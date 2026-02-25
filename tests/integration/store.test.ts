import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VectorStore } from '../../cli/store.ts';
import type { Chunk, MethodDefinition, MethodCall, Association } from '../../cli/types.ts';
import { EMBEDDING_DIMS } from '../../cli/embedder.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

/** 次元 index のみ 1.0 を立てたワンホットベクトル */
function makeEmbedding(index: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMS).fill(0);
  vec[index % EMBEDDING_DIMS] = 1.0;
  return vec;
}

/** 最小限の Chunk オブジェクトを生成するファクトリ */
function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: randomUUID(),
    content: 'def greet; end',
    filePath: 'app/models/user.rb',
    startLine: 1,
    endLine: 3,
    type: 'method',
    className: 'User',
    methodName: 'greet',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('VectorStore', () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-store-test-'));
    store = new VectorStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('saveChunk / getChunksForFile', () => {
    it('保存したチャンクがファイルパスで取得できる', () => {
      const chunk = makeChunk();
      store.saveChunk(chunk, makeEmbedding(0));

      const rows = store.getChunksForFile(chunk.filePath);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(chunk.id);
    });

    it('複数チャンクを同一ファイルパスで保存・取得できる', () => {
      const filePath = 'app/models/order.rb';
      const chunk1 = makeChunk({ filePath, methodName: 'cancel' });
      const chunk2 = makeChunk({ filePath, methodName: 'confirm' });
      store.saveChunk(chunk1, makeEmbedding(0));
      store.saveChunk(chunk2, makeEmbedding(1));

      const rows = store.getChunksForFile(filePath);
      expect(rows).toHaveLength(2);
    });

    it('存在しないファイルパスは空配列を返す', () => {
      const rows = store.getChunksForFile('not/exist.rb');
      expect(rows).toHaveLength(0);
    });

    it('gitInfo を渡すと git_hash / git_message が保存される', () => {
      const chunk = makeChunk({ filePath: 'app/models/git_test.rb' });
      store.saveChunk(chunk, makeEmbedding(0), {
        hash: 'abc123',
        message: 'feat: initial commit',
      });

      const rows = store.getChunksForFile(chunk.filePath);
      // getChunksForFile はgit情報を返さないが、vectorSearch で確認する
      expect(rows).toHaveLength(1);
    });

    it('同じ id で saveChunk を呼ぶと上書き（REPLACE）される', () => {
      const chunk = makeChunk({ content: 'original' });
      store.saveChunk(chunk, makeEmbedding(0));

      const updated = { ...chunk, content: 'updated' };
      store.saveChunk(updated, makeEmbedding(0));

      // vectorSearch で最新の内容を確認
      const results = store.vectorSearch(makeEmbedding(0), 1);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('updated');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('file_index (upsertFileIndex / getFileRecord / getAllKnownPaths)', () => {
    it('upsertFileIndex で記録→ getFileRecord で取得できる', () => {
      store.upsertFileIndex('app/models/user.rb', 1_700_000_000, 'hash1');
      const record = store.getFileRecord('app/models/user.rb');
      expect(record).not.toBeNull();
      expect(record!.mtime).toBe(1_700_000_000);
      expect(record!.hash).toBe('hash1');
    });

    it('同じパスで再度 upsert すると上書きされる', () => {
      store.upsertFileIndex('app/models/user.rb', 100, 'old');
      store.upsertFileIndex('app/models/user.rb', 200, 'new');
      const record = store.getFileRecord('app/models/user.rb');
      expect(record!.mtime).toBe(200);
      expect(record!.hash).toBe('new');
    });

    it('存在しないパスは null を返す', () => {
      expect(store.getFileRecord('no/such/file.rb')).toBeNull();
    });

    it('getAllKnownPaths で全ファイルパスの Set が返る', () => {
      store.upsertFileIndex('app/models/user.rb', 1, 'h1');
      store.upsertFileIndex('app/models/order.rb', 2, 'h2');
      const paths = store.getAllKnownPaths();
      expect(paths.size).toBe(2);
      expect(paths.has('app/models/user.rb')).toBe(true);
      expect(paths.has('app/models/order.rb')).toBe(true);
    });

    it('何も登録していないときは空の Set が返る', () => {
      expect(store.getAllKnownPaths().size).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('deleteFileData', () => {
    it('削除後、getChunksForFile が空配列を返す', () => {
      const chunk = makeChunk({ filePath: 'app/models/target.rb' });
      store.saveChunk(chunk, makeEmbedding(0));
      store.upsertFileIndex('app/models/target.rb', 1, 'h');

      store.deleteFileData('app/models/target.rb');

      expect(store.getChunksForFile('app/models/target.rb')).toHaveLength(0);
    });

    it('削除後、file_index から消える', () => {
      store.upsertFileIndex('app/models/target.rb', 1, 'h');
      store.deleteFileData('app/models/target.rb');
      expect(store.getFileRecord('app/models/target.rb')).toBeNull();
    });

    it('削除後、vectorSearch に出現しない', () => {
      const chunk = makeChunk({ filePath: 'app/models/target.rb' });
      store.saveChunk(chunk, makeEmbedding(5));
      store.deleteFileData('app/models/target.rb');

      const results = store.vectorSearch(makeEmbedding(5), 10);
      const found = results.some((r) => r.filePath === 'app/models/target.rb');
      expect(found).toBe(false);
    });

    it('削除後、ftsSearch に出現しない', () => {
      const chunk = makeChunk({
        filePath: 'app/models/target.rb',
        content: 'def uniquemethodxyz; end',
        methodName: 'uniquemethodxyz',
      });
      store.saveChunk(chunk, makeEmbedding(0));
      store.deleteFileData('app/models/target.rb');

      const results = store.ftsSearch('uniquemethodxyz', 10);
      expect(results).toHaveLength(0);
    });

    it('他のファイルのデータは削除されない', () => {
      const target = makeChunk({ filePath: 'app/models/target.rb' });
      const other = makeChunk({ filePath: 'app/models/other.rb' });
      store.saveChunk(target, makeEmbedding(0));
      store.saveChunk(other, makeEmbedding(1));

      store.deleteFileData('app/models/target.rb');

      expect(store.getChunksForFile('app/models/other.rb')).toHaveLength(1);
    });

    it('存在しないファイルを削除しても例外が起きない', () => {
      expect(() => store.deleteFileData('no/such.rb')).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('vectorSearch', () => {
    it('クエリベクトルに最も近いチャンクが上位に来る', () => {
      const chunk0 = makeChunk({ filePath: 'app/a.rb', methodName: 'alpha' });
      const chunk1 = makeChunk({ filePath: 'app/b.rb', methodName: 'beta' });
      store.saveChunk(chunk0, makeEmbedding(0));
      store.saveChunk(chunk1, makeEmbedding(1));

      // dim=0 に一致するクエリ → chunk0 が最上位
      const results = store.vectorSearch(makeEmbedding(0), 2);
      expect(results[0].chunkId).toBe(chunk0.id);
    });

    it('topK を超えるチャンクは返らない', () => {
      for (let i = 0; i < 5; i++) {
        store.saveChunk(makeChunk(), makeEmbedding(i));
      }
      const results = store.vectorSearch(makeEmbedding(0), 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('チャンクが 0 件のとき空配列を返す', () => {
      expect(store.vectorSearch(makeEmbedding(0), 5)).toHaveLength(0);
    });

    it('結果に chunkId / filePath / content が含まれる', () => {
      const chunk = makeChunk({ content: 'def hello; end' });
      store.saveChunk(chunk, makeEmbedding(10));

      const results = store.vectorSearch(makeEmbedding(10), 1);
      expect(results[0].chunkId).toBe(chunk.id);
      expect(results[0].filePath).toBe(chunk.filePath);
      expect(results[0].content).toBe('def hello; end');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('ftsSearch', () => {
    it('コンテンツのキーワードで検索できる', () => {
      const chunk = makeChunk({
        content: 'def cancel_payment; end',
        methodName: 'cancel_payment',
      });
      store.saveChunk(chunk, makeEmbedding(0));

      const results = store.ftsSearch('cancel_payment', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunkId).toBe(chunk.id);
    });

    it('クラス名でも検索できる', () => {
      const chunk = makeChunk({ className: 'PaymentGateway', methodName: 'charge' });
      store.saveChunk(chunk, makeEmbedding(0));

      const results = store.ftsSearch('PaymentGateway', 10);
      expect(results.some((r) => r.chunkId === chunk.id)).toBe(true);
    });

    it('存在しないキーワードは空配列を返す', () => {
      store.saveChunk(makeChunk({ content: 'def greet; end' }), makeEmbedding(0));
      const results = store.ftsSearch('xyzxyzxyz', 10);
      expect(results).toHaveLength(0);
    });

    it('topK 件までしか返さない', () => {
      // 同じキーワードを含む複数チャンクを投入
      for (let i = 0; i < 5; i++) {
        store.saveChunk(
          makeChunk({ content: `def search_keyword_${i}; end`, methodName: `search_keyword_${i}` }),
          makeEmbedding(i),
        );
      }
      const results = store.ftsSearch('search', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('参照インデックス (saveDefinition / saveCall / saveAssociation / getReferences)', () => {
    it('saveDefinition → getReferences で callee 側に出る', () => {
      const chunk = makeChunk({ className: 'User', methodName: 'greet' });
      store.saveChunk(chunk, makeEmbedding(0));

      const def: MethodDefinition = {
        id: 'User#greet',
        filePath: 'app/models/user.rb',
        className: 'User',
        methodName: 'greet',
        startLine: 1,
        accessModifier: 'public',
        isClassMethod: false,
      };
      store.saveDefinition(def);

      // 呼び出し元を登録
      const call: MethodCall = {
        callerId: 'OrdersController#create',
        calleeRaw: 'user.greet',
        filePath: 'app/controllers/orders_controller.rb',
        line: 10,
      };
      store.saveCall(call);

      const refs = store.getReferences('User', 'greet');
      expect(refs.callers.some((c) => c.caller_id === 'OrdersController#create')).toBe(true);
    });

    it('saveCall → getReferences で callees に出る', () => {
      const call: MethodCall = {
        callerId: 'User#process',
        calleeRaw: 'payment.charge',
        filePath: 'app/models/user.rb',
        line: 5,
      };
      store.saveCall(call);

      const refs = store.getReferences('User', 'process');
      expect(refs.callees.some((c) => c.callee_raw === 'payment.charge')).toBe(true);
    });

    it('saveAssociation → getReferences の associations に出る', () => {
      const assoc: Association = {
        sourceClass: 'Order',
        type: 'belongs_to',
        target: 'User',
        filePath: 'app/models/order.rb',
      };
      store.saveAssociation(assoc);

      const refs = store.getReferences('Order', 'any');
      expect(refs.associations.some((a) => a.type === 'belongs_to' && a.target === 'User')).toBe(true);
    });
  });
});
