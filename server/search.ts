import type { Request, Response } from 'express';
import { embedQuery } from '../cli/embedder.ts';
import type { VectorStore, SearchResult } from '../cli/store.ts';

const TOP_K = 20; // 各検索で取得する件数
const RRF_K = 60; // RRF定数（一般的な推奨値）

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
      const topResults = merged.slice(0, topK);

      // ── 4. 参照情報付与 ──────────────────────────────────────
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
