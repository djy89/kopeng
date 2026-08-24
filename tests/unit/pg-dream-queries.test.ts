import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { PgDreamQueries } from '../../src/database/pg-dream-queries.js';
import { PgObservationQueries } from '../../src/database/pg-observation-queries.js';
import { PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON } from '../../src/types/types.js';

/**
 * R2/R3 — Postgres store coverage via a mocked pool (no live PG in unit tests).
 * Asserts the new methods issue the right SQL shape (completed-only filter,
 * NULL-safe scope comparison, ordering) and map rows back correctly; the SQLite
 * twin is exercised against a real in-memory DB in dream-queries.test.ts.
 */

function dreamRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7', operator_id: 'default', scope: 'project:a', mode: 'windowed',
    trigger_source: 'scheduled', reason: null, window_key: '2026-06-08',
    input_obs_start_id: null, input_obs_end_id: null, output_diff: null,
    acceptance_status: 'empty', status: 'completed',
    started_at: new Date('2026-06-08T09:10:00Z'), completed_at: null, duration_ms: 12,
    memories_examined: '3', changes_auto_applied: '0', changes_queued: '0', error: null,
    ...overrides,
  };
}

function mockPool(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql?: string) => {
    // Transaction control statements return no rows.
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    return { rows, rowCount: rows.length };
  });
  // snapshotRevision's operator-edit path checks out a client for its
  // insert+trim transaction (r2 NEW-5) — same query mock, so SQL-shape
  // assertions see every statement regardless of path.
  const connect = vi.fn(async () => ({ query, release: vi.fn() }));
  return { pool: { query, connect } as unknown as pg.Pool, query };
}

describe('PgDreamQueries (R2)', () => {
  it('getLastCompletedDream selects completed-only for (operator, scope, mode), newest-first', async () => {
    const { pool, query } = mockPool([dreamRow()]);
    const store = new PgDreamQueries(pool);

    const last = await store.getLastCompletedDream('default', 'project:a', 'windowed');
    expect(last?.id).toBe(7);
    expect(last?.status).toBe('completed');
    expect(last?.started_at).toBe('2026-06-08T09:10:00.000Z');

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'completed'/);
    expect(sql).toMatch(/scope IS NOT DISTINCT FROM \$3/); // NULL-scope safe
    expect(sql).toMatch(/COALESCE\(reason, ''\) NOT IN \(\$4, \$5\)/); // excludes promotion + maintenance carrier rows (P3, Phase 2)
    expect(sql).toMatch(/ORDER BY started_at DESC, id DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(params).toEqual(['default', 'windowed', 'project:a', PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON]);
  });

  it('getLastCompletedDream returns null when no completed dream exists', async () => {
    const { pool } = mockPool([]);
    const store = new PgDreamQueries(pool);
    expect(await store.getLastCompletedDream('default', null, 'windowed')).toBeNull();
  });

  it('listPendingDreams selects completed pending/partial dreams excluding carriers, newest-first (D1.3 + team-review #22)', async () => {
    const { pool, query } = mockPool([dreamRow({ acceptance_status: 'pending' })]);
    const store = new PgDreamQueries(pool);

    const list = await store.listPendingDreams(20);
    expect(list.map(d => d.id)).toEqual([7]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'completed'/);
    expect(sql).toMatch(/acceptance_status IN \('pending', 'partial'\)/);
    // $2/$3 are the carrier exclusion even though $1 is limit — the placeholders
    // do NOT appear in textual order; the exclusion lives in the QUERY, not in
    // the writers' hardcoded acceptance values (team-review #22 A6).
    expect(sql).toMatch(/COALESCE\(reason, ''\) NOT IN \(\$2, \$3\)/);
    expect(sql).toMatch(/ORDER BY started_at DESC, id DESC/);
    expect(params).toEqual([20, PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON]);
  });

  it('listRecentDreams INCLUDES carrier rows (team-review #22 S3 — history is their operator-facing record), newest-first, paged', async () => {
    const { pool, query } = mockPool([dreamRow()]);
    const store = new PgDreamQueries(pool);

    const list = await store.listRecentDreams(10, 5);
    expect(list.map(d => d.id)).toEqual([7]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'completed'/);
    // No carrier exclusion here — dream-history labels carriers `is_carrier`
    // instead of hiding real archives from the only history surface.
    expect(sql).not.toMatch(/NOT IN/);
    expect(sql).toMatch(/ORDER BY started_at DESC, id DESC/);
    expect(sql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(params).toEqual([10, 5]);
  });

  it('listDreamsByWindow returns the full window history, newest-first', async () => {
    const rows = [dreamRow({ id: '9', status: 'failed' }), dreamRow({ id: '8', status: 'failed' })];
    const { pool, query } = mockPool(rows);
    const store = new PgDreamQueries(pool);

    const list = await store.listDreamsByWindow('default', null, 'windowed', '2026-06-08');
    expect(list.map(d => d.id)).toEqual([9, 8]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/window_key = \$3/);
    expect(sql).toMatch(/scope IS NOT DISTINCT FROM \$4/);
    expect(sql).toMatch(/ORDER BY started_at DESC, id DESC/);
    expect(params).toEqual(['default', 'windowed', '2026-06-08', null]);
  });
});

describe('PgDreamQueries revisions — Phase 2 scope/type/updated_at/last_seen', () => {
  // Mirrors the SQLite round-trips in dream-queries.test.ts (SQLite exercises the
  // real behavior against an in-memory DB; here — no live PG in unit tests — the
  // mocked pool asserts the SQL shape carries the new columns, matching this
  // file's existing pattern for every other method).

  function revisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '3', memory_id: '1', revision: '1', content: 'phase-2 snapshot fields',
      content_hash: 'h', summary: null, confidence: 1, observation_count: 1,
      metadata: {}, tags: ['x'], last_contradicted: null, deprecated_at: null, valid_from: null,
      scope: 'client:acme-foods', type: 'project',
      updated_at: new Date('2026-01-02T00:00:00Z'), last_seen: new Date('2026-01-01T00:00:00Z'),
      created_by_dream_id: null, created_at: new Date('2026-01-03T00:00:00Z'),
      ...overrides,
    };
  }

  it('snapshotRevision copies scope/type/updated_at/last_seen from the live memory row', async () => {
    const { pool, query } = mockPool([{ id: '3', revision: 1 }]);
    const store = new PgDreamQueries(pool);
    await store.snapshotRevision(1);

    // Operator-edit path runs BEGIN → INSERT → trim → COMMIT in one checkout
    // (r2 NEW-5); the INSERT is the second statement.
    const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO memory_revisions'));
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toMatch(/m\.scope, m\.type, m\.updated_at, m\.last_seen/);
  });

  it('snapshotRevision: dream-linked snapshots skip the retention trim; operator-edit snapshots run it in a transaction (r2 N2/NEW-5)', async () => {
    const dreamLinked = mockPool([{ id: '3', revision: 1 }]);
    await new PgDreamQueries(dreamLinked.pool).snapshotRevision(1, 42);
    const dlStatements = dreamLinked.query.mock.calls.map(c => String(c[0]));
    expect(dlStatements.some(s => s.includes('DELETE FROM memory_revisions'))).toBe(false);
    expect(dlStatements).not.toContain('BEGIN');

    const operatorEdit = mockPool([{ id: '3', revision: 1 }]);
    await new PgDreamQueries(operatorEdit.pool).snapshotRevision(1);
    const oeStatements = operatorEdit.query.mock.calls.map(c => String(c[0]));
    expect(oeStatements).toContain('BEGIN');
    expect(oeStatements.some(s => s.includes('DELETE FROM memory_revisions')
      && s.includes('created_by_dream_id IS NULL'))).toBe(true);
    expect(oeStatements).toContain('COMMIT');
  });

  it('listRevisions / getRevision select and map scope/type/updated_at/last_seen', async () => {
    const { pool: listPool, query: listQuery } = mockPool([revisionRow()]);
    const listStore = new PgDreamQueries(listPool);
    const list = await listStore.listRevisions(1);
    expect(list[0].scope).toBe('client:acme-foods');
    expect(list[0].type).toBe('project');
    expect(list[0].updated_at).toBe('2026-01-02T00:00:00.000Z');
    expect(list[0].last_seen).toBe('2026-01-01T00:00:00.000Z');
    const [listSql] = listQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(listSql).toMatch(/scope, type, updated_at, last_seen/);

    const { pool: getPool, query: getQuery } = mockPool([revisionRow()]);
    const getStore = new PgDreamQueries(getPool);
    const got = await getStore.getRevision(1, 1);
    expect(got?.scope).toBe('client:acme-foods');
    const [getSql] = getQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(getSql).toMatch(/scope, type, updated_at, last_seen/);
  });

  it('getRevision maps a legacy (pre-v10, NULL-column) row to null scope/type/updated_at/last_seen', async () => {
    const { pool } = mockPool([revisionRow({ scope: null, type: null, updated_at: null, last_seen: null })]);
    const store = new PgDreamQueries(pool);
    const rev = await store.getRevision(1, 1);
    expect(rev?.scope).toBeNull();
    expect(rev?.type).toBeNull();
    expect(rev?.updated_at).toBeNull();
    expect(rev?.last_seen).toBeNull();
  });

  it('restoreRevision COALESCEs scope/type/last_seen against the live row (legacy-safe) and never restores updated_at from the revision', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                 // BEGIN
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // exists check
      .mockResolvedValueOnce({ rows: [] })                  // pre-restore snapshot INSERT
      .mockResolvedValueOnce({ rows: [] })                  // UPDATE memories
      .mockResolvedValueOnce({ rows: [] })                  // DELETE memory_tags
      .mockResolvedValueOnce({ rows: [] })                  // INSERT memory_tags
      .mockResolvedValueOnce({ rows: [] });                 // COMMIT
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const store = new PgDreamQueries(pool);

    const ok = await store.restoreRevision(1, 1);
    expect(ok).toBe(true);

    const snapshotSql = (clientQuery.mock.calls[2] as unknown as [string])[0];
    expect(snapshotSql).toMatch(/m\.scope, m\.type, m\.updated_at, m\.last_seen/);

    const updateSql = (clientQuery.mock.calls[3] as unknown as [string])[0];
    expect(updateSql).toMatch(/scope = COALESCE\(r\.scope, m\.scope\)/);
    expect(updateSql).toMatch(/type = COALESCE\(r\.type, m\.type\)/);
    expect(updateSql).toMatch(/last_seen = COALESCE\(r\.last_seen, m\.last_seen\)/);
    expect(updateSql).toMatch(/updated_at = NOW\(\)/);
    expect(updateSql).not.toMatch(/updated_at = r\.updated_at/);
  });
});

describe('PgObservationQueries.getLastObservationAt (R3)', () => {
  it('returns MAX(started_at) as an ISO string', async () => {
    const { pool, query } = mockPool([{ last: new Date('2026-06-09T02:55:00Z') }]);
    const store = new PgObservationQueries(pool);
    expect(await store.getLastObservationAt()).toBe('2026-06-09T02:55:00.000Z');
    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).toMatch(/MAX\(started_at\)/);
  });

  it('returns null on an empty observations table', async () => {
    const { pool } = mockPool([{ last: null }]);
    const store = new PgObservationQueries(pool);
    expect(await store.getLastObservationAt()).toBeNull();
  });
});
