import config from '../config/config.js';
import logger from '../utils/logger.js';

// Dynamic import for @xenova/transformers (ESM)
let pipeline: any;
let extractor: any;

// LRU embedding cache — avoids re-embedding identical queries
const EMBED_CACHE_MAX = 200;
const embedCache = new Map<string, Float32Array>();

function getCachedEmbedding(text: string): Float32Array | undefined {
  const cached = embedCache.get(text);
  if (cached) {
    // Move to end (most recently used)
    embedCache.delete(text);
    embedCache.set(text, cached);
  }
  return cached;
}

function setCachedEmbedding(text: string, embedding: Float32Array): void {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    // Evict oldest (first key)
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(text, embedding);
}

export async function initEmbedder(): Promise<void> {
  const startTime = Date.now();
  logger.info(`Loading embedding model: ${config.embedding.model}`);

  // Dynamic import
  const { pipeline: pipelineFn, env } = await import('@xenova/transformers');
  pipeline = pipelineFn;

  // Set cache directory for model downloads
  env.cacheDir = config.embedding.cacheDir;
  // Disable remote model checks after first download
  env.allowRemoteModels = true;

  extractor = await pipeline('feature-extraction', config.embedding.model, {
    quantized: true,
  });

  // Warmup
  await embed('warmup');

  const elapsed = Date.now() - startTime;
  logger.info(`Embedding model loaded in ${elapsed}ms`);
}

export async function embed(text: string): Promise<Float32Array> {
  if (!extractor) {
    throw new Error('Embedding model not initialized. Call initEmbedder() first.');
  }

  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const output = await extractor(text, { pooling: 'mean', normalize: true });
  const result = new Float32Array(output.data);
  setCachedEmbedding(text, result);
  return result;
}

/** `embed` plus the model name — the shape the dream apply path's embedText dependency wants (D2.2). */
export async function embedWithModel(text: string): Promise<{ vector: Float32Array; model: string }> {
  return { vector: await embed(text), model: config.embedding.model };
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}

export function isEmbedderReady(): boolean {
  return extractor !== null && extractor !== undefined;
}
