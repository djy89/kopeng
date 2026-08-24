import { describe, it, expect, vi } from 'vitest';
import { runDiscovery } from '../../src/discovery/discovery-engine.js';
import { createTestDatabase, createTestObservationsDb, createTestObservation } from '../fixtures/test-helpers.js';
import { config } from '../../src/config/config.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';

/** A zero-vector stub that always reports isReady = false — runDiscovery falls
 * back to always-create with no embed/dedup call, which is all these tests need. */
const notReadyIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

/**
 * Task 8 normalized-grouping fixture — 4 observations, ids 1..4 in insertion
 * order, all the SAME tool+input (Grep 'shared-config-check'), each in its own
 * session so only the repeated_tool detector can fire:
 *   ids 1,2 → client:Acme-Foods   (alias-cased variant)
 *   ids 3,4 → client:acme-foods   (canonical)
 *
 * At minOccurrences 3, neither raw scope's 2 observations reach the bar alone —
 * only the pooled 4 do. That split IS the test: detection pools evidence across
 * alias variants iff resolveScope maps them to one resolved scope.
 */
async function seedFixture(
  obsQueries: ReturnType<typeof createTestObservationsDb>['obsQueries'],
) {
  const scopes = [
    'client:Acme-Foods', // id 1
    'client:Acme-Foods', // id 2
    'client:acme-foods', // id 3
    'client:acme-foods', // id 4
  ];
  for (let i = 0; i < scopes.length; i++) {
    await obsQueries.storeObservation(createTestObservation({
      project_scope: scopes[i],
      tool_name: 'Grep',
      input_summary: 'shared-config-check',
      session_id: `session-${i + 1}`,
    }));
  }
}

const discoveryConfig = { ...config.discovery, minOccurrences: 3 };

/** Phase 3 registry stub: both casings resolve to the canonical client scope. */
const resolveScope = async (raw: string, _origin: string | null): Promise<string> =>
  raw === 'client:Acme-Foods' ? 'client:acme-foods' : raw;

describe('runDiscovery — normalized detection grouping, raw lineage (Task 8)', () => {
  it('alias variants group together for detection: split evidence now clears the bar', async () => {
    // POSITIVE precondition first — pre-Phase-3 behavior (resolveScope absent):
    // 2+2 never reaches the 3-bar, so 0 memories. This makes the with-resolveScope
    // assertion below falsifiable, not vacuous.
    const baseline = createTestObservationsDb();
    const baselineMem = createTestDatabase();
    await seedFixture(baseline.obsQueries);
    const baselineStoreSpy = vi.spyOn(baselineMem.queries, 'store');

    const baselineResult = await runDiscovery(
      baseline.obsQueries, baselineMem.queries, notReadyIndex, { config: discoveryConfig }
    );
    expect(baselineResult.memories_created).toBe(0);
    expect(baselineStoreSpy).not.toHaveBeenCalled();

    // With resolveScope: both raws pool under client:acme-foods → the 4
    // observations clear minOccurrences 3 → exactly 1 memory, canonical scope.
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedFixture(obsQueries);
    const storeSpy = vi.spyOn(queries, 'store');

    const result = await runDiscovery(
      obsQueries, queries, notReadyIndex, { config: discoveryConfig, resolveScope }
    );

    expect(result.memories_created).toBe(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0][0].scope).toBe('client:acme-foods'); // pinned
  });

  it('run rows stay RAW-keyed with per-raw end ids under normalized grouping', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedFixture(obsQueries);

    await runDiscovery(
      obsQueries, queries, notReadyIndex, { config: discoveryConfig, resolveScope }
    );

    // One run row per RAW scope (Task 6 preserved), each stamped with that raw
    // scope's OWN id range — pinned literals from the fixture's insertion order.
    const [casedRun] = await obsQueries.listDiscoveryRuns('client:Acme-Foods');
    expect(casedRun.status).toBe('completed');
    expect(casedRun.observation_start_id).toBe(1);
    expect(casedRun.observation_end_id).toBe(2);
    expect(casedRun.observations_analyzed).toBe(2);

    const [canonicalRun] = await obsQueries.listDiscoveryRuns('client:acme-foods');
    expect(canonicalRun.status).toBe('completed');
    expect(canonicalRun.observation_start_id).toBe(3);
    expect(canonicalRun.observation_end_id).toBe(4);
    expect(canonicalRun.observations_analyzed).toBe(2);

    // No run row was ever keyed by the RESOLVED scope beyond its own raw rows:
    // exactly the two raw-keyed rows exist in total.
    const allRuns = await obsQueries.listDiscoveryRuns();
    expect(allRuns.length).toBe(2);
  });

  it('observation rows are untouched — raw project_scope survives', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedFixture(obsQueries);

    await runDiscovery(
      obsQueries, queries, notReadyIndex, { config: discoveryConfig, resolveScope }
    );

    const rows = db.prepare('SELECT id, project_scope FROM observations ORDER BY id ASC').all() as
      { id: number; project_scope: string }[];
    expect(rows).toEqual([
      { id: 1, project_scope: 'client:Acme-Foods' },
      { id: 2, project_scope: 'client:Acme-Foods' },
      { id: 3, project_scope: 'client:acme-foods' },
      { id: 4, project_scope: 'client:acme-foods' },
    ]);
  });
});
