/**
 * Latency bench for the recall hook thin client (C1.3 / T16).
 *
 * Measures the added wall-clock latency of the POST /api/surface call vs the
 * C0 two-call baseline (project recall + tool recall only).  Runs N sample
 * prompts through both code paths, reports p50 / p95.
 *
 * This is an informational measurement tool — not a suite gate.
 *
 * Usage:  npx tsx scripts/bench-recall-hook.ts [--n <count>] [--url <api-url>]
 * Env:    KOPENG_API_URL (default http://localhost:3200)
 * Note:   Requires a running KOPENG server.  Results are latency observations,
 *         not correctness assertions.
 */

const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const REQUEST_TIMEOUT_MS = 3000;

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): { n: number; url: string } {
  let n = 20;
  let url = API_URL;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--n') n = parseInt(argv[++i], 10) || 20;
    if (argv[i] === '--url') url = argv[++i] ?? url;
  }
  return { n: Math.max(1, n), url };
}

// ── Sample prompts (invented, shaped like typical development prompts) ─────

const SAMPLE_PROMPTS = [
  'help me write a handoff document for this sprint',
  'review the API routes for missing error handling',
  'I need to scaffold a new service and wire up its config',
  'implement the causal metric for surfacing acceptance',
  'write a unit test for the dream apply path',
  'debug the dreaming scheduler — it is not firing at the right time',
  'update the project docs to reflect the new surfacing endpoint',
  'run the eval harness and compare reranked vs baseline',
  'create a new MCP tool for listing pending dreams',
  'what is the architecture of the discovery pipeline',
  'help me draft release notes for the next version',
  'set up time tracking categories for the current sprint',
  'the build is failing with a TypeScript error in routes.ts',
  'how does the dreaming layer choose which memories to consolidate',
  'I want to add a new metric for measuring dream acceptance quality',
  'deploy the updated server to the staging host',
  'create a detailed plan for implementing the C2 learned surfacing phase',
  'write the SQL migration for adding the surfaced_items column',
  'the hook is returning empty on every prompt — investigate',
  'create a PR description for the C1 static surfacing sprint',
];

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchRecall(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<number> {
  try {
    const res = await fetch(`${url}/api/memories/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal as RequestInit['signal'],
    });
    if (!res.ok) return 0;
    return (await res.json())?.data?.length ?? 0;
  } catch {
    return 0;
  }
}

async function fetchSurface(
  url: string,
  prompt: string,
  projectScope: string,
  signal: AbortSignal,
): Promise<number> {
  try {
    const res = await fetch(`${url}/api/surface`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, project_scope: projectScope }),
      signal: signal as RequestInit['signal'],
    });
    if (!res.ok) return 0;
    const d = (await res.json())?.data ?? {};
    return (d.tools?.length ?? 0) + (d.skills?.length ?? 0) + (d.conventions?.length ?? 0);
  } catch {
    return 0;
  }
}

// ── Baseline: two recall calls (C0) ───────────────────────────────────────

async function runBaseline(url: string, prompt: string, scope: string): Promise<number> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  await Promise.all([
    fetchRecall(url, { query: prompt, scopes: [scope, 'global'], threshold: 0.40, limit: 3 }, signal),
    fetchRecall(url, { query: prompt, scope: 'client:claude-tool', threshold: 0.45, limit: 3 }, signal),
  ]);
  return performance.now() - t0;
}

// ── C1: three calls (recall × 2 + /api/surface) ───────────────────────────

async function runC1(url: string, prompt: string, scope: string): Promise<number> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  await Promise.all([
    fetchRecall(url, { query: prompt, scopes: [scope, 'global'], threshold: 0.40, limit: 3 }, signal),
    fetchRecall(url, { query: prompt, scope: 'client:claude-tool', threshold: 0.45, limit: 3 }, signal),
    fetchSurface(url, prompt, scope, signal),
  ]);
  return performance.now() - t0;
}

// ── Statistics ─────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function stats(samples: number[]): { p50: number; p95: number; mean: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { n, url } = parseArgs(process.argv.slice(2));
  const PROJECT_SCOPE = 'project:kopeng';

  console.log(`\n  KOPENG · recall-hook latency bench (C1.3/T16)`);
  console.log(`  api: ${url}   n=${n} prompts   timeout=${REQUEST_TIMEOUT_MS}ms\n`);

  // Warm-up (not counted)
  console.log('  Warming up...');
  try {
    await runBaseline(url, 'warm up the embedding model', PROJECT_SCOPE);
    await runC1(url, 'warm up the surface endpoint', PROJECT_SCOPE);
  } catch { /* warm-up failure is non-fatal */ }

  const baselineSamples: number[] = [];
  const c1Samples: number[] = [];
  const addedSamples: number[] = [];

  const prompts = Array.from({ length: n }, (_, i) => SAMPLE_PROMPTS[i % SAMPLE_PROMPTS.length]);

  process.stdout.write('  Running');
  for (const prompt of prompts) {
    try {
      const bMs = await runBaseline(url, prompt, PROJECT_SCOPE);
      const c1Ms = await runC1(url, prompt, PROJECT_SCOPE);
      baselineSamples.push(bMs);
      c1Samples.push(c1Ms);
      addedSamples.push(Math.max(0, c1Ms - bMs));
    } catch { /* skip failed sample */ }
    process.stdout.write('.');
  }
  console.log('\n');

  if (baselineSamples.length === 0) {
    console.error('  No samples collected — is the server running at', url, '?');
    process.exit(1);
  }

  const bStats = stats(baselineSamples);
  const c1Stats = stats(c1Samples);
  const addedStats = stats(addedSamples);

  const ms = (v: number) => `${v.toFixed(1)}ms`;
  const pass = (v: number, limit: number) => v <= limit ? '✓' : '✗';

  console.log('  Baseline (2 recall calls):');
  console.log(`    p50=${ms(bStats.p50)}  p95=${ms(bStats.p95)}  mean=${ms(bStats.mean)}  min=${ms(bStats.min)}  max=${ms(bStats.max)}`);
  console.log('');
  console.log('  C1 (2 recall + /api/surface, parallel):');
  console.log(`    p50=${ms(c1Stats.p50)}  p95=${ms(c1Stats.p95)}  mean=${ms(c1Stats.mean)}  min=${ms(c1Stats.min)}  max=${ms(c1Stats.max)}`);
  console.log('');
  console.log('  Added latency (C1 − baseline):');
  console.log(`    p50=${ms(addedStats.p50)}  p95=${ms(addedStats.p95)}  mean=${ms(addedStats.mean)}`);
  console.log('');
  console.log('  Gates:');
  console.log(`    p95 added < 250ms  ... ${pass(addedStats.p95, 250)} (${ms(addedStats.p95)})`);
  console.log(`    p95 C1 total < 3s  ... ${pass(c1Stats.p95, 3000)} (${ms(c1Stats.p95)})`);
  console.log(`    samples collected  ... ${baselineSamples.length}/${n}`);
  console.log('');
  console.log('  (Latency bench is informational — not a suite gate.)\n');
}

main().catch(err => {
  console.error('[bench-recall-hook] fatal:', err);
  process.exit(1);
});
