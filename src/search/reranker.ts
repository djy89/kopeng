import config from '../config/config.js';
import logger from '../utils/logger.js';
import { importWithoutDuplicateRejection } from '../utils/import-safely.js';

let tokenizer: any;
let model: any;
let loading = false;

export async function initReranker(): Promise<void> {
  if (model || loading) return;
  loading = true;

  const startTime = Date.now();
  const modelName = config.reranker.model;
  logger.info(`Loading reranker model: ${modelName}`);

  // Same guard as the embedder: if a search is what first touches the ONNX
  // runtime, its load failure must stay a caught error, not a fatal twin.
  const { AutoTokenizer, AutoModelForSequenceClassification, env } =
    await importWithoutDuplicateRejection(() => import('@xenova/transformers'));
  env.cacheDir = config.embedding.cacheDir;
  env.allowRemoteModels = true;

  tokenizer = await AutoTokenizer.from_pretrained(modelName);
  model = await AutoModelForSequenceClassification.from_pretrained(modelName, {
    quantized: true,
  });

  // Warmup
  const warmupInputs = tokenizer('query', { text_pair: 'passage', padding: true, truncation: true });
  await model(warmupInputs);

  const elapsed = Date.now() - startTime;
  logger.info(`Reranker model loaded in ${elapsed}ms`);
  loading = false;
}

export function isRerankerReady(): boolean {
  return model !== null && model !== undefined;
}

export interface RerankCandidate {
  id: number;
  content: string;
  originalScore: number;
}

export interface RerankResult {
  id: number;
  rerank_score: number;
  originalScore: number;
}

/**
 * Rerank candidates using cross-encoder.
 * Uses AutoModelForSequenceClassification directly to get raw logits,
 * since the pipeline abstraction applies sigmoid and clamps scores.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[]> {
  if (!model) {
    await initReranker();
  }

  if (!model || !tokenizer) {
    throw new Error('Reranker model failed to load');
  }

  const results: RerankResult[] = [];

  for (const candidate of candidates) {
    const inputs = tokenizer(query, {
      text_pair: candidate.content,
      padding: true,
      truncation: true,
    });

    const output = await model(inputs);

    // Raw logit — single value, higher = more relevant
    // Typical range: -12 (irrelevant) to +10 (highly relevant)
    const score = output.logits.data[0] as number;

    results.push({
      id: candidate.id,
      rerank_score: score,
      originalScore: candidate.originalScore,
    });
  }

  // Sort by rerank score descending
  results.sort((a, b) => b.rerank_score - a.rerank_score);

  return results;
}
