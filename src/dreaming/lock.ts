/**
 * Consolidation lock (D0.4): a single-holder mutex over the `consolidation_lock`
 * table, with acquire-or-skip semantics and stale-TTL self-release.
 *
 * The store provides the atomic compare-and-set primitive; this manager owns the
 * clock and the TTL, and offers `withLock()` — the supervisor's entry point.
 * Mutual exclusion is what keeps discovery, promotion, and dream passes from
 * stepping on the same memories concurrently.
 */
import { randomUUID } from 'crypto';
import type { IDreamStore } from '../database/interfaces.js';
import logger from '../utils/logger.js';

/** TTL must comfortably exceed a full discovery → promotion → dream pass. */
export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_OPERATOR_ID = 'default';

/**
 * Per-acquisition holder identity for locks constructed per REQUEST (manual
 * dream triggers, resolve, rollback, manual promote). `tryAcquireLock` allows
 * same-holder re-acquire (that is what the heartbeat and crash-restart recovery
 * rely on) — so two concurrent requests sharing a bare holder string would BOTH
 * acquire, and the first to finish would release the other's hold mid-write
 * (GATE 1 finding R9). A unique suffix keeps the same-holder extension for one
 * acquisition's heartbeat while making distinct acquisitions mutually exclusive.
 * Process-singleton holders (nightly chain, discovery scheduler) keep stable
 * names — they are constructed once and never race themselves.
 */
export function uniqueHolder(base: string): string {
  return `${base}#${randomUUID()}`;
}

export interface LockOptions {
  store: IDreamStore;
  /** Identifies this caller; release only succeeds for the matching holder. */
  holder: string;
  ttlMs?: number;
  operatorId?: string;
  /**
   * R4: heartbeat interval for withLock — a same-holder re-acquire that extends
   * the TTL while `fn` runs, so a long pass is never stale-stolen mid-write.
   * Defaults to ttlMs / 3. Set 0 to disable (tests that exercise stale-steal).
   */
  heartbeatMs?: number;
  /** Injectable epoch-ms clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface WithLockResult<T> {
  acquired: boolean;
  result: T | null;
}

/**
 * The withLock contract — what lock consumers (dream engine, supervisor,
 * discovery) actually depend on. `ConsolidationLockManager` is the real
 * implementation; `heldLockPassthrough` satisfies it for steps that already
 * run under a caller's hold (the supervisor chain). (I-prefixed to avoid
 * colliding with the `ConsolidationLock` row type in types.ts.)
 */
export interface IConsolidationLock {
  withLock<T>(fn: () => Promise<T>): Promise<WithLockResult<T>>;
}

/**
 * For steps running INSIDE an already-held lock (e.g. the dream step of the
 * nightly supervisor chain): runs `fn` directly, no store traffic. The outer
 * holder's heartbeat keeps the real lock alive.
 */
export const heldLockPassthrough: IConsolidationLock = {
  async withLock<T>(fn: () => Promise<T>): Promise<WithLockResult<T>> {
    return { acquired: true, result: await fn() };
  },
};

export class ConsolidationLockManager implements IConsolidationLock {
  private readonly store: IDreamStore;
  private readonly holder: string;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly operatorId: string;
  private readonly now: () => number;

  constructor(opts: LockOptions) {
    this.store = opts.store;
    this.holder = opts.holder;
    this.ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    this.heartbeatMs = opts.heartbeatMs ?? Math.floor(this.ttlMs / 3);
    this.operatorId = opts.operatorId ?? DEFAULT_OPERATOR_ID;
    this.now = opts.now ?? Date.now;
  }

  /** Try to take (or extend) the lock. Returns true iff this holder now owns it. */
  async acquire(): Promise<boolean> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + this.ttlMs).toISOString();
    return this.store.tryAcquireLock(this.operatorId, this.holder, nowIso, expiresIso);
  }

  /** Release the lock iff still held by this holder. */
  async release(): Promise<boolean> {
    return this.store.releaseLock(this.operatorId, this.holder);
  }

  /**
   * Acquire-or-skip. If acquired, runs `fn` and always releases (even on throw).
   * Returns `{ acquired: false, result: null }` when the lock is held elsewhere —
   * `fn` is not run in that case.
   *
   * R4: while `fn` runs, a heartbeat re-acquires (same-holder TTL extension) every
   * `heartbeatMs`, so a pass longer than the TTL is not stale-stolen mid-write.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<WithLockResult<T>> {
    const acquired = await this.acquire();
    if (!acquired) {
      logger.debug(`Consolidation lock busy (operator=${this.operatorId}); '${this.holder}' skipping`);
      return { acquired: false, result: null };
    }
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    if (this.heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        this.acquire().then(ok => {
          if (!ok) logger.warn(`Consolidation lock heartbeat lost for '${this.holder}' — lock stolen mid-run`);
        }).catch(err => {
          logger.warn(`Consolidation lock heartbeat failed for '${this.holder}':`, err);
        });
      }, this.heartbeatMs);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();
    }
    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      const released = await this.release();
      if (!released) {
        logger.warn(`Consolidation lock release was a no-op for '${this.holder}' (stale-stolen mid-run?)`);
      }
    }
  }
}
