import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ObservationQueries } from '../../src/database/observation-queries.js';
import { createTestObservationsDb, createTestObservation } from '../fixtures/test-helpers.js';

describe('ObservationQueries', () => {
  let db: Database.Database;
  let obsQueries: ObservationQueries;

  beforeEach(() => {
    const test = createTestObservationsDb();
    db = test.db;
    obsQueries = test.obsQueries;
  });

  afterEach(() => {
    db.close();
  });

  describe('storeObservation', () => {
    it('should store a new observation and return it', async () => {
      const obs = await obsQueries.storeObservation(createTestObservation());

      expect(obs.id).toBe(1);
      expect(obs.session_id).toBe('test-session-1');
      expect(obs.project_scope).toBe('project:test');
      expect(obs.tool_name).toBe('Bash');
      expect(obs.input_summary).toBe('npm test');
      expect(obs.status).toBe('started');
    });

    it('should deduplicate by idempotency_key', async () => {
      const input = createTestObservation({ idempotency_key: 'abc-123' });

      const first = await obsQueries.storeObservation(input);
      const second = await obsQueries.storeObservation(input);

      expect(first.id).toBe(second.id);
      // Only one row in DB
      const count = db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('should store with event_type=tool_complete as completed status', async () => {
      const obs = await obsQueries.storeObservation(
        createTestObservation({ event_type: 'tool_complete', output_summary: 'done' })
      );

      expect(obs.status).toBe('completed');
      expect(obs.output_summary).toBe('done');
    });
  });

  describe('getLastObservationAt (R3)', () => {
    it('returns null on an empty table', async () => {
      expect(await obsQueries.getLastObservationAt()).toBeNull();
    });

    it('returns MAX(started_at) normalized to ISO-8601 UTC', async () => {
      const before = Date.now();
      await obsQueries.storeObservation(createTestObservation());
      const last = await obsQueries.getLastObservationAt();

      expect(last).not.toBeNull();
      // Stored as 'YYYY-MM-DD HH:MM:SS[.SSS]' (UTC, no zone) — must come back
      // ISO so Date.parse doesn't read it as local time.
      expect(last).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      const ms = Date.parse(last!);
      expect(ms).toBeGreaterThanOrEqual(before - 1000);
      expect(ms).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe('completeObservation', () => {
    it('should update a started observation to completed', async () => {
      const obs = await obsQueries.storeObservation(createTestObservation());

      const completed = await obsQueries.completeObservation(obs.id, {
        status: 'completed',
        output_summary: 'All tests passed',
        duration_ms: 1500,
      });

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.output_summary).toBe('All tests passed');
      expect(completed!.duration_ms).toBe(1500);
      expect(completed!.completed_at).not.toBeNull();
    });

    it('should not update an already completed observation (additive-only)', async () => {
      const obs = await obsQueries.storeObservation(createTestObservation());
      await obsQueries.completeObservation(obs.id, {
        status: 'completed',
        output_summary: 'first',
        duration_ms: 100,
      });

      // Attempt to update again — should return null (no changes)
      const second = await obsQueries.completeObservation(obs.id, {
        status: 'failed',
        output_summary: 'overwrite attempt',
        duration_ms: 200,
      });

      expect(second).toBeNull();

      // Verify original values preserved
      const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(obs.id) as Record<string, unknown>;
      expect(row.output_summary).toBe('first');
      expect(row.status).toBe('completed');
    });

    it('should return null for non-existent observation', async () => {
      const result = await obsQueries.completeObservation(999, {
        status: 'completed',
      });
      expect(result).toBeNull();
    });
  });

  describe('storeObservationBatch', () => {
    it('should store multiple observations in a transaction', async () => {
      const inputs = [
        createTestObservation({ tool_name: 'Read', input_summary: 'file1.ts' }),
        createTestObservation({ tool_name: 'Edit', input_summary: 'file2.ts' }),
        createTestObservation({ tool_name: 'Bash', input_summary: 'npm build' }),
      ];

      const results = await obsQueries.storeObservationBatch(inputs);

      expect(results).toHaveLength(3);
      expect(results[0].tool_name).toBe('Read');
      expect(results[1].tool_name).toBe('Edit');
      expect(results[2].tool_name).toBe('Bash');
    });

    it('should handle idempotency within a batch', async () => {
      const key = 'batch-dedup-key';
      const inputs = [
        createTestObservation({ idempotency_key: key, tool_name: 'Read' }),
        createTestObservation({ idempotency_key: key, tool_name: 'Edit' }),
      ];

      const results = await obsQueries.storeObservationBatch(inputs);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(results[1].id); // same row returned
      const count = db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number };
      expect(count.c).toBe(1);
    });
  });

  describe('getObservationsSince', () => {
    it('should return observations after the given watermark', async () => {
      await obsQueries.storeObservation(createTestObservation({ tool_name: 'A' }));
      await obsQueries.storeObservation(createTestObservation({ tool_name: 'B' }));
      await obsQueries.storeObservation(createTestObservation({ tool_name: 'C' }));

      const sinceId1 = await obsQueries.getObservationsSince(1);
      expect(sinceId1).toHaveLength(2);
      expect(sinceId1[0].tool_name).toBe('B');
      expect(sinceId1[1].tool_name).toBe('C');
    });

    it('should filter by project_scope when provided', async () => {
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:alpha' }));
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:beta' }));
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:alpha' }));

      const alphaOnly = await obsQueries.getObservationsSince(0, 'project:alpha');
      expect(alphaOnly).toHaveLength(2);
      expect(alphaOnly.every(o => o.project_scope === 'project:alpha')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await obsQueries.storeObservation(createTestObservation());
      }

      const limited = await obsQueries.getObservationsSince(0, undefined, 2);
      expect(limited).toHaveLength(2);
    });
  });

  describe('watermark and discovery runs', () => {
    it('should return 0 when no completed runs exist', async () => {
      const watermark = await obsQueries.getLastWatermark();
      expect(watermark).toBe(0);
    });

    it('should return correct watermark from completed discovery runs', async () => {
      const run = await obsQueries.createDiscoveryRun('project:test', 1);
      await obsQueries.updateDiscoveryRun(run.id, {
        observation_end_id: 50,
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      const watermark = await obsQueries.getLastWatermark('project:test');
      expect(watermark).toBe(50);
    });

    it('should count unprocessed observations correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await obsQueries.storeObservation(createTestObservation());
      }

      const count = await obsQueries.getUnprocessedCount(2);
      expect(count).toBe(3); // ids 3, 4, 5
    });
  });

  describe('discovery runs CRUD', () => {
    it('should create a discovery run with running status', async () => {
      const run = await obsQueries.createDiscoveryRun('project:test', 1);

      expect(run.id).toBe(1);
      expect(run.project_scope).toBe('project:test');
      expect(run.observation_start_id).toBe(1);
      expect(run.status).toBe('running');
    });

    it('should update discovery run fields', async () => {
      const run = await obsQueries.createDiscoveryRun('project:test', 1);

      await obsQueries.updateDiscoveryRun(run.id, {
        observation_end_id: 100,
        observations_analyzed: 50,
        patterns_found: 3,
        memories_created: 2,
        memories_reinforced: 1,
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      const updated = await obsQueries.getDiscoveryRun(run.id);
      expect(updated!.observation_end_id).toBe(100);
      expect(updated!.observations_analyzed).toBe(50);
      expect(updated!.patterns_found).toBe(3);
      expect(updated!.memories_created).toBe(2);
      expect(updated!.memories_reinforced).toBe(1);
      expect(updated!.status).toBe('completed');
    });

    it('should get active run when one exists', async () => {
      await obsQueries.createDiscoveryRun('project:test', 1);

      const active = await obsQueries.getActiveRun('project:test');
      expect(active).not.toBeNull();
      expect(active!.status).toBe('running');
    });

    it('should return null when no active run exists', async () => {
      const run = await obsQueries.createDiscoveryRun('project:test', 1);
      await obsQueries.updateDiscoveryRun(run.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      const active = await obsQueries.getActiveRun('project:test');
      expect(active).toBeNull();
    });

    it('should list discovery runs ordered by id descending', async () => {
      await obsQueries.createDiscoveryRun('project:test', 1);
      await obsQueries.createDiscoveryRun('project:test', 50);

      const runs = await obsQueries.listDiscoveryRuns('project:test');
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBeGreaterThan(runs[1].id);
    });
  });

  describe('getObservationStats', () => {
    it('should return correct aggregate stats', async () => {
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:a', tool_name: 'Bash' }));
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:a', tool_name: 'Read' }));
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:b', tool_name: 'Bash' }));

      const stats = await obsQueries.getObservationStats();

      expect(stats.total).toBe(3);
      expect(stats.by_project['project:a']).toBe(2);
      expect(stats.by_project['project:b']).toBe(1);
      expect(stats.by_tool['Bash']).toBe(2);
      expect(stats.by_tool['Read']).toBe(1);
    });

    it('should filter by project_scope when provided', async () => {
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:a' }));
      await obsQueries.storeObservation(createTestObservation({ project_scope: 'project:b' }));

      const stats = await obsQueries.getObservationStats('project:a');
      expect(stats.total).toBe(1);
    });
  });

  describe('getObservationsBySession', () => {
    it('should return all observations for a session ordered by id ASC', async () => {
      await obsQueries.storeObservation(createTestObservation({ session_id: 's1', tool_name: 'Read' }));
      await obsQueries.storeObservation(createTestObservation({ session_id: 's2', tool_name: 'Bash' }));
      await obsQueries.storeObservation(createTestObservation({ session_id: 's1', tool_name: 'Edit' }));
      await obsQueries.storeObservation(createTestObservation({ session_id: 's1', tool_name: 'Grep' }));

      const s1 = await obsQueries.getObservationsBySession('s1');
      expect(s1).toHaveLength(3);
      expect(s1.map(o => o.tool_name)).toEqual(['Read', 'Edit', 'Grep']);
      // IDs must be strictly ascending
      for (let i = 1; i < s1.length; i++) {
        expect(s1[i].id).toBeGreaterThan(s1[i - 1].id);
      }
    });

    it('should return an empty array for an unknown session', async () => {
      const result = await obsQueries.getObservationsBySession('nonexistent');
      expect(result).toEqual([]);
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await obsQueries.storeObservation(createTestObservation({ session_id: 's1' }));
      }
      const limited = await obsQueries.getObservationsBySession('s1', 3);
      expect(limited).toHaveLength(3);
    });

    it('should return a single observation when only one event exists', async () => {
      await obsQueries.storeObservation(createTestObservation({ session_id: 'lonely' }));
      const result = await obsQueries.getObservationsBySession('lonely');
      expect(result).toHaveLength(1);
    });
  });

  describe('listSessions', () => {
    it('should return sessions ordered by started_at DESC (most recent first)', async () => {
      // Insert older session first, then newer — listSessions must put newer at top.
      const oldDate = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace('Z', '');
      db.prepare(
        `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, created_at)
         VALUES ('s_old', 'project:test', 'Bash', 'completed', '${oldDate}', '${oldDate}')`
      ).run();
      await obsQueries.storeObservation(createTestObservation({ session_id: 's_new' }));

      const sessions = await obsQueries.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions[0].session_id).toBe('s_new');
      expect(sessions[1].session_id).toBe('s_old');
    });

    it('should aggregate counts, project_scopes, and tool_names per session', async () => {
      await obsQueries.storeObservation(createTestObservation({ session_id: 's1', project_scope: 'project:alpha', tool_name: 'Read' }));
      await obsQueries.storeObservation(createTestObservation({ session_id: 's1', project_scope: 'project:alpha', tool_name: 'Edit' }));
      await obsQueries.storeObservation(createTestObservation({ session_id: 's1', project_scope: 'project:beta',  tool_name: 'Read' }));

      const sessions = await obsQueries.listSessions();
      const s1 = sessions.find(s => s.session_id === 's1');
      expect(s1).toBeDefined();
      expect(s1!.observation_count).toBe(3);
      expect(s1!.project_scopes.sort()).toEqual(['project:alpha', 'project:beta']);
      expect(s1!.tool_names.sort()).toEqual(['Edit', 'Read']);
    });

    it('should compute ended_at as MAX(COALESCE(completed_at, started_at))', async () => {
      // Insert a started-only row (no completed_at), then a completed row with a known time.
      // The ended_at should reflect the later of the two timestamps.
      const earlier = new Date(Date.now() - 30_000).toISOString().replace('T', ' ').replace('Z', '');
      const later   = new Date(Date.now() - 10_000).toISOString().replace('T', ' ').replace('Z', '');
      db.prepare(
        `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, completed_at, created_at)
         VALUES ('s_mixed', 'project:test', 'Bash', 'completed', '${earlier}', '${later}', '${earlier}')`
      ).run();
      db.prepare(
        `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, completed_at, created_at)
         VALUES ('s_mixed', 'project:test', 'Read', 'started', '${earlier}', NULL, '${earlier}')`
      ).run();

      const sessions = await obsQueries.listSessions();
      const mixed = sessions.find(s => s.session_id === 's_mixed');
      expect(mixed).toBeDefined();
      expect(mixed!.ended_at).toBe(later); // MAX falls back to completed_at on the first row
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await obsQueries.storeObservation(createTestObservation({ session_id: `session-${i}` }));
      }
      const limited = await obsQueries.listSessions(2);
      expect(limited).toHaveLength(2);
    });

    it('should return an empty array when no observations exist', async () => {
      const sessions = await obsQueries.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('purgeOlderThan', () => {
    it('should delete observations older than the cutoff', async () => {
      // Insert observations with old timestamps
      const oldDate = new Date(Date.now() - 10 * 86400000).toISOString().replace('T', ' ').replace('Z', '');
      db.prepare(
        `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, created_at)
         VALUES ('s1', 'project:test', 'Bash', 'completed', '${oldDate}', '${oldDate}')`
      ).run();
      db.prepare(
        `INSERT INTO observations (session_id, project_scope, tool_name, status, started_at, created_at)
         VALUES ('s1', 'project:test', 'Read', 'completed', '${oldDate}', '${oldDate}')`
      ).run();

      // Insert a fresh one
      await obsQueries.storeObservation(createTestObservation());

      const deleted = await obsQueries.purgeOlderThan(7);
      expect(deleted).toBe(2);

      const count = db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('should return 0 when nothing to purge', async () => {
      await obsQueries.storeObservation(createTestObservation());

      const deleted = await obsQueries.purgeOlderThan(7);
      expect(deleted).toBe(0);
    });
  });
});
