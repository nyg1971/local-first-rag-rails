import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkYamlFile } from '../../../cli/chunker/yaml.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../fixtures/yaml');

describe('chunkYamlFile', () => {
  // ──────────────────────────────────────────────────────────────────
  // トップレベルキー分割
  // ──────────────────────────────────────────────────────────────────
  describe('トップレベルキー分割', () => {
    it('トップレベルキーの数だけチャンクが生成される', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      // ja / en / errors の 3 キー
      expect(result.chunks).toHaveLength(3);
    });

    it('className にトップレベルキー名が入る', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      expect(result.chunks[0].className).toBe('ja');
      expect(result.chunks[1].className).toBe('en');
      expect(result.chunks[2].className).toBe('errors');
    });

    it('各チャンクの type が "file"', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      expect(result.chunks.every((c) => c.type === 'file')).toBe(true);
    });

    it('先頭チャンクの startLine が 1', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      expect(result.chunks[0].startLine).toBe(1);
    });

    it('各チャンクの endLine が次のキーの直前行になる', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      // ja チャンク（行1-3）の endLine は en キー（行4）の直前
      expect(result.chunks[0].endLine).toBe(3);
      // en チャンク（行4-6）の endLine は errors キー（行7）の直前
      expect(result.chunks[1].endLine).toBe(6);
    });

    it('各チャンクの content がキー名から始まる', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      expect(result.chunks[0].content).toMatch(/^ja:/);
      expect(result.chunks[1].content).toMatch(/^en:/);
      expect(result.chunks[2].content).toMatch(/^errors:/);
    });

    it('filePath が rootDir からの相対パスになっている', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      expect(result.chunks[0].filePath).toBe('locales.yml');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // フォールバック（トップキーなし）
  // ──────────────────────────────────────────────────────────────────
  describe('フォールバック（トップレベルキーなし）', () => {
    it('トップキーがない場合はファイル全体を 1 チャンクとして返す', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'no_keys.yml'), FIXTURES);
      expect(result.chunks).toHaveLength(1);
    });

    it('フォールバックチャンクの startLine が 1', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'no_keys.yml'), FIXTURES);
      expect(result.chunks[0].startLine).toBe(1);
    });

    it('フォールバックチャンクの type が "file"', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'no_keys.yml'), FIXTURES);
      expect(result.chunks[0].type).toBe('file');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 静的解析インデックスは生成しない
  // ──────────────────────────────────────────────────────────────────
  describe('静的解析インデックス', () => {
    it('definitions / calls / associations は常に空', async () => {
      const result = await chunkYamlFile(resolve(FIXTURES, 'locales.yml'), FIXTURES);
      expect(result.definitions).toHaveLength(0);
      expect(result.calls).toHaveLength(0);
      expect(result.associations).toHaveLength(0);
    });
  });
});
