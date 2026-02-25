/**
 * cli/index.ts main() のファイル単位エラー回復テスト
 *
 * 1ファイルの indexFile() が失敗しても main() はループを継続し、
 * process.exit を呼ばずに正常終了することを検証する。
 *
 * - walkFiles: 実際の tmpDir のファイルを走査（モックしない）
 * - indexFile:  vi.mock で制御（特定呼び出しだけ失敗させる）
 * - embedder:   モック（モデルロードを回避）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 外部依存をモック ──

vi.mock('../../cli/embedder.ts', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768)),
  embedBatch: vi.fn().mockResolvedValue([new Float32Array(768)]),
  EMBEDDING_DIMS: 768,
  EMBEDDING_MODEL: 'test-model',
  getExtractor: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../cli/indexer.ts', () => ({
  indexFile: vi.fn(),
}));

import { main as cliMain } from '../../cli/index.ts';
import { indexFile } from '../../cli/indexer.ts';

// ──────────────────────────────────────────────────────────────────
// テスト
// ──────────────────────────────────────────────────────────────────

describe('cli/index.ts main() — per-file error recovery', () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

const OK = { chunkCount: 1, defCount: 1, callCount: 1, assocCount: 0 };

  beforeEach(() => {
    vi.clearAllMocks(); // 前のテストのモック呼び出し履歴をリセット
    vi.mocked(indexFile).mockResolvedValue(OK); // デフォルトは成功
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-recovery-test-'));
    // process.exit が呼ばれたら検知できるようスパイを仕掛ける（実際には呼ばれないはず）
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      throw new Error(`process.exit(${code ?? 0})`);
    });
    // 進捗出力を抑制
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexFile が失敗しても main() は reject せずに完了する', async () => {
    // 対象ファイルを2つ配置
    writeFileSync(join(tmpDir, 'ok.rb'), 'class Ok; end');
    writeFileSync(join(tmpDir, 'bad.rb'), 'class Bad; end');

    // 最初の呼び出しだけ失敗させ、2回目は成功させる
    vi.mocked(indexFile)
      .mockRejectedValueOnce(new Error('simulated failure'))
      .mockResolvedValue(OK);

    // main() が例外なく完了することを確認
    await expect(cliMain([tmpDir])).resolves.toBeUndefined();
  });

  it('indexFile が失敗しても process.exit は呼ばれない', async () => {
    writeFileSync(join(tmpDir, 'error.rb'), 'class Err; end');

    vi.mocked(indexFile).mockRejectedValue(new Error('always fails'));

    await cliMain([tmpDir]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('複数ファイルのうち1つが失敗しても残りのファイルを処理する', async () => {
    writeFileSync(join(tmpDir, 'a.rb'), 'class A; end');
    writeFileSync(join(tmpDir, 'b.rb'), 'class B; end');
    writeFileSync(join(tmpDir, 'c.rb'), 'class C; end');

    // 真ん中だけ失敗
    vi.mocked(indexFile)
      .mockResolvedValueOnce(OK)                    // a.rb: 成功
      .mockRejectedValueOnce(new Error('b fails'))  // b.rb: 失敗
      .mockResolvedValueOnce(OK);                   // c.rb: 成功

    await expect(cliMain([tmpDir])).resolves.toBeUndefined();

    // indexFile が3ファイル分呼ばれた（失敗後も継続した）
    expect(vi.mocked(indexFile)).toHaveBeenCalledTimes(3);
  });

  it('全ファイルが失敗しても main() は reject しない', async () => {
    writeFileSync(join(tmpDir, 'x.rb'), 'class X; end');
    writeFileSync(join(tmpDir, 'y.rb'), 'class Y; end');

    vi.mocked(indexFile).mockRejectedValue(new Error('disk full'));

    await expect(cliMain([tmpDir])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
