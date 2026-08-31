import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { embeddingToBuffer } from '../../src/embeddings/embedder.js';
import { CONTRADICTION_FLAG_TAG } from '../../src/dreaming/contradiction.js';

/** Build a length-3 unit-ish embedding buffer from raw floats. */
function emb(vals: number[]): Buffer {
  return embeddingToBuffer(new Float32Array(vals));
}

describe('corpus-health store methods (SQLite)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeEach(() => {
    ({ db, queries } = createTestDatabase());
  });

  afterEach(() => {
    db.close();
  });

  describe('getCorpusHealthStats', () => {
    it('returns zeroed/null stats for an empty corpus', async () => {
      const stats = await queries.getCorpusHealthStats();
      expect(stats.active_count).toBe(0);
      expect(stats.mean_confidence).toBeNull();
      expect(stats.contradiction_flagged_count).toBe(0);
    });

    it('counts active memories and means their confidence', async () => {
      await queries.store(createTestMemory({ content: 'a', confidence: 0.4 }));
      await queries.store(createTestMemory({ content: 'b', confidence: 0.6 }));
      const stats = await queries.getCorpusHealthStats();
      expect(stats.active_count).toBe(2);
      expect(stats.mean_confidence).toBeCloseTo(0.5, 5);
    });

    it('excludes archived memories from count and mean', async () => {
      const { id } = await queries.store(createTestMemory({ content: 'a', confidence: 0.2 }));
      await queries.store(createTestMemory({ content: 'b', confidence: 0.8 }));
      await queries.archive(id);
      const stats = await queries.getCorpusHealthStats();
      expect(stats.active_count).toBe(1);
      expect(stats.mean_confidence).toBeCloseTo(0.8, 5);
    });

    it('counts distinct active memories carrying the contradiction-flagged tag', async () => {
      await queries.store(createTestMemory({ content: 'flagged-1', tags: [CONTRADICTION_FLAG_TAG, 'x'] }));
      await queries.store(createTestMemory({ content: 'flagged-2', tags: [CONTRADICTION_FLAG_TAG] }));
      await queries.store(createTestMemory({ content: 'clean', tags: ['y'] }));
      const archived = await queries.store(createTestMemory({ content: 'flagged-archived', tags: [CONTRADICTION_FLAG_TAG] }));
      await queries.archive(archived.id);

      const stats = await queries.getCorpusHealthStats();
      expect(stats.contradiction_flagged_count).toBe(2); // archived one excluded
    });

    describe('legacy_anchor_count (WS7.4 B3)', () => {
      it('counts unlocked confidence>=1.0 and pinned-metadata rows', async () => {
        await queries.store(createTestMemory({ content: 'legacy confirmed', confidence: 1.0 }));
        await queries.store(createTestMemory({ content: 'legacy pinned', confidence: 0.5, metadata: JSON.stringify({ pinned: true }) }));
        await queries.store(createTestMemory({ content: 'ordinary', confidence: 0.5 }));
        const stats = await queries.getCorpusHealthStats();
        expect(stats.legacy_anchor_count).toBe(2);
      });

      it('excludes rows already locked (not legacy — is_locked IS the current anchor)', async () => {
        const { id } = await queries.store(createTestMemory({ content: 'locked and confirmed', confidence: 1.0 }));
        db.prepare('UPDATE memories SET is_locked = 1 WHERE id = ?').run(id);
        const stats = await queries.getCorpusHealthStats();
        expect(stats.legacy_anchor_count).toBe(0);
      });

      it('excludes archived rows', async () => {
        const { id } = await queries.store(createTestMemory({ content: 'archived legacy anchor', confidence: 1.0 }));
        await queries.archive(id);
        const stats = await queries.getCorpusHealthStats();
        expect(stats.legacy_anchor_count).toBe(0);
      });

      it('does not count a non-boolean pinned value or malformed metadata as pinned', async () => {
        await queries.store(createTestMemory({ content: 'pinned string, not boolean', confidence: 0.5, metadata: JSON.stringify({ pinned: 'yes' }) }));
        const { id } = await queries.store(createTestMemory({ content: 'malformed metadata holder', confidence: 0.5 }));
        db.prepare("UPDATE memories SET metadata = 'not json' WHERE id = ?").run(id);
        const stats = await queries.getCorpusHealthStats();
        expect(stats.legacy_anchor_count).toBe(0);
      });

      it('does not count a JSON number 1 as pinned (must be the real JSON boolean true, matching isPinnedMetadata/PG)', async () => {
        // json_extract('{"pinned":1}', '$.pinned') = 1 would collide with JSON true under
        // an equality-vs-1 check — json_type distinguishes them ('integer' vs 'true').
        await queries.store(createTestMemory({ content: 'pinned as the number 1, not boolean true', confidence: 0.5, metadata: JSON.stringify({ pinned: 1 }) }));
        const stats = await queries.getCorpusHealthStats();
        expect(stats.legacy_anchor_count).toBe(0);
      });

      it('is zero on an empty corpus', async () => {
        const stats = await queries.getCorpusHealthStats();
        expect(stats.legacy_anchor_count).toBe(0);
      });
    });
  });

  describe('getCorpusHealthSample', () => {
    it('returns active rows ascending by id, capped at limit', async () => {
      for (let i = 0; i < 5; i++) {
        await queries.store(createTestMemory({ content: `m${i}`, confidence: 0.5 }));
      }
      const sample = await queries.getCorpusHealthSample(3);
      expect(sample).toHaveLength(3);
      expect(sample[0].id).toBeLessThan(sample[1].id);
      expect(sample[1].id).toBeLessThan(sample[2].id);
    });

    it('excludes archived rows and surfaces the strength inputs', async () => {
      const { id } = await queries.store(createTestMemory({ content: 'keep', confidence: 0.7 }));
      const archived = await queries.store(createTestMemory({ content: 'gone', confidence: 0.1 }));
      await queries.archive(archived.id);

      const sample = await queries.getCorpusHealthSample(100);
      expect(sample.map(r => r.id)).toEqual([id]);
      const row = sample[0];
      expect(row.confidence).toBeCloseTo(0.7, 5);
      expect(row).toHaveProperty('observation_count');
      expect(row).toHaveProperty('last_seen');
      expect(row).toHaveProperty('updated_at');
      expect(row.embedding).toBeNull(); // test memory had no embedding
    });

    it('surfaces the dup-pair classification inputs (scope, is_locked as boolean, metadata)', async () => {
      await queries.store(createTestMemory({
        content: 'classified',
        scope: 'project:demo',
        metadata: JSON.stringify({ condition_sources: [7] }),
      }));
      const sample = await queries.getCorpusHealthSample(100);
      expect(sample).toHaveLength(1);
      const row = sample[0];
      expect(row.scope).toBe('project:demo');
      expect(typeof row.is_locked).toBe('boolean');
      expect(row.is_locked).toBe(false);
      expect(JSON.parse(row.metadata ?? '{}').condition_sources).toEqual([7]);
    });

    it('returns the embedding BLOB when present', async () => {
      await queries.store({ ...createTestMemory({ content: 'vec' }), embedding: emb([1, 0, 0]) });
      const sample = await queries.getCorpusHealthSample(100);
      expect(sample).toHaveLength(1);
      expect(Buffer.isBuffer(sample[0].embedding)).toBe(true);
    });
  });
});

describe('listRecentDreams (SQLite DreamQueries)', () => {
  let db: Database.Database;
  let dreamStore: DreamQueries;

  beforeEach(() => {
    ({ db } = createTestDatabase());
    dreamStore = new DreamQueries(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns only completed dreams, newest first', async () => {
    const running = await dreamStore.createDream({ reason: 'running' });
    const failed = await dreamStore.createDream({ reason: 'failed' });
    const done1 = await dreamStore.createDream({ reason: 'done1' });
    const done2 = await dreamStore.createDream({ reason: 'done2' });

    await dreamStore.updateDream(failed.id, { status: 'failed' });
    await dreamStore.updateDream(done1.id, { status: 'completed', completed_at: '2026-06-20T00:00:00Z', started_at: '2026-06-20T00:00:00Z' } as Record<string, unknown>);
    await dreamStore.updateDream(done2.id, { status: 'completed', completed_at: '2026-06-21T00:00:00Z', started_at: '2026-06-21T00:00:00Z' } as Record<string, unknown>);

    const recent = await dreamStore.listRecentDreams(10);
    const ids = recent.map(d => d.id);
    expect(ids).not.toContain(running.id);
    expect(ids).not.toContain(failed.id);
    // newest started_at first
    expect(ids).toEqual([done2.id, done1.id]);
  });

  it('honors limit and offset paging', async () => {
    const created: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = await dreamStore.createDream({ reason: `d${i}` });
      await dreamStore.updateDream(d.id, {
        status: 'completed',
        started_at: `2026-06-1${i}T00:00:00Z`,
      } as Record<string, unknown>);
      created.push(d.id);
    }
    // started_at ascending d0..d3 → newest-first is d3,d2,d1,d0
    const page1 = await dreamStore.listRecentDreams(2, 0);
    const page2 = await dreamStore.listRecentDreams(2, 2);
    expect(page1.map(d => d.id)).toEqual([created[3], created[2]]);
    expect(page2.map(d => d.id)).toEqual([created[1], created[0]]);
  });
});
