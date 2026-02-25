import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isGitRepo, getGitRoot, getLastCommit } from '../../cli/git.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** このプロジェクト自体が git リポジトリなので、テストの基準として使う */
const PROJECT_ROOT = resolve(__dirname, '../..');

describe('git utilities', () => {
  // ──────────────────────────────────────────────────────────────────
  describe('isGitRepo', () => {
    it('git リポジトリ内のディレクトリでは true を返す', () => {
      expect(isGitRepo(PROJECT_ROOT)).toBe(true);
    });

    it('git リポジトリ外（一時ディレクトリ）では false を返す', () => {
      const tmpDir = mkdtempSync(`${tmpdir()}/rag-git-test-`);
      try {
        expect(isGitRepo(tmpDir)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('存在しないディレクトリでは false を返す（例外を投げない）', () => {
      expect(isGitRepo('/no/such/directory/xyz')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('getGitRoot', () => {
    it('プロジェクトルートを文字列で返す', () => {
      const root = getGitRoot(PROJECT_ROOT);
      expect(root).not.toBeNull();
      expect(typeof root).toBe('string');
    });

    it('返り値がプロジェクトルートと一致する', () => {
      const root = getGitRoot(PROJECT_ROOT);
      expect(root).toBe(PROJECT_ROOT);
    });

    it('git リポジトリ外では null を返す', () => {
      const tmpDir = mkdtempSync(`${tmpdir()}/rag-git-test-`);
      try {
        expect(getGitRoot(tmpDir)).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('getLastCommit', () => {
    it('コミット済みファイルの hash と message を返す', () => {
      // package.json は initial commit で追加済み
      const info = getLastCommit(PROJECT_ROOT, 'package.json');
      expect(info).not.toBeNull();
      expect(info!.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(info!.message).toBeTruthy();
    });

    it('hash が 40 文字の hex 文字列', () => {
      const info = getLastCommit(PROJECT_ROOT, 'package.json');
      expect(info!.hash).toHaveLength(40);
    });

    it('存在しないファイルは null を返す', () => {
      expect(getLastCommit(PROJECT_ROOT, 'no/such/file.rb')).toBeNull();
    });

    it('git リポジトリ外では null を返す（例外なし）', () => {
      const tmpDir = mkdtempSync(`${tmpdir()}/rag-git-test-`);
      try {
        expect(getLastCommit(tmpDir, 'something.rb')).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
