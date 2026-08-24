/**
 * Phase 3, Task 12 — every discovery_runs consumer handles 'held' DELIBERATELY.
 *
 * A 'held' run row records an ephemeral scope whose observations were observed
 * but never minted from (Task 6). This suite pins each consumer's
 * include/exclude choice so a future change can't silently flip one:
 *
 *  - /api/ops/cache-stats totals + dedup ratio: EXCLUDE held (a held run minted
 *    nothing — counting its observations would dilute the ratio's denominator
 *    context and inflate sample_size).
 *  - /api/ops/discovery-status recent_runs: INCLUDE held, labeled — the mapped
 *    row shape carries `status` so the viz can distinguish.
 *  - /api/ops/discovery-status runs_last_hour + last_run_at: INCLUDE held — a
 *    held pass consumed observations and stamped completed_at; excluding it
 *    would make an all-ephemeral hour look like a dead engine (the exact
 *    starvation scenario Task 6 fixed).
 *  - getActiveRun (concurrency guard): held is TERMINAL — it must never read as
 *    active, or one held row would block every future discovery pass.
 *  - listDiscoveryRuns (backing /api/discoveries/runs): unfiltered by design —
 *    held rows appear with their status; the raw listing is the debug surface.
 *
 * NOT re-tested here (already deliberate, own suites):
 *  - watermark predicates (global advances over held, per-scope does not):
 *    tests/unit/discovery-watermarks.test.ts (Task 6)
 *  - getHeldRunSummary (held-only by definition): tests/unit/ops-scope-registry.test.ts (Task 8)
 *  - re-drive cursor: tests/unit/discovery-redrive.test.ts (Task 9)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { MemoryQueries } from '../../src/database/queries.js';
import type { ObservationQueries } from '../../src/database/observation-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import { createTestObservationsDb } from '../fixtures/test-helpers.js';

function lifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
    backup: async () => '/tmp/test-backup.db',
  };
}

/** Seed one run row end-to-end: create (status 'running') then drive it to the
 * given terminal state with pinned counters. Returns the run id. */
async function seedRun(
  obsQueries: ObservationQueries,
  opts: {
    scope: string;
    status: 'completed' | 'failed' | 'held' | 'running';
    analyzed?: number;
    patterns?: number;
    created?: number;
    reinforced?: number;
    completedAt?: string;
  },
): Promise<number> {
  const run = await obsQueries.createDiscoveryRun(opts.scope, 0);
  if (opts.status !== 'running') {
    await obsQueries.updateDiscoveryRun(run.id, {
      status: opts.status,
      observation_end_id: 10,
      observations_analyzed: opts.analyzed ?? 0,
      patterns_found: opts.patterns ?? 0,
      memories_created: opts.created ?? 0,
      memories_reinforced: opts.reinforced ?? 0,
      completed_at: opts.completedAt ?? new Date().toISOString(),
    });
  }
  return run.id;
}

describe('held-run consumers (Phase 3, Task 12)', () => {
  let app: FastifyInstance;
  let memoryDb: Database.Database;
  let obsDb: Database.Database;
  let obsQueries: ObservationQueries;
  let heldCompletedAt: string;

  beforeAll(async () => {
    memoryDb = new Database(':memory:');
    memoryDb.pragma('journal_mode = WAL');
    const { runMigrations } = await import('../../src/database/migrations.js');
    runMigrations(memoryDb);

    const testObs = createTestObservationsDb();
    obsDb = testObs.db;
    obsQueries = testObs.obsQueries;

    // Fixture: 2 completed, 1 failed, 1 held (held last → newest by id).
    // Counters are all distinct primes-ish so any leak into a total is visible.
    await seedRun(obsQueries, { scope: 'project:alpha', status: 'completed', analyzed: 10, patterns: 2, created: 3, reinforced: 1 });
    await seedRun(obsQueries, { scope: 'project:beta', status: 'completed', analyzed: 5, patterns: 1, created: 1, reinforced: 1 });
    await seedRun(obsQueries, { scope: 'project:gamma', status: 'failed', analyzed: 4, patterns: 0, created: 0, reinforced: 0 });
    heldCompletedAt = new Date().toISOString();
    await seedRun(obsQueries, { scope: 'project:wf_ab12cd34', status: 'held', analyzed: 7, completedAt: heldCompletedAt });

    const embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);
    app = Fastify({ logger: false });
    registerRoutes(app, {
      stores: { queries: new MemoryQueries(memoryDb), observations: obsQueries },
      services: { embeddingIndex },
      lifecycle: lifecycleStub(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    memoryDb.close();
    obsDb.close();
  });

  describe('/api/ops/cache-stats — EXCLUDES held (and failed)', () => {
    it('totals, sample_size, and dedup ratio come from completed runs only', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ops/cache-stats' });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload).data;
      // 2 completed runs — the held (analyzed 7) and failed (analyzed 4) rows
      // must not leak into any aggregate.
      expect(data.sample_size).toBe(2);
      expect(data.totals).toEqual({
        observations_analyzed: 15,
        patterns_found: 3,
        memories_created: 4,
        memories_reinforced: 2,
      });
      // Pinned ratio: reinforced / (created + reinforced) = 2 / 6.
      expect(data.dedup_ratio).toBeCloseTo(2 / 6, 10);
    });
  });

  describe('/api/ops/discovery-status — INCLUDES held, labeled', () => {
    it('recent_runs carries the held row with status: "held" and its counters', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ops/discovery-status' });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload).data;
      const held = data.recent_runs.filter((r: { status: string }) => r.status === 'held');
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        project_scope: 'project:wf_ab12cd34',
        status: 'held',
        observations_analyzed: 7,
        memories_created: 0,
      });
      // All four seeded rows are present — the listing is unfiltered.
      expect(data.recent_runs).toHaveLength(4);
    });

    it('runs_last_hour counts the held pass (engine activity, status-blind)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ops/discovery-status' });
      const data = JSON.parse(res.payload).data;
      // All 4 seeded rows carry a fresh completed_at. The counter is a
      // liveness sparkline: a held pass consumed observations, so it counts —
      // an hour of purely ephemeral traffic must not read as a dead engine.
      expect(data.runs_last_hour).toBe(4);
    });

    it('last_run_at reflects the held pass when it is the newest row', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ops/discovery-status' });
      const data = JSON.parse(res.payload).data;
      expect(data.last_run_at).toBe(heldCompletedAt);
    });
  });

  describe('getActiveRun — held is terminal, never active', () => {
    it('a held run does not register as active (global or per-scope)', async () => {
      // The fixture holds only terminal rows (completed/failed/held).
      expect(await obsQueries.getActiveRun()).toBeNull();
      expect(await obsQueries.getActiveRun('project:wf_ab12cd34')).toBeNull();
    });

    it('a running run registers, then vanishes from active once driven to held', async () => {
      const id = await seedRun(obsQueries, { scope: 'project:wf_ffffffff', status: 'running' });
      expect((await obsQueries.getActiveRun())?.id).toBe(id);
      expect((await obsQueries.getActiveRun('project:wf_ffffffff'))?.id).toBe(id);

      await obsQueries.updateDiscoveryRun(id, {
        status: 'held',
        observation_end_id: 20,
        observations_analyzed: 3,
        completed_at: new Date().toISOString(),
      });
      // If held ever counted as active, this single row would block every
      // future discovery pass behind the stale-run threshold.
      expect(await obsQueries.getActiveRun()).toBeNull();
      expect(await obsQueries.getActiveRun('project:wf_ffffffff')).toBeNull();
    });
  });

  describe('listDiscoveryRuns — unfiltered raw listing (backs /api/discoveries/runs)', () => {
    it('returns held rows alongside every other status', async () => {
      const runs = await obsQueries.listDiscoveryRuns();
      const statuses = runs.map(r => r.status);
      expect(statuses).toContain('held');
      expect(statuses).toContain('completed');
      expect(statuses).toContain('failed');
    });

    it('scope filter still surfaces a held row for its own scope', async () => {
      const runs = await obsQueries.listDiscoveryRuns('project:wf_ab12cd34');
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('held');
    });
  });
});
