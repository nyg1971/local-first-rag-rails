import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkFiles } from '../../cli/walker.ts';

// ──────────────────────────────────────────────────────────────────
// テストヘルパー
// ──────────────────────────────────────────────────────────────────

async function collectFiles(dir: string, opts = {}): Promise<string[]> {
  const files: string[] = [];
  for await (const f of walkFiles(dir, opts)) {
    files.push(f);
  }
  return files;
}

// ──────────────────────────────────────────────────────────────────
// テストスイート
// ──────────────────────────────────────────────────────────────────

describe('walkFiles', () => {
  // ──────────────────────────────────────────────────────────────────
  describe('読み取り権限がないディレクトリ（no-throw）', () => {
    it('chmod 000 のディレクトリをスキップして例外を投げない', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'rag-walker-test-'));
      const unreadableDir = join(tmpDir, 'no-permission');
      mkdirSync(unreadableDir);
      chmodSync(unreadableDir, 0o000);

      try {
        await expect(collectFiles(tmpDir)).resolves.toBeDefined();
      } finally {
        chmodSync(unreadableDir, 0o755); // rmSync のために権限を戻す
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('読み取り不可ディレクトリの中身は結果に含まれない', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'rag-walker-test-'));
      const unreadableDir = join(tmpDir, 'no-permission');
      mkdirSync(unreadableDir);
      // Ruby ファイルを先に作成してから権限を剥奪
      writeFileSync(join(unreadableDir, 'secret.rb'), 'class Secret; end');
      chmodSync(unreadableDir, 0o000);

      try {
        const files = await collectFiles(tmpDir);
        expect(files.some((f) => f.includes('secret.rb'))).toBe(false);
      } finally {
        chmodSync(unreadableDir, 0o755);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('他の読み取り可能なディレクトリのファイルは引き続き取得できる', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'rag-walker-test-'));
      const unreadableDir = join(tmpDir, 'no-permission');
      const readableDir = join(tmpDir, 'app', 'models');

      mkdirSync(unreadableDir);
      mkdirSync(readableDir, { recursive: true });
      chmodSync(unreadableDir, 0o000);
      writeFileSync(join(readableDir, 'user.rb'), 'class User; end');

      try {
        const files = await collectFiles(tmpDir);
        expect(files.some((f) => f.includes('user.rb'))).toBe(true);
      } finally {
        chmodSync(unreadableDir, 0o755);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe('対象外ファイルのフィルタリング', () => {
    it('.rb .erb .yml .yaml Gemfile のみを返す', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'rag-walker-test-'));

      try {
        writeFileSync(join(tmpDir, 'user.rb'), '');
        writeFileSync(join(tmpDir, 'view.erb'), '');
        writeFileSync(join(tmpDir, 'locales.yml'), '');
        writeFileSync(join(tmpDir, 'Gemfile'), '');
        writeFileSync(join(tmpDir, 'README.md'), ''); // 対象外
        writeFileSync(join(tmpDir, 'app.js'), '');    // 対象外

        const files = await collectFiles(tmpDir);
        expect(files).toHaveLength(4);
        expect(files.some((f) => f.endsWith('.md'))).toBe(false);
        expect(files.some((f) => f.endsWith('.js'))).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('DEFAULT_EXCLUDE に含まれるディレクトリはスキップされる', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'rag-walker-test-'));
      const nodeModulesDir = join(tmpDir, 'node_modules', 'some-gem');

      try {
        mkdirSync(nodeModulesDir, { recursive: true });
        writeFileSync(join(nodeModulesDir, 'lib.rb'), '');

        const files = await collectFiles(tmpDir);
        expect(files.some((f) => f.includes('node_modules'))).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('scope を指定すると対象ディレクトリ外はスキップされる', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'rag-walker-test-'));
      const modelsDir = join(tmpDir, 'app', 'models');
      const servicesDir = join(tmpDir, 'app', 'services');

      try {
        mkdirSync(modelsDir, { recursive: true });
        mkdirSync(servicesDir, { recursive: true });
        writeFileSync(join(modelsDir, 'user.rb'), '');
        writeFileSync(join(servicesDir, 'payment.rb'), '');

        const files = await collectFiles(tmpDir, { scope: ['app/models'] });
        expect(files.some((f) => f.includes('user.rb'))).toBe(true);
        expect(files.some((f) => f.includes('payment.rb'))).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
