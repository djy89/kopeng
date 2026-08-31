/**
 * T55: `/api/memories/recall` must degrade to FTS-only when the embedder is
 * down (still loading, or terminally failed) instead of early-returning `[]`.
 *
 * The per-prompt recall hook rides this endpoint — before the fix, a broken
 * embedder (stranger-install Finding #2's designed keyword-only degrade path)
 * silently emptied recall for the whole session while `/api/memories/search`
 * kept returning keyword hits over the same corpus.
 *
 * The embedder is "down" here the same way it is in every other integration
 * suite: `initEmbedder()` is simply never called in this process, so
 * `isEmbedderReady()` is false and the semantic lane has no vector to search
 * with. Staple injection is embedder-independent and must also keep working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { isEmbedderReady } from '../../src/embeddings/embedder.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import { adminHeaders } from '../fixtures/test-helpers.js';

function createLifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({
      total_memories: 0,
      active_memories: 0,
      archived_memories: 0,
      db_size_bytes: 0,
      wal_size_bytes: 0,
    }),
    backup: async () => '/tmp/test-backup.db',
  };
}

describe('recall FTS-only fallback (embedder down)', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const queries = new MemoryQueries(db);
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
      stores: { queries },
      services: { embeddingIndex },
      lifecycle: createLifecycleStub(),
    });
    await app.ready();

    const store = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', headers: adminHeaders(), url: '/api/memories', payload });
    await store({
      content: 'The kopengdb connection string lives in the project env file',
      type: 'reference',
      scope: 'global',
      tags: ['test'],
    });
    await store({
      content: 'Unrelated note about gardening tomatoes on the balcony',
      type: 'reference',
      scope: 'global',
      tags: ['test'],
    });
    await store({
      content: 'Operator identity fact that must always surface',
      type: 'user',
      scope: 'global',
      tags: ['staple'],
      metadata: { trigger_terms: ['identityfact'] },
      confidence: 1.0,
    });
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('precondition: the embedder really is down in this process', () => {
    expect(isEmbedderReady()).toBe(false);
  });

  it('returns keyword matches instead of [] when the embedder is down', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories/recall',
      payload: { query: 'where is the kopengdb connection string', scope: 'global' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.length).toBeGreaterThan(0);
    const contents = body.data.map((m: { content: string }) => m.content);
    expect(contents.some((c: string) => c.includes('kopengdb connection string'))).toBe(true);
    // FTS-only ranking must not drag in the unrelated row.
    expect(contents.some((c: string) => c.includes('gardening tomatoes'))).toBe(false);
  });

  it('still injects staples on trigger-term match with the embedder down', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories/recall',
      payload: { query: 'remind me about the identityfact entry please' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const staple = body.data.find((m: { content: string }) => m.content.includes('must always surface'));
    expect(staple).toBeDefined();
    expect(staple.score).toBe(0.99);
  });

  it('a query with no keyword or staple hits still returns cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories/recall',
      payload: { query: 'zzzz qqqq completely absent tokens xylophone' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // "completely"/"absent"/"tokens"/"xylophone" match nothing stored.
    expect(body.data).toEqual([]);
  });
});
