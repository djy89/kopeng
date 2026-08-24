import type Database from 'better-sqlite3';
import type { Observation, ObservationInput, ObservationComplete, DiscoveryRun, ObservationStats, SessionSummary } from '../types/types.js';
import type { IObservationStore } from './interfaces.js';
import { GLOBAL_WATERMARK_STATUSES, SCOPE_WATERMARK_STATUSES } from './interfaces.js';

/**
 * Rows per INSERT transaction when loading the purge-exemption temp table
 * (S1b). Well under every SQLite bound-parameter compile-time cap; the value
 * only tunes insert batching, never correctness.
 */
export const PURGE_EXEMPT_CHUNK = 500;

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
    started_at: row.started_at as string,
    completed_at: (row.completed_at as string) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    metadata: (row.metadata as string) ?? '{}',
    schema_version: (row.schema_version as number) ?? 1,
    created_at: row.created_at as string,
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
    started_at: row.started_at as string,
    completed_at: (row.completed_at as string) ?? null,
    status: row.status as DiscoveryRun['status'],
    error: (row.error as string) ?? null,
  };
}

export class ObservationQueries implements IObservationStore {
  private db: Database.Database;

  // Prepared statements
  private insertObs: Database.Statement;
  private getObsById: Database.Statement;
  private getObsByIdempotency: Database.Statement;
  private completeObs: Database.Statement;
  private getObsSince: Database.Statement;
  private getObsSinceProject: Database.Statement;
  private countUnprocessed: Database.Statement;
  private countUnprocessedProject: Database.Statement;
  private lastWatermark: Database.Statement;
  private lastWatermarkProject: Database.Statement;
  private insertRun: Database.Statement;
  private getRunById: Database.Statement;
  private getActiveRunStmt: Database.Statement;
  private getActiveRunProjectStmt: Database.Statement;
  private getObsBySessionStmt: Database.Statement;
  private listSessionsStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.insertObs = db.prepare(`
      INSERT INTO observations (idempotency_key, session_id, project_scope, tool_name, input_summary, output_summary, status, started_at, duration_ms, metadata)
      VALUES (@idempotency_key, @session_id, @project_scope, @tool_name, @input_summary, @output_summary, @status, @started_at, @duration_ms, @metadata)
    `);

    this.getObsById = db.prepare('SELECT * FROM observations WHERE id = ?');

    this.getObsByIdempotency = db.prepare('SELECT * FROM observations WHERE idempotency_key = ?');

    this.completeObs = db.prepare(`
      UPDATE observations
      SET output_summary = COALESCE(output_summary, @output_summary),
          status = @status,
          completed_at = COALESCE(completed_at, datetime('now')),
          duration_ms = COALESCE(duration_ms, @duration_ms)
      WHERE id = @id AND status = 'started'
    `);

    this.getObsSince = db.prepare(`
      SELECT * FROM observations WHERE id > ? ORDER BY id ASC LIMIT ?
    `);

    this.getObsSinceProject = db.prepare(`
      SELECT * FROM observations WHERE id > ? AND project_scope = ? ORDER BY id ASC LIMIT ?
    `);

    this.countUnprocessed = db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE id > ?
    `);

    this.countUnprocessedProject = db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE id > ? AND project_scope = ?
    `);

    // Watermark predicates built FROM the shared constants (Phase 3, spec §6):
    // the global cursor advances over 'held' rows, the per-scope one does not.
    this.lastWatermark = db.prepare(`
      SELECT MAX(observation_end_id) as watermark FROM discovery_runs WHERE status IN (${GLOBAL_WATERMARK_STATUSES.map(() => '?').join(',')})
    `);

    this.lastWatermarkProject = db.prepare(`
      SELECT MAX(observation_end_id) as watermark FROM discovery_runs WHERE status IN (${SCOPE_WATERMARK_STATUSES.map(() => '?').join(',')}) AND project_scope = ?
    `);

    this.insertRun = db.prepare(`
      INSERT INTO discovery_runs (project_scope, observation_start_id, status)
      VALUES (@project_scope, @observation_start_id, 'running')
    `);

    this.getRunById = db.prepare('SELECT * FROM discovery_runs WHERE id = ?');

    // 'held' is TERMINAL and deliberately absent here (Phase 3, Task 12): if a
    // held row ever read as active, one ephemeral-scope batch would block every
    // future discovery pass behind the stale-run threshold. Pinned in
    // tests/unit/held-run-consumers.test.ts.
    this.getActiveRunStmt = db.prepare(`
      SELECT * FROM discovery_runs WHERE status IN ('running', 'completing') ORDER BY id DESC LIMIT 1
    `);

    this.getActiveRunProjectStmt = db.prepare(`
      SELECT * FROM discovery_runs WHERE status IN ('running', 'completing') AND project_scope = ? ORDER BY id DESC LIMIT 1
    `);

    this.getObsBySessionStmt = db.prepare(`
      SELECT * FROM observations WHERE session_id = ? ORDER BY id ASC LIMIT ?
    `);

    // listSessions aggregates per session_id. completed_at gets MAX over both
    // completed_at and started_at so a session whose last event never completed
    // still surfaces a non-null end time. project_scopes and tool_names are
    // returned as comma-separated DISTINCT values; the caller splits.
    this.listSessionsStmt = db.prepare(`
      SELECT session_id,
             COUNT(*) AS observation_count,
             MIN(started_at) AS started_at,
             MAX(COALESCE(completed_at, started_at)) AS ended_at,
             (SELECT GROUP_CONCAT(ps, ',') FROM (SELECT DISTINCT project_scope AS ps FROM observations WHERE session_id = o.session_id ORDER BY project_scope)) AS project_scopes,
             (SELECT GROUP_CONCAT(tn, ',') FROM (SELECT DISTINCT tool_name AS tn FROM observations WHERE session_id = o.session_id ORDER BY tool_name)) AS tool_names
      FROM observations o
      GROUP BY session_id
      ORDER BY MIN(started_at) DESC
      LIMIT ?
    `);
  }

  async storeObservation(input: ObservationInput): Promise<Observation> {
    // Check idempotency
    if (input.idempotency_key) {
      const existing = this.getObsByIdempotency.get(input.idempotency_key) as Record<string, unknown> | undefined;
      if (existing) {
        return rowToObservation(existing);
      }
    }

    const status = input.event_type === 'tool_failed' ? 'failed'
      : input.event_type === 'tool_complete' ? 'completed'
      : 'started';

    const result = this.insertObs.run({
      idempotency_key: input.idempotency_key ?? null,
      session_id: input.session_id,
      project_scope: input.project_scope,
      tool_name: input.tool_name,
      input_summary: input.input_summary ?? null,
      output_summary: input.output_summary ?? null,
      status,
      started_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      duration_ms: null,
      metadata: JSON.stringify(input.metadata ?? {}),
    });

    const row = this.getObsById.get(result.lastInsertRowid) as Record<string, unknown>;
    return rowToObservation(row);
  }

  async completeObservation(id: number, data: ObservationComplete): Promise<Observation | null> {
    const result = this.completeObs.run({
      id,
      output_summary: data.output_summary ?? null,
      status: data.status,
      duration_ms: data.duration_ms ?? null,
    });

    if (result.changes === 0) return null;

    const row = this.getObsById.get(id) as Record<string, unknown> | undefined;
    return row ? rowToObservation(row) : null;
  }

  async storeObservationBatch(inputs: ObservationInput[]): Promise<Observation[]> {
    const results: Observation[] = [];

    const batch = this.db.transaction(() => {
      for (const input of inputs) {
        // Check idempotency inline
        if (input.idempotency_key) {
          const existing = this.getObsByIdempotency.get(input.idempotency_key) as Record<string, unknown> | undefined;
          if (existing) {
            results.push(rowToObservation(existing));
            continue;
          }
        }

        const status = input.event_type === 'tool_failed' ? 'failed'
          : input.event_type === 'tool_complete' ? 'completed'
          : 'started';

        const insertResult = this.insertObs.run({
          idempotency_key: input.idempotency_key ?? null,
          session_id: input.session_id,
          project_scope: input.project_scope,
          tool_name: input.tool_name,
          input_summary: input.input_summary ?? null,
          output_summary: input.output_summary ?? null,
          status,
          started_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
          duration_ms: null,
          metadata: JSON.stringify(input.metadata ?? {}),
        });

        const row = this.getObsById.get(insertResult.lastInsertRowid) as Record<string, unknown>;
        results.push(rowToObservation(row));
      }
    });

    batch();
    return results;
  }

  async getObservationsSince(startId: number, projectScope?: string, limit: number = 1000): Promise<Observation[]> {
    const rows = projectScope
      ? this.getObsSinceProject.all(startId, projectScope, limit)
      : this.getObsSince.all(startId, limit);
    return (rows as Record<string, unknown>[]).map(rowToObservation);
  }

  async getObservationsBySession(sessionId: string, limit: number = 5000): Promise<Observation[]> {
    const rows = this.getObsBySessionStmt.all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(rowToObservation);
  }

  async listSessions(limit: number = 50): Promise<SessionSummary[]> {
    const rows = this.listSessionsStmt.all(limit) as Record<string, unknown>[];
    return rows.map(row => ({
      session_id: row.session_id as string,
      observation_count: row.observation_count as number,
      started_at: row.started_at as string,
      ended_at: (row.ended_at as string) ?? null,
      project_scopes: row.project_scopes
        ? (row.project_scopes as string).split(',').filter(Boolean)
        : [],
      tool_names: row.tool_names
        ? (row.tool_names as string).split(',').filter(Boolean)
        : [],
    }));
  }

  async getObservationStats(projectScope?: string): Promise<ObservationStats> {
    let totalQuery: string;
    const params: string[] = [];

    if (projectScope) {
      totalQuery = 'SELECT COUNT(*) as total FROM observations WHERE project_scope = ?';
      params.push(projectScope);
    } else {
      totalQuery = 'SELECT COUNT(*) as total FROM observations';
    }

    const total = (this.db.prepare(totalQuery).get(...params) as { total: number }).total;

    const byProjectRows = this.db.prepare(
      'SELECT project_scope, COUNT(*) as count FROM observations GROUP BY project_scope'
    ).all() as { project_scope: string; count: number }[];
    const by_project: Record<string, number> = {};
    for (const row of byProjectRows) {
      by_project[row.project_scope] = row.count;
    }

    let byToolQuery: string;
    const byToolParams: string[] = [];
    if (projectScope) {
      byToolQuery = 'SELECT tool_name, COUNT(*) as count FROM observations WHERE project_scope = ? GROUP BY tool_name';
      byToolParams.push(projectScope);
    } else {
      byToolQuery = 'SELECT tool_name, COUNT(*) as count FROM observations GROUP BY tool_name';
    }
    const byToolRows = this.db.prepare(byToolQuery).all(...byToolParams) as { tool_name: string; count: number }[];
    const by_tool: Record<string, number> = {};
    for (const row of byToolRows) {
      by_tool[row.tool_name] = row.count;
    }

    // Phase 4: oldest/newest are scoped like total/by_tool. §2's alias-group
    // dormancy reads per-scope recency — a global MAX here made every scope
    // share one activity clock (and a scope with no rows read the corpus-wide
    // newest).
    const rangeQuery = projectScope
      ? 'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM observations WHERE project_scope = ?'
      : 'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM observations';
    const range = this.db.prepare(rangeQuery).get(...(projectScope ? [projectScope] : [])) as
      { oldest: string | null; newest: string | null };

    return { total, by_project, by_tool, oldest: range.oldest, newest: range.newest };
  }

  async purgeOlderThan(olderThanDays: number, batchSize: number = 1000, exemptScopes: string[] = []): Promise<number> {
    let totalDeleted = 0;
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString().replace('T', ' ').replace('Z', '');

    // Exempt (held/ephemeral) scopes are excluded from BOTH statements, via a
    // temp-table anti-join loaded in bounded chunks (round-2 fix S1b): binding
    // the whole list inline as `NOT IN (?, ?, …)` dies on SQLite's
    // bound-parameter cap once the exempt set grows past it, killing the
    // ENTIRE purge — the failure mode where holding more scopes silently stops
    // retention. Temp tables are connection-local, so concurrent purges on
    // other connections can't collide; rows are cleared per call because the
    // exempt list varies per run.
    const exemptSql = exemptScopes.length
      ? ' AND project_scope NOT IN (SELECT scope FROM temp.purge_exempt_scopes)'
      : '';
    if (exemptScopes.length) {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_exempt_scopes (scope TEXT PRIMARY KEY)');
      this.db.prepare('DELETE FROM temp.purge_exempt_scopes').run();
      const insert = this.db.prepare('INSERT OR IGNORE INTO temp.purge_exempt_scopes (scope) VALUES (?)');
      const insertChunk = this.db.transaction((chunk: string[]) => {
        for (const scope of chunk) insert.run(scope);
      });
      for (let i = 0; i < exemptScopes.length; i += PURGE_EXEMPT_CHUNK) {
        insertChunk(exemptScopes.slice(i, i + PURGE_EXEMPT_CHUNK));
      }
    }

    try {
      // Windowed delete by row ID to avoid long-running locks
      const maxIdRow = this.db.prepare(
        `SELECT MAX(id) as max_id FROM observations WHERE created_at < ?${exemptSql}`
      ).get(cutoff) as { max_id: number | null };
      if (!maxIdRow.max_id) return 0;

      // The inner SELECT re-applies the cutoff + exemption — `id <= max` alone
      // would sweep exempt (and fresh) rows sitting below the max id.
      const deleteStmt = this.db.prepare(
        `DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE id <= ? AND created_at < ?${exemptSql} LIMIT ?)`
      );

      let deleted: number;
      do {
        const result = deleteStmt.run(maxIdRow.max_id, cutoff, batchSize);
        deleted = result.changes;
        totalDeleted += deleted;
      } while (deleted === batchSize);

      return totalDeleted;
    } finally {
      // Leave no per-call state behind (the table itself is connection-scoped
      // and reused; only its rows are per-call).
      if (exemptScopes.length) this.db.prepare('DELETE FROM temp.purge_exempt_scopes').run();
    }
  }

  async getUnprocessedCount(lastWatermark: number, projectScope?: string): Promise<number> {
    if (projectScope) {
      return (this.countUnprocessedProject.get(lastWatermark, projectScope) as { count: number }).count;
    }
    return (this.countUnprocessed.get(lastWatermark) as { count: number }).count;
  }

  async getLastWatermark(projectScope?: string): Promise<number> {
    const row = projectScope
      ? this.lastWatermarkProject.get(...SCOPE_WATERMARK_STATUSES, projectScope) as { watermark: number | null }
      : this.lastWatermark.get(...GLOBAL_WATERMARK_STATUSES) as { watermark: number | null };
    return row.watermark ?? 0;
  }

  async getMaxObservationId(): Promise<number> {
    const row = this.db.prepare('SELECT MAX(id) AS max_id FROM observations').get() as { max_id: number | null };
    return row.max_id ?? 0;
  }

  async getLastObservationAt(): Promise<string | null> {
    const row = this.db.prepare('SELECT MAX(started_at) AS last FROM observations').get() as { last: string | null };
    if (!row.last) return null;
    // started_at is stored as 'YYYY-MM-DD HH:MM:SS[.SSS]' in UTC (no zone marker);
    // normalize to ISO-8601 so Date.parse doesn't read it as local time.
    return row.last.includes('T') ? row.last : `${row.last.replace(' ', 'T')}Z`;
  }

  async createDiscoveryRun(projectScope: string, observationStartId: number): Promise<DiscoveryRun> {
    const result = this.insertRun.run({
      project_scope: projectScope,
      observation_start_id: observationStartId,
    });

    const row = this.getRunById.get(result.lastInsertRowid) as Record<string, unknown>;
    return rowToDiscoveryRun(row);
  }

  async updateDiscoveryRun(
    id: number,
    updates: Partial<Pick<DiscoveryRun, 'observation_end_id' | 'observations_analyzed' | 'patterns_found' | 'memories_created' | 'memories_reinforced' | 'status' | 'error' | 'completed_at'>>
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];

    if (updates.observation_end_id !== undefined) {
      setClauses.push('observation_end_id = ?');
      params.push(updates.observation_end_id);
    }
    if (updates.observations_analyzed !== undefined) {
      setClauses.push('observations_analyzed = ?');
      params.push(updates.observations_analyzed);
    }
    if (updates.patterns_found !== undefined) {
      setClauses.push('patterns_found = ?');
      params.push(updates.patterns_found);
    }
    if (updates.memories_created !== undefined) {
      setClauses.push('memories_created = ?');
      params.push(updates.memories_created);
    }
    if (updates.memories_reinforced !== undefined) {
      setClauses.push('memories_reinforced = ?');
      params.push(updates.memories_reinforced);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.error !== undefined) {
      setClauses.push('error = ?');
      params.push(updates.error);
    }
    if (updates.completed_at !== undefined) {
      setClauses.push('completed_at = ?');
      params.push(updates.completed_at);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    this.db.prepare(`UPDATE discovery_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  }

  async getActiveRun(projectScope?: string): Promise<DiscoveryRun | null> {
    const row = projectScope
      ? this.getActiveRunProjectStmt.get(projectScope) as Record<string, unknown> | undefined
      : this.getActiveRunStmt.get() as Record<string, unknown> | undefined;
    return row ? rowToDiscoveryRun(row) : null;
  }

  async getDiscoveryRun(id: number): Promise<DiscoveryRun | null> {
    const row = this.getRunById.get(id) as Record<string, unknown> | undefined;
    return row ? rowToDiscoveryRun(row) : null;
  }

  async listDiscoveryRuns(projectScope?: string, limit: number = 20): Promise<DiscoveryRun[]> {
    let sql = 'SELECT * FROM discovery_runs';
    const params: (string | number)[] = [];

    if (projectScope) {
      sql += ' WHERE project_scope = ?';
      params.push(projectScope);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToDiscoveryRun);
  }

  async getHeldRunSummary(): Promise<{ scope: string; observations_pending: number; observations_total: number; last_end_id: number }[]> {
    // Pending = held rows above the scope's COMPLETED watermark (a completed
    // re-drive run covers everything at or below its end id — CO6); the
    // watermark predicate is built from SCOPE_WATERMARK_STATUSES, never a
    // literal. Fully re-driven scopes (pending 0) drop out via HAVING.
    const scopeWm = SCOPE_WATERMARK_STATUSES.map(() => '?').join(',');
    return this.db.prepare(
      `WITH scope_wm AS (
         SELECT project_scope, MAX(observation_end_id) AS wm
         FROM discovery_runs
         WHERE status IN (${scopeWm})
         GROUP BY project_scope
       )
       SELECT h.project_scope AS scope,
              COALESCE(SUM(CASE WHEN h.observation_end_id > COALESCE(w.wm, 0) THEN h.observations_analyzed ELSE 0 END), 0) AS observations_pending,
              COALESCE(SUM(h.observations_analyzed), 0) AS observations_total,
              COALESCE(MAX(h.observation_end_id), 0) AS last_end_id
       FROM discovery_runs h
       LEFT JOIN scope_wm w ON w.project_scope = h.project_scope
       WHERE h.status = 'held'
       GROUP BY h.project_scope
       HAVING observations_pending > 0
       ORDER BY h.project_scope ASC`
    ).all(...SCOPE_WATERMARK_STATUSES) as { scope: string; observations_pending: number; observations_total: number; last_end_id: number }[];
  }

  close(): void {
    // Connection lifecycle managed by observations-db.ts (closeObservationsDatabase)
    // This is a no-op — the caller should use closeObservationsDatabase() directly
  }
}
