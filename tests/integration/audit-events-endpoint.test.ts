/**
 * T43 — GET /api/ops/audit-events: structured, id-cursored audit stream for
 * the viz timeline. Harness mirrors tests/integration/archive-ephemeral-route.test.ts
 * (in-process Fastify + registerRoutes over in-memory SQLite, DreamQueries as
 * the dream store) plus a second app built WITHOUT stores.dreams to cover the
 * `available: false` degrade path (Task 8's client fetch loop depends on it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

function lifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
    backup: async () => '/tmp/test-backup.db',
  };
}

function withZodErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });
}

describe('GET /api/ops/audit-events', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let dreams: DreamQueries;

  let appWithoutDreams: FastifyInstance;
  let dbWithoutDreams: Database.Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    const queries = new MemoryQueries(db);
    dreams = new DreamQueries(db);

    const embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);

    app = Fastify({ logger: false });
    withZodErrorHandler(app);
    registerRoutes(app, {
      stores: { queries, dreams },
      services: { embeddingIndex },
      lifecycle: lifecycleStub(),
    });
    await app.ready();

    dbWithoutDreams = new Database(':memory:');
    dbWithoutDreams.pragma('journal_mode = WAL');
    runMigrations(dbWithoutDreams);
    const queriesWithoutDreams = new MemoryQueries(dbWithoutDreams);
    const embeddingIndexWithoutDreams = new EmbeddingIndex();
    await embeddingIndexWithoutDreams.loadFromDatabase([]);

    appWithoutDreams = Fastify({ logger: false });
    withZodErrorHandler(appWithoutDreams);
    registerRoutes(appWithoutDreams, {
      stores: { queries: queriesWithoutDreams },
      services: { embeddingIndex: embeddingIndexWithoutDreams },
      lifecycle: lifecycleStub(),
    });
    await appWithoutDreams.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
    await appWithoutDreams.close();
    dbWithoutDreams.close();
  });

  it('returns structured, id-cursored audit events', async () => {
    const dream = await dreams.createDream({ mode: 'whole_corpus', trigger_source: 'scheduled', reason: 'seed', is_carrier: true });
    await dreams.appendAudit({ dream_id: dream.id, memory_id: 1, change_class: 'decay', after_ref: 'archived' });
    await dreams.appendAudit({ dream_id: dream.id, memory_id: 2, change_class: 'exact_dup', after_ref: 'archived;kept=9' });
    await dreams.appendAudit({ dream_id: dream.id, memory_id: 3, change_class: 'reinforce' });

    const r1 = await app.inject({ method: 'GET', url: '/api/ops/audit-events?limit=2' });
    expect(r1.statusCode).toBe(200);
    const j1 = r1.json();
    expect(j1.data).toHaveLength(2);
    expect(j1.data[1].relation).toEqual({ kind: 'kept', target_id: 9 });
    expect(j1.data[1].group_key).toBe(`${dream.id}:exact_dup:kept=9`);
    expect(j1.data[0].raw_after_ref).toBe('archived');
    expect(j1.data[0].group_key).toBeNull();
    expect(j1.data[0].created_at).toMatch(/T.*Z$/); // normalized to ISO UTC
    expect(j1.meta.has_more).toBe(true);

    const r2 = await app.inject({ method: 'GET', url: `/api/ops/audit-events?limit=2&cursor=${j1.meta.cursor}` });
    const j2 = r2.json();
    expect(j2.data).toHaveLength(1);
    expect(j2.meta.has_more).toBe(false);
  });

  it('reports available:false without a dream store', async () => {
    const r = await appWithoutDreams.inject({ method: 'GET', url: '/api/ops/audit-events' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ data: [], meta: { available: false, has_more: false, cursor: null } });
  });

  it('rejects a bad limit', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ops/audit-events?limit=5000' });
    expect(r.statusCode).toBe(400);
  });
});
