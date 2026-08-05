import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

// Enable Neo4j via env BEFORE importing config / routes so the conditional
// `if (config.neo4j.enabled)` branch in registerRoutes evaluates true.
vi.stubEnv('NEO4J_ENABLED', 'true');
vi.stubEnv('NEO4J_PASSWORD', 'test-password');

// Mock the Neo4j session factory. Each test resets the canned records so we
// can assert the helper's transformation logic and the route's filter wiring.
const sessionState: { records: unknown[]; lastParams: Record<string, unknown> | null } = {
  records: [],
  lastParams: null,
};

vi.mock('../../src/graph/neo4j.js', () => ({
  getSession: () => ({
    run: async (_cypher: string, params: Record<string, unknown>) => {
      sessionState.lastParams = params;
      return {
        records: sessionState.records.map((r) => ({
          get: (key: string) => (r as Record<string, unknown>)[key],
        })),
      };
    },
    close: async () => {},
  }),
}));

const { default: config } = await import('../../src/config/config.js');
const { registerRoutes } = await import('../../src/api/routes.js');

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

describe('GET /api/graph/edges', () => {
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

    // Force-enable Neo4j on the imported config object — vi.stubEnv only
    // affects process.env, but config is captured at import time.
    config.neo4j.enabled = true;

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

  it('returns bipartite shape: entities + memory→entity links', async () => {
    sessionState.records = [
      { name: 'neo4j', type: 'technology', memoryCount: 3, memIds: [101, 102, 103] },
      { name: 'kopeng', type: 'project', memoryCount: 2, memIds: [101, 104] },
    ];

    const res = await app.inject({ method: 'GET', url: '/api/graph/edges?min=2&max=50' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(body.data.entities).toHaveLength(2);
    expect(body.data.entities[0]).toEqual({ name: 'neo4j', type: 'technology', memoryCount: 3 });
    expect(body.data.links).toHaveLength(5);
    expect(body.data.links).toContainEqual({ memoryId: 101, entityName: 'neo4j' });
    expect(body.data.links).toContainEqual({ memoryId: 104, entityName: 'kopeng' });
    expect(body.meta.entity_count).toBe(2);
    expect(body.meta.link_count).toBe(5);
  });

  it('passes min/max/scope/type/entity_types to the Cypher query', async () => {
    sessionState.records = [];
    sessionState.lastParams = null;

    const res = await app.inject({
      method: 'GET',
      url: '/api/graph/edges?min=3&max=20&scope=project:kopeng&type=project&entity_types=technology,concept',
    });
    expect(res.statusCode).toBe(200);

    expect(sessionState.lastParams).toEqual({
      min: 3,
      max: 20,
      scope: 'project:kopeng',
      memType: 'project',
      entityTypes: ['technology', 'concept'],
    });
  });

  it('applies sane defaults when no params given', async () => {
    sessionState.records = [];
    sessionState.lastParams = null;

    const res = await app.inject({ method: 'GET', url: '/api/graph/edges' });
    expect(res.statusCode).toBe(200);

    expect(sessionState.lastParams).toMatchObject({ min: 2, max: 50, scope: null, memType: null, entityTypes: null });
  });

  it('rejects invalid min/max combinations', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/graph/edges?min=10&max=5' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.error).toMatch(/min must be/);
  });

  it('rejects invalid memory type via Zod', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/graph/edges?type=bogus' });
    expect(res.statusCode).toBe(400);
  });

  it('handles empty result set', async () => {
    sessionState.records = [];
    const res = await app.inject({ method: 'GET', url: '/api/graph/edges?min=2&max=50' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.entities).toEqual([]);
    expect(body.data.links).toEqual([]);
  });
});
