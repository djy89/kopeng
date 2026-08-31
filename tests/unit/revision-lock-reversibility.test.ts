/**
 * WS0 finding 1 — the Hard Anchor has to be recoverable.
 *
 * `is_locked` is THE Hard Anchor: it is what stops promotion / the dream decay
 * tier / maintenance §2 from archiving a memory. It is also model-writable —
 * the MCP `update_memory {locked}` argument forwards straight to `body.is_locked`
 * on PUT /api/memories/:id. Before this change the `memory_revisions` INSERT
 * column list omitted `is_locked` on BOTH backends, so a model-issued
 * `{locked:false}` was unrecorded AND unrecoverable, and the row became
 * archivable on the very next promotion/dream pass. Meanwhile the README
 * promised "every write is reversible".
 *
 * The fix: `memory_revisions.is_locked` (SQLite migration v10 / PG v12, plain
 * additive nullable ADD COLUMN), written by both INSERT sites (the
 * `snapshotRevision` path and `restoreRevision`'s own pre-rollback snapshot),
 * and restored under the same NULL-safe COALESCE that guards scope/type/last_seen.
 *
 * These cases are SQLite-executed; the PG twin lives in
 * tests/integration/pg-executed-sql.test.ts (env-gated on KOPENG_PG_TEST_URL).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import { adminHeaders } from '../fixtures/test-helpers.js';

describe('memory_revisions.is_locked — the anchor is snapshotted and restorable', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    queries = new MemoryQueries(db);
    dreamStore = new DreamQueries(db);
    const embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);

    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error.name === 'ZodError') {
        reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
        return;
      }
      reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    });
    registerRoutes(app, {
      stores: { queries, dreams: dreamStore, operatorConfig: dreamStore },
      services: { embeddingIndex },
      lifecycle: {
        initialize: async () => {}, close: async () => {},
        getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
        backup: async () => 'noop',
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function createMemory(content: string): Promise<number> {
    const res = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/memories',
      payload: { content, type: 'reference', scope: 'global', confidence: 0.5 },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload).data.id as number;
  }

  function put(id: number, payload: Record<string, unknown>) {
    return app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload });
  }

  /** Read the RAW column, independent of the mapper — so mapper bugs can't hide. */
  function revisionLockColumn(id: number, revision: number): number | null {
    const row = db.prepare(
      'SELECT is_locked FROM memory_revisions WHERE memory_id = ? AND revision = ?'
    ).get(id, revision) as { is_locked: number | null } | undefined;
    return row ? row.is_locked : null;
  }

  it('the migration ladder actually added the column', () => {
    const cols = (db.prepare('PRAGMA table_info(memory_revisions)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('is_locked');
  });

  it('a lock change snapshots a revision that RECORDS the pre-change lock state', async () => {
    const id = await createMemory('anchor snapshot subject');

    // unlocked -> locked. Snapshot-first, so the revision must record 0.
    expect(JSON.parse((await put(id, { is_locked: true })).payload).meta.lock_changed).toBe(true);
    let revs = await dreamStore.listRevisions(id);
    expect(revs.length).toBe(1);
    expect(revisionLockColumn(id, revs[0].revision)).toBe(0);

    // locked -> unlocked. This is the dangerous direction: the revision must
    // record 1, which is the only record that the anchor ever existed.
    expect(JSON.parse((await put(id, { is_locked: false })).payload).meta.lock_changed).toBe(true);
    revs = await dreamStore.listRevisions(id);
    expect(revs.length).toBe(2);
    expect(revisionLockColumn(id, revs[0].revision)).toBe(1);
  });

  it('rolling back a model-issued unlock restores the lock (the finding-1 regression)', async () => {
    const id = await createMemory('a locked identity-level staple');
    await put(id, { is_locked: true });
    expect((await queries.get(id))?.is_locked).toBe(1);

    // The exact shape MCP `update_memory {locked:false}` produces.
    await put(id, { is_locked: false });
    expect((await queries.get(id))?.is_locked).toBe(0);

    // Default rollback = newest revision = the snapshot taken before the unlock.
    const rb = await app.inject({
      method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`, payload: {},
    });
    expect(rb.statusCode).toBe(200);
    expect((await queries.get(id))?.is_locked).toBe(1);
  });

  it('rollback is itself reversible for the lock: the pre-rollback snapshot records the live value', async () => {
    const id = await createMemory('reversible rollback subject');
    await put(id, { is_locked: true });   // rev 1 records 0
    await put(id, { is_locked: false });  // rev 2 records 1

    await app.inject({ method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`, payload: {} });
    expect((await queries.get(id))?.is_locked).toBe(1);

    // restoreRevision snapshots the live (unlocked) row before restoring, so
    // rolling THAT snapshot back returns the row to unlocked.
    const revs = await dreamStore.listRevisions(id);
    const preRollback = revs.find(r => r.revision > 2 && revisionLockColumn(id, r.revision) === 0);
    expect(preRollback).toBeDefined();

    const rb2 = await app.inject({
      method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`,
      payload: { revision: preRollback!.revision },
    });
    expect(rb2.statusCode).toBe(200);
    expect((await queries.get(id))?.is_locked).toBe(0);
  });

  it('a legacy NULL-is_locked revision does NOT clobber a live locked row', async () => {
    const id = await createMemory('legacy revision subject');

    // A content PUT snapshots the row, then we NULL the new column to simulate a
    // pre-v10 revision — exactly what every revision written before the
    // migration looks like on the live corpus.
    await put(id, { content: 'legacy revision subject v2' });
    const revs = await dreamStore.listRevisions(id);
    expect(revs.length).toBe(1);
    db.prepare('UPDATE memory_revisions SET is_locked = NULL WHERE memory_id = ? AND revision = ?')
      .run(id, revs[0].revision);
    expect(revisionLockColumn(id, revs[0].revision)).toBeNull();

    // Lock the live row AFTER that revision was written.
    await put(id, { is_locked: true });
    expect((await queries.get(id))?.is_locked).toBe(1);

    const rb = await app.inject({
      method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`,
      payload: { revision: revs[0].revision },
    });
    expect(rb.statusCode).toBe(200);
    const cur = await queries.get(id);
    expect(cur?.content).toBe('legacy revision subject'); // content did roll back
    expect(cur?.is_locked).toBe(1);                       // …and the anchor was NOT stripped
  });

  it('documented consequence: a NON-legacy unlocked snapshot DOES revert a later lock', async () => {
    // The flip side of full-row restore, and the one behaviour change an operator
    // can be surprised by. It is the same semantics scope/type/last_seen already
    // have: rollback reverts the row to how it was, protection included. Bounded —
    // rollback is admin-gated, explicit, and (see above) itself reversible, since
    // the pre-rollback snapshot captures the live lock.
    const id = await createMemory('full-row restore subject');
    await put(id, { content: 'full-row restore subject v2' }); // rev 1 records is_locked = 0
    const revs = await dreamStore.listRevisions(id);
    expect(revisionLockColumn(id, revs[0].revision)).toBe(0);

    await put(id, { is_locked: true });
    expect((await queries.get(id))?.is_locked).toBe(1);

    await app.inject({
      method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`,
      payload: { revision: revs[0].revision },
    });
    expect((await queries.get(id))?.is_locked).toBe(0);
  });

  it('the revisions READ surface exposes is_locked as a boolean, and NULL for legacy rows', async () => {
    // The admin-gated revisions surface is where an operator reconstructs what
    // happened. Omitting the one field that decides whether a memory is protected
    // would leave the anchor half-visible — the failure shape this repo keeps
    // hitting. Both mappers normalize to boolean|null (SQLite stores 0/1).
    const id = await createMemory('read-surface subject');
    await put(id, { is_locked: true });   // rev 1 snapshots the UNLOCKED row
    await put(id, { is_locked: false });  // rev 2 snapshots the LOCKED row

    const revs = await dreamStore.listRevisions(id); // newest first
    expect(revs[0].is_locked).toBe(true);
    expect(revs[1].is_locked).toBe(false);
    expect(typeof revs[0].is_locked).toBe('boolean'); // not 1/0

    const one = await dreamStore.getRevision(id, revs[1].revision);
    expect(one!.is_locked).toBe(false);

    // A legacy (pre-v10) revision reads null, not false — the two must stay
    // distinguishable, since only null means "predates the column".
    db.prepare('UPDATE memory_revisions SET is_locked = NULL WHERE memory_id = ? AND revision = ?')
      .run(id, revs[1].revision);
    expect((await dreamStore.getRevision(id, revs[1].revision))!.is_locked).toBeNull();
  });

  it('a dream-linked snapshot captures the lock too (the automated-archive path)', async () => {
    const id = await createMemory('dream-linked snapshot subject');
    await put(id, { is_locked: true });

    const dream = await dreamStore.createDream({ reason: 'ws0 revision-lock test' });
    const { revision } = await dreamStore.snapshotRevision(id, dream.id);
    expect(revisionLockColumn(id, revision)).toBe(1);
  });
});
