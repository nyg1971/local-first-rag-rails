import { parseArgs } from 'node:util';
import { resolve, join, relative } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { walkFiles } from './walker.ts';
import { EMBEDDING_MODEL, EMBEDDING_DIMS } from './embedder.ts';
import { VectorStore } from './store.ts';
import { ArchiveStore } from './archive.ts';
import { isGitRepo, getGitRoot, getLastCommit } from './git.ts';
import { indexFile } from './indexer.ts';

// ────────────────────────────────────────────────────────────────────
// エントリーポイント
// ────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // ── CLI 引数のパース ──
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scope:   { type: 'string', short: 's' },
      exclude: { type: 'string', short: 'e' },
      db:      { type: 'string' },
    },
  });

  const targetPath = positionals[0];

  if (!targetPath) {
    console.error(
      'Usage: tsx cli/index.ts <rails-root> [--scope app/models,app/services] [--exclude spec] [--db path/to/output.db]',
    );
    process.exit(1);
  }

  const rootDir  = resolve(targetPath);
  const scope    = values.scope?.split(',').map((s) => s.trim());
  const exclude  = values.exclude?.split(',').map((s) => s.trim());
  const dbPath   = values.db
    ? resolve(values.db)
    : join(rootDir, '.rag', 'index.db');

  // ── git 自動判定 ──
  const gitRoot = isGitRepo(rootDir) ? getGitRoot(rootDir) : null;
  const useGit  = gitRoot !== null;

  console.log(`\n[local-first-rag] Indexing: ${rootDir}`);
  console.log(`  Model:   ${EMBEDDING_MODEL} (${EMBEDDING_DIMS}dims)`);
  console.log(`  DB:      ${dbPath}`);
  console.log(`  Git:     ${useGit ? `enabled (${gitRoot})` : 'disabled (not a git repo)'}`);
  if (scope)   console.log(`  Scope:   ${scope.join(', ')}`);
  if (exclude) console.log(`  Exclude: ${exclude.join(', ')}`);
  console.log('');

  const archivePath = dbPath.endsWith('.db')
    ? dbPath.slice(0, -3) + '.archive.db'
    : dbPath + '.archive.db';

  // ── DB 初期化（失敗時は即終了） ──
  let store: VectorStore;
  let archiveStore: ArchiveStore;
  try {
    store = new VectorStore(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[local-first-rag] DBのオープンに失敗しました: ${dbPath}`);
    console.error(`  原因: ${msg}`);
    console.error('  ディスクの空き容量・ファイルのパーミッションを確認してください。');
    process.exit(1);
  }
  try {
    archiveStore = new ArchiveStore(archivePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[local-first-rag] アーカイブDBのオープンに失敗しました: ${archivePath}`);
    console.error(`  原因: ${msg}`);
    store.close();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────────────
  // インデクシング実行（ストリーミング: チャンクごとに逐次保存）
  // ────────────────────────────────────────────────────────────────────
  let addedCount   = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount   = 0;
  let chunkCount   = 0;
  let defCount     = 0;
  let callCount    = 0;
  let assocCount   = 0;

  function fileHash(path: string): string {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  }

  function withGitInfo(
    chunks: ReturnType<typeof store.getChunksForFile>,
    relFilePath: string,
  ) {
    const commit = useGit && gitRoot ? getLastCommit(gitRoot, relFilePath) : null;
    return chunks.map((c) => ({
      ...c,
      git_hash:    commit?.hash    ?? null,
      git_message: commit?.message ?? null,
    }));
  }

  function printProgress(): void {
    process.stdout.write(
      `\r  Added: ${addedCount}  Updated: ${updatedCount}  Skipped: ${skippedCount}  Chunks: ${chunkCount}`,
    );
  }

  // ── 差分検出の基準: 前回記録済みのファイルパス一覧 ──
  const knownPaths   = store.getAllKnownPaths();
  const visitedPaths = new Set<string>();

  for await (const filePath of walkFiles(rootDir, { scope, exclude })) {
    const relPath = relative(rootDir, filePath);
    visitedPaths.add(relPath);

    try {
      const stat   = statSync(filePath);
      const mtime  = stat.mtimeMs;
      const record = store.getFileRecord(relPath);

      if (record && record.mtime === mtime) {
        skippedCount++;
        printProgress();
        continue;
      }

      const hash = fileHash(filePath);
      if (record && record.hash === hash) {
        store.upsertFileIndex(relPath, mtime, hash);
        skippedCount++;
        printProgress();
        continue;
      }

      if (record) {
        const oldChunks = store.getChunksForFile(relPath);
        if (oldChunks.length > 0) archiveStore.archiveChunks(withGitInfo(oldChunks, relPath), 'file_changed');
        store.deleteFileData(relPath);
        updatedCount++;
      } else {
        addedCount++;
      }

      const saved = await indexFile(filePath, relPath, rootDir, store, gitRoot);
      chunkCount += saved.chunkCount;
      defCount   += saved.defCount;
      callCount  += saved.callCount;
      assocCount += saved.assocCount;
      store.upsertFileIndex(relPath, mtime, hash);
      printProgress();

    } catch (err) {
      errorCount++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n  [WARN] Skip ${filePath}: ${msg}\n`);
    }
  }

  // ── 削除されたファイルの処理 ──
  let deletedCount = 0;
  for (const knownPath of knownPaths) {
    if (!visitedPaths.has(knownPath)) {
      try {
        const oldChunks = store.getChunksForFile(knownPath);
        if (oldChunks.length > 0) archiveStore.archiveChunks(withGitInfo(oldChunks, knownPath), 'file_deleted');
        store.deleteFileData(knownPath);
        deletedCount++;
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n  [WARN] 削除処理スキップ ${knownPath}: ${msg}\n`);
      }
    }
  }

  store.close();
  archiveStore.close();

  // ── 結果サマリー ──
  console.log('\n\n[local-first-rag] Done.');
  console.log(`  Added  : ${addedCount} files`);
  console.log(`  Updated: ${updatedCount} files`);
  console.log(`  Deleted: ${deletedCount} files`);
  console.log(`  Skipped: ${skippedCount} files (unchanged)`);
  console.log(`  Errors : ${errorCount}`);
  console.log(`  Chunks : ${chunkCount}  Defs: ${defCount}  Calls: ${callCount}  Assocs: ${assocCount}`);
  console.log(`  DB     : ${dbPath}`);
  if (updatedCount + deletedCount > 0) {
    console.log(`  Archive: ${archivePath}`);
  }
}

// スクリプトとして直接実行された場合のみ main() を呼ぶ
// （import された場合は呼ばない）
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
