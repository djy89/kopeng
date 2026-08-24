/**
 * T24 (F5) — weekly corpus-health snapshot.
 *
 * HTTP-client-only script (owns NO src/** code — mirrors the client discipline
 * of scripts/sync-claude-indexes.ts). GETs the two read-only ops endpoints
 * (/api/ops/corpus-health + /api/ops/confidence-distribution) from the running
 * KOPENG server and APPENDS one JSON line
 *   { ts, corpus_health, confidence_distribution }
 * to a JSONL log — the M3 time series behind "dreaming leaves the corpus
 * leaner". The corpus-health object carries the endpoint's `meta`
 * (sample_size / sampled) inline so a sampled undercount is legible in the
 * series.
 *
 * Usage:
 *   npm run snapshot:corpus-health
 *   npm run snapshot:corpus-health -- --url http://localhost:3200 --out ./scratch/corpus-health.jsonl
 *
 * Defaults:
 *   --url  $KOPENG_API_URL, else http://localhost:3200
 *   --out  ~/.kopeng/metrics/corpus-health.jsonl (parent dirs created)
 *
 * Fail-soft: server unreachable or non-200 → clear error on stderr, exit
 * non-zero, NO partial line written (both fetches complete and parse before
 * anything touches the log).
 *
 * Scheduled driver: scripts/ops/corpus-health-task.ps1 (weekly Task Scheduler
 * task — see scripts/ops/install-corpus-health-task.ps1 and
 * docs/ops/corpus-health-snapshot.md).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Pure helpers — exported so unit tests can import them with no network/FS
// side effects. main() runs only when the script is invoked directly.
// ---------------------------------------------------------------------------

/** API envelope shape ({ data, meta? }) as returned by the ops endpoints. */
export interface OpsEnvelope {
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface SnapshotArgs {
  url: string;
  outPath: string;
}

export const DEFAULT_URL = 'http://localhost:3200';

export function defaultOutPath(homedir: string = os.homedir()): string {
  return path.join(homedir, '.kopeng', 'metrics', 'corpus-health.jsonl');
}

/**
 * Parse CLI args. Pure: takes argv (already sliced past node+script) and an
 * env-provided base URL so tests need no process/env mutation.
 * Supports `--url <base>` and `--out <path>`; unknown flags throw (a typo'd
 * flag silently snapshotting to the wrong place would poison the series).
 */
export function parseArgs(argv: string[], envUrl?: string, homedir?: string): SnapshotArgs {
  let url = envUrl || DEFAULT_URL;
  let outPath = defaultOutPath(homedir);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') {
      const v = argv[++i];
      if (!v) throw new Error('--url requires a value');
      url = v;
    } else if (arg === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out requires a value');
      outPath = v;
    } else {
      throw new Error(`Unknown argument: ${arg} (supported: --url <base>, --out <path>)`);
    }
  }
  // Trailing slash would double up when composing endpoint paths.
  url = url.replace(/\/+$/, '');
  return { url, outPath };
}

/**
 * Compose the single JSONL line for one snapshot.
 * `corpus_health` = the endpoint's data with its meta (sample_size/sampled)
 * folded in under `meta`; `confidence_distribution` = the endpoint's data.
 * Returns the line WITHOUT a trailing newline (the writer owns framing).
 */
export function composeSnapshotLine(
  health: OpsEnvelope,
  dist: OpsEnvelope,
  ts: string,
  drift?: OpsEnvelope | null,
): string {
  // `scope_drift` carries the SUMMARY only, not the cluster list: this file is a
  // time series, and the number that matters over time is active_rows_adrift —
  // 0 on a reconciled corpus, so any rise is new drift rather than a backlog.
  // OPTIONAL by design: omitted when the drift fetch failed or the server predates
  // /api/ops/scope-drift, so adding it can never break the weekly snapshot.
  const driftSummary = (drift?.data as { summary?: unknown } | undefined)?.summary;
  return JSON.stringify({
    ts,
    corpus_health: { ...health.data, ...(health.meta !== undefined ? { meta: health.meta } : {}) },
    confidence_distribution: dist.data,
    ...(driftSummary !== undefined ? { scope_drift: driftSummary } : {}),
  });
}

// ---------------------------------------------------------------------------
// HTTP + IO (main path only)
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;

async function fetchOps(baseUrl: string, endpoint: string): Promise<OpsEnvelope> {
  const url = `${baseUrl}${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err: unknown) {
    // undici surfaces connection errors as "fetch failed" with the real reason
    // on .cause — unwrap it so "server unreachable" is legible on stderr.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new Error(`GET ${url} failed: ${reason} (is the KOPENG server running?)`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { data?: unknown }).data !== 'object' ||
    (body as { data?: unknown }).data === null
  ) {
    throw new Error(`GET ${url} returned an unexpected body (no data envelope)`);
  }
  return body as OpsEnvelope;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env.KOPENG_API_URL);

  // Fetch BOTH endpoints fully before touching the log — a failure here means
  // nothing is written (no partial/corrupt line, acceptance criterion).
  const [health, dist] = await Promise.all([
    fetchOps(args.url, '/api/ops/corpus-health'),
    fetchOps(args.url, '/api/ops/confidence-distribution'),
  ]);

  // Scope drift is BEST-EFFORT and deliberately not in the Promise.all above:
  // the two original endpoints are the snapshot's contract, and a 404 from a
  // server predating /api/ops/scope-drift (or any drift-side error) must not
  // cost the operator their weekly corpus-health line.
  const drift = await fetchOps(args.url, '/api/ops/scope-drift').catch(() => null);

  const ts = new Date().toISOString();
  const line = composeSnapshotLine(health, dist, ts, drift);

  const outPath = path.resolve(args.outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, line + '\n', 'utf8');

  console.log(`corpus-health snapshot appended to ${outPath}`);
  console.log(`  ts=${ts}`);
  const h = health.data as { active_memory_count?: number; mean_confidence?: number };
  console.log(`  active_memory_count=${h.active_memory_count} mean_confidence=${h.mean_confidence}`);
}

// Only execute when run directly (not when imported by tests or other modules).
// Compare the entry-point path to this file's name — works with tsx direct
// execution. Normalise separators and case for Windows-safe comparison.
function isDirectRun(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return entry.includes('corpus-health-snapshot');
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`corpus-health-snapshot failed: ${msg}`);
    console.error('No snapshot line was written.');
    process.exit(1);
  });
}
