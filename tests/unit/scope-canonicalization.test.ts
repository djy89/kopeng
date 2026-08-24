/**
 * T46 scope-alias layer — Task 2 wiring tests.
 *
 * Exercises the ScopeAliasService (Task 1) wired into the live routes: every
 * mutating memory/slot route canonicalizes an incoming alias scope before it
 * hits the store, recall expands a requested scope to its alias group so
 * un-migrated rows and post-migration rows are both reachable, and the
 * operator-config PATCH invalidates the service's cache so a freshly-added
 * alias takes effect immediately (no 60s TTL wait).
 *
 * Follows the in-process-app pattern of core-crud-auth.test.ts, but wires a
 * REAL ScopeAliasService (DreamQueries over the same in-memory db acting as
 * the IOperatorConfigStore) so the wiring itself is under test, not a mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { registerRoutes } from '../../src/api/routes.js';
import { ScopeAliasService } from '../../src/services/scope-alias.js';
import config from '../../src/config/config.js';
import { adminHeaders } from '../fixtures/test-helpers.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

// The recall handler short-circuits to `[]` when isEmbedderReady() is false
// (true in unit tests, since the real model never loads). Mocking just the two
// readiness/embed exports lets the FTS leg do the matching deterministically,
// while every other export (embedWithModel, embeddingToBuffer,
// bufferToEmbedding, initEmbedder) stays real via importOriginal — routes.ts
// uses those too and they're pure/model-independent.
vi.mock('../../src/embeddings/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/embeddings/embedder.js')>();
  return {
    ...actual,
    isEmbedderReady: () => true,
    embed: async () => new Float32Array(384),
  };
});

const KEY = 'test-admin-key';

let app: FastifyInstance;
let db: Database.Database;
let queries: MemoryQueries;
let dreamStore: DreamQueries;
let scopeAliases: ScopeAliasService;
let prevKey = '';

/** Seed the operator_config `config` blob's scope_aliases key directly through
 * the store, in the SAME shape the PATCH route's server-side merge produces
 * (a JSON-stringified blob — DreamQueries.updateConfig binds `config` straight
 * to a SQLite column, so it must be a string, not an object). Bypasses the
 * route so these fixtures aren't exercising the thing under test in the PATCH
 * describe block below. */
async function seedAliases(map: Record<string, string>): Promise<void> {
  await dreamStore.updateConfig('default', { config: JSON.stringify({ scope_aliases: map }) });
  scopeAliases.invalidate();
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  queries = new MemoryQueries(db);
  dreamStore = new DreamQueries(db);
  scopeAliases = new ScopeAliasService(dreamStore);

  const embeddingIndex = new EmbeddingIndex();
  const lifecycle: IDatabaseLifecycle = {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;

  app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries, dreams: dreamStore, operatorConfig: dreamStore },
    services: { embeddingIndex, scopeAliases },
    lifecycle,
  } as never);
  await app.ready();
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

describe('write-time canonicalization', () => {
  beforeAll(async () => {
    await seedAliases({ 'client:Acme-Foods': 'client:acme-foods' });
  });

  it('POST /api/memories stores the canonical scope when an alias is sent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memories', headers: adminHeaders(),
      payload: { content: 'alias write test', type: 'project', scope: 'client:Acme-Foods' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.scope).toBe('client:acme-foods');
  });

  it('POST /api/memories/batch canonicalizes each item', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memories/batch', headers: adminHeaders(),
      payload: { memories: [
        { content: 'batch alias one', scope: 'client:Acme-Foods' },
        { content: 'batch plain two', scope: 'project:untouched' },
      ] },
    });
    expect(res.statusCode).toBe(200);
    const [a, b] = res.json().data.ids as number[];
    expect((await queries.get(a))!.scope).toBe('client:acme-foods');
    expect((await queries.get(b))!.scope).toBe('project:untouched');
  });

  it('PUT /api/memories/:id canonicalizes a scope change', async () => {
    const seeded = await queries.store({
      content: 'put alias seed', type: 'reference', scope: 'global',
      source: null, source_path: null, metadata: '{}', embedding: null,
      embedding_model: '', created_by: null, tags: [],
    });

    const res = await app.inject({
      method: 'PUT', url: `/api/memories/${seeded.id}`, headers: adminHeaders(),
      payload: { scope: 'client:Acme-Foods' },
    });
    expect(res.statusCode).toBe(200);
    expect((await queries.get(seeded.id))!.scope).toBe('client:acme-foods');
  });

  it('PUT /api/memories/:id leaves an unmapped scope unchanged', async () => {
    const seeded = await queries.store({
      content: 'put unmapped seed', type: 'reference', scope: 'global',
      source: null, source_path: null, metadata: '{}', embedding: null,
      embedding_model: '', created_by: null, tags: [],
    });

    const res = await app.inject({
      method: 'PUT', url: `/api/memories/${seeded.id}`, headers: adminHeaders(),
      payload: { scope: 'project:untouched-put' },
    });
    expect(res.statusCode).toBe(200);
    expect((await queries.get(seeded.id))!.scope).toBe('project:untouched-put');
  });

  it('POST /api/slots canonicalizes the scope on create', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/slots', headers: adminHeaders(),
      payload: { slot_key: 'alias-slot', content: 'slot content', type: 'reference', scope: 'client:Acme-Foods' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.scope).toBe('client:acme-foods');
  });

  it('PUT /api/slots/:slot_key canonicalizes the scope on update', async () => {
    const seedRes = await app.inject({
      method: 'POST', url: '/api/slots', headers: adminHeaders(),
      payload: { slot_key: 'alias-slot-2', content: 'slot content 2', type: 'reference', scope: 'global' },
    });
    expect(seedRes.statusCode).toBe(201);

    const updateRes = await app.inject({
      method: 'PUT', url: '/api/slots/alias-slot-2', headers: adminHeaders(),
      payload: { scope: 'client:Acme-Foods' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().data.scope).toBe('client:acme-foods');
  });

  it('an unmapped scope on POST /api/memories passes through unchanged', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memories', headers: adminHeaders(),
      payload: { content: 'unmapped scope test', type: 'reference', scope: 'project:untouched-2' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.scope).toBe('project:untouched-2');
  });
});

describe('read-time expansion in recall', () => {
  // Deliberately NOT a case-only difference from its canonical — memory scope
  // matching is COLLATE NOCASE at the DB layer (queries.ts), so a case-only
  // alias pair (like the write-time fixture above) would appear to "work" via
  // that collation alone and never actually exercise expand().
  const CANONICAL = 'client:acme-corp';
  const ALIAS = 'client:acme-legacy-co';
  // A second alias pair with NO memories stored under either side — used to
  // regression-test the single-scope global fallback (see below).
  const EMPTY_ALIAS = 'client:acme-zzz-alias';
  const EMPTY_CANONICAL = 'client:acme-zzz-canonical';

  beforeAll(async () => {
    await seedAliases({
      'client:Acme-Foods': 'client:acme-foods',
      [ALIAS]: CANONICAL,
      [EMPTY_ALIAS]: EMPTY_CANONICAL,
    });
  });

  it('recall with the canonical scope finds rows still stored under the alias (un-migrated)', async () => {
    const seeded = await queries.store({
      content: 'zorblatt pre-migration content marker', type: 'reference', scope: ALIAS,
      source: null, source_path: null, metadata: '{}', embedding: null,
      embedding_model: '', created_by: null, tags: [],
    });

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: { query: 'zorblatt', scopes: [CANONICAL] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(seeded.id);
  });

  it('recall with the alias scope finds rows stored under the canonical (post-migration writers)', async () => {
    const seeded = await queries.store({
      content: 'wibbleflorp post-migration content marker', type: 'reference', scope: CANONICAL,
      source: null, source_path: null, metadata: '{}', embedding: null,
      embedding_model: '', created_by: null, tags: [],
    });

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: { query: 'wibbleflorp', scopes: [ALIAS] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(seeded.id);
  });

  it('recall with an unaliased scope behaves exactly as before (identity expansion)', async () => {
    const seeded = await queries.store({
      content: 'quibnorf unaliased scope marker', type: 'reference', scope: 'project:untouched-recall',
      source: null, source_path: null, metadata: '{}', embedding: null,
      embedding_model: '', created_by: null, tags: [],
    });

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: { query: 'quibnorf', scopes: ['project:untouched-recall'] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(seeded.id);
  });

  it('a single aliased scope with no memories anywhere in its alias group still falls back to global (regression)', async () => {
    // Registering an alias for a scope must not disable the documented
    // single-scope global fallback (CLAUDE.md: recall "falls back to global
    // scope only"). Before the fix, expand()'ing a single requested scope
    // pushed the request into the multi-scope union branch the moment ANY
    // alias existed for it, and an empty union there returns [] with no
    // retry against global.
    const seeded = await queries.store({
      content: 'quazzlemer global fallback marker', type: 'reference', scope: 'global',
      source: null, source_path: null, metadata: '{}', embedding: null,
      embedding_model: '', created_by: null, tags: [],
    });

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: { query: 'quazzlemer', scopes: [EMPTY_CANONICAL] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(seeded.id);
  });
});

describe('PATCH /api/operator-config invalidates the alias cache', () => {
  it('a new alias takes effect on the next write without waiting out the TTL', async () => {
    // Warm the cache first so this test proves invalidate() works, regardless
    // of whether an earlier test in the file already happened to warm it.
    await scopeAliases.canonicalize('noop-warm-cache-scope');

    const patchRes = await app.inject({
      method: 'PATCH', url: '/api/operator-config', headers: adminHeaders(),
      payload: { config: { scope_aliases: { 'project:Old-Name': 'project:old-name' } } },
    });
    expect(patchRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: '/api/memories', headers: adminHeaders(),
      payload: { content: 'patch invalidation test', type: 'reference', scope: 'project:Old-Name' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.scope).toBe('project:old-name');
  });
});
