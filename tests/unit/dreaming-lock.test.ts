import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager, DEFAULT_OPERATOR_ID, uniqueHolder } from '../../src/dreaming/lock.js';

/**
 * D0.4 — Consolidation lock (SQLite). Covers acquire-or-skip, holder-scoped
 * release, stale-TTL self-release, and the withLock wrapper.
 */
describe('ConsolidationLockManager (D0.4, SQLite)', () => {
  let db: Database.Database;
  let store: DreamQueries;

  beforeEach(() => {
    db = createTestDatabase().db;
    store = new DreamQueries(db);
  });

  it('a second concurrent acquire returns false while held', async () => {
    const a = new ConsolidationLockManager({ store, holder: 'A' });
    const b = new ConsolidationLockManager({ store, holder: 'B' });

    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);

    const lock = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(lock?.holder).toBe('A');
  });

  it('release only succeeds for the holder, then frees the lock', async () => {
    const a = new ConsolidationLockManager({ store, holder: 'A' });
    const b = new ConsolidationLockManager({ store, holder: 'B' });

    expect(await a.acquire()).toBe(true);
    expect(await b.release()).toBe(false); // not the holder — no-op
    expect(await a.release()).toBe(true);

    const lock = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(lock?.holder).toBeNull();
    expect(await b.acquire()).toBe(true); // freed — B can take it now
  });

  it('a stale lock self-releases: a later holder reclaims it', async () => {
    let clockA = 1_000_000; // fixed epoch ms
    const a = new ConsolidationLockManager({ store, holder: 'A', ttlMs: 1000, now: () => clockA });
    expect(await a.acquire()).toBe(true);

    // B's clock is past A's expiry (now + ttl).
    const b = new ConsolidationLockManager({ store, holder: 'B', ttlMs: 1000, now: () => clockA + 1001 });
    expect(await b.acquire()).toBe(true);

    const lock = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(lock?.holder).toBe('B');
  });

  it('the same holder can re-acquire (extend) its own lock', async () => {
    let clock = 5_000_000;
    const a = new ConsolidationLockManager({ store, holder: 'A', ttlMs: 1000, now: () => clock });
    expect(await a.acquire()).toBe(true);
    const first = await store.getLock(DEFAULT_OPERATOR_ID);

    clock += 500; // still within TTL, but re-acquire should extend
    expect(await a.acquire()).toBe(true);
    const second = await store.getLock(DEFAULT_OPERATOR_ID);

    expect(second!.expires_at! > first!.expires_at!).toBe(true);
  });

  it('withLock runs fn and releases afterwards', async () => {
    const a = new ConsolidationLockManager({ store, holder: 'A' });
    let ran = false;
    const out = await a.withLock(async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(out).toEqual({ acquired: true, result: 42 });

    const lock = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(lock?.holder).toBeNull(); // released
  });

  it('withLock skips (does not run fn) when the lock is held elsewhere', async () => {
    const holder = new ConsolidationLockManager({ store, holder: 'holder' });
    expect(await holder.acquire()).toBe(true);

    const b = new ConsolidationLockManager({ store, holder: 'B' });
    let ran = false;
    const out = await b.withLock(async () => { ran = true; return 1; });

    expect(ran).toBe(false);
    expect(out).toEqual({ acquired: false, result: null });
  });

  it('withLock releases the lock even when fn throws', async () => {
    const a = new ConsolidationLockManager({ store, holder: 'A' });
    await expect(a.withLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    const lock = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(lock?.holder).toBeNull(); // released despite the throw
  });

  // R4: the heartbeat re-acquires (same-holder extend) while fn runs, so a pass
  // longer than the TTL is never stale-stolen mid-write. Real timers — the
  // heartbeat is a wall-clock setInterval.
  describe('R4 heartbeat', () => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    it('a long-running fn keeps the lock past the TTL (heartbeat observable via getLock)', async () => {
      const a = new ConsolidationLockManager({ store, holder: 'A', ttlMs: 200, heartbeatMs: 50 });
      const b = new ConsolidationLockManager({ store, holder: 'B', ttlMs: 200 });

      const out = await a.withLock(async () => {
        const initial = await store.getLock(DEFAULT_OPERATOR_ID);
        await sleep(320); // well past the original 200ms TTL
        expect(await b.acquire()).toBe(false); // still live — not stale-stealable
        const extended = await store.getLock(DEFAULT_OPERATOR_ID);
        expect(extended!.holder).toBe('A');
        expect(extended!.expires_at! > initial!.expires_at!).toBe(true);
        return 'done';
      });

      expect(out).toEqual({ acquired: true, result: 'done' });
      expect((await store.getLock(DEFAULT_OPERATOR_ID))?.holder).toBeNull(); // released
    });

    it('heartbeatMs: 0 disables the heartbeat — TTL expiry allows a steal again', async () => {
      const a = new ConsolidationLockManager({ store, holder: 'A', ttlMs: 50, heartbeatMs: 0 });
      const b = new ConsolidationLockManager({ store, holder: 'B', ttlMs: 1000 });

      await a.withLock(async () => {
        await sleep(120); // past A's 50ms TTL, no heartbeat to extend it
        expect(await b.acquire()).toBe(true); // stale-stolen
      });
    });
  });

  describe('R9 unique per-acquisition holders (GATE 1)', () => {
    it('two locks built from the same base do NOT co-acquire via same-holder re-entry', async () => {
      // The exact production wiring for per-request locks (manual trigger,
      // resolve, rollback, manual promote): same base name, unique suffix.
      const a = new ConsolidationLockManager({ store, holder: uniqueHolder('dream-engine') });
      const b = new ConsolidationLockManager({ store, holder: uniqueHolder('dream-engine') });

      expect(await a.acquire()).toBe(true);
      expect(await b.acquire()).toBe(false); // a bare 'dream-engine' holder would have returned true here

      // The loser's release must be a no-op — it must NOT free the winner's hold
      // (the failure mode behind R9: loser finishes first, drops winner's lock).
      expect(await b.release()).toBe(false);
      expect((await store.getLock(DEFAULT_OPERATOR_ID))?.holder).not.toBeNull();

      expect(await a.release()).toBe(true);
      expect(await b.acquire()).toBe(true); // freed for real now
    });
  });
});
