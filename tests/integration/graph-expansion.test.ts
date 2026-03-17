import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VectorStore } from '../../cli/store.ts';
import type { Chunk, MethodCall, Association } from '../../cli/types.ts';
import { EMBEDDING_DIMS } from '../../cli/embedder.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

function makeEmbedding(index: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMS).fill(0);
  vec[index % EMBEDDING_DIMS] = 1.0;
  return vec;
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: randomUUID(),
    content: 'class User; end',
    filePath: 'app/models/user.rb',
    startLine: 1,
    endLine: 10,
    type: 'class',
    className: 'User',
    methodName: null,
    calledMethods: [],
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('グラフ拡張用 store メソッド', () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-graph-test-'));
    store = new VectorStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('getChunksByIds', () => {
    it('空配列を渡すと空配列を返す', () => {
      expect(store.getChunksByIds([])).toHaveLength(0);
    });

    it('指定した chunk_id のチャンクを返す', () => {
      const chunk = makeChunk({ className: 'User', content: 'class User; end' });
      store.saveChunk(chunk, makeEmbedding(0));

      const results = store.getChunksByIds([chunk.id]);
      expect(results).toHaveLength(1);
      expect(results[0].chunkId).toBe(chunk.id);
      expect(results[0].className).toBe('User');
    });

    it('複数の chunk_id を一括取得できる', () => {
      const chunkA = makeChunk({ className: 'User' });
      const chunkB = makeChunk({ className: 'Order', filePath: 'app/models/order.rb' });
      store.saveChunk(chunkA, makeEmbedding(0));
      store.saveChunk(chunkB, makeEmbedding(1));

      const results = store.getChunksByIds([chunkA.id, chunkB.id]);
      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.chunkId);
      expect(ids).toContain(chunkA.id);
      expect(ids).toContain(chunkB.id);
    });

    it('存在しない ID は無視される', () => {
      const chunk = makeChunk();
      store.saveChunk(chunk, makeEmbedding(0));

      const results = store.getChunksByIds([chunk.id, 'non-existent-id']);
      expect(results).toHaveLength(1);
      expect(results[0].chunkId).toBe(chunk.id);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('getAssociatedChunkIds', () => {
    it('has_many アソシエーション先のクラスチャンクを返す', () => {
      // User has_many Orders
      const orderChunk = makeChunk({
        className: 'Order',
        type: 'class',
        filePath: 'app/models/order.rb',
      });
      store.saveChunk(orderChunk, makeEmbedding(0));

      const assoc: Association = {
        sourceClass: 'User',
        type: 'has_many',
        target: 'Order',
        filePath: 'app/models/user.rb',
      };
      store.saveAssociation(assoc);

      const results = store.getAssociatedChunkIds('User');
      expect(results.some((r) => r.chunkId === orderChunk.id && r.type === 'has_many')).toBe(true);
    });

    it('belongs_to アソシエーション先のクラスチャンクを返す', () => {
      const userChunk = makeChunk({ className: 'User', type: 'class' });
      store.saveChunk(userChunk, makeEmbedding(0));

      const assoc: Association = {
        sourceClass: 'Order',
        type: 'belongs_to',
        target: 'User',
        filePath: 'app/models/order.rb',
      };
      store.saveAssociation(assoc);

      const results = store.getAssociatedChunkIds('Order');
      expect(results.some((r) => r.chunkId === userChunk.id && r.type === 'belongs_to')).toBe(true);
    });

    it('include 先モジュールのチャンクを返す', () => {
      const concernChunk = makeChunk({
        className: 'Searchable',
        type: 'module',
        filePath: 'app/models/concerns/searchable.rb',
      });
      store.saveChunk(concernChunk, makeEmbedding(0));

      const assoc: Association = {
        sourceClass: 'User',
        type: 'include',
        target: 'Searchable',
        filePath: 'app/models/user.rb',
      };
      store.saveAssociation(assoc);

      const results = store.getAssociatedChunkIds('User');
      expect(results.some((r) => r.chunkId === concernChunk.id && r.type === 'include')).toBe(true);
    });

    it('include 元クラス数が閾値を超える汎用 Concern は除外される', () => {
      const genericConcern = makeChunk({
        className: 'GenericConcern',
        type: 'module',
        filePath: 'app/models/concerns/generic_concern.rb',
      });
      store.saveChunk(genericConcern, makeEmbedding(0));

      // GenericConcern を 11 クラスから include する（閾値 10 を超える）
      for (let i = 0; i < 11; i++) {
        store.saveAssociation({
          sourceClass: `Class${i}`,
          type: 'include',
          target: 'GenericConcern',
          filePath: `app/models/class${i}.rb`,
        });
      }

      // User も include するが、汎用 Concern なので除外される
      const userChunk = makeChunk({ className: 'User', type: 'class' });
      store.saveChunk(userChunk, makeEmbedding(1));
      store.saveAssociation({
        sourceClass: 'User',
        type: 'include',
        target: 'GenericConcern',
        filePath: 'app/models/user.rb',
      });

      const results = store.getAssociatedChunkIds('User');
      expect(results.some((r) => r.chunkId === genericConcern.id)).toBe(false);
    });

    it('アソシエーションがない場合は空配列を返す', () => {
      expect(store.getAssociatedChunkIds('NonExistentClass')).toHaveLength(0);
    });

    it('target クラスのチャンクが存在しない場合は結果に含まれない', () => {
      // チャンクを保存せずにアソシエーションだけ登録
      store.saveAssociation({
        sourceClass: 'User',
        type: 'has_many',
        target: 'GhostClass',
        filePath: 'app/models/user.rb',
      });

      const results = store.getAssociatedChunkIds('User');
      expect(results).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('getCallerChunkIds', () => {
    it('指定メソッドを呼び出しているチャンクの ID を返す', () => {
      // UsersController#create が user.create を呼ぶ
      const ctrlChunk = makeChunk({
        className: 'UsersController',
        methodName: 'create',
        type: 'method',
        filePath: 'app/controllers/users_controller.rb',
      });
      store.saveChunk(ctrlChunk, makeEmbedding(0));

      const call: MethodCall = {
        callerId: 'UsersController#create',
        calleeRaw: 'user.create',
        filePath: 'app/controllers/users_controller.rb',
        line: 10,
      };
      store.saveCall(call);

      const results = store.getCallerChunkIds('User', 'create');
      expect(results).toContain(ctrlChunk.id);
    });

    it('クラスメソッド形式の caller_id（ClassName.method）も解決できる', () => {
      const svcChunk = makeChunk({
        className: 'OrderService',
        methodName: 'process',
        type: 'singleton_method',
        filePath: 'app/services/order_service.rb',
      });
      store.saveChunk(svcChunk, makeEmbedding(0));

      store.saveCall({
        callerId: 'OrderService.process',
        calleeRaw: 'user.notify',
        filePath: 'app/services/order_service.rb',
        line: 5,
      });

      const results = store.getCallerChunkIds('User', 'notify');
      expect(results).toContain(svcChunk.id);
    });

    it('呼び出し元が存在しない場合は空配列を返す', () => {
      expect(store.getCallerChunkIds('User', 'nonexistent_method')).toHaveLength(0);
    });

    it('caller_id に対応するチャンクが存在しない場合は空配列を返す', () => {
      // メソッドコールだけ登録、チャンクは保存しない
      store.saveCall({
        callerId: 'GhostClass#ghost_method',
        calleeRaw: 'user.create',
        filePath: 'app/ghost.rb',
        line: 1,
      });

      const results = store.getCallerChunkIds('User', 'create');
      expect(results).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('getCalleeConstantChunkIds', () => {
    it('定数レシーバーの callee からクラスチャンクを返す', () => {
      // UserMailer の概要チャンクを登録
      const mailerChunk = makeChunk({
        className: 'UserMailer',
        type: 'class',
        filePath: 'app/mailers/user_mailer.rb',
      });
      store.saveChunk(mailerChunk, makeEmbedding(0));

      // UserService#notify が UserMailer.deliver を呼ぶ
      store.saveCall({
        callerId: 'UserService#notify',
        calleeRaw: 'UserMailer.deliver',
        filePath: 'app/services/user_service.rb',
        line: 15,
      });

      const results = store.getCalleeConstantChunkIds('UserService', 'notify');
      expect(results).toContain(mailerChunk.id);
    });

    it('変数レシーバーの callee は無視される', () => {
      const chunk = makeChunk({ className: 'PaymentService', type: 'class' });
      store.saveChunk(chunk, makeEmbedding(0));

      // 小文字始まり（変数レシーバー）は除外
      store.saveCall({
        callerId: 'OrderService#process',
        calleeRaw: 'payment_service.charge',
        filePath: 'app/services/order_service.rb',
        line: 5,
      });

      const results = store.getCalleeConstantChunkIds('OrderService', 'process');
      expect(results).toHaveLength(0);
    });

    it('callee_raw がない場合は空配列を返す', () => {
      expect(store.getCalleeConstantChunkIds('UserService', 'nonexistent')).toHaveLength(0);
    });

    it('クラスメソッド形式（ClassName.method）の caller_id も対象にする', () => {
      const mailerChunk = makeChunk({
        className: 'UserMailer',
        type: 'class',
        filePath: 'app/mailers/user_mailer.rb',
      });
      store.saveChunk(mailerChunk, makeEmbedding(0));

      // クラスメソッドが呼び出す場合
      store.saveCall({
        callerId: 'NotificationService.broadcast',
        calleeRaw: 'UserMailer.notify',
        filePath: 'app/services/notification_service.rb',
        line: 8,
      });

      const results = store.getCalleeConstantChunkIds('NotificationService', 'broadcast');
      expect(results).toContain(mailerChunk.id);
    });
  });
});
