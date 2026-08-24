/**
 * memory_access_log retention (Phase 8 Task 4 — S7, CX-7, CX-14).
 *
 * The access log is the one unbounded-growth table (335k rows on the live
 * system). `trimAccessLog(days)` deletes rows older than a backend-native
 * cutoff — SQLite `datetime('now', '-<n> days')`, never a JS ISO string,
 * whose 'T' separator sorts wrong against SQLite's space-separated text
 * (CX-7).
 *
 * CX-14 pins the blast radius: the ARCHIVE line (`isDecayedAtRisk`, over
 * confidence/last_seen/updated_at) reads NO access-log rows, so trimming can
 * never change which memories are at risk (test 1); the only observable delta
 * is the reporting-side `computeDecayScores` frequency/recency components
 * (test 2).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import { isAnchored, isDecayedAtRisk } from '../../src/dreaming/scoring.js';
import { computeDecayScores } from '../../src/promotion/decay.js';

function insertAccess(db: Database.Database, memoryId: number, modifier: string): void {
  db.prepare(
    "INSERT INTO memory_access_log (memory_id, accessed_at) VALUES (?, datetime('now', ?))"
  ).run(memoryId, modifier);
}

function accessCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM memory_access_log').get() as { n: number }).n;
}

function accessCountFor(db: Database.Database, memoryId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM memory_access_log WHERE memory_id = ?')
    .get(memoryId) as { n: number }).n;
}

async function seedMemory(
  db: Database.Database,
  queries: MemoryQueries,
  m: Parameters<typeof createTestMemory>[0],
  staleDays?: number,
): Promise<number> {
  const { id } = await queries.store(createTestMemory(m));
  if (staleDays !== undefined) {
    const ts = new Date(Date.now() - staleDays * 86_400_000).toISOString();
    db.prepare(
      'UPDATE memories SET last_seen = ?, updated_at = ?, created_at = ?, observation_count = 1 WHERE id = ?'
    ).run(ts, ts, ts, id);
  }
  return id;
}

describe('trimAccessLog (SQLite)', () => {
  it('deletes only rows older than the window (backend-native cutoff)', async () => {
    const { db, queries } = createTestDatabase();
    const a = await seedMemory(db, queries, { content: 'memory with an ancient access row' });
    const b = await seedMemory(db, queries, { content: 'memory with an inside-window access row' });
    const c = await seedMemory(db, queries, { content: 'memory with a fresh access row' });

    insertAccess(db, a, '-100 days');
    insertAccess(db, b, '-89 days');
    insertAccess(db, c, '-0 seconds');
    expect(accessCount(db)).toBe(3);

    const deleted = await queries.trimAccessLog(90);
    expect(deleted).toBe(1);
    expect(accessCount(db)).toBe(2);
    // Exactly the 100-day row is gone; the -89d and fresh rows survive.
    expect(accessCountFor(db, a)).toBe(0);
    expect(accessCountFor(db, b)).toBe(1);
    expect(accessCountFor(db, c)).toBe(1);
  });

  it("keeps a row at exactly the boundary — the cutoff comparison is strict `<`", async () => {
    const { db, queries } = createTestDatabase();
    const id = await seedMemory(db, queries, { content: 'boundary-row memory' });

    // SQLite datetime() has SECOND granularity, so a row inserted at
    // datetime('now','-90 days') equals the DELETE's cutoff only when insert
    // and trim execute within the same wall-clock second. Retry across a
    // second tick so the equality case is what we actually pin (never flaky).
    const nowSecond = () =>
      (db.prepare("SELECT strftime('%s','now') AS s").get() as { s: string }).s;
    let deleted = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = nowSecond();
      insertAccess(db, id, '-90 days');
      deleted = await queries.trimAccessLog(90);
      const after = nowSecond();
      if (before === after) break; // equality held — result is authoritative
      db.prepare('DELETE FROM memory_access_log WHERE memory_id = ?').run(id);
      deleted = -1;
    }
    // `accessed_at < datetime('now','-90 days')` — the equal row is KEPT.
    expect(deleted).toBe(0);
    expect(accessCountFor(db, id)).toBe(1);
  });

  it('days=0 means keep forever: returns 0 and deletes nothing', async () => {
    const { db, queries } = createTestDatabase();
    const id = await seedMemory(db, queries, { content: 'ancient but retained access row' });
    insertAccess(db, id, '-100 days');
    insertAccess(db, id, '-1000 days');

    // If a DELETE ran with a '-0 days' cutoff, BOTH old rows would be deleted
    // (cutoff = now). Surviving rows prove the guard short-circuits.
    expect(await queries.trimAccessLog(0)).toBe(0);
    expect(accessCount(db)).toBe(2);

    // Defensive: negatives (unreachable via config, which throws) also no-op.
    expect(await queries.trimAccessLog(-5)).toBe(0);
    expect(accessCount(db)).toBe(2);
  });

  it('archive-line independence (CX-14 test 1): isDecayedAtRisk selects the identical set before/after a trim', async () => {
    const { db, queries } = createTestDatabase();
    // Borrowed from the decay-predicate-composition seeding shape: one anchored
    // row, two at-risk rows, one fresh row — every one carrying access rows old
    // enough that trim(90) deletes them.
    const anchored = await seedMemory(db, queries,
      { content: 'operator-confirmed fact held at full confidence', type: 'project', scope: 'project:anchors', confidence: 1.0 }, 300);
    const atRisk1 = await seedMemory(db, queries,
      { content: 'stale discovery sitting under a quiet scope', type: 'discovery', scope: 'project:quiet', confidence: 0.6 }, 300);
    const atRisk2 = await seedMemory(db, queries,
      { content: 'stale project note nobody has touched', type: 'project', scope: 'project:quiet', confidence: 0.5 }, 300);
    const fresh = await seedMemory(db, queries,
      { content: 'fresh well-believed project note', type: 'project', scope: 'global', confidence: 0.8 });
    for (const id of [anchored, atRisk1, atRisk2, fresh]) {
      insertAccess(db, id, '-200 days');
      insertAccess(db, id, '-150 days');
    }

    const now = new Date();
    const selectAtRisk = (): number[] => {
      const rows = db.prepare(
        'SELECT id, type, confidence, observation_count, last_seen, updated_at, is_locked, metadata FROM memories WHERE is_archived = 0'
      ).all() as {
        id: number; type: string; confidence: number; observation_count: number | null;
        last_seen: string | null; updated_at: string; is_locked: number; metadata: string;
      }[];
      return rows
        .filter((r) => !isAnchored(r) && isDecayedAtRisk(
          { confidence: r.confidence, observation_count: r.observation_count, last_seen: r.last_seen, updated_at: r.updated_at, type: r.type, tags: [] },
          now,
        ))
        .map((r) => r.id)
        .sort((x, y) => x - y);
    };

    const before = selectAtRisk();
    expect(before).toEqual([atRisk1, atRisk2].sort((x, y) => x - y));

    const deleted = await queries.trimAccessLog(90);
    expect(deleted).toBe(8); // the trim really happened — the test is not vacuous

    expect(selectAtRisk()).toEqual(before);
  });

  it('reporting delta (CX-14 test 2): computeDecayScores changes for a memory whose only access rows aged out', async () => {
    const { db, queries } = createTestDatabase();
    // Non-anchored (conf < 1.0, not pinned, not immature discovery) so the
    // scoring shortcut branches don't mask the frequency component.
    const id = await seedMemory(db, queries,
      { content: 'project note whose access history is entirely stale', type: 'project', confidence: 0.8 }, 100);
    insertAccess(db, id, '-100 days');
    insertAccess(db, id, '-95 days');

    const before = (await computeDecayScores(null, db)).find((s) => s.memoryId === id)!;
    expect(before.frequencyScore).toBeGreaterThan(0);

    expect(await queries.trimAccessLog(90)).toBe(2);

    const after = (await computeDecayScores(null, db)).find((s) => s.memoryId === id)!;
    // Frequency (all-time COUNT over the log) drops to zero — the delta is
    // reporting-only; the archive line (test above) never moved.
    expect(after.frequencyScore).toBe(0);
    expect(after.totalScore).not.toBe(before.totalScore);
  });
});

describe('ACCESS_LOG_RETENTION_DAYS config bound (CX-7)', () => {
  const ORIGINAL = process.env.ACCESS_LOG_RETENTION_DAYS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ACCESS_LOG_RETENTION_DAYS;
    else process.env.ACCESS_LOG_RETENTION_DAYS = ORIGINAL;
    vi.resetModules();
  });

  it('negative value makes config load throw', async () => {
    process.env.ACCESS_LOG_RETENTION_DAYS = '-1';
    vi.resetModules();
    await expect(import('../../src/config/config.js')).rejects.toThrow(/ACCESS_LOG_RETENTION_DAYS/);
  });

  it('0 is accepted (keep forever)', async () => {
    process.env.ACCESS_LOG_RETENTION_DAYS = '0';
    vi.resetModules();
    const { config } = await import('../../src/config/config.js');
    expect(config.retention.accessLogDays).toBe(0);
  });

  it('defaults to 90', async () => {
    delete process.env.ACCESS_LOG_RETENTION_DAYS;
    vi.resetModules();
    const { config } = await import('../../src/config/config.js');
    expect(config.retention.accessLogDays).toBe(90);
  });
});
