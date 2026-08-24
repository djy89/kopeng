/**
 * Round-2 fix CO5+S1a: ONE definition of "held" — buildHoldPredicate in
 * src/discovery/hold.ts. Held iff ephemeral-SHAPED (ephemeralReason) AND not
 * alias-mapped (canonicalize(raw) === raw). The alias entry IS the ruling:
 * a ruled ephemeral scope releases — its observations resolve through the
 * normal alias-first path to the target and its rows return to the retention
 * clock — while an unruled one stays held + purge-exempt (spec §7 / R-B).
 *
 * Predicate units here, plus the discovery-engine wiring (a ruled wf_ scope's
 * observations MINT under the target; an unruled one stays held). The
 * maintenance-§1 wiring is pinned in tests/unit/purge-exemption.test.ts.
 * All referents synthetic (fixture hygiene).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildHoldPredicate } from '../../src/discovery/hold.js';
import { runDiscovery } from '../../src/discovery/discovery-engine.js';
import { createTestDatabase, createTestObservationsDb, createTestObservation } from '../fixtures/test-helpers.js';
import { config } from '../../src/config/config.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';

/** Alias table stub: the wf_ scope is RULED into project:fuel-dashboard. */
const ruledCanonicalize = async (s: string): Promise<string> =>
  s === 'project:wf_ab12cd34' ? 'project:fuel-dashboard' : s;

describe('buildHoldPredicate (CO5)', () => {
  it('unruled ephemeral-shaped scope → held', async () => {
    const isHeld = buildHoldPredicate(async (s) => s); // empty table = identity
    expect(await isHeld('project:wf_ab12cd34')).toBe(true);
  });

  it('ALIAS-MAPPED ephemeral-shaped scope → NOT held (the ruling releases it)', async () => {
    const isHeld = buildHoldPredicate(ruledCanonicalize);
    expect(await isHeld('project:wf_ab12cd34')).toBe(false);
  });

  it('non-ephemeral scope → never held, mapped or not', async () => {
    const isHeld = buildHoldPredicate(ruledCanonicalize);
    expect(await isHeld('project:fuel-dashboard')).toBe(false);
    expect(await isHeld('client:acme-foods')).toBe(false);
  });

  it('no canonicalize wired → shape-only back-compat', async () => {
    const isHeld = buildHoldPredicate();
    expect(await isHeld('project:wf_ab12cd34')).toBe(true);
    expect(await isHeld('project:fuel-dashboard')).toBe(false);
  });

  it('a throwing canonicalize fails toward HOLDING (never mint or purge on a broken table)', async () => {
    const isHeld = buildHoldPredicate(async () => { throw new Error('table down'); });
    expect(await isHeld('project:wf_ab12cd34')).toBe(true);
    expect(await isHeld('project:fuel-dashboard')).toBe(false); // shape gate first, no call
  });
});

/** Not-ready vector stub (discovery-normalized-grouping.test.ts pattern). */
const notReadyIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

const discoveryConfig = { ...config.discovery, minOccurrences: 3 };

/** 4 same-tool observations on the wf_ scope, distinct sessions (ids 1..4). */
async function seedWfObservations(
  obsQueries: ReturnType<typeof createTestObservationsDb>['obsQueries'],
) {
  for (let i = 0; i < 4; i++) {
    await obsQueries.storeObservation(createTestObservation({
      project_scope: 'project:wf_ab12cd34',
      tool_name: 'Grep',
      input_summary: 'shared-config-check',
      session_id: `session-${i + 1}`,
    }));
  }
}

describe('runDiscovery held short-circuit uses the shared predicate (CO5)', () => {
  it('UNRULED wf_ scope stays held: held run row, nothing minted', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedWfObservations(obsQueries);
    const storeSpy = vi.spyOn(queries, 'store');

    const result = await runDiscovery(obsQueries, queries, notReadyIndex, {
      config: discoveryConfig,
      isHeld: buildHoldPredicate(async (s) => s), // empty alias table
    });

    expect(result.memories_created).toBe(0);
    expect(storeSpy).not.toHaveBeenCalled();
    const [run] = await obsQueries.listDiscoveryRuns('project:wf_ab12cd34');
    expect(run.status).toBe('held');
    expect(run.observation_end_id).toBe(4);
    expect(run.observations_analyzed).toBe(4);
  });

  it('RULED (alias-mapped) wf_ scope is NOT held: the memory lands on the TARGET scope', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedWfObservations(obsQueries);
    const storeSpy = vi.spyOn(queries, 'store');

    const result = await runDiscovery(obsQueries, queries, notReadyIndex, {
      config: discoveryConfig,
      isHeld: buildHoldPredicate(ruledCanonicalize),
      // The engine mirror of server.ts's alias-first resolveScope: with the
      // scope no longer held, resolution routes it to the ruled target.
      resolveScope: async (raw, _origin) => ruledCanonicalize(raw),
    });

    // POSITIVE outcome pinned: the SAME fixture that stayed held above now
    // mints exactly one memory — under the ruled target, never the wf_ scope.
    expect(result.memories_created).toBe(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0][0].scope).toBe('project:fuel-dashboard');

    // Lineage stays raw: one COMPLETED run row under the wf_ scope, no held row.
    const runs = await obsQueries.listDiscoveryRuns('project:wf_ab12cd34');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].observation_end_id).toBe(4);
  });

  it('absent isHeld keeps the shape-only pre-round-2 behavior (unit-stub back-compat)', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedWfObservations(obsQueries);

    const result = await runDiscovery(obsQueries, queries, notReadyIndex, {
      config: discoveryConfig,
      // No isHeld — even with a resolveScope that WOULD map the wf_ scope,
      // shape-only holding wins (the pre-round-2 contract stubs rely on).
      resolveScope: async (raw, _origin) => ruledCanonicalize(raw),
    });

    expect(result.memories_created).toBe(0);
    const [run] = await obsQueries.listDiscoveryRuns('project:wf_ab12cd34');
    expect(run.status).toBe('held');
  });
});
