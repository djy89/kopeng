/**
 * Anchor triage (F3 / T22) — SQLite offline driver: segmentation report +
 * reviewed bulk demote over a COPY of the corpus.
 *
 * The D1/D3 predicates + report live in scripts/lib/anchor-triage.ts (shared
 * with the live REST driver, scripts/triage-anchors-live.ts, so report and
 * apply can never drift). This file owns only the SQLite-copy plumbing.
 *
 * WHY: before T23, `store_memory`'s default confidence was 1.0, the Hard Anchor
 * (confidence >= 1.0 short-circuits retrieval-time decay). That left a mass of
 * legacy rows permanently anchored that were never meant to be. This tool
 * (a) reports the segmentation, then (b) — only with --apply — demotes:
 *
 *   D1: legacy `client:claude-tool` catalog rows      → confidence 0.55
 *   D3: aged `project`/`reference` anchors (conf >= 1) → confidence 0.9
 *       (`user`/`feedback` are UNTOUCHED; `is_locked` deliberate anchors kept)
 *
 * SAFETY (mirrors dream:effectiveness):
 *   - Always operate on a COPY. `--db <path>` is REQUIRED and the live files
 *     (memory.db / observations.db) are refused BY NAME in every mode, dry-run
 *     included (opening a live SQLite file touches its WAL). Copy first:
 *       cp data/memory.db memory.copy.db
 *   - Default is dry-run (writes nothing). --apply is required to mutate.
 *   - Every demote is snapshot-first into memory_revisions (the append-only
 *     audit record) via DreamQueries.snapshotRevision — reversible with
 *     POST /api/memories/:id/rollback, exactly like the dream apply path.
 *
 * NOTE: for a LIVE Postgres corpus this SQLite driver does not apply — use
 * scripts/triage-anchors-live.ts (drives the audited REST API instead).
 *
 * Usage:
 *   npm run triage:anchors -- --db memory.copy.db                 # dry-run report
 *   npm run triage:anchors -- --db memory.copy.db --aged-days 60  # tune D3 age
 *   npm run triage:anchors -- --db memory.copy.db --apply         # perform demotes
 *   npm run triage:anchors -- --db memory.copy.db --out report.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/database/migrations.js';
import { MemoryQueries } from '../src/database/queries.js';
import { DreamQueries } from '../src/database/dream-queries.js';
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

interface Args {
  dbPath: string | null;
  apply: boolean;
  agedDays: number;
  outPath: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dbPath: string | null = null;
  let apply = false;
  let agedDays = DEFAULT_AGED_DAYS;
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' && argv[i + 1]) dbPath = argv[++i];
    else if (a === '--apply') apply = true;
    else if (a === '--aged-days' && argv[i + 1]) agedDays = parseInt(argv[++i], 10) || DEFAULT_AGED_DAYS;
    else if (a === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (a === '--dry-run') apply = false;
  }
  return { dbPath, apply, agedDays, outPath };
}

interface ApplyResult {
  d1_demoted: number;
  d3_demoted: number;
  revisions_written: number;
}

/**
 * Snapshot-first demote of every D1/D3 candidate (reversible via rollback).
 * Sequential await per row: snapshot pre-change state (its own transaction) →
 * updateConfidence. NOT wrapped in an outer better-sqlite3 transaction — that
 * would commit before the awaited updateConfidence microtasks ran. Every
 * demoted row is snapshotted first, so even a mid-batch failure leaves only
 * fully-reversible changes on the copy.
 */
async function applyDemotes(
  queries: MemoryQueries,
  dreamStore: DreamQueries,
  rows: AnchorRow[],
  nowMs: number,
  agedDays: number,
): Promise<ApplyResult> {
  let d1 = 0;
  let d3 = 0;
  let revisions = 0;

  for (const r of rows) {
    const target = demoteTarget(r, nowMs, agedDays);
    if (target === null) continue;
    if (target === D1_TARGET) d1++;
    else if (target === D3_TARGET) d3++;
    await dreamStore.snapshotRevision(r.id, null);
    revisions++;
    await queries.updateConfidence(r.id, target);
  }

  return { d1_demoted: d1, d3_demoted: d3, revisions_written: revisions };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.dbPath) {
    console.error(
      'Refusing to run without --db. Point --db at a COPY of the corpus:\n' +
        '  cp data/memory.db memory.copy.db\n' +
        '  npm run triage:anchors -- --db memory.copy.db\n' +
        '(For a live Postgres corpus use: npm run triage:anchors:live -- --url http://localhost:3200)',
    );
    process.exit(2);
  }

  const workingDbPath = path.resolve(args.dbPath);
  const base = path.basename(workingDbPath);
  if (base === 'memory.db' || base === 'observations.db') {
    console.error(
      `Refusing to open '${base}' directly — point --db at a COPY (e.g. cp data/memory.db memory.copy.db). ` +
        `Triage opens the DB read-write and --apply mutates it.`,
    );
    process.exit(2);
  }
  if (!fs.existsSync(workingDbPath)) {
    console.error(`--db not found: ${workingDbPath}`);
    process.exit(2);
  }

  const db = new Database(workingDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // idempotent: ensures memory_revisions exists on an old copy

  const queries = new MemoryQueries(db);
  const dreamStore = new DreamQueries(db);
  const nowMs = Date.now();

  const rows = db
    .prepare(
      `SELECT id, scope, type, source, confidence, last_seen, updated_at, created_at, is_locked
       FROM memories WHERE is_archived = 0`,
    )
    .all() as AnchorRow[];

  const report = buildReport(rows, nowMs, args.agedDays, workingDbPath);
  printReport(report);

  let applyResult: ApplyResult | null = null;
  if (args.apply) {
    applyResult = await applyDemotes(queries, dreamStore, rows, nowMs, args.agedDays);
    console.log(`APPLIED (snapshot-first, reversible via POST /api/memories/:id/rollback):`);
    console.log(`  D1 demoted → 0.55: ${applyResult.d1_demoted}`);
    console.log(`  D3 demoted → 0.9:  ${applyResult.d3_demoted}`);
    console.log(`  revisions written: ${applyResult.revisions_written}`);
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

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
