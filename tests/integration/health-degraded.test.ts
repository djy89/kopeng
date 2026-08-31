/**
 * T56: `/api/health` must distinguish "embedder still loading" from "embedder
 * load attempted and terminally failed".
 *
 * Before the fix, a failed load reported the cold-start shape
 * (`status: "loading"`, `embedding: "initializing"`) forever, so an operator
 * following the documented first troubleshooting step concluded the server was
 * stuck — while it was actually up and serving keyword-only search.
 *
 * The failure is forced the same way the real one happens (stranger-install
 * Finding #2): the guarded `@xenova/transformers` import rejects. Mocking
 * `importWithoutDuplicateRejection` reproduces that without onnxruntime or
 * network, and drives the REAL `initEmbedder` state machine end to end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import { initEmbedder, isEmbedderReady, getEmbedderLoadState } from '../../src/embeddings/embedder.js';
import { adminHeaders } from '../fixtures/test-helpers.js';

vi.mock('../../src/utils/import-safely.js', () => ({
  importWithoutDuplicateRejection: () =>
    Promise.reject(
      Object.assign(new Error('simulated native binding failure'), { code: 'ERR_DLOPEN_FAILED' })
    ),
}));

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

describe('/api/health reflects terminal embedder failure', () => {
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
    registerRoutes(app, {
      stores: { queries },
      services: { embeddingIndex },
      lifecycle: createLifecycleStub(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  async function health() {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).data;
  }

  it('before any load attempt, health reports the transient cold-start shape', async () => {
    expect(getEmbedderLoadState()).toBe('idle');
    const data = await health();
    expect(data.status).toBe('loading');
    expect(data.embedding).toBe('initializing');
    expect(data.search).toBe('unavailable'); // empty corpus, no embedder yet
  });

  it('after the load attempt fails, health reports the terminal degraded state', async () => {
    await expect(initEmbedder()).rejects.toThrow('simulated native binding failure');
    expect(getEmbedderLoadState()).toBe('failed');
    expect(isEmbedderReady()).toBe(false);

    const data = await health();
    expect(data.status).toBe('degraded');
    expect(data.embedding).toBe('error');
    expect(data.search).toBe('keyword_only');
  });

  it('the degraded server genuinely serves keyword-only recall (T55 × T56)', async () => {
    const stored = await app.inject({
      method: 'POST',
      headers: adminHeaders(),
      url: '/api/memories',
      payload: {
        content: 'Sentinel memory proving keyword search survives embedder failure',
        type: 'reference',
        scope: 'global',
      },
    });
    expect(stored.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/api/memories/recall',
      payload: { query: 'sentinel memory keyword search embedder' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.some((m: { content: string }) => m.content.includes('Sentinel memory'))).toBe(true);
  });
});
