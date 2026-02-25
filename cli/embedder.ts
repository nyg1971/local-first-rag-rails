import { pipeline, env } from '@xenova/transformers';

// ※ 要検討: モデル変更時はここと EMBEDDING_DIMS の2箇所を変えてDBを再作成すること
export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-base';
export const EMBEDDING_DIMS = 768;

// Node.js モード設定
env.allowLocalModels = false;
env.useBrowserCache = false;

// multilingual-e5 はクエリに "query: " プレフィックスが推奨されている
// インデクシング時はコードそのままでも可だが "passage: " を付けると精度向上
export const QUERY_PREFIX   = 'query: ';
export const PASSAGE_PREFIX = 'passage: ';

/** バッチサイズ: メモリと速度のバランスを取った値 */
const BATCH_SIZE = 32;

type Extractor = Awaited<ReturnType<typeof pipeline>>;
let _extractor: Extractor | null = null;

/** モデルを遅延ロードし、ロード済みならキャッシュを返す */
export async function getExtractor(): Promise<Extractor> {
  if (_extractor) return _extractor;
  process.stdout.write(`\n[embedder] Loading model: ${EMBEDDING_MODEL} ...`);
  console.time('model_load');
  _extractor = await pipeline('feature-extraction', EMBEDDING_MODEL);
  process.stdout.write(' ');
  console.timeEnd('model_load');
  return _extractor;
}

/**
 * テキスト配列をバッチ処理して埋め込みベクトルを返す。
 * 大量チャンクでもメモリを圧迫しないよう BATCH_SIZE 単位で処理する。
 *
 * @param texts   埋め込むテキスト
 * @param prefix  "passage: " または "query: "（multilingual-e5の推奨形式）
 */
export async function embedBatch(
  texts: string[],
  prefix: string = PASSAGE_PREFIX,
): Promise<Float32Array[]> {
  const extractor = await getExtractor();
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => prefix + t);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const output = await (extractor as any)(batch, { pooling: 'mean', normalize: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const dims: number[] = (output as any).dims as number[];
    const batchSize = dims[0];
    const dim = dims[1];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const flat = (output as any).data as Float32Array;

    for (let j = 0; j < batchSize; j++) {
      results.push(flat.slice(j * dim, (j + 1) * dim));
    }
  }

  return results;
}

/**
 * クエリテキスト1件を埋め込んで返す（検索時に使用）
 */
export async function embedQuery(query: string): Promise<Float32Array> {
  const vecs = await embedBatch([query], QUERY_PREFIX);
  return vecs[0];
}
