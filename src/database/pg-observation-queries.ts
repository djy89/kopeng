import type pg from 'pg';
import type { Observation, ObservationInput, ObservationComplete, DiscoveryRun, ObservationStats, SessionSummary } from '../types/types.js';
import type { IObservationStore } from './interfaces.js';

// The pre-INSERT idempotency SELECT is a fast path, NOT the correctness
// mechanism: concurrent observe-hook processes (one per tool call, multiplied
// by parallel tools and subagents) can both read "absent" and both insert the
// same key, and inside the batch transaction that unique violation aborts the
// WHOLE chunk with a 500 — which the hook retries, then quarantines to
// poison-*.jsonl, raising a capture alarm that never clears. Let the index
// arbitrate instead. DO UPDATE rather than DO NOTHING so RETURNING * still
// yields the row (the SET is a no-op re-write of the conflicting key); the
// WHERE clause matches the PARTIAL unique index (pg-migrations.ts:104).
const IDEMPOTENT_ON_CONFLICT = `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key`;

function rowToObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as number,
    idempotency_key: (row.idempotency_key as string) ?? null,
    session_id: row.session_id as string,
    project_scope: row.project_scope as string,
    tool_name: row.tool_name as string,
    input_summary: (row.input_summary as string) ?? null,
    output_summary: (row.output_summary as string) ?? null,
    status: row.status as Observation['status'],
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at as string),
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at as string | null),
    duration_ms: (row.duration_ms as number) ?? null,
    metadata: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? {}),
    schema_version: (row.schema_version as number) ?? 1,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at as string),
  };
}

function rowToDiscoveryRun(row: Record<string, unknown>): DiscoveryRun {
  return {
    id: row.id as number,
    project_scope: row.project_scope as string,
    observation_start_id: (row.observation_start_id as number) ?? null,
    observation_end_id: (row.observation_end_id as number) ?? null,
    observations_analyzed: (row.observations_analyzed as number) ?? 0,
    patterns_found: (row.patterns_found as number) ?? 0,
    memories_created: (row.memories_created as number) ?? 0,
    memories_reinforced: (row.memories_reinforced as number) ?? 0,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at as string),
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at as string | null),
    status: row.status as DiscoveryRun['status'],
    error: (row.error as string) ?? null,
  };
}

export class PgObservationQueries implements IObservationStore {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async storeObservation(input: ObservationInput): Promise<Observation> {
    // Check idempotency
    if (input.idempotency_key) {
      const existing = await this.pool.query(
        'SELECT * FROM observations WHERE idempotency_key = $1',
        [input.idempotency_key]
      );
      if (existing.rows.length > 0) {
        return rowToObservation(existing.rows[0]);
      }
    }

    const status = input.event_type === 'tool_failed' ? 'failed'
      : input.event_type === 'tool_complete' ? 'completed'
      : 'started';

    const result = await this.pool.query(
      `INSERT INTO observations (idempotency_key, session_id, project_scope, tool_name, input_summary, output_summary, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ${IDEMPOTENT_ON_CONFLICT}
       RETURNING *`,
      [
        input.idempotency_key ?? null,
        input.session_id,
        input.project_scope,
        input.tool_name,
        input.input_summary ?? null,
        input.output_summary ?? null,
        status,
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    return rowToObservation(result.rows[0]);
  }

  async completeObservation(id: number, data: ObservationComplete): Promise<Observation | null> {
    const result = await this.pool.query(
      `UPDATE observations
       SET output_summary = COALESCE(output_summary, $1),
           status = $2,
           completed_at = COALESCE(completed_at, NOW()),
           duration_ms = COALESCE(duration_ms, $3)
       WHERE id = $4 AND status = 'started'
       RETURNING *`,
      [data.output_summary ?? null, data.status, data.duration_ms ?? null, id]
    );

    return result.rows.length > 0 ? rowToObservation(result.rows[0]) : null;
  }

  async storeObservationBatch(inputs: ObservationInput[]): Promise<Observation[]> {
    const results: Observation[] = [];
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const input of inputs) {
        // Check idempotency
        if (input.idempotency_key) {
          const existing = await client.query(
            'SELECT * FROM observations WHERE idempotency_key = $1',
            [input.idempotency_key]
          );
          if (existing.rows.length > 0) {
            results.push(rowToObservation(existing.rows[0]));
            continue;
          }
        }

        const status = input.event_type === 'tool_failed' ? 'failed'
          : input.event_type === 'tool_complete' ? 'completed'
          : 'started';

        const result = await client.query(
          `INSERT INTO observations (idempotency_key, session_id, project_scope, tool_name, input_summary, output_summary, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ${IDEMPOTENT_ON_CONFLICT}
           RETURNING *`,
          [
            input.idempotency_key ?? null,
            input.session_id,
            input.project_scope,
            input.tool_name,
            input.input_summary ?? null,
            input.output_summary ?? null,
            status,
            JSON.stringify(input.metadata ?? {}),
          ]
        );

        results.push(rowToObservation(result.rows[0]));
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return results;
  }

  async getObservationsSince(startId: number, projectScope?: string, limit: number = 1000): Promise<Observation[]> {
    let sql = 'SELECT * FROM observations WHERE id > $1';
    const params: (string | number)[] = [startId];
    let paramIdx = 2;

    if (projectScope) {
      sql += ` AND project_scope = $${paramIdx}`;
      params.push(projectScope);
      paramIdx++;
    }

    sql += ` ORDER BY id ASC LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows.map((r: Record<string, unknown>) => rowToObservation(r));
  }

  async getObservationsBySession(sessionId: string, limit: number = 5000): Promise<Observation[]> {
    const result = await this.pool.query(
      'SELECT * FROM observations WHERE session_id = $1 ORDER BY id ASC LIMIT $2',
      [sessionId, limit]
    );
    return result.rows.map((r: Record<string, unknown>) => rowToObservation(r));
  }

  async listSessions(limit: number = 50): Promise<SessionSummary[]> {
    // array_agg(DISTINCT ...) returns Postgres text[] which the pg driver hands
    // back as a JS array directly — no comma-split needed (unlike SQLite).
    const result = await this.pool.query(
      `SELECT session_id,
              COUNT(*)::int AS observation_count,
              MIN(started_at) AS started_at,
              MAX(COALESCE(completed_at, started_at)) AS ended_at,
              array_agg(DISTINCT project_scope) AS project_scopes,
              array_agg(DISTINCT tool_name) AS tool_names
       FROM observations
       GROUP BY session_id
       ORDER BY MIN(started_at) DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      session_id: row.session_id as string,
      observation_count: row.observation_count as number,
      started_at: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at as string),
      ended_at: row.ended_at == null
        ? null
        : (row.ended_at instanceof Date ? row.ended_at.toISOString() : (row.ended_at as string)),
      project_scopes: Array.isArray(row.project_scopes) ? row.project_scopes.filter(Boolean) as string[] : [],
      tool_names: Array.isArray(row.tool_names) ? row.tool_names.filter(Boolean) as string[] : [],
    }));
  }

  async getObservationStats(projectScope?: string): Promise<ObservationStats> {
    let totalQuery: string;
    const totalParams: string[] = [];

    if (projectScope) {
      totalQuery = 'SELECT COUNT(*) as total FROM observations WHERE project_scope = $1';
      totalParams.push(projectScope);
    } else {
      totalQuery = 'SELECT COUNT(*) as total FROM observations';
    }

    const totalResult = await this.pool.query(totalQuery, totalParams);
    const total = parseInt(totalResult.rows[0].total, 10);

    const byProjectResult = await this.pool.query(
      'SELECT project_scope, COUNT(*) as count FROM observations GROUP BY project_scope'
    );
    const by_project: Record<string, number> = {};
    for (const row of byProjectResult.rows) {
      by_project[row.project_scope as string] = parseInt(row.count as string, 10);
    }

    let byToolQuery: string;
    const byToolParams: string[] = [];
    if (projectScope) {
      byToolQuery = 'SELECT tool_name, COUNT(*) as count FROM observations WHERE project_scope = $1 GROUP BY tool_name';
      byToolParams.push(projectScope);
    } else {
      byToolQuery = 'SELECT tool_name, COUNT(*) as count FROM observations GROUP BY tool_name';
    }
    const byToolResult = await this.pool.query(byToolQuery, byToolParams);
    const by_tool: Record<string, number> = {};
    for (const row of byToolResult.rows) {
      by_tool[row.tool_name as string] = parseInt(row.count as string, 10);
    }

    const rangeResult = await this.pool.query(
      'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM observations'
    );
    const oldest = rangeResult.rows[0].oldest
      ? (rangeResult.rows[0].oldest instanceof Date ? rangeResult.rows[0].oldest.toISOString() : rangeResult.rows[0].oldest as string)
      : null;
    const newest = rangeResult.rows[0].newest
      ? (rangeResult.rows[0].newest instanceof Date ? rangeResult.rows[0].newest.toISOString() : rangeResult.rows[0].newest as string)
      : null;

    return { total, by_project, by_tool, oldest, newest };
  }

  async purgeOlderThan(olderThanDays: number, batchSize: number = 1000): Promise<number> {
    let totalDeleted = 0;

    // Windowed delete by row ID
    const maxIdResult = await this.pool.query(
      `SELECT MAX(id) as max_id FROM observations WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'`
    );
    const maxId = maxIdResult.rows[0]?.max_id;
    if (!maxId) return 0;

    let deleted: number;
    do {
      const result = await this.pool.query(
        'DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE id <= $1 LIMIT $2)',
        [maxId, batchSize]
      );
      deleted = result.rowCount ?? 0;
      totalDeleted += deleted;
    } while (deleted === batchSize);

    return totalDeleted;
  }

  async getUnprocessedCount(lastWatermark: number, projectScope?: string): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM observations WHERE id > $1';
    const params: (string | number)[] = [lastWatermark];

    if (projectScope) {
      sql += ' AND project_scope = $2';
      params.push(projectScope);
    }

    const result = await this.pool.query(sql, params);
    return parseInt(result.rows[0].count, 10);
  }

  async getLastWatermark(projectScope?: string): Promise<number> {
    let sql = "SELECT MAX(observation_end_id) as watermark FROM discovery_runs WHERE status = 'completed'";
    const params: string[] = [];

    if (projectScope) {
      sql += ' AND project_scope = $1';
      params.push(projectScope);
    }

    const result = await this.pool.query(sql, params);
    return result.rows[0]?.watermark ?? 0;
  }

  async getMaxObservationId(): Promise<number> {
    const result = await this.pool.query<{ max_id: string | null }>('SELECT MAX(id) AS max_id FROM observations');
    const raw = result.rows[0]?.max_id;
    if (raw == null) return 0;
    return typeof raw === 'string' ? parseInt(raw, 10) : raw;
  }

  async getLastObservationAt(): Promise<string | null> {
    const result = await this.pool.query<{ last: Date | string | null }>('SELECT MAX(started_at) AS last FROM observations');
    const raw = result.rows[0]?.last;
    if (raw == null) return null;
    return raw instanceof Date ? raw.toISOString() : raw;
  }

  async createDiscoveryRun(projectScope: string, observationStartId: number): Promise<DiscoveryRun> {
    const result = await this.pool.query(
      `INSERT INTO discovery_runs (project_scope, observation_start_id, status)
       VALUES ($1, $2, 'running')
       RETURNING *`,
      [projectScope, observationStartId]
    );
    return rowToDiscoveryRun(result.rows[0]);
  }

  async updateDiscoveryRun(
    id: number,
    updates: Partial<Pick<DiscoveryRun, 'observation_end_id' | 'observations_analyzed' | 'patterns_found' | 'memories_created' | 'memories_reinforced' | 'status' | 'error' | 'completed_at'>>
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    let paramIdx = 1;

    if (updates.observation_end_id !== undefined) {
      setClauses.push(`observation_end_id = $${paramIdx++}`);
      params.push(updates.observation_end_id);
    }
    if (updates.observations_analyzed !== undefined) {
      setClauses.push(`observations_analyzed = $${paramIdx++}`);
      params.push(updates.observations_analyzed);
    }
    if (updates.patterns_found !== undefined) {
      setClauses.push(`patterns_found = $${paramIdx++}`);
      params.push(updates.patterns_found);
    }
    if (updates.memories_created !== undefined) {
      setClauses.push(`memories_created = $${paramIdx++}`);
      params.push(updates.memories_created);
    }
    if (updates.memories_reinforced !== undefined) {
      setClauses.push(`memories_reinforced = $${paramIdx++}`);
      params.push(updates.memories_reinforced);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIdx++}`);
      params.push(updates.status);
    }
    if (updates.error !== undefined) {
      setClauses.push(`error = $${paramIdx++}`);
      params.push(updates.error);
    }
    if (updates.completed_at !== undefined) {
      setClauses.push(`completed_at = $${paramIdx++}`);
      params.push(updates.completed_at);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    await this.pool.query(
      `UPDATE discovery_runs SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      params
    );
  }

  async getActiveRun(projectScope?: string): Promise<DiscoveryRun | null> {
    let sql = "SELECT * FROM discovery_runs WHERE status IN ('running', 'completing')";
    const params: string[] = [];

    if (projectScope) {
      sql += ' AND project_scope = $1';
      params.push(projectScope);
    }

    sql += ' ORDER BY id DESC LIMIT 1';

    const result = await this.pool.query(sql, params);
    return result.rows.length > 0 ? rowToDiscoveryRun(result.rows[0]) : null;
  }

  async getDiscoveryRun(id: number): Promise<DiscoveryRun | null> {
    const result = await this.pool.query('SELECT * FROM discovery_runs WHERE id = $1', [id]);
    return result.rows.length > 0 ? rowToDiscoveryRun(result.rows[0]) : null;
  }

  async listDiscoveryRuns(projectScope?: string, limit: number = 20): Promise<DiscoveryRun[]> {
    let sql = 'SELECT * FROM discovery_runs';
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (projectScope) {
      sql += ` WHERE project_scope = $${paramIdx++}`;
      params.push(projectScope);
    }

    sql += ` ORDER BY id DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows.map((r: Record<string, unknown>) => rowToDiscoveryRun(r));
  }

  close(): void {
    // Connection lifecycle managed by the pool owner
  }
}
