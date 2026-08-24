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
 * Phase 3 watermark fixture — 6 observations, ids 1..6 in insertion order:
 *   ids 1,2,3 → project:alpha        (Grep 'todo-marker' ×3, distinct sessions →
 *                                     one repeated_tool pattern at minOccurrences 2)
 *   ids 4,5   → project:wf_ab12cd34  (ephemeral workflow-run scope; Grep
 *                                     'legacy-flag' ×2 — WOULD mint at
 *                                     minOccurrences 2 if processed)
 *   id  6     → project:beta         (single obs, no pattern)
 *
 * Grep is deliberately the only tool used: it is not in BASH_TOOLS or
 * FILE_TOOLS, and each observation sits in its own session, so exactly ONE
 * detector (repeated_tool) can fire per scope — pinned mint counts stay honest.
 */
const EPHEMERAL_SCOPE = 'project:wf_ab12cd34';

async function seedFixture(
  obsQueries: ReturnType<typeof createTestObservationsDb>['obsQueries'],
  middleScope: string = EPHEMERAL_SCOPE,
) {
  const rows: { project_scope: string; input_summary: string }[] = [
    { project_scope: 'project:alpha', input_summary: 'todo-marker' }, // id 1
    { project_scope: 'project:alpha', input_summary: 'todo-marker' }, // id 2
    { project_scope: 'project:alpha', input_summary: 'todo-marker' }, // id 3
    { project_scope: middleScope, input_summary: 'legacy-flag' },     // id 4
    { project_scope: middleScope, input_summary: 'legacy-flag' },     // id 5
    { project_scope: 'project:beta', input_summary: 'unique-once' },  // id 6
  ];
  for (let i = 0; i < rows.length; i++) {
    await obsQueries.storeObservation(createTestObservation({
      ...rows[i],
      tool_name: 'Grep',
      session_id: `session-${i + 1}`,
    }));
  }
}

const discoveryConfig = { ...config.discovery, minOccurrences: 2 };

describe('runDiscovery — honest per-scope watermarks + held run rows (Phase 3)', () => {
  it('stamps each completed run with ITS scope max id, not the global batch end', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedFixture(obsQueries);

    await runDiscovery(obsQueries, queries, notReadyIndex, { config: discoveryConfig });

    const [alphaRun] = await obsQueries.listDiscoveryRuns('project:alpha');
    expect(alphaRun.status).toBe('completed');
    expect(alphaRun.observation_start_id).toBe(1);
    expect(alphaRun.observation_end_id).toBe(3); // pinned: alpha's own max id, not last-batch-id 6

    const [betaRun] = await obsQueries.listDiscoveryRuns('project:beta');
    expect(betaRun.status).toBe('completed');
    expect(betaRun.observation_start_id).toBe(6);
    expect(betaRun.observation_end_id).toBe(6);
  });

  it('writes a held run row for the ephemeral scope and mints NOTHING from it', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedFixture(obsQueries);
    const storeSpy = vi.spyOn(queries, 'store');

    await runDiscovery(obsQueries, queries, notReadyIndex, { config: discoveryConfig });

    const [heldRun] = await obsQueries.listDiscoveryRuns(EPHEMERAL_SCOPE);
    expect(heldRun.status).toBe('held');
    expect(heldRun.observation_start_id).toBe(4);
    expect(heldRun.observation_end_id).toBe(5);
    expect(heldRun.observations_analyzed).toBe(2);
    expect(heldRun.memories_created).toBe(0);

    // The negative gate: no memory was ever stored under the ephemeral scope.
    const storedScopes = storeSpy.mock.calls.map(([input]) => input.scope);
    expect(storedScopes.some(s => s?.startsWith('project:wf_'))).toBe(false);

    // POSITIVE precondition — the same fixture with ids 4,5 re-scoped to a
    // real project DOES process them (completed run, memory minted), so the
    // "never stored" assertion above is falsifiable, not vacuous.
    const fresh = createTestObservationsDb();
    const freshMem = createTestDatabase();
    await seedFixture(fresh.obsQueries, 'project:gamma');
    const gammaStoreSpy = vi.spyOn(freshMem.queries, 'store');

    await runDiscovery(fresh.obsQueries, freshMem.queries, notReadyIndex, { config: discoveryConfig });

    const [gammaRun] = await fresh.obsQueries.listDiscoveryRuns('project:gamma');
    expect(gammaRun.status).toBe('completed');
    expect(gammaRun.observation_end_id).toBe(5);
    expect(gammaRun.observations_analyzed).toBe(2);
    expect(gammaRun.memories_created).toBe(1);
    const gammaScopes = gammaStoreSpy.mock.calls.map(([input]) => input.scope);
    expect(gammaScopes).toContain('project:gamma');
  });

  it('the two watermark predicates diverge exactly on held rows', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedFixture(obsQueries);

    await runDiscovery(obsQueries, queries, notReadyIndex, { config: discoveryConfig });

    // Global cursor advances over held rows (starvation fix): completed beta
    // row carries 6, so the held row at 5 is shadowed but present.
    expect(await obsQueries.getLastWatermark()).toBe(6);

    // Per-scope cursor does NOT advance on held rows — the ephemeral scope's
    // observations remain formally unprocessed for a future re-drive.
    expect(await obsQueries.getLastWatermark(EPHEMERAL_SCOPE)).toBe(0);
    expect(await obsQueries.getLastWatermark('project:alpha')).toBe(3);

    // Knock out the completed beta row: the global cursor must now be carried
    // by the HELD row alone — pinning the divergence from both sides.
    const [betaRun] = await obsQueries.listDiscoveryRuns('project:beta');
    await obsQueries.updateDiscoveryRun(betaRun.id, { status: 'failed' });
    expect(await obsQueries.getLastWatermark()).toBe(5);
  });
});
