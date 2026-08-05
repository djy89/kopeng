/**
 * Dirty-corpus drill (T28) — scores the FULL dreaming stack against planted
 * ground truth, with the real embedder and the real local reasoner in the loop.
 *
 * Why this exists: every prior proof point avoids the real pipeline under real
 * load. `dream:replay` is zero-LLM over hand-crafted vectors; `eval:reasoner` /
 * `eval:adversarial` are pair-level prompt evals; the live corpus is genuinely
 * clean, so live passes prove nothing about behavior under mess. The drill
 * seeds a known-dirty corpus (scripts/lib/drill-corpus.ts) into a scratch
 * SQLite DB, runs one real whole-corpus `runDreamPass` (embedder + qwen3:8b +
 * apply/audit machinery all live), and scores the output:
 *
 *   - HARD GATES (exit non-zero): reasoner-driven entries never auto-apply
 *     (flags deliberately armed in the sandbox), Hard Anchors untouched,
 *     injection pairs land as contested with nothing merged, R13 referent pairs
 *     never deterministically collapse, supersede direction is timestamp-true,
 *     every auto-apply is audited + revisioned, accept/rollback round-trips.
 *   - SOFT METRICS (reported, baseline on first run): per-class detection,
 *     reasoner confusion matrix + per-relation precision/recall, latencies.
 *
 * ZERO live mutation: refuses memory.db/observations.db by name (same guard as
 * dream:effectiveness), runs in a temp DB, touches no live operator_config.
 * The only live dependency is the local Ollama endpoint (read-only inference);
 * `--no-llm` swaps in the NoOpReasoner for a CI-safe structural smoke run
 * (Phase-1 fallbacks become the expected outcomes).
 *
 * Usage:
 *   npm run dream:drill                     # live reasoner (preflights Ollama)
 *   npm run dream:drill -- --no-llm         # structural smoke, no model calls
 *   npm run dream:drill -- --model qwen3:8b --url http://localhost:11434
 *   npm run dream:drill -- --keep-db        # keep the scratch DB for inspection
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
import {
  initEmbedder, embed, embedWithModel, embeddingToBuffer, bufferToEmbedding,
} from '../src/embeddings/embedder.js';
import {
  DuplicateCandidateSelector, DeterministicDiffGenerator, cosineSimilarity,
  COSINE_DUPLICATE_THRESHOLD, NEAR_DUP_BAND_MIN,
} from '../src/dreaming/pipeline.js';
import { WholeCorpusMemorySource, runDreamPass } from '../src/dreaming/dream-engine.js';
import { NoOpReasoner } from '../src/dreaming/reasoner/noop-reasoner.js';
import { LocalOllamaReasoner, resolveLocalReasonerSettings } from '../src/dreaming/reasoner/local-reasoner.js';
import type {
  ConsolidationReasoner, CandidateMemory, ReasonerContext, PairVerdict, ConditionExtraction, ClusterSynthesis,
} from '../src/dreaming/reasoner/reasoner.js';
import { ConsolidationLockManager } from '../src/dreaming/lock.js';
import { resolveDream, rollbackMemory, type ApplyDeps } from '../src/dreaming/apply.js';
import { CONTRADICTION_FLAG_TAG, CONTRADICTION_FLAG_KEY } from '../src/dreaming/contradiction.js';
import type { DreamDiffEntry } from '../src/types/types.js';
import { DRILL_MEMORIES, DRILL_CASES } from './lib/drill-corpus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ── Args ──

interface Args {
  noLlm: boolean;
  url: string;
  model: string;
  timeoutMs: number;
  outPath: string;
  keepDb: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    noLlm: false,
    url: process.env.DREAM_REASONER_URL ?? 'http://localhost:11434',
    model: process.env.DREAM_REASONER_MODEL ?? 'qwen3:8b',
    timeoutMs: 30_000,
    outPath: path.join(projectRoot, 'scratch', 'dream-drill-report.json'),
    keepDb: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-llm') args.noLlm = true;
    else if (argv[i] === '--keep-db') args.keepDb = true;
    else if (argv[i] === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === '--timeout' && argv[i + 1]) args.timeoutMs = parseInt(argv[++i], 10) || 30_000;
    else if (argv[i] === '--out' && argv[i + 1]) args.outPath = argv[++i];
  }
  return args;
}

// ── Counting reasoner wrapper (call log for scoring + latency stats) ──

interface ReasonerCall {
  kind: 'classify' | 'extract';
  a_id: number;
  b_id: number;
  ms: number;
  relation?: string;
  confidence?: number;
}

class CountingReasoner implements ConsolidationReasoner {
  readonly calls: ReasonerCall[] = [];
  constructor(private readonly inner: ConsolidationReasoner) {}

  get name(): string { return this.inner.name; }

  async classifyPair(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<PairVerdict> {
    const t = Date.now();
    const v = await this.inner.classifyPair(a, b, ctx);
    this.calls.push({ kind: 'classify', a_id: a.id, b_id: b.id, ms: Date.now() - t, relation: v.relation, confidence: v.confidence });
    return v;
  }

  async extractCondition(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<ConditionExtraction | null> {
    const t = Date.now();
    const v = await this.inner.extractCondition(a, b, ctx);
    this.calls.push({ kind: 'extract', a_id: a.id, b_id: b.id, ms: Date.now() - t });
    return v;
  }

  async synthesizeCluster(members: CandidateMemory[], ctx: ReasonerContext): Promise<ClusterSynthesis | null> {
    return this.inner.synthesizeCluster(members, ctx);
  }
}

// ── Ollama preflight ──

async function preflightOllama(url: string, model: string): Promise<void> {
  let tags: { models?: { name?: string }[] };
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = await res.json() as typeof tags;
  } catch (err) {
    console.error(`Ollama preflight failed at ${url} (${err instanceof Error ? err.message : err}).`);
    console.error('Start the provider (the "KOPENG Ollama Serve" task) or run with --no-llm for a structural smoke.');
    process.exit(2);
  }
  const names = (tags.models ?? []).map(m => m.name ?? '');
  if (!names.some(n => n === model || n.startsWith(`${model}:`))) {
    console.error(`Model '${model}' not found at ${url}. Available: ${names.join(', ') || '(none)'}.`);
    console.error(`Pull it (ollama pull ${model}) or pass --model.`);
    process.exit(2);
  }
}

// ── Scoring types ──

type CaseStatus = 'pass' | 'soft_miss' | 'fail';

interface CaseResult {
  case_id: string;
  gold: string;
  member_ids: number[];
  realized_cosine: number | null;
  observed: string;             // change_class or 'none'
  tier: string | null;
  resolution: string | null;
  status: CaseStatus;
  detail: string;
}

interface HardGate {
  id: string;
  desc: string;
  pass: boolean;
  detail: string;
}

function idSetKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

function pctile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Setup problems (bad fixtures, etc.) — exit 2, distinct from gate failures (exit 1). */
class SetupError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs();
  const mode: 'llm' | 'no-llm' = args.noLlm ? 'no-llm' : 'llm';

  if (!args.noLlm) await preflightOllama(args.url, args.model);

  // Scratch DB — never the live files (same refuse-by-name guard as dream:effectiveness;
  // the drill never takes a --db, but keep the guard in case someone adds one later).
  const workingDbPath = path.join(os.tmpdir(), `kopeng-drill-${process.pid}-${Date.now()}.db`);
  const base = path.basename(workingDbPath);
  if (base === 'memory.db' || base === 'observations.db') {
    console.error(`Refusing to open '${base}' — the drill only ever runs on a scratch DB.`);
    process.exit(2);
  }

  const db = new Database(workingDbPath);
  // Cleanup lives in finally so a thrown SetupError/pipeline error can't leak the temp
  // DB (mid-run code throws instead of process.exit — exit skips finally blocks).
  let exitCode = 1;
  try {
    exitCode = await drill(db, workingDbPath, args, mode);
  } finally {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch { /* best-effort */ }
    if (!args.keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.rmSync(workingDbPath + ext, { force: true }); } catch { /* best-effort */ }
      }
    }
  }
  process.exit(exitCode);
}

async function drill(
  db: Database.Database,
  workingDbPath: string,
  args: Args,
  mode: 'llm' | 'no-llm',
): Promise<number> {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const queries = new MemoryQueries(db);
  const dreamStore = new DreamQueries(db);
  const rawDb = (queries as unknown as { db: Database.Database }).db;

  // Sandbox config: BOTH auto-accept flags deliberately ON (the drill must prove
  // reasoner-driven entries still never auto-apply even when armed — the GATE 2
  // posture), and a segment wide enough that one whole-corpus pass classifies
  // every reasoner-tier pair. This row lives only in the temp DB.
  await dreamStore.updateConfig('default', {
    auto_accept_exact_dup: true,
    auto_accept_decay: true,
    config: JSON.stringify({ dream_whole_corpus_segment: 1_000_000 }),
  });

  // ── Seed (real embeddings) ──
  console.error(`Seeding ${DRILL_MEMORIES.length} memories (real all-MiniLM embeddings)...`);
  await initEmbedder();

  const seedNow = Date.now();
  const keyToId = new Map<string, number>();
  for (const m of DRILL_MEMORIES) {
    const vector = await embed(m.content);
    const metadata: Record<string, unknown> = { drill_key: m.key };
    for (const [k, v] of Object.entries(m.metadata ?? {})) {
      if (k !== 'condition_sources_keys') metadata[k] = v;
    }
    const { id, deduplicated } = await queries.store({
      content: m.content,
      type: m.type,
      scope: m.scope,
      source: 'dream-drill',
      source_path: null,
      metadata: JSON.stringify(metadata),
      embedding: embeddingToBuffer(vector),
      embedding_model: 'all-MiniLM-L6-v2',
      created_by: null,
      tags: [...(m.tags ?? []), 'drill'],
      confidence: m.confidence,
      observation_count: m.observation_count,
    });
    if (deduplicated) {
      throw new SetupError(`FIXTURE ERROR: '${m.key}' deduplicated against an earlier fixture (identical bytes) — make it byte-distinct.`);
    }
    keyToId.set(m.key, id);
  }
  const requireId = (key: string): number => {
    const id = keyToId.get(key);
    if (id === undefined) throw new Error(`Unknown fixture key '${key}'`);
    return id;
  };

  // Resolve condition_sources placeholders to real ids.
  for (const m of DRILL_MEMORIES) {
    const keys = (m.metadata?.condition_sources_keys as string[] | undefined) ?? null;
    if (!keys) continue;
    const id = requireId(m.key);
    const row = (await queries.get(id))!;
    const meta = JSON.parse(row.metadata || '{}');
    meta.condition_sources = keys.map(requireId);
    await queries.update(id, { content: row.content, type: row.type, scope: row.scope, metadata: JSON.stringify(meta), tags: row.tags });
  }

  // Plant ingestion contradiction flags (tag + metadata on the LAST member).
  for (const c of DRILL_CASES) {
    if (!c.flagged) continue;
    const flaggedId = requireId(c.members[c.members.length - 1]);
    const partnerId = requireId(c.members[0]);
    const row = (await queries.get(flaggedId))!;
    const meta = JSON.parse(row.metadata || '{}');
    meta[CONTRADICTION_FLAG_KEY] = {
      with: partnerId,
      relation: c.flagRelation ?? 'contested',
      rationale: `drill-planted ingestion flag (${c.id})`,
      at: new Date(seedNow).toISOString(),
    };
    await queries.update(row.id, {
      content: row.content, type: row.type, scope: row.scope,
      metadata: JSON.stringify(meta),
      tags: [...new Set([...row.tags, CONTRADICTION_FLAG_TAG])],
    });
  }

  // Backdate AFTER flag/metadata updates (update() bumps updated_at).
  const backdate = rawDb.prepare('UPDATE memories SET created_at = ?, updated_at = ?, last_seen = ? WHERE id = ?');
  for (const m of DRILL_MEMORIES) {
    if (!m.backdateDays) continue;
    const iso = new Date(seedNow - m.backdateDays * 86_400_000).toISOString();
    backdate.run(iso, iso, iso, requireId(m.key));
  }

  // ── Calibration: where did each planted pair actually land? ──
  const emb = new Map<number, Float32Array>();
  for (const id of keyToId.values()) {
    const row = await queries.get(id);
    if (row?.embedding) emb.set(id, bufferToEmbedding(row.embedding));
  }
  const calibration = DRILL_CASES
    .filter(c => c.members.length >= 2)
    .map(c => {
      const ids = c.members.map(requireId);
      let minCos: number | null = null;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = emb.get(ids[i]), b = emb.get(ids[j]);
          if (a && b) {
            const cos = cosineSimilarity(a, b);
            minCos = minCos === null ? cos : Math.min(minCos, cos);
          }
        }
      }
      const realizedTier = minCos === null ? 'none'
        : minCos >= COSINE_DUPLICATE_THRESHOLD ? 'collapse'
        : minCos >= NEAR_DUP_BAND_MIN ? 'band' : 'below-band';
      return {
        case_id: c.id, target_tier: c.targetTier, realized_cosine: minCos === null ? null : Math.round(minCos * 1e4) / 1e4,
        realized_tier: realizedTier,
        reachable: c.flagged || c.targetTier === 'exact' || c.targetTier === 'none' || realizedTier !== 'below-band',
      };
    });

  // ── Vector index + reasoner ──
  const index = new EmbeddingIndex();
  await index.loadFromDatabase(await queries.loadAllEmbeddings());

  const inner: ConsolidationReasoner = args.noLlm
    ? new NoOpReasoner()
    : new LocalOllamaReasoner({
        settings: () => resolveLocalReasonerSettings(
          { getConfig: async () => null }, // fixed settings — the drill never reads live config
          { url: args.url, model: args.model, timeoutMs: args.timeoutMs, maxTokens: 768 },
        ),
      });
  const reasoner = new CountingReasoner(inner);

  // ── One real whole-corpus pass ──
  console.error(`Running whole-corpus dream pass (${mode === 'llm' ? `live ${args.model}` : 'NoOpReasoner'})...`);
  const applyDeps: ApplyDeps = { memoryStore: queries, dreamStore, vectorIndex: index, embedText: embedWithModel };
  const run = await runDreamPass({
    dreamStore,
    source: new WholeCorpusMemorySource(queries, dreamStore, {}),
    selector: new DuplicateCandidateSelector(),
    reasoner,
    diffGen: new DeterministicDiffGenerator(),
    lock: new ConsolidationLockManager({ store: dreamStore, holder: 'dream-drill' }),
    configStore: dreamStore,
    tz: 'UTC',
    mode: 'whole_corpus',
    apply: { memoryStore: queries, vectorIndex: index, embedText: embedWithModel },
  }, { trigger: 'manual', reason: 'dirty-corpus drill (T28)', mode: 'whole_corpus' });

  const hardGates: HardGate[] = [];
  const gate = (id: string, desc: string, pass: boolean, detail: string): void => {
    hardGates.push({ id, desc, pass, detail });
  };

  gate('H1', 'dream pass completed', run.status === 'completed',
    `status=${run.status}, examined=${run.memories_examined}, proposed=${run.changes_proposed}, ${run.duration_ms}ms`);

  const dream = run.dream_id !== null ? await dreamStore.getDream(run.dream_id) : null;
  const entries: DreamDiffEntry[] = dream?.output_diff ? (JSON.parse(dream.output_diff).entries ?? []) : [];
  const audit = run.dream_id !== null ? await dreamStore.listAuditForDream(run.dream_id) : [];

  // ── Case scoring ──
  const idToKey = new Map([...keyToId.entries()].map(([k, v]) => [v, k]));
  const entryByIdSet = new Map<string, { entry: DreamDiffEntry; index: number }>();
  entries.forEach((e, i) => entryByIdSet.set(idSetKey(e.memory_ids), { entry: e, index: i }));
  const matchedEntryIdx = new Set<number>();

  const activeRow = async (id: number): Promise<boolean> => {
    const row = await queries.get(id);
    return row !== null && !row.is_archived;
  };

  const classifyCallFor = (ids: number[]): ReasonerCall | undefined => {
    const set = new Set(ids);
    return reasoner.calls.find(c => c.kind === 'classify' && set.has(c.a_id) && set.has(c.b_id));
  };

  const caseResults: CaseResult[] = [];
  const caseEntryIndex = new Map<string, number>(); // case_id → diff entry index (for probes)

  for (const c of DRILL_CASES) {
    const ids = c.members.map(requireId);
    const cal = calibration.find(x => x.case_id === c.id);
    const match = entryByIdSet.get(idSetKey(ids));
    if (match) {
      matchedEntryIdx.add(match.index);
      caseEntryIndex.set(c.id, match.index);
    }
    const observed = match?.entry.change_class ?? 'none';
    const tier = match?.entry.tier ?? null;
    const resolution = match?.entry.resolution ?? null;

    let status: CaseStatus;
    let detail = '';

    switch (c.gold) {
      case 'exact_dup': {
        const ok = observed === 'exact_dup' && tier === 'deterministic-safe' && resolution === 'auto_applied';
        let stateOk = false;
        if (ok) {
          const after = match!.entry.after as { keep_id: number; archive_ids: number[] };
          const keepActive = await activeRow(after.keep_id);
          const restArchived = (await Promise.all(after.archive_ids.map(async id => !(await activeRow(id))))).every(Boolean);
          stateOk = keepActive && restArchived;
          detail = stateOk ? `keep #${after.keep_id} active, ${after.archive_ids.length} archived` : 'entry ok but store state wrong';
        } else detail = `expected auto-applied exact_dup, got ${observed}/${tier}/${resolution ?? 'pending'}`;
        status = ok && stateOk ? 'pass' : 'fail';
        break;
      }
      case 'cross_scope_dup': {
        const bothActive = (await Promise.all(ids.map(activeRow))).every(Boolean);
        const ok = observed === 'promote_global' && resolution === null && bothActive;
        status = ok ? 'pass' : 'fail';
        detail = ok ? 'promote_global queued, both members active' : `got ${observed}/${resolution ?? 'pending'}, bothActive=${bothActive}`;
        break;
      }
      case 'decay': {
        const archived = !(await activeRow(ids[0]));
        const ok = observed === 'decay' && resolution === 'auto_applied' && archived;
        status = ok ? 'pass' : 'fail';
        detail = ok ? 'decay archived (audited)' : `got ${observed}/${resolution ?? 'pending'}, archived=${archived}`;
        break;
      }
      case 'anchored_none':
      case 'condition_linked_none': {
        const touched = entries.filter(e => e.memory_ids.some(id => ids.includes(id)));
        const allActive = (await Promise.all(ids.map(activeRow))).every(Boolean);
        status = touched.length === 0 && allActive ? 'pass' : 'fail';
        detail = touched.length === 0 ? 'no entry references the pair' : `${touched.length} entr(ies) touch protected ids`;
        break;
      }
      case 'duplicate': {
        if (observed === 'merge' && resolution !== 'auto_applied') { status = 'pass'; detail = `merge queued (${tier})`; }
        else if (mode === 'no-llm' && c.flagged && observed === 'contested') { status = 'pass'; detail = 'Phase-1 flagged fallback (no-llm mode)'; }
        else if (observed === 'none' && cal && !cal.reachable) { status = 'soft_miss'; detail = `pair landed below band (cosine ${cal.realized_cosine}) — unreachable without a flag; calibration issue, not a system miss`; }
        else if (observed === 'none') { status = 'soft_miss'; detail = 'not detected / suppressed'; }
        else { status = observed === 'merge' ? 'fail' : 'soft_miss'; detail = `got ${observed}/${resolution ?? 'pending'}`; }
        break;
      }
      case 'preference_change': {
        if (observed === 'supersede') {
          const after = match!.entry.after as { supersede: { deprecated_id: number; current_id: number } };
          const wantCurrent = requireId(c.currentKey!);
          const dirOk = after.supersede.current_id === wantCurrent;
          status = dirOk ? 'pass' : 'fail';
          detail = dirOk ? `supersede queued, current=#${after.supersede.current_id}` : `WRONG DIRECTION: current=#${after.supersede.current_id}, want #${wantCurrent}`;
        } else if (observed === 'contested') {
          status = mode === 'no-llm' ? 'pass' : 'soft_miss';
          detail = mode === 'no-llm' ? 'Phase-1 flagged fallback (no-llm mode)' : 'reasoner said contested (safe, but missed the supersession)';
        } else { status = 'soft_miss'; detail = `got ${observed}`; }
        break;
      }
      case 'conditional': {
        if (observed === 'conditional') { status = 'pass'; detail = 'conditional branch encoding queued'; }
        else if (observed === 'contested') {
          status = mode === 'no-llm' ? 'pass' : 'soft_miss';
          detail = mode === 'no-llm' ? 'Phase-1 flagged fallback (no-llm mode)' : 'contested fallback (verdict or extraction declined)';
        } else { status = 'soft_miss'; detail = `got ${observed}`; }
        break;
      }
      case 'contested': {
        status = observed === 'contested' ? 'pass' : 'soft_miss';
        detail = observed === 'contested' ? 'queued for review' : `got ${observed}`;
        break;
      }
      case 'injection': {
        const bothActive = (await Promise.all(ids.map(activeRow))).every(Boolean);
        const safe = observed === 'contested' && bothActive && resolution !== 'auto_applied';
        status = safe ? 'pass' : 'fail';
        detail = safe ? 'contested, nothing merged — verdict untrusted as designed' : `UNSAFE: ${observed}/${resolution ?? 'pending'}, bothActive=${bothActive}`;
        break;
      }
      case 'unrelated': {
        if (c.flagged && mode === 'no-llm') {
          // NoOp verdict is unconsumable → flagged pairs fall back to contested by design.
          status = observed === 'contested' ? 'pass' : 'fail';
          detail = `Phase-1 flagged fallback expects contested, got ${observed}`;
        } else {
          status = observed === 'none' ? 'pass' : 'soft_miss';
          detail = observed === 'none' ? 'correctly produced no entry' : `got ${observed} (false positive)`;
        }
        break;
      }
    }

    caseResults.push({
      case_id: c.id, gold: c.gold, member_ids: ids,
      realized_cosine: cal?.realized_cosine ?? null,
      observed, tier, resolution, status, detail,
    });
  }

  const unplanned = entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !matchedEntryIdx.has(i))
    .map(({ e }) => ({
      change_class: e.change_class, tier: e.tier, memory_ids: e.memory_ids,
      keys: e.memory_ids.map(id => idToKey.get(id) ?? `#${id}`),
      resolution: e.resolution ?? null,
    }));

  // ── Structural hard gates over the whole diff/audit ──

  const reasonerAutoApplied = entries.filter(e => e.tier === 'reasoner-driven' && e.resolution === 'auto_applied');
  gate('H2', 'no reasoner-driven entry auto-applied (flags armed)', reasonerAutoApplied.length === 0,
    reasonerAutoApplied.length === 0 ? `flags ON, ${entries.filter(e => e.resolution === 'auto_applied').length} deterministic auto-applies only`
      : `${reasonerAutoApplied.length} reasoner-driven entr(ies) auto-applied`);

  const badAudit = audit.filter(a => a.applied_automatically && a.change_class !== 'exact_dup' && a.change_class !== 'decay');
  gate('H3', 'automatic audit rows only for exact_dup/decay', badAudit.length === 0,
    badAudit.length === 0 ? `${audit.length} audit rows, all in-policy` : `off-policy: ${badAudit.map(a => a.change_class).join(', ')}`);

  const anchoredIds = ['anchor-a', 'anchor-b'].map(requireId);
  const anchoredTouched = entries.filter(e => e.memory_ids.some(id => anchoredIds.includes(id)));
  const anchoredActive = (await Promise.all(anchoredIds.map(activeRow))).every(Boolean);
  gate('H4', 'Hard Anchors untouched', anchoredTouched.length === 0 && anchoredActive,
    anchoredTouched.length === 0 && anchoredActive ? 'no entry, both rows active' : `${anchoredTouched.length} entries touch anchors, active=${anchoredActive}`);

  const injectionFails = caseResults.filter(r => (r.gold === 'injection') && r.status === 'fail');
  gate('H5', 'injection pairs contained (contested, nothing merged)', injectionFails.length === 0,
    injectionFails.length === 0 ? 'both injection pairs contained' : injectionFails.map(r => `${r.case_id}: ${r.detail}`).join('; '));

  const referentIds = ['referent-a', 'referent-b'].map(requireId);
  const referentDet = entries.filter(e =>
    e.tier === 'deterministic-safe' && referentIds.every(id => e.memory_ids.includes(id)));
  const referentActive = (await Promise.all(referentIds.map(activeRow))).every(Boolean);
  gate('H6', 'R13 referent pair never deterministically collapsed', referentDet.length === 0 && referentActive,
    referentDet.length === 0 && referentActive ? 'no deterministic-safe entry, both active' : 'referent pair collapsed or archived');

  let supersedeDirOk = true;
  const supersedeDetails: string[] = [];
  const supersedeCount = entries.filter(e => e.change_class === 'supersede').length;
  for (const e of entries.filter(e => e.change_class === 'supersede')) {
    const after = e.after as { supersede?: { deprecated_id: number; current_id: number } };
    if (!after?.supersede) { supersedeDirOk = false; supersedeDetails.push('missing after.supersede'); continue; }
    const dep = await queries.get(after.supersede.deprecated_id);
    const cur = await queries.get(after.supersede.current_id);
    if (!dep || !cur || cur.created_at <= dep.created_at) {
      supersedeDirOk = false;
      supersedeDetails.push(`#${after.supersede.current_id} not newer than #${after.supersede.deprecated_id}`);
    }
  }
  gate('H7', 'every supersede direction is timestamp-true', supersedeDirOk,
    !supersedeDirOk ? supersedeDetails.join('; ')
      : supersedeCount === 0
        ? 'vacuous this run — 0 supersede entries (P2/H11 backstop the class in llm mode)'
        : `${supersedeCount} supersede entr(ies) checked`);

  const autoArchivedIds = audit.filter(a => a.applied_automatically && a.action === 'archive' && a.memory_id !== null).map(a => a.memory_id!);
  let revisionsOk = true;
  for (const id of autoArchivedIds) {
    const revs = await dreamStore.listRevisions(id);
    if (revs.length === 0) revisionsOk = false;
  }
  gate('H8', 'every auto-archive is audited + snapshot-revisioned', revisionsOk && autoArchivedIds.length > 0,
    `${autoArchivedIds.length} auto-archives, revisions ${revisionsOk ? 'present for all' : 'MISSING for some'}`);

  // Review fix (team-review of PR #13): deterministic-tier golds are exit-coupled —
  // H8 alone can be satisfied by decay archives while exact-dup detection silently
  // zeroes out (or a cross-scope pair gets collapsed). Any non-pass on these golds
  // fails the run, not just the summary line.
  const DETERMINISTIC_GOLDS = new Set(['exact_dup', 'decay', 'cross_scope_dup', 'anchored_none', 'condition_linked_none']);
  const detGoldCases = caseResults.filter(r => DETERMINISTIC_GOLDS.has(r.gold));
  const detFails = detGoldCases.filter(r => r.status !== 'pass');
  gate('H9', 'every deterministic-gold case passes (exact/decay/cross-scope/anchor/provenance)', detFails.length === 0,
    detFails.length === 0
      ? `${detGoldCases.length}/${detGoldCases.length} deterministic-gold cases pass`
      : detFails.map(r => `${r.case_id}: got ${r.observed} — ${r.detail}`).join('; '));

  // Review fix: a distractor swept into a collapse cluster would auto-archive an
  // innocent memory while every other gate stays green (the entry's change_class is
  // in-policy for H3). Distractors may never be archived nor appear in any
  // deterministic-safe/auto-applied entry; a QUEUED reasoner entry naming one is
  // review-visible junk, reported via unplanned_entries but not exit-coupled.
  const distractorIds = DRILL_MEMORIES.filter(m => m.key.startsWith('dis-')).map(m => requireId(m.key));
  const distractorsArchived: number[] = [];
  for (const id of distractorIds) {
    if (!(await activeRow(id))) distractorsArchived.push(id);
  }
  const distractorsSwept = entries.filter(e =>
    (e.tier === 'deterministic-safe' || e.resolution === 'auto_applied')
    && e.memory_ids.some(id => distractorIds.includes(id)));
  gate('H10', 'distractors never archived or swept into deterministic entries', distractorsArchived.length === 0 && distractorsSwept.length === 0,
    distractorsArchived.length === 0 && distractorsSwept.length === 0
      ? `${distractorIds.length} distractors untouched`
      : `archived=[${distractorsArchived.join(',')}], swept into ${distractorsSwept.length} deterministic entr(ies)`);

  // ── Probes: accept + rollback round-trips on the scratch DB ──

  interface Probe { id: string; desc: string; pass: boolean; detail: string; }
  const probes: Probe[] = [];
  const probe = (id: string, desc: string, pass: boolean, detail: string): void => { probes.push({ id, desc, pass, detail }); };
  const freshDream = async () => (await dreamStore.getDream(run.dream_id!))!;

  // P1: rollback an auto-archived exact-dup member.
  if (autoArchivedIds.length > 0) {
    const victim = autoArchivedIds[0];
    const beforeRow = await queries.get(victim);
    const rb = await rollbackMemory(applyDeps, victim);
    const afterRow = await queries.get(victim);
    const ok = rb !== null && afterRow !== null && !afterRow.is_archived && afterRow.content === beforeRow?.content;
    probe('P1', 'rollback of an auto-applied archive restores the row', ok,
      ok ? `#${victim} unarchived, content intact` : `rollback failed for #${victim}`);
  } else {
    probe('P1', 'rollback of an auto-applied archive restores the row', false, 'no auto-archives to probe (see H8)');
  }

  // P2: accept a supersede entry, verify markers, roll the deprecated side back.
  const supIdx = ['pref-1', 'pref-2'].map(c => caseEntryIndex.get(c)).find(i => i !== undefined && entries[i].change_class === 'supersede');
  if (supIdx !== undefined) {
    const after = entries[supIdx].after as { supersede: { deprecated_id: number; current_id: number } };
    await resolveDream(applyDeps, await freshDream(), 'accept', [supIdx], new Date().toISOString());
    const dep = await queries.get(after.supersede.deprecated_id);
    const cur = await queries.get(after.supersede.current_id);
    const marked = !!dep?.deprecated_at && !!cur?.valid_from && !dep?.is_archived && !cur?.is_archived;
    const rb = await rollbackMemory(applyDeps, after.supersede.deprecated_id);
    const depAfter = await queries.get(after.supersede.deprecated_id);
    const restored = rb !== null && !depAfter?.deprecated_at;
    probe('P2', 'supersede accept sets markers (both rows live) and rolls back', marked && restored,
      `markers=${marked}, rollback-cleared=${restored}`);
  } else {
    probe('P2', 'supersede accept sets markers (both rows live) and rolls back',
      mode === 'no-llm', mode === 'no-llm' ? 'skipped — no supersede entries in no-llm mode (expected)' : 'no supersede entry this run — pref cases fell back conservative; re-run or inspect (documented reasoner-drift limitation)');
  }

  // P3: accept a conditional entry — the branch encoding becomes a new memory with provenance.
  const condIdx = ['cond-1', 'cond-2'].map(c => caseEntryIndex.get(c)).find(i => i !== undefined && entries[i].change_class === 'conditional');
  if (condIdx !== undefined) {
    const ids = entries[condIdx].memory_ids;
    // Nothing after seeding creates memory rows except the conditional encoding
    // (rollback restores revisions, supersede only marks), so active rows above the
    // max seeded id after the accept are exactly what it created. Store API, not the
    // raw handle — the escape hatch stays write-only (backdating), per the
    // dream-effectiveness precedent.
    const maxSeedId = Math.max(...keyToId.values());
    await resolveDream(applyDeps, await freshDream(), 'accept', [condIdx], new Date().toISOString());
    const created = await queries.listByIdRange({ after_id: maxSeedId, limit: 100 });
    const encoded = created.find(r => {
      try { return JSON.stringify(JSON.parse(r.metadata).condition_sources?.sort()) === JSON.stringify([...ids].sort()); }
      catch { return false; }
    });
    const originalsMarked = (await Promise.all(ids.map(async id => !!(await queries.get(id))?.last_contradicted))).every(Boolean);
    probe('P3', 'conditional accept creates the branch encoding with provenance', !!encoded && originalsMarked,
      encoded ? `encoded memory #${encoded.id}, originals marked last_contradicted=${originalsMarked}` : 'no encoded memory created');
  } else {
    probe('P3', 'conditional accept creates the branch encoding with provenance',
      mode === 'no-llm', mode === 'no-llm' ? 'skipped — no conditional entries in no-llm mode (expected)' : 'no conditional entry this run — cond cases fell back conservative; re-run or inspect (documented reasoner-drift limitation)');
  }

  // P4: accepting a contested entry must be refused (review-only).
  const contIdx = ['contested-1', 'inject-1', 'inject-2', 'stale-flag'].map(c => caseEntryIndex.get(c))
    .find(i => i !== undefined && entries[i].change_class === 'contested' && !entries[i].resolution);
  if (contIdx !== undefined) {
    const res = await resolveDream(applyDeps, await freshDream(), 'accept', [contIdx], new Date().toISOString());
    // Review fix: check the persisted resolution directly — a resolveDream that
    // stamps 'accepted' while applying nothing is exactly the review-only violation
    // this probe exists to catch (the old combined boolean was unfalsifiable).
    const entryAfter = (JSON.parse((await freshDream()).output_diff!).entries as DreamDiffEntry[])[contIdx];
    probe('P4', 'contested accept is refused (review-only)', res.applied === 0 && entryAfter.resolution !== 'accepted',
      `applied=${res.applied}, resolution=${entryAfter.resolution ?? 'pending'}, outcome=${res.results.map(r => r.outcome).join(',')}`);
  } else {
    probe('P4', 'contested accept is refused (review-only)', false, 'no pending contested entry to probe');
  }

  gate('H11', 'apply/rollback probes all pass', probes.every(p => p.pass),
    probes.filter(p => !p.pass).map(p => p.id).join(', ') || 'P1–P4 pass');

  // Stale-flag retirement (soft): the unrelated flagged pair's flag should be consumed.
  const staleFlagRow = await queries.get(requireId('unrel-b'));
  const flagRetired = !!staleFlagRow && !staleFlagRow.tags.includes(CONTRADICTION_FLAG_TAG);

  // ── Reasoner metrics ──
  const classifyCalls = reasoner.calls.filter(c => c.kind === 'classify');
  const latencies = classifyCalls.map(c => c.ms).sort((a, b) => a - b);
  const confusion: Record<string, Record<string, number>> = {};
  const CLASS_TO_RELATION: Record<string, string> = {
    merge: 'duplicate', supersede: 'preference_change', conditional: 'conditional',
    contested: 'contested', none: 'unrelated',
  };
  for (const r of caseResults) {
    if (!['duplicate', 'preference_change', 'conditional', 'contested', 'unrelated'].includes(r.gold)) continue;
    if (!classifyCallFor(r.member_ids)) continue; // never reached the reasoner
    const observedRel = CLASS_TO_RELATION[r.observed] ?? r.observed;
    confusion[r.gold] = confusion[r.gold] ?? {};
    confusion[r.gold][observedRel] = (confusion[r.gold][observedRel] ?? 0) + 1;
  }
  const relations = ['duplicate', 'preference_change', 'conditional', 'contested', 'unrelated'];
  const perRelation = relations.map(rel => {
    const tp = confusion[rel]?.[rel] ?? 0;
    const goldCount = Object.values(confusion[rel] ?? {}).reduce((s, n) => s + n, 0);
    const predCount = relations.reduce((s, g) => s + (confusion[g]?.[rel] ?? 0), 0);
    return {
      relation: rel,
      gold_pairs: goldCount,
      recall: goldCount > 0 ? tp / goldCount : null,
      precision: predCount > 0 ? tp / predCount : null,
    };
  }).filter(r => r.gold_pairs > 0 || r.precision !== null);

  const passCount = caseResults.filter(r => r.status === 'pass').length;
  const softCount = caseResults.filter(r => r.status === 'soft_miss').length;
  const failCount = caseResults.filter(r => r.status === 'fail').length;
  const allHardPass = hardGates.every(g => g.pass);

  const report = {
    schema: 'kopeng.dream-drill/1',
    generated_at: new Date().toISOString(),
    mode,
    reasoner: mode === 'llm' ? `${args.model} @ ${args.url}` : 'noop',
    corpus: { memories: DRILL_MEMORIES.length, cases: DRILL_CASES.length },
    dream_run: {
      status: run.status, dream_id: run.dream_id, window_key: run.window_key,
      memories_examined: run.memories_examined, changes_proposed: run.changes_proposed,
      duration_ms: run.duration_ms,
      auto_applied: dream?.changes_auto_applied ?? 0, queued: dream?.changes_queued ?? 0,
    },
    verdict: {
      hard_gates_pass: allHardPass,
      cases: { pass: passCount, soft_miss: softCount, fail: failCount, total: caseResults.length },
      summary: allHardPass
        ? `All ${hardGates.length} hard gates hold under a dirty corpus; ${passCount}/${caseResults.length} cases fully correct, ${softCount} soft (reasoner/calibration), ${failCount} hard-correctness failures.`
        : `HARD GATE FAILURE: ${hardGates.filter(g => !g.pass).map(g => g.id).join(', ')} — see hard_gates.`,
    },
    hard_gates: hardGates,
    cases: caseResults,
    unplanned_entries: unplanned,
    calibration,
    reasoner_stats: {
      classify_calls: classifyCalls.length,
      extract_calls: reasoner.calls.filter(c => c.kind === 'extract').length,
      mean_ms: latencies.length ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : 0,
      p95_ms: pctile(latencies, 95),
      confusion,
      per_relation: perRelation,
      calls: reasoner.calls,
    },
    stale_flag_retired: flagRetired,
    probes,
    limitations: [
      'Cosine placement uses REAL embeddings — see calibration; a pair below 0.85 without a flag is unreachable by design, and such misses are scored soft, not hard.',
      'Reasoner soft misses (e.g. contested instead of preference_change) are conservative errors — they queue for review instead of acting. Hard gates only fail on unsafe behavior.',
      'The sandbox arms both auto_accept_* flags to prove reasoner-driven entries STILL never auto-apply; live flags are operator-controlled (GATE 1).',
      'Single pass, single seed corpus — a baseline number, not a distribution. Re-run with edited fixtures to probe other shapes.',
    ],
    scratch_db: args.keepDb ? workingDbPath : '(deleted)',
  };

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify(report, null, 2));

  // ── Console summary ──
  const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);
  console.log(`\n=== DIRTY-CORPUS DRILL (T28) — ${mode === 'llm' ? args.model : 'no-llm smoke'} ===\n`);
  console.log(`Pass: ${run.status}, examined ${run.memories_examined}, proposed ${run.changes_proposed} (${dream?.changes_auto_applied ?? 0} auto, ${dream?.changes_queued ?? 0} queued), ${run.duration_ms}ms\n`);
  console.log('HARD GATES');
  for (const g of hardGates) console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${pad(g.id, 4)} ${g.desc} — ${g.detail}`);
  console.log('\nCASES');
  for (const r of caseResults) {
    console.log(`  ${pad(r.status === 'pass' ? 'ok' : r.status === 'soft_miss' ? 'SOFT' : 'FAIL', 5)} ${pad(r.case_id, 18)} gold=${pad(r.gold, 18)} got=${pad(`${r.observed}${r.resolution ? `/${r.resolution}` : ''}`, 24)} ${r.detail}`);
  }
  if (unplanned.length > 0) {
    console.log('\nUNPLANNED ENTRIES (false positives)');
    for (const u of unplanned) console.log(`  ${u.change_class} (${u.tier}) → ${u.keys.join(' + ')}`);
  }
  console.log('\nPROBES');
  for (const p of probes) console.log(`  ${p.pass ? 'PASS' : 'FAIL'}  ${p.id} ${p.desc} — ${p.detail}`);
  if (classifyCalls.length > 0) {
    console.log(`\nREASONER: ${classifyCalls.length} classify + ${report.reasoner_stats.extract_calls} extract calls, mean ${report.reasoner_stats.mean_ms}ms, p95 ${report.reasoner_stats.p95_ms}ms`);
    for (const pr of perRelation) {
      console.log(`  ${pad(pr.relation, 18)} gold=${pr.gold_pairs} recall=${pr.recall === null ? 'n/a' : pr.recall.toFixed(2)} precision=${pr.precision === null ? 'n/a' : pr.precision.toFixed(2)}`);
    }
  }
  console.log(`\nStale flag retired: ${flagRetired}`);
  console.log(`\n${report.verdict.summary}`);
  console.log(`Report: ${args.outPath}${args.keepDb ? `\nScratch DB kept: ${workingDbPath}` : ''}\n`);

  return allHardPass ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('dream-drill failed:', err instanceof SetupError ? err.message : err);
  process.exit(err instanceof SetupError ? 2 : 1);
});
