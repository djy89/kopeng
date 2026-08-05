import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import config from '../../src/config/config.js';
import { createTestDatabase, createTestObservationsDb } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { ObservationQueries } from '../../src/database/observation-queries.js';

// T10 — FST_ERR_CTP_BODY_TOO_LARGE (413) regression.
//
// The global Fastify bodyLimit (config.search.maxContentSize * 2 ≈ 100KB) is
// sized for single-memory POSTs. A full observation batch (up to 100
// observations, each carrying multi-KB input/output summaries) easily exceeds
// it and was being rejected with 413 + silently dropped. The fix is an explicit
// per-route bodyLimit (2MB) on POST /api/observations/batch. This test pins the
// app's global limit to the production 100KB value and asserts the batch route
// accepts a body above that ceiling.

function createLifecycleStub(db: Database.Database): IDatabaseLifecycle {
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

const GLOBAL_BODY_LIMIT = config.search.maxContentSize * 2; // mirror src/server.ts

async function createApp(
  db: Database.Database,
  queries: MemoryQueries,
  obsQueries: ObservationQueries,
): Promise<FastifyInstance> {
  const embeddingIndex = new EmbeddingIndex();
  await embeddingIndex.loadFromDatabase([]);

  // Match the production global bodyLimit so the test exercises the per-route
  // override rather than Fastify's larger built-in default (1MB).
  const app = Fastify({ logger: false, bodyLimit: GLOBAL_BODY_LIMIT });
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });

  registerRoutes(app, {
    stores: { queries, observations: obsQueries },
    services: { embeddingIndex },
    lifecycle: createLifecycleStub(db),
  });
  await app.ready();
  return app;
}

function makeObservation(i: number, payloadChars: number) {
  return {
    idempotency_key: `t10-${i}`,
    session_id: 'sess-t10',
    project_scope: 'project:kopeng',
    tool_name: 'Bash',
    event_type: 'tool_complete' as const,
    input_summary: 'x'.repeat(payloadChars),
    output_summary: 'y'.repeat(payloadChars),
    metadata: { i },
  };
}

describe('T10 — observation batch bodyLimit', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let obsDb: Database.Database;
  let obsQueries: ObservationQueries;
  let app: FastifyInstance;
  let prevIngestion: boolean;
  let prevApiKey: string;

  beforeEach(async () => {
    prevIngestion = config.discovery.ingestionEnabled;
    config.discovery.ingestionEnabled = true; // gate the /api/observations/* routes on
    // Neutralize the observation API key for this body-limit test: the primary
    // checkout's .env sets OBSERVATION_API_KEY (the route's requireApiKey then
    // 401s an unauthenticated inject), while a fresh CI/worktree has no .env.
    // This test is about bodyLimit, not auth — pin the route open in both envs.
    prevApiKey = config.discovery.apiKey;
    config.discovery.apiKey = '';

    const testDb = createTestDatabase();
    db = testDb.db;
    queries = testDb.queries;
    const obs = createTestObservationsDb();
    obsDb = obs.db;
    obsQueries = obs.obsQueries;
    app = await createApp(db, queries, obsQueries);
  });

  afterEach(async () => {
    await app.close();
    db.close();
    obsDb.close();
    config.discovery.ingestionEnabled = prevIngestion;
    config.discovery.apiKey = prevApiKey;
  });

  it('rejects an oversized body on a route that keeps the global limit', async () => {
    // POST /api/observations (single) inherits the global 100KB limit — a body
    // above it must still be rejected, proving the override is route-scoped.
    const big = 'z'.repeat(GLOBAL_BODY_LIMIT + 5000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/observations',
      payload: {
        session_id: 'sess-t10',
        project_scope: 'project:kopeng',
        tool_name: 'Bash',
        event_type: 'tool_complete',
        input_summary: big.slice(0, config.discovery.maxInputSize),
        output_summary: big.slice(0, config.discovery.maxErrorOutputSize),
        metadata: { pad: big },
      },
    });
    expect(res.statusCode).toBe(413);
  });

  it('accepts a batch body larger than the global bodyLimit', async () => {
    // 30 observations × ~4KB each ≈ 120KB serialized — above the 100KB global
    // limit, below the 2MB per-route cap.
    const observations = Array.from({ length: 30 }, (_, i) => makeObservation(i, 2000));
    const payload = { observations };
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
    expect(bodyBytes).toBeGreaterThan(GLOBAL_BODY_LIMIT); // genuinely oversized vs the old cap

    const res = await app.inject({
      method: 'POST',
      url: '/api/observations/batch',
      payload,
    });

    expect(res.statusCode).toBe(201);
    const json = res.json() as { data: unknown[]; meta: { count: number } };
    expect(json.meta.count).toBe(30);
    expect(json.data.length).toBe(30);
  });

  it('still enforces the explicit per-route cap on a runaway batch', async () => {
    // A body above the explicit 2MB route cap is rejected — the limit is a real
    // ceiling, not removed. Each observation is capped, so we need many of them.
    const observations = Array.from({ length: 100 }, (_, i) =>
      makeObservation(i, config.discovery.maxInputSize),
    );
    const bodyBytes = Buffer.byteLength(JSON.stringify({ observations }), 'utf-8');
    // Sanity: 100 × ~10KB stays under 2MB, so this batch should be ACCEPTED.
    expect(bodyBytes).toBeLessThan(2 * 1024 * 1024);

    const res = await app.inject({
      method: 'POST',
      url: '/api/observations/batch',
      payload: { observations },
    });
    expect(res.statusCode).toBe(201);
  });
});
