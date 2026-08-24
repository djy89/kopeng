/**
 * Phase 3 (Task 11): operator ruling endpoint — POST /api/admin/scopes/rule.
 *
 * The endpoint RECORDS a ruling (confirm / merge_into / rename); it never
 * migrates rows or re-drives held observations behind the operator's back
 * (spec §12) — those are returned as meta.follow_ups command strings, pinned
 * verbatim here. merge_into / rename append their alias entry through the SAME
 * serialized configPatchChain as PATCH /api/operator-config (T26), and the
 * would-be table is validated through the shared buildScopeResolution first —
 * a rejected entry (chain/self-map/capture) is a 400 that leaves scope_aliases
 * byte-identical.
 *
 * App built in-process the same way scope-write-routing.test.ts does; registry
 * assertions go through a directly-constructed ScopeRegistryQueries over the
 * same in-memory db. Expected strings are PINNED, never derived.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
let dreamQueries: DreamQueries;
let registryStore: ScopeRegistryQueries;
let prevKey = '';

async function buildApp(): Promise<void> {
  db = new Database(':memory:');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  dreamQueries = new DreamQueries(db);
  registryStore = new ScopeRegistryQueries(db);

  const scopeRegistry = new ScopeRegistryService({
    registry: registryStore,
    configStore: dreamQueries,
  });
  const scopeAliases = new ScopeAliasService(dreamQueries);

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

async function rule(payload: Record<string, unknown>, headers?: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/admin/scopes/rule', payload, headers });
}

/** The stored scope_aliases table, exactly as the config blob holds it. */
async function storedAliases(): Promise<unknown> {
  const res = await app.inject({ method: 'GET', url: '/api/operator-config' });
  if (res.statusCode === 404) return undefined; // not seeded yet
  const blob = JSON.parse(res.json().data.config ?? '{}');
  return blob.scope_aliases;
}

async function registryRow(scope: string) {
  const rows = await registryStore.listAll();
  return rows.find((r) => r.scope === scope);
}

beforeEach(async () => {
  prevKey = config.server.adminApiKey;
  config.server.adminApiKey = ''; // open dev mode — the auth test arms it per-request
  await buildApp();
});

afterEach(async () => {
  config.server.adminApiKey = prevKey;
  await app.close();
  db.close();
});

describe('POST /api/admin/scopes/rule (Phase 3 Task 11)', () => {
  it('confirm marks the registry row confirmed with a ruled_at stamp; no follow-ups', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My-Project', origin_cwd: null, status: 'provisional',
    });

    const res = await rule({ scope: 'project:my-project', action: 'confirm' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      scope: 'project:my-project',
      action: 'confirm',
      status: 'confirmed',
      ruled_at: body.data.ruled_at,
    });
    expect(typeof body.data.ruled_at).toBe('string');
    expect(body.meta).toBeUndefined();

    const row = await registryRow('project:my-project');
    expect(row!.status).toBe('confirmed');
    expect(row!.ruled_at).not.toBeNull();
  });

  it('merge_into appends the alias via the serialized chain, confirms the row, registers the target, and returns the follow-ups verbatim', async () => {
    await registryStore.register({
      scope: 'client:Acme-Foods', slug: 'client:acme-foods',
      claimant_raw: 'client:Acme-Foods', origin_cwd: null, status: 'provisional',
    });

    // Warm the alias-service cache so the post-ruling write below actually
    // proves scopeAliases.invalidate() ran (a cold cache would pass anyway).
    const warm = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a warm-up write before the ruling', type: 'reference', scope: 'global' },
    });
    expect(warm.statusCode).toBe(201);

    const res = await rule({ scope: 'client:Acme-Foods', action: 'merge_into', target: 'client:acme-foods' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      scope: 'client:Acme-Foods',
      action: 'merge_into',
      target: 'client:acme-foods',
      status: 'confirmed',
      ruled_at: body.data.ruled_at,
    });
    expect(body.meta.follow_ups).toEqual([
      'npm run migrate:scope-aliases -- --only client:Acme-Foods (dry-run first)',
      'POST /api/admin/discovery/redrive {"scope": "client:Acme-Foods"} (if this scope has held observations)',
    ]);

    // The alias entry landed in the config blob.
    expect(await storedAliases()).toEqual({ 'client:Acme-Foods': 'client:acme-foods' });

    // The ruled row is confirmed; the target got its own confirmed registry row
    // (without one, the canonical's next write would slug-collide with the
    // merged row and quarantine — the ruling must not plant that trap).
    const merged = await registryRow('client:Acme-Foods');
    expect(merged!.status).toBe('confirmed');
    expect(merged!.ruled_at).not.toBeNull();
    const target = await registryRow('client:acme-foods');
    expect(target).toBeDefined();
    expect(target!.status).toBe('confirmed');
    expect(target!.claimant_raw).toBe('client:acme-foods');
    expect(target!.reserved).toBe(false);

    // The ruling is live immediately (both caches invalidated): a write naming
    // the alias lands on the canonical, unrerouted and unquarantined.
    const write = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'a write naming the merged alias scope', type: 'reference', scope: 'client:Acme-Foods' },
    });
    expect(write.statusCode).toBe(201);
    expect(write.json().data.scope).toBe('client:acme-foods');
    expect(write.json().meta.scope_rerouted).toBeUndefined();
  });

  it('rename re-keys the registry row and appends the alias entry via the same chain', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My-Project', origin_cwd: null, status: 'provisional',
    });

    const res = await rule({ scope: 'project:my-project', action: 'rename', target: 'project:fuel-dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      scope: 'project:my-project',
      action: 'rename',
      target: 'project:fuel-dashboard',
      slug: 'project:fuel-dashboard',
      status: 'confirmed',
      ruled_at: body.data.ruled_at,
    });
    expect(typeof body.data.ruled_at).toBe('string');
    expect(body.meta.follow_ups).toEqual([
      'npm run migrate:scope-aliases -- --only project:my-project (dry-run first)',
      'POST /api/admin/discovery/redrive {"scope": "project:my-project"} (if this scope has held observations)',
    ]);

    // Row re-keyed: the new scope carries the new slug, keeps its claimant,
    // and is CONFIRMED (spec §12: rename confirms the claimant under its own
    // operator-chosen scope — fix round 1). The freed scope is not gone but
    // TOMBSTONED (final review I1): reserved + confirmed under its original
    // claim slug, so the slug count never hands the freed suffix to a future
    // colliding claimant.
    expect(await registryRow('project:my-project')).toMatchObject({
      slug: 'project:my-project',
      claimant_raw: 'project:my-project',
      origin_cwd: null,
      status: 'confirmed',
      reserved: true,
    });
    const renamed = await registryRow('project:fuel-dashboard');
    expect(renamed).toBeDefined();
    expect(renamed!.slug).toBe('project:fuel-dashboard');
    expect(renamed!.claimant_raw).toBe('project:My-Project');
    expect(renamed!.status).toBe('confirmed');
    expect(renamed!.ruled_at).not.toBeNull();

    // Old scope covered by the alias entry.
    expect(await storedAliases()).toEqual({ 'project:my-project': 'project:fuel-dashboard' });
  });

  it('400 on missing target for merge_into and rename', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:my-project', origin_cwd: null, status: 'provisional',
    });

    for (const action of ['merge_into', 'rename']) {
      const res = await rule({ scope: 'project:my-project', action });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Validation error');
    }
    // Nothing was ruled or written.
    expect((await registryRow('project:my-project'))!.status).toBe('provisional');
    expect(await storedAliases()).toBeUndefined();
  });

  it('confirm also rules a quarantined row to confirmed (spec §12: provisional AND quarantined)', async () => {
    await registryStore.register({
      scope: 'project:my-project--q2', slug: 'project:my-project',
      claimant_raw: 'project:My-Project', origin_cwd: 'C:/somewhere/else', status: 'quarantined',
    });

    const res = await rule({ scope: 'project:my-project--q2', action: 'confirm' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('confirmed');

    const row = await registryRow('project:my-project--q2');
    expect(row!.status).toBe('confirmed');
    expect(row!.ruled_at).not.toBeNull();
  });

  it('refuses "global" as a merge_into / rename target with a 400; nothing written', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:my-project', origin_cwd: null, status: 'provisional',
    });

    for (const action of ['merge_into', 'rename']) {
      const res = await rule({ scope: 'project:my-project', action, target: 'global' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Ruling target cannot be "global"');
    }
    expect((await registryRow('project:my-project'))!.status).toBe('provisional');
    expect(await storedAliases()).toBeUndefined();
  });

  it('refuses every ruling on a RESERVED row with a 400 naming it (round-2 CO4) — seeded triage scope', async () => {
    // Mirror server.ts's boot seed.
    await registryStore.register({
      scope: 'project:_unrouted', slug: 'project:unrouted',
      claimant_raw: 'project:_unrouted', origin_cwd: null, status: 'confirmed', reserved: true,
    });

    for (const payload of [
      { scope: 'project:_unrouted', action: 'confirm' },
      { scope: 'project:_unrouted', action: 'merge_into', target: 'project:somewhere' },
      { scope: 'project:_unrouted', action: 'rename', target: 'project:somewhere' },
    ]) {
      const res = await rule(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Registry row "project:_unrouted" is reserved (system scope or rename tombstone) — rulings do not apply to reserved rows',
      );
    }
    // Untouched: still reserved+confirmed, never re-ruled, no alias written.
    expect(await registryRow('project:_unrouted')).toMatchObject({ status: 'confirmed', reserved: true, ruled_at: null });
    expect(await storedAliases()).toBeUndefined();
  });

  it('refuses rulings on a rename TOMBSTONE with the same 400 (round-2 CO4)', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My-Project', origin_cwd: null, status: 'provisional',
    });
    const renamed = await rule({ scope: 'project:my-project', action: 'rename', target: 'project:fuel-dashboard' });
    expect(renamed.statusCode).toBe(200);

    // The freed scope is now a tombstone; ruling it again (any action) is refused.
    const res = await rule({ scope: 'project:my-project', action: 'confirm' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(
      'Registry row "project:my-project" is reserved (system scope or rename tombstone) — rulings do not apply to reserved rows',
    );
    expect(await registryRow('project:my-project')).toMatchObject({ reserved: true, status: 'confirmed' });
  });

  it('a blob-write failure AFTER rename+tombstone landed is a 500 naming the partial state and the recovery (round-2 CO7)', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My-Project', origin_cwd: null, status: 'provisional',
    });
    vi.spyOn(dreamQueries, 'updateConfig').mockRejectedValueOnce(new Error('disk full'));

    const res = await rule({ scope: 'project:my-project', action: 'rename', target: 'project:fuel-dashboard' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe(
      'Ruling partially applied: registry row "project:my-project" was renamed to "project:fuel-dashboard" (tombstone in place) but its alias entry {"project:my-project": "project:fuel-dashboard"} failed to persist (disk full). ' +
      'Do NOT retry the rename — the re-key already landed and would 409 off the tombstone. ' +
      'Recover by adding the entry {"project:my-project": "project:fuel-dashboard"} to config.scope_aliases via PATCH /api/operator-config (resend the FULL map — the blob key replaces whole).',
    );

    // The named partial state is real: re-key + tombstone landed, alias absent.
    expect(await registryRow('project:fuel-dashboard')).toMatchObject({ claimant_raw: 'project:My-Project' });
    expect(await registryRow('project:my-project')).toMatchObject({ reserved: true, status: 'confirmed' });
    expect(await storedAliases()).toBeUndefined();

    // The named recovery works: PATCH the full map in; the alias goes live.
    const recover = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: { config: { scope_aliases: { 'project:my-project': 'project:fuel-dashboard' } } },
    });
    expect(recover.statusCode).toBe(200);
    expect(await storedAliases()).toEqual({ 'project:my-project': 'project:fuel-dashboard' });
  });

  it('404 when the scope has no registry row', async () => {
    const res = await rule({ scope: 'project:nope', action: 'confirm' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('No registry row for scope "project:nope"');
  });

  it('a merge_into that would form an alias chain is refused 400 and leaves scope_aliases unchanged', async () => {
    await registryStore.register({
      scope: 'client:acme-foods', slug: 'client:acme-foods',
      claimant_raw: 'client:acme-foods', origin_cwd: null, status: 'provisional',
    });
    // Seed an accepted table whose VALUE is the scope about to be ruled — the
    // new entry {'client:acme-foods': 'client:acme'} makes that string both an
    // alias key and a canonical value, which the resolver rejects as chained.
    const seed = await app.inject({
      method: 'PATCH',
      url: '/api/operator-config',
      payload: { config: { scope_aliases: { 'client:Acme-Foods': 'client:acme-foods' } } },
    });
    expect(seed.statusCode).toBe(200);

    const res = await rule({ scope: 'client:acme-foods', action: 'merge_into', target: 'client:acme' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('alias entry {"client:acme-foods": "client:acme"} rejected: chained');

    // Table byte-identical; the row was not confirmed.
    expect(await storedAliases()).toEqual({ 'client:Acme-Foods': 'client:acme-foods' });
    const row = await registryRow('client:acme-foods');
    expect(row!.status).toBe('provisional');
    expect(row!.ruled_at).toBeNull();
  });

  it('rename onto a scope that already has a registry row is a 409 and writes no alias', async () => {
    await registryStore.register({
      scope: 'project:one', slug: 'project:one',
      claimant_raw: 'project:one', origin_cwd: null, status: 'provisional',
    });
    await registryStore.register({
      scope: 'project:two', slug: 'project:two',
      claimant_raw: 'project:two', origin_cwd: null, status: 'provisional',
    });

    const res = await rule({ scope: 'project:one', action: 'rename', target: 'project:two' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Rename refused: target scope "project:two" already has a registry row');

    expect(await registryRow('project:one')).toBeDefined();
    expect(await storedAliases()).toBeUndefined();
  });

  it('a rename PK conflict that races past the pre-check (stale snapshot) is still a 409, not a 500', async () => {
    await registryStore.register({
      scope: 'project:one', slug: 'project:one',
      claimant_raw: 'project:one', origin_cwd: null, status: 'provisional',
    });
    // Warm the registry-service cache, THEN register the conflicting target
    // directly at the store — the service's 60s-TTL snapshot no longer sees it,
    // so the endpoint's pre-check passes and the store's UNIQUE throw is what
    // fires (the raced-mint shape, made deterministic).
    const warm = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(warm.statusCode).toBe(200);
    await registryStore.register({
      scope: 'project:two', slug: 'project:two',
      claimant_raw: 'project:two', origin_cwd: null, status: 'provisional',
    });

    const res = await rule({ scope: 'project:one', action: 'rename', target: 'project:two' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Rename refused: target scope "project:two" already has a registry row');

    // The re-key did not happen and no alias was written.
    expect(await registryRow('project:one')).toBeDefined();
    expect(await storedAliases()).toBeUndefined();
  });

  it('a rename ruling tombstones the freed quarantine scope: the next collision gets --q3, never --q2 again (final review I1)', async () => {
    // The incumbent and its first colliding claimant (the q2 row), exactly as
    // minting would leave them.
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My-Project', origin_cwd: 'C:/dev/one', status: 'provisional',
    });
    await registryStore.register({
      scope: 'project:my-project--q2', slug: 'project:my-project',
      claimant_raw: 'project:my-project', origin_cwd: 'C:/dev/two', status: 'quarantined',
    });

    const res = await rule({ scope: 'project:my-project--q2', action: 'rename', target: 'project:second-project' });
    expect(res.statusCode).toBe(200);

    // The freed q-scope is TOMBSTONED — reserved + confirmed, carrying the
    // ORIGINAL claim slug so bySlug counting still sees the historical claimant.
    const tombstone = await registryRow('project:my-project--q2');
    expect(tombstone).toMatchObject({
      slug: 'project:my-project',
      claimant_raw: 'project:my-project--q2',
      origin_cwd: null,
      status: 'confirmed',
      reserved: true,
    });

    // A fresh THIRD claimant colliding on the same base slug quarantines under
    // --q3 — NOT the freed --q2, whose alias entry now points at the renamed
    // claimant's project (suffix reuse would sweep the new claimant's rows
    // there — the R-A cross-claimant merge).
    const write = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'third claimant write colliding on the base slug', type: 'reference', scope: 'project:My_Project' },
    });
    expect(write.statusCode).toBe(201);
    expect(write.json().data.scope).toBe('project:my-project--q3');
    const q3 = await registryRow('project:my-project--q3');
    expect(q3).toMatchObject({
      slug: 'project:my-project',
      claimant_raw: 'project:My_Project',
      status: 'quarantined',
      reserved: false,
    });
  });

  it('a confirm-write failure after the alias landed is a 500 naming the partial state; a confirm retry heals it (final review M1)', async () => {
    await registryStore.register({
      scope: 'client:Acme-Foods', slug: 'client:acme-foods',
      claimant_raw: 'client:Acme-Foods', origin_cwd: null, status: 'provisional',
    });
    vi.spyOn(registryStore, 'updateStatus').mockRejectedValueOnce(new Error('disk full'));

    const res = await rule({ scope: 'client:Acme-Foods', action: 'merge_into', target: 'client:acme-foods' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe(
      'Ruling partially applied: alias entry {"client:Acme-Foods": "client:acme-foods"} is live but the confirming status update failed (disk full). ' +
      'Registry row "client:Acme-Foods" remains unconfirmed — retry with {"scope": "client:Acme-Foods", "action": "confirm"} to complete the ruling.',
    );

    // The named partial state is real: alias landed, row unconfirmed.
    expect(await storedAliases()).toEqual({ 'client:Acme-Foods': 'client:acme-foods' });
    expect((await registryRow('client:Acme-Foods'))!.status).toBe('provisional');

    // The retry the error names completes the ruling.
    const heal = await rule({ scope: 'client:Acme-Foods', action: 'confirm' });
    expect(heal.statusCode).toBe(200);
    expect((await registryRow('client:Acme-Foods'))!.status).toBe('confirmed');
  });

  it('is admin-gated: 401 without the key, 200 with it', async () => {
    await registryStore.register({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:my-project', origin_cwd: null, status: 'provisional',
    });
    config.server.adminApiKey = 'test-admin-key-123';

    const denied = await rule({ scope: 'project:my-project', action: 'confirm' });
    expect(denied.statusCode).toBe(401);

    const allowed = await rule(
      { scope: 'project:my-project', action: 'confirm' },
      { 'x-api-key': 'test-admin-key-123' },
    );
    expect(allowed.statusCode).toBe(200);
  });
});
