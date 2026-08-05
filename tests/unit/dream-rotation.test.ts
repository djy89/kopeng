import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import {
  runDreamPass, RotatingWindowMemorySource, isRotatingSource, DbWindowMemorySource,
  type DreamEngineDeps,
} from '../../src/dreaming/dream-engine.js';
import {
  EmptyDiffGenerator, WindowedCandidateSelector,
  DuplicateCandidateSelector, DeterministicDiffGenerator, type DiffGenerator,
} from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';

/**
 * D1.4 — rotating-window selector. The newest-500-by-id window never revisited
 * older memories; the rotating source walks the id space in ascending segments
 * (cursor persisted in operator_config.config), wrapping at the top. The cursor
 * advances ONLY on dream completion, and the window key encodes it
 * (`<day>#a<cursor>`) so R2 collapse stays per-segment.
 */
describe('D1.4 rotating window', () => {
  let db: Database.Database;
  let memories: MemoryQueries;
  let dreams: DreamQueries;
  const NOW = Date.parse('2026-06-15T03:00:00Z'); // UTC day 2026-06-15

  async function seed(content: string, opts: { scope?: string; confidence?: number } = {}): Promise<number> {
    const { id } = await memories.store({
      content, type: 'project', scope: opts.scope ?? 'global', source: 'test',
      source_path: null, metadata: '{}', embedding: null, embedding_model: '',
      created_by: null, tags: [], confidence: opts.confidence ?? 0.7,
    });
    return id;
  }

  function rotatingSource(limit: number): RotatingWindowMemorySource {
    return new RotatingWindowMemorySource(memories, dreams, { limit });
  }

  function deps(overrides: Partial<DreamEngineDeps> = {}): DreamEngineDeps {
    return {
      dreamStore: dreams,
      configStore: dreams,
      source: rotatingSource(4),
      selector: new WindowedCandidateSelector(),
      reasoner: new NoOpReasoner(),
      diffGen: new EmptyDiffGenerator(),
      lock: new ConsolidationLockManager({ store: dreams, holder: 'dream-engine', now: () => NOW }),
      tz: 'UTC',
      now: () => NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDatabase().db;
    memories = new MemoryQueries(db);
    dreams = new DreamQueries(db);
  });

  describe('listByIdRange', () => {
    it('returns active memories ascending within (after_id, max_id]', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) ids.push(await seed(`range seed ${i}`));
      await memories.archive(ids[2]);

      const rows = await memories.listByIdRange({ after_id: ids[0], max_id: ids[4], limit: 10 });
      expect(rows.map(r => r.id)).toEqual([ids[1], ids[3], ids[4]]); // archived excluded, ascending

      const limited = await memories.listByIdRange({ after_id: 0, limit: 2 });
      expect(limited.map(r => r.id)).toEqual([ids[0], ids[1]]);
    });

    it('filters by scope case-insensitively', async () => {
      const a = await seed('scoped one', { scope: 'project:Alpha' });
      await seed('scoped two', { scope: 'project:beta' });
      const rows = await memories.listByIdRange({ after_id: 0, limit: 10, scope: 'project:alpha' });
      expect(rows.map(r => r.id)).toEqual([a]);
    });
  });

  describe('RotatingWindowMemorySource', () => {
    it('walks disjoint ascending segments across commits and wraps at the top', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 10; i++) ids.push(await seed(`walk seed ${i}`));

      const src = rotatingSource(4);
      expect(isRotatingSource(src)).toBe(true);
      expect(isRotatingSource(new DbWindowMemorySource(memories))).toBe(false);

      expect((await src.fetch()).map(m => m.id)).toEqual(ids.slice(0, 4));
      await src.commit();
      expect(await src.currentCursor()).toBe(ids[3]);

      expect((await src.fetch()).map(m => m.id)).toEqual(ids.slice(4, 8));
      await src.commit();

      // Tail (2 rows) + wrap-fill from the bottom (2 rows).
      expect((await src.fetch()).map(m => m.id)).toEqual([ids[8], ids[9], ids[0], ids[1]]);
      await src.commit();
      expect(await src.currentCursor()).toBe(ids[1]);
    });

    it('covers the whole corpus every pass when it is smaller than the limit', async () => {
      const ids = [await seed('small one'), await seed('small two')];
      const src = rotatingSource(4);
      expect((await src.fetch()).map(m => m.id)).toEqual(ids);
      await src.commit();
      // Cursor sits at the top: the next window wraps to the whole corpus again.
      expect((await src.fetch()).map(m => m.id)).toEqual(ids);
    });

    it('commit without a fetch is a no-op', async () => {
      await seed('noop seed');
      const src = rotatingSource(4);
      await src.commit();
      expect(await src.currentCursor()).toBe(0);
    });
  });

  describe('engine integration', () => {
    it('encodes the cursor in the window key and advances only on completion', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) ids.push(await seed(`engine seed ${i}`));

      const p1 = await runDreamPass(deps(), { trigger: 'scheduled' });
      expect(p1.status).toBe('completed');
      expect(p1.window_key).toBe('2026-06-15#a0');
      expect(p1.memories_examined).toBe(4);

      // Same day, fresh source instance (server constructs one per pass): the
      // cursor advanced, so the next pass gets a NEW per-segment window.
      const p2 = await runDreamPass(deps(), { trigger: 'manual' });
      expect(p2.status).toBe('completed');
      expect(p2.window_key).toBe(`2026-06-15#a${ids[3]}`);
      expect(p2.memories_examined).toBe(4); // ids 5,6 + wrap 1,2

      // Re-trigger of an already-collapsed segment (explicit key) collapses.
      const p3 = await runDreamPass(deps(), { trigger: 'manual', windowKey: '2026-06-15#a0' });
      expect(p3.status).toBe('collapsed');
      expect(p3.dream_id).toBe(p1.dream_id);
    });

    it('a failed pass does not advance the cursor — the retry re-covers the same segment', async () => {
      for (let i = 0; i < 6; i++) await seed(`retry seed ${i}`);
      const boom: DiffGenerator = { generate: () => { throw new Error('boom'); } };

      await expect(runDreamPass(deps({ diffGen: boom }), { trigger: 'scheduled' })).rejects.toThrow('boom');
      const src = rotatingSource(4);
      expect(await src.currentCursor()).toBe(0);

      // R2 retry: same window key, same segment, completes and advances.
      const retry = await runDreamPass(deps(), { trigger: 'scheduled' });
      expect(retry.status).toBe('completed');
      expect(retry.window_key).toBe('2026-06-15#a0');
      expect(await src.currentCursor()).toBeGreaterThan(0);
    });

    it('dry-run does not advance the cursor', async () => {
      for (let i = 0; i < 6; i++) await seed(`dry seed ${i}`);
      const dry = await runDreamPass(deps(), { trigger: 'manual', dryRun: true });
      expect(dry.status).toBe('dry_run');
      expect(dry.memories_examined).toBe(4);
      expect(await rotatingSource(4).currentCursor()).toBe(0);
    });

    it('finds a dup pair planted in an old segment when rotation reaches it', async () => {
      // Segment 1: distinct. Segment 2: a case-variant exact-dup pair.
      for (let i = 0; i < 4; i++) await seed(`planted seed ${i}`);
      const dupA = await seed('The retro board lives in Miro');
      const dupB = await seed('the retro board lives in miro');
      for (let i = 4; i < 6; i++) await seed(`planted seed ${i}`);

      const detect = () => deps({
        selector: new DuplicateCandidateSelector(),
        diffGen: new DeterministicDiffGenerator(),
      });
      const p1 = await runDreamPass(detect(), { trigger: 'scheduled' });
      expect(p1.status).toBe('completed');
      expect(p1.changes_proposed).toBe(0);

      const p2 = await runDreamPass(detect(), { trigger: 'manual' });
      expect(p2.status).toBe('completed');
      expect(p2.changes_proposed).toBe(1);
      const dream = await dreams.getDream(p2.dream_id!);
      const entry = JSON.parse(dream!.output_diff!).entries[0];
      expect(entry.change_class).toBe('exact_dup');
      expect([...entry.memory_ids].sort()).toEqual([dupA, dupB].sort());
    });
  });
});
