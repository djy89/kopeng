/**
 * T76 §10 — the four-consumer ruled-distinct composition net, mirroring the
 * `decay-predicate-composition` pattern: ONE seeded registry fact
 * (`mark_distinct`) must release the SAME scope at every consumer that reads
 * it — hold, minting, archive-ephemeral, drift — and an UNRULED sibling scope
 * must show the opposite verdict everywhere. All four consumers are driven
 * from ONE seeded `scope_registry` store; nothing is hand-rolled per consumer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ScopeRegistryQueries } from '../../src/database/scope-registry-queries.js';
import { ScopeRegistryService } from '../../src/services/scope-registry.js';
import { buildHoldPredicate } from '../../src/discovery/hold.js';
import { decideMint, buildMintContext } from '../../src/scopes/minting.js';
import {
  runArchiveEphemeral,
  IneligibleScopeError,
  type ArchiveEphemeralDeps,
} from '../../src/scopes/archive-ephemeral.js';
import { buildScopeDrift, DistinctRulings } from '../../src/scopes/drift.js';
import { EMPTY_RESOLUTION, slugifyScope } from '../../src/scopes/resolver.js';
import type { IVectorSearch, VectorSearchResult } from '../../src/database/interfaces.js';

/** Ephemeral-SHAPED synthetic scope (date-stamped rule). */
const RULED_SCOPE = 'project:20260901-demo';
/** Sibling ephemeral-shaped scope, never ruled — the control. */
const UNRULED_SCOPE = 'project:20260902-other';

class StubVectorIndex implements IVectorSearch {
  removed: number[] = [];
  async loadFromDatabase(): Promise<void> {}
  async add(): Promise<void> {}
  async remove(id: number): Promise<void> { this.removed.push(id); }
  async search(): Promise<VectorSearchResult[]> { return []; }
  get isReady(): boolean { return true; }
  get size(): number { return 0; }
}

/** Identity resolution (empty alias table) — the same closure production wires
 *  through `readResolution` when nothing has been aliased. */
const identityResolution = async () => ({ table: {}, version: 'v1' });

async function seed(queries: MemoryQueries, scope: string, count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const { id } = await queries.store(createTestMemory({
      content: `composition-net row ${scope}-${i}`,
      scope,
    }));
    ids.push(id);
  }
  return ids;
}

describe('ruled-distinct four-consumer composition (T76 §10)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;
  let registryStore: ScopeRegistryQueries;
  let registryService: ScopeRegistryService;
  let vectorIndex: StubVectorIndex;
  let isRuledDistinct: (scope: string) => Promise<boolean>;
  let archiveDeps: ArchiveEphemeralDeps;

  beforeEach(async () => {
    ({ db, queries } = createTestDatabase());
    dreamStore = new DreamQueries(db);
    registryStore = new ScopeRegistryQueries(db);
    registryService = new ScopeRegistryService({ registry: registryStore });
    vectorIndex = new StubVectorIndex();
    isRuledDistinct = (scope: string) => registryService.isRuledDistinct(scope);
    archiveDeps = {
      memoryStore: queries,
      dreamStore,
      vectorIndex,
      readResolution: identityResolution,
      isRuledDistinct,
    };

    // Seed 3 active memories in each scope.
    await seed(queries, RULED_SCOPE, 3);
    await seed(queries, UNRULED_SCOPE, 3);

    // Registry: RULED_SCOPE registers itself (self-claimed, no origin), then
    // gets the mark_distinct ruling. UNRULED_SCOPE never touches the registry
    // at all — it stays an unknown ephemeral scope, exactly as an un-triaged
    // one would in production.
    await registryStore.register({
      scope: RULED_SCOPE,
      slug: slugifyScope(RULED_SCOPE),
      claimant_raw: RULED_SCOPE,
      origin_cwd: null,
      status: 'provisional',
    });
    await registryStore.markDistinct(RULED_SCOPE, '2026-09-01T00:00:00.000Z');
  });

  afterEach(() => { db.close(); });

  it('mark_distinct releases the scope at ALL FOUR consumers from ONE registry fact', async () => {
    // 1. HOLD: released.
    const held = buildHoldPredicate(undefined, isRuledDistinct);
    expect(await held(RULED_SCOPE)).toBe(false);

    // 2. MINTING: resolves like a real project (the T77 guard composes — byScope hit).
    const rows = await registryStore.listAll();
    const ctx = buildMintContext(rows, null);
    const decision = decideMint(RULED_SCOPE, null, ctx);
    expect(decision.kind).toBe('pass');
    expect(decision.scope).toBe(RULED_SCOPE);

    // 3. ARCHIVE-EPHEMERAL: refused — eligibility precedes the dry-run branch.
    await expect(runArchiveEphemeral(archiveDeps, { scope: RULED_SCOPE, apply: false }))
      .rejects.toThrow(IneligibleScopeError);
    await expect(runArchiveEphemeral(archiveDeps, { scope: RULED_SCOPE, apply: false }))
      .rejects.toThrow(/ruled distinct/);
    expect(await queries.countActiveByScope(RULED_SCOPE)).toBe(3);

    // 4. DRIFT: the ephemeral entry is labeled + excluded from actionable pressure.
    const report = buildScopeDrift(
      await queries.getScopeAggregates(),
      EMPTY_RESOLUTION,
      DistinctRulings.fromRegistryRows(await registryStore.listAll()),
    );
    const entry = report.ephemeral.find(e => e.scope === RULED_SCOPE);
    expect(entry).toBeDefined();
    expect(entry?.ruled_distinct).toBe(true);
  });

  it('control: the UNRULED sibling scope is held, un-mintable, archive-eligible, and unlabeled', async () => {
    // 1. HOLD: still held — no ruling has released it.
    const held = buildHoldPredicate(undefined, isRuledDistinct);
    expect(await held(UNRULED_SCOPE)).toBe(true);

    // 2. MINTING: unknown ephemeral scope passes through raw, unregistered
    // (never mints — the discovery path holds it upstream).
    const rows = await registryStore.listAll();
    const ctx = buildMintContext(rows, null);
    const decision = decideMint(UNRULED_SCOPE, null, ctx);
    expect(decision.kind).toBe('pass');
    expect(decision.scope).toBe(UNRULED_SCOPE);
    expect(ctx.byScope.has(UNRULED_SCOPE)).toBe(false);

    // 3. ARCHIVE-EPHEMERAL: eligible — a dry-run resolves with a would-archive count.
    const res = await runArchiveEphemeral(archiveDeps, { scope: UNRULED_SCOPE, apply: false });
    expect(res.dry_run).toBe(true);
    expect(res.archived).toBe(3);
    expect(res.refused_anchored).toBe(0);
    expect(await queries.countActiveByScope(UNRULED_SCOPE)).toBe(3);

    // 4. DRIFT: the ephemeral entry is present but unlabeled.
    const report = buildScopeDrift(
      await queries.getScopeAggregates(),
      EMPTY_RESOLUTION,
      DistinctRulings.fromRegistryRows(await registryStore.listAll()),
    );
    const entry = report.ephemeral.find(e => e.scope === UNRULED_SCOPE);
    expect(entry).toBeDefined();
    expect(entry?.ruled_distinct).toBe(false);
  });
});

/**
 * The other half of the ruling's reach: a mark_distinct on a CASING-cluster
 * variant, which is not ephemeral-shaped and so exercises the consumers that
 * read the ruling for drift/minting rather than for hold/archive. Same
 * discipline as above — ONE seeded registry store drives every assertion.
 */
describe('ruled-distinct composition on a CASING cluster (non-ephemeral)', () => {
  /** Synthetic client, two spellings. The ruled one is the capitalized variant. */
  const CANONICAL = 'client:acme-foods';
  const RULED_VARIANT = 'client:Acme-Foods';

  let db: Database.Database;
  let queries: MemoryQueries;
  let registryStore: ScopeRegistryQueries;
  let registryService: ScopeRegistryService;
  let isRuledDistinct: (scope: string) => Promise<boolean>;
  let archiveDeps: ArchiveEphemeralDeps;

  beforeEach(async () => {
    ({ db, queries } = createTestDatabase());
    registryStore = new ScopeRegistryQueries(db);
    registryService = new ScopeRegistryService({ registry: registryStore });
    isRuledDistinct = (scope: string) => registryService.isRuledDistinct(scope);
    archiveDeps = {
      memoryStore: queries,
      dreamStore: new DreamQueries(db),
      vectorIndex: new StubVectorIndex(),
      readResolution: identityResolution,
      isRuledDistinct,
    };

    await seed(queries, CANONICAL, 5);
    await seed(queries, RULED_VARIANT, 2);

    await registryStore.register({
      scope: RULED_VARIANT,
      slug: slugifyScope(RULED_VARIANT),
      claimant_raw: RULED_VARIANT,
      origin_cwd: null,
      status: 'provisional',
    });
    await registryStore.markDistinct(RULED_VARIANT, '2026-09-01T00:00:00.000Z');
  });

  afterEach(() => { db.close(); });

  it('drift and minting agree from ONE store state that the ruled variant stands on its own', async () => {
    const rows = await registryStore.listAll();

    // DRIFT: the ruled variant carries its own per-variant flag, the cluster
    // aggregate reads ruled (it is the only uncovered member), and nothing is
    // adrift — the operator has no ruling left to make here.
    const report = buildScopeDrift(
      await queries.getScopeAggregates(),
      EMPTY_RESOLUTION,
      DistinctRulings.fromRegistryRows(rows),
    );
    const cluster = report.clusters.find(c => c.key === CANONICAL)!;
    expect(cluster.kind).toBe('casing');
    const byScope = Object.fromEntries(cluster.variants.map(v => [v.scope, v]));
    expect(byScope[RULED_VARIANT].ruled_distinct).toBe(true);
    expect(byScope[CANONICAL].ruled_distinct).toBe(false);
    expect(cluster.ruled_distinct).toBe(true);
    expect(cluster.active_rows_adrift).toBe(0);
    expect(report.summary.clusters_actionable).toBe(0);
    expect(report.summary.active_rows_adrift).toBe(0);

    // MINTING: the same registry row resolves the variant to ITSELF — a write
    // on that spelling stays there rather than being folded into the canonical.
    const decision = decideMint(RULED_VARIANT, null, buildMintContext(rows, null));
    expect(decision.kind).toBe('pass');
    expect(decision.scope).toBe(RULED_VARIANT);
  });

  it('hold and archive are structurally inapplicable to a non-ephemeral scope', async () => {
    // Held requires ephemeral SHAPE first — a ruling is not even consulted.
    expect(await buildHoldPredicate(undefined, isRuledDistinct)(RULED_VARIANT)).toBe(false);
    // And the archive action refuses on shape, before the ruling clause.
    await expect(runArchiveEphemeral(archiveDeps, { scope: RULED_VARIANT, apply: false }))
      .rejects.toThrow(/not ephemeral-shaped/);
  });
});
