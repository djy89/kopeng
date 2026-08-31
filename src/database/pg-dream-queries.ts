import type pg from 'pg';
import type { IDreamStore, IOperatorConfigStore } from './interfaces.js';
import { PgQueries } from './pg-queries.js';
import {
  PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON, REVISION_KEEP_PER_MEMORY,
  type Dream, type DreamDiff, type MemoryRevision, type DreamAuditEntry, type OperatorConfig,
  type DreamMode, type DreamTrigger, type ConsolidationLock,
} from '../types/types.js';

/** Postgres implementation of the dreaming-layer stores (D0.2). */
export class PgDreamQueries implements IDreamStore, IOperatorConfigStore {
  constructor(private pool: pg.Pool) {}

  /**
   * Handle to the canonical memory store over the SAME pool, so the deprecated
   * `setMemoryLock` can forward instead of re-spelling the write. PgQueries'
   * constructor only stores the pool, so this is free; lazy anyway to mirror the
   * SQLite side. pg-queries.ts already imports queries.ts, so cross-store
   * imports are an established edge here — no cycle.
   */
  private memoryStore?: PgQueries;
  private get memories(): PgQueries {
    return (this.memoryStore ??= new PgQueries(this.pool));
  }

  // ─────────────────────────── dreams ───────────────────────────

  async createDream(input: {
    operator_id?: string;
    scope?: string | null;
    mode?: DreamMode;
    trigger_source?: DreamTrigger;
    reason?: string | null;
    window_key?: string | null;
    input_obs_start_id?: number | null;
    input_obs_end_id?: number | null;
  }): Promise<Dream> {
    const r = await this.pool.query(
      `INSERT INTO dreams (operator_id, scope, mode, trigger_source, reason, window_key,
        input_obs_start_id, input_obs_end_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.operator_id ?? 'default',
        input.scope ?? null,
        input.mode ?? 'windowed',
        input.trigger_source ?? 'scheduled',
        input.reason ?? null,
        input.window_key ?? null,
        input.input_obs_start_id ?? null,
        input.input_obs_end_id ?? null,
      ]
    );
    return rowToDream(r.rows[0]);
  }

  async updateDream(id: number, updates: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map(k => normalizeJson(k, updates[k]));
    vals.push(id);
    await this.pool.query(`UPDATE dreams SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`, vals);
  }

  async getDream(id: number): Promise<Dream | null> {
    const r = await this.pool.query(`SELECT * FROM dreams WHERE id = $1`, [id]);
    return r.rows.length ? rowToDream(r.rows[0]) : null;
  }

  async getDreamByWindow(operatorId: string, scope: string | null, mode: DreamMode, windowKey: string): Promise<Dream | null> {
    const r = await this.pool.query(
      `SELECT * FROM dreams WHERE operator_id = $1 AND mode = $2 AND window_key = $3
        AND scope IS NOT DISTINCT FROM $4 LIMIT 1`,
      [operatorId, mode, windowKey, scope]
    );
    return r.rows.length ? rowToDream(r.rows[0]) : null;
  }

  async listDreamsByWindow(operatorId: string, scope: string | null, mode: DreamMode, windowKey: string): Promise<Dream[]> {
    const r = await this.pool.query(
      `SELECT * FROM dreams WHERE operator_id = $1 AND mode = $2 AND window_key = $3
        AND scope IS NOT DISTINCT FROM $4 ORDER BY started_at DESC, id DESC`,
      [operatorId, mode, windowKey, scope]
    );
    return r.rows.map(rowToDream);
  }

  async getLastCompletedDream(operatorId: string, scope: string | null, mode: DreamMode): Promise<Dream | null> {
    // Excludes promotion + discovery-maintenance audit-carrier rows (P3, Phase
    // 2): a carrier is a real completed dreams row that exists only to route
    // archives through the audited apply path, not an actual dream pass —
    // counting it satisfies the once-per-period gate and permanently blocks
    // the whole-corpus sweep from firing.
    const r = await this.pool.query(
      `SELECT * FROM dreams WHERE operator_id = $1 AND mode = $2
        AND scope IS NOT DISTINCT FROM $3 AND status = 'completed'
        AND COALESCE(reason, '') NOT IN ($4, $5)
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [operatorId, mode, scope, PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON]
    );
    return r.rows.length ? rowToDream(r.rows[0]) : null;
  }

  async listDreams(limit: number): Promise<Dream[]> {
    const r = await this.pool.query(
      `SELECT * FROM dreams ORDER BY started_at DESC, id DESC LIMIT $1`, [limit]
    );
    return r.rows.map(rowToDream);
  }

  async listRecentDreams(limit: number, offset: number = 0): Promise<Dream[]> {
    // Carriers are INCLUDED here (team-review #22 S3): they perform real,
    // automatic archives, so dream-history is their one operator-facing record
    // — the ops endpoint labels them `is_carrier`. The carrier exclusion lives
    // only where it is load-bearing: getLastCompletedDream (the once-per-period
    // scheduler gate) and listPendingDreams (the review queue).
    const r = await this.pool.query(
      `SELECT * FROM dreams WHERE status = 'completed'
       ORDER BY started_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return r.rows.map(rowToDream);
  }

  async listPendingDreams(limit: number): Promise<Dream[]> {
    // Carrier exclusion in the QUERY, matching listRecentDreams/getLastCompletedDream
    // (team-review #22): carriers previously stayed out of the review queue only because
    // their writers hardcode acceptance_status — an incidental value, not a rule.
    const r = await this.pool.query(
      `SELECT * FROM dreams WHERE status = 'completed'
        AND acceptance_status IN ('pending', 'partial')
        AND COALESCE(reason, '') NOT IN ($2, $3)
       ORDER BY started_at DESC, id DESC LIMIT $1`,
      [limit, PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON]
    );
    return r.rows.map(rowToDream);
  }

  async setDreamDiff(id: number, diff: DreamDiff): Promise<void> {
    await this.pool.query(`UPDATE dreams SET output_diff = $1 WHERE id = $2`, [JSON.stringify(diff), id]);
  }

  // ───────────────────────── revisions ──────────────────────────

  async snapshotRevision(memoryId: number, createdByDreamId?: number | null): Promise<{ id: number; revision: number }> {
    // is_locked is snapshotted (v12) because the lock is THE Hard Anchor and is
    // model-writable through update_memory {locked} — without it an unlock left no
    // record and no way back.
    const insertSql =
      `INSERT INTO memory_revisions
        (memory_id, revision, content, content_hash, summary, embedding, embedding_model,
         confidence, observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
         scope, type, updated_at, last_seen, is_locked, created_by_dream_id)
       SELECT m.id,
         (SELECT COALESCE(MAX(revision), 0) + 1 FROM memory_revisions WHERE memory_id = $1),
         m.content, m.content_hash, m.summary, m.embedding, m.embedding_model,
         m.confidence, m.observation_count, m.metadata,
         (SELECT COALESCE(jsonb_agg(tag ORDER BY tag), '[]'::jsonb) FROM memory_tags WHERE memory_id = $1),
         m.last_contradicted, m.deprecated_at, m.valid_from,
         m.scope, m.type, m.updated_at, m.last_seen, m.is_locked, $2
       FROM memories m WHERE m.id = $1
       RETURNING id, revision`;
    const insertParams = [memoryId, createdByDreamId ?? null];

    // Dream-linked snapshot: single statement, no trim — a non-NULL-class insert
    // cannot change the NULL-class set, so the trim there was a guaranteed no-op
    // costing one round-trip per audited archive (team-review #22 r2 N2).
    if (createdByDreamId != null) {
      const r = await this.pool.query(insertSql, insertParams);
      if (r.rows.length === 0) throw new Error(`snapshotRevision: memory ${memoryId} not found`);
      return { id: Number(r.rows[0].id), revision: Number(r.rows[0].revision) };
    }

    // Operator-edit snapshot: insert + retention trim in ONE transaction — the
    // SQLite side wraps the pair in db.transaction, and the two backends must
    // share atomicity semantics (r2 NEW-5).
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(insertSql, insertParams);
      if (r.rows.length === 0) throw new Error(`snapshotRevision: memory ${memoryId} not found`);
      // Retention (team-review #22): bound the operator-edit revision class to the
      // newest REVISION_KEEP_PER_MEMORY per memory. Dream-linked revisions are
      // exempt — see the constant's doc in types.ts.
      await client.query(
        `DELETE FROM memory_revisions
          WHERE memory_id = $1 AND created_by_dream_id IS NULL
            AND revision NOT IN (
              SELECT revision FROM memory_revisions
               WHERE memory_id = $1 AND created_by_dream_id IS NULL
               ORDER BY revision DESC LIMIT $2)`,
        [memoryId, REVISION_KEEP_PER_MEMORY]
      );
      await client.query('COMMIT');
      return { id: Number(r.rows[0].id), revision: Number(r.rows[0].revision) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteRevision(memoryId: number, revision: number): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM memory_revisions WHERE memory_id = $1 AND revision = $2`, [memoryId, revision]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async deleteRevisions(memoryId: number): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM memory_revisions WHERE memory_id = $1`, [memoryId]
    );
    return r.rowCount ?? 0;
  }

  async listRevisions(memoryId: number): Promise<MemoryRevision[]> {
    const r = await this.pool.query(
      `SELECT id, memory_id, revision, content, content_hash, summary, confidence,
        observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
        scope, type, updated_at, last_seen, is_locked, created_by_dream_id, created_at
       FROM memory_revisions WHERE memory_id = $1 ORDER BY revision DESC`,
      [memoryId]
    );
    return r.rows.map(rowToRevision);
  }

  async getRevision(memoryId: number, revision: number): Promise<MemoryRevision | null> {
    const r = await this.pool.query(
      `SELECT id, memory_id, revision, content, content_hash, summary, confidence,
        observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
        scope, type, updated_at, last_seen, is_locked, created_by_dream_id, created_at
       FROM memory_revisions WHERE memory_id = $1 AND revision = $2`,
      [memoryId, revision]
    );
    return r.rows.length ? rowToRevision(r.rows[0]) : null;
  }

  async restoreRevision(memoryId: number, revision: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query(
        `SELECT 1 FROM memory_revisions WHERE memory_id = $1 AND revision = $2`, [memoryId, revision]
      );
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      // Snapshot current state first (reversible restore).
      await client.query(
        `INSERT INTO memory_revisions
          (memory_id, revision, content, content_hash, summary, embedding, embedding_model,
           confidence, observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
           scope, type, updated_at, last_seen, is_locked, created_by_dream_id)
         SELECT m.id,
           (SELECT COALESCE(MAX(revision), 0) + 1 FROM memory_revisions WHERE memory_id = $1),
           m.content, m.content_hash, m.summary, m.embedding, m.embedding_model,
           m.confidence, m.observation_count, m.metadata,
           (SELECT COALESCE(jsonb_agg(tag ORDER BY tag), '[]'::jsonb) FROM memory_tags WHERE memory_id = $1),
           m.last_contradicted, m.deprecated_at, m.valid_from,
           m.scope, m.type, m.updated_at, m.last_seen, m.is_locked, NULL
         FROM memories m WHERE m.id = $1`,
        [memoryId]
      );

      // Copy the revision back over the live row (search_vector regenerates automatically).
      // scope/type/last_seen/is_locked are NULL-safe COALESCEs: a legacy revision has
      // NULL in these columns (pre-v10 for the first three, pre-v12 for is_locked) and
      // must never clobber the live values (ruling 7). For is_locked that guard is the
      // difference between "rollback restores the anchor" and "rollback strips the
      // anchor off a live locked row".
      // updated_at is NOT restored from the revision — it always gets the restore's own
      // stamp, since it is the correction clock, not part of what's being reverted.
      await client.query(
        `UPDATE memories m SET content = r.content, content_hash = r.content_hash, summary = r.summary,
          embedding = r.embedding, embedding_model = r.embedding_model, confidence = r.confidence,
          observation_count = r.observation_count, metadata = r.metadata,
          last_contradicted = r.last_contradicted, deprecated_at = r.deprecated_at, valid_from = r.valid_from,
          scope = COALESCE(r.scope, m.scope), type = COALESCE(r.type, m.type),
          last_seen = COALESCE(r.last_seen, m.last_seen),
          is_locked = COALESCE(r.is_locked, m.is_locked),
          updated_at = NOW()
         FROM memory_revisions r WHERE r.memory_id = $1 AND r.revision = $2 AND m.id = $1`,
        [memoryId, revision]
      );

      // Replace tags from the revision snapshot.
      await client.query(`DELETE FROM memory_tags WHERE memory_id = $1`, [memoryId]);
      await client.query(
        `INSERT INTO memory_tags (memory_id, tag)
         SELECT $1, jsonb_array_elements_text(
           (SELECT tags FROM memory_revisions WHERE memory_id = $1 AND revision = $2))
         ON CONFLICT DO NOTHING`,
        [memoryId, revision]
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─────────────────────────── audit ────────────────────────────

  async appendAudit(entry: {
    dream_id: number;
    memory_id?: number | null;
    revision_id?: number | null;
    change_class: DreamAuditEntry['change_class'];
    action?: string | null;
    applied_automatically?: boolean;
    before_ref?: string | null;
    after_ref?: string | null;
  }): Promise<DreamAuditEntry> {
    const r = await this.pool.query(
      `INSERT INTO dream_audit_log
        (dream_id, memory_id, revision_id, change_class, action, applied_automatically, before_ref, after_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        entry.dream_id, entry.memory_id ?? null, entry.revision_id ?? null, entry.change_class,
        entry.action ?? null, entry.applied_automatically ?? false, entry.before_ref ?? null, entry.after_ref ?? null,
      ]
    );
    return rowToAudit(r.rows[0]);
  }

  async listAuditForDream(dreamId: number): Promise<DreamAuditEntry[]> {
    const r = await this.pool.query(
      `SELECT * FROM dream_audit_log WHERE dream_id = $1 ORDER BY id ASC`, [dreamId]
    );
    return r.rows.map(rowToAudit);
  }

  // ──────────────────── reinforcement / anchor ──────────────────

  async reinforceMemory(memoryId: number, at?: string): Promise<void> {
    await this.pool.query(
      `UPDATE memories SET observation_count = observation_count + 1, last_seen = COALESCE($2::timestamptz, NOW())
       WHERE id = $1`,
      [memoryId, at ?? null]
    );
  }

  /**
   * DEPRECATED — kept only because it is an exported store method that may have
   * out-of-repo callers. It now FORWARDS to `IMemoryStore.updateLocked`, the
   * canonical lock write, so there is exactly ONE implementation of "write
   * is_locked" per backend rather than two that can drift. (This spelling had
   * already drifted: it skipped `updated_at`.) Prefer `updateLocked` in new code.
   */
  async setMemoryLock(memoryId: number, locked: boolean): Promise<void> {
    return this.memories.updateLocked(memoryId, locked);
  }

  // ───────────────────── consolidation lock ─────────────────────

  async tryAcquireLock(operatorId: string, holder: string, nowIso: string, expiresAtIso: string): Promise<boolean> {
    // INSERT ... ON CONFLICT DO UPDATE ... WHERE is a single atomic statement; the
    // UPDATE only fires when the lock is free, ours already, or stale.
    const r = await this.pool.query(
      `INSERT INTO consolidation_lock (operator_id, holder, acquired_at, expires_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (operator_id) DO UPDATE SET
         holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at
       WHERE consolidation_lock.holder IS NULL
          OR consolidation_lock.holder = EXCLUDED.holder
          OR consolidation_lock.expires_at IS NULL
          OR consolidation_lock.expires_at <= $3::timestamptz
       RETURNING operator_id`,
      [operatorId, holder, nowIso, expiresAtIso]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async releaseLock(operatorId: string, holder: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE consolidation_lock SET holder = NULL, acquired_at = NULL, expires_at = NULL
       WHERE operator_id = $1 AND holder = $2`,
      [operatorId, holder]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async getLock(operatorId: string): Promise<ConsolidationLock | null> {
    const r = await this.pool.query(`SELECT * FROM consolidation_lock WHERE operator_id = $1`, [operatorId]);
    return r.rows.length ? rowToLock(r.rows[0]) : null;
  }

  // ─────────────────────── operator_config ──────────────────────

  async getConfig(operatorId: string = 'default'): Promise<OperatorConfig | null> {
    const r = await this.pool.query(`SELECT * FROM operator_config WHERE operator_id = $1`, [operatorId]);
    return r.rows.length ? rowToConfig(r.rows[0]) : null;
  }

  async updateConfig(operatorId: string, patch: Record<string, unknown>): Promise<OperatorConfig> {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    sets.push('updated_at = NOW()');
    const vals = keys.map(k => normalizeJson(k, patch[k]));
    vals.push(operatorId);
    await this.pool.query(
      `UPDATE operator_config SET ${sets.join(', ')} WHERE operator_id = $${keys.length + 1}`, vals
    );
    const cfg = await this.getConfig(operatorId);
    if (!cfg) throw new Error(`updateConfig: operator '${operatorId}' not found`);
    return cfg;
  }
}

// ─────────────────────────── helpers ────────────────────────────

/** JSONB columns accept a JSON string; pass objects through as serialized JSON. */
function normalizeJson(key: string, value: unknown): unknown {
  if ((key === 'output_diff' || key === 'config') && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : (v as string);
}

/** JSONB comes back from the pg driver already parsed; re-serialize to the string-typed shape. */
function jsonToString(v: unknown, fallback: string): string {
  if (v === null || v === undefined) return fallback;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function rowToDream(row: Record<string, unknown>): Dream {
  return {
    id: Number(row.id),
    operator_id: row.operator_id as string,
    scope: (row.scope as string | null) ?? null,
    mode: row.mode as Dream['mode'],
    trigger_source: row.trigger_source as Dream['trigger_source'],
    reason: (row.reason as string | null) ?? null,
    window_key: (row.window_key as string | null) ?? null,
    input_obs_start_id: row.input_obs_start_id !== null && row.input_obs_start_id !== undefined ? Number(row.input_obs_start_id) : null,
    input_obs_end_id: row.input_obs_end_id !== null && row.input_obs_end_id !== undefined ? Number(row.input_obs_end_id) : null,
    output_diff: row.output_diff !== null && row.output_diff !== undefined ? jsonToString(row.output_diff, 'null') : null,
    acceptance_status: row.acceptance_status as Dream['acceptance_status'],
    status: row.status as Dream['status'],
    started_at: toIso(row.started_at),
    completed_at: toIsoOrNull(row.completed_at),
    duration_ms: (row.duration_ms as number | null) ?? null,
    memories_examined: Number(row.memories_examined),
    changes_auto_applied: Number(row.changes_auto_applied),
    changes_queued: Number(row.changes_queued),
    error: (row.error as string | null) ?? null,
  };
}

function rowToRevision(row: Record<string, unknown>): MemoryRevision {
  return {
    id: Number(row.id),
    memory_id: Number(row.memory_id),
    revision: Number(row.revision),
    content: row.content as string,
    content_hash: (row.content_hash as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    observation_count: (row.observation_count as number | null) ?? null,
    metadata: jsonToString(row.metadata, '{}'),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : JSON.parse((row.tags as string | null) ?? '[]'),
    last_contradicted: toIsoOrNull(row.last_contradicted),
    deprecated_at: toIsoOrNull(row.deprecated_at),
    valid_from: toIsoOrNull(row.valid_from),
    scope: (row.scope as string | null) ?? null,
    type: (row.type as string | null) ?? null,
    updated_at: toIsoOrNull(row.updated_at),
    last_seen: toIsoOrNull(row.last_seen),
    // PG already hands back a boolean; the coercion mirrors the SQLite mapper so
    // both backends expose the same shape. `== null` (not `=== null`) so a pre-v12
    // row, where the column is absent entirely rather than NULL, also reads as
    // "this revision predates the column".
    is_locked: row.is_locked == null ? null : !!row.is_locked,
    created_by_dream_id: row.created_by_dream_id !== null && row.created_by_dream_id !== undefined ? Number(row.created_by_dream_id) : null,
    created_at: toIso(row.created_at),
  };
}

function rowToAudit(row: Record<string, unknown>): DreamAuditEntry {
  return {
    id: Number(row.id),
    dream_id: Number(row.dream_id),
    memory_id: row.memory_id !== null && row.memory_id !== undefined ? Number(row.memory_id) : null,
    revision_id: row.revision_id !== null && row.revision_id !== undefined ? Number(row.revision_id) : null,
    change_class: row.change_class as DreamAuditEntry['change_class'],
    action: (row.action as string | null) ?? null,
    applied_automatically: !!row.applied_automatically,
    before_ref: (row.before_ref as string | null) ?? null,
    after_ref: (row.after_ref as string | null) ?? null,
    created_at: toIso(row.created_at),
  };
}

function rowToConfig(row: Record<string, unknown>): OperatorConfig {
  return {
    operator_id: row.operator_id as string,
    timezone: (row.timezone as string | null) ?? null,
    quiet_hours_start: (row.quiet_hours_start as string | null) ?? null,
    quiet_hours_end: (row.quiet_hours_end as string | null) ?? null,
    idle_minutes: Number(row.idle_minutes),
    dream_cadence: (row.dream_cadence as string | null) ?? null,
    auto_accept_exact_dup: !!row.auto_accept_exact_dup,
    auto_accept_decay: !!row.auto_accept_decay,
    reasoner_provider: (row.reasoner_provider as string | null) ?? null,
    primary_scope: (row.primary_scope as string | null) ?? null,
    config: jsonToString(row.config, '{}'),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function rowToLock(row: Record<string, unknown>): ConsolidationLock {
  return {
    operator_id: row.operator_id as string,
    holder: (row.holder as string | null) ?? null,
    acquired_at: toIsoOrNull(row.acquired_at),
    expires_at: toIsoOrNull(row.expires_at),
  };
}
