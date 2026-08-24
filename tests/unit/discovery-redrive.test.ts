import { describe, it, expect, vi } from 'vitest';
import { runRedrive, RedriveNotRuledError } from '../../src/discovery/redrive.js';
import { createTestDatabase, createTestObservationsDb, createTestObservation } from '../fixtures/test-helpers.js';
import { config } from '../../src/config/config.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';

/** A zero-vector stub that always reports isReady = false — the dedup path falls
 * back to always-create with no embed call, which is all these tests need. */
const notReadyIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

const HELD_SCOPE = 'project:wf_ab12cd34';   // matches the workflow-run ephemeral rule
const RULED_SCOPE = 'project:gamma';

/**
 * Pinned at test-write time (brief Step 1): the stored memory's confidence is
 *   computeConfidence(3, 19)
 *     = min(0.85, 0.5 + 0.35 * (1 - 1/ln(4)) + min(0.05, 0.05 * (19/7)))
 * evaluated with node against src/discovery/confidence.ts's formula.
 */
const PINNED_CONFIDENCE_3_OBS_19_DAYS = 0.6475283678444315;

/**
 * Seed the held scope with 3 same-pattern observations (one repeated_tool
 * candidate at minOccurrences 3): Grep 'legacy-flag' across 3 distinct
 * sessions, started_at spanning 2026-06-01 → 2026-06-20 (19 days — satisfies
 * both evidence bars: count ≥ minOccurrences, multi-day span). started_at is
 * stamped by SQL after insert because storeObservation always writes now() —
 * the re-drive must compute its signals from these STORED historical values.
 */
async function seedHeldObservations(
  db: ReturnType<typeof createTestObservationsDb>['db'],
  obsQueries: ReturnType<typeof createTestObservationsDb>['obsQueries'],
): Promise<void> {
  const startedAt = ['2026-06-01 00:00:00', '2026-06-10 00:00:00', '2026-06-20 00:00:00'];
  for (let i = 0; i < startedAt.length; i++) {
    const row = await obsQueries.storeObservation(createTestObservation({
      project_scope: HELD_SCOPE,
      tool_name: 'Grep',
      input_summary: 'legacy-flag',
      session_id: `session-${i + 1}`,
    }));
    db.prepare('UPDATE observations SET started_at = ? WHERE id = ?').run(startedAt[i], row.id);
  }
}

const discoveryConfig = { ...config.discovery, minOccurrences: 3 };

/**
 * I2 (final review): the live pass's record that a batch of held-scope
 * observations was CONSUMED — a `held` run row, which advances the GLOBAL
 * watermark (the re-drive bound) to `endId` while leaving the per-scope
 * watermark at 0.
 */
async function seedHeldRun(
  obsQueries: ReturnType<typeof createTestObservationsDb>['obsQueries'],
  startId: number,
  endId: number,
  count: number,
): Promise<void> {
  const run = await obsQueries.createDiscoveryRun(HELD_SCOPE, startId);
  await obsQueries.updateDiscoveryRun(run.id, {
    status: 'held',
    observation_end_id: endId,
    observations_analyzed: count,
    completed_at: new Date().toISOString(),
  });
}

describe('runRedrive — time-preserving re-drive for held scopes (Phase 3)', () => {
  it('refuses an unruled scope', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries);
    const storeSpy = vi.spyOn(queries, 'store');

    // resolveTo returns the scope unchanged (no alias, no registry ruling) and
    // no isConfirmed is wired → the scope has no ruling at all.
    await expect(runRedrive(obsQueries, queries, notReadyIndex, {
      scope: HELD_SCOPE,
      resolveTo: async (raw) => raw,
      config: discoveryConfig,
    })).rejects.toThrow(RedriveNotRuledError);

    // The error names the scope.
    await expect(runRedrive(obsQueries, queries, notReadyIndex, {
      scope: HELD_SCOPE,
      resolveTo: async (raw) => raw,
      config: discoveryConfig,
    })).rejects.toThrow(HELD_SCOPE);

    // Zero run rows written, zero memories.
    expect(await obsQueries.listDiscoveryRuns(HELD_SCOPE)).toHaveLength(0);
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('re-drives a ruled scope with original time spans', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries);

    // The invariant's baseline: observation rows as stored, before the re-drive.
    const before = db.prepare('SELECT id, started_at, created_at FROM observations ORDER BY id')
      .all() as { id: number; started_at: string; created_at: string }[];
    expect(before).toHaveLength(3);

    // The live pass consumed these (held row = the I2 bound source).
    await seedHeldRun(obsQueries, before[0].id, before[before.length - 1].id, 3);

    const result = await runRedrive(obsQueries, queries, notReadyIndex, {
      scope: HELD_SCOPE,
      resolveTo: async () => RULED_SCOPE, // ruled: wf_ scope → project:gamma
      config: discoveryConfig,
    });

    expect(result.resolved_scope).toBe(RULED_SCOPE);
    expect(result.project_scope).toBe(HELD_SCOPE);
    expect(result.observations_analyzed).toBe(3);
    expect(result.patterns_found).toBe(1);
    expect(result.memories_created).toBe(1);
    expect(result.memories_reinforced).toBe(0);

    // Exactly one memory, in the RULED scope, none in the raw held scope.
    const gammaIds = await queries.getFilteredIds({ scope: RULED_SCOPE, include_archived: false });
    expect(gammaIds).toHaveLength(1);
    expect(await queries.getFilteredIds({ scope: HELD_SCOPE, include_archived: false })).toHaveLength(0);

    // Its confidence reflects the ORIGINAL evidence span (observation_span_days = 19,
    // 2026-06-01 → 2026-06-20), not the re-drive's own clock: the pinned
    // computeConfidence(3, 19) value.
    const memory = await queries.get(gammaIds[0]);
    expect(memory).not.toBeNull();
    expect(memory!.confidence).toBe(PINNED_CONFIDENCE_3_OBS_19_DAYS);
    const metadata = JSON.parse(memory!.metadata ?? '{}');
    expect(metadata.evidence_count).toBe(3);
    expect(metadata.observation_span_days).toBe(19);

    // Run rows: the seeded held row plus the re-drive's OWN completed row —
    // RAW scope lineage, end id = max seeded id.
    const runs = await obsQueries.listDiscoveryRuns(HELD_SCOPE);
    expect(runs).toHaveLength(2); // seeded held + completed re-drive
    const completed = runs.filter(r => r.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].project_scope).toBe(HELD_SCOPE);
    expect(completed[0].observation_start_id).toBe(before[0].id);
    expect(completed[0].observation_end_id).toBe(before[before.length - 1].id);
    expect(completed[0].observations_analyzed).toBe(3);
    expect(completed[0].memories_created).toBe(1);

    // THE invariant: no observation rows created, no timestamps rewritten —
    // COUNT unchanged and started_at/created_at byte-identical.
    const after = db.prepare('SELECT id, started_at, created_at FROM observations ORDER BY id').all();
    expect(after).toEqual(before);
  });

  it('a second re-drive is a no-op (per-scope watermark advanced)', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries);
    await seedHeldRun(obsQueries, 1, 3, 3); // live pass consumed ids 1–3

    const options = {
      scope: HELD_SCOPE,
      resolveTo: async () => RULED_SCOPE,
      config: discoveryConfig,
    };
    const first = await runRedrive(obsQueries, queries, notReadyIndex, options);
    expect(first.memories_created).toBe(1);

    const second = await runRedrive(obsQueries, queries, notReadyIndex, options);

    // The completed run advanced the per-scope watermark past every seeded id,
    // so the second re-drive sees an empty first page and leaves NO trace: no
    // memories, no new run rows (exact count stays at held-seed + first run).
    expect(second.observations_analyzed).toBe(0);
    expect(second.patterns_found).toBe(0);
    expect(second.memories_created).toBe(0);
    expect(second.memories_reinforced).toBe(0);
    expect(await queries.getFilteredIds({ scope: RULED_SCOPE, include_archived: false })).toHaveLength(1);
    expect(await obsQueries.listDiscoveryRuns(HELD_SCOPE)).toHaveLength(2);
  });

  it('an unchanged resolution proceeds when the registry row is confirmed', async () => {
    // The refusal predicate is a conjunction: unchanged AND not confirmed. This
    // pins the second half — an operator who CONFIRMED the scope as legitimate
    // as-is gets a re-drive into that same scope, not a 409.
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries);
    await seedHeldRun(obsQueries, 1, 3, 3); // live pass consumed ids 1–3

    const result = await runRedrive(obsQueries, queries, notReadyIndex, {
      scope: HELD_SCOPE,
      resolveTo: async (raw) => raw,           // unchanged…
      isConfirmed: async () => true,           // …but confirmed by ruling
      config: discoveryConfig,
    });

    expect(result.resolved_scope).toBe(HELD_SCOPE);
    expect(result.memories_created).toBe(1);
    expect(await queries.getFilteredIds({ scope: HELD_SCOPE, include_archived: false })).toHaveLength(1);
  });
});

describe('runRedrive — global-watermark bound (final review I2)', () => {
  it('processes only ids the live path already consumed; never advances the global watermark', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries); // held-scope ids 1, 2, 3
    // The live pass consumed 1–3: its held row is the record.
    await seedHeldRun(obsQueries, 1, 3, 3);

    // Later observations with NO live pass over them: another scope's id 4
    // (would be silently skipped if a redrive run row stamped an end id past
    // it) and a newer held-scope id 5.
    const other = await obsQueries.storeObservation(createTestObservation({
      project_scope: 'project:delta', tool_name: 'Read',
      input_summary: 'other-scope-doc', session_id: 'delta-1',
    }));
    const late = await obsQueries.storeObservation(createTestObservation({
      project_scope: HELD_SCOPE, tool_name: 'Grep',
      input_summary: 'legacy-flag', session_id: 'session-4',
    }));
    expect(other.id).toBe(4);
    expect(late.id).toBe(5);

    const preBound = await obsQueries.getLastWatermark(); // global, held rows count
    expect(preBound).toBe(3);

    const result = await runRedrive(obsQueries, queries, notReadyIndex, {
      scope: HELD_SCOPE,
      resolveTo: async () => RULED_SCOPE,
      config: discoveryConfig,
    });

    // Exactly [1, 2, 3] — id 5 waits for its own held row + a later re-drive.
    expect(result.observations_analyzed).toBe(3);
    const completed = (await obsQueries.listDiscoveryRuns(HELD_SCOPE)).filter(r => r.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].observation_end_id).toBe(3);

    // The global watermark did not move past its pre-redrive value: the next
    // live pass still sees ids 4 and 5.
    expect(await obsQueries.getLastWatermark()).toBe(3);
  });

  it('a subsequent live pass over the newer held observation makes it re-drivable', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries); // held-scope ids 1, 2, 3
    await seedHeldRun(obsQueries, 1, 3, 3);
    await obsQueries.storeObservation(createTestObservation({
      project_scope: 'project:delta', tool_name: 'Read',
      input_summary: 'other-scope-doc', session_id: 'delta-1',
    })); // id 4
    await obsQueries.storeObservation(createTestObservation({
      project_scope: HELD_SCOPE, tool_name: 'Grep',
      input_summary: 'legacy-flag', session_id: 'session-4',
    })); // id 5

    const options = {
      scope: HELD_SCOPE,
      resolveTo: async () => RULED_SCOPE,
      config: discoveryConfig,
    };
    const first = await runRedrive(obsQueries, queries, notReadyIndex, options);
    expect(first.observations_analyzed).toBe(3); // bounded at 3 (above)

    // The next live pass consumes ids 4–5: a completed run for the other
    // scope, a held row for the held scope's id 5.
    const otherRun = await obsQueries.createDiscoveryRun('project:delta', 4);
    await obsQueries.updateDiscoveryRun(otherRun.id, {
      status: 'completed', observation_end_id: 4, observations_analyzed: 1,
      completed_at: new Date().toISOString(),
    });
    await seedHeldRun(obsQueries, 5, 5, 1);

    // A second re-drive now picks up exactly id 5.
    const second = await runRedrive(obsQueries, queries, notReadyIndex, options);
    expect(second.observations_analyzed).toBe(1);
    const completed = (await obsQueries.listDiscoveryRuns(HELD_SCOPE))
      .filter(r => r.status === 'completed')
      .map(r => r.observation_end_id)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(completed).toEqual([3, 5]);
  });

  it('a re-drive before any live pass is a clean no-op: empty result, no run row', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();
    await seedHeldObservations(db, obsQueries); // ids 1–3, NO run rows at all

    const result = await runRedrive(obsQueries, queries, notReadyIndex, {
      scope: HELD_SCOPE,
      resolveTo: async () => RULED_SCOPE,
      config: discoveryConfig,
    });

    expect(result.observations_analyzed).toBe(0);
    expect(result.memories_created).toBe(0);
    expect(result.run_id).toBe(0);
    expect(await obsQueries.listDiscoveryRuns(HELD_SCOPE)).toHaveLength(0);
    expect(await queries.getFilteredIds({ scope: RULED_SCOPE, include_archived: false })).toHaveLength(0);
  });
});
