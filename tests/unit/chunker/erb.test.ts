import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chunkErbFile } from '../../../cli/chunker/erb.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../fixtures/erb');

describe('chunkErbFile', () => {
  // ──────────────────────────────────────────────────────────────────
  // 常にファイル全体を 1 チャンクで返す
  // ──────────────────────────────────────────────────────────────────
  describe('ファイル全体チャンク', () => {
    it('チャンク数は常に 1', async () => {
      const result = await chunkErbFile(resolve(FIXTURES, 'template.html.erb'), FIXTURES);
      expect(result.chunks).toHaveLength(1);
    });

    it('content がファイル全体のソースと一致する', async () => {
      const filePath = resolve(FIXTURES, 'template.html.erb');
      const [result, source] = await Promise.all([
        chunkErbFile(filePath, FIXTURES),
        readFile(filePath, 'utf-8'),
      ]);
      expect(result.chunks[0].content).toBe(source);
    });

    it('startLine が 1', async () => {
      const result = await chunkErbFile(resolve(FIXTURES, 'template.html.erb'), FIXTURES);
      expect(result.chunks[0].startLine).toBe(1);
    });

    it('endLine がファイルの行数と一致する', async () => {
      const filePath = resolve(FIXTURES, 'template.html.erb');
      const [result, source] = await Promise.all([
        chunkErbFile(filePath, FIXTURES),
        readFile(filePath, 'utf-8'),
      ]);
      const lineCount = source.split('\n').length;
      expect(result.chunks[0].endLine).toBe(lineCount);
    });

    it('type が "file"', async () => {
      const result = await chunkErbFile(resolve(FIXTURES, 'template.html.erb'), FIXTURES);
      expect(result.chunks[0].type).toBe('file');
    });

    it('filePath が rootDir からの相対パスになっている', async () => {
      const result = await chunkErbFile(resolve(FIXTURES, 'template.html.erb'), FIXTURES);
      expect(result.chunks[0].filePath).toBe('template.html.erb');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // 静的解析インデックスは生成しない
  // ──────────────────────────────────────────────────────────────────
  describe('静的解析インデックス', () => {
    it('definitions / calls / associations は常に空', async () => {
      const result = await chunkErbFile(resolve(FIXTURES, 'template.html.erb'), FIXTURES);
      expect(result.definitions).toHaveLength(0);
      expect(result.calls).toHaveLength(0);
      expect(result.associations).toHaveLength(0);
    });
  });
});
