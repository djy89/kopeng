/**
 * D1.1 — durability-aware scoring: reinforcement column separation, new-row
 * population, derived strength, and the retuned auto-archive path (proof that
 * the 0.1 threshold can actually catch a stale memory — a dry-run over a real
 * corpus caught nothing under the old additive floor).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MemoryQueries } from '../../src/database/queries.js';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import { computeDecayScores } from '../../src/promotion/decay.js';
import { autoArchive } from '../../src/promotion/auto-archive.js';
import { memoryStrength } from '../../src/dreaming/scoring.js';

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('D1.1 reinforcement columns', () => {
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeEach(() => {
    ({ db, queries } = createTestDatabase());
  });

  afterEach(() => {
    db.close();
  });

  function getRow(id: number) {
    return db.prepare(
      'SELECT observation_count, first_seen, last_seen, updated_at, content FROM memories WHERE id = ?'
    ).get(id) as { observation_count: number; first_seen: string | null; last_seen: string | null; updated_at: string; content: string };
  }

  it('store populates first_seen/last_seen and defaults observation_count to 1', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'row population check' }));
    const row = getRow(id);
    expect(row.first_seen).not.toBeNull();
    expect(row.last_seen).not.toBeNull();
    expect(row.observation_count).toBe(1);
  });

  it('store seeds observation_count from the input (discovery evidence_count)', async () => {
    const { id } = await queries.store({
      ...createTestMemory({ content: 'seeded evidence count' }),
      observation_count: 7,
    });
    expect(getRow(id).observation_count).toBe(7);
  });

  it('reinforceOnAccess bumps observation_count and refreshes last_seen', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'reinforcement target' }));
    db.prepare('UPDATE memories SET last_seen = ? WHERE id = ?').run(daysAgoIso(30), id);

    await queries.reinforceOnAccess([id]);
    await queries.reinforceOnAccess([id]);

    const row = getRow(id);
    expect(row.observation_count).toBe(3);
    // Decay clock reset: last_seen is fresh again (not 30 days old)
    expect(Date.now() - new Date(row.last_seen!).getTime()).toBeLessThan(60_000);
  });

  it('correction (update) does NOT touch observation_count or last_seen', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'original content here' }));
    db.prepare('UPDATE memories SET last_seen = ?, observation_count = ? WHERE id = ?')
      .run(daysAgoIso(30), 5, id);
    const before = getRow(id);

    await queries.update(id, {
      content: 'corrected content here',
      type: 'reference',
      scope: 'global',
      metadata: '{}',
      tags: [],
    });

    const after = getRow(id);
    expect(after.content).toBe('corrected content here');
    // Correction must not masquerade as usage (D1.1 column separation)
    expect(after.observation_count).toBe(before.observation_count);
    expect(after.last_seen).toBe(before.last_seen);
  });
});

describe('D1.1 derived strength (scoring.ts)', () => {
  it('uses last_seen as the decay anchor, falling back to updated_at', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString();

    const recalled = memoryStrength(
      { confidence: 0.7, observation_count: 1, last_seen: now.toISOString(), updated_at: sixtyDaysAgo },
      now
    );
    const unrecalled = memoryStrength(
      { confidence: 0.7, observation_count: 1, last_seen: null, updated_at: sixtyDaysAgo },
      now
    );
    expect(recalled).toBeCloseTo(0.7, 5); // recall reset the clock
    expect(unrecalled).toBeCloseTo(0.35, 5); // one half-life on the fallback anchor
  });
});

describe('D1.1 auto-archive retune (the 0.1 threshold has teeth)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeEach(() => {
    ({ db, queries } = createTestDatabase());
  });

  afterEach(() => {
    db.close();
  });

  /** Insert a memory and backdate every clock the decay score reads. */
  async function insertAged(opts: {
    content: string;
    type?: 'discovery' | 'reference' | 'feedback';
    confidence?: number;
    ageDays: number;
    metadata?: string;
    locked?: boolean;
  }): Promise<number> {
    const { id } = await queries.store(createTestMemory({
      content: opts.content,
      type: opts.type ?? 'discovery',
      confidence: opts.confidence,
      metadata: opts.metadata,
    }));
    const ts = daysAgoIso(opts.ageDays);
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ?, first_seen = ?, last_seen = ?, is_locked = ? WHERE id = ?')
      .run(ts, ts, ts, ts, opts.locked ? 1 : 0, id);
    return id;
  }

  it('archives a stale unaccessed memory but spares fresh, confirmed, pinned, and locked ones', async () => {
    const staleId = await insertAged({ content: 'stale unused discovery pattern', confidence: 0.7, ageDays: 120 });
    const freshId = await insertAged({ content: 'fresh discovery pattern', confidence: 0.7, ageDays: 0 });
    const confirmedId = await insertAged({ content: 'operator-confirmed truth', confidence: 1.0, ageDays: 120 });
    const pinnedId = await insertAged({
      content: 'pinned slot memory', confidence: 0.7, ageDays: 120, metadata: '{"pinned": true}',
    });
    const lockedId = await insertAged({ content: 'hard-anchor locked memory', confidence: 0.7, ageDays: 120, locked: true });

    const scores = await computeDecayScores(null, db);
    const result = await autoArchive(queries, scores, 0.1, false);

    expect(result.archived).toContain(staleId);
    expect(result.archived).not.toContain(freshId);
    expect(result.archived).not.toContain(confirmedId);
    expect(result.archived).not.toContain(pinnedId);
    expect(result.archived).not.toContain(lockedId);

    const archived = db.prepare('SELECT is_archived FROM memories WHERE id = ?').get(staleId) as { is_archived: number };
    expect(archived.is_archived).toBe(1);
  });

  it('reinforcement-on-access rescues a memory from the archive threshold', async () => {
    const id = await insertAged({ content: 'stale but then recalled pattern', confidence: 0.7, ageDays: 120 });

    const before = (await computeDecayScores(null, db)).find(s => s.memoryId === id)!;
    expect(before.totalScore).toBeLessThan(0.1);

    await queries.reinforceOnAccess([id]); // recall resets last_seen

    const after = (await computeDecayScores(null, db)).find(s => s.memoryId === id)!;
    expect(after.totalScore).toBeGreaterThan(0.1);
  });

  it('immature discoveries (confidence < 0.6) remain exempt from decay archival', async () => {
    const id = await insertAged({ content: 'young low-confidence discovery', confidence: 0.5, ageDays: 120 });
    const scores = await computeDecayScores(null, db);
    expect(scores.find(s => s.memoryId === id)!.totalScore).toBe(1);
  });
});
