import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../../server/search.ts';
import type { SearchResult } from '../../../cli/store.ts';

// テスト用の最小限 SearchResult ファクトリ
function makeResult(chunkId: string, distance = 0.5): SearchResult {
  return {
    chunkId,
    filePath: 'app/models/dummy.rb',
    startLine: 1,
    endLine: 10,
    type: 'method',
    className: 'Dummy',
    methodName: chunkId,
    content: `def ${chunkId}; end`,
    docComment: null,
    accessModifier: null,
    distance,
    gitHash: null,
    gitMessage: null,
  };
}

const K = 60; // RRF定数

describe('reciprocalRankFusion', () => {
  describe('ベクトル検索のみ', () => {
    it('ベクトル検索結果のみで RRF スコアが計算される', () => {
      const vecResults = [makeResult('a'), makeResult('b')];
      const result = reciprocalRankFusion(vecResults, [], K);
      expect(result).toHaveLength(2);
      // rank 0: 1/(60+0+1) = 1/61
      expect(result[0].rrfScore).toBeCloseTo(1 / 61);
      // rank 1: 1/(60+1+1) = 1/62
      expect(result[1].rrfScore).toBeCloseTo(1 / 62);
    });

    it('vectorDistance にベクトル距離が入り、ftsScore は null', () => {
      const vecResults = [makeResult('a', 0.3)];
      const result = reciprocalRankFusion(vecResults, [], K);
      expect(result[0].vectorDistance).toBe(0.3);
      expect(result[0].ftsScore).toBeNull();
    });
  });

  describe('FTS 検索のみ', () => {
    it('FTS 結果のみで RRF スコアが計算される', () => {
      const ftsResults = [makeResult('a'), makeResult('b')];
      const result = reciprocalRankFusion([], ftsResults, K);
      expect(result).toHaveLength(2);
      expect(result[0].rrfScore).toBeCloseTo(1 / 61);
    });

    it('vectorDistance は null、ftsScore に BM25 スコアが入る', () => {
      const ftsResults = [makeResult('a', 5.0)];
      const result = reciprocalRankFusion([], ftsResults, K);
      expect(result[0].vectorDistance).toBeNull();
      expect(result[0].ftsScore).toBe(5.0);
    });
  });

  describe('ハイブリッド（スコア統合）', () => {
    it('両方に存在するチャンクはスコアが加算される', () => {
      const vec = [makeResult('a'), makeResult('b')];
      const fts = [makeResult('a'), makeResult('c')]; // 'a' が共通
      const result = reciprocalRankFusion(vec, fts, K);

      const scoreA = result.find((r) => r.chunkId === 'a')?.rrfScore ?? 0;
      const scoreB = result.find((r) => r.chunkId === 'b')?.rrfScore ?? 0;
      const scoreC = result.find((r) => r.chunkId === 'c')?.rrfScore ?? 0;

      // 'a' は vec rank0 + fts rank0 = 1/61 + 1/61 ≒ 0.0328
      expect(scoreA).toBeCloseTo(1 / 61 + 1 / 61);
      // 'b' は vec rank1 のみ = 1/62 ≒ 0.0161
      expect(scoreB).toBeCloseTo(1 / 62);
      // 'a' のスコアは 'b' より高い
      expect(scoreA).toBeGreaterThan(scoreB);
      // 'c' は fts rank1 のみ = 1/62
      expect(scoreC).toBeCloseTo(1 / 62);
    });

    it('結果は rrfScore の降順で返される', () => {
      const vec = [makeResult('high'), makeResult('low')];
      const fts = [makeResult('high')]; // 'high' は両方にあり高スコア
      const result = reciprocalRankFusion(vec, fts, K);

      const scores = result.map((r) => r.rrfScore);
      const sorted = [...scores].sort((a, b) => b - a);
      expect(scores).toEqual(sorted);
    });

    it('重複なく統合される（同じ chunkId が 2 件になることはない）', () => {
      const vec = [makeResult('a'), makeResult('b')];
      const fts = [makeResult('a'), makeResult('b')]; // 全件重複
      const result = reciprocalRankFusion(vec, fts, K);
      expect(result).toHaveLength(2);
    });
  });

  describe('エッジケース', () => {
    it('両方空のとき空配列を返す', () => {
      expect(reciprocalRankFusion([], [], K)).toEqual([]);
    });
  });
});
