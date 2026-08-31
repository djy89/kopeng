/**
 * Phase 3 done-when integration test (spec §13) — the phase's acceptance gate.
 *
 * The full minting story, driven end-to-end through the real endpoints and the
 * real discovery engine (in-process, wired the way server.ts wires it):
 *
 *   install one — observation batch from cwd `C:/dev/My Project` carrying
 *     project_scope `project:My Project` → discovery mints ONE canonical scope
 *     `project:my-project` (provisional, claimant_raw preserved verbatim);
 *   install two — byte-different claimant `project:my-project` from a DIFFERENT
 *     cwd → discovery quarantines under `project:my-project--q2`, incumbent
 *     rows untouched;
 *   ruling merge_into — folds the quarantined claimant home via the alias
 *     table; ruling rename — keeps them distinct under an operator-chosen name.
 *
 * App construction mirrors tests/unit/scope-write-routing.test.ts (in-process
 * Fastify + registerRoutes over in-memory SQLite); the discovery run mirrors
 * tests/unit/discovery-normalized-grouping.test.ts (runDiscovery with the
 * resolveScope closure exactly as server.ts builds it). Every referent is
 * synthetic; every expected string is PINNED, never derived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ScopeRegistryQueries } from '../../src/database/scope-registry-queries.js';
import { ObservationQueries } from '../../src/database/observation-queries.js';
import { registerRoutes } from '../../src/api/routes.js';
import { ScopeRegistryService, resolveWriteThroughAliases } from '../../src/services/scope-registry.js';
import { ScopeAliasService } from '../../src/services/scope-alias.js';
import { buildHoldPredicate } from '../../src/discovery/hold.js';
import { runDiscovery } from '../../src/discovery/discovery-engine.js';
import { createTestObservationsDb } from '../fixtures/test-helpers.js';
import config from '../../src/config/config.js';
import type { IDatabaseLifecycle, IVectorSearch } from '../../src/database/interfaces.js';

/** Not-ready vector stub (mirrors discovery-normalized-grouping.test.ts):
 * runDiscovery falls back to always-create with no embed/dedup call, and the
 * memory-search routes return empty — all this scenario needs. */
const notReadyIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

/** minOccurrences 3 so a 4-observation install clears the repeated_tool bar. */
const discoveryConfig = { ...config.discovery, minOccurrences: 3 };

interface MintingApp {
  app: FastifyInstance;
  db: Database.Database;
  obsDb: Database.Database;
  queries: MemoryQueries;
  obsQueries: ObservationQueries;
  dreamQueries: DreamQueries;
  registryStore: ScopeRegistryQueries;
  scopeRegistry: ScopeRegistryService;
  scopeAliases: ScopeAliasService;
  runDiscoveryNow: () => ReturnType<typeof runDiscovery>;
  close: () => Promise<void>;
}

async function buildApp(): Promise<MintingApp> {
  const db = new Database(':memory:');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  const dreamQueries = new DreamQueries(db);
  const registryStore = new ScopeRegistryQueries(db);

  // Mirror server.ts's boot seed of the reserved triage scope (idempotent).
  await registryStore.register({
    scope: 'project:_unrouted',
    slug: 'project:unrouted',
    claimant_raw: 'project:_unrouted',
    origin_cwd: null,
    status: 'confirmed',
    reserved: true,
  });

  const scopeAliases = new ScopeAliasService(dreamQueries);
  const scopeRegistry = new ScopeRegistryService({
    registry: registryStore,
    configStore: dreamQueries,
    // CO1 mirror of server.ts: the primary scope canonicalizes at load.
    canonicalize: (s: string) => scopeAliases.canonicalize(s),
  });

  const { db: obsDb, obsQueries } = createTestObservationsDb();

  const lifecycle: IDatabaseLifecycle = {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;

  const app = Fastify({ logger: false });
  // Mirror the production Zod error handler from server.ts (400, not 500).
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });
  registerRoutes(app, {
    stores: { queries, observations: obsQueries, operatorConfig: dreamQueries },
    services: { embeddingIndex: notReadyIndex, scopeAliases, scopeRegistry },
    lifecycle,
  } as never);
  await app.ready();

  // The discovery run, wired the way server.ts wires the DiscoveryScheduler:
  // the SHARED alias-first composition (round-2 A3 — resolveWriteThroughAliases,
  // never hand-rolled) BEFORE detection grouping, the SHARED hold predicate
  // (round-2 CO5), and alias canonicalization as belt-and-braces on the created
  // memory's scope.
  const runDiscoveryNow = () =>
    runDiscovery(obsQueries, queries, notReadyIndex, {
      config: discoveryConfig,
      canonicalizeScope: (s: string) => scopeAliases.canonicalize(s),
      resolveScope: async (raw: string, origin: string | null) =>
        (await resolveWriteThroughAliases(scopeAliases, scopeRegistry, raw, origin)).scope,
      isHeld: buildHoldPredicate((s: string) => scopeAliases.canonicalize(s)),
    });

  return {
    app, db, obsDb, queries, obsQueries, dreamQueries, registryStore,
    scopeRegistry, scopeAliases, runDiscoveryNow,
    close: async () => { await app.close(); db.close(); obsDb.close(); },
  };
}

/** One "install": a 4-observation batch (distinct sessions, same tool+input so
 * only the repeated_tool detector fires) through the real batch endpoint. */
async function installBatch(
  ctx: MintingApp,
  opts: { scope: string; cwd: string; sessionPrefix: string; input: string },
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/observations/batch',
    payload: {
      observations: [1, 2, 3, 4].map((n) => ({
        session_id: `${opts.sessionPrefix}-${n}`,
        project_scope: opts.scope,
        tool_name: 'Grep',
        input_summary: opts.input,
        metadata: { cwd: opts.cwd },
      })),
    },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().meta.count).toBe(4);
}

async function memoriesInScope(ctx: MintingApp, scope: string): Promise<{ id: number; scope: string; type: string }[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/memories?scope=${encodeURIComponent(scope)}&limit=50`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

const installOne = (ctx: MintingApp) =>
  installBatch(ctx, {
    scope: 'project:My Project',
    cwd: 'C:/dev/My Project',
    sessionPrefix: 'install-one',
    input: 'shared-config-check',
  });

const installTwo = (ctx: MintingApp) =>
  installBatch(ctx, {
    scope: 'project:my-project',
    cwd: 'C:/dev/my-project',
    sessionPrefix: 'install-two',
    input: 'second-config-check', // distinct content so store()'s hash dedup can't merge the two installs
  });

let prevAdminKey = '';
let prevIngestion = false;
let prevObsKey = '';

beforeAll(() => {
  prevAdminKey = config.server.adminApiKey;
  prevIngestion = config.discovery.ingestionEnabled;
  prevObsKey = config.discovery.apiKey;
  config.server.adminApiKey = '';        // open dev mode — auth is core-crud-auth's suite
  config.discovery.ingestionEnabled = true; // observation routes must register
  config.discovery.apiKey = '';          // no observation key = open (dev mode)
});

afterAll(() => {
  config.server.adminApiKey = prevAdminKey;
  config.discovery.ingestionEnabled = prevIngestion;
  config.discovery.apiKey = prevObsKey;
});

describe('Phase 3 done-when (spec §13)', () => {
  // Tests 1–3 are one continuous scenario over ONE app: mint → quarantine →
  // merge ruling. Vitest runs them in declaration order within the file.
  let ctx: MintingApp;
  let incumbentMemoryId: number;

  beforeAll(async () => {
    ctx = await buildApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('install one: a write from cwd `My Project` mints ONE canonical scope', async () => {
    await installOne(ctx);
    const result = await ctx.runDiscoveryNow();
    expect(result.memories_created).toBe(1);

    // The memory landed in the CANONICAL slug scope — never the raw claimant.
    const canonical = await memoriesInScope(ctx, 'project:my-project');
    expect(canonical).toHaveLength(1);
    expect(canonical[0].type).toBe('discovery');
    incumbentMemoryId = canonical[0].id;
    expect(await memoriesInScope(ctx, 'project:My Project')).toHaveLength(0);

    // Registry: exactly ONE non-reserved row, provisional, claimant preserved.
    const rows = await ctx.registryStore.listAll();
    expect(rows).toHaveLength(2); // seeded _unrouted + the mint
    const minted = rows.filter((r) => !r.reserved);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      scope: 'project:my-project',
      slug: 'project:my-project',
      claimant_raw: 'project:My Project',
      origin_cwd: 'C:/dev/My Project',
      status: 'provisional',
      reserved: false,
    });
  });

  it('install two: `my-project` from a different cwd is QUARANTINED, not merged', async () => {
    // Pin the incumbent's state BEFORE the second install.
    const before = await memoriesInScope(ctx, 'project:my-project');
    expect(before).toHaveLength(1);

    await installTwo(ctx);
    const result = await ctx.runDiscoveryNow();
    expect(result.memories_created).toBe(1);

    // The new memory landed in the quarantine scope, NOT the incumbent's.
    const quarantined = await memoriesInScope(ctx, 'project:my-project--q2');
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].type).toBe('discovery');

    // Incumbent untouched: same single row, same id.
    const after = await memoriesInScope(ctx, 'project:my-project');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(incumbentMemoryId);

    // Registry: the quarantine row records the colliding claimant + its cwd.
    const rows = await ctx.registryStore.listAll();
    const qRow = rows.find((r) => r.scope === 'project:my-project--q2');
    expect(qRow).toMatchObject({
      slug: 'project:my-project',
      claimant_raw: 'project:my-project',
      origin_cwd: 'C:/dev/my-project',
      status: 'quarantined',
      reserved: false,
    });

    // Ops endpoint reports the triage state.
    const ops = await ctx.app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(ops.statusCode).toBe(200);
    const data = ops.json().data;
    expect(data.enabled).toBe(true);
    expect(data.counts).toEqual({ provisional: 1, confirmed: 1, quarantined: 1 });
  });

  it('ruling merge_into folds the claimant home', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/scopes/rule',
      payload: { scope: 'project:my-project--q2', action: 'merge_into', target: 'project:my-project' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toMatchObject({
      scope: 'project:my-project--q2',
      action: 'merge_into',
      target: 'project:my-project',
      status: 'confirmed',
    });
    expect(typeof body.data.ruled_at).toBe('string');
    // Follow-ups verbatim (spec §12) — the operator's next two commands.
    expect(body.meta.follow_ups).toEqual([
      'npm run migrate:scope-aliases -- --only project:my-project--q2 (dry-run first)',
      'POST /api/admin/discovery/redrive {"scope": "project:my-project--q2"} (if this scope has held observations)',
    ]);

    // The alias table now carries the fold, and the live service resolves it.
    const cfg = await ctx.dreamQueries.getConfig('default');
    const blob = JSON.parse(cfg?.config ?? '{}');
    expect(blob.scope_aliases).toEqual({ 'project:my-project--q2': 'project:my-project' });
    expect(await ctx.scopeAliases.canonicalize('project:my-project--q2')).toBe('project:my-project');

    // Registry row confirmed under its own (quarantine) name.
    const rows = await ctx.registryStore.listAll();
    const qRow = rows.find((r) => r.scope === 'project:my-project--q2');
    expect(qRow!.status).toBe('confirmed');
    expect(qRow!.ruled_at).toBe(body.data.ruled_at);

    const ops = await ctx.app.inject({ method: 'GET', url: '/api/ops/scope-registry' });
    expect(ops.json().data.counts).toEqual({ provisional: 1, confirmed: 2, quarantined: 0 });
  });

  it('ruling rename keeps them distinct', async () => {
    // Fresh app — an independent corpus that quarantines the same way, then
    // takes the OTHER ruling.
    const ctx2 = await buildApp();
    try {
      await installOne(ctx2);
      await ctx2.runDiscoveryNow();
      await installTwo(ctx2);
      await ctx2.runDiscoveryNow();
      expect(
        (await ctx2.registryStore.listAll()).find((r) => r.scope === 'project:my-project--q2')?.status,
      ).toBe('quarantined');

      const res = await ctx2.app.inject({
        method: 'POST',
        url: '/api/admin/scopes/rule',
        payload: { scope: 'project:my-project--q2', action: 'rename', target: 'project:second-project' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toMatchObject({
        scope: 'project:my-project--q2',
        action: 'rename',
        target: 'project:second-project',
        slug: 'project:second-project',
        status: 'confirmed',
      });

      // Registry re-keyed: the row lives under the operator-chosen scope,
      // claimant lineage intact, CONFIRMED (rename rules the claimant a real,
      // distinct project — spec §12). The freed quarantine key is TOMBSTONED
      // (final review I1) — reserved + confirmed under the original claim slug
      // — so a future third claimant colliding on the base slug gets --q3,
      // never the freed --q2 whose alias entry now points at second-project.
      const rows = await ctx2.registryStore.listAll();
      expect(rows.find((r) => r.scope === 'project:my-project--q2')).toMatchObject({
        slug: 'project:my-project',
        claimant_raw: 'project:my-project--q2',
        origin_cwd: null,
        status: 'confirmed',
        reserved: true,
      });
      const renamed = rows.find((r) => r.scope === 'project:second-project');
      expect(renamed).toMatchObject({
        slug: 'project:second-project',
        claimant_raw: 'project:my-project',
        origin_cwd: 'C:/dev/my-project',
        status: 'confirmed',
      });

      // The alias maps the q-scope to the NEW name — and the incumbent stays a
      // separate, untouched row: distinct, not merged.
      expect(await ctx2.scopeAliases.canonicalize('project:my-project--q2')).toBe('project:second-project');
      const incumbent = rows.find((r) => r.scope === 'project:my-project');
      expect(incumbent!.status).toBe('provisional');
      expect(incumbent!.claimant_raw).toBe('project:My Project');
    } finally {
      await ctx2.close();
    }
  });

  it('a tabled non-fold alias routes discovery through the alias table BEFORE the registry (final review C1)', async () => {
    // Fresh app: an operator ruling is already on file — project:legacy-tool
    // is an alias of client:acme-foods (a NON-slug-fold mapping, so only the
    // alias table can resolve it; the registry alone would mint it).
    const ctx3 = await buildApp();
    try {
      const seed = await ctx3.app.inject({
        method: 'PATCH',
        url: '/api/operator-config',
        payload: { config: { scope_aliases: { 'project:legacy-tool': 'client:acme-foods' } } },
      });
      expect(seed.statusCode).toBe(200);

      await installBatch(ctx3, {
        scope: 'project:legacy-tool',
        cwd: 'C:/dev/legacy-tool',
        sessionPrefix: 'legacy',
        input: 'legacy-config-check',
      });
      const result = await ctx3.runDiscoveryNow();
      expect(result.memories_created).toBe(1);

      // The memory landed on the RULED canonical — never the alias variant.
      expect(await memoriesInScope(ctx3, 'client:acme-foods')).toHaveLength(1);
      expect(await memoriesInScope(ctx3, 'project:legacy-tool')).toHaveLength(0);

      // Registry: NO row minted for the ruled-away alias scope (or its slug) —
      // alias-first resolution means the registry only ever sees the canonical,
      // which minted normally with the observing origin.
      const rows = await ctx3.registryStore.listAll();
      expect(rows.find((r) => r.scope === 'project:legacy-tool')).toBeUndefined();
      expect(rows.find((r) => r.slug === 'project:legacy-tool')).toBeUndefined();
      expect(rows.find((r) => r.scope === 'client:acme-foods')).toMatchObject({
        slug: 'client:acme-foods',
        claimant_raw: 'client:acme-foods',
        origin_cwd: 'C:/dev/legacy-tool',
        status: 'provisional',
        reserved: false,
      });

      // Lineage untouched: the run row stays on the RAW scope.
      const runs = await ctx3.obsQueries.listDiscoveryRuns('project:legacy-tool');
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('completed');
    } finally {
      await ctx3.close();
    }
  });

  it('a RESERVED confirmed scope refuses re-drive with the 409 (round-2 CO3)', async () => {
    // The seeded triage row is confirmed AND reserved — confirmed-as-system-
    // state, not operator-blessed for minting. Pre-fix, isConfirmed keyed on
    // status alone, so a redrive would have run detection over _unrouted.
    const ctx4 = await buildApp();
    try {
      const res = await ctx4.app.inject({
        method: 'POST',
        url: '/api/admin/discovery/redrive',
        payload: { scope: 'project:_unrouted' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(
        'Scope "project:_unrouted" has no ruling: resolution returns it unchanged and its registry row is not confirmed. ' +
        'Rule the scope first (alias it to its real target, or confirm it in the scope registry), then re-drive.',
      );
    } finally {
      await ctx4.close();
    }
  });

  // RULING-C (WS7.6): the hooks now mint project:<owner>-<repo> instead of
  // project:<basename(cwd)> — a remote-derived shape needs no special server
  // handling: it is just another raw scope string arriving at the same choke
  // point as any operator-typed one.
  it('a remote-derived scope (project:acme-api) mints and registers exactly like any raw scope', async () => {
    const ctx5 = await buildApp();
    try {
      const res = await ctx5.app.inject({
        method: 'POST',
        url: '/api/memories',
        payload: { content: 'a write on a remote-derived scope', type: 'reference', scope: 'project:acme-api' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.scope).toBe('project:acme-api');
      expect(body.meta.scope_rerouted).toBeUndefined();

      const rows = await ctx5.registryStore.listAll();
      const minted = rows.find((r) => r.scope === 'project:acme-api');
      expect(minted).toMatchObject({
        slug: 'project:acme-api',
        claimant_raw: 'project:acme-api',
        status: 'provisional',
        reserved: false,
      });

      expect(await memoriesInScope(ctx5, 'project:acme-api')).toHaveLength(1);
    } finally {
      await ctx5.close();
    }
  });
});
