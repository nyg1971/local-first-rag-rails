import type { Request, Response } from 'express';
import { embedQuery } from '../cli/embedder.ts';
import type { VectorStore, SearchResult } from '../cli/store.ts';

const TOP_K = 20; // 各検索で取得する件数
const RRF_K = 60; // RRF定数（一般的な推奨値）

// ハブノード（展開起点から除外する Rails 基底クラス）
const HUB_CLASS_NAMES = new Set([
  'ApplicationRecord',
  'ApplicationController',
  'ApplicationJob',
  'ApplicationMailer',
  'ApplicationHelper',
]);

// 関係種別ごとの減衰率
const DECAY_RATES: Record<string, number> = {
  has_many:                  0.6,
  belongs_to:                0.6,
  has_one:                   0.6,
  has_and_belongs_to_many:   0.6,
  callers:                   0.5,
  include:                   0.4,
  extend:                    0.4,
  prepend:                   0.4,
  callees:                   0.3,
};

export interface HybridResult {
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  type: string;
  className: string | null;
  methodName: string | null;
  content: string;
  docComment: string | null;
  accessModifier: string | null;
  rrfScore: number;
  vectorDistance: number | null;
  ftsScore: number | null;
  references?: ReturnType<VectorStore['getReferences']>;
}

/**
 * POST /search
 * body: { query: string, topK?: number, includeRefs?: boolean }
 */
export function createSearchHandler(store: VectorStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { query, topK = 10, includeRefs = true } = req.body as {
      query: string;
      topK?: number;
      includeRefs?: boolean;
    };

    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    try {
      // ── 1. ベクトル検索 ──────────────────────────────────────
      const queryVec = await embedQuery(query);
      const vecResults = store.vectorSearch(queryVec, TOP_K);

      // ── 2. BM25 全文検索 ──────────────────────────────────────
      const safeFtsQuery = escapeFtsQuery(query);
      let ftsResults: SearchResult[] = [];
      if (safeFtsQuery) {
        try {
          ftsResults = store.ftsSearch(safeFtsQuery, TOP_K);
        } catch (err) {
          // FTS クエリが無効な場合はベクトル検索のみで継続
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[server] FTS検索をスキップしてベクトル検索のみで継続します: ${msg}`);
        }
      }

      // ── 3. RRF スコア統合 ──────────────────────────────────────
      const merged = reciprocalRankFusion(vecResults, ftsResults, RRF_K);

      // ── 4. グラフ拡張・再ランキング ──────────────────────────────────────
      const expanded = expandByGraph(merged, store, topK);
      const topResults = expanded.slice(0, topK);

      // ── 5. 参照情報付与 ──────────────────────────────────────
      const results: HybridResult[] = topResults.map((r) => {
        const base: HybridResult = {
          chunkId: r.chunkId,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          type: r.type,
          className: r.className,
          methodName: r.methodName,
          content: r.content,
          docComment: r.docComment,
          accessModifier: r.accessModifier,
          rrfScore: r.rrfScore,
          vectorDistance: r.vectorDistance,
          ftsScore: r.ftsScore,
        };

        if (includeRefs && r.className && r.methodName) {
          base.references = store.getReferences(r.className, r.methodName);
        }

        return base;
      });

      res.json({ query, results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  };
}

// ────────────────────────────────────────────────────────────────────
// RRF: Reciprocal Rank Fusion
// ────────────────────────────────────────────────────────────────────

export interface RankedResult extends SearchResult {
  rrfScore: number;
  vectorDistance: number | null;
  ftsScore: number | null;
}

export function reciprocalRankFusion(
  vecResults: SearchResult[],
  ftsResults: SearchResult[],
  k: number,
): RankedResult[] {
  const scores = new Map<string, RankedResult>();

  // ベクトル検索スコア付与
  vecResults.forEach((r, rank) => {
    scores.set(r.chunkId, {
      ...r,
      rrfScore: 1 / (k + rank + 1),
      vectorDistance: r.distance,
      ftsScore: null,
    });
  });

  // FTS スコアを加算
  ftsResults.forEach((r, rank) => {
    const existing = scores.get(r.chunkId);
    const ftsContrib = 1 / (k + rank + 1);
    if (existing) {
      existing.rrfScore += ftsContrib;
      existing.ftsScore = r.distance; // FTSはdistanceフィールドにBM25スコアが入る
    } else {
      scores.set(r.chunkId, {
        ...r,
        rrfScore: ftsContrib,
        vectorDistance: null,
        ftsScore: r.distance,
      });
    }
  });

  return [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

// ────────────────────────────────────────────────────────────────────
// グラフ拡張・再ランキング
// ────────────────────────────────────────────────────────────────────

/**
 * RRF 結果の上位 topK チャンクを起点に参照テーブルを辿り、
 * 関連チャンクを取得してスコアを付与したうえで再ランキングする。
 *
 * - ハブノード（ApplicationRecord 等）は展開起点から除外
 * - include/extend/prepend の汎用 Concern は store 側で除外
 * - 重複チャンクはスコアを加算
 */
export function expandByGraph(
  initialResults: RankedResult[],
  store: VectorStore,
  topK: number,
): RankedResult[] {
  // scoreMap: chunkId → RankedResult（スコアを上書き可能なコピー）
  const scoreMap = new Map<string, RankedResult>();
  for (const r of initialResults) {
    scoreMap.set(r.chunkId, { ...r });
  }

  // 追加スコアを集積: chunkId → 合計加算スコア
  const addedScores = new Map<string, number>();

  const seeds = initialResults.slice(0, topK);

  for (const seed of seeds) {
    if (!seed.className) continue;
    if (HUB_CLASS_NAMES.has(seed.className)) continue;

    // アソシエーション展開（has_many / belongs_to / include 等）
    for (const { chunkId, type } of store.getAssociatedChunkIds(seed.className)) {
      if (chunkId === seed.chunkId) continue;
      const decay = DECAY_RATES[type] ?? 0.3;
      addedScores.set(chunkId, (addedScores.get(chunkId) ?? 0) + seed.rrfScore * decay);
    }

    if (seed.methodName) {
      // Callers 展開（このメソッドを呼び出しているチャンク）
      for (const chunkId of store.getCallerChunkIds(seed.className, seed.methodName)) {
        if (chunkId === seed.chunkId) continue;
        addedScores.set(
          chunkId,
          (addedScores.get(chunkId) ?? 0) + seed.rrfScore * DECAY_RATES.callers,
        );
      }

      // Callees 展開（定数レシーバーのみ）
      for (const chunkId of store.getCalleeConstantChunkIds(seed.className, seed.methodName)) {
        if (chunkId === seed.chunkId) continue;
        addedScores.set(
          chunkId,
          (addedScores.get(chunkId) ?? 0) + seed.rrfScore * DECAY_RATES.callees,
        );
      }
    }
  }

  // 新規チャンク（初期結果に含まれないもの）を DB から取得して scoreMap に追加
  const newIds = [...addedScores.keys()].filter((id) => !scoreMap.has(id));
  for (const chunk of store.getChunksByIds(newIds)) {
    scoreMap.set(chunk.chunkId, {
      ...chunk,
      rrfScore: 0,
      vectorDistance: null,
      ftsScore: null,
    });
  }

  // スコア加算（既存・新規問わず）
  for (const [chunkId, addedScore] of addedScores.entries()) {
    const entry = scoreMap.get(chunkId);
    if (entry) entry.rrfScore += addedScore;
  }

  return [...scoreMap.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

// ────────────────────────────────────────────────────────────────────
// FTS5 クエリエスケープ
// ────────────────────────────────────────────────────────────────────

/**
 * FTS5 特殊文字（" * ^ ( ) など）をエスケープして
 * 安全なクエリ文字列を生成する。
 * スペース区切りで各トークンを AND 検索にする。
 */
export function escapeFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      // 英数字・アンダースコア・日本語文字以外を除去
      const cleaned = token.replace(/[^\w\u3000-\u9fff\uFF00-\uFFEF]/g, '');
      return cleaned;
    })
    .filter((t) => t.length > 0);

  return tokens.join(' ');
}
