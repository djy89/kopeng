import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ApiHealthError,
  DatasetNotFoundError,
  type EvalReport,
  type QueryResult,
  runEvalPass,
} from './lib/eval-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';

function format4(value: number): string {
  return value.toFixed(4);
}

function format2(value: number): string {
  return value.toFixed(2);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, Math.min(index, sorted.length - 1))]);
}

function truncateQuery(query: string): string {
  return query.length > 60 ? query.slice(0, 60) : query;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function queryMap(report: EvalReport): Map<string, QueryResult> {
  return new Map(report.per_query.map(result => [result.eval_id, result]));
}

function buildEvalMarkdown(generatedAt: string, baseline: EvalReport, reranked: EvalReport): string {
  const baselineP50 = percentile(baseline.per_query.map(result => result.duration_ms), 50);
  const baselineP95 = percentile(baseline.per_query.map(result => result.duration_ms), 95);
  const rerankedP50 = percentile(reranked.per_query.map(result => result.duration_ms), 50);
  const rerankedP95 = percentile(reranked.per_query.map(result => result.duration_ms), 95);

  const baselineById = queryMap(baseline);
  const rerankedById = queryMap(reranked);
  const ids = [...baselineById.keys()].sort((a, b) => a.localeCompare(b));

  const lines = [
    '# KOPENG Retrieval Evaluation',
    '',
    `> Generated: ${generatedAt}  `,
    `> Dataset: ${baseline.config.dataset_size} queries · k=5 · hybrid · all-MiniLM-L6-v2 + ms-marco-MiniLM-L-6-v2`,
    '',
    '## Aggregate',
    '',
    '| Metric | Baseline | Reranked |',
    '|---|---|---|',
    `| P@5 | ${format4(baseline.aggregate.mean_precision_at_k)} | ${format4(reranked.aggregate.mean_precision_at_k)} |`,
    `| R@5 | ${format4(baseline.aggregate.mean_recall_at_k)} | ${format4(reranked.aggregate.mean_recall_at_k)} |`,
    `| MRR | ${format4(baseline.aggregate.mean_mrr)} | ${format4(reranked.aggregate.mean_mrr)} |`,
    `| nDCG@5 | ${format4(baseline.aggregate.mean_ndcg_at_k)} | ${format4(reranked.aggregate.mean_ndcg_at_k)} |`,
    `| Median latency | ${baselineP50}ms | ${rerankedP50}ms |`,
    `| p95 latency | ${baselineP95}ms | ${rerankedP95}ms |`,
    '',
    '## Per-Query',
    '',
    '| ID | Query | Base P@5 | Rnk P@5 | Base MRR | Rnk MRR | Base nDCG | Rnk nDCG |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const id of ids) {
    const base = baselineById.get(id);
    const rnk = rerankedById.get(id);
    if (!base || !rnk) continue;

    lines.push(`| ${escapeMarkdownCell(id)} | ${escapeMarkdownCell(truncateQuery(base.query))} | ${format2(base.precision_at_k)} | ${format2(rnk.precision_at_k)} | ${format2(base.mrr)} | ${format2(rnk.mrr)} | ${format2(base.ndcg_at_k)} | ${format2(rnk.ndcg_at_k)} |`);
  }

  return `${lines.join('\n')}\n`;
}

function buildCsv(baseline: EvalReport, reranked: EvalReport): string {
  const baselineById = queryMap(baseline);
  const rerankedById = queryMap(reranked);
  const ids = [...baselineById.keys()].sort((a, b) => a.localeCompare(b));

  const lines = [
    'eval_id,query,base_precision,base_recall,base_mrr,base_ndcg,base_duration_ms,rnk_precision,rnk_recall,rnk_mrr,rnk_ndcg,rnk_duration_ms',
  ];

  for (const id of ids) {
    const base = baselineById.get(id);
    const rnk = rerankedById.get(id);
    if (!base || !rnk) continue;

    lines.push([
      escapeCsvCell(id),
      escapeCsvCell(base.query),
      format4(base.precision_at_k),
      format4(base.recall_at_k),
      format4(base.mrr),
      format4(base.ndcg_at_k),
      format4(base.duration_ms),
      format4(rnk.precision_at_k),
      format4(rnk.recall_at_k),
      format4(rnk.mrr),
      format4(rnk.ndcg_at_k),
      format4(rnk.duration_ms),
    ].join(','));
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const baseline = await runEvalPass({ mode: 'hybrid', rerank: false, k: 5, apiUrl: API_URL });
  const reranked = await runEvalPass({ mode: 'hybrid', rerank: true, k: 5, apiUrl: API_URL });
  const generatedAt = new Date().toISOString();

  const evalPath = path.join(projectRoot, 'EVAL.md');
  fs.writeFileSync(evalPath, buildEvalMarkdown(generatedAt, baseline, reranked));

  const resultsDir = path.join(projectRoot, 'data', 'eval_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const csvPath = path.join(resultsDir, 'latest.csv');
  fs.writeFileSync(csvPath, buildCsv(baseline, reranked));

  console.log(`Eval report saved: ${evalPath}`);
  console.log(`Eval CSV saved: ${csvPath}`);
}

main().catch((err: unknown) => {
  if (err instanceof DatasetNotFoundError) {
    console.error(err.message);
    console.error('Run: npx tsx scripts/seed-eval-dataset.ts');
    process.exit(1);
  }

  if (err instanceof ApiHealthError) {
    console.error(err.message);
    process.exit(1);
  }

  console.error('Eval report failed:', err);
  process.exit(1);
});
