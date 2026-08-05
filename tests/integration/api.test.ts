import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
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

describe('REST API Integration', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let queries: MemoryQueries;
  let embeddingIndex: EmbeddingIndex;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    queries = new MemoryQueries(db);
    embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);

    app = Fastify({ logger: false });

    // Mirror the production Zod error handler from server.ts
    app.setErrorHandler((error, _request, reply) => {
      if (error.name === 'ZodError') {
        reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
        return;
      }
      reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    });

    registerRoutes(app, {
      stores: { queries },
      services: { embeddingIndex },
      lifecycle: createLifecycleStub(db),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.status).toBeDefined();
      expect(body.data.memories).toBeDefined();
    });
  });

  describe('POST /api/memories', () => {
    it('should store a memory', async () => {
      const res = await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: {
          content: 'Integration test memory',
          type: 'reference',
          scope: 'global',
          tags: ['test'],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data.id).toBeGreaterThan(0);
      expect(body.data.content).toBe('Integration test memory');
    });

    it('should deduplicate identical content', async () => {
      const payload = {
        content: 'Dedup test content',
        type: 'reference',
        scope: 'global',
      };
      await app.inject({ method: 'POST', headers: adminHeaders(), url: '/api/memories', payload });
      const res = await app.inject({ method: 'POST', headers: adminHeaders(), url: '/api/memories', payload });
      expect(res.statusCode).toBe(200); // 200 for dedup, not 201
      const body = JSON.parse(res.payload);
      expect(body.meta.deduplicated).toBe(true);
    });

    it('should reject empty content', async () => {
      const res = await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: { content: '' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/memories/:id', () => {
    it('should return a stored memory', async () => {
      const storeRes = await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: { content: 'Get by ID test', type: 'user', scope: 'global' },
      });
      const id = JSON.parse(storeRes.payload).data.id;

      const res = await app.inject({ method: 'GET', url: `/api/memories/${id}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.content).toBe('Get by ID test');
    });

    it('should return 404 for non-existent id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memories/99999' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Memory not found');
    });
  });

  describe('PUT /api/memories/:id', () => {
    it('should update a memory', async () => {
      const storeRes = await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: { content: 'Before update', type: 'reference', scope: 'global' },
      });
      const id = JSON.parse(storeRes.payload).data.id;

      const res = await app.inject({
        method: 'PUT', headers: adminHeaders(), url: `/api/memories/${id}`,
        payload: { content: 'After update' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta.content_changed).toBe(true);
    });
  });

  describe('PATCH /api/memories/:id', () => {
    it('should archive and unarchive', async () => {
      const storeRes = await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: { content: 'Archive test', type: 'reference', scope: 'global' },
      });
      const id = JSON.parse(storeRes.payload).data.id;

      const archiveRes = await app.inject({
        method: 'PATCH', headers: adminHeaders(), url: `/api/memories/${id}`,
        payload: { archive: true },
      });
      expect(archiveRes.statusCode).toBe(200);
      expect(JSON.parse(archiveRes.payload).data.archived).toBe(true);

      const unarchiveRes = await app.inject({
        method: 'PATCH', headers: adminHeaders(), url: `/api/memories/${id}`,
        payload: { archive: false },
      });
      expect(JSON.parse(unarchiveRes.payload).data.archived).toBe(false);
    });
  });

  describe('POST /api/memories/search', () => {
    it('should search memories by keyword', async () => {
      await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: { content: 'PostgreSQL vector database search', type: 'reference', scope: 'global' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/memories/search',
        payload: { query: 'PostgreSQL', mode: 'keyword' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/memories', () => {
    it('should list memories with pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories?limit=5',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toBeInstanceOf(Array);
      expect(body.meta.limit).toBe(5);
    });

    it('fields=lite omits embeddings over HTTP and allows big pages', async () => {
      const storeRes = await app.inject({
        method: 'POST', headers: adminHeaders(), url: '/api/memories',
        payload: { content: 'lite route test', type: 'reference', scope: 'global' },
      });
      const id = JSON.parse(storeRes.payload).data.id;
      const vec = new Float32Array([0.5, 0.5, 0.5]);
      await queries.setEmbedding(id, Buffer.from(vec.buffer), 'test-model');

      const full = await app.inject({ method: 'GET', url: '/api/memories?limit=100' });
      const fullRow = JSON.parse(full.payload).data.find((m: { id: number }) => m.id === id);
      expect(fullRow.embedding).not.toBeNull();

      const lite = await app.inject({ method: 'GET', url: '/api/memories?limit=1000&fields=lite' });
      expect(lite.statusCode).toBe(200);
      const liteBody = JSON.parse(lite.payload);
      expect(liteBody.meta.limit).toBe(1000);
      const liteRow = liteBody.data.find((m: { id: number }) => m.id === id);
      expect(liteRow.embedding).toBeNull();
    });

    it('clamps full requests above maxLimit instead of serving big pages with embeddings', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memories?limit=500' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).meta.limit).toBe(100);
    });

    it('rejects limit above the lite ceiling', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memories?limit=1001&fields=lite' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/stats', () => {
    it('should return database stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.embedding_index_size).toBeDefined();
    });
  });
});
