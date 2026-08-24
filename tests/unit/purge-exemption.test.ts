/**
 * Task 7 (Phase 3): purge exemption for held (ephemeral-scope) observations.
 *
 * A `held` discovery run's observations were observed but never minted from —
 * their per-scope watermark never advanced (see GLOBAL/SCOPE_WATERMARK_STATUSES
 * in interfaces.ts), so the retention purge must not destroy the only copy
 * before a future operator ruling can re-drive the scope. `purgeOlderThan`
 * gains an `exemptScopes` param; maintenance §1 computes the list from the
 * SHARED ephemeral predicate (`ephemeralReason`) over the live scope inventory.
 *
 * All referents synthetic (fixture hygiene).
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { runDiscoveryMaintenance } from '../../src/discovery/maintenance.js';
import { buildHoldPredicate } from '../../src/discovery/hold.js';
import { createTestDatabase, createTestObservationsDb } from '../fixtures/test-helpers.js';

/**
 * Shared seed: 2 aged rows on a normal project scope, 2 aged rows on an
 * ephemeral workflow-run scope, 1 fresh row. Aged rows pin `created_at` in
 * 2026-06 — far past both the test's 30-day cutoff and the default 7-day
 * retention; the fresh row uses datetime('now').
 */
function seedObservations(db: Database.Database): void {
  const insertAged = db.prepare(
    `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, created_at)
     VALUES (?, ?, ?, 'completed', ?, ?)`
  );
  insertAged.run('s1', 'project:old-normal', 'Bash', '2026-06-01 10:00:00', '2026-06-01 10:00:00');
  insertAged.run('s1', 'project:old-normal', 'Read', '2026-06-02 10:00:00', '2026-06-02 10:00:00');
  insertAged.run('s2', 'project:wf_ab12cd34', 'Bash', '2026-06-03 10:00:00', '2026-06-03 10:00:00');
  insertAged.run('s2', 'project:wf_ab12cd34', 'Edit', '2026-06-04 10:00:00', '2026-06-04 10:00:00');
  db.prepare(
    `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, created_at)
     VALUES ('s3', 'project:fresh', 'Bash', 'completed', datetime('now'), datetime('now'))`
  ).run();
}

describe('Phase 3: purge exemption for held scopes', () => {
  it('purgeOlderThan deletes aged rows but leaves exempt scopes untouched', async () => {
    // POSITIVE precondition on an identical seed: with no exemption, every
    // aged row (both scopes) is swept — proves the seed actually ages out and
    // the exemption below is what saves the wf_ rows, not a broken cutoff.
    const control = createTestObservationsDb();
    seedObservations(control.db);
    expect(await control.obsQueries.purgeOlderThan(30, 1000, [])).toBe(4);

    const { db, obsQueries } = createTestObservationsDb();
    seedObservations(db);
    const deleted = await obsQueries.purgeOlderThan(30, 1000, ['project:wf_ab12cd34']);
    expect(deleted).toBe(2);

    // Survivors: the 2 exempt wf_ rows (below the aged max id — the windowed
    // delete's inner SELECT must re-apply the exemption) + the fresh row.
    const remaining = db
      .prepare('SELECT project_scope FROM observations ORDER BY id')
      .all() as { project_scope: string }[];
    expect(remaining.map((r) => r.project_scope)).toEqual([
      'project:wf_ab12cd34',
      'project:wf_ab12cd34',
      'project:fresh',
    ]);
  });

  it('maintenance computes the exempt list from the shared ephemeral predicate and reports it', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    seedObservations(db);
    const { queries } = createTestDatabase();

    // §1 runs with or without audit deps — the purge is not an archive site.
    const result = await runDiscoveryMaintenance(obsQueries, queries);

    // The exempt list is the ephemeral subset of the live scope inventory
    // (project:old-normal and project:fresh are real scopes; only the
    // workflow-run scope matches ephemeralReason), sorted.
    expect(result.observations_exempted_scopes).toEqual(['project:wf_ab12cd34']);

    // Default retention is 7 days: the two aged old-normal rows purge, the
    // two aged wf_ rows survive on exemption, the fresh row survives on age.
    expect(result.observations_purged).toBe(2);
    const wfCount = db
      .prepare("SELECT COUNT(*) AS c FROM observations WHERE project_scope = 'project:wf_ab12cd34'")
      .get() as { c: number };
    expect(wfCount.c).toBe(2);
    const total = db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number };
    expect(total.c).toBe(3);
  });

  it('CO5+S1a: an UNRULED wf_ scope stays exempt when the shared predicate is wired with an identity table', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    seedObservations(db);
    const { queries } = createTestDatabase();

    const result = await runDiscoveryMaintenance(obsQueries, queries, undefined, {
      isHeld: buildHoldPredicate(async (s) => s), // empty alias table = no ruling anywhere
    });

    expect(result.observations_exempted_scopes).toEqual(['project:wf_ab12cd34']);
    expect(result.observations_purged).toBe(2);
    const wfCount = db
      .prepare("SELECT COUNT(*) AS c FROM observations WHERE project_scope = 'project:wf_ab12cd34'")
      .get() as { c: number };
    expect(wfCount.c).toBe(2);
  });

  it('CO5+S1a: a RULED (alias-mapped) wf_ scope is NOT exempt — its aged rows return to the retention clock (spec §7)', async () => {
    const { db, obsQueries } = createTestObservationsDb();
    seedObservations(db);
    const { queries } = createTestDatabase();

    // The ruling: an alias entry maps the wf_ scope to its real target.
    const result = await runDiscoveryMaintenance(obsQueries, queries, undefined, {
      isHeld: buildHoldPredicate(async (s) =>
        s === 'project:wf_ab12cd34' ? 'project:fuel-dashboard' : s),
    });

    // No scope is exempt any more; ALL four aged rows purge (2 old-normal +
    // 2 wf_) — pinned survivor count: only the fresh row remains.
    expect(result.observations_exempted_scopes).toEqual([]);
    expect(result.observations_purged).toBe(4);
    const remaining = db
      .prepare('SELECT project_scope FROM observations ORDER BY id')
      .all() as { project_scope: string }[];
    expect(remaining.map((r) => r.project_scope)).toEqual(['project:fresh']);
  });

  it('S1b: an exemption list past SQLite’s bound-parameter cap still purges (temp-table anti-join, chunked)', async () => {
    // 33 000 scopes exceeds every default SQLITE_MAX_VARIABLE_NUMBER build
    // (999 historically, 32 766 since 3.32) — the pre-fix inline `NOT IN (?,…)`
    // threw "too many SQL variables" and the WHOLE purge died, which is the
    // failure mode where holding more scopes silently stops retention.
    const { db, obsQueries } = createTestObservationsDb();
    seedObservations(db);
    const bigExemptList = Array.from({ length: 33_000 }, (_, i) => `project:wf_${i.toString(16).padStart(8, '0')}`);
    bigExemptList.push('project:wf_ab12cd34'); // the seeded held scope rides along

    const deleted = await obsQueries.purgeOlderThan(30, 1000, bigExemptList);
    expect(deleted).toBe(2); // the two aged old-normal rows

    const remaining = db
      .prepare('SELECT project_scope FROM observations ORDER BY id')
      .all() as { project_scope: string }[];
    expect(remaining.map((r) => r.project_scope)).toEqual([
      'project:wf_ab12cd34',
      'project:wf_ab12cd34',
      'project:fresh',
    ]);
  });
});
