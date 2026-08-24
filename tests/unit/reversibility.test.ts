import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { DreamQueries } from '../../src/database/dream-queries.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';
import { autoArchiveDecayed } from '../../src/promotion/auto-archive.js';
import { rollbackMemory } from '../../src/dreaming/apply.js';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';

// applyEntry/rollback only touch add/remove — a null stub keeps the test model-free.
const nullIndex = {
  async add() {}, async remove() {}, async search() { return []; },
} as unknown as IVectorSearch;

describe('Phase 2 G1/G2: rollback of a decay archive is durable', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;

  beforeEach(() => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
  });

  it('a rolled-back decay archive survives the next promotion pass and the rollback is audited', async () => {
    const { id } = await queries.store(createTestMemory({
      content: 'ancient but deliberately rescued', type: 'project', confidence: 0.6,
    }));
    // Age the decay clock far past the project half-life (45d): strength << 0.2.
    db.prepare(`UPDATE memories SET last_seen = datetime('now', '-400 days'),
      updated_at = datetime('now', '-400 days'), observation_count = 1 WHERE id = ?`).run(id);

    const deps = { memoryStore: queries, dreamStore: store, vectorIndex: nullIndex };
    const first = await autoArchiveDecayed(deps, 0.1, false);
    expect(first.archived).toContain(id);
    expect((await queries.get(id))?.is_archived).toBe(1);

    const rb = await rollbackMemory(deps, id);
    expect(rb).not.toBeNull();
    const restored = await queries.get(id);
    expect(restored?.is_archived).toBe(0);

    // G2: the rollback appended a dream_audit_log row under the carrier dream.
    const audit = await store.listAuditForDream(first.dream_id!);
    expect(audit.filter(a => a.change_class === 'rollback').length).toBe(1);

    // G1: the decay clock was refreshed (rescue), so a re-run archives nothing.
    const second = await autoArchiveDecayed(deps, 0.1, false);
    expect(second.archived).not.toContain(id);
    expect((await queries.get(id))?.is_archived).toBe(0);
  });

  it('rollback refreshes last_seen and bumps observation_count (rescue reinforce)', async () => {
    const { id } = await queries.store(createTestMemory({ content: 'reinforce on rollback', confidence: 0.6 }));
    db.prepare(`UPDATE memories SET last_seen = datetime('now', '-400 days'), observation_count = 3 WHERE id = ?`).run(id);
    const snap = await store.snapshotRevision(id);
    await rollbackMemory({ memoryStore: queries, dreamStore: store, vectorIndex: nullIndex }, id, snap.revision);
    const mem = await queries.get(id);
    const ageMs = Date.now() - new Date(mem!.last_seen + 'Z').getTime();
    expect(ageMs).toBeLessThan(60_000);
    expect(mem?.observation_count).toBe(4); // restored 3, then +1 rescue reinforce
  });
});
