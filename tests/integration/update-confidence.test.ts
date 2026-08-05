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

/** Minimal stub that satisfies IDatabaseLifecycle for testing */
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
 * T22: PUT /api/memories/:id now accepts `confidence`. A confidence change is
 * snapshot-first (memory_revisions) and therefore reversible via the rollback
 * API — the anchor-triage safety property. The dream store must be wired for the
 * revision/rollback routes to mount.
 */
describe('PUT /api/memories/:id confidence (T22 anchor triage)', () => {
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

  async function createMemory(confidence: number): Promise<number> {
    const res = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/memories',
      payload: { content: `anchor-triage subject ${confidence} ${Math.random()}`, type: 'reference', scope: 'global', tags: [], confidence },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload).data.id as number;
  }

  it('accepts a confidence field on PUT and applies the change', async () => {
    const id = await createMemory(1.0);

    const res = await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { confidence: 0.9 } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.confidence).toBe(0.9);
    expect(body.meta.confidence_changed).toBe(true);
  });

  it('snapshots the pre-change confidence into a revision (audited)', async () => {
    const id = await createMemory(1.0);

    // No revisions before the change.
    const before = await app.inject({ method: 'GET', url: `/api/memories/${id}/revisions` });
    expect(JSON.parse(before.payload).data.length).toBe(0);

    await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { confidence: 0.9 } });

    const after = await app.inject({ method: 'GET', url: `/api/memories/${id}/revisions` });
    const revs = JSON.parse(after.payload).data as Array<{ revision: number; confidence: number }>;
    expect(revs.length).toBe(1);
    // The snapshot captured the OLD confidence (pre-change).
    expect(revs[0].confidence).toBe(1.0);
  });

  it('rollback restores the pre-change confidence', async () => {
    const id = await createMemory(1.0);
    await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { confidence: 0.4 } });

    // Sanity: it was actually demoted.
    let cur = await app.inject({ method: 'GET', url: `/api/memories/${id}` });
    expect(JSON.parse(cur.payload).data.confidence).toBe(0.4);

    const rb = await app.inject({ method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/rollback`, headers: adminHeaders(), payload: {} });
    expect(rb.statusCode).toBe(200);

    cur = await app.inject({ method: 'GET', url: `/api/memories/${id}` });
    expect(JSON.parse(cur.payload).data.confidence).toBe(1.0);
  });

  it('does NOT snapshot when confidence is unchanged / absent', async () => {
    const id = await createMemory(0.9);

    // Content-only update, no confidence field.
    const res = await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { content: 'reworded anchor-triage subject' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).meta.confidence_changed).toBe(false);

    const revs = await app.inject({ method: 'GET', url: `/api/memories/${id}/revisions` });
    expect(JSON.parse(revs.payload).data.length).toBe(0);
  });

  it('does NOT snapshot when the same confidence is re-sent (no-op change)', async () => {
    const id = await createMemory(0.9);
    const res = await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { confidence: 0.9 } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).meta.confidence_changed).toBe(false);

    const revs = await app.inject({ method: 'GET', url: `/api/memories/${id}/revisions` });
    expect(JSON.parse(revs.payload).data.length).toBe(0);
  });

  it('rejects an out-of-bounds confidence (400)', async () => {
    const id = await createMemory(0.9);
    const high = await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { confidence: 1.5 } });
    expect(high.statusCode).toBe(400);
    const low = await app.inject({ method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`, payload: { confidence: -0.1 } });
    expect(low.statusCode).toBe(400);
  });
});
