/**
 * Replay + metrics harness (D0.7) — the zero-LLM regression net for every later phase.
 *
 * Two surfaces:
 *  1. `runReplay` — run a real dream pass (`runDreamPass`, lock + `dreams` row and
 *     all) over a synthetic memory snapshot, capture what the selector/diff
 *     generator actually produced, and score it against a gold set of known
 *     duplicates / contradictions / preference-changes.
 *  2. `runScenario` — execute a scripted sequence of passes against one store to
 *     verify the R2 fire/collapse semantics (failed-window retry, retry budget,
 *     per-(operator, scope, mode) windows, manual `window_key` override).
 *
 * NO LLM calls anywhere in here, ever: the default reasoner is NoOpReasoner, and
 * `CountingReasoner` reports `llm_calls` so callers can assert zero. Fixtures live
 * in `tests/fixtures/dreaming/`; the CLI entry is `scripts/replay-dream.ts`
 * (`npm run dream:replay`).
 */
import type { IDreamStore, IMemoryStore, IOperatorConfigStore, IVectorSearch } from '../database/interfaces.js';
import type { DreamDiff, DreamDiffEntry, MemoryType } from '../types/types.js';
import type { VectorSearchResult } from '../embeddings/index.js';
import {
  runDreamPass, RotatingWindowMemorySource, WholeCorpusMemorySource, DbWindowMemorySource,
  type DreamEngineDeps, type DreamRunResult, type DreamRunStatus, type RotatingMemorySource,
} from './dream-engine.js';
import { CONTRADICTION_FLAG_TAG, CONTRADICTION_FLAG_KEY } from './contradiction.js';
import {
  StaticMemorySource, WindowedCandidateSelector, EmptyDiffGenerator, isAnchored,
  DuplicateCandidateSelector, DeterministicDiffGenerator,
  type CandidateSelector, type CandidateGroup, type DiffGenerator, type ClassifiedCandidate,
} from './pipeline.js';
import { NoOpReasoner } from './reasoner/noop-reasoner.js';
import type {
  ConsolidationReasoner, CandidateMemory, ReasonerContext,
  PairVerdict, ConditionExtraction, ClusterSynthesis,
} from './reasoner/reasoner.js';
import { ConsolidationLockManager } from './lock.js';
import { applyEntry, rollbackMemory, type ApplyDeps } from './apply.js';
import { autoArchiveDecayed } from '../promotion/auto-archive.js';

// ── Gold set ──

export type GoldClass = 'duplicate' | 'contradiction' | 'preference_change' | 'cross_scope_duplicate' | 'decay';

/** One known-truth case in the gold set. */
export interface GoldCase {
  id: string;
  gold_class: GoldClass;
  /** The exact memory ids that belong together. Matching is set-equality. */
  member_ids: number[];
  /** Earliest phase whose detector is expected to find this case (0 = normalized-content selector, 1.2 = cosine ≥0.95, 2 = reasoner). */
  detectable_phase: 0 | 1.2 | 2;
  note: string;
}

// ── Instrumentation wrappers (capture what the real pass produced) ──

/**
 * Counts reasoner interface calls. NoOpReasoner performs no model calls by
 * construction, so `llm_calls` is 0 for it; any other reasoner's interface
 * calls are assumed model-backed.
 */
export class CountingReasoner implements ConsolidationReasoner {
  classifyCalls = 0;
  extractCalls = 0;
  synthesizeCalls = 0;

  constructor(private readonly inner: ConsolidationReasoner) {}

  get name(): string {
    return this.inner.name;
  }

  get llmCalls(): number {
    if (this.inner.name === 'noop') return 0;
    return this.classifyCalls + this.extractCalls + this.synthesizeCalls;
  }

  async classifyPair(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<PairVerdict> {
    this.classifyCalls++;
    return this.inner.classifyPair(a, b, ctx);
  }

  async extractCondition(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<ConditionExtraction | null> {
    this.extractCalls++;
    return this.inner.extractCondition(a, b, ctx);
  }

  async synthesizeCluster(members: CandidateMemory[], ctx: ReasonerContext): Promise<ClusterSynthesis | null> {
    this.synthesizeCalls++;
    return this.inner.synthesizeCluster(members, ctx);
  }
}

class RecordingSelector implements CandidateSelector {
  groups: CandidateGroup[] = [];
  constructor(private readonly inner: CandidateSelector) {}
  async select(memories: CandidateMemory[]): Promise<CandidateGroup[]> {
    this.groups = await this.inner.select(memories);
    return this.groups;
  }
}

class RecordingDiffGenerator implements DiffGenerator {
  diff: DreamDiff = { entries: [] };
  constructor(private readonly inner: DiffGenerator) {}
  generate(classified: ClassifiedCandidate[]): DreamDiff {
    this.diff = this.inner.generate(classified);
    return this.diff;
  }
}

// ── Metrics ──

export interface DetectionMetrics {
  groups_total: number;
  true_positive_groups: number;
  false_positive_groups: number;
  gold_total: number;
  gold_detected: number;
  by_class: Record<GoldClass, { total: number; detected: number }>;
  /** TP / groups proposed. Null when no groups were proposed. */
  precision: number | null;
  /** gold_detected / gold_total — over the FULL gold set, later phases included. */
  recall: number;
  /** Recall restricted to gold cases with detectable_phase === 0 — must be 1.0 in Phase 0. */
  phase0_recall: number;
  /** Recall restricted to gold cases with detectable_phase <= 1.2 — must be 1.0 from D1.2 on. */
  phase12_recall: number;
  /** FP / groups proposed. Null when no groups were proposed. */
  false_positive_rate: number | null;
}

export interface DiffMetrics {
  entries_total: number;
  /** Proposed-change counts by DreamChangeClass. */
  by_change_class: Record<string, number>;
  /** Diff entries whose memory_ids set-match a gold case. */
  matched_gold: number;
}

export interface ReplayMetrics {
  memories_examined: number;
  detection: DetectionMetrics;
  diff: DiffMetrics;
  /** Hard-Anchor invariant: must always be empty. */
  anchor_violations: Array<{ where: 'candidate' | 'diff'; memory_id: number }>;
  reasoner: { name: string; classify_calls: number; llm_calls: number };
}

export interface ReplayResult {
  run: DreamRunResult;
  metrics: ReplayMetrics;
}

function setEq(ids: number[], set: ReadonlySet<number>): boolean {
  return ids.length === set.size && ids.every(id => set.has(id));
}

export function computeMetrics(args: {
  corpus: CandidateMemory[];
  gold: GoldCase[];
  groups: CandidateGroup[];
  diff: DreamDiff;
  memoriesExamined: number;
  reasoner: CountingReasoner;
}): ReplayMetrics {
  const { corpus, gold, groups, diff } = args;
  const goldSets = gold.map(g => ({ gold: g, set: new Set(g.member_ids) }));

  // Detection: a group is a true positive iff its member-id set equals a gold case's.
  let tp = 0;
  let fp = 0;
  const detected = new Set<string>();
  for (const group of groups) {
    const ids = group.members.map(m => m.id);
    const match = goldSets.find(({ set }) => setEq(ids, set));
    if (match) {
      tp++;
      detected.add(match.gold.id);
    } else {
      fp++;
    }
  }

  const byClass: DetectionMetrics['by_class'] = {
    duplicate: { total: 0, detected: 0 },
    contradiction: { total: 0, detected: 0 },
    preference_change: { total: 0, detected: 0 },
    cross_scope_duplicate: { total: 0, detected: 0 },
    decay: { total: 0, detected: 0 },
  };
  for (const g of gold) {
    byClass[g.gold_class].total++;
    if (detected.has(g.id)) byClass[g.gold_class].detected++;
  }
  const phase0 = gold.filter(g => g.detectable_phase === 0);
  const phase0Detected = phase0.filter(g => detected.has(g.id)).length;
  const phase12 = gold.filter(g => g.detectable_phase <= 1.2);
  const phase12Detected = phase12.filter(g => detected.has(g.id)).length;

  const byChangeClass: Record<string, number> = {};
  let matchedGold = 0;
  for (const entry of diff.entries) {
    byChangeClass[entry.change_class] = (byChangeClass[entry.change_class] ?? 0) + 1;
    if (goldSets.some(({ set }) => setEq(entry.memory_ids, set))) matchedGold++;
  }

  // Hard Anchor: confidence >= 1.0 / is_locked members must never surface anywhere.
  const anchoredIds = new Set(corpus.filter(isAnchored).map(m => m.id));
  const violations: ReplayMetrics['anchor_violations'] = [];
  for (const group of groups) {
    for (const m of group.members) {
      if (anchoredIds.has(m.id)) violations.push({ where: 'candidate', memory_id: m.id });
    }
  }
  for (const entry of diff.entries) {
    for (const id of entry.memory_ids) {
      if (anchoredIds.has(id)) violations.push({ where: 'diff', memory_id: id });
    }
  }

  return {
    memories_examined: args.memoriesExamined,
    detection: {
      groups_total: groups.length,
      true_positive_groups: tp,
      false_positive_groups: fp,
      gold_total: gold.length,
      gold_detected: detected.size,
      by_class: byClass,
      precision: groups.length ? tp / groups.length : null,
      recall: gold.length ? detected.size / gold.length : 1,
      phase0_recall: phase0.length ? phase0Detected / phase0.length : 1,
      phase12_recall: phase12.length ? phase12Detected / phase12.length : 1,
      false_positive_rate: groups.length ? fp / groups.length : null,
    },
    diff: {
      entries_total: diff.entries.length,
      by_change_class: byChangeClass,
      matched_gold: matchedGold,
    },
    anchor_violations: violations,
    reasoner: {
      name: args.reasoner.name,
      classify_calls: args.reasoner.classifyCalls,
      llm_calls: args.reasoner.llmCalls,
    },
  };
}

// ── Replay pass ──

export interface ReplayOptions {
  corpus: CandidateMemory[];
  gold: GoldCase[];
  /** Fresh store recommended — the pass writes a real `dreams` row. */
  dreamStore: IDreamStore;
  /** Defaults preserve the Phase-0 baseline; later phases swap these in to re-score. */
  selector?: CandidateSelector;
  reasoner?: ConsolidationReasoner;
  diffGen?: DiffGenerator;
  scope?: string | null;
  windowKey?: string;
  /** Injectable epoch-ms clock for deterministic runs. */
  now?: () => number;
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const selector = new RecordingSelector(opts.selector ?? new WindowedCandidateSelector());
  const diffGen = new RecordingDiffGenerator(opts.diffGen ?? new EmptyDiffGenerator());
  const reasoner = new CountingReasoner(opts.reasoner ?? new NoOpReasoner());

  const run = await runDreamPass({
    dreamStore: opts.dreamStore,
    source: new StaticMemorySource(opts.corpus),
    selector,
    reasoner,
    diffGen,
    lock: new ConsolidationLockManager({ store: opts.dreamStore, holder: 'replay-harness', now: opts.now }),
    scope: opts.scope,
    tz: 'UTC',
    now: opts.now,
  }, { trigger: 'manual', reason: 'replay harness', windowKey: opts.windowKey });

  const metrics = computeMetrics({
    corpus: opts.corpus,
    gold: opts.gold,
    groups: selector.groups,
    diff: diffGen.diff,
    memoriesExamined: run.memories_examined,
    reasoner,
  });
  return { run, metrics };
}

// ── R2 scenarios (fire/collapse semantics) ──

export interface ScenarioPass {
  /** Human label used in failure messages. */
  label: string;
  scope?: string | null;
  /** Explicit window override (the R2 manual-trigger fix). Implies trigger 'manual'. */
  windowKey?: string;
  /** Inject a diff-generator failure so the pass records a `failed` dream. */
  fail?: boolean;
  /** Expected outcome; 'failed' means the pass throws and leaves a failed row. */
  expect: DreamRunStatus | 'failed';
}

export interface ReplayScenario {
  name: string;
  description: string;
  passes: ScenarioPass[];
  /** Expected total `dreams` rows in the store after all passes. */
  expect_rows: number;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  failures: string[];
}

/** Runs every pass of one scenario against a single FRESH store from `makeStore`. */
export async function runScenario(
  scenario: ReplayScenario,
  makeStore: () => IDreamStore,
  opts: { now?: () => number } = {},
): Promise<ScenarioResult> {
  const store = makeStore();
  const failures: string[] = [];
  const boom: DiffGenerator = {
    generate: () => { throw new Error('replay harness: injected failure'); },
  };

  for (const pass of scenario.passes) {
    const deps: DreamEngineDeps = {
      dreamStore: store,
      source: new StaticMemorySource([]),
      selector: new WindowedCandidateSelector(),
      reasoner: new NoOpReasoner(),
      diffGen: pass.fail ? boom : new EmptyDiffGenerator(),
      lock: new ConsolidationLockManager({ store, holder: 'replay-harness', now: opts.now }),
      scope: pass.scope ?? null,
      tz: 'UTC',
      now: opts.now,
    };
    let outcome: DreamRunStatus | 'failed';
    try {
      const result = await runDreamPass(deps, {
        trigger: pass.windowKey ? 'manual' : 'scheduled',
        windowKey: pass.windowKey,
      });
      outcome = result.status;
    } catch {
      outcome = 'failed';
    }
    if (outcome !== pass.expect) {
      failures.push(`${pass.label}: expected '${pass.expect}', got '${outcome}'`);
    }
  }

  const rows = await store.listDreams(1000);
  if (rows.length !== scenario.expect_rows) {
    failures.push(`expected ${scenario.expect_rows} dreams row(s) after all passes, found ${rows.length}`);
  }
  return { name: scenario.name, ok: failures.length === 0, failures };
}

// ── D1.4 rotation scenario ──

/** RotatingMemorySource wrapper recording the ids each fetch returned. */
class RecordingRotatingSource implements RotatingMemorySource {
  fetchedIds: number[] = [];
  constructor(private readonly inner: RotatingMemorySource) {}
  currentCursor(): Promise<number> { return this.inner.currentCursor(); }
  commit(): Promise<void> { return this.inner.commit(); }
  async fetch(): Promise<CandidateMemory[]> {
    const rows = await this.inner.fetch();
    this.fetchedIds = rows.map(m => m.id);
    return rows;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_BASE = Date.parse('2026-06-15T08:00:00Z');

/**
 * D1.4 rotating-window scenario, run against ONE store triple over a single
 * database. Seeds a 10-memory corpus (limit 4) with a case-variant exact-dup
 * pair planted in the SECOND segment, then verifies:
 *
 *   - consecutive completed passes cover disjoint ascending segments and the
 *     window key encodes the cursor (`<day>#a<cursor>`) — so a same-day
 *     re-trigger after completion walks the NEXT segment instead of being
 *     blocked by R2 collapse;
 *   - a re-trigger of an already-collapsed segment (same window key) still
 *     collapses;
 *   - the planted dup pair is found when rotation reaches its segment;
 *   - the window wrap-fills from the bottom of the id space at the top.
 *
 * The selector's decay clock is its default (real wall time), so freshly
 * seeded rows never trip the decay tier; the ENGINE clock is scripted days
 * so window keys are deterministic.
 */
export async function runRotationScenario(deps: {
  memoryStore: IMemoryStore;
  dreamStore: IDreamStore;
  configStore: IOperatorConfigStore;
}): Promise<ScenarioResult> {
  const failures: string[] = [];
  const LIMIT = 4;

  // Seed: 10 distinct memories; #5/#6 differ only by case (exact-dup pair —
  // content_hash differs, normalized content matches). confidence 0.7 keeps
  // everything below the Hard-Anchor line.
  const contents = [
    'rotation seed: deploy script lives in scripts/deploy.sh',
    'rotation seed: staging db is on host 192.0.2.7',
    'rotation seed: weekly review happens on Fridays',
    'rotation seed: feature flags load from flags.json',
    'KOPENG REST API listens on port 3200',
    'kopeng rest api listens on port 3200',
    'rotation seed: error budget resets monthly',
    'rotation seed: vendor invoices go to accounting@',
    'rotation seed: CI cache key includes the lockfile hash',
    'rotation seed: design tokens are exported from Figma',
  ];
  const ids: number[] = [];
  for (const content of contents) {
    const { id } = await deps.memoryStore.store({
      content, type: 'project', scope: 'global', source: 'replay-rotation',
      source_path: null, metadata: '{}', embedding: null, embedding_model: '',
      created_by: null, tags: [], confidence: 0.7,
    });
    ids.push(id);
  }

  async function pass(dayOffset: number, windowKey?: string): Promise<{ result: DreamRunResult; ids: number[] }> {
    const clock = () => ROTATION_BASE + dayOffset * DAY_MS;
    const source = new RecordingRotatingSource(
      new RotatingWindowMemorySource(deps.memoryStore, deps.configStore, { limit: LIMIT }),
    );
    const result = await runDreamPass({
      dreamStore: deps.dreamStore,
      configStore: deps.configStore,
      source,
      selector: new DuplicateCandidateSelector(),
      reasoner: new NoOpReasoner(),
      diffGen: new DeterministicDiffGenerator(),
      lock: new ConsolidationLockManager({ store: deps.dreamStore, holder: 'replay-rotation', now: clock }),
      tz: 'UTC',
      now: clock,
    }, { trigger: windowKey ? 'manual' : 'scheduled', windowKey });
    return { result, ids: source.fetchedIds };
  }

  function check(label: string, ok: boolean, detail = ''): void {
    if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
  }
  const eq = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // Pass 1 (day 1): first segment, no dups in it.
  const p1 = await pass(0);
  check('pass 1: completed', p1.result.status === 'completed', `got ${p1.result.status}`);
  check('pass 1: window key encodes cursor 0', p1.result.window_key === '2026-06-15#a0', `got ${p1.result.window_key}`);
  check('pass 1: covers ids 1-4', eq(p1.ids, ids.slice(0, 4)), `got [${p1.ids}]`);
  check('pass 1: no proposals', p1.result.changes_proposed === 0, `got ${p1.result.changes_proposed}`);

  // Pass 2 (same day): the cursor advanced on completion, so the derived key is
  // a NEW per-segment window — the pass walks the next disjoint segment instead
  // of being blocked by the daily collapse. It contains the planted dup pair.
  const p2 = await pass(0);
  check('pass 2: same-day pass walks the next segment', p2.result.status === 'completed', `got ${p2.result.status}`);
  check('pass 2: window key advanced', p2.result.window_key === `2026-06-15#a${ids[3]}`, `got ${p2.result.window_key}`);
  check('pass 2: covers ids 5-8 (disjoint from pass 1)', eq(p2.ids, ids.slice(4, 8)), `got [${p2.ids}]`);
  check('pass 2: planted dup proposed', p2.result.changes_proposed === 1, `got ${p2.result.changes_proposed}`);
  if (p2.result.dream_id !== null) {
    const dream = await deps.dreamStore.getDream(p2.result.dream_id);
    const entries: DreamDiffEntry[] = dream?.output_diff ? JSON.parse(dream.output_diff).entries : [];
    const entry = entries[0];
    const want = new Set([ids[4], ids[5]]);
    check(
      'pass 2: diff entry is exact_dup of the planted pair',
      entry?.change_class === 'exact_dup' && entry.memory_ids.length === 2 && entry.memory_ids.every(id => want.has(id)),
      JSON.stringify(entry ?? null),
    );
  }

  // Pass 3 (day 2): tail + wrap-fill from the bottom.
  const p3 = await pass(1);
  check('pass 3: completed', p3.result.status === 'completed', `got ${p3.result.status}`);
  check('pass 3: window key advanced', p3.result.window_key === `2026-06-16#a${ids[7]}`, `got ${p3.result.window_key}`);
  check('pass 3: wraps (ids 9,10 then 1,2)', eq(p3.ids, [ids[8], ids[9], ids[0], ids[1]]), `got [${p3.ids}]`);

  // Pass 4: re-trigger of an already-collapsed segment (same window key) collapses.
  const p4 = await pass(1, '2026-06-15#a0');
  check('pass 4: re-trigger of a collapsed segment collapses', p4.result.status === 'collapsed', `got ${p4.result.status}`);

  const rows = await deps.dreamStore.listDreams(100);
  check('exactly 3 dreams rows (completed passes only)', rows.length === 3, `got ${rows.length}`);

  return { name: 'd14-rotating-window', ok: failures.length === 0, failures };
}

// ── T6 whole-corpus scenario ──

const WC_BASE = Date.parse('2026-06-15T08:00:00Z'); // ISO week 2026-W25

/** Unit vector with cosine exactly `w` against basis(i) (zero-model). Sized 12
 *  (was 8 pre-round-22): existing callers only ever index 0-7 (or `p % 8`), so
 *  widening is a zero-padded no-op for them — new dims stay orthogonal. */
const WC_DIM = 12;
function wcBlend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(WC_DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}
function wcBasis(i: number): Float32Array {
  const v = new Float32Array(WC_DIM);
  v[i] = 1;
  return v;
}
function wcBuf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * T6 / R12 whole-corpus scenario. Plants the GATE-1-shaped pair (a Δ≈2000-id
 * exact-dup the rotating window provably cannot co-window) plus a band backlog
 * LARGER than one id-segment, and verifies:
 *
 *   - the far-apart dup surfaces as a queued (deterministic) exact_dup proposal —
 *     it is found every pass (the deterministic tier scans the whole corpus);
 *   - the reasoner tier is bounded by the id-segment: per-pass classify calls
 *     ≤ the in-segment band-pair count, and successive passes cover DISJOINT
 *     id-segments and drain the band backlog;
 *   - the cursor advances by the segment ONLY on completion;
 *   - a deterministic-only sub-case (whole-corpus over exact-dups) makes 0 calls.
 *
 * Zero-LLM: NoOpReasoner wrapped in CountingReasoner; band pairs route to the
 * Phase-1 queued merge, the call count is asserted.
 */
export async function runWholeCorpusScenario(deps: {
  memoryStore: IMemoryStore;
  dreamStore: IDreamStore;
  configStore: IOperatorConfigStore;
}): Promise<ScenarioResult> {
  const failures: string[] = [];
  const SEGMENT = 3;
  const clock = () => WC_BASE;

  const seed = async (content: string, embedding?: Float32Array): Promise<number> => {
    const { id } = await deps.memoryStore.store({
      content, type: 'project', scope: 'global', source: 'replay-wc',
      source_path: null, metadata: '{}',
      embedding: embedding ? wcBuf(embedding) : null,
      embedding_model: embedding ? 'test' : '',
      created_by: null, tags: [], confidence: 0.7,
    });
    return id;
  };

  // Set the segment dial small so the backlog needs several passes to drain.
  await deps.configStore.updateConfig('default', {
    config: JSON.stringify({ dream_whole_corpus_segment: SEGMENT }),
  });

  // The far-apart exact-dup pair: one low id, ~2000 fillers, its twin far above.
  const dupA = await seed('Production host is 192.0.2.10 on the WireGuard net');
  // A band backlog of 5 near-dup pairs interleaved among the low ids.
  const bandPairs: Array<[number, number]> = [];
  for (let p = 0; p < 5; p++) {
    const a = await seed(`band topic ${p} stated one way`, wcBasis(p % 8));
    const b = await seed(`band topic ${p} stated a different way entirely`, wcBlend(p % 8, (p + 1) % 8, 0.90));
    bandPairs.push([a, b]);
  }
  for (let i = 0; i < 2000; i++) await seed(`wc filler ${i}`);
  const dupB = await seed('production host is 192.0.2.10 on the wireguard net');

  function check(label: string, ok: boolean, detail = ''): void {
    if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
  }
  check('planted dup pair is genuinely far apart (Δ > 1900)', dupB - dupA > 1900, `Δ=${dupB - dupA}`);

  async function pass(): Promise<{ result: DreamRunResult; calls: number; entries: DreamDiffEntry[] }> {
    const counter = new CountingReasoner(new NoOpReasoner());
    const source = new WholeCorpusMemorySource(deps.memoryStore, deps.configStore, {});
    const result = await runDreamPass({
      dreamStore: deps.dreamStore,
      configStore: deps.configStore,
      source,
      selector: new DuplicateCandidateSelector({ now: () => new Date(WC_BASE) }),
      reasoner: counter,
      diffGen: new DeterministicDiffGenerator(),
      lock: new ConsolidationLockManager({ store: deps.dreamStore, holder: 'replay-wc', now: clock }),
      mode: 'whole_corpus',
      tz: 'UTC',
      now: clock,
    }, { trigger: 'manual' });
    const dream = result.dream_id !== null ? await deps.dreamStore.getDream(result.dream_id) : null;
    const entries: DreamDiffEntry[] = dream?.output_diff ? JSON.parse(dream.output_diff).entries : [];
    return { result, calls: counter.classifyCalls, entries };
  }

  const cursor = () => new WholeCorpusMemorySource(deps.memoryStore, deps.configStore, {}).currentCursor();

  // Pass 1: segment [0,3). Finds the far-apart dup deterministically + ≤3 band pairs.
  const p1 = await pass();
  check('pass 1: completed', p1.result.status === 'completed', `got ${p1.result.status}`);
  check('pass 1: window key is the ISO-week whole key', p1.result.window_key === '2026-W25#whole#a0', `got ${p1.result.window_key}`);
  const plantedP1 = p1.entries.find(e => e.memory_ids.length === 2 && e.memory_ids.includes(dupA) && e.memory_ids.includes(dupB));
  check('pass 1: far-apart dup surfaces as exact_dup (deterministic-safe)',
    plantedP1?.change_class === 'exact_dup' && plantedP1?.tier === 'deterministic-safe', JSON.stringify(plantedP1 ?? null));
  const p1Merges = p1.entries.filter(e => e.change_class === 'merge');
  check('pass 1: reasoner calls ≤ segment band-pairs', p1.calls <= SEGMENT, `calls=${p1.calls}`);
  check('pass 1: queued merges == in-segment classify calls', p1Merges.length === p1.calls, `merges=${p1Merges.length} calls=${p1.calls}`);
  check('pass 1: cursor advanced by the segment', (await cursor()) === SEGMENT, `cursor=${await cursor()}`);

  // Pass 2: segment [3,6) — disjoint from pass 1. Different band pairs classified.
  const p2 = await pass();
  check('pass 2: completed on the next segment', p2.result.status === 'completed', `got ${p2.result.status}`);
  check('pass 2: window key advanced to the next segment', p2.result.window_key === `2026-W25#whole#a${SEGMENT}`, `got ${p2.result.window_key}`);
  const p2MergeIds = new Set(p2.entries.filter(e => e.change_class === 'merge').flatMap(e => e.memory_ids));
  const p1MergeIds = new Set(p1Merges.flatMap(e => e.memory_ids));
  const overlap = [...p2MergeIds].some(id => p1MergeIds.has(id));
  check('pass 2: classified band pairs are disjoint from pass 1', !overlap, `p1=${[...p1MergeIds]} p2=${[...p2MergeIds]}`);
  check('pass 2: cursor advanced again', (await cursor()) === 2 * SEGMENT, `cursor=${await cursor()}`);

  // Drain: keep passing until the band backlog is exhausted (deterministic dup
  // still appears every pass, but no NEW merges once all band pairs are drained).
  let drained = false;
  const allMergeIds = new Set([...p1MergeIds, ...p2MergeIds]);
  for (let i = 0; i < 12 && !drained; i++) {
    const pn = await pass();
    const ids = pn.entries.filter(e => e.change_class === 'merge').flatMap(e => e.memory_ids);
    ids.forEach(id => allMergeIds.add(id));
    // Every band pair's BOTH members eventually appear in a queued merge.
    if (bandPairs.every(([a, b]) => allMergeIds.has(a) && allMergeIds.has(b))) drained = true;
  }
  check('all band pairs drain across successive disjoint segments', drained,
    `merged ids=${[...allMergeIds]}`);

  return { name: 't6-whole-corpus', ok: failures.length === 0, failures };
}

// ── T31 referent-guard scenario ──

/**
 * No-op vector index for the referent-guard scenario's apply deps. The apply
 * deps exist only so the engine's flag-consumption step runs (`deps.apply`
 * gates it); with the default operator config nothing deterministic-safe ever
 * auto-applies, so the index is never meaningfully used.
 */
export class NullVectorSearch implements IVectorSearch {
  async loadFromDatabase(): Promise<void> { /* no-op */ }
  async add(): Promise<void> { /* no-op */ }
  async remove(): Promise<void> { /* no-op */ }
  async search(): Promise<VectorSearchResult[]> { return []; }
  get isReady(): boolean { return true; }
  get size(): number { return 0; }
}

/**
 * T31 / R13-extension scenario: the queue-review noise class (an entire
 * pending queue of discovery-template pairs — sequence bigrams,
 * repeated_tool payloads, key-files lists, numeric-only re-observations) must
 * produce ZERO reasoner calls and ZERO queue entries, across both the flagged
 * and the 0.85–0.95 band consumption paths, while:
 *
 *   - a same-template + SAME-referent pair with a substantive difference (a
 *     genuine potential contradiction) still reaches the reasoner and queues
 *     its Phase-1 entry;
 *   - an operator-authored (non-discovery) list-shaped pair is never
 *     guard-routed — it classifies and falls back contested as before;
 *   - the noise flagged pair's stale ingestion flag retires through the
 *     existing unrelated-verdict consume path (no special-casing).
 *
 * Zero-LLM: NoOpReasoner wrapped in CountingReasoner — the classify-call count
 * is the proof that the guard, not the reasoner, decided the noise pairs.
 */
export async function runReferentGuardScenario(deps: {
  memoryStore: IMemoryStore;
  dreamStore: IDreamStore;
}): Promise<ScenarioResult> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = ''): void => {
    if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
  };

  // The EXACT template shapes auto-discovery emits (heuristics.ts / synthesizer.ts).
  const seq = (bigram: string, sessions: number, total: number, pct: number): string =>
    `Workflow sequence detected: ${bigram}. Observed in ${sessions}/${total} sessions (${pct}% coverage). This consistent ordering suggests a deliberate workflow step.`;
  const repeated = (tool: string, payload: string): string =>
    `When working in this project, the operator frequently uses ${tool} with: ${payload}`;
  const repeatedCommand = (command: string): string =>
    `The operator frequently runs this command in the project: ${command}`;
  const keyFiles = (files: string[]): string =>
    `Key reference files frequently accessed in rg-app:\n${files.map(f => `  - ${f}`).join('\n')}\n\nThese files are consistently accessed across sessions, suggesting they are architectural touchpoints or orientation files.`;

  const seed = async (
    content: string,
    opts: { type?: MemoryType; embedding?: Float32Array } = {},
  ): Promise<number> => {
    const { id } = await deps.memoryStore.store({
      content,
      type: opts.type ?? 'discovery',
      scope: 'project:rg',
      source: 'replay-referent-guard',
      source_path: null,
      metadata: '{}',
      embedding: opts.embedding ? wcBuf(opts.embedding) : null,
      embedding_model: opts.embedding ? 'test' : '',
      created_by: null,
      tags: [],
      confidence: 0.7,
    });
    return id;
  };

  /** Plant an ingestion contradiction flag on `flaggedId` naming `partnerId`. */
  const plantFlag = async (flaggedId: number, partnerId: number): Promise<void> => {
    const row = (await deps.memoryStore.get(flaggedId))!;
    const meta = JSON.parse(row.metadata || '{}');
    meta[CONTRADICTION_FLAG_KEY] = {
      with: partnerId, relation: 'conditional',
      rationale: 'scenario-planted ingestion flag', at: new Date().toISOString(),
    };
    await deps.memoryStore.update(flaggedId, {
      content: row.content, type: row.type, scope: row.scope,
      metadata: JSON.stringify(meta),
      tags: [...new Set([...row.tags, CONTRADICTION_FLAG_TAG])],
    });
  };

  // P1 — flagged sequence pair, DIFFERENT bigrams (the 82/91 majority class).
  const seqA = await seed(seq('Read(app.js) → Bash(node)', 2, 5, 40));
  const seqB = await seed(seq('Edit(routes.ts) → Bash(npm)', 3, 6, 50));
  await plantFlag(seqB, seqA);

  // P2 — band repeated_tool pair, different command payloads.
  const rtA = await seed(repeated('Bash', '{"command":"npm run build"}'), { embedding: wcBasis(0) });
  const rtB = await seed(repeated('Bash', '{"command":"docker compose up"}'), { embedding: wcBlend(0, 1, 0.88) });

  // P3 — band key-files pair, disjoint file lists (the R13 live-pair class).
  const kfA = await seed(keyFiles(['src/server.ts', 'src/index.ts']), { embedding: wcBasis(2) });
  const kfB = await seed(keyFiles(['viz/app.js', 'viz/index.html']), { embedding: wcBlend(2, 3, 0.90) });

  // P4 — band sequence pair, SAME bigram, counts-only difference (T28 sibling).
  const numA = await seed(seq('Read(config.ts) → Edit(config.ts)', 2, 5, 40), { embedding: wcBasis(4) });
  const numB = await seed(seq('Read(config.ts) → Edit(config.ts)', 4, 7, 57), { embedding: wcBlend(4, 5, 0.93) });

  // P5 — band repeated_command pair, different commands (round-22 defect: this
  // template previously never parsed, so referentGuard bailed for both members
  // and the reasoner read the near-identical prose wrapper as `duplicate`).
  const rcA = await seed(repeatedCommand('git diff --stat'), { embedding: wcBasis(8) });
  const rcB = await seed(repeatedCommand('cargo fmt && cargo clippy && cargo test'), { embedding: wcBlend(8, 9, 0.91) });

  // C1 — CONTROL: same bigram + substantive difference → must reach the reasoner.
  const ctlA = await seed(seq('Bash(vitest) → Bash(git)', 3, 5, 60), { embedding: wcBasis(6) });
  const ctlB = await seed(
    `${seq('Bash(vitest) → Bash(git)', 3, 5, 60)} NOTE: superseded — commits now happen before the test run.`,
    { embedding: wcBlend(6, 7, 0.88) },
  );

  // C2 — CONTROL: operator-authored list-shaped pair (type != discovery) —
  // template-parseable content, but the guard must never touch it.
  const opA = await seed('Deploy checklist:\n  - build the image\n  - run smoke tests', { type: 'project' });
  const opB = await seed('Deploy checklist:\n  - update DNS\n  - rotate keys', { type: 'project' });
  await plantFlag(opB, opA);

  // C3 — CONTROL: cross-family SAME command (repeated_tool "Bash" wrapper vs
  // repeated_command wrapper) — round-22's other required behavior: folding
  // both producers into one referent family means this is a same-referent
  // pair, so it must still reach the reasoner (a genuine duplicate claim,
  // confirmed by hand 2026-08-20) rather than being misrouted `unrelated`.
  const xfA = await seed(repeated('Bash', 'cargo test --workspace'), { embedding: wcBasis(10) });
  const xfB = await seed(repeatedCommand('cargo test --workspace'), { embedding: wcBlend(10, 11, 0.90) });

  const noiseIds = new Set([seqA, seqB, rtA, rtB, kfA, kfB, numA, numB, rcA, rcB]);

  const counter = new CountingReasoner(new NoOpReasoner());
  const result = await runDreamPass({
    dreamStore: deps.dreamStore,
    source: new DbWindowMemorySource(deps.memoryStore, { limit: 500 }),
    selector: new DuplicateCandidateSelector(),
    reasoner: counter,
    diffGen: new DeterministicDiffGenerator(),
    lock: new ConsolidationLockManager({ store: deps.dreamStore, holder: 'replay-referent-guard' }),
    tz: 'UTC',
    apply: { memoryStore: deps.memoryStore, vectorIndex: new NullVectorSearch() },
  }, { trigger: 'manual', reason: 'T31 referent-guard scenario', windowKey: 'replay-t31' });

  check('pass completed', result.status === 'completed', `got ${result.status}`);

  // The guard, not the reasoner, decided every noise pair: exactly the three
  // control pairs were classified (C1 same-referent-substantive-diff, C3
  // cross-family-same-command — both genuine same-referent claims).
  check('exactly 3 classify calls (controls only — noise pairs cost 0)',
    counter.classifyCalls === 3, `got ${counter.classifyCalls}`);
  check('zero LLM calls (NoOp)', counter.llmCalls === 0, `got ${counter.llmCalls}`);

  const dream = result.dream_id !== null ? await deps.dreamStore.getDream(result.dream_id) : null;
  const entries: DreamDiffEntry[] = dream?.output_diff ? JSON.parse(dream.output_diff).entries : [];

  const touchingNoise = entries.filter(e => e.memory_ids.some(id => noiseIds.has(id)));
  check('no diff entry touches a noise pair (the 91-entry class queues nothing)',
    touchingNoise.length === 0, JSON.stringify(touchingNoise));

  const ctlEntry = entries.find(e => e.memory_ids.length === 2 && e.memory_ids.includes(ctlA) && e.memory_ids.includes(ctlB));
  check('same-referent conflicting control still queues (Phase-1 band merge)',
    ctlEntry?.change_class === 'merge' && ctlEntry?.tier === 'reasoner-driven', JSON.stringify(ctlEntry ?? null));

  const opEntry = entries.find(e => e.memory_ids.length === 2 && e.memory_ids.includes(opA) && e.memory_ids.includes(opB));
  check('operator-authored list pair untouched by the guard (contested fallback as before)',
    opEntry?.change_class === 'contested' && opEntry?.tier === 'reasoner-driven', JSON.stringify(opEntry ?? null));

  const xfEntry = entries.find(e => e.memory_ids.length === 2 && e.memory_ids.includes(xfA) && e.memory_ids.includes(xfB));
  check('cross-family same-command control still reaches the reasoner (not misrouted unrelated)',
    xfEntry?.tier === 'reasoner-driven', JSON.stringify(xfEntry ?? null));

  check('exactly the three control entries were proposed', entries.length === 3, `got ${entries.length}`);

  // Flag lifecycle: BOTH routed flagged pairs retire their flags via the
  // existing consume path — unrelated (guard) and contested (fallback) alike.
  for (const [label, id] of [['noise sequence pair', seqB], ['operator pair', opB]] as const) {
    const row = await deps.memoryStore.get(id);
    const flagGone = !!row
      && !row.tags.includes(CONTRADICTION_FLAG_TAG)
      && !(CONTRADICTION_FLAG_KEY in JSON.parse(row.metadata || '{}'));
    check(`${label}: stale ingestion flag retired`, flagGone, `tags=${JSON.stringify(row?.tags)}`);
  }

  // Nothing was archived — the guard only suppresses proposals, never mutates.
  for (const id of [...noiseIds, ctlA, ctlB, opA, opB, xfA, xfB]) {
    const row = await deps.memoryStore.get(id);
    check(`memory #${id} still active`, row !== null && !row.is_archived);
  }

  return { name: 't31-referent-guard', ok: failures.length === 0, failures };
}

// ── Phase 2 reversibility scenario ──

/**
 * The synthetic alias-variant scope pair shared by the reversibility scenario
 * and the Phase-5 alias fixtures (`tests/fixtures/dreaming/corpus.ts`). One
 * definition so the two harness fixtures for "a casing variant of one client
 * scope" cannot drift apart. Names are synthetic (fixture-hygiene rule) and
 * mirror the T46 doc example.
 */
export const SYNTHETIC_ALIAS_SCOPE_RAW = 'client:Acme-Foods';
export const SYNTHETIC_ALIAS_SCOPE_CANONICAL = 'client:acme-foods';

/**
 * Phase 2 zero-LLM gate: the reversibility invariants exercised end-to-end
 * against the same harness deps shape every other replay scenario uses (no
 * raw db handle, no LLM — deterministic via injected clocks, mirroring the
 * unit coverage in `tests/unit/reversibility.test.ts` / `dream-apply.test.ts`).
 *
 *   1. G1/G2 rescue loop: a 0.6-confidence project memory has its `last_seen`
 *      genuinely backdated ~400 days via `IDreamStore.reinforceMemory(id, at)`
 *      (the store's own clock-control hook — no raw db handle needed, same
 *      effect as the unit test's raw-SQL `datetime('now','-400 days')`).
 *      `autoArchiveDecayed` (real wall-clock `now`, no override) archives it;
 *      `rollbackMemory` restores the pre-archive snapshot — which is STILL
 *      400-days-ancient — and its built-in rescue reinforce
 *      (`reinforceMemory`, unconditionally real-wall-clock) is what refreshes
 *      `last_seen` back to genuinely now. A second archive pass at real wall
 *      time finds nothing to archive only because that rescue ran: comment it
 *      out in `rollbackMemory` and this sub-check re-archives, proving the
 *      gate is load-bearing (see Task 7 report for the RED run). G2 asserts
 *      exactly one audited `rollback` row lands on the carrier dream the
 *      first pass created.
 *   2. G3: a `merge` entry whose keep target was archived out-of-band after
 *      the diff was generated must be refused (`not_actionable`) rather than
 *      archive its sibling toward a dead target — stale-diff defense, not
 *      data loss.
 *   3. Canonical survivor: an `exact_dup` pair split across an alias/canonical
 *      scope pair (same normalized content, different scope) swaps keep and
 *      archive so the CANONICAL-scoped row survives when `canonicalizeScope`
 *      is supplied.
 */
export async function runReversibilityScenario(deps: {
  memoryStore: IMemoryStore;
  dreamStore: IDreamStore;
}): Promise<ScenarioResult> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = ''): void => {
    if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
  };

  const applyDeps: ApplyDeps = {
    memoryStore: deps.memoryStore,
    dreamStore: deps.dreamStore,
    vectorIndex: new NullVectorSearch(),
  };

  const seed = async (content: string, scope = 'global', confidence = 0.7): Promise<number> => {
    const { id } = await deps.memoryStore.store({
      content, type: 'project', scope, source: 'replay-reversibility',
      source_path: null, metadata: '{}', embedding: null, embedding_model: '',
      created_by: null, tags: [], confidence,
    });
    return id;
  };

  // ── G1/G2: rescue loop ──
  {
    const id = await seed('replay reversibility: ancient but deliberately rescued', 'global', 0.6);
    // Genuinely backdate last_seen — the effect a rollback-restored snapshot
    // must actually be seen to have, distinct from just inflating the clock
    // `autoArchiveDecayed` scores against.
    await deps.dreamStore.reinforceMemory(id, new Date(Date.now() - 400 * DAY_MS).toISOString());

    const first = await autoArchiveDecayed(applyDeps, 0.1, false);
    check('G1: decay pass archives the genuinely-aged memory', first.archived.includes(id), `archived=${JSON.stringify(first.archived)}`);
    check('G1: memory is archived after the first pass', (await deps.memoryStore.get(id))?.is_archived === 1);

    const rb = await rollbackMemory(applyDeps, id);
    check('G1: rollback succeeds', rb !== null);
    check('G1: memory is active again after rollback', (await deps.memoryStore.get(id))?.is_archived === 0);

    check('G2: exactly one audited rollback row on the carrier dream',
      first.dream_id !== undefined
        && (await deps.dreamStore.listAuditForDream(first.dream_id)).filter(a => a.change_class === 'rollback').length === 1,
      `dream_id=${first.dream_id}`);

    // Real wall-clock now (no override): the rescue reinforce set last_seen to
    // genuinely now, so this must find nothing — the rescue holds.
    const second = await autoArchiveDecayed(applyDeps, 0.1, false);
    check('G1: the rescue holds — a real-time re-run archives nothing', !second.archived.includes(id), `archived=${JSON.stringify(second.archived)}`);
    check('G1: memory stays active after the rescue re-run', (await deps.memoryStore.get(id))?.is_archived === 0);
  }

  // ── G3: stale keep-target refusal ──
  {
    const a = await seed('replay reversibility: keep-target A');
    const b = await seed('replay reversibility: sibling B');
    const dream = await deps.dreamStore.createDream({ window_key: 'replay-reversibility-g3' });
    const entry: DreamDiffEntry = {
      change_class: 'merge', tier: 'reasoner-driven', memory_ids: [a, b],
      rationale: 'replay reversibility: stale keep-target scenario',
      after: { keep_id: a, archive_ids: [b] },
    };
    await deps.memoryStore.archive(a); // out-of-band archive of the keep target, after the diff was crafted

    const result = await applyEntry(applyDeps, dream.id, 0, entry, false);
    check('G3: applyEntry refuses a stale (archived) keep target', result.outcome === 'not_actionable', `outcome=${result.outcome}`);
    const bRow = await deps.memoryStore.get(b);
    check('G3: sibling B stays active (no data loss)', bRow !== null && !bRow.is_archived);
  }

  // ── Canonical survivor: exact_dup swap across an alias/canonical scope pair ──
  {
    const a = await seed('npm test runs the suite', SYNTHETIC_ALIAS_SCOPE_RAW, 0.8);
    const b = await seed('NPM  test runs the suite', SYNTHETIC_ALIAS_SCOPE_CANONICAL, 0.6);
    const dream = await deps.dreamStore.createDream({ window_key: 'replay-reversibility-canon' });
    const entry: DreamDiffEntry = {
      change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [a, b],
      rationale: 'replay reversibility: exact dup across an alias/canonical scope pair',
      after: { keep_id: a, archive_ids: [b] },
    };
    const canonicalDeps: ApplyDeps = {
      ...applyDeps,
      canonicalizeScope: async (s: string) => (s === SYNTHETIC_ALIAS_SCOPE_RAW ? SYNTHETIC_ALIAS_SCOPE_CANONICAL : s),
    };

    const result = await applyEntry(canonicalDeps, dream.id, 0, entry, false);
    check('canonical survivor: entry applies', result.outcome === 'applied', `outcome=${result.outcome}`);
    check('canonical survivor: alias-scoped A archived', (await deps.memoryStore.get(a))?.is_archived === 1);
    check('canonical survivor: canonical-scoped B survives', (await deps.memoryStore.get(b))?.is_archived === 0);
  }

  return { name: 'phase2-reversibility', ok: failures.length === 0, failures };
}
