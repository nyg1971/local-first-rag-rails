import { readdir } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import type { WalkOptions } from './types.ts';

const SUPPORTED_EXTENSIONS = new Set(['.rb', '.erb', '.yml', '.yaml']);

/** 拡張子なしでインデクシング対象とするファイル名 */
const SUPPORTED_BASENAMES = new Set(['Gemfile']);

/** Railsプロジェクトのデフォルト除外ディレクトリ */
const DEFAULT_EXCLUDE = [
  'node_modules',
  '.git',
  'tmp',
  'log',
  'vendor/bundle',
  'public/assets',
  'public/packs',
  'coverage',
  '.bundle',
];

/**
 * rootDir 配下のサポート対象ファイルを再帰的にyieldする。
 * scope指定があればそのディレクトリ配下のみ対象にする。
 */
export async function* walkFiles(
  rootDir: string,
  opts: WalkOptions = {},
): AsyncGenerator<string> {
  const { scope, exclude = [] } = opts;
  const allExclude = [...DEFAULT_EXCLUDE, ...exclude];

  async function* recurse(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 読み取り権限がないディレクトリはスキップ
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath);

      // 除外チェック
      if (allExclude.some((ex) => relPath === ex || relPath.startsWith(ex + '/'))) {
        continue;
      }

      // スコープチェック: 指定がある場合はスコープ内のパスのみ処理する
      if (scope && scope.length > 0) {
        const inScope = scope.some(
          (s) => relPath.startsWith(s + '/') || relPath === s || s.startsWith(relPath + '/'),
        );
        if (!inScope) continue;
      }

      if (entry.isDirectory()) {
        yield* recurse(fullPath);
      } else if (
        SUPPORTED_EXTENSIONS.has(extname(entry.name)) ||
        SUPPORTED_BASENAMES.has(entry.name)
      ) {
        yield fullPath;
      }
    }
  }

  yield* recurse(rootDir);
}
