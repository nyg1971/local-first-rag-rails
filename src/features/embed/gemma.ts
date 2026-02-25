import { pipeline, env } from '@xenova/transformers';
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 2;
env.useBrowserCache = true;
let _extractor: any | null = null;

export async function getEmbedder() {
    if (_extractor) return _extractor;
    _extractor = await pipeline(
        'feature-extraction',
        'Xenova/embedding-gemma-2b-int8');
    return _extractor;
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await getEmbedder();
    const outputs = await extractor(texts, { pooling:'mean', normalize:true });
    return Array.isArray(outputs) ? outputs : [outputs] as any;
}