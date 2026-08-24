import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { REVISION_KEEP_PER_MEMORY } from '../../src/types/types.js';
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

    it('snapshots scope, type, updated_at and last_seen (Phase 2)', async () => {
      const { id } = await queries.store(createTestMemory({
        content: 'phase-2 snapshot fields', scope: 'client:acme-foods', type: 'project',
      }));
      db.prepare(`UPDATE memories SET last_seen = '2026-01-01 00:00:00', updated_at = '2026-01-02 00:00:00' WHERE id = ?`).run(id);
      const snap = await dreams.snapshotRevision(id);
      const rev = await dreams.getRevision(id, snap.revision);
      expect(rev?.scope).toBe('client:acme-foods');
      expect(rev?.type).toBe('project');
      expect(rev?.last_seen).toBe('2026-01-01 00:00:00');
      expect(rev?.updated_at).toBe('2026-01-02 00:00:00');
    });

    it('restore returns a scope/type change to the snapshotted values', async () => {
      const { id } = await queries.store(createTestMemory({
        content: 'scope round trip', scope: 'project:web', type: 'discovery',
      }));
      const snap = await dreams.snapshotRevision(id);
      await queries.update(id, { content: 'scope round trip', type: 'reference', scope: 'client:acme-foods', metadata: '{}', tags: [] });
      expect(await dreams.restoreRevision(id, snap.revision)).toBe(true);
      const mem = await queries.get(id);
      expect(mem?.scope).toBe('project:web');
      expect(mem?.type).toBe('discovery');
    });

    it('a legacy (pre-v8, NULL-column) revision restores without clobbering live scope/type/last_seen', async () => {
      const { id } = await queries.store(createTestMemory({
        content: 'legacy revision', scope: 'client:acme-foods', type: 'project',
      }));
      const snap = await dreams.snapshotRevision(id);
      db.prepare(`UPDATE memory_revisions SET scope = NULL, type = NULL, updated_at = NULL, last_seen = NULL WHERE memory_id = ?`).run(id);
      await dreams.restoreRevision(id, snap.revision);
      const mem = await queries.get(id);
      expect(mem?.scope).toBe('client:acme-foods');
      expect(mem?.type).toBe('project');
      expect(mem?.last_seen).not.toBeNull();
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

// Team-review #22 S1/P2: revision retention + purge + the non-reinforcing read.
describe('revision retention, purge, and peek (team-review #22)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreams: DreamQueries;

  beforeEach(() => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    dreams = new DreamQueries(db);
  });

  it('snapshotRevision trims operator-edit (NULL-dream) revisions to the newest REVISION_KEEP_PER_MEMORY, never dream-linked ones', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'retention target' }));
    const dream = await dreams.createDream({});
    // Two dream-linked snapshots first — these must survive any trim.
    await dreams.snapshotRevision(id, dream.id);
    await dreams.snapshotRevision(id, dream.id);
    // Then far more operator-edit snapshots than the retention bound.
    for (let i = 0; i < REVISION_KEEP_PER_MEMORY + 7; i++) {
      await dreams.snapshotRevision(id);
    }
    const revs = await dreams.listRevisions(id);
    const nullLinked = revs.filter(r => r.created_by_dream_id === null);
    const dreamLinked = revs.filter(r => r.created_by_dream_id === dream.id);
    expect(nullLinked).toHaveLength(REVISION_KEEP_PER_MEMORY);
    expect(dreamLinked).toHaveLength(2);
    // The SURVIVING null-linked revisions are the newest ones.
    const nullRevNums = nullLinked.map(r => r.revision).sort((a, b) => a - b);
    expect(nullRevNums[0]).toBe(2 + 7 + 1); // oldest survivor = total(2+27) - 20 + 1
  });

  it('deleteRevision removes exactly one revision; deleteRevisions purges the memory\'s history', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'purge target' }));
    await dreams.snapshotRevision(id);
    await dreams.snapshotRevision(id);
    expect(await dreams.deleteRevision(id, 1)).toBe(true);
    expect(await dreams.deleteRevision(id, 1)).toBe(false); // already gone
    expect(await dreams.listRevisions(id)).toHaveLength(1);
    expect(await dreams.deleteRevisions(id)).toBe(1);
    expect(await dreams.listRevisions(id)).toHaveLength(0);
  });

  it('peek reads a memory WITHOUT writing an access-log row (get does)', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'quiet read', tags: ['t1'] }));
    const logCount = () =>
      (db.prepare(`SELECT COUNT(*) AS c FROM memory_access_log WHERE memory_id = ?`).get(id) as { c: number }).c;
    const base = logCount();
    const peeked = await queries.peek(id);
    expect(peeked?.content).toBe('quiet read');
    expect(peeked?.tags).toContain('t1');
    expect(logCount()).toBe(base);
    await queries.get(id);
    expect(logCount()).toBe(base + 1);
  });
});
