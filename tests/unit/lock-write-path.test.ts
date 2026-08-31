import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import { adminHeaders } from '../fixtures/test-helpers.js';

/** Minimal stub that satisfies IDatabaseLifecycle for testing (mirrors update-confidence.test.ts). */
function createLifecycleStub(db: Database.Database): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => {
      const total = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
      const active = (db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_archived = 0').get() as { count: number }).count;
      return {
        total_memories: total,
        active_memories: active,
        archived_memories: total - active,
        db_size_bytes: 0,
        wal_size_bytes: 0,
      };
    },
    backup: async () => '/tmp/test-backup.db',
  };
}

/**
 * WS7.4 B1: `is_locked` is settable via PUT /api/memories/:id, mirroring the
 * T22 confidence anchor-triage pattern exactly — snapshot-first, reversible
 * change detection, no-op-safe.
 *
 * WS0 SUPERSEDES the original Ruling-4 note that used to sit here ("the lock is
 * protection state, not content state — NOT captured by memory_revisions and NOT
 * restored by rollback"). Once `is_locked` became THE Hard Anchor it also became
 * the one field whose loss is unrecoverable, and it is model-writable through the
 * MCP `update_memory {locked}` argument. So the lock IS now snapshotted
 * (memory_revisions.is_locked, SQLite v10 / PG v12) and IS restored by rollback,
 * with the same NULL-safe COALESCE that guards scope/type/last_seen.
 * What survives from ruling 4 is the AUDIT posture, not the revision posture: an
 * operator PUT still appends no dream_audit_log row — the revision snapshot is
 * the reversibility record. Deeper reversibility coverage lives in
 * tests/unit/revision-lock-reversibility.test.ts.
 */
describe('PUT /api/memories/:id is_locked (WS7.4 B1)', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;
  let embeddingIndex: EmbeddingIndex;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    queries = new MemoryQueries(db);
    dreamStore = new DreamQueries(db);
    embeddingIndex = new EmbeddingIndex();
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
      lifecycle: createLifecycleStub(db),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  async function createMemory(overrides: Partial<{ content: string; type: string; scope: string; confidence: number }> = {}): Promise<number> {
    const res = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/memories',
      payload: {
        content: overrides.content ?? `lock-write-path subject ${Math.random()}`,
        type: overrides.type ?? 'reference',
        scope: overrides.scope ?? 'global',
        confidence: overrides.confidence ?? 0.5,
      },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload).data.id as number;
  }

  it('PUT {is_locked:true} flips the row and snapshots a revision', async () => {
    const id = await createMemory();
    const before = await dreamStore.listRevisions(id);

    const res = await app.inject({
      method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.is_locked).toBe(1);
    expect(body.meta.lock_changed).toBe(true);

    const after = await dreamStore.listRevisions(id);
    expect(after.length).toBe(before.length + 1);
  });

  it('accepts a fixed set of wire shapes (1, 0, "true", "false") and rejects everything else', async () => {
    const truthy: unknown[] = [1, 'true', true];
    const falsy: unknown[] = [0, 'false', false];
    for (const value of truthy) {
      const id = await createMemory();
      const res = await app.inject({
        method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: value },
      });
      expect(res.statusCode, `value ${JSON.stringify(value)} should lock`).toBe(200);
      expect(JSON.parse(res.payload).data.is_locked, `value ${JSON.stringify(value)} should lock`).toBe(1);
    }
    for (const value of falsy) {
      const id = await createMemory();
      await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: true } });
      const res = await app.inject({
        method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: value },
      });
      expect(res.statusCode, `value ${JSON.stringify(value)} should unlock`).toBe(200);
      expect(JSON.parse(res.payload).data.is_locked, `value ${JSON.stringify(value)} should unlock`).toBe(0);
    }
  });

  it('rejects null and other junk wire shapes with 400 rather than silently coercing (Finding 3)', async () => {
    const id = await createMemory();
    for (const value of [null, 'yes', 2, 'TRUE', [], {}]) {
      const res = await app.inject({
        method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: value },
      });
      expect(res.statusCode, `value ${JSON.stringify(value)} should be rejected`).toBe(400);
    }
    // Confirm the row was never touched by any of the rejected payloads.
    const cur = await queries.get(id);
    expect(cur?.is_locked).toBe(0);
  });

  it('re-PUT of the same lock value snapshots nothing (byte-identical)', async () => {
    const id = await createMemory();
    await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: true } });
    const before = await dreamStore.listRevisions(id);

    const res = await app.inject({
      method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).meta.lock_changed).toBe(false);

    const after = await dreamStore.listRevisions(id);
    expect(after.length).toBe(before.length);
  });

  it('an empty PUT does not report a lock change', async () => {
    const id = await createMemory();
    const res = await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).meta.lock_changed).toBe(false);
  });

  it('unlocking flips it back and snapshots again', async () => {
    const id = await createMemory();
    await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: true } });
    const before = await dreamStore.listRevisions(id);

    const res = await app.inject({
      method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: false },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.is_locked).toBe(0);

    const after = await dreamStore.listRevisions(id);
    expect(after.length).toBe(before.length + 1);
  });

  it('rollback of a revision snapshotted while LOCKED leaves the row locked', async () => {
    const id = await createMemory({ content: 'original lock-ruling-4 content' });

    // Lock it first.
    await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { is_locked: true } });

    // A separate content-only PUT snapshots the (locked) live row into a revision.
    const putRes = await app.inject({
      method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { content: 'changed lock-ruling-4 content' },
    });
    expect(putRes.statusCode).toBe(200);

    let cur = await queries.get(id);
    expect(cur?.content).toBe('changed lock-ruling-4 content');
    expect(cur?.is_locked).toBe(1);

    const rb = await app.inject({ method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`, payload: {} });
    expect(rb.statusCode).toBe(200);

    cur = await queries.get(id);
    expect(cur?.content).toBe('original lock-ruling-4 content'); // content restored
    // The row stays locked. Pre-WS0 that was because the lock was never touched
    // by rollback at all; now it is because the revision genuinely recorded
    // is_locked = 1 and the restore put that value back. Same outcome, and the
    // discriminating cases (restoring an UNLOCKED snapshot, and the legacy-NULL
    // guard) live in revision-lock-reversibility.test.ts.
    expect(cur?.is_locked).toBe(1);
  });
});
