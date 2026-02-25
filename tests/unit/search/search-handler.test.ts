import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { createSearchHandler } from '../../../server/search.ts';
import type { VectorStore, SearchResult } from '../../../cli/store.ts';

// 280MB モデルのロードを回避するため embedder をモック
// vi.mock は自動的にホイスト（import より前に実行）される
vi.mock('../../../cli/embedder.ts', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768)),
  embedBatch: vi.fn(),
  EMBEDDING_DIMS: 768,
  EMBEDDING_MODEL: 'test-model',
  getExtractor: vi.fn(),
}));

// モック済みの embedQuery を型付きで参照する（vi.mocked で使用）
import { embedQuery } from '../../../cli/embedder.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    rowid: 1,
    chunkId: 'chunk-1',
    filePath: 'app/models/user.rb',
    startLine: 1,
    endLine: 5,
    type: 'method',
    className: 'User',
    methodName: 'greet',
    content: 'def greet; end',
    docComment: null,
    accessModifier: null,
    distance: 0.1,
    gitHash: null,
    gitMessage: null,
    ...overrides,
  };
}

function makeMockStore(overrides: Partial<Record<keyof VectorStore, unknown>> = {}): VectorStore {
  return {
    vectorSearch: vi.fn().mockReturnValue([]),
    ftsSearch: vi.fn().mockReturnValue([]),
    getReferences: vi.fn().mockReturnValue({ callers: [], callees: [], associations: [] }),
    saveChunk: vi.fn(),
    saveDefinition: vi.fn(),
    saveCall: vi.fn(),
    saveAssociation: vi.fn(),
    getChunksForFile: vi.fn().mockReturnValue([]),
    getAllKnownPaths: vi.fn().mockReturnValue(new Set()),
    getFileRecord: vi.fn().mockReturnValue(null),
    upsertFileIndex: vi.fn(),
    deleteFileData: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as VectorStore;
}

function makeReq(body: Record<string, unknown> = {}): Request {
  return { body } as unknown as Request;
}

/** res.status(400).json({...}) チェーンに対応した Response モック */
function makeRes() {
  const res = {
    statusCode: 200,
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res; // チェーン用に自身を返す
  });
  return res;
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('createSearchHandler', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // embedQuery のデフォルト実装を復元
    vi.mocked(embedQuery).mockResolvedValue(new Float32Array(768));
  });

  // ──────────────────────────────────────────────────────────────────
  describe('400 Bad Request', () => {
    it('query が null のとき 400 を返す', async () => {
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({ query: null }), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'query is required' });
    });

    it('query が undefined（body に含まれない）のとき 400 を返す', async () => {
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({}), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'query is required' });
    });

    it('query が空文字のとき 400 を返す', async () => {
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({ query: '' }), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'query is required' });
    });

    it('query が数値のとき 400 を返す', async () => {
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({ query: 42 }), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'query is required' });
    });

    it('query が配列のとき 400 を返す', async () => {
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({ query: ['hello'] }), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'query is required' });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('500 Internal Server Error', () => {
    it('vectorSearch が例外を投げると 500 を返す', async () => {
      const store = makeMockStore({
        vectorSearch: vi.fn().mockImplementation(() => {
          throw new Error('DB crashed');
        }),
      });
      const handler = createSearchHandler(store);
      const res = makeRes();
      await handler(makeReq({ query: 'hello' }), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'DB crashed' });
    });

    it('500 の error フィールドに例外メッセージが入る', async () => {
      const store = makeMockStore({
        vectorSearch: vi.fn().mockImplementation(() => {
          throw new Error('connection lost');
        }),
      });
      const handler = createSearchHandler(store);
      const res = makeRes();
      await handler(makeReq({ query: 'test' }), res as unknown as Response);

      const body = vi.mocked(res.json).mock.calls[0][0] as { error: string };
      expect(body.error).toBe('connection lost');
    });

    it('embedQuery が失敗すると 500 を返す', async () => {
      vi.mocked(embedQuery).mockRejectedValueOnce(new Error('model error'));
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({ query: 'hello' }), res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('FTS degraded mode', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('ftsSearch が例外を投げると console.warn が呼ばれる', async () => {
      const store = makeMockStore({
        vectorSearch: vi.fn().mockReturnValue([makeSearchResult()]),
        ftsSearch: vi.fn().mockImplementation(() => {
          throw new Error('FTS index broken');
        }),
      });
      const handler = createSearchHandler(store);
      const res = makeRes();
      await handler(makeReq({ query: 'hello' }), res as unknown as Response);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('FTS検索をスキップ'),
      );
    });

    it('ftsSearch が失敗しても 200 で結果が返る', async () => {
      const store = makeMockStore({
        vectorSearch: vi.fn().mockReturnValue([makeSearchResult()]),
        ftsSearch: vi.fn().mockImplementation(() => {
          throw new Error('FTS error');
        }),
      });
      const handler = createSearchHandler(store);
      const res = makeRes();
      await handler(makeReq({ query: 'hello' }), res as unknown as Response);

      // status() を呼ばない = 200 相当
      expect(res.status).not.toHaveBeenCalled();
      const body = vi.mocked(res.json).mock.calls[0][0] as { results: unknown[] };
      expect(body.results).toHaveLength(1);
    });

    it('warn メッセージに [server] プレフィックスと FTS エラー内容が含まれる', async () => {
      const store = makeMockStore({
        vectorSearch: vi.fn().mockReturnValue([]),
        ftsSearch: vi.fn().mockImplementation(() => {
          throw new Error('syntax error near token');
        }),
      });
      const handler = createSearchHandler(store);
      const res = makeRes();
      await handler(makeReq({ query: 'hello' }), res as unknown as Response);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[server\] FTS検索をスキップ.*syntax error near token/),
      );
    });

    it('特殊文字のみのクエリは ftsSearch を呼ばない（escapeFtsQuery が "" を返す）', async () => {
      const store = makeMockStore();
      const handler = createSearchHandler(store);
      const res = makeRes();
      await handler(makeReq({ query: '***' }), res as unknown as Response);

      expect(vi.mocked(store.ftsSearch)).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('正常系の基本確認', () => {
    it('正常なクエリでは status() を呼ばずに results 配列を返す', async () => {
      const handler = createSearchHandler(makeMockStore());
      const res = makeRes();
      await handler(makeReq({ query: 'hello' }), res as unknown as Response);

      expect(res.status).not.toHaveBeenCalled();
      const body = vi.mocked(res.json).mock.calls[0][0] as { query: string; results: unknown[] };
      expect(body.query).toBe('hello');
      expect(Array.isArray(body.results)).toBe(true);
    });
  });
});
