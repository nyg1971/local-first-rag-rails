/**
 * CLI / サーバー 起動エラーテスト
 *
 * main() を直接インポートして呼び出し、
 * process.exit と console.error の呼ばれ方を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

// ── 外部依存をモック ──

// embedder（モデルロードを回避）
vi.mock('../../cli/embedder.ts', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768)),
  embedBatch: vi.fn(),
  EMBEDDING_DIMS: 768,
  EMBEDDING_MODEL: 'test-model',
  getExtractor: vi.fn().mockResolvedValue({}),
}));

// walker（ファイル走査を回避）
vi.mock('../../cli/walker.ts', () => ({
  walkFiles: vi.fn(async function* () { /* 何も yield しない */ }),
}));

import { main as cliMain } from '../../cli/index.ts';
import { main as serverMain } from '../../server/index.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

/** process.exit をモックして「終了コード付き Error」として throw させる */
function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    throw new Error(`process.exit(${code ?? 0})`);
  });
}

// ──────────────────────────────────────────────────────────────────
// CLI main() テスト
// ──────────────────────────────────────────────────────────────────

describe('cli/index.ts main()', () => {
  let exitSpy: ReturnType<typeof mockProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    exitSpy  = mockProcessExit();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-cli-test-'));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('引数エラー', () => {
    it('引数なしで呼ぶと process.exit(1) が呼ばれる', async () => {
      await expect(cliMain([])).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('引数なしで呼ぶと Usage メッセージが出力される', async () => {
      await expect(cliMain([])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage:'),
      );
    });
  });

  describe('DB オープン失敗', () => {
    it('書き込み不可なパスを DB に指定すると process.exit(1) が呼ばれる', async () => {
      // 存在しない深いパス（権限エラーではなくディレクトリ作成失敗を誘発）
      await expect(
        cliMain([tmpDir, '--db', '/root/no-permission/test.db']),
      ).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('DB オープン失敗時のエラーメッセージに "DBのオープンに失敗" が含まれる', async () => {
      await expect(
        cliMain([tmpDir, '--db', '/root/no-permission/test.db']),
      ).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DBのオープンに失敗しました'),
      );
    });

    it('DB オープン失敗時のエラーメッセージにディスク確認案内が含まれる', async () => {
      await expect(
        cliMain([tmpDir, '--db', '/root/no-permission/test.db']),
      ).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ディスクの空き容量'),
      );
    });
  });

  describe('正常終了', () => {
    it('有効なディレクトリを渡すと process.exit を呼ばずに完了する', async () => {
      // walkFiles モックが何も返さないため即完了する
      await cliMain([tmpDir]);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// サーバー main() テスト
// ──────────────────────────────────────────────────────────────────

describe('server/index.ts main()', () => {
  let exitSpy: ReturnType<typeof mockProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  // 正常起動したサーバーをテスト後に確実に閉じるために保持
  let startedServer: Server | null = null;

  beforeEach(() => {
    exitSpy  = mockProcessExit();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // console.log も黙らせてテスト出力を抑制
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-server-test-'));
  });

  afterEach(async () => {
    // 起動されたサーバーをクローズしてポートを解放する
    if (startedServer) {
      await new Promise<void>((resolve) => startedServer!.close(() => resolve()));
      startedServer = null;
    }
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('引数エラー', () => {
    it('--db を指定しないと process.exit(1) が呼ばれる', async () => {
      await expect(serverMain([])).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('--db なしで Usage メッセージが出力される', async () => {
      await expect(serverMain([])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage:'),
      );
    });
  });

  describe('DB オープン失敗', () => {
    it('不正な DB パスを指定すると process.exit(1) が呼ばれる', async () => {
      await expect(
        serverMain(['--db', '/root/no-permission/index.db']),
      ).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('DB オープン失敗時のエラーメッセージに "DBのオープンに失敗" が含まれる', async () => {
      await expect(
        serverMain(['--db', '/root/no-permission/index.db']),
      ).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DBのオープンに失敗しました'),
      );
    });

    it('DB オープン失敗時に インデクシング実行案内が含まれる', async () => {
      await expect(
        serverMain(['--db', '/root/no-permission/index.db']),
      ).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('pnpm index'),
      );
    });
  });

  describe('埋め込みモデル ロード失敗', () => {
    it('getExtractor が失敗すると process.exit(1) が呼ばれる', async () => {
      const { getExtractor } = await import('../../cli/embedder.ts');
      vi.mocked(getExtractor).mockRejectedValueOnce(new Error('network error'));

      // 有効な DB ファイルを作成（DB オープン自体は成功させる）
      const dbPath = join(tmpDir, 'test.db');
      const { VectorStore } = await import('../../cli/store.ts');
      const store = new VectorStore(dbPath);
      store.close();

      await expect(
        serverMain(['--db', dbPath]),
      ).rejects.toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('モデルロード失敗時のエラーメッセージに "埋め込みモデル" が含まれる', async () => {
      const { getExtractor } = await import('../../cli/embedder.ts');
      vi.mocked(getExtractor).mockRejectedValueOnce(new Error('timeout'));

      const dbPath = join(tmpDir, 'test.db');
      const { VectorStore } = await import('../../cli/store.ts');
      const store = new VectorStore(dbPath);
      store.close();

      await expect(serverMain(['--db', dbPath])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('埋め込みモデルのロードに失敗しました'),
      );
    });

    it('モデルロード失敗時に ネットワーク確認案内が含まれる', async () => {
      const { getExtractor } = await import('../../cli/embedder.ts');
      vi.mocked(getExtractor).mockRejectedValueOnce(new Error('timeout'));

      const dbPath = join(tmpDir, 'test.db');
      const { VectorStore } = await import('../../cli/store.ts');
      const store = new VectorStore(dbPath);
      store.close();

      await expect(serverMain(['--db', dbPath])).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ネットワーク接続'),
      );
    });
  });

  describe('正常終了', () => {
    it('有効な DB と --port 0 を指定するとサーバーが起動する', async () => {
      const dbPath = join(tmpDir, 'test.db');
      const { VectorStore } = await import('../../cli/store.ts');
      const store = new VectorStore(dbPath);
      store.close();

      // port 0 = OS が空きポートを自動割り当て（ポート競合を防ぐ）
      startedServer = await serverMain(['--db', dbPath, '--port', '0']);
      expect(startedServer).toBeDefined();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('/health エンドポイントが正常応答する', async () => {
      const dbPath = join(tmpDir, 'test.db');
      const { VectorStore } = await import('../../cli/store.ts');
      const store = new VectorStore(dbPath);
      store.close();

      startedServer = await serverMain(['--db', dbPath, '--port', '0']);
      const addr = startedServer.address() as { port: number };

      const res = await fetch(`http://localhost:${addr.port}/health`);
      expect(res.ok).toBe(true);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    });
  });
});
