import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeNDCG, computePrecision, computeRecall, computeMRR } from './retrieval-metrics.js';

// Re-exported for back-compat: callers (and tests) that imported computeNDCG
// from eval-core keep working after the pure-math factor-out.
export { computeNDCG };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

export interface EvalExample {
  id: string;
  query: string;
  relevant_memory_ids: number[];
  expected_answer_themes: string[];
}

export interface QueryResult {
  eval_id: string;
  query: string;
  retrieved_ids: number[];
  relevant_ids: number[];
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
  ndcg_at_k: number;
  reranked: boolean;
  duration_ms: number;
}

export interface EvalConfig {
  mode: string;
  rerank: boolean;
  k: number;
  apiUrl: string;
}

export interface EvalReport {
  timestamp: string;
  config: {
    mode: string;
    rerank: boolean;
    k: number;
    api_url: string;
    dataset_size: number;
  };
  aggregate: {
    mean_precision_at_k: number;
    mean_recall_at_k: number;
    mean_mrr: number;
    mean_ndcg_at_k: number;
  };
  per_query: QueryResult[];
}

interface SearchResponse {
  data: Array<{ memory: { id: number }; score: number; rerank_score?: number }>;
  meta: { reranked: boolean; duration_ms: number };
}

export class ApiHealthError extends Error {
  constructor(apiUrl: string) {
    super(`Cannot reach API at ${apiUrl}. Is the server running?`);
    this.name = 'ApiHealthError';
  }
}

export class DatasetNotFoundError extends Error {
  constructor(datasetPath: string) {
    super(`Dataset not found: ${datasetPath}`);
    this.name = 'DatasetNotFoundError';
  }
}

export function getEvalDatasetPath(): string {
  return path.join(projectRoot, 'data', 'eval_dataset.json');
}

export async function runEvalPass(config: EvalConfig): Promise<EvalReport> {
  const { mode, rerank, k, apiUrl } = config;

  const datasetPath = getEvalDatasetPath();
  if (!fs.existsSync(datasetPath)) {
    throw new DatasetNotFoundError(datasetPath);
  }

  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8')) as EvalExample[];
  console.log(`\nEval config: mode=${mode}, rerank=${rerank}, k=${k}`);
  console.log(`Dataset: ${dataset.length} examples\n`);

  try {
    const health = await fetch(`${apiUrl}/api/health`);
    if (!health.ok) throw new Error(`API returned ${health.status}`);
  } catch {
    throw new ApiHealthError(apiUrl);
  }

  const results: QueryResult[] = [];

  for (const example of dataset) {
    const response = await fetch(`${apiUrl}/api/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: example.query,
        mode,
        rerank,
        rerank_candidates: 20,
        limit: k,
      }),
    });

    if (!response.ok) {
      console.error(`  [${example.id}] Search failed: ${response.status}`);
      continue;
    }

    const data = await response.json() as SearchResponse;
    const retrievedIds = data.data.map(r => r.memory.id);
    const relevantSet = new Set(example.relevant_memory_ids);

    const precision = computePrecision(retrievedIds, relevantSet);
    const recall = computeRecall(retrievedIds, relevantSet);
    const mrr = computeMRR(retrievedIds, relevantSet);
    const ndcg = computeNDCG(retrievedIds, relevantSet, k);

    const qr: QueryResult = {
      eval_id: example.id,
      query: example.query,
      retrieved_ids: retrievedIds,
      relevant_ids: example.relevant_memory_ids,
      precision_at_k: precision,
      recall_at_k: recall,
      mrr,
      ndcg_at_k: ndcg,
      reranked: data.meta.reranked,
      duration_ms: data.meta.duration_ms,
    };

    results.push(qr);

    const status = precision > 0 ? 'HIT' : 'MISS';
    console.log(`  [${example.id}] ${status} P@${k}=${precision.toFixed(2)} R@${k}=${recall.toFixed(2)} MRR=${mrr.toFixed(2)} NDCG=${ndcg.toFixed(2)} (${data.meta.duration_ms}ms)`);
  }

  const n = results.length;
  const aggregate = {
    mean_precision_at_k: results.reduce((s, r) => s + r.precision_at_k, 0) / n,
    mean_recall_at_k: results.reduce((s, r) => s + r.recall_at_k, 0) / n,
    mean_mrr: results.reduce((s, r) => s + r.mrr, 0) / n,
    mean_ndcg_at_k: results.reduce((s, r) => s + r.ndcg_at_k, 0) / n,
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS: ${n} queries | mode=${mode} | rerank=${rerank} | k=${k}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Mean P@${k}:   ${aggregate.mean_precision_at_k.toFixed(4)}`);
  console.log(`  Mean R@${k}:   ${aggregate.mean_recall_at_k.toFixed(4)}`);
  console.log(`  Mean MRR:    ${aggregate.mean_mrr.toFixed(4)}`);
  console.log(`  Mean NDCG@${k}: ${aggregate.mean_ndcg_at_k.toFixed(4)}`);
  console.log(`${'='.repeat(60)}\n`);

  return {
    timestamp: new Date().toISOString(),
    config: { mode, rerank, k, api_url: apiUrl, dataset_size: n },
    aggregate,
    per_query: results,
  };
}
