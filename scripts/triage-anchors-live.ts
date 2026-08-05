/**
 * Anchor triage — LIVE driver (F3 / T22b) — segmentation report + reviewed bulk
 * demote over the LIVE corpus via the audited REST API. Backend-agnostic: works
 * against Postgres OR SQLite (the sibling scripts/triage-anchors.ts only handles
 * a SQLite copy, so it can't touch a live Postgres deployment — this closes that
 * gap).
 *
 * The D1/D3 predicates + report are the SHARED core (scripts/lib/anchor-triage.ts),
 * so this driver and the SQLite one can never drift.
 *
 *   D1: legacy `client:claude-tool` catalog rows (conf > 0.55) → 0.55
 *   D3: aged `project`/`reference` anchors (conf >= 1.0)       → 0.9
 *       (`user`/`feedback` UNTOUCHED; `is_locked` deliberate anchors kept)
 *
 * SAFETY:
 *   - Default is dry-run (reads only). --apply is required to mutate.
 *   - --apply hits the LIVE server named by --url; the target is echoed loudly.
 *   - Every demote goes through PUT /api/memories/:id { confidence } which is
 *     SNAPSHOT-FIRST server-side (memory_revisions) → each change is reversible
 *     with POST /api/memories/:id/rollback, exactly like the dream apply path.
 *   - Reads page the corpus with fields=lite (no embeddings); writes are
 *     sequential with 429/5xx backoff so the API's rate limiter isn't tripped.
 *
 * Usage:
 *   npm run triage:anchors:live -- --url http://localhost:3200                 # dry-run report
 *   npm run triage:anchors:live -- --url http://localhost:3200 --aged-days 60  # tune D3 age
 *   npm run triage:anchors:live -- --url http://localhost:3200 --apply         # perform demotes (LIVE)
 *   npm run triage:anchors:live -- --url http://localhost:3200 --out report.json
 *   (--url defaults to $MEMORY_API_URL, else http://localhost:3200)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import {
  type AnchorRow,
  DEFAULT_AGED_DAYS,
  D1_TARGET,
  D3_TARGET,
  buildReport,
  printReport,
  demoteTarget,
} from './lib/anchor-triage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load this repo's .env so ADMIN_API_KEY is present when run from a scheduled task
// or a bare shell, where it is not otherwise in the environment. Non-overriding: an
// already-exported value wins. Without this the script silently 401s against a
// key-configured server (sweep-3 PB-2 made memory writes admin-gated).
dotenv.config({ path: path.join(projectRoot, '.env') });

const PAGE_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 4;

interface Args {
  url: string;
  apply: boolean;
  agedDays: number;
  outPath: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let url = process.env.MEMORY_API_URL || 'http://localhost:3200';
  let apply = false;
  let agedDays = DEFAULT_AGED_DAYS;
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) url = argv[++i];
    else if (a === '--apply') apply = true;
    else if (a === '--aged-days' && argv[i + 1]) agedDays = parseInt(argv[++i], 10) || DEFAULT_AGED_DAYS;
    else if (a === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (a === '--dry-run') apply = false;
  }
  return { url: url.replace(/\/$/, ''), apply, agedDays, outPath };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Project a REST memory row onto the shared AnchorRow shape. */
function project(m: Record<string, unknown>): AnchorRow {
  return {
    id: Number(m.id),
    scope: String(m.scope),
    type: String(m.type),
    source: (m.source as string | null) ?? null,
    confidence: Number(m.confidence),
    last_seen: (m.last_seen as string | null) ?? null,
    updated_at: String(m.updated_at),
    created_at: String(m.created_at),
    is_locked: Number(m.is_locked) === 1 ? 1 : 0,
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown; retryAfter: number | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const retryAfterHdr = res.headers.get('retry-after');
    const retryAfter = retryAfterHdr ? parseInt(retryAfterHdr, 10) * 1000 : null;
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: res.status, body, retryAfter };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllActive(baseUrl: string): Promise<AnchorRow[]> {
  const rows: AnchorRow[] = [];
  let cursor: number | undefined;
  for (;;) {
    const u = new URL('/api/memories', baseUrl);
    u.searchParams.set('fields', 'lite');
    u.searchParams.set('include_archived', 'false');
    u.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor !== undefined) u.searchParams.set('cursor', String(cursor));
    const { status, body } = await fetchJson(u.toString());
    if (status !== 200 || !body || typeof body !== 'object') {
      throw new Error(`GET /api/memories failed (${status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
    const env = body as { data?: unknown[]; meta?: { has_more?: boolean; cursor?: number } };
    const data = env.data ?? [];
    for (const m of data) rows.push(project(m as Record<string, unknown>));
    process.stdout.write(`\r  fetched ${rows.length} active memories...`);
    if (!env.meta?.has_more || data.length === 0 || env.meta.cursor === undefined) break;
    cursor = env.meta.cursor;
  }
  process.stdout.write('\n');
  return rows;
}

/** PUT one confidence change with backoff on 429/5xx/network. Returns on success, throws on give-up. */
async function putConfidence(baseUrl: string, id: number, confidence: number): Promise<void> {
  const url = new URL(`/api/memories/${id}`, baseUrl).toString();
  const init: RequestInit = {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      // Memory writes are admin-key gated when the server has ADMIN_API_KEY set.
      ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
    },
    body: JSON.stringify({ confidence }),
  };
  let attempt = 0;
  for (;;) {
    attempt++;
    let status = 0;
    let retryAfter: number | null = null;
    let body: unknown = null;
    try {
      const res = await fetchJson(url, init);
      status = res.status;
      retryAfter = res.retryAfter;
      body = res.body;
    } catch (err) {
      // network / abort → retryable
      if (attempt > MAX_RETRIES) throw new Error(`PUT ${id} network error after ${MAX_RETRIES} retries: ${String(err)}`);
      await sleep(retryAfter ?? Math.min(4000, 500 * 2 ** (attempt - 1)));
      continue;
    }
    if (status >= 200 && status < 300) return;
    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt > MAX_RETRIES) {
      throw new Error(`PUT ${id} failed (${status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
    await sleep(retryAfter ?? Math.min(4000, 500 * 2 ** (attempt - 1)));
  }
}

interface ApplyResult {
  d1_demoted: number;
  d3_demoted: number;
  failures: Array<{ id: number; error: string }>;
}

async function applyDemotes(baseUrl: string, rows: AnchorRow[], nowMs: number, agedDays: number): Promise<ApplyResult> {
  const targets: Array<{ id: number; target: number }> = [];
  for (const r of rows) {
    const target = demoteTarget(r, nowMs, agedDays);
    if (target !== null) targets.push({ id: r.id, target });
  }

  let d1 = 0;
  let d3 = 0;
  const failures: ApplyResult['failures'] = [];
  let done = 0;
  for (const { id, target } of targets) {
    try {
      await putConfidence(baseUrl, id, target);
      if (target === D1_TARGET) d1++;
      else if (target === D3_TARGET) d3++;
    } catch (err) {
      failures.push({ id, error: String(err) });
    }
    done++;
    if (done % 100 === 0 || done === targets.length) {
      process.stdout.write(`\r  applied ${done}/${targets.length} (D1=${d1} D3=${d3} failed=${failures.length})...`);
    }
  }
  process.stdout.write('\n');
  return { d1_demoted: d1, d3_demoted: d3, failures };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const nowMs = Date.now();

  console.log(`\nAnchor triage (LIVE) — target: ${args.url}`);
  if (args.apply) {
    console.log('  ⚠  --apply is ON: this will MUTATE the live corpus (snapshot-first, reversible via rollback).');
  }

  const rows = await fetchAllActive(args.url);
  const report = buildReport(rows, nowMs, args.agedDays, args.url);
  printReport(report);

  let applyResult: ApplyResult | null = null;
  if (args.apply) {
    applyResult = await applyDemotes(args.url, rows, nowMs, args.agedDays);
    console.log(`\nAPPLIED (each snapshot-first, reversible via POST /api/memories/:id/rollback):`);
    console.log(`  D1 demoted → 0.55: ${applyResult.d1_demoted}`);
    console.log(`  D3 demoted → 0.9:  ${applyResult.d3_demoted}`);
    console.log(`  failures:          ${applyResult.failures.length}`);
    if (applyResult.failures.length > 0) {
      console.log(`  first failures:    ${applyResult.failures.slice(0, 5).map((f) => `#${f.id}`).join(', ')}`);
    }
    console.log('');
  } else {
    console.log('Dry-run — no changes written. Re-run with --apply after reviewing the report.\n');
  }

  if (args.outPath) {
    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ ...report, applied: applyResult }, null, 2));
    console.log(`Report written to ${path.relative(projectRoot, outPath)}`);
  }

  // Non-zero exit if any applied write failed, so an operator/CI notices.
  if (applyResult && applyResult.failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
