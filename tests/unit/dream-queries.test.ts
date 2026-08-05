import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { MemoryQueries } from '../../src/database/queries.js';

/**
 * D0.2 — Dreaming-layer store round-trips (SQLite).
 * Exercises dreams, revisions (snapshot/restore), audit, reinforcement, and operator_config.
 */
describe('DreamQueries (D0.2, SQLite)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreams: DreamQueries;

  beforeEach(() => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    dreams = new DreamQueries(db);
  });

  async function newMemory(content: string, tags: string[] = []) {
    const { id } = await queries.store(createTestMemory({ content, tags }));
    return id;
  }

  describe('dreams', () => {
    it('creates a running dream with defaults and reads it back', async () => {
      const d = await dreams.createDream({ scope: 'project:x', reason: 'test' });
      expect(d.id).toBeGreaterThan(0);
      expect(d.status).toBe('running');
      expect(d.acceptance_status).toBe('pending');
      expect(d.mode).toBe('windowed');
      expect(d.trigger_source).toBe('scheduled');
      const fetched = await dreams.getDream(d.id);
      expect(fetched?.reason).toBe('test');
    });

    it('updates counts, diff, and completion', async () => {
      const d = await dreams.createDream({});
      await dreams.setDreamDiff(d.id, { entries: [{ change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [1, 2], rationale: 'dupe' }] });
      await dreams.updateDream(d.id, { status: 'completed', acceptance_status: 'empty', memories_examined: 5, changes_queued: 1 });
      const after = await dreams.getDream(d.id);
      expect(after?.status).toBe('completed');
      expect(after?.memories_examined).toBe(5);
      expect(JSON.parse(after!.output_diff!).entries[0].change_class).toBe('exact_dup');
    });

    it('enforces window idempotency via getDreamByWindow', async () => {
      await dreams.createDream({ scope: 'project:x', window_key: '2026-06-07' });
      const found = await dreams.getDreamByWindow('default', 'project:x', 'windowed', '2026-06-07');
      expect(found).not.toBeNull();
      // A duplicate keyed window collides on the partial unique index.
      await expect(dreams.createDream({ scope: 'project:x', window_key: '2026-06-07' })).rejects.toThrow();
    });

    it('R2: a failed dream leaves the unique index, so the window accepts a retry row', async () => {
      const first = await dreams.createDream({ scope: 'project:x', window_key: '2026-06-07' });
      await dreams.updateDream(first.id, { status: 'failed', error: 'boom' });

      // Retry INSERT for the same window now succeeds…
      const retry = await dreams.createDream({ scope: 'project:x', window_key: '2026-06-07' });
      expect(retry.id).not.toBe(first.id);

      // …and the window's full history is visible, newest-first.
      const windowDreams = await dreams.listDreamsByWindow('default', 'project:x', 'windowed', '2026-06-07');
      expect(windowDreams.map(d => d.id)).toEqual([retry.id, first.id]);
      // A different window stays empty.
      expect(await dreams.listDreamsByWindow('default', 'project:x', 'windowed', '2026-06-08')).toEqual([]);
    });

    it('R2: getLastCompletedDream filters by status and (operator, scope, mode)', async () => {
      const failed = await dreams.createDream({ scope: 'project:a', window_key: '2026-06-07' });
      await dreams.updateDream(failed.id, { status: 'failed', error: 'boom' });
      expect(await dreams.getLastCompletedDream('default', 'project:a', 'windowed')).toBeNull();

      const done = await dreams.createDream({ scope: 'project:a', window_key: '2026-06-08' });
      await dreams.updateDream(done.id, { status: 'completed' });

      const last = await dreams.getLastCompletedDream('default', 'project:a', 'windowed');
      expect(last?.id).toBe(done.id);
      // Scope B, NULL scope, other mode, other operator: all unaffected by scope A's dream.
      expect(await dreams.getLastCompletedDream('default', 'project:b', 'windowed')).toBeNull();
      expect(await dreams.getLastCompletedDream('default', null, 'windowed')).toBeNull();
      expect(await dreams.getLastCompletedDream('default', 'project:a', 'whole_corpus')).toBeNull();
      expect(await dreams.getLastCompletedDream('other-op', 'project:a', 'windowed')).toBeNull();
    });

    it('lists dreams newest-first', async () => {
      const a = await dreams.createDream({ reason: 'a' });
      const b = await dreams.createDream({ reason: 'b' });
      const list = await dreams.listDreams(10);
      expect(list.map(d => d.id)).toEqual([b.id, a.id]);
    });

    it('listPendingDreams returns only completed dreams awaiting review (D1.3)', async () => {
      const pending = await dreams.createDream({ window_key: 'w1' });
      await dreams.updateDream(pending.id, { status: 'completed', acceptance_status: 'pending' });
      const partial = await dreams.createDream({ window_key: 'w2' });
      await dreams.updateDream(partial.id, { status: 'completed', acceptance_status: 'partial' });
      const empty = await dreams.createDream({ window_key: 'w3' });
      await dreams.updateDream(empty.id, { status: 'completed', acceptance_status: 'empty' });
      const failed = await dreams.createDream({ window_key: 'w4' });
      await dreams.updateDream(failed.id, { status: 'failed', acceptance_status: 'pending' });
      await dreams.createDream({ window_key: 'w5' }); // still running

      const list = await dreams.listPendingDreams(10);
      expect(list.map(d => d.id)).toEqual([partial.id, pending.id]);
    });
  });

  describe('revisions', () => {
    it('snapshots the live row including tags, with incrementing revision numbers', async () => {
      const id = await newMemory('original content', ['alpha', 'beta']);
      const r1 = await dreams.snapshotRevision(id);
      const r2 = await dreams.snapshotRevision(id);
      expect(r1.revision).toBe(1);
      expect(r2.revision).toBe(2);

      const revs = await dreams.listRevisions(id);
      expect(revs).toHaveLength(2);
      const snap = await dreams.getRevision(id, 1);
      expect(snap?.content).toBe('original content');
      expect(snap?.tags.sort()).toEqual(['alpha', 'beta']);
    });

    it('restores a revision over the live row and is itself reversible', async () => {
      const id = await newMemory('v1 content', ['t1']);
      await dreams.snapshotRevision(id);            // revision 1 = "v1 content"

      // Mutate the live memory.
      await queries.update(id, { content: 'v2 content', type: 'reference', scope: 'global', metadata: '{}', tags: ['t2'] });
      let live = await queries.get(id);
      expect(live?.content).toBe('v2 content');
      expect(live?.tags).toEqual(['t2']);

      // Restore revision 1.
      const ok = await dreams.restoreRevision(id, 1);
      expect(ok).toBe(true);
      live = await queries.get(id);
      expect(live?.content).toBe('v1 content');
      expect(live?.tags).toEqual(['t1']);

      // Restore snapshotted the pre-restore (v2) state as a new revision → reversible.
      const revs = await dreams.listRevisions(id);
      const v2snap = revs.find(r => r.content === 'v2 content');
      expect(v2snap).toBeDefined();
    });

    it('returns false when restoring a non-existent revision', async () => {
      const id = await newMemory('x');
      expect(await dreams.restoreRevision(id, 99)).toBe(false);
    });
  });

  describe('audit', () => {
    it('appends and lists audit entries for a dream', async () => {
      const d = await dreams.createDream({});
      await dreams.appendAudit({ dream_id: d.id, memory_id: 1, change_class: 'decay', applied_automatically: true, action: 'archived' });
      await dreams.appendAudit({ dream_id: d.id, memory_id: 2, change_class: 'merge', applied_automatically: false });
      const log = await dreams.listAuditForDream(d.id);
      expect(log).toHaveLength(2);
      expect(log[0].applied_automatically).toBe(true);
      expect(log[1].applied_automatically).toBe(false);
      expect(log[0].change_class).toBe('decay');
    });
  });

  describe('reinforcement / anchor', () => {
    it('reinforceMemory bumps observation_count and sets last_seen', async () => {
      const id = await newMemory('reinforce me');
      await dreams.reinforceMemory(id, '2026-06-07T00:00:00Z');
      const row = db.prepare('SELECT observation_count, last_seen FROM memories WHERE id = ?').get(id) as { observation_count: number; last_seen: string };
      expect(row.observation_count).toBe(2); // default 1 + 1
      expect(row.last_seen).toBe('2026-06-07T00:00:00Z');
    });

    it('setMemoryLock toggles is_locked', async () => {
      const id = await newMemory('lock me');
      await dreams.setMemoryLock(id, true);
      expect((db.prepare('SELECT is_locked FROM memories WHERE id = ?').get(id) as { is_locked: number }).is_locked).toBe(1);
      await dreams.setMemoryLock(id, false);
      expect((db.prepare('SELECT is_locked FROM memories WHERE id = ?').get(id) as { is_locked: number }).is_locked).toBe(0);
    });
  });

  describe('operator_config', () => {
    it('reads the seeded default row with auto-accept OFF', async () => {
      const cfg = await dreams.getConfig();
      expect(cfg?.operator_id).toBe('default');
      expect(cfg?.auto_accept_exact_dup).toBe(false);
      expect(cfg?.auto_accept_decay).toBe(false);
      expect(cfg?.idle_minutes).toBe(15);
    });

    it('updates config fields and bumps booleans correctly', async () => {
      const updated = await dreams.updateConfig('default', {
        timezone: 'America/Denver', auto_accept_exact_dup: true, idle_minutes: 30, dream_cadence: 'daily',
      });
      expect(updated.timezone).toBe('America/Denver');
      expect(updated.auto_accept_exact_dup).toBe(true);
      expect(updated.auto_accept_decay).toBe(false);
      expect(updated.idle_minutes).toBe(30);
      expect(updated.dream_cadence).toBe('daily');
    });
  });
});
