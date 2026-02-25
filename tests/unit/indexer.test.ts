/**
 * cli/indexer.ts の単体テスト
 *
 * 重点: indexFile() の
 *   1. フェーズ付きエラーメッセージ（[チャンク化] / [埋め込み] / [DB保存]）
 *   2. 対象外ファイルは 0 を返す
 *   3. 正常系でチャンク数を返す
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexFile } from '../../cli/indexer.ts';
import type { VectorStore } from '../../cli/store.ts';

// ── embedder をモック（280MB モデルロードを回避） ──
vi.mock('../../cli/embedder.ts', () => ({
  embedBatch: vi.fn().mockResolvedValue([new Float32Array(768)]),
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768)),
  EMBEDDING_DIMS: 768,
  EMBEDDING_MODEL: 'test-model',
  getExtractor: vi.fn(),
}));

import { embedBatch } from '../../cli/embedder.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

function makeMockStore(): VectorStore {
  return {
    saveChunk: vi.fn(),
    saveDefinition: vi.fn(),
    saveCall: vi.fn(),
    saveAssociation: vi.fn(),
    vectorSearch: vi.fn().mockReturnValue([]),
    ftsSearch: vi.fn().mockReturnValue([]),
    getReferences: vi.fn().mockReturnValue({ callers: [], callees: [], associations: [] }),
    getChunksForFile: vi.fn().mockReturnValue([]),
    getAllKnownPaths: vi.fn().mockReturnValue(new Set()),
    getFileRecord: vi.fn().mockReturnValue(null),
    upsertFileIndex: vi.fn(),
    deleteFileData: vi.fn(),
    close: vi.fn(),
  } as unknown as VectorStore;
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('indexFile', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(embedBatch).mockResolvedValue([new Float32Array(768)]);
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  describe('対象外ファイル', () => {
    it('.txt ファイルは 0 を返す（チャンク化スキップ）', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexer-'));
      const filePath = join(tmpDir, 'readme.txt');
      writeFileSync(filePath, 'hello world');

      const result = await indexFile(filePath, 'readme.txt', tmpDir, makeMockStore(), null);
      expect(result.chunkCount).toBe(0);
    });

    it('.js ファイルも 0 を返す', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexer-'));
      const filePath = join(tmpDir, 'app.js');
      writeFileSync(filePath, 'console.log("hi")');

      const result = await indexFile(filePath, 'app.js', tmpDir, makeMockStore(), null);
      expect(result.chunkCount).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('フェーズ付きエラーメッセージ', () => {
    it('[埋め込み] フェーズで失敗するとエラーメッセージに "[埋め込み]" が含まれる', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexer-'));
      // チャンクを生成するために有効な Ruby ファイルを作成
      const filePath = join(tmpDir, 'user.rb');
      writeFileSync(filePath, 'class User\n  def greet; end\nend\n');

      // embedBatch を失敗させる
      vi.mocked(embedBatch).mockRejectedValueOnce(new Error('model unavailable'));

      await expect(
        indexFile(filePath, 'user.rb', tmpDir, makeMockStore(), null),
      ).rejects.toThrow('[埋め込み] model unavailable');
    });

    it('[DB保存] フェーズで失敗するとエラーメッセージに "[DB保存]" が含まれる', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexer-'));
      const filePath = join(tmpDir, 'user.rb');
      writeFileSync(filePath, 'class User\n  def greet; end\nend\n');

      const store = makeMockStore();
      vi.mocked(store.saveChunk).mockImplementation(() => {
        throw new Error('DB is locked');
      });

      await expect(
        indexFile(filePath, 'user.rb', tmpDir, store, null),
      ).rejects.toThrow('[DB保存] DB is locked');
    });

    it('[チャンク化] フェーズで失敗するとエラーメッセージに "[チャンク化]" が含まれる', async () => {
      // 存在しないファイルパスを渡す → readFile が ENOENT で失敗 = チャンク化フェーズのエラー
      await expect(
        indexFile('/no/such/file.rb', 'file.rb', '/no/such', makeMockStore(), null),
      ).rejects.toThrow('[チャンク化]');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('正常系', () => {
    it('有効な Ruby ファイルは保存したチャンク数を返す', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexer-'));
      const filePath = join(tmpDir, 'user.rb');
      // クラス概要チャンク(1) + 2メソッド = 3チャンク
      writeFileSync(filePath, 'class User\n  def greet; end\n  def farewell; end\nend\n');

      // embedBatch は 3チャンク分のベクトルを返す
      vi.mocked(embedBatch).mockResolvedValueOnce([
        new Float32Array(768),
        new Float32Array(768),
        new Float32Array(768),
      ]);

      const result = await indexFile(filePath, 'user.rb', tmpDir, makeMockStore(), null);
      expect(result.chunkCount).toBe(3);
    });

    it('YAML ファイルも処理できる', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'rag-indexer-'));
      const filePath = join(tmpDir, 'locales.yml');
      writeFileSync(filePath, 'ja:\n  hello: こんにちは\n');

      vi.mocked(embedBatch).mockResolvedValueOnce([new Float32Array(768)]);

      const result = await indexFile(filePath, 'locales.yml', tmpDir, makeMockStore(), null);
      expect(result.chunkCount).toBe(1);
    });
  });
});
