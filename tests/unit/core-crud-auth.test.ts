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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import config from '../../src/config/config.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

const KEY = 'test-admin-key';

let app: FastifyInstance;
let db: Database.Database;
let queries: MemoryQueries;
let seededId = 0;
let prevKey = '';

beforeAll(async () => {
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
  for (const url of ['/api/memories/recall', '/api/memories/search']) {
    it(`${url} does not require a key`, async () => {
      const res = await app.inject({ method: 'POST', url, payload: { query: 'seed memory' } });
      expect(res.statusCode).not.toBe(401);
    });
  }

  it('GET /api/memories does not require a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memories?limit=5' });
    expect(res.statusCode).toBe(200);
  });
});
