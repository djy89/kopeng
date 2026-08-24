/**
 * Phase-4 Task 7 (CR-2) — scoped-search identity.
 *
 * POST /api/memories/search expands a requested scope through the T46 alias
 * table (same read-time semantics as recall) so an alias-scoped search reaches
 * rows stored under the canonical and vice versa. GET /api/memories stays
 * exact-match BY DEFAULT (the T46 migration driver's residual check depends on
 * it) and only widens under the opt-in `expand=aliases` query param.
 *
 * Follows the in-process-app pattern of scope-canonicalization.test.ts: real
 * ScopeAliasService over the same in-memory db acting as IOperatorConfigStore.
 * All alias fixtures are deliberately NON-case-variant pairs — SQLite scope
 * matching is COLLATE NOCASE (documented T46 exception), so a case-only pair
 * would "work" through the fold alone and never prove expansion did the work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { registerRoutes } from '../../src/api/routes.js';
import { ScopeAliasService } from '../../src/services/scope-alias.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

const CANONICAL = 'client:acme-foods';
const ALIAS = 'client:legacy-tool';
const LIST_CANONICAL = 'client:list-canonical';
const LIST_ALIAS = 'client:list-legacy';

const lifecycleStub: IDatabaseLifecycle = {
  initialize: async () => {},
  close: async () => {},
  getStats: async () => ({}) as never,
  backup: async () => '',
} as unknown as IDatabaseLifecycle;

function buildApp(withAliasService: boolean): {
  app: FastifyInstance;
  db: Database.Database;
  queries: MemoryQueries;
  scopeAliases: ScopeAliasService | undefined;
  dreamStore: DreamQueries;
} {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  const dreamStore = new DreamQueries(db);
  const scopeAliases = withAliasService ? new ScopeAliasService(dreamStore) : undefined;

  const app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries, dreams: dreamStore, operatorConfig: dreamStore },
    services: { embeddingIndex: new EmbeddingIndex(), ...(scopeAliases ? { scopeAliases } : {}) },
    lifecycle: lifecycleStub,
  } as never);
  return { app, db, queries, scopeAliases, dreamStore };
}

async function seedMemory(queries: MemoryQueries, content: string, scope: string): Promise<number> {
  const memory = await queries.store({
    content, type: 'reference', scope,
    source: null, source_path: null, metadata: '{}', embedding: null,
    embedding_model: '', created_by: null, tags: [],
  });
  return memory.id;
}

/** keyword mode + rerank:false keeps the route off the embedder and reranker. */
function searchPayload(query: string, scope: string) {
  return { query, mode: 'keyword', rerank: false, scope };
}

describe('alias expansion with the service wired', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeAll(async () => {
    const built = buildApp(true);
    app = built.app; db = built.db; queries = built.queries;
    // Same blob shape the PATCH route's server-side merge produces (a JSON
    // string — DreamQueries.updateConfig binds it straight to a SQLite column).
    await built.dreamStore.updateConfig('default', {
      config: JSON.stringify({
        scope_aliases: { [ALIAS]: CANONICAL, [LIST_ALIAS]: LIST_CANONICAL },
      }),
    });
    built.scopeAliases!.invalidate();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  describe('POST /api/memories/search', () => {
    it('an alias-scoped search finds rows stored under the canonical', async () => {
      const seeded = await seedMemory(queries, 'zynthara canonical row marker', CANONICAL);

      const res = await app.inject({
        method: 'POST', url: '/api/memories/search',
        payload: searchPayload('zynthara', ALIAS),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = (body.data as { memory: { id: number } }[]).map(r => r.memory.id);
      expect(ids).toContain(seeded);
      // R-2 (team round): the union branch discloses what it searched —
      // mirroring the list route's expand=aliases marker.
      expect((body.meta.expanded_scopes as string[]).sort())
        .toEqual([ALIAS, CANONICAL].sort());
    });

    it('a canonical-scoped search finds rows still stored under the alias (un-migrated)', async () => {
      const seeded = await seedMemory(queries, 'morvax alias row marker', ALIAS);

      const res = await app.inject({
        method: 'POST', url: '/api/memories/search',
        payload: searchPayload('morvax', CANONICAL),
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { memory: { id: number } }[]).map(r => r.memory.id);
      expect(ids).toContain(seeded);
    });

    it('an unaliased scope stays exact — no widening without a table entry', async () => {
      const alphaId = await seedMemory(queries, 'plimzor probe row one', 'project:alpha-only');
      const betaId = await seedMemory(queries, 'plimzor probe row two', 'project:beta-only');

      const res = await app.inject({
        method: 'POST', url: '/api/memories/search',
        payload: searchPayload('plimzor', 'project:alpha-only'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = (body.data as { memory: { id: number } }[]).map(r => r.memory.id);
      expect(ids).toEqual([alphaId]);
      expect(ids).not.toContain(betaId);
      // R-2: no expansion happened, so the marker is absent.
      expect(body.meta.expanded_scopes).toBeUndefined();
    });
  });

  describe('GET /api/memories?expand=aliases', () => {
    let canonId: number;
    let aliasId: number;

    beforeAll(async () => {
      canonId = await seedMemory(queries, 'list canonical row', LIST_CANONICAL);
      aliasId = await seedMemory(queries, 'list alias row', LIST_ALIAS);
    });

    it('returns rows from every scope in the alias group with meta.expanded_scopes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?scope=${encodeURIComponent(LIST_ALIAS)}&expand=aliases&fields=lite`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = (body.data as { id: number }[]).map(m => m.id);
      expect(ids).toContain(canonId);
      expect(ids).toContain(aliasId);
      expect((body.meta.expanded_scopes as string[]).sort())
        .toEqual([LIST_ALIAS, LIST_CANONICAL].sort());
    });

    it('DEFAULT (no expand param) stays exact-match — the migration residual-check contract', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?scope=${encodeURIComponent(LIST_ALIAS)}&fields=lite`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = (body.data as { id: number }[]).map(m => m.id);
      expect(ids).toContain(aliasId);
      expect(ids).not.toContain(canonId);
      expect(body.meta.expanded_scopes).toBeUndefined();
    });

    it('merges dedup by id, sorts id DESC, and slices to limit', async () => {
      const extraId = await seedMemory(queries, 'list extra canonical row', LIST_CANONICAL);
      // Group now holds canonId < aliasId < extraId — limit 2 keeps the two newest.
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?scope=${encodeURIComponent(LIST_CANONICAL)}&expand=aliases&fields=lite&limit=2`,
      });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: number }[]).map(m => m.id);
      expect(ids).toEqual([extraId, aliasId].sort((x, y) => y - x));
      expect(ids).not.toContain(canonId);
    });

    it('expand=aliases with a cursor is a 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?scope=${encodeURIComponent(LIST_ALIAS)}&expand=aliases&cursor=5`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('expand=aliases does not support cursor pagination');
    });

    it('expand=aliases without a scope is ignored (normal listing)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories?expand=aliases&fields=lite',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().meta.expanded_scopes).toBeUndefined();
    });
  });
});

describe('no alias service wired — byte-identical to today', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeAll(async () => {
    const built = buildApp(false);
    app = built.app; db = built.db; queries = built.queries;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('search with a scope stays exact-match', async () => {
    const seeded = await seedMemory(queries, 'quorvel exact row', CANONICAL);
    const otherId = await seedMemory(queries, 'quorvel other row', ALIAS);

    const res = await app.inject({
      method: 'POST', url: '/api/memories/search',
      payload: searchPayload('quorvel', CANONICAL),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = (body.data as { memory: { id: number } }[]).map(r => r.memory.id);
    expect(ids).toEqual([seeded]);
    expect(ids).not.toContain(otherId);
    // R-2: no service ⇒ never expanded ⇒ no marker.
    expect(body.meta.expanded_scopes).toBeUndefined();
  });

  it('expand=aliases is ignored without the service', async () => {
    const seeded = await seedMemory(queries, 'no-service list row', CANONICAL);
    const otherId = await seedMemory(queries, 'no-service alias row', ALIAS);

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories?scope=${encodeURIComponent(CANONICAL)}&expand=aliases&fields=lite`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = (body.data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(seeded);
    expect(ids).not.toContain(otherId);
    expect(body.meta.expanded_scopes).toBeUndefined();
  });
});
