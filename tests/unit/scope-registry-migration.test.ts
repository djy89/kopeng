// Phase 3 migrations: scope_registry table, operator_config.primary_scope,
// and the 'held' discovery_runs status on both fresh and pre-Phase-3 DBs.
//
// NOTE: tests/fixtures/test-helpers.ts DUPLICATES the observations schema from
// src/database/observations-db.ts (it does not import OBSERVATIONS_SCHEMA) —
// the discovery_runs CHECK there must be kept in step with the source schema.
import { describe, it, expect } from 'vitest';
import { createTestDatabase, createTestObservationsDb } from '../fixtures/test-helpers.js';

describe('Phase 3 migrations', () => {
  it('creates scope_registry with the expected columns', () => {
    const { db } = createTestDatabase();
    const cols = db.prepare(`PRAGMA table_info(scope_registry)`).all() as { name: string }[];
    const names = cols.map(c => c.name);
    for (const c of ['scope', 'slug', 'claimant_raw', 'origin_cwd', 'status', 'reserved', 'first_seen', 'updated_at', 'ruled_at']) {
      expect(names).toContain(c);
    }
  });

  it('adds primary_scope to operator_config', () => {
    const { db } = createTestDatabase();
    const cols = db.prepare(`PRAGMA table_info(operator_config)`).all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain('primary_scope');
  });

  it('scope_registry rejects an unknown status', () => {
    const { db } = createTestDatabase();
    expect(() =>
      db.prepare(`INSERT INTO scope_registry (scope, slug, claimant_raw, status) VALUES ('project:x', 'project:x', 'project:x', 'bogus')`).run()
    ).toThrow();
  });

  it('discovery_runs accepts held (fresh DB) and still rejects garbage', () => {
    const { db: obs } = createTestObservationsDb();
    obs.prepare(`INSERT INTO discovery_runs (project_scope, status) VALUES ('project:wf_ab12cd34', 'held')`).run();
    expect(() =>
      obs.prepare(`INSERT INTO discovery_runs (project_scope, status) VALUES ('project:x', 'bogus')`).run()
    ).toThrow();
  });

  it('rebuilds an OLD-CHECK discovery_runs in place without losing rows', async () => {
    // Simulate a pre-Phase-3 observations.db: old CHECK, one existing row.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE discovery_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_scope TEXT NOT NULL,
      observation_start_id INTEGER, observation_end_id INTEGER,
      observations_analyzed INTEGER NOT NULL DEFAULT 0,
      patterns_found INTEGER NOT NULL DEFAULT 0,
      memories_created INTEGER NOT NULL DEFAULT 0,
      memories_reinforced INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completing', 'completed', 'failed')),
      error TEXT
    );
    CREATE INDEX idx_discovery_project_status ON discovery_runs(project_scope, status);`);
    db.prepare(`INSERT INTO discovery_runs (project_scope, status) VALUES ('project:kept', 'completed')`).run();

    const { ensureHeldStatus } = await import('../../src/database/observations-db.js');
    ensureHeldStatus(db);
    ensureHeldStatus(db); // idempotent

    expect(db.prepare(`SELECT COUNT(*) AS n FROM discovery_runs`).get()).toEqual({ n: 1 });
    db.prepare(`INSERT INTO discovery_runs (project_scope, status) VALUES ('project:wf_ab12cd34', 'held')`).run();
  });
});
