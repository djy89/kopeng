/**
 * Core-CRUD admin gate (sweep-3 PB-2).
 *
 * Before this, ADMIN_API_KEY covered only the operator endpoints — memory
 * create/update/archive, slots, context and artifacts had NO auth handler at
 * all. On the old wildcard bind default that meant anyone who could reach the
 * port could rewrite the corpus, and injected memories get recalled into a
 * model's context on later prompts: prompt injection with persistence.
 *
 * Two properties are pinned here, and the second matters as much as the first:
 *   1. every mutating route rejects a missing/wrong key;
 *   2. the POST-shaped READS stay open — the recall hooks call
 *      /api/memories/recall and /search on every prompt with no key, so gating
 *      them would silently break recall for every client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ScopeRegistryQueries } from '../../src/database/scope-registry-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import { ScopeRegistryService } from '../../src/services/scope-registry.js';
import { ScopeAliasService } from '../../src/services/scope-alias.js';
import config from '../../src/config/config.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

// CX-13: POST /api/memories/traverse is registered only inside the
// `if (config.neo4j.enabled)` block (routes.ts) and its handler opens a real
// Neo4j session. To pin its auth posture WITHOUT a Neo4j instance — and
// without the vacuous pass where an unregistered route 404s and 404 !== 401
// trivially holds — the graph dependencies are stubbed so the route can be
// REGISTERED and answer for real.
vi.mock('../../src/graph/neo4j.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/graph/neo4j.js')>();
  return {
    ...actual,
    getSession: () => ({ close: async () => {} }),
  };
});
vi.mock('../../src/graph/graph-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/graph/graph-queries.js')>();
  return {
    ...actual,
    traverseEntity: async () => ({
      entity: 'deploys', entityType: 'unknown', connectedMemoryIds: [], relatedEntities: [],
    }),
  };
});

const KEY = 'test-admin-key';

let app: FastifyInstance;
let db: Database.Database;
let queries: MemoryQueries;
let seededId = 0;
let prevKey = '';
let prevNeo4jEnabled = false;

beforeAll(async () => {
  // Route registration happens once, inside registerRoutes — the flag must be
  // on BEFORE that call for the traverse route to exist at all.
  prevNeo4jEnabled = config.neo4j.enabled;
  config.neo4j.enabled = true;

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  queries = new MemoryQueries(db);
  const embeddingIndex = new EmbeddingIndex();
  const lifecycle: IDatabaseLifecycle = {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;

  app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries },
    services: { embeddingIndex },
    lifecycle,
  } as never);
  await app.ready();

  const seeded = await queries.store({
    content: 'seed memory for the auth gate test',
    type: 'reference',
    scope: 'global',
    source: null,
    source_path: null,
    metadata: '{}',
    embedding: null,
    embedding_model: '',
    created_by: null,
    tags: [],
  });
  seededId = seeded.id;
});

afterAll(async () => {
  config.neo4j.enabled = prevNeo4jEnabled;
  await app.close();
  db.close();
});

beforeEach(() => {
  prevKey = config.server.adminApiKey;
  config.server.adminApiKey = KEY;
});

afterEach(() => {
  config.server.adminApiKey = prevKey;
});

/** Every route that mutates state and must therefore be gated. */
const MUTATING: Array<{ method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: () => string; payload?: unknown }> = [
  { method: 'POST', url: () => '/api/memories', payload: { content: 'injected by an unauthenticated caller', type: 'reference', scope: 'global' } },
  { method: 'POST', url: () => '/api/memories/batch', payload: { memories: [{ content: 'bulk injection', type: 'reference', scope: 'global' }] } },
  { method: 'PUT', url: () => `/api/memories/${seededId}`, payload: { content: 'overwritten' } },
  { method: 'PATCH', url: () => `/api/memories/${seededId}`, payload: { archived: true } },
  { method: 'POST', url: () => `/api/memories/${seededId}/archive`, payload: { archive: true } },
  { method: 'POST', url: () => '/api/slots', payload: { slot_key: 'x', content: 'y' } },
  { method: 'PUT', url: () => '/api/slots/x', payload: { content: 'y' } },
  { method: 'DELETE', url: () => '/api/slots/x' },
];

describe('core CRUD is admin-key gated', () => {
  for (const route of MUTATING) {
    it(`${route.method} ${route.url().replace(/\d+/, ':id')} rejects a missing key`, async () => {
      const res = await app.inject({ method: route.method, url: route.url(), payload: route.payload as never });
      expect(res.statusCode).toBe(401);
    });

    it(`${route.method} ${route.url().replace(/\d+/, ':id')} rejects a wrong key`, async () => {
      const res = await app.inject({
        method: route.method, url: route.url(), headers: { 'x-api-key': 'nope' }, payload: route.payload as never,
      });
      expect(res.statusCode).toBe(401);
    });
  }

  it('accepts the correct key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memories', headers: { 'x-api-key': KEY },
      payload: { content: 'stored by an authenticated caller', type: 'reference', scope: 'global' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('is open when no key is configured (dev mode posture)', async () => {
    config.server.adminApiKey = '';
    const res = await app.inject({
      method: 'POST', url: '/api/memories',
      payload: { content: 'dev mode, no key configured', type: 'reference', scope: 'global' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('POST-shaped reads stay open (the recall hooks send no key)', () => {
  // A regression here breaks memory recall for every client, silently — the
  // hooks fail closed to "no memories" rather than surfacing an auth error.
  // The not-404 assertion guards the vacuous pass: an unregistered route
  // 404s, and 404 !== 401 would hold trivially.
  const OPEN_READS: Array<{ url: string; payload: unknown }> = [
    { url: '/api/memories/recall', payload: { query: 'seed memory' } },
    { url: '/api/memories/search', payload: { query: 'seed memory' } },
    { url: '/api/surface', payload: { prompt: 'which tools help with deploys' } },
  ];
  for (const { url, payload } of OPEN_READS) {
    it(`${url} does not require a key`, async () => {
      const res = await app.inject({ method: 'POST', url, payload: payload as never });
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).not.toBe(401);
    });

    it(`${url} does not 401 on a wrong key either`, async () => {
      const res = await app.inject({
        method: 'POST', url, headers: { 'x-api-key': 'nope' }, payload: payload as never,
      });
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).not.toBe(401);
    });
  }

  it('GET /api/memories does not require a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memories?limit=5' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/memories/traverse stays open (CX-13 — registration proven, not assumed)', () => {
  // Registration is conditional on config.neo4j.enabled (see the vi.mock note
  // at the top): with the flag forced on and the session/traverseEntity
  // dependencies stubbed, the route answers for real — so the not-404
  // assertion kills the vacuous pass where a never-registered route would
  // satisfy `not 401` by 404ing.
  const payload = { entity: 'deploys' };

  it('is registered (not 404) and does not require a key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/memories/traverse', payload });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('does not 401 on a wrong key either', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memories/traverse', headers: { 'x-api-key': 'nope' }, payload,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('scope-registry admin routes (T76) are gated — a separate app, since both routes register only inside `if (operatorConfigStore) { if (scopeRegistry) { ... } }`', () => {
  // Both routes are conditionally registered — without wiring operatorConfig +
  // scopeRegistry the vacuous pass (404 !== 401 trivially holding) is live, the
  // same trap the CX-13 traverse block above guards against. A separate,
  // minimal app avoids reshaping the shared MUTATING harness above just to
  // thread these two extra deps through every other case.
  let scopeApp: FastifyInstance;
  let scopeDb: Database.Database;
  let registryStore: ScopeRegistryQueries;
  let scopedPrevKey = '';

  beforeAll(async () => {
    scopeDb = new Database(':memory:');
    runMigrations(scopeDb);
    const scopeQueries = new MemoryQueries(scopeDb);
    const dreamQueries = new DreamQueries(scopeDb);
    registryStore = new ScopeRegistryQueries(scopeDb);
    const scopeRegistry = new ScopeRegistryService({ registry: registryStore, configStore: dreamQueries });
    const scopeAliases = new ScopeAliasService(dreamQueries);
    const lifecycle: IDatabaseLifecycle = {
      initialize: async () => {},
      close: async () => {},
      getStats: async () => ({}) as never,
      backup: async () => '',
    } as unknown as IDatabaseLifecycle;

    scopeApp = Fastify({ logger: false });
    registerRoutes(scopeApp, {
      stores: { queries: scopeQueries, operatorConfig: dreamQueries, dreams: dreamQueries },
      services: { embeddingIndex: new EmbeddingIndex(), scopeAliases, scopeRegistry },
      lifecycle,
    } as never);
    await scopeApp.ready();

    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:my-project', origin_cwd: null, status: 'provisional',
    });
  });

  afterAll(async () => {
    await scopeApp.close();
    scopeDb.close();
  });

  beforeEach(() => {
    scopedPrevKey = config.server.adminApiKey;
    config.server.adminApiKey = KEY;
  });

  afterEach(() => {
    config.server.adminApiKey = scopedPrevKey;
  });

  const SCOPE_MUTATING: Array<{ url: string; payload: unknown }> = [
    { url: '/api/admin/scopes/rule', payload: { scope: 'project:my-project', action: 'confirm' } },
    { url: '/api/admin/scopes/archive-ephemeral', payload: { scope: 'project:20260901-demo' } },
  ];

  for (const route of SCOPE_MUTATING) {
    it(`POST ${route.url} rejects a missing key (registered, not 404)`, async () => {
      const res = await scopeApp.inject({ method: 'POST', url: route.url, payload: route.payload as never });
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(401);
    });

    it(`POST ${route.url} rejects a wrong key`, async () => {
      const res = await scopeApp.inject({
        method: 'POST', url: route.url, headers: { 'x-api-key': 'nope' }, payload: route.payload as never,
      });
      expect(res.statusCode).toBe(401);
    });

    it(`POST ${route.url} accepts the correct key`, async () => {
      const res = await scopeApp.inject({
        method: 'POST', url: route.url, headers: { 'x-api-key': KEY }, payload: route.payload as never,
      });
      expect(res.statusCode).not.toBe(401);
    });
  }
});
