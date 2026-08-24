/**
 * Dream engine (D0.6) — the empty-diff runner that ties the pipeline (D0.3) to the
 * `dreams` table under the consolidation lock (D0.4). Phase 0 emits an EMPTY diff;
 * Phase 1.2 swaps in real candidate detection + a real diff generator behind the
 * same call. Both the scheduler fire path (D0.5) and the manual trigger endpoint
 * call `runDreamPass`, so scheduled and manual passes are identical except trigger.
 *
 * Guarantees:
 *  - Writes happen INSIDE the consolidation lock; if the lock is held elsewhere the
 *    pass is `skipped` (no row written).
 *  - Idempotent per window: a non-failed dream already recorded for (operator,
 *    scope, mode, window_key) `collapsed`s instead of inserting a duplicate. A
 *    FAILED dream does not collapse the window (R2) — it is retried, bounded by
 *    MAX_WINDOW_RETRIES. The under-lock pre-check covers the NULL-scope case the
 *    partial UNIQUE index can't.
 *  - Dry-run computes + logs and writes NOTHING (no lock, no row).
 *  - window_key defaults to the operator-LOCAL day (same tz the fire predicate uses),
 *    so the scheduler's "already ran today" and the engine's collapse agree. D1.4:
 *    a rotating source appends its cursor (`<day>#a<cursor>`) so collapse is
 *    per-segment; the scheduler's daily gate is unaffected (it keys on started_at).
 */
import type { IMemoryStore, IDreamStore, IOperatorConfigStore, IVectorSearch } from '../database/interfaces.js';
import type { DreamTrigger, DreamMode, DreamStatus, DreamAcceptance, Memory } from '../types/types.js';
import {
  runPipeline, type MemorySource, type CandidateSelector, type DiffGenerator, type PipelineLimits,
  type CandidateGroup,
} from './pipeline.js';
import { autoApplyDiff, computeAcceptance } from './apply.js';
import { CONTRADICTION_FLAG_TAG, readContradictionFlag, consumeContradictionFlags } from './contradiction.js';
import type { ConsolidationReasoner, ReasonerContext, CandidateMemory } from './reasoner/reasoner.js';
import type { IConsolidationLock } from './lock.js';
import { localPartsInTz } from './fire-predicate.js';
import logger from '../utils/logger.js';

export interface DreamEngineDeps {
  dreamStore: IDreamStore;
  source: MemorySource;
  selector: CandidateSelector;
  reasoner: ConsolidationReasoner;
  diffGen: DiffGenerator;
  /**
   * The engine's own acquisition (manual triggers, standalone fires). The nightly
   * supervisor chain passes `heldLockPassthrough` instead — it already holds the lock.
   */
  lock: IConsolidationLock;
  /** Optional: resolves the operator tz for window_key (matches the fire predicate). */
  configStore?: IOperatorConfigStore;
  operatorId?: string;
  scope?: string | null;
  mode?: DreamMode;
  /** Fallback tz when no operator_config timezone is set. */
  tz?: string;
  /** Injectable epoch-ms clock for deterministic tests. */
  now?: () => number;
  reasonerTimeoutMs?: number;
  /** R4: total pass budget, enforced by the pipeline. Default DEFAULT_PASS_BUDGET_MS. */
  passBudgetMs?: number;
  /**
   * D1.3: enables the auto-apply step (deterministic-safe entries gated by
   * operator_config.auto_accept_*, which ship OFF). Absent → generation-only,
   * exactly the pre-D1.3 behavior (replay harness, tests). embedText (D2.2)
   * passes through to ApplyDeps for conditional encodings — auto-apply never
   * reaches them (reasoner-driven), but the deps shape stays uniform.
   */
  apply?: {
    memoryStore: IMemoryStore;
    vectorIndex: IVectorSearch;
    embedText?: (text: string) => Promise<{ vector: Float32Array; model: string }>;
    /**
     * Team-review #22 r2 NEW-1: without this, the canonical-survivor preference
     * (ApplyDeps.canonicalizeScope) never ran on the AUTO-APPLY path — the one
     * unattended path where exact_dup can apply. Same wiring expression as the
     * operator-resolve path in routes.ts.
     */
    canonicalizeScope?: (scope: string) => Promise<string>;
  };
}

export interface RunDreamOptions {
  trigger: DreamTrigger;
  reason?: string;
  dryRun?: boolean;
  /** Override the auto-derived (local-day) window key. */
  windowKey?: string;
  /**
   * T6: which pass to run. `'whole_corpus'` swaps the rotating window for the
   * `WholeCorpusMemorySource` (every active id, id-segment reasoner gate) — the
   * manual activation path (T17). Defaults to the nightly rotating window.
   */
  mode?: DreamMode;
}

export type DreamRunStatus = 'completed' | 'collapsed' | 'skipped' | 'dry_run';

/**
 * Statuses that collapse a window (R2): 'completed' means consolidation already
 * happened; 'running' means a pass is mid-flight (or a crashed pass left its row —
 * either way, don't start a duplicate). 'failed' is deliberately ABSENT: one
 * transient 2am error must not block consolidation for the rest of the local day —
 * failed windows are retried, bounded by MAX_WINDOW_RETRIES.
 */
const COLLAPSING_STATUSES: ReadonlySet<DreamStatus> = new Set(['completed', 'running']);

/**
 * A failed window is retried at most this many times (so 1 + MAX_WINDOW_RETRIES
 * attempts total). Spacing comes from the caller: each retry needs a fresh
 * scheduler tick (or manual trigger), so retries are at least one scheduler
 * interval apart.
 */
export const MAX_WINDOW_RETRIES = 2;

/**
 * R4: hard pass deadline, comfortably under the 10-min lock TTL. The heartbeat
 * keeps the lock alive while a pass runs; this budget keeps the pass itself
 * bounded — a wedged reasoner marks the dream `failed` instead of running forever.
 */
export const DEFAULT_PASS_BUDGET_MS = 8 * 60 * 1000;

export interface DreamRunResult {
  status: DreamRunStatus;
  dream_id: number | null;
  window_key: string;
  memories_examined: number;
  changes_proposed: number;
  duration_ms: number;
}

export async function runDreamPass(deps: DreamEngineDeps, opts: RunDreamOptions): Promise<DreamRunResult> {
  const now = deps.now ?? Date.now;
  const operatorId = deps.operatorId ?? 'default';
  const scope = deps.scope ?? null;
  const mode: DreamMode = deps.mode ?? 'windowed';
  const start = now();

  // Resolve window_key from the operator-local day (same tz source as the predicate).
  // D1.4: a rotating source appends its cursor (`#a<cursor>`) so each segment gets
  // its own window — R2 collapse stays per-segment and a completed segment doesn't
  // block the next one on the same local day.
  const resolveWindowKey = async (): Promise<string> => {
    // T6: whole-corpus passes key on the ISO week (`<isoWeek>#whole`) so a weekly
    // pass is idempotent per-scope; the id-segment cursor is appended (`#a<cursor>`)
    // — exactly like the rotating window — so successive same-week passes drain
    // disjoint reasoner segments instead of collapsing on the base week key.
    if (isWholeCorpusSource(deps.source)) {
      return `${isoWeekKey(now())}#whole#a${await deps.source.currentCursor()}`;
    }
    let tz = deps.tz ?? 'UTC';
    if (deps.configStore) {
      const cfg = await deps.configStore.getConfig(operatorId).catch(() => null);
      if (cfg?.timezone) tz = cfg.timezone;
    }
    const day = localPartsInTz(now(), tz).day;
    if (isRotatingSource(deps.source)) {
      return `${day}#a${await deps.source.currentCursor()}`;
    }
    return day;
  };
  let windowKey = opts.windowKey ?? await resolveWindowKey();

  const ctx: ReasonerContext = { timeoutMs: deps.reasonerTimeoutMs ?? 30_000 };
  const limits: PipelineLimits = { passBudgetMs: deps.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS, now };
  // T6: a whole-corpus source supplies the id-segment reasoner gate — only band/
  // flagged/gate-demoted pairs anchored in the current segment are classified.
  // The deterministic tier (the whole selector) is unaffected (runs every pass).
  if (isWholeCorpusSource(deps.source)) {
    limits.reasonerGate = await deps.source.reasonerGate();
  }

  // Dry-run: compute + log, write nothing. Read-only, so no lock needed.
  if (opts.dryRun) {
    const r = await runPipeline(deps.source, deps.selector, deps.reasoner, deps.diffGen, ctx, limits);
    logger.info(`Dream dry-run (${opts.trigger}): examined ${r.memoriesExamined}, ${r.diff.entries.length} proposed change(s) — nothing written`);
    return {
      status: 'dry_run', dream_id: null, window_key: windowKey,
      memories_examined: r.memoriesExamined, changes_proposed: r.diff.entries.length,
      duration_ms: now() - start,
    };
  }

  const { acquired, result } = await deps.lock.withLock(async (): Promise<DreamRunResult> => {
    // D1.4: re-resolve a derived key under the lock — another pass may have
    // committed the rotation cursor between our provisional read and acquisition.
    if (!opts.windowKey) windowKey = await resolveWindowKey();

    // Idempotency (R2): collapse only on a non-failed dream for this window; a
    // failed dream leaves the window retryable until the retry budget is spent.
    const prior = await deps.dreamStore.listDreamsByWindow(operatorId, scope, mode, windowKey!);
    const collapsing = prior.find(d => COLLAPSING_STATUSES.has(d.status));
    if (collapsing) {
      logger.info(`Dream window ${windowKey} already recorded (id=${collapsing.id}, status=${collapsing.status}) — collapsed`);
      return {
        status: 'collapsed', dream_id: collapsing.id, window_key: windowKey!,
        memories_examined: 0, changes_proposed: 0, duration_ms: now() - start,
      };
    }
    const failedAttempts = prior.filter(d => d.status === 'failed').length;
    if (failedAttempts > MAX_WINDOW_RETRIES) {
      logger.warn(`Dream window ${windowKey} retry budget exhausted (${failedAttempts} failed attempts) — collapsed`);
      return {
        status: 'collapsed', dream_id: prior[0]?.id ?? null, window_key: windowKey!,
        memories_examined: 0, changes_proposed: 0, duration_ms: now() - start,
      };
    }

    const dream = await deps.dreamStore.createDream({
      operator_id: operatorId, scope, mode,
      trigger_source: opts.trigger, reason: opts.reason ?? null, window_key: windowKey!,
    });

    try {
      const r = await runPipeline(deps.source, deps.selector, deps.reasoner, deps.diffGen, ctx, limits);
      await deps.dreamStore.setDreamDiff(dream.id, r.diff);

      // D2.2: ingestion flags this pass CLASSIFIED are consumed now (inside the
      // lock, after the diff is stored) — the queued entry carries the pair from
      // here; without consumption every later pass would re-queue it. Consumption
      // reads classifiedCandidates, NOT candidates (pre-T17 fix): a flagged pair
      // the T6 reasonerGate dropped produced no entry, so its flag must survive
      // for the pass whose segment classifies it. Apply-less deployments
      // (replay, tests) have no memoryStore and skip this.
      if (deps.apply) {
        const consumed = await consumeContradictionFlags(deps.apply.memoryStore, r.classifiedCandidates);
        if (consumed > 0) logger.info(`Dream ${dream.id}: consumed ${consumed} contradiction flag(s)`);
      }

      // D1.3 auto-apply: deterministic-safe entries whose operator flag is ON
      // apply here, INSIDE the lock hold — snapshot → archive → audit per memory.
      // Per-entry failures leave that entry pending; the dream still completes.
      const entries = r.diff.entries;
      let autoApplied = 0;
      let acceptance: DreamAcceptance = entries.length === 0 ? 'empty' : 'pending';
      if (deps.apply && entries.length > 0) {
        const cfg = deps.configStore ? await deps.configStore.getConfig(operatorId).catch(() => null) : null;
        const applyResult = await autoApplyDiff(
          { ...deps.apply, dreamStore: deps.dreamStore },
          dream.id, entries, cfg, new Date(now()).toISOString(),
        );
        autoApplied = applyResult.applied;
        // Persist UNCONDITIONALLY after an apply attempt (team-review #22 A1):
        // applyEntry mutates entries in place even when nothing fully applies —
        // a canonical-survivor swap followed by an anchored refusal leaves
        // autoApplied at 0 with the entry's keep/archive already swapped. Gating
        // on autoApplied > 0 discarded that mutation, so the stored diff named
        // the archived row as survivor (the "lying diff").
        await deps.dreamStore.setDreamDiff(dream.id, { entries });
        acceptance = computeAcceptance(entries);
      }

      await deps.dreamStore.updateDream(dream.id, {
        status: 'completed',
        acceptance_status: acceptance,
        completed_at: new Date(now()).toISOString(),
        duration_ms: now() - start,
        memories_examined: r.memoriesExamined,
        changes_auto_applied: autoApplied,
        changes_queued: entries.length - autoApplied,
      });
      logger.info(`Dream ${dream.id} completed (${opts.trigger}, window ${windowKey}): examined ${r.memoriesExamined}, ${entries.length === 0 ? 'empty diff' : `${autoApplied} auto-applied, ${entries.length - autoApplied} queued`}`);

      // D1.4: advance the rotation cursor ONLY on completion — a failed pass
      // retries the same segment. A commit failure is degraded-but-safe: the
      // next pass re-covers this segment under a later day's key.
      if (isRotatingSource(deps.source)) {
        try {
          await deps.source.commit();
        } catch (err) {
          logger.error(`Dream ${dream.id}: failed to persist rotation cursor — next pass re-covers this segment:`, err);
        }
      }
      return {
        status: 'completed', dream_id: dream.id, window_key: windowKey!,
        memories_examined: r.memoriesExamined, changes_proposed: r.diff.entries.length,
        duration_ms: now() - start,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`Dream ${dream.id} failed:`, err);
      await deps.dreamStore.updateDream(dream.id, {
        status: 'failed', error,
        completed_at: new Date(now()).toISOString(), duration_ms: now() - start,
      }).catch(() => { /* best-effort; never mask the original error */ });
      throw err;
    }
  });

  if (!acquired) {
    logger.debug(`Dream pass skipped: consolidation lock held elsewhere (window ${windowKey})`);
    return {
      status: 'skipped', dream_id: null, window_key: windowKey,
      memories_examined: 0, changes_proposed: 0, duration_ms: now() - start,
    };
  }
  return result as DreamRunResult;
}

/** Memory row → pipeline candidate (shared by the window sources). */
function toCandidate(m: Memory & { tags: string[] }): CandidateMemory {
  return {
    id: m.id,
    content: m.content,
    content_hash: m.content_hash,
    summary: m.summary,
    tags: m.tags,
    scope: m.scope,
    type: m.type,
    confidence: m.confidence,
    is_locked: m.is_locked === 1,
    created_at: m.created_at,
    updated_at: m.updated_at,
    embedding: m.embedding
      ? new Float32Array(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength / 4)
      : null,
    metadata: m.metadata,
    last_seen: m.last_seen,
    observation_count: m.observation_count,
    deprecated_at: m.deprecated_at,
    last_contradicted: m.last_contradicted,
  };
}

/**
 * DB-backed window source: a bounded slice of recent active memories.
 *
 * D1.2: surfaces the REAL `is_locked` column (Hard Anchor — the D0.6 carry-over),
 * plus the embedding (cosine detection), metadata (evidence gates), and the
 * D1.1 usage columns (decay scoring).
 */
export class DbWindowMemorySource implements MemorySource {
  constructor(
    private readonly queries: IMemoryStore,
    private readonly opts: { scope?: string; limit?: number } = {},
  ) {}

  async fetch(): Promise<CandidateMemory[]> {
    const { memories } = await this.queries.list({
      scope: this.opts.scope,
      limit: this.opts.limit ?? 500,
      include_archived: false,
    });
    return memories.map(toCandidate);
  }
}

// ── D1.4: rotating window ──

/**
 * A MemorySource with a persisted rotation cursor. The engine derives the
 * window key from `currentCursor()` and calls `commit()` only after the dream
 * completes — a failed pass leaves the cursor alone so the R2 retry re-covers
 * the SAME segment.
 */
export interface RotatingMemorySource extends MemorySource {
  currentCursor(): Promise<number>;
  commit(): Promise<void>;
}

export function isRotatingSource(s: MemorySource): s is RotatingMemorySource {
  const r = s as RotatingMemorySource;
  return typeof r.currentCursor === 'function' && typeof r.commit === 'function';
}

/** Shape of the cursor blob inside `operator_config.config` (keyed by scope, `*` = unscoped). */
const CURSOR_CONFIG_KEY = 'dream_window_cursor';

/**
 * D1.4 rotating window source. Replaces the newest-500-by-id window (which never
 * revisited older memories, so scheduled dreams emitted empty diffs forever — the
 * D1.2 finding): each pass takes the next `limit` active memories in ascending id
 * order after the persisted cursor, wrap-filling from the bottom of the id space
 * when it hits the top, so consecutive completed passes cover disjoint segments
 * and the whole corpus is revisited every ceil(N/limit) passes.
 *
 * The cursor lives in `operator_config.config` under `dream_window_cursor`,
 * keyed by scope. It advances ONLY via `commit()` (called by the engine on
 * dream completion); fetch records the would-be next cursor without persisting.
 *
 * Known limit (documented, accepted for D1.4): a dup pair split across two
 * segments is not co-windowed in one cycle. Because segment boundaries drift
 * whenever corpus size isn't a multiple of `limit`, straddling pairs are
 * usually co-windowed in a later cycle; the deferred whole-corpus mode is the
 * complete answer.
 */
export class RotatingWindowMemorySource implements RotatingMemorySource {
  private pendingCursor: number | null = null;

  constructor(
    private readonly queries: IMemoryStore,
    private readonly configStore: IOperatorConfigStore,
    private readonly opts: { operatorId?: string; scope?: string; limit?: number } = {},
  ) {}

  private get scopeKey(): string {
    return this.opts.scope ?? '*';
  }

  private async readCursorBlob(): Promise<Record<string, unknown>> {
    const cfg = await this.configStore.getConfig(this.opts.operatorId ?? 'default');
    try {
      const parsed = JSON.parse(cfg?.config ?? '{}');
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {}; // corrupt config JSON: start the rotation over rather than fail the pass
    }
  }

  async currentCursor(): Promise<number> {
    const blob = await this.readCursorBlob();
    const cursors = blob[CURSOR_CONFIG_KEY] as Record<string, unknown> | undefined;
    const value = cursors?.[this.scopeKey];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  async fetch(): Promise<CandidateMemory[]> {
    const cursor = await this.currentCursor();
    const limit = this.opts.limit ?? 500;
    const primary = await this.queries.listByIdRange({
      after_id: cursor, limit, scope: this.opts.scope,
    });
    let rows = primary;
    if (primary.length < limit && cursor > 0) {
      // Hit the top of the id space: wrap-fill from the bottom, bounded at the
      // cursor so the wrapped slice can never overlap the tail.
      const wrap = await this.queries.listByIdRange({
        after_id: 0, max_id: cursor, limit: limit - primary.length, scope: this.opts.scope,
      });
      rows = [...primary, ...wrap];
    }
    this.pendingCursor = rows.length > 0 ? rows[rows.length - 1].id : 0;
    return rows.map(toCandidate);
  }

  async commit(): Promise<void> {
    if (this.pendingCursor === null) return;
    const operatorId = this.opts.operatorId ?? 'default';
    const blob = await this.readCursorBlob();
    const cursors = (blob[CURSOR_CONFIG_KEY] ?? {}) as Record<string, unknown>;
    cursors[this.scopeKey] = this.pendingCursor;
    blob[CURSOR_CONFIG_KEY] = cursors;
    await this.configStore.updateConfig(operatorId, { config: JSON.stringify(blob) });
    this.pendingCursor = null;
  }
}

// ── T6: whole-corpus source ──

/**
 * A whole-corpus MemorySource. Like `RotatingMemorySource` it carries a persisted
 * cursor + `commit()`, but the cursor here is the REASONER id-segment cursor, not
 * a fetch window: `fetch()` returns the WHOLE active corpus for the scope (so the
 * cheap deterministic tier scans everything every pass), while `reasonerGate()`
 * builds the predicate that throttles the slow reasoner tier to band/flagged pairs
 * anchored in `[cursor, cursor+segment)`. The cursor advances by `segment` on
 * `commit()` (engine calls it only on completion), wrap-filling from the bottom.
 */
export interface WholeCorpusSource extends RotatingMemorySource {
  /** The id-segment reasoner gate for THIS pass (snapshot of cursor+segment+maxId). */
  reasonerGate(): Promise<(group: CandidateGroup) => boolean>;
}

export function isWholeCorpusSource(s: MemorySource): s is WholeCorpusSource {
  const w = s as WholeCorpusSource;
  return typeof w.currentCursor === 'function'
    && typeof w.commit === 'function'
    && typeof w.reasonerGate === 'function';
}

/** ISO-8601 week key `YYYY-Www` (UTC) — the whole-corpus window base. */
export function isoWeekKey(epochMs: number): string {
  // Copy to a UTC date, shift to the Thursday of the current ISO week, then the
  // week number is the count of weeks since the year's first Thursday.
  const d = new Date(epochMs);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7; // Mon=1..Sun=7
  utc.setUTCDate(utc.getUTCDate() + 4 - day); // move to Thursday
  const isoYear = utc.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((utc.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Config blob keys (in `operator_config.config`, keyed by scope; `*` = unscoped). */
const WHOLE_CORPUS_CURSOR_KEY = 'dream_whole_corpus_cursor';
const WHOLE_CORPUS_SEGMENT_KEY = 'dream_whole_corpus_segment';
/** Default id-segment width (≈ one review sitting, well under the ~150-call budget rail). */
export const DEFAULT_WHOLE_CORPUS_SEGMENT = 60;
/**
 * Backstop: log a shard warning if a scope's eligible set exceeds this — the
 * existing pairwise selector is seconds well past this, but a silent O(n²) at
 * >10k-in-one-scope should announce itself (plan T6.2).
 */
export const WHOLE_CORPUS_SHARD_THRESHOLD = 10_000;

/**
 * T6 whole-corpus source. `fetch()` pages `listByIdRange` over the FULL id space
 * (active only, scope-filtered) and returns everything — so a planted dup pair
 * Δ≈2000 ids apart (invisible to the rotating window's contiguous mid-corpus
 * windows; only a wrap-seam-straddling pair could ever co-window there) is
 * co-windowed here and surfaces. The deterministic selector tiers then run over
 * the whole set.
 *
 * The persisted cursor (`dream_whole_corpus_cursor[scope]`) and segment dial
 * (`dream_whole_corpus_segment`, default 60) bound only the REASONER tier:
 * `reasonerGate()` returns a predicate keeping band/flagged pairs whose anchor
 * `min(a.id,b.id)` falls in `[cursor, cursor+segment)`. The cursor advances by
 * `segment` on `commit()` (engine: only on completion), wrap-filling to 0 once it
 * passes the max active id — so successive passes drain disjoint segments and a
 * still-pending pair is never re-classified until the cursor wraps.
 */
export class WholeCorpusMemorySource implements WholeCorpusSource {
  private pendingCursor: number | null = null;
  private maxActiveId = 0;

  constructor(
    private readonly queries: IMemoryStore,
    private readonly configStore: IOperatorConfigStore,
    private readonly opts: { operatorId?: string; scope?: string; pageSize?: number } = {},
  ) {}

  private get scopeKey(): string {
    return this.opts.scope ?? '*';
  }

  private async readBlob(): Promise<Record<string, unknown>> {
    const cfg = await this.configStore.getConfig(this.opts.operatorId ?? 'default');
    try {
      const parsed = JSON.parse(cfg?.config ?? '{}');
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  async currentCursor(): Promise<number> {
    const blob = await this.readBlob();
    const cursors = blob[WHOLE_CORPUS_CURSOR_KEY] as Record<string, unknown> | undefined;
    const value = cursors?.[this.scopeKey];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private async readSegment(): Promise<number> {
    const blob = await this.readBlob();
    const value = blob[WHOLE_CORPUS_SEGMENT_KEY];
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : DEFAULT_WHOLE_CORPUS_SEGMENT;
  }

  async fetch(): Promise<CandidateMemory[]> {
    const pageSize = this.opts.pageSize ?? 1000;
    const rows: (Memory & { tags: string[] })[] = [];
    let after = 0;
    for (;;) {
      const page = await this.queries.listByIdRange({
        after_id: after, limit: pageSize, scope: this.opts.scope,
      });
      if (page.length === 0) break;
      rows.push(...page);
      after = page[page.length - 1].id;
      if (page.length < pageSize) break;
    }
    this.maxActiveId = rows.length > 0 ? rows[rows.length - 1].id : 0;
    if (rows.length > WHOLE_CORPUS_SHARD_THRESHOLD) {
      logger.warn(`WholeCorpusMemorySource: ${rows.length} eligible memories in scope ${this.scopeKey} exceeds the ${WHOLE_CORPUS_SHARD_THRESHOLD} pairwise backstop — consider sharding the scope (selector is still O(n²) per scope).`);
    }
    return rows.map(toCandidate);
  }

  async reasonerGate(): Promise<(group: CandidateGroup) => boolean> {
    const cursor = await this.currentCursor();
    const segment = await this.readSegment();
    const end = cursor + segment;
    // Advance the cursor by the segment width on the NEXT commit, wrap-filling to
    // 0 once we've covered past the max active id. fetch() runs before commit, so
    // maxActiveId is set by the time the engine commits.
    this.pendingCursor = end;
    return (group: CandidateGroup): boolean => {
      if (group.members.length < 2) return false;
      const anchor = Math.min(...group.members.map(m => m.id));
      return anchor >= cursor && anchor < end;
    };
  }

  async commit(): Promise<void> {
    if (this.pendingCursor === null) return;
    // Wrap-fill from the bottom once the segment window passes the corpus top, so
    // the cursor never runs off to infinity and the next cycle re-covers low ids.
    const next = this.maxActiveId > 0 && this.pendingCursor > this.maxActiveId ? 0 : this.pendingCursor;
    const operatorId = this.opts.operatorId ?? 'default';
    const blob = await this.readBlob();
    const cursors = (blob[WHOLE_CORPUS_CURSOR_KEY] ?? {}) as Record<string, unknown>;
    cursors[this.scopeKey] = next;
    blob[WHOLE_CORPUS_CURSOR_KEY] = cursors;
    await this.configStore.updateConfig(operatorId, { config: JSON.stringify(blob) });
    this.pendingCursor = null;
  }
}

// ── D2.2: flagged-pair window augmentation ──

/**
 * Wrap a MemorySource so every fetch also includes ingestion-flagged
 * contradiction pairs (tag `contradiction-flagged`) AND their partners,
 * regardless of where rotation currently points. Without this, a flagged pair
 * whose ids sit far apart is co-windowed never (the R12 rotation limit) — the
 * flag exists precisely so the next pass examines the pair.
 *
 * Bounded: at most `limit` (default 50) flagged memories per pass — leftovers
 * keep their flag and ride the next pass. Rotation cursors pass through
 * untouched (the wrapper preserves currentCursor/commit on rotating sources).
 * Augmentation failures degrade to the plain window, never fail the pass.
 */
export function withFlaggedPairs(
  inner: MemorySource,
  queries: IMemoryStore,
  opts: { limit?: number } = {},
): MemorySource {
  const fetch = async (): Promise<CandidateMemory[]> => {
    const window = await inner.fetch();
    try {
      const { memories: flagged } = await queries.list({
        tags: [CONTRADICTION_FLAG_TAG],
        limit: opts.limit ?? 50,
        include_archived: false,
      });
      if (flagged.length === 0) return window;

      const have = new Set(window.map(m => m.id));
      const extras: CandidateMemory[] = [];
      for (const m of flagged) {
        const flag = readContradictionFlag(m.metadata);
        if (!flag) continue;
        if (!have.has(m.id)) {
          extras.push(toCandidate(m));
          have.add(m.id);
        }
        if (!have.has(flag.with)) {
          const partner = await queries.get(flag.with).catch(() => null);
          if (partner && !partner.is_archived) {
            extras.push(toCandidate(partner));
            have.add(partner.id);
          }
        }
      }
      return extras.length > 0 ? [...window, ...extras] : window;
    } catch (err) {
      logger.warn('withFlaggedPairs: augmentation failed — using the plain window:', err);
      return window;
    }
  };

  if (isRotatingSource(inner)) {
    const rotating: RotatingMemorySource = {
      fetch,
      currentCursor: () => inner.currentCursor(),
      commit: () => inner.commit(),
    };
    return rotating;
  }
  return { fetch };
}
