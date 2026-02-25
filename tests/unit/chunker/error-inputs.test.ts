import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkRubyFile } from '../../../cli/chunker/ruby.ts';
import { chunkYamlFile } from '../../../cli/chunker/yaml.ts';
import { chunkErbFile } from '../../../cli/chunker/erb.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUBY_FIXTURES = resolve(__dirname, '../../fixtures/ruby');
const YAML_FIXTURES = resolve(__dirname, '../../fixtures/yaml');
const ERB_FIXTURES = resolve(__dirname, '../../fixtures/erb');

// ──────────────────────────────────────────────────────────────────
// 存在しないファイルへのアクセス
// ──────────────────────────────────────────────────────────────────

describe('存在しないファイル（ENOENT）', () => {
  it('chunkRubyFile: 存在しないファイルは ENOENT エラーで reject される', async () => {
    await expect(
      chunkRubyFile('/no/such/file.rb', '/no/such'),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('chunkYamlFile: 存在しないファイルは ENOENT エラーで reject される', async () => {
    await expect(
      chunkYamlFile('/no/such/file.yml', '/no/such'),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('chunkErbFile: 存在しないファイルは ENOENT エラーで reject される', async () => {
    await expect(
      chunkErbFile('/no/such/template.html.erb', '/no/such'),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });
});

// ──────────────────────────────────────────────────────────────────
// Ruby 構文エラー
// ──────────────────────────────────────────────────────────────────

describe('Ruby 構文エラーファイル', () => {
  // tree-sitter は構文エラーがあっても例外を投げず、
  // ERROR ノードを含む AST を返す設計のため、チャンカーも例外なしで完了する。

  it('構文エラーのある Ruby ファイルでも例外を投げない', async () => {
    await expect(
      chunkRubyFile(resolve(RUBY_FIXTURES, 'syntax_error.rb'), RUBY_FIXTURES),
    ).resolves.toBeDefined();
  });

  it('構文エラーのある Ruby ファイルは IndexResult を返す', async () => {
    const result = await chunkRubyFile(
      resolve(RUBY_FIXTURES, 'syntax_error.rb'),
      RUBY_FIXTURES,
    );
    // IndexResult の構造を持つ
    expect(result).toHaveProperty('chunks');
    expect(result).toHaveProperty('definitions');
    expect(result).toHaveProperty('calls');
    expect(result).toHaveProperty('associations');
  });

  it('構文エラーのある Ruby ファイルは配列プロパティを返す（クラッシュしない）', async () => {
    const result = await chunkRubyFile(
      resolve(RUBY_FIXTURES, 'syntax_error.rb'),
      RUBY_FIXTURES,
    );
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(Array.isArray(result.definitions)).toBe(true);
    expect(Array.isArray(result.calls)).toBe(true);
    expect(Array.isArray(result.associations)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// YAML チャンカーの境界ケース
// ──────────────────────────────────────────────────────────────────

describe('YAML チャンカー境界ケース', () => {
  // chunkYamlFile は js-yaml を使わず正規表現ベースのため、
  // 「不正 YAML」は例外を投げない。キーが見つからなければ
  // ファイル全体を 1 チャンクで返すフォールバック動作になる。

  it('コメントのみのファイルはフォールバックで 1 チャンクを返す', async () => {
    const result = await chunkYamlFile(
      resolve(YAML_FIXTURES, 'no_keys.yml'),
      YAML_FIXTURES,
    );
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].type).toBe('file');
  });
});
