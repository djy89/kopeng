import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { createTestDatabase } from '../fixtures/test-helpers.js';

/**
 * D0.1 — Dreaming layer schema migration (SQLite v4).
 * Verifies additive columns, new tables, the seeded operator_config row,
 * default values on new rows, and the backfill SQL.
 */
describe('Dreaming migration (D0.1, SQLite v4)', () => {
  it('advances schema_version to at least 4', () => {
    const { db } = createTestDatabase();
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(4);
  });

  it('adds the reinforcement / temporal / anchor columns to memories', () => {
    const { db } = createTestDatabase();
    const cols = (db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map(c => c.name);
    for (const c of [
      'observation_count', 'first_seen', 'last_seen', 'last_contradicted',
      'criticality', 'is_locked', 'deprecated_at', 'valid_from', 'source_observation_ids',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('creates the five dreaming tables', () => {
    const { db } = createTestDatabase();
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all() as { name: string }[]).map(t => t.name);
    for (const t of ['dreams', 'memory_revisions', 'dream_audit_log', 'operator_config', 'consolidation_lock']) {
      expect(tables).toContain(t);
    }
  });

  it('seeds exactly one operator_config row with auto-accept OFF', () => {
    const { db } = createTestDatabase();
    const rows = db.prepare(`SELECT * FROM operator_config`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].operator_id).toBe('default');
    expect(rows[0].auto_accept_exact_dup).toBe(0);
    expect(rows[0].auto_accept_decay).toBe(0);
    expect(rows[0].idle_minutes).toBe(15);
  });

  it('applies sane defaults to a newly inserted memory', () => {
    const { db } = createTestDatabase();
    const id = (db.prepare(
      `INSERT INTO memories (content, type, scope) VALUES (?, ?, ?)`
    ).run('hello', 'reference', 'global').lastInsertRowid) as number;
    const m = db.prepare(
      `SELECT observation_count, criticality, is_locked, source_observation_ids FROM memories WHERE id = ?`
    ).get(id) as Record<string, unknown>;
    expect(m.observation_count).toBe(1);
    expect(m.criticality).toBe(0);
    expect(m.is_locked).toBe(0);
    expect(m.source_observation_ids).toBe('[]');
  });

  it('the idempotency partial index permits NULL-window rows but blocks duplicates', () => {
    const { db } = createTestDatabase();
    const ins = db.prepare(
      `INSERT INTO dreams (operator_id, scope, mode, window_key) VALUES ('default', 'project:x', 'windowed', ?)`
    );
    // Two NULL-window (empty/manual) dreams are allowed.
    expect(() => ins.run(null)).not.toThrow();
    expect(() => ins.run(null)).not.toThrow();
    // First keyed window inserts; the duplicate collides.
    expect(() => ins.run('2026-06-07')).not.toThrow();
    expect(() => ins.run('2026-06-07')).toThrow();
  });

  it("v6 extends the dream_audit_log CHECK with 'promote_global' and 'rollback'", () => {
    const { db } = createTestDatabase();
    const dreamId = db.prepare(
      `INSERT INTO dreams (operator_id, mode) VALUES ('default', 'windowed')`
    ).run().lastInsertRowid as number;

    const ins = db.prepare(
      `INSERT INTO dream_audit_log (dream_id, change_class, action) VALUES (?, ?, ?)`
    );
    // New classes accepted post-v6…
    expect(() => ins.run(dreamId, 'promote_global', 'signal')).not.toThrow();
    expect(() => ins.run(dreamId, 'rollback', 'restore_revision')).not.toThrow();
    // …original classes survive the rebuild, bogus classes still rejected.
    expect(() => ins.run(dreamId, 'exact_dup', 'archive')).not.toThrow();
    expect(() => ins.run(dreamId, 'bogus_class', 'x')).toThrow();
  });

  it('backfill SQL seeds temporal markers and observation_count from evidence_count', () => {
    // Fresh DB at v4, then simulate a pre-migration row (new cols NULL/zero) and re-run backfill.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    db.prepare(
      `INSERT INTO memories (content, type, scope, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('x', 'reference', 'global', '{"evidence_count":7}', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    db.exec(`UPDATE memories SET first_seen = NULL, last_seen = NULL, valid_from = NULL, observation_count = 1`);

    // Backfill statements (identical to migration v4).
    db.exec(`UPDATE memories SET first_seen = created_at WHERE first_seen IS NULL`);
    db.exec(`UPDATE memories SET last_seen = updated_at WHERE last_seen IS NULL`);
    db.exec(`UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL`);
    db.exec(`UPDATE memories SET observation_count = COALESCE(CAST(json_extract(metadata, '$.evidence_count') AS INTEGER), 1)`);

    const m = db.prepare(
      `SELECT first_seen, last_seen, valid_from, observation_count FROM memories`
    ).get() as Record<string, unknown>;
    expect(m.first_seen).toBe('2026-01-01T00:00:00Z');
    expect(m.last_seen).toBe('2026-02-01T00:00:00Z');
    expect(m.valid_from).toBe('2026-01-01T00:00:00Z');
    expect(m.observation_count).toBe(7);
    db.close();
  });

  it('v8 adds scope/type/updated_at/last_seen to memory_revisions', () => {
    const { db } = createTestDatabase();
    const cols = (db.prepare(`PRAGMA table_info(memory_revisions)`).all() as { name: string }[]).map(c => c.name);
    for (const c of ['scope', 'type', 'updated_at', 'last_seen']) expect(cols).toContain(c);
  });
});
