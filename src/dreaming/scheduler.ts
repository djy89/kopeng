/**
 * Dream scheduler (D0.5) — mirrors DiscoveryScheduler's lifecycle (interval timer,
 * unref, isRunning guard, start/stop, triggerNow) but its trigger logic is the pure
 * `shouldDreamFire` predicate fed from the operator config + activity tracker +
 * last-dream day. It owns the clock and the I/O; the predicate owns the decision.
 *
 * The fire ACTION is injected (`runDream`) so the scheduler stays decoupled from
 * the dream engine (D0.6, now wired). On a scheduled fire it calls runDream with the
 * predicate's reason; `triggerNow()` runs a manual pass that bypasses the predicate.
 * The action can also be a logged stub (as in tests) — the firing itself (the D0.5
 * deliverable) is fully exercised either way.
 */
import type { IDreamStore, IOperatorConfigStore, IObservationStore } from '../database/interfaces.js';
import type { DreamTrigger, DreamMode, OperatorConfig } from '../types/types.js';
import { shouldDreamFire, localPartsInTz } from './fire-predicate.js';
import type { ActivityTracker } from './activity-tracker.js';
import logger from '../utils/logger.js';

/** Fallbacks used when the operator_config row is unseeded or has null fields. */
export interface DreamSchedulerDefaults {
  tz: string;
  idleMinutes: number;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

export interface DreamSchedulerDeps {
  dreamStore: IDreamStore;
  configStore: IOperatorConfigStore;
  activity: ActivityTracker;
  /**
   * R3: durable activity floor. When present, the idle signal is the NEWER of the
   * in-process activity stamp and MAX(observations.started_at) — so a service
   * restart (which wipes the tracker) can't make a just-active operator look idle.
   * Absent when observation ingestion is off; behavior is then tracker-only.
   */
  observationStore?: IObservationStore;
  /**
   * The fire action. D0.6 supplies the dream engine; until then a logged stub.
   * T6.3: `mode` is passed ONLY for a scheduled whole-corpus sweep — absent
   * means the default windowed/nightly pass (keeps the original contract).
   */
  runDream: (trigger: DreamTrigger, reason: string, mode?: DreamMode) => Promise<void>;
  intervalMs: number;
  defaults: DreamSchedulerDefaults;
  operatorId?: string;
  /** Scope/mode this scheduler dreams over — must match the engine's runner so "already ran today" keys on the same (operator, scope, mode) the run will record (R2). */
  scope?: string | null;
  mode?: DreamMode;
  /** Injectable epoch-ms clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for the T9 read-retry backoff (deterministic tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Parse 'HH' or 'HH:MM' to an hour [0..23], or null if blank/invalid. */
export function parseHour(value: string | null | undefined): number | null {
  if (!value) return null;
  const h = parseInt(value.split(':')[0], 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

// ── T6: whole-corpus cadence ──

/**
 * Whole-corpus maintenance cadence (config-driven, ships default OFF — T6.3).
 * The historic-mass drain is operator-triggered first (T17); a cadence is only
 * set once passes come back near-empty. `off` is the shipped default.
 */
export type WholeCorpusCadence = 'off' | 'monthly';

/** Config-blob key (in `operator_config.config`) for the whole-corpus cadence. */
export const WHOLE_CORPUS_CADENCE_KEY = 'dream_whole_corpus_cadence';

/** Read the whole-corpus cadence from an operator_config `config` JSON blob. Default `off`. */
export function readWholeCorpusCadence(configJson: string | null | undefined): WholeCorpusCadence {
  if (!configJson) return 'off';
  try {
    const parsed = JSON.parse(configJson);
    return parsed?.[WHOLE_CORPUS_CADENCE_KEY] === 'monthly' ? 'monthly' : 'off';
  } catch {
    return 'off';
  }
}

/**
 * Pure predicate: should a scheduled whole-corpus pass fire now? Decoupled from
 * I/O like `shouldDreamFire`. Fires only when the cadence is a maintenance value
 * AND no completed whole-corpus dream exists for the current period (operator-
 * local). `off` (the default) NEVER fires — the historic drain is manual (T17).
 *
 * The period is intentionally coarse (the month, in the operator's tz): a
 * maintenance whole-corpus sweep runs at most once per period per scope. The
 * within-quiet-hours/idle gating reuses the same fire window as `shouldDreamFire`
 * (the caller composes them) — this predicate adds only the cadence + period gate.
 */
export function shouldWholeCorpusFire(args: {
  cadence: WholeCorpusCadence;
  now: number;
  /** Local-day string (`localPartsInTz(...).day`) of the last COMPLETED whole-corpus dream, or null. */
  lastWholeCorpusDayLocal: string | null;
  tz: string;
}): { fire: boolean; reason: string } {
  if (args.cadence === 'off') return { fire: false, reason: 'cadence_off' };
  const nowParts = localPartsInTz(args.now, args.tz);
  const nowPeriod = nowParts.day.slice(0, 7); // YYYY-MM (monthly)
  const lastPeriod = args.lastWholeCorpusDayLocal ? args.lastWholeCorpusDayLocal.slice(0, 7) : null;
  if (lastPeriod === nowPeriod) return { fire: false, reason: 'already_ran_this_period' };
  return { fire: true, reason: 'whole_corpus_cadence' };
}

/**
 * T9: a transient pooled-connection drop ("Connection terminated due to connection
 * timeout") surfaces as a thrown error on the FIRST query of a per-minute tick. Retry
 * the read once after a short delay so a single dropped socket self-heals (the pool
 * hands out a fresh connection on the retry), and only warn — never error — if the
 * retry also fails. The tick still degrades gracefully (caller catches null).
 */
async function readWithRetry<T>(
  label: string,
  read: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T | null> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (attempt < retries) {
        logger.debug(`Dream scheduler: ${label} read failed (attempt ${attempt + 1}), retrying:`, err);
        await sleep(delayMs);
        continue;
      }
      // Final failure: a single warn, not a per-tick error.
      logger.warn(`Dream scheduler: ${label} read unavailable this tick (degrading): ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  return null;
}

export class DreamScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private readonly now: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly operatorId: string;
  private readonly scope: string | null;
  private readonly mode: DreamMode;

  constructor(private readonly deps: DreamSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep;
    this.operatorId = deps.operatorId ?? 'default';
    this.scope = deps.scope ?? null;
    this.mode = deps.mode ?? 'windowed';
  }

  start(): void {
    if (this.intervalId) return;
    logger.info(`Dream scheduler started (interval: ${this.deps.intervalMs}ms)`);
    this.intervalId = setInterval(() => {
      this.tick().catch(err => logger.error('Dream scheduler tick failed:', err));
    }, this.deps.intervalMs);
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Dream scheduler stopped');
    }
  }

  get isActive(): boolean {
    return this.intervalId !== null;
  }

  get isDreamRunning(): boolean {
    return this.isRunning;
  }

  /** Periodic tick: evaluate the predicate and fire if it says so. */
  async tick(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Dream tick skipped: already running');
      return;
    }

    const decision = await this.evaluate();
    logger.debug(`Dream fire decision: ${decision.reason} (fire=${decision.fire})`);
    if (decision.fire) {
      await this.executeDream('scheduled', decision.reason);
      return;
    }

    // T6.3: the monthly whole-corpus sweep rides the same tick, evaluated only
    // when the nightly pass didn't claim it — one scheduled fire per tick. A
    // just-completed nightly holds whole-corpus until a later tick tonight; the
    // shipped default cadence 'off' short-circuits this to a no-op.
    const wc = await this.evaluateWholeCorpus();
    if (!wc.fire) return;
    logger.debug(`Whole-corpus fire decision: ${wc.reason} (fire=true)`);
    await this.executeDream('scheduled', wc.reason, 'whole_corpus');
  }

  /** Force a manual dream pass, bypassing the predicate (manual trigger endpoint). */
  async triggerNow(reason = 'manual_trigger'): Promise<void> {
    await this.executeDream('manual', reason);
  }

  /**
   * Resolve the shared fire-window inputs (tz + idle/quiet knobs + the R3
   * activity floor) both the nightly and whole-corpus evaluations gate on.
   */
  private async resolveFireWindow(cfg: OperatorConfig | null) {
    const d = this.deps.defaults;
    const tz = cfg?.timezone ?? d.tz;
    const idleMinutes = cfg?.idle_minutes ?? d.idleMinutes;
    const quietStartHour = cfg?.quiet_hours_start != null ? parseHour(cfg.quiet_hours_start) : d.quietStartHour;
    const quietEndHour = cfg?.quiet_hours_end != null ? parseHour(cfg.quiet_hours_end) : d.quietEndHour;

    // R3: floor the idle signal with observation recency, which survives restarts.
    let lastActivityAt = this.deps.activity.get();
    if (this.deps.observationStore) {
      const obsIso = await readWithRetry(
        'observation-recency',
        () => this.deps.observationStore!.getLastObservationAt(),
        { sleep: this.sleep },
      );
      if (obsIso) {
        const obsMs = Date.parse(obsIso);
        if (Number.isFinite(obsMs) && (lastActivityAt === null || obsMs > lastActivityAt)) {
          lastActivityAt = obsMs;
        }
      }
    }

    return { tz, idleMs: idleMinutes * 60 * 1000, quietStartHour, quietEndHour, lastActivityAt };
  }

  /** Resolve operator config + last-run day, then ask the pure predicate. */
  private async evaluate() {
    const cfg = await this.deps.configStore.getConfig(this.operatorId).catch(() => null);

    // Operator kill-switch (hot, no restart): dream_cadence 'off' stops every
    // SCHEDULED fire — the nightly pass here and the whole-corpus sweep in
    // evaluateWholeCorpus (which re-checks it). Manual triggers (triggerNow)
    // bypass evaluate() entirely, so the capability stays available while off.
    if (cfg?.dream_cadence === 'off') {
      return { fire: false, reason: 'cadence_off' };
    }

    const w = await this.resolveFireWindow(cfg);

    // R2: "already ran today" means a COMPLETED dream for THIS (operator, scope,
    // mode) — a failed dream doesn't claim the day (the engine bounds its retries),
    // and a dream in another scope must not starve this one.
    // T9: retry-once-then-warn on a transient pooled-connection drop.
    let lastRunDayLocal: string | null = null;
    const last = await readWithRetry(
      'last-dream-day',
      () => this.deps.dreamStore.getLastCompletedDream(this.operatorId, this.scope, this.mode),
      { sleep: this.sleep },
    );
    if (last?.started_at) {
      lastRunDayLocal = localPartsInTz(Date.parse(last.started_at), w.tz).day;
    }

    return shouldDreamFire({
      now: this.now(),
      lastActivityAt: w.lastActivityAt,
      lastRunDayLocal,
      tz: w.tz,
      idleMs: w.idleMs,
      quietStartHour: w.quietStartHour,
      quietEndHour: w.quietEndHour,
    });
  }

  /**
   * T6.3: scheduled whole-corpus sweep — composed gates, cheapest first:
   * kill-switch (`dream_cadence` 'off' stops this too) → blob cadence (the
   * shipped default 'off' short-circuits here; the review-tab toggle flips it
   * to 'monthly') → once-per-period gate over COMPLETED whole-corpus dreams →
   * the same quiet-hours/idle window as the nightly pass (`shouldDreamFire`,
   * fed the whole-corpus last-run day so once-per-local-day also holds).
   */
  private async evaluateWholeCorpus(): Promise<{ fire: boolean; reason: string }> {
    const cfg = await this.deps.configStore.getConfig(this.operatorId).catch(() => null);
    if (cfg?.dream_cadence === 'off') return { fire: false, reason: 'cadence_off' };
    const cadence = readWholeCorpusCadence(cfg?.config);
    if (cadence === 'off') return { fire: false, reason: 'cadence_off' };

    const w = await this.resolveFireWindow(cfg);

    let lastWholeCorpusDayLocal: string | null = null;
    const last = await readWithRetry(
      'last-whole-corpus-day',
      () => this.deps.dreamStore.getLastCompletedDream(this.operatorId, this.scope, 'whole_corpus'),
      { sleep: this.sleep },
    );
    if (last?.started_at) {
      lastWholeCorpusDayLocal = localPartsInTz(Date.parse(last.started_at), w.tz).day;
    }

    const period = shouldWholeCorpusFire({
      cadence,
      now: this.now(),
      lastWholeCorpusDayLocal,
      tz: w.tz,
    });
    if (!period.fire) return period;

    const window = shouldDreamFire({
      now: this.now(),
      lastActivityAt: w.lastActivityAt,
      lastRunDayLocal: lastWholeCorpusDayLocal,
      tz: w.tz,
      idleMs: w.idleMs,
      quietStartHour: w.quietStartHour,
      quietEndHour: w.quietEndHour,
    });
    return window.fire ? { fire: true, reason: 'whole_corpus_cadence' } : window;
  }

  /** Run the injected dream action under the isRunning guard. */
  private async executeDream(trigger: DreamTrigger, reason: string, mode?: DreamMode): Promise<void> {
    if (this.isRunning) {
      logger.debug('Dream execution skipped: already running');
      return;
    }
    this.isRunning = true;
    try {
      logger.info(`Dream firing (${trigger}${mode === 'whole_corpus' ? ', whole-corpus' : ''}): ${reason}`);
      // Mode is passed only for whole-corpus so the windowed contract (and its
      // exact-arity call sites/tests) stays byte-identical.
      if (mode === 'whole_corpus') await this.deps.runDream(trigger, reason, mode);
      else await this.deps.runDream(trigger, reason);
    } finally {
      this.isRunning = false;
    }
  }
}
