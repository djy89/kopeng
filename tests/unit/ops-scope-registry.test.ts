/**
 * Phase 3 (Task 10): GET /api/ops/scope-registry — read-only registry visibility.
 *
 * One ops snapshot answers "what has the minting layer done": the registry rows
 * with per-status counts, the held (ephemeral) discovery backlogs awaiting a
 * ruling, the `project:_unrouted` triage backlog, and the rerouted-write count
 * (active rows carrying metadata.raw_scope). Public, no key — same threat model
 * as /api/stats. Absent registry service degrades to `{ enabled: false, rows: [] }`
 * (mirrors /api/ops/dream-history); absent observation store degrades only the
 * `held` field to [], never the endpoint.
 *
 * App built in-process the same way scope-write-routing.test.ts does; seeding
 * goes through the real write path (POST /api/memories) so the rerouted-write
 * metadata is the genuine article, not a hand-built row. Expected counts are
 * PINNED, never derived.
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
import { createTestObservationsDb } from '../fixtures/test-helpers.js';
import type { ObservationQueries } from '../../src/database/observation-queries.js';
import config from '../../src/config/config.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

let app: FastifyInstance;
let db: Database.Database;
let obsDb: Database.Database | null = null;
let obsQueries: ObservationQueries | null = null;
let registryStore: ScopeRegistryQueries;
let prevKey = '';

async function buildApp(opts: { withRegistry: boolean; withObservations: boolean }): Promise<void> {
  db = new Database(':memory:');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  const dreamQueries = new DreamQueries(db);
  registryStore = new ScopeRegistryQueries(db);

  let scopeRegistry: ScopeRegistryService | undefined;
  if (opts.withRegistry) {
    // Mirror server.ts's boot seed of the reserved triage scope.
    await registryStore.register({
      scope: 'project:_unrouted',
      slug: 'project:unrouted',
      claimant_raw: 'project:_unrouted',
      origin_cwd: null,
      status: 'confirmed',
      reserved: true,
    });
    scopeRegistry = new ScopeRegistryService({
      registry: registryStore,
      configStore: dreamQueries,
    });
  }

  if (opts.withObservations) {
    const obs = createTestObservationsDb();
    obsDb = obs.db;
    obsQueries = obs.obsQueries;
  } else {
    obsDb = null;
    obsQueries = null;
  }

  const lifecycle: IDatabaseLifecycle = {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;

  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });
  registerRoutes(app, {
    stores: {
      queries,
      operatorConfig: dreamQueries,
      ...(obsQueries ? { observations: obsQueries } : {}),
    },
    services: { embeddingIndex: new EmbeddingIndex(), ...(scopeRegistry ? { scopeRegistry } : {}) },
    lifecycle,
  } as never);
  await app.ready();
}

beforeEach(() => {
  prevKey = config.server.adminApiKey;
  config.server.adminApiKey = ''; // open dev mode — auth is core-crud-auth's suite
});

afterEach(async () => {
  config.server.adminApiKey = prevKey;
  await app.close();
  db.close();
  obsDb?.close();
});

describe('GET /api/ops/scope-registry (Phase 3 Task 10)', () => {
  it('reports rows, status counts, held backlogs, _unrouted and rerouted counts — all pinned', async () => {
    await buildApp({ withRegistry: true, withObservations: true });

    // Registry: one row per status. The reserved triage seed is the confirmed one.
    await registryStore.register({
      scope: 'project:widget-app',
      slug: 'project:widget-app',
      claimant_raw: 'project:Widget-App',
      origin_cwd: null,
      status: 'provisional',
      reserved: false,
    });
    await registryStore.register({
      scope: 'project:fuel-dashboard--q2',
      slug: 'project:fuel-dashboard',
      claimant_raw: 'project:Fuel-Dashboard',
      origin_cwd: null,
      status: 'quarantined',
      reserved: false,
    });

    // Held backlog: two held runs on one scope (proves SUM + MAX, not last-row),
    // plus a completed run on another scope that must NOT appear.
    const heldA = await obsQueries!.createDiscoveryRun('project:tmp-scratch', 0);
    await obsQueries!.updateDiscoveryRun(heldA.id, {
      status: 'held', observations_analyzed: 4, observation_end_id: 40,
    });
    const heldB = await obsQueries!.createDiscoveryRun('project:tmp-scratch', 40);
    await obsQueries!.updateDiscoveryRun(heldB.id, {
      status: 'held', observations_analyzed: 3, observation_end_id: 42,
    });
    const done = await obsQueries!.createDiscoveryRun('project:widget-app', 0);
    await obsQueries!.updateDiscoveryRun(done.id, {
      status: 'completed', observations_analyzed: 9, observation_end_id: 99,
    });

    // Triage backlog through the REAL write path: a scopeless write and a
    // malformed-scope write both land in project:_unrouted (no primary set);
    // only the malformed one carries metadata.raw_scope.
    const scopeless = await app.inject({
      method: 'POST', url: '/api/memories',
      payload: { content: 'a scopeless write awaiting triage', type: 'reference' },
    });
    expect(scopeless.statusCode).toBe(201);
    expect(scopeless.json().data.scope).toBe('project:_unrouted');

    const rerouted = await app.inject({
      method: 'POST', url: '/api/memories',
      payload: { content: 'a write carrying a malformed scope', type: 'reference', scope: 'status:archived' },
    });
    expect(rerouted.statusCode).toBe(201);
    expect(JSON.parse(rerouted.json().data.metadata).raw_scope).toBe('status:archived');

    // An ARCHIVED _unrouted row must count in neither counter.
    const archived = await app.inject({
      method: 'POST', url: '/api/memories',
      payload: { content: 'an unrouted write later archived', type: 'reference' },
    });
    expect(archived.statusCode).toBe(201);
    const archiveRes = await app.inject({
      method: 'POST', url: `/api/memories/${archived.json().data.id}/archive`,
    });
    expect(archiveRes.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;

    expect(data.enabled).toBe(true);
    expect(data.counts).toEqual({ provisional: 1, confirmed: 1, quarantined: 1 });
    expect(data.rows).toHaveLength(3);
    expect(data.rows.map((r: { scope: string }) => r.scope).sort()).toEqual([
      'project:_unrouted',
      'project:fuel-dashboard--q2',
      'project:widget-app',
    ]);
    const byScope = Object.fromEntries(
      data.rows.map((r: { scope: string; status: string; reserved: boolean }) => [r.scope, r])
    );
    expect(byScope['project:_unrouted'].status).toBe('confirmed');
    expect(byScope['project:_unrouted'].reserved).toBe(true);
    expect(byScope['project:widget-app'].status).toBe('provisional');
    expect(byScope['project:fuel-dashboard--q2'].status).toBe('quarantined');

    // CO6 shape: pending (above the scope's completed watermark — none exists
    // for tmp-scratch, so all 7 are pending) + all-time total.
    expect(data.held).toEqual([
      { scope: 'project:tmp-scratch', observations_pending: 7, observations_total: 7, last_end_id: 42 },
    ]);
    // 3 rows landed in _unrouted; 1 was archived. The rerouted row is one of the 2.
    expect(data.unrouted_active_rows).toBe(2);
    expect(data.rerouted_rows).toBe(1);
  });

  it('held summary reports PENDING vs total; a fully re-driven scope drops out (round-2 CO6)', async () => {
    await buildApp({ withRegistry: true, withObservations: true });

    // Scope A: 7 ever-held observations (end ids 40 and 42); a completed
    // re-drive run covered through 41 → only the end-42 held row (3 obs) is
    // still pending.
    const heldA1 = await obsQueries!.createDiscoveryRun('project:tmp-a', 0);
    await obsQueries!.updateDiscoveryRun(heldA1.id, {
      status: 'held', observations_analyzed: 4, observation_end_id: 40,
    });
    const heldA2 = await obsQueries!.createDiscoveryRun('project:tmp-a', 40);
    await obsQueries!.updateDiscoveryRun(heldA2.id, {
      status: 'held', observations_analyzed: 3, observation_end_id: 42,
    });
    const redriveA = await obsQueries!.createDiscoveryRun('project:tmp-a', 0);
    await obsQueries!.updateDiscoveryRun(redriveA.id, {
      status: 'completed', observations_analyzed: 4, observation_end_id: 41,
    });

    // Scope B: fully re-driven (completed watermark ≥ every held end id) —
    // reads 0 pending and DROPS OUT of the summary.
    const heldB = await obsQueries!.createDiscoveryRun('project:tmp-b', 0);
    await obsQueries!.updateDiscoveryRun(heldB.id, {
      status: 'held', observations_analyzed: 2, observation_end_id: 10,
    });
    const redriveB = await obsQueries!.createDiscoveryRun('project:tmp-b', 0);
    await obsQueries!.updateDiscoveryRun(redriveB.id, {
      status: 'completed', observations_analyzed: 2, observation_end_id: 10,
    });

    expect(await obsQueries!.getHeldRunSummary()).toEqual([
      { scope: 'project:tmp-a', observations_pending: 3, observations_total: 7, last_end_id: 42 },
    ]);
  });

  it('caps the row list at 500 with meta.truncated + full-registry counts (round-2 S2)', async () => {
    await buildApp({ withRegistry: true, withObservations: false });

    // 502 provisional rows + the reserved seed = 503 total.
    for (let i = 0; i < 502; i++) {
      await registryStore.register({
        scope: `project:bulk-${i.toString().padStart(4, '0')}`,
        slug: `project:bulk-${i.toString().padStart(4, '0')}`,
        claimant_raw: `project:bulk-${i}`,
        origin_cwd: null,
        status: 'provisional',
        reserved: false,
      });
    }

    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.rows).toHaveLength(500);
    expect(body.meta).toEqual({ row_total: 503, truncated: true });
    // Counts stay FULL-registry — the cap clips only the row list.
    expect(body.data.counts).toEqual({ provisional: 502, confirmed: 1, quarantined: 0 });
  });

  it('is memoized on the 60s ops memo; a ruling drops the key so it reflects immediately (round-2 S2)', async () => {
    await buildApp({ withRegistry: true, withObservations: false });
    await registryStore.register({
      scope: 'project:widget-app', slug: 'project:widget-app',
      claimant_raw: 'project:Widget-App', origin_cwd: null, status: 'provisional', reserved: false,
    });

    const first = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(first.json().data.counts).toEqual({ provisional: 1, confirmed: 1, quarantined: 0 });
    expect(first.json().meta).toEqual({ row_total: 2, truncated: false });

    // A write lands in _unrouted between polls — the memoized snapshot must
    // NOT recompute (unrouted_active_rows stays 0 for up to the TTL).
    const write = await app.inject({
      method: 'POST', url: '/api/memories',
      payload: { content: 'an unrouted write behind the memo', type: 'reference' },
    });
    expect(write.statusCode).toBe(201);
    const second = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(second.json().data.unrouted_active_rows).toBe(0); // memo hit, pinned stale

    // A RULING deletes the memo key: the next poll recomputes and sees both
    // the ruling and the write.
    const ruled = await app.inject({
      method: 'POST', url: '/api/admin/scopes/rule',
      payload: { scope: 'project:widget-app', action: 'confirm' },
    });
    expect(ruled.statusCode).toBe(200);
    const third = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(third.json().data.counts).toEqual({ provisional: 0, confirmed: 2, quarantined: 0 });
    expect(third.json().data.unrouted_active_rows).toBe(1);
  });

  it('degrades to { enabled: false, rows: [] } when no registry service is wired', async () => {
    await buildApp({ withRegistry: false, withObservations: true });
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { enabled: false, rows: [] } });
  });

  it('degrades only the held field to [] when no observation store is wired', async () => {
    await buildApp({ withRegistry: true, withObservations: false });
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.enabled).toBe(true);
    expect(data.held).toEqual([]);
    expect(data.counts).toEqual({ provisional: 0, confirmed: 1, quarantined: 0 });
    expect(data.rows).toHaveLength(1);
    expect(data.unrouted_active_rows).toBe(0);
    expect(data.rerouted_rows).toBe(0);
  });
});
