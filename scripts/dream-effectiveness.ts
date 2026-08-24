/**
 * Dream-effectiveness harness — proves, IN-PROCESS and with ZERO live mutation,
 * that a dream pass leaves the corpus leaner/cleaner while retrieval holds.
 * Emits the JSON a launch video consumes.
 *
 * What it does (extends the replay.ts pattern to real/copy data + retrieval):
 *   1. Build a memory store. `--db <path>` opens a COPY you point it at; with no
 *      flag it generates a synthetic corpus in a temp DB (zero external state).
 *      The live memory.db is NEVER opened or written — always copy first.
 *   2. Build an in-memory embedding index over the corpus (pure cosine, no model).
 *   3. BASELINE: retrieval metrics (P@k / R@k / MRR / NDCG@k over the gold query
 *      set — shared math with `npm run eval`) + a corpus-health snapshot
 *      (active count, dup-pairs cosine ≥ 0.95, contradiction-flagged, decayed,
 *      mean confidence — same definitions as GET /api/ops/corpus-health).
 *   4. DREAM: run a real `runDreamPass` with auto-apply enabled IN THIS SANDBOX
 *      (auto_accept_exact_dup + auto_accept_decay forced ON on the copy only) so
 *      exact-dup collapses and decay archives actually apply; capture the change
 *      list from the audit log.
 *   5. AFTER: re-measure retrieval + corpus-health against the same (now-mutated)
 *      index — archived ids are removed from the index by the apply path.
 *   6. EMIT { before, after, deltas, changesApplied, goldQueries, ... } to stdout
 *      and to --out (default scratch/dream-effectiveness.json). `--quiet`
 *      suppresses the stdout copy (CI logs); the file + gates always emit.
 *   7. GATE (Phase 5): re-read the emitted file and assert the headline per
 *      lane — non-zero exit on any failure. See the gate block for the rules.
 *
 * HONESTY / LIMITATIONS (also embedded in the report):
 *   - This measures the SHAPE of the claim, not a production number. The default
 *     corpus is SYNTHETIC with hand-crafted unit-vector embeddings (zero-model),
 *     designed to contain exact-dups + decayed rows for dreaming to clean.
 *   - "Retrieval held" means the gold-query P@k/NDCG did not drop after the
 *     redundant copies were archived — it is a sanity floor, not a relevance
 *     proof. Acceptance/cleanup ≠ relevance; true relevance needs human labels.
 *   - In `--db` mode there is no gold query set unless you supply one, so
 *     retrieval metrics are skipped and only corpus-health before/after is shown.
 *   - The sandbox FORCES auto-accept flags ON to exercise the apply path. The
 *     live system ships them OFF (GATE 1); nothing here touches live config.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/database/migrations.js';
import { MemoryQueries } from '../src/database/queries.js';
import { DreamQueries } from '../src/database/dream-queries.js';
import { EmbeddingIndex } from '../src/embeddings/index.js';
import { embeddingToBuffer, bufferToEmbedding } from '../src/embeddings/embedder.js';
import {
  DuplicateCandidateSelector, DeterministicDiffGenerator, cosineSimilarity,
  COSINE_DUPLICATE_THRESHOLD,
} from '../src/dreaming/pipeline.js';
import { DbWindowMemorySource, runDreamPass } from '../src/dreaming/dream-engine.js';
import { NoOpReasoner } from '../src/dreaming/reasoner/noop-reasoner.js';
import { ConsolidationLockManager } from '../src/dreaming/lock.js';
import { isAnchored, isDecayedAtRisk } from '../src/dreaming/scoring.js';
import { scoreQuery, type RetrievalScores } from './lib/retrieval-metrics.js';
import {
  EFFECTIVENESS_CORPUS, EFFECTIVENESS_GOLD, EFFECTIVENESS_CLOCK,
  type GoldQuery,
} from './lib/effectiveness-corpus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

interface Args {
  dbPath: string | null;
  k: number;
  outPath: string;
  /** Suppress the full-report stdout dump (the file + gates still emit) — for CI logs. */
  quiet: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dbPath: string | null = null;
  let k = 5;
  let outPath = path.join(projectRoot, 'scratch', 'dream-effectiveness.json');
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) dbPath = argv[++i];
    else if (argv[i] === '--k' && argv[i + 1]) k = parseInt(argv[++i], 10) || 5;
    else if (argv[i] === '--out' && argv[i + 1]) outPath = argv[++i];
    else if (argv[i] === '--quiet') quiet = true;
  }
  return { dbPath, k, outPath, quiet };
}

// ── Corpus-health snapshot (same definitions as GET /api/ops/corpus-health) ──

interface CorpusHealth {
  active_memory_count: number;
  mean_confidence: number | null;
  contradiction_flagged_count: number;
  duplicate_pair_count: number;
  decayed_at_risk_count: number;
  sample_size: number;
  sampled: boolean;
}

async function corpusHealth(queries: MemoryQueries, now: Date, sampleCap: number): Promise<CorpusHealth> {
  const stats = await queries.getCorpusHealthStats();
  const sample = await queries.getCorpusHealthSample(sampleCap);

  let decayedAtRisk = 0;
  const vectors: Float32Array[] = [];
  for (const m of sample) {
    if (!isAnchored(m) && isDecayedAtRisk(m, now)) decayedAtRisk++;
    if (m.embedding) vectors.push(bufferToEmbedding(m.embedding));
  }

  let duplicatePairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      if (cosineSimilarity(vectors[i], vectors[j]) >= COSINE_DUPLICATE_THRESHOLD) duplicatePairs++;
    }
  }

  return {
    active_memory_count: stats.active_count,
    mean_confidence: stats.mean_confidence,
    contradiction_flagged_count: stats.contradiction_flagged_count,
    duplicate_pair_count: duplicatePairs,
    decayed_at_risk_count: decayedAtRisk,
    sample_size: sample.length,
    sampled: sample.length < stats.active_count,
  };
}

// ── Retrieval metrics over the gold query set ──

interface QueryReport extends RetrievalScores {
  id: string;
  retrieved_ids: number[];
  relevant_ids: number[];
  note: string;
}

interface RetrievalSnapshot {
  k: number;
  query_count: number;
  mean_precision_at_k: number;
  mean_recall_at_k: number;
  mean_mrr: number;
  mean_ndcg_at_k: number;
  per_query: QueryReport[];
}

async function retrieval(
  index: EmbeddingIndex,
  gold: GoldQuery[],
  keyToId: Map<string, number>,
  k: number,
): Promise<RetrievalSnapshot> {
  const per: QueryReport[] = [];
  for (const g of gold) {
    const relevantIds = g.relevant_keys
      .map(key => keyToId.get(key))
      .filter((id): id is number => id !== undefined);
    const hits = await index.search(g.embedding, undefined, k);
    const retrievedIds = hits.map(h => h.id);
    const scores = scoreQuery(retrievedIds, relevantIds, k);
    per.push({ id: g.id, retrieved_ids: retrievedIds, relevant_ids: relevantIds, note: g.note, ...scores });
  }
  const n = per.length || 1;
  return {
    k,
    query_count: per.length,
    mean_precision_at_k: per.reduce((s, r) => s + r.precision_at_k, 0) / n,
    mean_recall_at_k: per.reduce((s, r) => s + r.recall_at_k, 0) / n,
    mean_mrr: per.reduce((s, r) => s + r.mrr, 0) / n,
    mean_ndcg_at_k: per.reduce((s, r) => s + r.ndcg_at_k, 0) / n,
    per_query: per,
  };
}

// ── Synthetic corpus build ──

/** Seed the synthetic corpus into the DB and return key→id + an index. */
async function seedSynthetic(queries: MemoryQueries): Promise<Map<string, number>> {
  const keyToId = new Map<string, number>();
  for (const m of EFFECTIVENESS_CORPUS) {
    const { id } = await queries.store({
      content: m.content,
      type: m.type ?? 'reference',
      scope: m.scope,
      source: 'dream-effectiveness',
      source_path: null,
      metadata: '{}',
      embedding: embeddingToBuffer(m.embedding),
      embedding_model: 'synthetic',
      created_by: null,
      tags: [],
      confidence: m.confidence,
    });
    keyToId.set(m.key, id);
    // The decay clock anchors on last_seen ?? updated_at; store() can't set those,
    // so push decayed rows' clocks back via the temporal/usage columns directly.
    if (m.last_seen || m.updated_at) {
      // last_seen lives on the usage columns; set it without resetting via raw update.
      // (reinforceOnAccess would push it forward; we need it in the past.)
      backdate(queries, id, m.last_seen ?? m.updated_at!, m.updated_at ?? m.last_seen!);
    }
  }
  return keyToId;
}

/** Backdate a row's decay clock for the synthetic decay fixtures (sandbox copy only). */
function backdate(queries: MemoryQueries, id: number, lastSeen: string, updatedAt: string): void {
  // queries exposes the better-sqlite3 db via its constructor capture; reach the
  // raw handle through a narrow cast — this is sandbox seeding, not a store API.
  // created_at is backdated too (to the earlier of the two stamps): store()
  // stamps it with seed wall-clock, which sits AFTER the pinned harness clock —
  // any age-based rule (crystallization's age>=7d, supersession ordering) would
  // otherwise see a row "created in the future".
  const db = (queries as unknown as { db: Database.Database }).db;
  const createdAt = lastSeen < updatedAt ? lastSeen : updatedAt;
  db.prepare('UPDATE memories SET last_seen = ?, updated_at = ?, created_at = ? WHERE id = ?')
    .run(lastSeen, updatedAt, createdAt, id);
}

// ── Change capture from the audit log ──

interface ChangeApplied {
  change_class: string;
  action: string | null;
  memory_id: number | null;
  applied_automatically: boolean;
}

async function changesFromDream(dreamStore: DreamQueries, dreamId: number): Promise<ChangeApplied[]> {
  const audit = await dreamStore.listAuditForDream(dreamId);
  return audit.map(a => ({
    change_class: a.change_class,
    action: a.action,
    memory_id: a.memory_id,
    applied_automatically: a.applied_automatically,
  }));
}

// ── Deltas ──

function pct(before: number, after: number): number | null {
  if (before === 0) return after === 0 ? 0 : null; // null = undefined ratio (0 → n)
  return (after - before) / before;
}

function round(n: number | null, dp = 4): number | null {
  return n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const synthetic = args.dbPath === null;
  const now = new Date(synthetic ? EFFECTIVENESS_CLOCK : Date.now());
  const nowMs = (): number => now.getTime();

  // Resolve the working DB. Synthetic → fresh temp DB. --db → guard against the
  // live files, then open the COPY the operator pointed us at.
  let workingDbPath: string;
  let cleanupTemp = false;
  if (synthetic) {
    workingDbPath = path.join(os.tmpdir(), `kopeng-effectiveness-${process.pid}-${Date.now()}.db`);
    cleanupTemp = true;
  } else {
    workingDbPath = path.resolve(args.dbPath!);
    const base = path.basename(workingDbPath);
    if (base === 'memory.db' || base === 'observations.db') {
      console.error(
        `Refusing to open '${base}' directly — point --db at a COPY (e.g. cp memory.db memory.copy.db). ` +
        `The harness mutates the DB it opens.`,
      );
      process.exit(2);
    }
    if (!fs.existsSync(workingDbPath)) {
      console.error(`--db not found: ${workingDbPath}`);
      process.exit(2);
    }
  }

  const db = new Database(workingDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db); // idempotent: ensures dreaming tables exist on an old copy

  const queries = new MemoryQueries(db);
  const dreamStore = new DreamQueries(db);

  // Sandbox-only: force auto-accept ON so the apply path actually runs here.
  // (The live system ships these OFF — GATE 1. This config row lives only in the
  //  temp/copy DB.)
  await dreamStore.updateConfig('default', {
    auto_accept_exact_dup: true,
    auto_accept_decay: true,
  });

  let keyToId: Map<string, number> | null = null;
  if (synthetic) keyToId = await seedSynthetic(queries);

  // Build the in-process embedding index over the corpus.
  const index = new EmbeddingIndex();
  await index.loadFromDatabase(await queries.loadAllEmbeddings());

  const sampleCap = Math.max(2000, (await queries.getCount()) + 1);
  const gold = synthetic ? EFFECTIVENESS_GOLD : [];

  // ── BASELINE ──
  const beforeHealth = await corpusHealth(queries, now, sampleCap);
  const beforeRetrieval = keyToId ? await retrieval(index, gold, keyToId, args.k) : null;

  // ── DREAM (auto-apply on in the sandbox) ──
  const run = await runDreamPass({
    dreamStore,
    source: new DbWindowMemorySource(queries, { limit: sampleCap }),
    selector: new DuplicateCandidateSelector({ now: () => now }),
    reasoner: new NoOpReasoner(),
    diffGen: new DeterministicDiffGenerator(),
    lock: new ConsolidationLockManager({ store: dreamStore, holder: 'dream-effectiveness', now: nowMs }),
    configStore: dreamStore,
    tz: 'UTC',
    now: nowMs,
    apply: { memoryStore: queries, vectorIndex: index },
    // Unique per invocation: without this, a SECOND run against the same --db
    // copy collapses on the day's window (a benign non-run) and the completed
    // gate misreads it as a dreaming defect.
  }, { trigger: 'manual', reason: 'dream-effectiveness harness', windowKey: `effectiveness-${Date.now()}` });

  const changesApplied = run.dream_id !== null ? await changesFromDream(dreamStore, run.dream_id) : [];

  // ── AFTER ──
  const afterHealth = await corpusHealth(queries, now, sampleCap);
  const afterRetrieval = keyToId ? await retrieval(index, gold, keyToId, args.k) : null;

  // ── Deltas + headline ──
  const deltas = {
    active_memory_count: afterHealth.active_memory_count - beforeHealth.active_memory_count,
    duplicate_pair_count: afterHealth.duplicate_pair_count - beforeHealth.duplicate_pair_count,
    contradiction_flagged_count:
      afterHealth.contradiction_flagged_count - beforeHealth.contradiction_flagged_count,
    decayed_at_risk_count: afterHealth.decayed_at_risk_count - beforeHealth.decayed_at_risk_count,
    mean_confidence_pct: round(pct(beforeHealth.mean_confidence ?? 0, afterHealth.mean_confidence ?? 0)),
    retrieval: beforeRetrieval && afterRetrieval ? {
      mean_precision_at_k: round(afterRetrieval.mean_precision_at_k - beforeRetrieval.mean_precision_at_k),
      mean_recall_at_k: round(afterRetrieval.mean_recall_at_k - beforeRetrieval.mean_recall_at_k),
      mean_mrr: round(afterRetrieval.mean_mrr - beforeRetrieval.mean_mrr),
      mean_ndcg_at_k: round(afterRetrieval.mean_ndcg_at_k - beforeRetrieval.mean_ndcg_at_k),
    } : null,
  };

  // "Held" tracks RANK QUALITY (NDCG + MRR): did the canonical answer to each
  // gold query stay at the top after its redundant copies were archived? Precision
  // is reported but not gated on — with fact-level (single canonical) relevance it
  // is structurally capped at 1/k and is the wrong knob for a dedup claim.
  const EPS = 1e-9;
  const retrievalHeld = !beforeRetrieval || !afterRetrieval
    ? null
    : afterRetrieval.mean_ndcg_at_k >= beforeRetrieval.mean_ndcg_at_k - EPS
      && afterRetrieval.mean_mrr >= beforeRetrieval.mean_mrr - EPS;
  const corpusShrank = afterHealth.active_memory_count < beforeHealth.active_memory_count;
  const dupsDropped = afterHealth.duplicate_pair_count < beforeHealth.duplicate_pair_count;

  const report = {
    schema: 'kopeng.dream-effectiveness/1',
    generated_at: new Date().toISOString(),
    mode: synthetic ? 'synthetic' : 'copy-db',
    db: synthetic ? '(synthetic temp corpus)' : workingDbPath,
    clock: now.toISOString(),
    headline: {
      claim: 'Dreaming shrank the corpus and dropped duplicate pairs while retrieval held.',
      retrieval_held: retrievalHeld,
      corpus_shrank: corpusShrank,
      duplicate_pairs_dropped: dupsDropped,
      memories_archived: changesApplied.filter(c => c.action === 'archive').length,
    },
    dream_run: {
      status: run.status,
      dream_id: run.dream_id,
      window_key: run.window_key,
      memories_examined: run.memories_examined,
      changes_proposed: run.changes_proposed,
      duration_ms: run.duration_ms,
    },
    before: { corpus_health: beforeHealth, retrieval: beforeRetrieval },
    after: { corpus_health: afterHealth, retrieval: afterRetrieval },
    deltas,
    changesApplied,
    goldQueries: gold.map(g => ({ id: g.id, relevant_keys: g.relevant_keys, note: g.note })),
    limitations: [
      synthetic
        ? 'Synthetic corpus with hand-crafted unit-vector embeddings (zero-model) — proves the SHAPE of the claim, not a production number.'
        : 'Copy-DB mode: no gold query set supplied, so retrieval metrics are skipped — only corpus-health before/after is shown.',
      'Retrieval "held" = gold-query P@k/NDCG did not drop after redundant copies were archived. It is a sanity floor, not a relevance proof; acceptance/cleanup != relevance, which needs human labels.',
      'The sandbox FORCES auto_accept_exact_dup + auto_accept_decay ON to exercise the apply path. Live KOPENG ships them OFF (GATE 1); no live config is touched.',
      'Corpus-health duplicate-pair and decayed counts are computed over a bounded sample (same as GET /api/ops/corpus-health); on a large copy they undercount the full corpus.',
    ],
  };

  // Emit to file (+ stdout unless --quiet).
  const json = JSON.stringify(report, null, 2);
  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, json);
  if (!args.quiet) process.stdout.write(json + '\n');
  console.error(`\nReport written to ${args.outPath}`);

  // Gates read the file just written — the artifact consumers actually see —
  // so a serialization/emit bug sits INSIDE the gated surface, not beside it.
  const emitted = JSON.parse(fs.readFileSync(args.outPath, 'utf8')) as typeof report;

  // ── Gates (Phase 5) ──
  // The headline booleans used to be report-only: computing `retrieval_held` and
  // never asserting it meant only a crash could exit non-zero — a harness that
  // cannot fail. Synthetic mode asserts the full claim per lane (the corpus is
  // BUILT to contain exact-dups AND decayed rows, so a quiet lane is a defect —
  // the exact-dup lane alone must not be able to satisfy the shrink/archive
  // gates). Copy-db mode asserts only that the pass itself completed — an
  // arbitrary copy may legitimately be clean, and there is no gold set to hold
  // retrieval to.
  const gates: Array<[string, boolean]> = synthetic
    ? [
        ['dream pass completed', emitted.dream_run.status === 'completed'],
        ['corpus shrank (active count dropped)', emitted.headline.corpus_shrank === true],
        ['duplicate pairs dropped', emitted.headline.duplicate_pairs_dropped === true],
        ['retrieval held (NDCG + MRR did not drop)', emitted.headline.retrieval_held === true],
        ['at least one archive applied via the audit log', emitted.headline.memories_archived > 0],
        ['decay lane live: decayed-at-risk count dropped',
          emitted.after.corpus_health.decayed_at_risk_count < emitted.before.corpus_health.decayed_at_risk_count],
        ['decay lane live: at least one decay-class archive applied',
          emitted.changesApplied.some(c => c.change_class === 'decay' && c.action === 'archive')],
      ]
    : [
        ['dream pass completed', emitted.dream_run.status === 'completed'],
      ];

  console.error('\n— Gates —');
  let failedGates = 0;
  for (const [name, ok] of gates) {
    if (!ok) failedGates++;
    console.error(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }

  // Flush WAL and close before deleting the temp copy.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  if (cleanupTemp) {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.rmSync(workingDbPath + ext, { force: true }); } catch { /* best-effort */ }
    }
  }

  if (failedGates > 0) {
    console.error(`\n${failedGates} gate(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.error('\nAll gates passed.');
  }
}

main().catch((err: unknown) => {
  console.error('dream-effectiveness failed:', err);
  process.exit(1);
});
