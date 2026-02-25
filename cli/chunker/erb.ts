import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexResult } from '../types.ts';

/**
 * ERBファイルをファイル単位のチャンクとして返す。
 * テンプレートは構文的に分割しにくいためファイル全体を1チャンクとする。
 */
export async function chunkErbFile(filePath: string, rootDir: string): Promise<IndexResult> {
  const source = await readFile(filePath, 'utf-8');
  const relPath = relative(rootDir, filePath);
  const lineCount = source.split('\n').length;

  return {
    chunks: [
      {
        id: randomUUID(),
        content: source,
        filePath: relPath,
        startLine: 1,
        endLine: lineCount,
        type: 'file',
      },
    ],
    definitions: [],
    calls: [],
    associations: [],
  };
}
