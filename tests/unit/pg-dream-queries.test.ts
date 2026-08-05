import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { PgDreamQueries } from '../../src/database/pg-dream-queries.js';
import { PgObservationQueries } from '../../src/database/pg-observation-queries.js';

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
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as pg.Pool, query };
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
    expect(sql).toMatch(/ORDER BY started_at DESC, id DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(params).toEqual(['default', 'windowed', 'project:a']);
  });

  it('getLastCompletedDream returns null when no completed dream exists', async () => {
    const { pool } = mockPool([]);
    const store = new PgDreamQueries(pool);
    expect(await store.getLastCompletedDream('default', null, 'windowed')).toBeNull();
  });

  it('listPendingDreams selects completed dreams with pending/partial acceptance, newest-first (D1.3)', async () => {
    const { pool, query } = mockPool([dreamRow({ acceptance_status: 'pending' })]);
    const store = new PgDreamQueries(pool);

    const list = await store.listPendingDreams(20);
    expect(list.map(d => d.id)).toEqual([7]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'completed'/);
    expect(sql).toMatch(/acceptance_status IN \('pending', 'partial'\)/);
    expect(sql).toMatch(/ORDER BY started_at DESC, id DESC/);
    expect(params).toEqual([20]);
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
