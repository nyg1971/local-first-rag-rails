/**
 * 差分インデクシング ライフサイクル統合テスト
 *
 * 実際の埋め込みモデルや CLI サブプロセスは使わず、
 * VectorStore + ArchiveStore を直接操作して
 * 追加 → 更新 → 削除のライフサイクルを検証する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { VectorStore } from '../../cli/store.ts';
import { ArchiveStore } from '../../cli/archive.ts';
import type { Chunk } from '../../cli/types.ts';
import { EMBEDDING_DIMS } from '../../cli/embedder.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

/** 次元 index のみ 1.0 を立てたワンホットベクトル */
function makeEmbedding(index: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMS).fill(0);
  vec[index % EMBEDDING_DIMS] = 1.0;
  return vec;
}

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

/** テスト専用: archive DB を直接照会してアーカイブ件数を返す */
function countArchived(archiveDbPath: string, filePath: string): number {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const db = require('better-sqlite3')(archiveDbPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM archived_chunks WHERE file_path = ?')
    .get(filePath) as { cnt: number };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  db.close();
  return row.cnt;
}

/**
 * ファイルをインデックスへ追加するシミュレーション
 * (cli/index.ts の indexFile() 主要部を模倣)
 */
function simulateIndex(
  store: VectorStore,
  filePath: string,
  chunks: Chunk[],
  mtime: number,
  hash: string,
): void {
  chunks.forEach((chunk, i) => {
    store.saveChunk(chunk, makeEmbedding(i));
  });
  store.upsertFileIndex(filePath, mtime, hash);
}

/**
 * ファイル更新のシミュレーション
 * 旧チャンクをアーカイブ → 削除 → 新チャンク保存
 */
function simulateUpdate(
  store: VectorStore,
  archive: ArchiveStore,
  filePath: string,
  newChunks: Chunk[],
  newMtime: number,
  newHash: string,
): void {
  const oldChunks = store.getChunksForFile(filePath);
  if (oldChunks.length > 0) {
    archive.archiveChunks(oldChunks, 'file_changed');
  }
  store.deleteFileData(filePath);
  simulateIndex(store, filePath, newChunks, newMtime, newHash);
}

/**
 * ファイル削除のシミュレーション
 * 旧チャンクをアーカイブ → 削除
 */
function simulateDelete(
  store: VectorStore,
  archive: ArchiveStore,
  filePath: string,
): void {
  const oldChunks = store.getChunksForFile(filePath);
  if (oldChunks.length > 0) {
    archive.archiveChunks(oldChunks, 'file_deleted');
  }
  store.deleteFileData(filePath);
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('差分インデクシング ライフサイクル', () => {
  let tmpDir: string;
  let archiveDbPath: string;
  let store: VectorStore;
  let archive: ArchiveStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexing-test-'));
    archiveDbPath = join(tmpDir, 'index.archive.db');
    store = new VectorStore(join(tmpDir, 'index.db'));
    archive = new ArchiveStore(archiveDbPath);
  });

  afterEach(() => {
    store.close();
    archive.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('新規追加（Add）', () => {
    it('追加後、file_index に記録される', () => {
      const filePath = 'app/models/user.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath })], 1000, 'h1');

      const record = store.getFileRecord(filePath);
      expect(record).not.toBeNull();
      expect(record!.hash).toBe('h1');
      expect(record!.mtime).toBe(1000);
    });

    it('追加後、チャンクが保存される', () => {
      const filePath = 'app/models/user.rb';
      const chunks = [
        makeChunk({ filePath, methodName: 'greet' }),
        makeChunk({ filePath, methodName: 'farewell' }),
      ];
      simulateIndex(store, filePath, chunks, 1000, 'h1');

      expect(store.getChunksForFile(filePath)).toHaveLength(2);
    });

    it('追加後、getAllKnownPaths に現れる', () => {
      const filePath = 'app/models/user.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath })], 1000, 'h1');

      expect(store.getAllKnownPaths().has(filePath)).toBe(true);
    });

    it('追加後、vectorSearch で見つかる', () => {
      const filePath = 'app/models/user.rb';
      const chunk = makeChunk({ filePath });
      simulateIndex(store, filePath, [chunk], 1000, 'h1');

      const results = store.vectorSearch(makeEmbedding(0), 10);
      expect(results.some((r) => r.chunkId === chunk.id)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('更新（Update）', () => {
    it('更新後、file_index が新しい hash・mtime に変わる', () => {
      const filePath = 'app/models/order.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath })], 1000, 'old_hash');
      simulateUpdate(store, archive, filePath, [makeChunk({ filePath })], 2000, 'new_hash');

      const record = store.getFileRecord(filePath);
      expect(record!.hash).toBe('new_hash');
      expect(record!.mtime).toBe(2000);
    });

    it('更新後、旧チャンクは消えて新チャンクだけが残る', () => {
      const filePath = 'app/models/order.rb';
      const oldChunk = makeChunk({ filePath, methodName: 'old_method' });
      simulateIndex(store, filePath, [oldChunk], 1000, 'h1');

      const newChunk = makeChunk({ filePath, methodName: 'new_method' });
      simulateUpdate(store, archive, filePath, [newChunk], 2000, 'h2');

      const remaining = store.getChunksForFile(filePath);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(newChunk.id);
    });

    it('更新後もファイルは getAllKnownPaths に残る', () => {
      const filePath = 'app/models/order.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath })], 1000, 'h1');
      simulateUpdate(store, archive, filePath, [makeChunk({ filePath })], 2000, 'h2');

      expect(store.getAllKnownPaths().has(filePath)).toBe(true);
    });

    it('更新によって旧チャンクがアーカイブされる', () => {
      const filePath = 'app/models/order.rb';
      const oldChunk = makeChunk({ filePath });
      simulateIndex(store, filePath, [oldChunk], 1000, 'h1');
      simulateUpdate(store, archive, filePath, [makeChunk({ filePath })], 2000, 'h2');

      archive.close();
      const archivedCount = countArchived(archiveDbPath, filePath);
      archive = new ArchiveStore(archiveDbPath); // afterEach 用に再オープン

      expect(archivedCount).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('削除（Delete）', () => {
    it('削除後、file_index から消える', () => {
      const filePath = 'app/models/removed.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath })], 1000, 'h1');
      simulateDelete(store, archive, filePath);

      expect(store.getFileRecord(filePath)).toBeNull();
    });

    it('削除後、getAllKnownPaths から消える', () => {
      const filePath = 'app/models/removed.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath })], 1000, 'h1');
      simulateDelete(store, archive, filePath);

      expect(store.getAllKnownPaths().has(filePath)).toBe(false);
    });

    it('削除後、vectorSearch に出現しない', () => {
      const filePath = 'app/models/removed.rb';
      const chunk = makeChunk({ filePath });
      simulateIndex(store, filePath, [chunk], 1000, 'h1');
      simulateDelete(store, archive, filePath);

      const results = store.vectorSearch(makeEmbedding(0), 10);
      expect(results.some((r) => r.chunkId === chunk.id)).toBe(false);
    });

    it('削除によってチャンクがアーカイブされる', () => {
      const filePath = 'app/models/removed.rb';
      simulateIndex(store, filePath, [makeChunk({ filePath }), makeChunk({ filePath })], 1000, 'h1');
      simulateDelete(store, archive, filePath);

      archive.close();
      const archivedCount = countArchived(archiveDbPath, filePath);
      archive = new ArchiveStore(archiveDbPath);

      expect(archivedCount).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('変更検出ロジック', () => {
    it('hash が異なれば「更新が必要」と判定できる', () => {
      store.upsertFileIndex('app/models/user.rb', 1000, 'hash_a');
      const record = store.getFileRecord('app/models/user.rb');
      expect(record?.hash !== 'hash_b').toBe(true); // 再インデクシングが必要
    });

    it('hash が同じなら「変更なし」と判定できる', () => {
      store.upsertFileIndex('app/models/user.rb', 1000, 'hash_a');
      const record = store.getFileRecord('app/models/user.rb');
      expect(record?.hash !== 'hash_a').toBe(false); // スキップ可
    });

    it('getFileRecord が null なら新規ファイルと判定できる', () => {
      expect(store.getFileRecord('app/models/new.rb')).toBeNull();
    });

    it('getAllKnownPaths にないパスは削除されたファイルと判定できる', () => {
      // 前回インデクシング時に登録済みのパス
      store.upsertFileIndex('app/models/old.rb', 1, 'h1');
      store.upsertFileIndex('app/models/alive.rb', 2, 'h2');

      // 今回のスキャンで訪問したパス（old.rb はファイルシステムから消えた想定）
      const visited = new Set(['app/models/alive.rb']);

      // known にあって visited にないもの = 削除されたファイル
      const known = store.getAllKnownPaths();
      const deleted = [...known].filter((p) => !visited.has(p));
      expect(deleted).toContain('app/models/old.rb');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('複数ファイル混在 & フルライフサイクル', () => {
    it('複数ファイルを追加・一部削除しても残りは影響を受けない', () => {
      const file1 = 'app/models/user.rb';
      const file2 = 'app/models/order.rb';
      const file3 = 'app/models/payment.rb';

      simulateIndex(store, file1, [makeChunk({ filePath: file1 })], 1, 'h1');
      simulateIndex(store, file2, [makeChunk({ filePath: file2 })], 2, 'h2');
      simulateIndex(store, file3, [makeChunk({ filePath: file3 })], 3, 'h3');

      simulateDelete(store, archive, file2);

      const known = store.getAllKnownPaths();
      expect(known.has(file1)).toBe(true);
      expect(known.has(file2)).toBe(false);
      expect(known.has(file3)).toBe(true);
    });

    it('Add → Update → Delete の完全ライフサイクルが正常動作する', () => {
      const filePath = 'app/models/lifecycle.rb';

      // 1. Add
      const v1 = makeChunk({ filePath, methodName: 'v1' });
      simulateIndex(store, filePath, [v1], 100, 'h_v1');
      expect(store.getFileRecord(filePath)!.hash).toBe('h_v1');
      expect(store.getChunksForFile(filePath)).toHaveLength(1);

      // 2. Update
      const v2 = makeChunk({ filePath, methodName: 'v2' });
      simulateUpdate(store, archive, filePath, [v2], 200, 'h_v2');
      expect(store.getFileRecord(filePath)!.hash).toBe('h_v2');
      expect(store.getChunksForFile(filePath)[0].id).toBe(v2.id);

      // 3. Delete
      simulateDelete(store, archive, filePath);
      expect(store.getFileRecord(filePath)).toBeNull();
      expect(store.getChunksForFile(filePath)).toHaveLength(0);
      expect(store.getAllKnownPaths().has(filePath)).toBe(false);
    });
  });
});
