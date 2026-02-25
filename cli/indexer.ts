import { extname, basename } from 'node:path';
import { chunkRubyFile } from './chunker/ruby.ts';
import { chunkErbFile } from './chunker/erb.ts';
import { chunkYamlFile } from './chunker/yaml.ts';
import { embedBatch } from './embedder.ts';
import { getLastCommit } from './git.ts';
import type { VectorStore } from './store.ts';

export type IndexFileResult = {
  chunkCount: number;
  defCount:   number;
  callCount:  number;
  assocCount: number;
};

/**
 * 単一ファイルをチャンク化・埋め込み・DB保存する。
 *
 * @param filePath  - ファイルの絶対パス
 * @param relPath   - rootDir からの相対パス（DB保存キー）
 * @param rootDir   - Rails プロジェクトのルート（チャンカーに渡す）
 * @param store     - 保存先 VectorStore
 * @param gitRoot   - git リポジトリのルート（null なら git 連携無効）
 * @returns チャンク数・定義数・呼び出し数・アソシエーション数
 * @throws {Error} チャンク化・埋め込み・DB保存のいずれかで失敗した場合、
 *                 `[${phase}] ${原因}` 形式のメッセージで re-throw する
 */
export async function indexFile(
  filePath: string,
  relPath: string,
  rootDir: string,
  store: VectorStore,
  gitRoot: string | null,
): Promise<IndexFileResult> {
  const ext  = extname(filePath);
  const base = basename(filePath);

  let phase = 'チャンク化';
  try {
    let result;
    if (ext === '.rb') {
      result = await chunkRubyFile(filePath, rootDir);
    } else if (ext === '.erb') {
      result = await chunkErbFile(filePath, rootDir);
    } else if (ext === '.yml' || ext === '.yaml') {
      result = await chunkYamlFile(filePath, rootDir);
    } else if (base === 'Gemfile') {
      result = await chunkErbFile(filePath, rootDir);
    } else {
      return { chunkCount: 0, defCount: 0, callCount: 0, assocCount: 0 };
    }

    const gitInfo = gitRoot ? getLastCommit(gitRoot, relPath) : null;

    let chunkCount = 0;
    if (result.chunks.length > 0) {
      const texts = result.chunks.map((c) => c.content);
      phase = '埋め込み';
      const embeddings = await embedBatch(texts);
      phase = 'DB保存';
      for (let i = 0; i < result.chunks.length; i++) {
        store.saveChunk(result.chunks[i], embeddings[i], gitInfo);
        chunkCount++;
      }
    }
    phase = 'DB保存';
    for (const def of result.definitions)    { store.saveDefinition(def); }
    for (const call of result.calls)         { store.saveCall(call); }
    for (const assoc of result.associations) { store.saveAssociation(assoc); }

    return {
      chunkCount,
      defCount:   result.definitions.length,
      callCount:  result.calls.length,
      assocCount: result.associations.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${phase}] ${msg}`);
  }
}
