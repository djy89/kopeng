/**
 * Retrieval evaluation harness.
 *
 * Usage:
 *   npx tsx scripts/run-eval.ts [--mode hybrid|semantic|keyword] [--rerank true|false] [--k 5]
 *
 * Reads data/eval_dataset.json, runs each query against the live REST API,
 * computes retrieval metrics, and saves results to data/eval_results/[timestamp].json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ApiHealthError,
  DatasetNotFoundError,
  runEvalPass,
} from './lib/eval-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';

function parseArgs(): { mode: string; rerank: boolean; k: number } {
  const args = process.argv.slice(2);
  let mode = 'hybrid';
  let rerank = true;
  let k = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (args[i] === '--rerank' && args[i + 1]) {
      rerank = args[++i] === 'true';
    } else if (args[i] === '--k' && args[i + 1]) {
      k = parseInt(args[++i], 10);
    }
  }

  return { mode, rerank, k };
}

async function main() {
  const { mode, rerank, k } = parseArgs();
  const report = await runEvalPass({ mode, rerank, k, apiUrl: API_URL });

  const resultsDir = path.join(projectRoot, 'data', 'eval_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outputPath = path.join(resultsDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Results saved: ${outputPath}`);
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

  console.error('Eval failed:', err);
  process.exit(1);
});
