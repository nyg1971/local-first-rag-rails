import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexResult, Chunk } from '../types.ts';

/**
 * YAMLファイルをトップレベルキー単位でチャンク化する。
 * locales/*.yml や config/*.yml を想定。
 * トップキーが見つからない場合はファイル全体を1チャンクとする。
 */
export async function chunkYamlFile(filePath: string, rootDir: string): Promise<IndexResult> {
  const source = await readFile(filePath, 'utf-8');
  const relPath = relative(rootDir, filePath);
  const lines = source.split('\n');

  // トップレベルキーの位置を収集
  // 条件: インデントなし・コメントでない・空行でない・コロンを含む
  const keyPositions: { key: string; lineIdx: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('...')) continue;
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_\-.]*)\s*:/);
    if (match) {
      keyPositions.push({ key: match[1], lineIdx: i });
    }
  }

  const chunks: Chunk[] = [];

  if (keyPositions.length === 0) {
    // トップキーが見つからない場合はファイル全体を1チャンク
    chunks.push({
      id: randomUUID(),
      content: source,
      filePath: relPath,
      startLine: 1,
      endLine: lines.length,
      type: 'file',
    });
  } else {
    for (let i = 0; i < keyPositions.length; i++) {
      const { key, lineIdx } = keyPositions[i];
      const startLine = lineIdx + 1; // 1-indexed
      const endLineIdx =
        i + 1 < keyPositions.length ? keyPositions[i + 1].lineIdx - 1 : lines.length - 1;
      const endLine = endLineIdx + 1; // 1-indexed
      const content = lines.slice(lineIdx, endLineIdx + 1).join('\n');

      chunks.push({
        id: randomUUID(),
        content,
        filePath: relPath,
        startLine,
        endLine,
        type: 'file',
        className: key, // トップレベルキー名をclassNameに格納（YAMLのセクション名）
      });
    }
  }

  return { chunks, definitions: [], calls: [], associations: [] };
}
