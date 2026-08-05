/**
 * T19 + T21 ops-surface routes, in-process (app.inject, no external server):
 *  - GET /api/ops/discovery-status exposes last_observation_at (senses light).
 *  - GET /api/ops/reasoner-status reflects the injected reasonerStatus closure,
 *    and degrades to a disarmed status when the closure is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { MemoryQueries } from '../../src/database/queries.js';
import { ObservationQueries } from '../../src/database/observation-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import type { ReasonerLivenessStatus } from '../../src/dreaming/reasoner/liveness.js';
import { createTestObservationsDb } from '../fixtures/test-helpers.js';

function lifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
    backup: async () => '/tmp/test-backup.db',
  };
}

describe('Ops status routes (T19 senses + T21 reasoner)', () => {
  let app: FastifyInstance;
  let memoryDb: Database.Database;
  let obsDb: Database.Database;
  let queries: MemoryQueries;
  let obsQueries: ObservationQueries;
  let embeddingIndex: EmbeddingIndex;

  // Toggle what the injected reasonerStatus closure returns per test.
  let reasonerState: ReasonerLivenessStatus | undefined;

  beforeAll(async () => {
    memoryDb = new Database(':memory:');
    memoryDb.pragma('journal_mode = WAL');
    const { runMigrations } = await import('../../src/database/migrations.js');
    runMigrations(memoryDb);
    queries = new MemoryQueries(memoryDb);

    const testObs = createTestObservationsDb();
    obsDb = testObs.db;
    obsQueries = testObs.obsQueries;

    embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);

    app = Fastify({ logger: false });
    registerRoutes(app, {
      stores: { queries, observations: obsQueries },
      services: {
        embeddingIndex,
        reasonerStatus: async () => reasonerState ?? { armed: false, provider: 'none', reachable: null, model: null, url: null, last_classify_at: null },
      },
      lifecycle: lifecycleStub(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    memoryDb.close();
    obsDb.close();
  });

  it('discovery-status carries last_observation_at once an observation lands', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/ops/discovery-status' });
    expect(before.statusCode).toBe(200);
    // No observations yet → null (senses would read "dark").
    expect(JSON.parse(before.payload).data.last_observation_at).toBeNull();

    await obsQueries.storeObservation({
      session_id: 's1', project_scope: 'project:test', tool_name: 'Bash', input_summary: 'npm test',
    });

    const after = await app.inject({ method: 'GET', url: '/api/ops/discovery-status' });
    const data = JSON.parse(after.payload).data;
    expect(data.enabled).toBe(true);
    expect(typeof data.last_observation_at).toBe('string');
    // Fresh insert → recent → green band (< 1h).
    expect(Date.now() - new Date(data.last_observation_at).getTime()).toBeLessThan(3_600_000);
  });

  it('reasoner-status reflects an armed + reachable provider', async () => {
    reasonerState = {
      armed: true, provider: 'ollama', reachable: true, model: 'qwen3:8b',
      url: 'http://localhost:11434', last_classify_at: '2026-07-10T00:00:00.000Z',
    };
    const res = await app.inject({ method: 'GET', url: '/api/ops/reasoner-status' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toMatchObject({ armed: true, reachable: true, model: 'qwen3:8b' });
  });

  it('reasoner-status reflects armed + dark (the alarm)', async () => {
    reasonerState = {
      armed: true, provider: 'ollama', reachable: false, model: 'qwen3:8b',
      url: 'http://localhost:11434', last_classify_at: null, error: 'ECONNREFUSED',
    };
    const res = await app.inject({ method: 'GET', url: '/api/ops/reasoner-status' });
    const data = JSON.parse(res.payload).data;
    expect(data.armed).toBe(true);
    expect(data.reachable).toBe(false);
    expect(data.error).toMatch(/ECONNREFUSED/);
  });
});

describe('Ops reasoner-status degrades when the closure is absent', () => {
  it('returns a disarmed status (no reasonerStatus in services)', async () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    const { runMigrations } = await import('../../src/database/migrations.js');
    runMigrations(db);
    const idx = new EmbeddingIndex();
    await idx.loadFromDatabase([]);
    const app2 = Fastify({ logger: false });
    registerRoutes(app2, {
      stores: { queries: new MemoryQueries(db) },
      services: { embeddingIndex: idx },
      lifecycle: lifecycleStub(),
    });
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: '/api/ops/reasoner-status' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toEqual({
      armed: false, provider: 'none', reachable: null, model: null, url: null, last_classify_at: null,
    });
    await app2.close();
    db.close();
  });
});
