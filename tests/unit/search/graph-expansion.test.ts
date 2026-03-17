import { describe, it, expect, vi } from 'vitest';
import { expandByGraph } from '../../../server/search.ts';
import type { VectorStore, SearchResult } from '../../../cli/store.ts';
import type { RankedResult } from '../../../server/search.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

function makeRanked(
  chunkId: string,
  className: string | null,
  rrfScore: number,
  overrides: Partial<RankedResult> = {},
): RankedResult {
  return {
    rowid: 0,
    chunkId,
    filePath: `app/models/${chunkId}.rb`,
    startLine: 1,
    endLine: 10,
    type: 'class',
    className,
    methodName: null,
    content: `class ${className}`,
    docComment: null,
    accessModifier: null,
    distance: 0,
    gitHash: null,
    gitMessage: null,
    rrfScore,
    vectorDistance: null,
    ftsScore: null,
    ...overrides,
  };
}

function makeSearchResult(chunkId: string, className: string | null = null): SearchResult {
  return {
    rowid: 0,
    chunkId,
    filePath: `app/models/${chunkId}.rb`,
    startLine: 1,
    endLine: 10,
    type: 'class',
    className,
    methodName: null,
    content: `class ${className}`,
    docComment: null,
    accessModifier: null,
    distance: 0,
    gitHash: null,
    gitMessage: null,
  };
}

function makeMockStore(overrides: {
  getAssociatedChunkIds?: ReturnType<typeof vi.fn>;
  getCallerChunkIds?: ReturnType<typeof vi.fn>;
  getCalleeConstantChunkIds?: ReturnType<typeof vi.fn>;
  getChunksByIds?: ReturnType<typeof vi.fn>;
} = {}): VectorStore {
  return {
    getAssociatedChunkIds: vi.fn().mockReturnValue([]),
    getCallerChunkIds: vi.fn().mockReturnValue([]),
    getCalleeConstantChunkIds: vi.fn().mockReturnValue([]),
    getChunksByIds: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as VectorStore;
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('expandByGraph', () => {
  // ──────────────────────────────────────────────────────────────────
  describe('拡張なし（関連なし）', () => {
    it('関連チャンクが存在しない場合、初期結果をそのまま返す', () => {
      const initial = [makeRanked('chunk-user', 'User', 0.8)];
      const result = expandByGraph(initial, makeMockStore(), 10);

      expect(result).toHaveLength(1);
      expect(result[0].chunkId).toBe('chunk-user');
      expect(result[0].rrfScore).toBeCloseTo(0.8);
    });

    it('className が null のチャンクは展開をスキップする', () => {
      const initial = [makeRanked('chunk-1', null, 0.8)];
      const store = makeMockStore();
      expandByGraph(initial, store, 10);

      expect(vi.mocked(store.getAssociatedChunkIds)).not.toHaveBeenCalled();
    });

    it('初期結果が空の場合は空配列を返す', () => {
      const result = expandByGraph([], makeMockStore(), 10);
      expect(result).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('ハブノード除外', () => {
    it.each([
      'ApplicationRecord',
      'ApplicationController',
      'ApplicationJob',
      'ApplicationMailer',
      'ApplicationHelper',
    ])('%s は展開起点にならない', (hubClass) => {
      const initial = [makeRanked('chunk-hub', hubClass, 0.9)];
      const store = makeMockStore();
      expandByGraph(initial, store, 10);

      expect(vi.mocked(store.getAssociatedChunkIds)).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('減衰率の適用', () => {
    it('has_many の減衰率は 0.6', () => {
      const initial = [makeRanked('chunk-user', 'User', 1.0)];
      const store = makeMockStore({
        getAssociatedChunkIds: vi.fn().mockReturnValue([
          { chunkId: 'chunk-order', type: 'has_many' },
        ]),
        getChunksByIds: vi.fn().mockReturnValue([makeSearchResult('chunk-order', 'Order')]),
      });
      const result = expandByGraph(initial, store, 10);

      const orderChunk = result.find((r) => r.chunkId === 'chunk-order');
      expect(orderChunk).toBeDefined();
      expect(orderChunk!.rrfScore).toBeCloseTo(1.0 * 0.6);
    });

    it('belongs_to の減衰率は 0.6', () => {
      const initial = [makeRanked('chunk-order', 'Order', 1.0)];
      const store = makeMockStore({
        getAssociatedChunkIds: vi.fn().mockReturnValue([
          { chunkId: 'chunk-user', type: 'belongs_to' },
        ]),
        getChunksByIds: vi.fn().mockReturnValue([makeSearchResult('chunk-user', 'User')]),
      });
      const result = expandByGraph(initial, store, 10);

      const userChunk = result.find((r) => r.chunkId === 'chunk-user');
      expect(userChunk!.rrfScore).toBeCloseTo(1.0 * 0.6);
    });

    it('include の減衰率は 0.4', () => {
      const initial = [makeRanked('chunk-user', 'User', 1.0)];
      const store = makeMockStore({
        getAssociatedChunkIds: vi.fn().mockReturnValue([
          { chunkId: 'chunk-concern', type: 'include' },
        ]),
        getChunksByIds: vi.fn().mockReturnValue([makeSearchResult('chunk-concern', 'Searchable')]),
      });
      const result = expandByGraph(initial, store, 10);

      const concernChunk = result.find((r) => r.chunkId === 'chunk-concern');
      expect(concernChunk!.rrfScore).toBeCloseTo(1.0 * 0.4);
    });

    it('callers の減衰率は 0.5', () => {
      const initial = [makeRanked('chunk-user', 'User', 1.0, { methodName: 'create' })];
      const store = makeMockStore({
        getCallerChunkIds: vi.fn().mockReturnValue(['chunk-ctrl']),
        getChunksByIds: vi.fn().mockReturnValue([makeSearchResult('chunk-ctrl', 'UsersController')]),
      });
      const result = expandByGraph(initial, store, 10);

      const ctrlChunk = result.find((r) => r.chunkId === 'chunk-ctrl');
      expect(ctrlChunk).toBeDefined();
      expect(ctrlChunk!.rrfScore).toBeCloseTo(1.0 * 0.5);
    });

    it('callees（定数レシーバー）の減衰率は 0.3', () => {
      const initial = [makeRanked('chunk-svc', 'UserService', 1.0, { methodName: 'notify' })];
      const store = makeMockStore({
        getCalleeConstantChunkIds: vi.fn().mockReturnValue(['chunk-mailer']),
        getChunksByIds: vi.fn().mockReturnValue([makeSearchResult('chunk-mailer', 'UserMailer')]),
      });
      const result = expandByGraph(initial, store, 10);

      const mailerChunk = result.find((r) => r.chunkId === 'chunk-mailer');
      expect(mailerChunk).toBeDefined();
      expect(mailerChunk!.rrfScore).toBeCloseTo(1.0 * 0.3);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('スコア加算（重複チャンク）', () => {
    it('初期結果に含まれるチャンクが関連として取得された場合、スコアが加算される', () => {
      const initial = [
        makeRanked('chunk-user', 'User', 0.8),
        makeRanked('chunk-order', 'Order', 0.35),
      ];
      const store = makeMockStore({
        getAssociatedChunkIds: vi.fn().mockReturnValue([
          { chunkId: 'chunk-order', type: 'has_many' },
        ]),
        getChunksByIds: vi.fn().mockReturnValue([]),
      });
      const result = expandByGraph(initial, store, 10);

      const orderChunk = result.find((r) => r.chunkId === 'chunk-order');
      // 0.35 + 0.8 * 0.6 = 0.83
      expect(orderChunk!.rrfScore).toBeCloseTo(0.35 + 0.8 * 0.6);
    });

    it('複数の起点から参照されたチャンクは加算後のスコアになる', () => {
      const initial = [
        makeRanked('chunk-user', 'User', 0.8),
        makeRanked('chunk-order', 'Order', 0.5),
      ];
      // 両方の起点から chunk-payment が関連として取得される
      const store = makeMockStore({
        getAssociatedChunkIds: vi.fn().mockReturnValue([
          { chunkId: 'chunk-payment', type: 'has_many' },
        ]),
        getChunksByIds: vi.fn().mockReturnValue([makeSearchResult('chunk-payment', 'Payment')]),
      });
      const result = expandByGraph(initial, store, 10);

      const paymentChunk = result.find((r) => r.chunkId === 'chunk-payment');
      // 0.8 * 0.6 + 0.5 * 0.6 = 0.78
      expect(paymentChunk!.rrfScore).toBeCloseTo(0.8 * 0.6 + 0.5 * 0.6);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('再ランキングと topK', () => {
    it('拡張後にスコアの降順で並び替えられる', () => {
      const initial = [
        makeRanked('chunk-a', 'ClassA', 0.5),
        makeRanked('chunk-b', 'ClassB', 0.1),
      ];
      // ClassA から chunk-d (score = 0.5 * 0.6 = 0.3)
      const store = makeMockStore({
        getAssociatedChunkIds: vi.fn()
          .mockReturnValueOnce([{ chunkId: 'chunk-d', type: 'has_many' }]) // ClassA
          .mockReturnValueOnce([]),                                          // ClassB
        getChunksByIds: vi.fn().mockImplementation((ids: string[]) =>
          ids.map((id) => makeSearchResult(id)),
        ),
      });
      const result = expandByGraph(initial, store, 10);

      // chunk-a (0.5) > chunk-d (0.3) > chunk-b (0.1)
      expect(result[0].chunkId).toBe('chunk-a');
      expect(result[1].chunkId).toBe('chunk-d');
      expect(result[2].chunkId).toBe('chunk-b');
    });

    it('topK を超えるチャンクは展開起点にならない', () => {
      const initial = [
        makeRanked('chunk-a', 'ClassA', 0.8),
        makeRanked('chunk-b', 'ClassB', 0.3),
      ];
      const store = makeMockStore();
      expandByGraph(initial, store, 1); // topK = 1: chunk-a のみが起点

      expect(vi.mocked(store.getAssociatedChunkIds)).toHaveBeenCalledWith('ClassA');
      expect(vi.mocked(store.getAssociatedChunkIds)).not.toHaveBeenCalledWith('ClassB');
    });
  });
});
