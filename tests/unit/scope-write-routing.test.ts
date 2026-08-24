/**
 * Phase 3 (Task 5): registry-aware write routing at the API choke points.
 *
 * The silent-global leak is closed: a scopeless POST no longer defaults to
 * `global` via the Zod schema — it lands in the operator's primary scope, or
 * the reserved triage scope `project:_unrouted` when no primary is set, with
 * the routing surfaced in the response meta. Malformed explicit scopes are
 * captured (stored under primary/_unrouted with metadata.raw_scope preserved),
 * explicit `global` stays a deliberate act, and a NEW valid scope mints a
 * provisional registry row under its slug form.
 *
 * App built in-process the same way core-crud-auth.test.ts does; registry
 * assertions go through a directly-constructed ScopeRegistryQueries over the
 * same in-memory db. Expected strings are PINNED, never derived.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

let app: FastifyInstance;
let db: Database.Database;
let registryStore: ScopeRegistryQueries;
let prevKey = '';

async function buildApp(): Promise<void> {
  db = new Database(':memory:');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  const dreamQueries = new DreamQueries(db);
  registryStore = new ScopeRegistryQueries(db);

  // Mirror server.ts's boot seed of the reserved triage scope (idempotent).
  await registryStore.register({
    scope: 'project:_unrouted',
    slug: 'project:unrouted',
    claimant_raw: 'project:_unrouted',
    origin_cwd: null,
    status: 'confirmed',
    reserved: true,
  });

  // Wired like server.ts — the alias table (operator_config.config.scope_aliases)
  // is empty by default, so this is identity unless a test PATCHes a table in.
  const scopeAliases = new ScopeAliasService(dreamQueries);
  const scopeRegistry = new ScopeRegistryService({
    registry: registryStore,
    configStore: dreamQueries,
    // CO1 mirror of server.ts: the primary scope canonicalizes at load.
    canonicalize: (s: string) => scopeAliases.canonicalize(s),
  });

  const lifecycle: IDatabaseLifecycle = {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;

  app = Fastify({ logger: false });
  // Mirror the production Zod error handler from server.ts (400, not 500).
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });
  registerRoutes(app, {
    stores: { queries, operatorConfig: dreamQueries },
    services: { embeddingIndex: new EmbeddingIndex(), scopeAliases, scopeRegistry },
    lifecycle,
  } as never);
  await app.ready();
}

beforeEach(async () => {
  prevKey = config.server.adminApiKey;
  config.server.adminApiKey = ''; // open dev mode — auth is core-crud-auth's suite
  await buildApp();
});

afterEach(async () => {
  config.server.adminApiKey = prevKey;
  await app.close();
  db.close();
});

describe('registry-aware write routing (Phase 3 Task 5)', () => {
  it('scopeless POST /api/memories lands in _unrouted with meta.scope_defaulted when no primary is set', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a scopeless write with no primary configured', type: 'reference' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('project:_unrouted');
    expect(body.meta.scope_defaulted).toEqual({
      stored_as: 'project:_unrouted',
      primary_scope_set: false,
    });
    expect(body.meta.scope_rerouted).toBeUndefined();
  });

  it('scopeless POST lands in the primary scope when operator_config.primary_scope is set', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: { primary_scope: 'project:my-project' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.primary_scope).toBe('project:my-project');

    // GET reflects the column too (brief step 3.4).
    const got = await app.inject({ method: 'GET', url: '/api/operator-config' });
    expect(got.json().data.primary_scope).toBe('project:my-project');

    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a scopeless write with a primary configured', type: 'reference' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('project:my-project');
    expect(body.meta.scope_defaulted).toEqual({
      stored_as: 'project:my-project',
      primary_scope_set: true,
    });
  });

  it('malformed explicit scope is captured: 201, stored under primary/_unrouted, metadata.raw_scope preserved, meta.scope_rerouted present', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a write carrying a malformed scope', type: 'reference', scope: 'status:archived' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('project:_unrouted');
    expect(body.meta.scope_rerouted).toEqual({
      raw: 'status:archived',
      stored_as: 'project:_unrouted',
      reason: 'malformed',
    });
    expect(JSON.parse(body.data.metadata).raw_scope).toBe('status:archived');
  });

  it('explicit scope "global" stays global — no reroute, no registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a deliberate explicit global write', type: 'reference', scope: 'global' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('global');
    expect(body.meta.scope_rerouted).toBeUndefined();
    expect(body.meta.scope_defaulted).toBeUndefined();

    // Registry untouched: only the seeded reserved row exists.
    const rows = await registryStore.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('project:_unrouted');
    expect(rows[0].reserved).toBe(true);
  });

  it('primary_scope set to an alias-table KEY canonicalizes: scopeless POST lands on the canonical scope', async () => {
    // Fix round 1 finding 1: the highest-volume default path must not
    // accumulate rows on a non-canonical alias variant (T46).
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: {
        primary_scope: 'client:Acme-Foods',
        config: { scope_aliases: { 'client:Acme-Foods': 'client:acme-foods' } },
      },
    });
    expect(patch.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a scopeless write with an aliased primary', type: 'reference' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('client:acme-foods');
    expect(body.meta.scope_defaulted).toEqual({
      stored_as: 'client:acme-foods',
      primary_scope_set: true,
    });
  });

  it('a MALFORMED explicit scope with an aliased primary lands on the CANONICAL too (round-2 CO1)', async () => {
    // Fix round 1 canonicalized the primary in the scopeless branch ONLY, so
    // decideMint's Rule-2 reroute still used the alias KEY — the two triage
    // paths fragmented the same primary. The service now canonicalizes the
    // primary at load, so both paths agree.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: {
        primary_scope: 'client:Acme-Foods',
        config: { scope_aliases: { 'client:Acme-Foods': 'client:acme-foods' } },
      },
    });
    expect(patch.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a malformed-scope write with an aliased primary', type: 'reference', scope: 'status:archived' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('client:acme-foods');
    expect(body.meta.scope_rerouted).toEqual({
      raw: 'status:archived',
      stored_as: 'client:acme-foods',
      reason: 'malformed',
    });
    expect(JSON.parse(body.data.metadata).raw_scope).toBe('status:archived');
  });

  it('PATCH primary_scope rejects a non-scope-form value with 400; null clears with 200', async () => {
    // Fix round 1 finding 2: a value routing would silently ignore must not 200.
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: { primary_scope: 'not-a-scope' },
    });
    expect(bad.statusCode).toBe(400);

    const set = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: { primary_scope: 'project:my-project' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().data.primary_scope).toBe('project:my-project');

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: { primary_scope: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.primary_scope).toBeNull();

    // Routing reflects the clear: scopeless writes fall back to the triage scope.
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a scopeless write after the primary was cleared', type: 'reference' },
    });
    expect(res.json().data.scope).toBe('project:_unrouted');
  });

  it("batch envelope meta reports counts + last, never one item's routing as the batch's", async () => {
    // Fix round 1 finding 3. The durable per-row record stays metadata.raw_scope.
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories/batch',
      payload: {
        memories: [
          { content: 'batch item with a malformed scope', type: 'reference', scope: 'status:archived' },
          { content: 'batch item with another malformed scope', type: 'reference', scope: 'not-a-scope' },
          { content: 'scopeless batch item', type: 'reference' },
          { content: 'explicit global batch item', type: 'reference', scope: 'global' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json().meta;
    expect(meta.scope_rerouted).toEqual({
      count: 2,
      last: { raw: 'not-a-scope', stored_as: 'project:_unrouted', reason: 'malformed' },
    });
    expect(meta.scope_defaulted).toEqual({
      count: 1,
      last: { stored_as: 'project:_unrouted', primary_scope_set: false },
    });

    // Per-row durable record on the second rerouted item.
    const ids = res.json().data.ids as number[];
    const row = await app.inject({ method: 'GET', url: `/api/memories/${ids[1]}` });
    expect(row.json().data.scope).toBe('project:_unrouted');
    expect(JSON.parse(row.json().data.metadata).raw_scope).toBe('not-a-scope');
  });

  it('a NEW valid scope mints: stored under slug form, registry row provisional', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a write claiming a brand-new scope', type: 'reference', scope: 'project:My-Project' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.scope).toBe('project:my-project');
    expect(body.meta.scope_rerouted).toBeUndefined();

    const rows = await registryStore.listAll();
    const minted = rows.find((r) => r.scope === 'project:my-project');
    expect(minted).toBeDefined();
    expect(minted!.status).toBe('provisional');
    expect(minted!.claimant_raw).toBe('project:My-Project');
    expect(minted!.slug).toBe('project:my-project');
    expect(minted!.reserved).toBe(false);
    expect(minted!.origin_cwd).toBeNull();
  });
});
