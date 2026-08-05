import { describe, it, expect, vi } from 'vitest';
import {
  DreamScheduler, parseHour, readWholeCorpusCadence, shouldWholeCorpusFire,
  type DreamSchedulerDeps,
} from '../../src/dreaming/scheduler.js';
import { ActivityTracker, isActivityPath } from '../../src/dreaming/activity-tracker.js';
import type { IDreamStore, IObservationStore, IOperatorConfigStore } from '../../src/database/interfaces.js';
import type { Dream, OperatorConfig } from '../../src/types/types.js';
import logger from '../../src/utils/logger.js';

/** No-op sleep so the T9 read-retry backoff runs instantly in tests. */
const NO_SLEEP = async () => {};

/**
 * D0.5 — DreamScheduler (predicate-driven firing) + ActivityTracker.
 * Stores are stubbed to just the methods the scheduler reads; the clock is
 * injected so firing is deterministic without timers. R2: last-run day comes
 * from getLastCompletedDream (completed-only, per scope/mode). R3: observation
 * recency floors the idle signal.
 */

const IN_WINDOW = Date.parse('2026-06-15T03:00:00Z'); // 03:00 UTC, inside 02–06
const OUT_OF_WINDOW = Date.parse('2026-06-15T12:00:00Z'); // noon UTC

function makeDeps(overrides: Partial<DreamSchedulerDeps> = {}): {
  deps: DreamSchedulerDeps;
  runDream: ReturnType<typeof vi.fn>;
} {
  const runDream = vi.fn(async () => {});
  const configStore = {
    getConfig: async (): Promise<OperatorConfig | null> => null, // unseeded → use defaults
  } as unknown as IOperatorConfigStore;
  const dreamStore = {
    getLastCompletedDream: async (): Promise<Dream | null> => null, // no prior completed dream
  } as unknown as IDreamStore;

  const deps: DreamSchedulerDeps = {
    dreamStore,
    configStore,
    activity: new ActivityTracker(),
    runDream,
    intervalMs: 60_000,
    defaults: { tz: 'UTC', idleMinutes: 30, quietStartHour: 2, quietEndHour: 6 },
    now: () => IN_WINDOW,
    sleep: NO_SLEEP,
    ...overrides,
  };
  return { deps, runDream };
}

describe('DreamScheduler (D0.5)', () => {
  it('fires a scheduled dream when the predicate says so', async () => {
    const { deps, runDream } = makeDeps();
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).toHaveBeenCalledOnce();
    expect(runDream).toHaveBeenCalledWith('scheduled', 'fire');
  });

  it('does not fire outside the quiet-hours window', async () => {
    const { deps, runDream } = makeDeps({ now: () => OUT_OF_WINDOW });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).not.toHaveBeenCalled();
  });

  it('does not fire when a dream already completed today', async () => {
    const priorDream = { started_at: '2026-06-15T03:00:00Z', status: 'completed' } as Dream;
    const dreamStore = { getLastCompletedDream: async () => priorDream } as unknown as IDreamStore;
    const { deps, runDream } = makeDeps({ dreamStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).not.toHaveBeenCalled();
  });

  it('queries the last completed dream for its own (operator, scope, mode)', async () => {
    // R2: a completed dream in scope A must not block scope B's scheduler — the
    // store is asked per-key; here the store only has a scope-A dream.
    const getLastCompletedDream = vi.fn(async (_op: string, scope: string | null) =>
      scope === 'project:a' ? ({ started_at: '2026-06-15T03:00:00Z', status: 'completed' } as Dream) : null
    );
    const dreamStore = { getLastCompletedDream } as unknown as IDreamStore;

    const { deps, runDream } = makeDeps({ dreamStore, scope: 'project:b' });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(getLastCompletedDream).toHaveBeenCalledWith('default', 'project:b', 'windowed');
    expect(runDream).toHaveBeenCalledOnce(); // scope B fires despite scope A's dream
  });

  it('does not fire when the operator was recently active', async () => {
    const activity = new ActivityTracker(() => IN_WINDOW - 60_000); // 1 min ago
    activity.stamp();
    const { deps, runDream } = makeDeps({ activity });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).not.toHaveBeenCalled();
  });

  it('R3: a recent observation blocks firing even with a fresh (restarted) tracker', async () => {
    // Simulated restart: the in-process tracker is empty (null ⇒ idle), but the
    // observations DB durably recorded activity 5 minutes ago.
    const observationStore = {
      getLastObservationAt: async () => new Date(IN_WINDOW - 5 * 60_000).toISOString(),
    } as unknown as IObservationStore;
    const { deps, runDream } = makeDeps({ activity: new ActivityTracker(), observationStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).not.toHaveBeenCalled(); // idle_not_met
  });

  it('R3: a stale observation does not block firing', async () => {
    const observationStore = {
      getLastObservationAt: async () => new Date(IN_WINDOW - 2 * 60 * 60_000).toISOString(), // 2h ago > 30min idle
    } as unknown as IObservationStore;
    const { deps, runDream } = makeDeps({ observationStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).toHaveBeenCalledOnce();
  });

  it('R3: an observation-store failure degrades to tracker-only behavior', async () => {
    const observationStore = {
      getLastObservationAt: async () => { throw new Error('db gone'); },
    } as unknown as IObservationStore;
    const { deps, runDream } = makeDeps({ observationStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).toHaveBeenCalledOnce(); // tracker is null ⇒ idle, error swallowed
  });

  describe('T6.3 — scheduled whole-corpus cadence (wired; ships off)', () => {
    /** Config store with a blob cadence (+ optional top-level fields). */
    const cadenceStore = (cadence: string, extra: Partial<OperatorConfig> = {}) => ({
      getConfig: async () => ({
        config: JSON.stringify({ dream_whole_corpus_cadence: cadence }),
        ...extra,
      } as OperatorConfig),
    } as unknown as IOperatorConfigStore);

    /** Dream store where the windowed pass already completed today and the last whole-corpus pass (if any) is injectable. */
    const dreamStoreWith = (lastWholeCorpus: string | null) => {
      const getLastCompletedDream = vi.fn(async (_op: string, _scope: string | null, mode: string) => {
        if (mode === 'windowed') return { started_at: '2026-06-15T02:30:00Z', status: 'completed' } as Dream;
        return lastWholeCorpus ? ({ started_at: lastWholeCorpus, status: 'completed' } as Dream) : null;
      });
      return { store: { getLastCompletedDream } as unknown as IDreamStore, getLastCompletedDream };
    };

    it('monthly cadence fires a whole-corpus sweep once the nightly pass has claimed the day', async () => {
      const { store } = dreamStoreWith(null); // never swept
      const { deps, runDream } = makeDeps({ configStore: cadenceStore('monthly'), dreamStore: store });
      await new DreamScheduler(deps).tick();
      expect(runDream).toHaveBeenCalledOnce();
      expect(runDream).toHaveBeenCalledWith('scheduled', 'whole_corpus_cadence', 'whole_corpus');
    });

    it('fires in a new period (last sweep was last month)', async () => {
      const { store } = dreamStoreWith('2026-05-20T03:00:00Z');
      const { deps, runDream } = makeDeps({ configStore: cadenceStore('monthly'), dreamStore: store });
      await new DreamScheduler(deps).tick();
      expect(runDream).toHaveBeenCalledWith('scheduled', 'whole_corpus_cadence', 'whole_corpus');
    });

    it('does not re-fire within the same period', async () => {
      const { store } = dreamStoreWith('2026-06-02T03:00:00Z'); // already swept this June
      const { deps, runDream } = makeDeps({ configStore: cadenceStore('monthly'), dreamStore: store });
      await new DreamScheduler(deps).tick();
      expect(runDream).not.toHaveBeenCalled();
    });

    it('default (no blob key) short-circuits — no whole-corpus store read, no fire', async () => {
      const { store, getLastCompletedDream } = dreamStoreWith(null);
      const { deps, runDream } = makeDeps({ dreamStore: store }); // unseeded config → cadence off
      await new DreamScheduler(deps).tick();
      expect(runDream).not.toHaveBeenCalled();
      // Only the windowed daily-gate read happened; the cadence gate never
      // reached the whole-corpus store read.
      expect(getLastCompletedDream).toHaveBeenCalledTimes(1);
      expect(getLastCompletedDream).toHaveBeenCalledWith('default', null, 'windowed');
    });

    it("the dream_cadence 'off' kill-switch blocks the whole-corpus schedule too", async () => {
      const { store } = dreamStoreWith(null);
      const { deps, runDream } = makeDeps({
        configStore: cadenceStore('monthly', { dream_cadence: 'off' } as Partial<OperatorConfig>),
        dreamStore: store,
      });
      await new DreamScheduler(deps).tick();
      expect(runDream).not.toHaveBeenCalled();
    });

    it('respects the quiet/idle window (recent operator activity blocks the sweep)', async () => {
      const activity = new ActivityTracker(() => IN_WINDOW - 60_000); // 1 min ago
      activity.stamp();
      const { store } = dreamStoreWith(null);
      const { deps, runDream } = makeDeps({ configStore: cadenceStore('monthly'), dreamStore: store, activity });
      await new DreamScheduler(deps).tick();
      expect(runDream).not.toHaveBeenCalled();
    });

    it('the nightly pass wins the tick — one scheduled fire, windowed contract unchanged', async () => {
      // Nothing ran today and the cadence is armed: nightly fires, whole-corpus waits.
      const { deps, runDream } = makeDeps({ configStore: cadenceStore('monthly') });
      await new DreamScheduler(deps).tick();
      expect(runDream).toHaveBeenCalledOnce();
      expect(runDream).toHaveBeenCalledWith('scheduled', 'fire');
    });
  });

  it("dream_cadence 'off' blocks scheduled fires (hot kill-switch)", async () => {
    const configStore = {
      getConfig: async () => ({ dream_cadence: 'off' } as OperatorConfig),
    } as unknown as IOperatorConfigStore;
    const { deps, runDream } = makeDeps({ configStore }); // otherwise perfect firing conditions
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).not.toHaveBeenCalled();
  });

  it("dream_cadence values other than 'off' keep the default firing behavior", async () => {
    const configStore = {
      getConfig: async () => ({ dream_cadence: 'nightly' } as OperatorConfig),
    } as unknown as IOperatorConfigStore;
    const { deps, runDream } = makeDeps({ configStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();
    expect(runDream).toHaveBeenCalledOnce();
  });

  it("triggerNow bypasses the cadence kill-switch — manual triggers still work while off", async () => {
    const configStore = {
      getConfig: async () => ({ dream_cadence: 'off' } as OperatorConfig),
    } as unknown as IOperatorConfigStore;
    const { deps, runDream } = makeDeps({ configStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.triggerNow();
    expect(runDream).toHaveBeenCalledOnce();
    expect(runDream).toHaveBeenCalledWith('manual', 'manual_trigger');
  });

  it('T9: a transient dropped connection on the last-dream read retries, then fires', async () => {
    // First call throws (connection terminated due to connection timeout), retry succeeds (no prior dream).
    const getLastCompletedDream = vi
      .fn<() => Promise<Dream | null>>()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce(null);
    const dreamStore = { getLastCompletedDream } as unknown as IDreamStore;
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const { deps, runDream } = makeDeps({ dreamStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();

    expect(getLastCompletedDream).toHaveBeenCalledTimes(2); // initial + one retry
    expect(runDream).toHaveBeenCalledOnce(); // retry saw "no prior dream" → fires
    expect(errorSpy).not.toHaveBeenCalled(); // T9: a transient drop is never an error-level log
    errorSpy.mockRestore();
  });

  it('T9: a persistent connection-timeout on both reads degrades with at most a single warn, no error', async () => {
    const drop = () => { throw new Error('Connection terminated due to connection timeout'); };
    const dreamStore = { getLastCompletedDream: async () => drop() } as unknown as IDreamStore;
    const observationStore = { getLastObservationAt: async () => drop() } as unknown as IObservationStore;
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const { deps, runDream } = makeDeps({ dreamStore, observationStore });
    const scheduler = new DreamScheduler(deps);
    await scheduler.tick();

    expect(errorSpy).not.toHaveBeenCalled(); // no error-level log per tick
    // one warn per failing read (last-dream + observation-recency), never an error
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toMatch(/degrading/);
    // last-dream read degraded to null ⇒ treated as "never ran" ⇒ still fires
    expect(runDream).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('triggerNow runs a manual pass bypassing the predicate', async () => {
    // Outside the window — the predicate would block, but manual ignores it.
    const { deps, runDream } = makeDeps({ now: () => OUT_OF_WINDOW });
    const scheduler = new DreamScheduler(deps);
    await scheduler.triggerNow();
    expect(runDream).toHaveBeenCalledWith('manual', 'manual_trigger');
  });

  it('isRunning guard prevents overlapping dream passes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const runDream = vi.fn(async () => { await gate; });
    const { deps } = makeDeps({ runDream });
    const scheduler = new DreamScheduler(deps);

    const first = scheduler.tick(); // acquires isRunning, then awaits the gate
    await scheduler.tick(); // should skip — already running
    expect(runDream).toHaveBeenCalledOnce();

    release();
    await first;
  });

  it('reflects activity/firing state via accessors', () => {
    const { deps } = makeDeps();
    const scheduler = new DreamScheduler(deps);
    expect(scheduler.isActive).toBe(false);
    expect(scheduler.isDreamRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
  });
});

describe('parseHour', () => {
  it('parses HH and HH:MM, rejecting blanks and out-of-range', () => {
    expect(parseHour('2')).toBe(2);
    expect(parseHour('23:30')).toBe(23);
    expect(parseHour('06:00')).toBe(6);
    expect(parseHour(null)).toBeNull();
    expect(parseHour('')).toBeNull();
    expect(parseHour('99')).toBeNull();
  });
});

describe('T6 whole-corpus cadence', () => {
  const JUNE = Date.parse('2026-06-15T03:00:00Z');

  it('readWholeCorpusCadence defaults to off and only accepts monthly', () => {
    expect(readWholeCorpusCadence(null)).toBe('off');
    expect(readWholeCorpusCadence('{}')).toBe('off');
    expect(readWholeCorpusCadence('not json')).toBe('off');
    expect(readWholeCorpusCadence(JSON.stringify({ dream_whole_corpus_cadence: 'weekly' }))).toBe('off');
    expect(readWholeCorpusCadence(JSON.stringify({ dream_whole_corpus_cadence: 'monthly' }))).toBe('monthly');
  });

  it('off never fires (the shipped default — drain is manual, T17)', () => {
    expect(shouldWholeCorpusFire({ cadence: 'off', now: JUNE, lastWholeCorpusDayLocal: null, tz: 'UTC' }).fire).toBe(false);
  });

  it('monthly fires when no completed whole-corpus pass exists this month', () => {
    const r = shouldWholeCorpusFire({ cadence: 'monthly', now: JUNE, lastWholeCorpusDayLocal: null, tz: 'UTC' });
    expect(r.fire).toBe(true);
    expect(r.reason).toBe('whole_corpus_cadence');
  });

  it('monthly does NOT re-fire within the same month', () => {
    const r = shouldWholeCorpusFire({ cadence: 'monthly', now: JUNE, lastWholeCorpusDayLocal: '2026-06-02', tz: 'UTC' });
    expect(r.fire).toBe(false);
    expect(r.reason).toBe('already_ran_this_period');
  });

  it('monthly fires again in a new month', () => {
    expect(shouldWholeCorpusFire({ cadence: 'monthly', now: JUNE, lastWholeCorpusDayLocal: '2026-05-30', tz: 'UTC' }).fire).toBe(true);
  });
});

describe('ActivityTracker (D0.5)', () => {
  it('starts null and records stamps at the injected time', () => {
    let t = 1000;
    const tracker = new ActivityTracker(() => t);
    expect(tracker.get()).toBeNull();
    tracker.stamp();
    expect(tracker.get()).toBe(1000);
    t = 2000;
    tracker.stamp();
    expect(tracker.get()).toBe(2000);
  });
});

describe('isActivityPath', () => {
  it('counts real operator work as activity', () => {
    expect(isActivityPath('POST', '/api/memories')).toBe(true);
    expect(isActivityPath('POST', '/api/memories/search')).toBe(true);
    expect(isActivityPath('POST', '/api/observations')).toBe(true);
  });

  it('excludes health, ops, dream, and SSE traffic', () => {
    expect(isActivityPath('GET', '/api/health')).toBe(false);
    expect(isActivityPath('GET', '/api/ops/discovery-status')).toBe(false);
    expect(isActivityPath('POST', '/api/dreams/trigger')).toBe(false);
    expect(isActivityPath('GET', '/api/observations/stream')).toBe(false);
  });

  it('R8: excludes slot reads (viz polling) but counts slot writes', () => {
    expect(isActivityPath('GET', '/api/slots')).toBe(false);
    expect(isActivityPath('GET', '/api/slots/active-task')).toBe(false);
    expect(isActivityPath('POST', '/api/slots')).toBe(true);
    expect(isActivityPath('PUT', '/api/slots/active-task')).toBe(true);
    expect(isActivityPath('DELETE', '/api/slots/active-task')).toBe(true);
  });

  it('ignores the query string when matching', () => {
    expect(isActivityPath('GET', '/api/ops/top-decaying?limit=5')).toBe(false);
    expect(isActivityPath('GET', '/api/memories?scope=global')).toBe(true);
  });
});
