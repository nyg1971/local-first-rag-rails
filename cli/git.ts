import { execSync } from 'node:child_process';

export interface GitCommitInfo {
  hash: string;
  message: string;
}

/**
 * 指定ディレクトリが git リポジトリ内かを判定する。
 * git が使えない環境や非リポジトリの場合は false を返す。
 */
export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * git リポジトリのルートディレクトリを返す。
 */
export function getGitRoot(dir: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 指定ファイルの最終コミット情報（hash・メッセージ）を返す。
 * コミットされていないファイルや git が使えない場合は null を返す。
 *
 * @param repoRoot - git リポジトリのルートパス
 * @param relFilePath - リポジトリルートからの相対ファイルパス
 */
export function getLastCommit(
  repoRoot: string,
  relFilePath: string,
): GitCommitInfo | null {
  try {
    const output = execSync(
      `git log -1 --format="%H\t%s" -- "${relFilePath}"`,
      { cwd: repoRoot, encoding: 'utf-8' },
    ).trim();

    if (!output) return null; // 未コミットファイル

    const tabIdx = output.indexOf('\t');
    return {
      hash:    output.slice(0, tabIdx),
      message: output.slice(tabIdx + 1),
    };
  } catch {
    return null;
  }
}
