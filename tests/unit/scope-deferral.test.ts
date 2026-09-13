/**
 * Blocker 4 (UX synthesis theme C): deferral marking.
 *
 * A deferral is BOOKKEEPING, not a ruling: `deferred_at` + `deferred_note`
 * live as dedicated registry columns mirroring `ruled_distinct_at` (§1.2b —
 * one fact, one home, read by every consumer), the ruling endpoint gains
 * `defer` / `undefer` actions that deliberately do NOT confirm the row
 * (deferral postpones the identity judgment — confirming would make it), and
 * the drift report derives:
 *   - per-variant `deferred_at` / `deferred_note` (evidence, both row kinds),
 *   - a cluster `deferred` aggregate — true iff EVERY unruled uncovered
 *     variant is deferred (mirrors `ruled_distinct`'s arithmetic),
 *   - `clusters_deferred` in the summary (ADDITIVE — the §1.2a watchdog rule:
 *     deferred clusters leave `clusters_actionable` but never the report, and
 *     `active_rows_adrift` / `clusters_uncovered` are UNTOUCHED, so the
 *     time-series metric cannot be silenced by deferring).
 *
 * A real ruling supersedes a deferral: merge_into and mark_distinct clear
 * `deferred_at` (the deferral postponed exactly the decision that just
 * happened).
 *
 * Harness mirrors scope-ruling.test.ts: in-process app, registry assertions
 * through a directly-constructed ScopeRegistryQueries over the same in-memory
 * db. Expected strings PINNED, never derived.
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
import {
  buildScopeDrift, DistinctRulings, DeferredMarks, type ScopeAggregate,
} from '../../src/scopes/drift.js';

// ── Pure drift derivation ──────────────────────────────────────────────────

const agg = (scope: string, active: number): ScopeAggregate => ({
  scope, total: active, active, archived: 0,
  anchored: 0,
  by_type: { discovery: active }, by_source: { 'auto-discovery': active },
  by_source_active: { 'auto-discovery': active },
  first_write: '2026-08-01T00:00:00Z', last_write: '2026-09-01T00:00:00Z',
});

// One casing cluster: canonical (0 rows, synthesized) + two variants with rows.
const CASING = [agg('project:Acme-App', 7), agg('project:ACME-app', 3)];

function marks(rows: { scope: string; deferred_at: string | null; deferred_note?: string | null }[]) {
  return DeferredMarks.fromRegistryRows(rows.map(r => ({ deferred_note: null, ...r })));
}

describe('buildScopeDrift deferral derivation (blocker 4)', () => {
  it('per-variant deferred_at/deferred_note ride the evidence on cluster variants and ephemeral entries', () => {
    const deferred = marks([
      { scope: 'project:Acme-App', deferred_at: '2026-09-03T00:00:00Z', deferred_note: 'Acme family — bulk pass later' },
      { scope: 'project:wf_abc123', deferred_at: '2026-09-03T00:00:00Z' },
    ]);
    const report = buildScopeDrift(
      [...CASING, agg('project:wf_abc123', 5)],
      undefined, undefined, deferred,
    );
    const cluster = report.clusters[0];
    const v = cluster.variants.find(x => x.scope === 'project:Acme-App')!;
    expect(v.deferred_at).toBe('2026-09-03T00:00:00Z');
    expect(v.deferred_note).toBe('Acme family — bulk pass later');
    const other = cluster.variants.find(x => x.scope === 'project:ACME-app')!;
    expect(other.deferred_at).toBeNull();
    expect(other.deferred_note).toBeNull();
    const eph = report.ephemeral.find(e => e.scope === 'project:wf_abc123')!;
    expect(eph.deferred_at).toBe('2026-09-03T00:00:00Z');
    expect(eph.deferred_note).toBeNull();
  });

  it('cluster reads deferred iff EVERY unruled uncovered variant is deferred; partial deferral does not count', () => {
    const partial = buildScopeDrift(CASING, undefined, undefined, marks([
      { scope: 'project:Acme-App', deferred_at: '2026-09-03T00:00:00Z' },
    ]));
    expect(partial.clusters[0].deferred).toBe(false);
    expect(partial.summary.clusters_deferred).toBe(0);

    const full = buildScopeDrift(CASING, undefined, undefined, marks([
      { scope: 'project:Acme-App', deferred_at: '2026-09-03T00:00:00Z' },
      { scope: 'project:ACME-app', deferred_at: '2026-09-03T00:00:00Z' },
    ]));
    expect(full.clusters[0].deferred).toBe(true);
    expect(full.summary.clusters_deferred).toBe(1);
  });

  it('deferral removes the cluster from clusters_actionable but NOT from clusters_uncovered or active_rows_adrift (the §1.2a watchdog rule)', () => {
    const before = buildScopeDrift(CASING);
    expect(before.summary.clusters_actionable).toBe(1);

    const after = buildScopeDrift(CASING, undefined, undefined, marks([
      { scope: 'project:Acme-App', deferred_at: '2026-09-03T00:00:00Z' },
      { scope: 'project:ACME-app', deferred_at: '2026-09-03T00:00:00Z' },
    ]));
    expect(after.summary.clusters_actionable).toBe(0);
    expect(after.summary.clusters_deferred).toBe(1);
    // The structural count and THE drift metric are untouched — deferring
    // cannot silence the time series.
    expect(after.summary.clusters_uncovered).toBe(before.summary.clusters_uncovered);
    expect(after.summary.active_rows_adrift).toBe(before.summary.active_rows_adrift);
    // The rows stay visible and labelled.
    expect(after.clusters[0].variants.length).toBe(before.clusters[0].variants.length);
  });

  it('a ruled+deferred mix reads deferred: ruled members are out of the unruled set, so the remaining deferred member completes the aggregate', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'project:Acme-App', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift(CASING, undefined, distinct, marks([
      { scope: 'project:ACME-app', deferred_at: '2026-09-03T00:00:00Z' },
    ]));
    expect(report.clusters[0].deferred).toBe(true);
    expect(report.summary.clusters_actionable).toBe(0);
  });

  it('a fully-RULED cluster is ruled_distinct, not deferred — the aggregates stay disjoint', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'project:Acme-App', ruled_distinct_at: '2026-09-01T00:00:00Z' },
      { scope: 'project:ACME-app', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift(CASING, undefined, distinct, marks([
      { scope: 'project:Acme-App', deferred_at: '2026-09-03T00:00:00Z' },
    ]));
    expect(report.clusters[0].ruled_distinct).toBe(true);
    expect(report.clusters[0].deferred).toBe(false);
    expect(report.summary.clusters_deferred).toBe(0);
  });

  it('DeferredMarks is unforgeable-by-construction like DistinctRulings: EMPTY defers nothing', () => {
    const report = buildScopeDrift(CASING, undefined, undefined, DeferredMarks.EMPTY);
    expect(report.clusters[0].deferred).toBe(false);
    expect(report.clusters[0].variants[0].deferred_at).toBeNull();
  });
});

// ── Registry store (SQLite; the PG twin lives in pg-executed-sql) ──────────

describe('ScopeRegistryQueries deferral columns (blocker 4)', () => {
  let db: Database.Database;
  let store: ScopeRegistryQueries;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new ScopeRegistryQueries(db);
  });
  afterEach(() => db.close());

  const seeded = async () => {
    await store.register({
      scope: 'project:acme', slug: 'project:acme',
      claimant_raw: 'project:acme', origin_cwd: null, status: 'provisional',
    });
  };

  it('setDeferred stamps deferred_at + deferred_note and leaves status alone (deferral is not a ruling)', async () => {
    await seeded();
    await store.setDeferred('project:acme', '2026-09-03T10:00:00Z', 'revisit after the Acme pass');
    const row = (await store.listAll()).find(r => r.scope === 'project:acme')!;
    expect(row.deferred_at).toBe('2026-09-03T10:00:00Z');
    expect(row.deferred_note).toBe('revisit after the Acme pass');
    expect(row.status).toBe('provisional');
    expect(row.ruled_at).toBeNull();
  });

  it('setDeferred with no note stores null; clearDeferred nulls both columns', async () => {
    await seeded();
    await store.setDeferred('project:acme', '2026-09-03T10:00:00Z', null);
    let row = (await store.listAll()).find(r => r.scope === 'project:acme')!;
    expect(row.deferred_at).toBe('2026-09-03T10:00:00Z');
    expect(row.deferred_note).toBeNull();
    await store.clearDeferred('project:acme');
    row = (await store.listAll()).find(r => r.scope === 'project:acme')!;
    expect(row.deferred_at).toBeNull();
    expect(row.deferred_note).toBeNull();
  });

  it('markDistinct clears an existing deferral atomically — the ruling IS the decision the deferral postponed', async () => {
    await seeded();
    await store.setDeferred('project:acme', '2026-09-03T10:00:00Z', 'later');
    await store.markDistinct('project:acme', '2026-09-04T00:00:00Z');
    const row = (await store.listAll()).find(r => r.scope === 'project:acme')!;
    expect(row.ruled_distinct_at).toBe('2026-09-04T00:00:00Z');
    expect(row.deferred_at).toBeNull();
    expect(row.deferred_note).toBeNull();
  });
});

// ── Ruling endpoint ────────────────────────────────────────────────────────

describe('POST /api/admin/scopes/rule defer/undefer (blocker 4)', () => {
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
    const scopeRegistry = new ScopeRegistryService({
      registry: registryStore,
      configStore: dreamQueries,
    });
    const scopeAliases = new ScopeAliasService(dreamQueries);
    const lifecycle: IDatabaseLifecycle = {
      initialize: async () => {}, close: async () => {},
      getStats: async () => ({}) as never, backup: async () => '',
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
      stores: { queries, operatorConfig: dreamQueries },
      services: { embeddingIndex: new EmbeddingIndex(), scopeAliases, scopeRegistry },
      lifecycle,
    } as never);
    await app.ready();
    return;
  }

  const rule = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/admin/scopes/rule', payload });

  const registryRow = async (scope: string) =>
    (await registryStore.listAll()).find(r => r.scope === scope);

  beforeEach(async () => {
    prevKey = config.server.adminApiKey;
    config.server.adminApiKey = '';
    await buildApp();
  });
  afterEach(async () => {
    config.server.adminApiKey = prevKey;
    await app.close();
    db.close();
  });

  it('defer stamps deferred_at + note and does NOT confirm the row — deferral postpones the ruling instead of making one', async () => {
    await registryStore.register({
      scope: 'project:acme', slug: 'project:acme',
      claimant_raw: 'project:acme', origin_cwd: null, status: 'provisional',
    });
    const res = await rule({ scope: 'project:acme', action: 'defer', note: 'after the Acme pass' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.scope).toBe('project:acme');
    expect(body.data.action).toBe('defer');
    expect(typeof body.data.deferred_at).toBe('string');
    const row = (await registryRow('project:acme'))!;
    expect(row.deferred_at).not.toBeNull();
    expect(row.deferred_note).toBe('after the Acme pass');
    expect(row.status).toBe('provisional');
    expect(row.ruled_at).toBeNull();
  });

  it('undefer clears both columns', async () => {
    await registryStore.register({
      scope: 'project:acme', slug: 'project:acme',
      claimant_raw: 'project:acme', origin_cwd: null, status: 'provisional',
    });
    await rule({ scope: 'project:acme', action: 'defer', note: 'later' });
    const res = await rule({ scope: 'project:acme', action: 'undefer' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ scope: 'project:acme', action: 'undefer', deferred_at: null });
    const row = (await registryRow('project:acme'))!;
    expect(row.deferred_at).toBeNull();
    expect(row.deferred_note).toBeNull();
  });

  it('register-then-defer: an unregistered scope-form scope gets a provisional row in the same request (F-4 pattern)', async () => {
    const res = await rule({ scope: 'project:legacy-variant', action: 'defer' });
    expect(res.statusCode).toBe(200);
    const row = (await registryRow('project:legacy-variant'))!;
    expect(row.status).toBe('provisional');
    expect(row.claimant_raw).toBe('project:legacy-variant');
    expect(row.deferred_at).not.toBeNull();
  });

  it('reserved rows refuse defer like every other action', async () => {
    await registryStore.register({
      scope: 'project:_unrouted', slug: 'project:_unrouted',
      claimant_raw: 'project:_unrouted', origin_cwd: null, status: 'confirmed', reserved: true,
    });
    const res = await rule({ scope: 'project:_unrouted', action: 'defer' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('reserved');
  });

  it('a note past 500 chars is a 400, not a truncation — and a 500-char note is accepted verbatim', async () => {
    const tooLong = await rule({ scope: 'project:acme', action: 'defer', note: 'x'.repeat(501) });
    expect(tooLong.statusCode).toBe(400);
    // The boundary case proves the 400 above is about the NOTE, not about
    // `defer` being an unknown action (which would 400 vacuously).
    const atLimit = await rule({ scope: 'project:acme2', action: 'defer', note: 'y'.repeat(500) });
    expect(atLimit.statusCode).toBe(200);
    const row = (await registryRow('project:acme2'))!;
    expect(row.deferred_note).toBe('y'.repeat(500));
  });

  it('defer on an already-ruled-distinct scope is REFUSED — the two marks are mutually exclusive in both orders', async () => {
    await registryStore.register({
      scope: 'project:acme', slug: 'project:acme',
      claimant_raw: 'project:acme', origin_cwd: null, status: 'provisional',
    });
    await rule({ scope: 'project:acme', action: 'mark_distinct' });
    const res = await rule({ scope: 'project:acme', action: 'defer', note: 'changed my mind' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('already ruled distinct');
    const row = (await registryRow('project:acme'))!;
    expect(row.ruled_distinct_at).not.toBeNull();
    expect(row.deferred_at).toBeNull(); // never both
  });

  it('note is refused on any action but defer, rather than silently dropped', async () => {
    await registryStore.register({
      scope: 'project:acme', slug: 'project:acme',
      claimant_raw: 'project:acme', origin_cwd: null, status: 'provisional',
    });
    const res = await rule({ scope: 'project:acme', action: 'mark_distinct', note: 'two real clients' });
    expect(res.statusCode).toBe(400);
    // The ruling did NOT happen — a refused request must not half-apply.
    const row = (await registryRow('project:acme'))!;
    expect(row.ruled_distinct_at).toBeNull();
  });

  it('merge_into supersedes a prior deferral — the alias entry is the decision the deferral postponed', async () => {
    await registryStore.register({
      scope: 'client:Acme-Foods', slug: 'client:acme-foods',
      claimant_raw: 'client:Acme-Foods', origin_cwd: null, status: 'provisional',
    });
    await rule({ scope: 'client:Acme-Foods', action: 'defer', note: 'undecided' });
    const res = await rule({ scope: 'client:Acme-Foods', action: 'merge_into', target: 'client:acme-foods' });
    expect(res.statusCode).toBe(200);
    const row = (await registryRow('client:Acme-Foods'))!;
    expect(row.deferred_at).toBeNull();
    expect(row.deferred_note).toBeNull();
  });

  it('the drift report reflects a deferral immediately: actionable drops, clusters_deferred counts, the rows stay visible', async () => {
    // Two casing variants holding live rows → one actionable cluster.
    const queries = new MemoryQueries(db);
    await queries.store({
      content: 'row on the capitalized spelling', type: 'discovery',
      scope: 'project:Acme-App', tags: [], metadata: '{}', source: 'test',
    } as never);
    await queries.store({
      content: 'row on the lowercase spelling', type: 'discovery',
      scope: 'project:acme-app', tags: [], metadata: '{}', source: 'test',
    } as never);

    const before = (await app.inject({ method: 'GET', url: '/api/ops/scope-drift' })).json().data;
    expect(before.summary.clusters_actionable).toBe(1);
    expect(before.summary.clusters_deferred).toBe(0);

    for (const scope of ['project:Acme-App', 'project:acme-app']) {
      const r = await rule({ scope, action: 'defer', note: 'phase 2' });
      expect(r.statusCode).toBe(200);
    }

    const after = (await app.inject({ method: 'GET', url: '/api/ops/scope-drift' })).json().data;
    expect(after.summary.clusters_actionable).toBe(0);
    expect(after.summary.clusters_deferred).toBe(1);
    expect(after.summary.active_rows_adrift).toBe(before.summary.active_rows_adrift);
    const cluster = after.clusters.find((c: { deferred: boolean }) => c.deferred);
    expect(cluster).toBeDefined();
    expect(cluster.variants.some((v: { deferred_note: string | null }) => v.deferred_note === 'phase 2')).toBe(true);
  });
});
