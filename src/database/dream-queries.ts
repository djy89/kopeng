import type Database from 'better-sqlite3';
import type { IDreamStore, IOperatorConfigStore } from './interfaces.js';
import { MemoryQueries } from './queries.js';
import {
  PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON, REVISION_KEEP_PER_MEMORY,
  type Dream, type DreamDiff, type MemoryRevision, type DreamAuditEntry, type OperatorConfig,
  type DreamMode, type DreamTrigger, type ConsolidationLock,
} from '../types/types.js';

/** SQLite implementation of the dreaming-layer stores (D0.2). */
export class DreamQueries implements IDreamStore, IOperatorConfigStore {
  constructor(private db: Database.Database) {}

  /**
   * Lazily-built handle to the canonical memory store over the SAME db, so the
   * deprecated `setMemoryLock` can forward instead of re-spelling the write.
   * Lazy because MemoryQueries' constructor prepares ~16 statements and no
   * production caller reaches setMemoryLock — a DreamQueries that never calls it
   * pays nothing. No import cycle: queries.ts pulls only types + a tag constant.
   */
  private memoryStore?: MemoryQueries;
  private get memories(): MemoryQueries {
    return (this.memoryStore ??= new MemoryQueries(this.db));
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
    const info = this.db.prepare(
      `INSERT INTO dreams (operator_id, scope, mode, trigger_source, reason, window_key,
        input_obs_start_id, input_obs_end_id)
       VALUES (@operator_id, @scope, @mode, @trigger_source, @reason, @window_key,
        @input_obs_start_id, @input_obs_end_id)`
    ).run({
      operator_id: input.operator_id ?? 'default',
      scope: input.scope ?? null,
      mode: input.mode ?? 'windowed',
      trigger_source: input.trigger_source ?? 'scheduled',
      reason: input.reason ?? null,
      window_key: input.window_key ?? null,
      input_obs_start_id: input.input_obs_start_id ?? null,
      input_obs_end_id: input.input_obs_end_id ?? null,
    });
    const dream = await this.getDream(Number(info.lastInsertRowid));
    if (!dream) throw new Error('createDream: row vanished after insert');
    return dream;
  }

  async updateDream(id: number, updates: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(updates);
    if (cols.length === 0) return;
    const setClause = cols.map(c => `${c} = @${c}`).join(', ');
    this.db.prepare(`UPDATE dreams SET ${setClause} WHERE id = @__id`).run({ ...updates, __id: id });
  }

  async getDream(id: number): Promise<Dream | null> {
    const row = this.db.prepare(`SELECT * FROM dreams WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToDream(row) : null;
  }

  async getDreamByWindow(operatorId: string, scope: string | null, mode: DreamMode, windowKey: string): Promise<Dream | null> {
    const row = this.db.prepare(
      `SELECT * FROM dreams WHERE operator_id = ? AND mode = ? AND window_key = ?
        AND scope IS ? LIMIT 1`
    ).get(operatorId, mode, windowKey, scope) as Record<string, unknown> | undefined;
    return row ? rowToDream(row) : null;
  }

  async listDreamsByWindow(operatorId: string, scope: string | null, mode: DreamMode, windowKey: string): Promise<Dream[]> {
    const rows = this.db.prepare(
      `SELECT * FROM dreams WHERE operator_id = ? AND mode = ? AND window_key = ?
        AND scope IS ? ORDER BY started_at DESC, id DESC`
    ).all(operatorId, mode, windowKey, scope) as Record<string, unknown>[];
    return rows.map(rowToDream);
  }

  async getLastCompletedDream(operatorId: string, scope: string | null, mode: DreamMode): Promise<Dream | null> {
    // Excludes promotion + discovery-maintenance audit-carrier rows (P3, Phase
    // 2): a carrier is a real completed dreams row that exists only to route
    // archives through the audited apply path, not an actual dream pass —
    // counting it satisfies the once-per-period gate and permanently blocks
    // the whole-corpus sweep from firing.
    const row = this.db.prepare(
      `SELECT * FROM dreams WHERE operator_id = ? AND mode = ? AND scope IS ?
        AND status = 'completed' AND COALESCE(reason, '') NOT IN (?, ?)
       ORDER BY started_at DESC, id DESC LIMIT 1`
    ).get(operatorId, mode, scope, PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON) as Record<string, unknown> | undefined;
    return row ? rowToDream(row) : null;
  }

  async listDreams(limit: number): Promise<Dream[]> {
    const rows = this.db.prepare(
      `SELECT * FROM dreams ORDER BY started_at DESC, id DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToDream);
  }

  async listRecentDreams(limit: number, offset: number = 0): Promise<Dream[]> {
    // Carriers are INCLUDED here (team-review #22 S3): they perform real,
    // automatic archives, so dream-history is their one operator-facing record
    // — the ops endpoint labels them `is_carrier`. The carrier exclusion lives
    // only where it is load-bearing: getLastCompletedDream (the once-per-period
    // scheduler gate) and listPendingDreams (the review queue).
    const rows = this.db.prepare(
      `SELECT * FROM dreams WHERE status = 'completed'
       ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(limit, offset) as Record<string, unknown>[];
    return rows.map(rowToDream);
  }

  async listPendingDreams(limit: number): Promise<Dream[]> {
    // Carrier exclusion in the QUERY, matching listRecentDreams/getLastCompletedDream
    // (team-review #22): carriers previously stayed out of the review queue only because
    // their writers hardcode acceptance_status — an incidental value, not a rule.
    const rows = this.db.prepare(
      `SELECT * FROM dreams WHERE status = 'completed'
        AND acceptance_status IN ('pending', 'partial')
        AND COALESCE(reason, '') NOT IN (?, ?)
       ORDER BY started_at DESC, id DESC LIMIT ?`
    ).all(PROMOTION_CARRIER_REASON, MAINTENANCE_CARRIER_REASON, limit) as Record<string, unknown>[];
    return rows.map(rowToDream);
  }

  async setDreamDiff(id: number, diff: DreamDiff): Promise<void> {
    this.db.prepare(`UPDATE dreams SET output_diff = ? WHERE id = ?`).run(JSON.stringify(diff), id);
  }

  // ───────────────────────── revisions ──────────────────────────

  async snapshotRevision(memoryId: number, createdByDreamId?: number | null): Promise<{ id: number; revision: number }> {
    const txn = this.db.transaction(() => {
      const next = (this.db.prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS r FROM memory_revisions WHERE memory_id = ?`
      ).get(memoryId) as { r: number }).r;

      const tags = (this.db.prepare(`SELECT tag FROM memory_tags WHERE memory_id = ?`)
        .all(memoryId) as { tag: string }[]).map(t => t.tag);

      // Copy the live row into a revision; embedding BLOB is copied in-DB via SELECT.
      // is_locked is snapshotted (v10) because the lock is THE Hard Anchor and is
      // model-writable through update_memory {locked} — without it an unlock left
      // no record and no way back.
      const info = this.db.prepare(
        `INSERT INTO memory_revisions
          (memory_id, revision, content, content_hash, summary, embedding, embedding_model,
           confidence, observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
           scope, type, updated_at, last_seen, is_locked, created_by_dream_id)
         SELECT id, @revision, content, content_hash, summary, embedding, embedding_model,
           confidence, observation_count, metadata, @tags, last_contradicted, deprecated_at, valid_from,
           scope, type, updated_at, last_seen, is_locked, @dreamId
         FROM memories WHERE id = @id`
      ).run({ revision: next, tags: JSON.stringify(tags), dreamId: createdByDreamId ?? null, id: memoryId });

      if (info.changes === 0) throw new Error(`snapshotRevision: memory ${memoryId} not found`);

      // Retention (team-review #22): bound the operator-edit revision class to the newest
      // REVISION_KEEP_PER_MEMORY per memory. Dream-linked revisions are exempt — see the
      // constant's doc in types.ts. Guarded on the snapshot's own class (r2 N2): a
      // dream-linked snapshot cannot change the NULL-class set, so running the trim
      // there was a guaranteed no-op per audited archive.
      if (createdByDreamId == null) {
        this.db.prepare(
          `DELETE FROM memory_revisions
            WHERE memory_id = ? AND created_by_dream_id IS NULL
              AND revision NOT IN (
                SELECT revision FROM memory_revisions
                 WHERE memory_id = ? AND created_by_dream_id IS NULL
                 ORDER BY revision DESC LIMIT ?)`
        ).run(memoryId, memoryId, REVISION_KEEP_PER_MEMORY);
      }

      return { id: Number(info.lastInsertRowid), revision: next };
    });
    return txn();
  }

  async deleteRevision(memoryId: number, revision: number): Promise<boolean> {
    const info = this.db.prepare(
      `DELETE FROM memory_revisions WHERE memory_id = ? AND revision = ?`
    ).run(memoryId, revision);
    return info.changes > 0;
  }

  async deleteRevisions(memoryId: number): Promise<number> {
    const info = this.db.prepare(
      `DELETE FROM memory_revisions WHERE memory_id = ?`
    ).run(memoryId);
    return info.changes;
  }

  async listRevisions(memoryId: number): Promise<MemoryRevision[]> {
    const rows = this.db.prepare(
      `SELECT id, memory_id, revision, content, content_hash, summary, confidence,
        observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
        scope, type, updated_at, last_seen, is_locked, created_by_dream_id, created_at
       FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC`
    ).all(memoryId) as Record<string, unknown>[];
    return rows.map(rowToRevision);
  }

  async getRevision(memoryId: number, revision: number): Promise<MemoryRevision | null> {
    const row = this.db.prepare(
      `SELECT id, memory_id, revision, content, content_hash, summary, confidence,
        observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
        scope, type, updated_at, last_seen, is_locked, created_by_dream_id, created_at
       FROM memory_revisions WHERE memory_id = ? AND revision = ?`
    ).get(memoryId, revision) as Record<string, unknown> | undefined;
    return row ? rowToRevision(row) : null;
  }

  async restoreRevision(memoryId: number, revision: number): Promise<boolean> {
    const txn = this.db.transaction(() => {
      const r = this.db.prepare(
        `SELECT * FROM memory_revisions WHERE memory_id = ? AND revision = ?`
      ).get(memoryId, revision) as Record<string, unknown> | undefined;
      if (!r) return false;

      // Snapshot the current state first so the restore is itself reversible.
      const tags = (this.db.prepare(`SELECT tag FROM memory_tags WHERE memory_id = ?`)
        .all(memoryId) as { tag: string }[]).map(t => t.tag);
      const next = (this.db.prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS r FROM memory_revisions WHERE memory_id = ?`
      ).get(memoryId) as { r: number }).r;
      this.db.prepare(
        `INSERT INTO memory_revisions
          (memory_id, revision, content, content_hash, summary, embedding, embedding_model,
           confidence, observation_count, metadata, tags, last_contradicted, deprecated_at, valid_from,
           scope, type, updated_at, last_seen, is_locked, created_by_dream_id)
         SELECT id, @revision, content, content_hash, summary, embedding, embedding_model,
           confidence, observation_count, metadata, @tags, last_contradicted, deprecated_at, valid_from,
           scope, type, updated_at, last_seen, is_locked, NULL
         FROM memories WHERE id = @id`
      ).run({ revision: next, tags: JSON.stringify(tags), id: memoryId });

      // Copy the revision back over the live row (FTS stays synced via the UPDATE trigger).
      // scope/type/last_seen/is_locked are NULL-safe COALESCEs: a legacy revision has
      // NULL in these columns (pre-v8 for the first three, pre-v10 for is_locked) and
      // must never clobber the live values (ruling 7). For is_locked that guard is
      // the difference between "rollback restores the anchor" and "rollback strips
      // the anchor off a live locked row".
      // updated_at is NOT restored from the revision — it always gets the restore's own
      // stamp, since it is the correction clock, not part of what's being reverted.
      this.db.prepare(
        `UPDATE memories SET content = @content, content_hash = @content_hash, summary = @summary,
          embedding = @embedding, embedding_model = @embedding_model, confidence = @confidence,
          observation_count = @observation_count, metadata = @metadata,
          last_contradicted = @last_contradicted, deprecated_at = @deprecated_at, valid_from = @valid_from,
          scope = COALESCE(@scope, scope), type = COALESCE(@type, type),
          last_seen = COALESCE(@last_seen, last_seen),
          is_locked = COALESCE(@is_locked, is_locked),
          updated_at = datetime('now')
         WHERE id = @id`
      ).run({
        content: r.content, content_hash: r.content_hash, summary: r.summary,
        embedding: r.embedding, embedding_model: r.embedding_model, confidence: r.confidence,
        observation_count: r.observation_count, metadata: r.metadata,
        last_contradicted: r.last_contradicted ?? null, deprecated_at: r.deprecated_at ?? null,
        valid_from: r.valid_from ?? null,
        scope: r.scope ?? null, type: r.type ?? null, last_seen: r.last_seen ?? null,
        is_locked: r.is_locked ?? null,
        id: memoryId,
      });

      // Replace tags with the revision's snapshot.
      this.db.prepare(`DELETE FROM memory_tags WHERE memory_id = ?`).run(memoryId);
      const restoredTags = JSON.parse((r.tags as string) ?? '[]') as string[];
      const insTag = this.db.prepare(`INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)`);
      for (const t of restoredTags) insTag.run(memoryId, t);

      return true;
    });
    return txn();
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
    const info = this.db.prepare(
      `INSERT INTO dream_audit_log
        (dream_id, memory_id, revision_id, change_class, action, applied_automatically, before_ref, after_ref)
       VALUES (@dream_id, @memory_id, @revision_id, @change_class, @action, @applied_automatically, @before_ref, @after_ref)`
    ).run({
      dream_id: entry.dream_id,
      memory_id: entry.memory_id ?? null,
      revision_id: entry.revision_id ?? null,
      change_class: entry.change_class,
      action: entry.action ?? null,
      applied_automatically: entry.applied_automatically ? 1 : 0,
      before_ref: entry.before_ref ?? null,
      after_ref: entry.after_ref ?? null,
    });
    const row = this.db.prepare(`SELECT * FROM dream_audit_log WHERE id = ?`).get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    return rowToAudit(row);
  }

  async listAuditForDream(dreamId: number): Promise<DreamAuditEntry[]> {
    const rows = this.db.prepare(
      `SELECT * FROM dream_audit_log WHERE dream_id = ? ORDER BY id ASC`
    ).all(dreamId) as Record<string, unknown>[];
    return rows.map(rowToAudit);
  }

  // ──────────────────── reinforcement / anchor ──────────────────

  async reinforceMemory(memoryId: number, at?: string): Promise<void> {
    if (at) {
      this.db.prepare(
        `UPDATE memories SET observation_count = observation_count + 1, last_seen = ? WHERE id = ?`
      ).run(at, memoryId);
    } else {
      this.db.prepare(
        `UPDATE memories SET observation_count = observation_count + 1, last_seen = datetime('now') WHERE id = ?`
      ).run(memoryId);
    }
  }

  /**
   * DEPRECATED — kept only because it is an exported store method that may have
   * out-of-repo callers. It now FORWARDS to `IMemoryStore.updateLocked`, the
   * canonical lock write, so there is exactly ONE implementation of "write
   * is_locked" per backend rather than two that can drift.
   *
   * It used to drift already: this spelling skipped `updated_at`. Two
   * independently-correct copies are still two copies — the repo's recurring bug
   * class — so the fix is delegation, not alignment. `tests/unit/dream-queries.test.ts`
   * pins it: both write paths must leave byte-identical row state.
   *
   * Prefer `IMemoryStore.updateLocked` directly in new code.
   */
  async setMemoryLock(memoryId: number, locked: boolean): Promise<void> {
    return this.memories.updateLocked(memoryId, locked);
  }

  // ───────────────────── consolidation lock ─────────────────────

  async tryAcquireLock(operatorId: string, holder: string, nowIso: string, expiresAtIso: string): Promise<boolean> {
    // Single statement = atomic under better-sqlite3's synchronous model. The ON
    // CONFLICT WHERE only fires the UPDATE when the lock is free, ours already, or stale.
    const info = this.db.prepare(
      `INSERT INTO consolidation_lock (operator_id, holder, acquired_at, expires_at)
       VALUES (@op, @holder, @now, @exp)
       ON CONFLICT(operator_id) DO UPDATE SET
         holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
       WHERE consolidation_lock.holder IS NULL
          OR consolidation_lock.holder = excluded.holder
          OR consolidation_lock.expires_at IS NULL
          OR consolidation_lock.expires_at <= @now`
    ).run({ op: operatorId, holder, now: nowIso, exp: expiresAtIso });
    return info.changes > 0;
  }

  async releaseLock(operatorId: string, holder: string): Promise<boolean> {
    const info = this.db.prepare(
      `UPDATE consolidation_lock SET holder = NULL, acquired_at = NULL, expires_at = NULL
       WHERE operator_id = ? AND holder = ?`
    ).run(operatorId, holder);
    return info.changes > 0;
  }

  async getLock(operatorId: string): Promise<ConsolidationLock | null> {
    const row = this.db.prepare(`SELECT * FROM consolidation_lock WHERE operator_id = ?`)
      .get(operatorId) as Record<string, unknown> | undefined;
    return row ? rowToLock(row) : null;
  }

  // ─────────────────────── operator_config ──────────────────────

  async getConfig(operatorId: string = 'default'): Promise<OperatorConfig | null> {
    const row = this.db.prepare(`SELECT * FROM operator_config WHERE operator_id = ?`)
      .get(operatorId) as Record<string, unknown> | undefined;
    return row ? rowToConfig(row) : null;
  }

  async updateConfig(operatorId: string, patch: Record<string, unknown>): Promise<OperatorConfig> {
    const normalized: Record<string, unknown> = { ...patch };
    // Coerce booleans to SQLite integers.
    for (const k of ['auto_accept_exact_dup', 'auto_accept_decay']) {
      if (k in normalized) normalized[k] = normalized[k] ? 1 : 0;
    }
    const cols = Object.keys(normalized);
    const setClause = [...cols.map(c => `${c} = @${c}`), `updated_at = datetime('now')`].join(', ');
    this.db.prepare(`UPDATE operator_config SET ${setClause} WHERE operator_id = @__id`)
      .run({ ...normalized, __id: operatorId });
    const cfg = await this.getConfig(operatorId);
    if (!cfg) throw new Error(`updateConfig: operator '${operatorId}' not found`);
    return cfg;
  }
}

// ─────────────────────────── mappers ────────────────────────────

function rowToDream(row: Record<string, unknown>): Dream {
  return {
    id: row.id as number,
    operator_id: row.operator_id as string,
    scope: (row.scope as string | null) ?? null,
    mode: row.mode as Dream['mode'],
    trigger_source: row.trigger_source as Dream['trigger_source'],
    reason: (row.reason as string | null) ?? null,
    window_key: (row.window_key as string | null) ?? null,
    input_obs_start_id: (row.input_obs_start_id as number | null) ?? null,
    input_obs_end_id: (row.input_obs_end_id as number | null) ?? null,
    output_diff: (row.output_diff as string | null) ?? null,
    acceptance_status: row.acceptance_status as Dream['acceptance_status'],
    status: row.status as Dream['status'],
    started_at: row.started_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
    duration_ms: (row.duration_ms as number | null) ?? null,
    memories_examined: row.memories_examined as number,
    changes_auto_applied: row.changes_auto_applied as number,
    changes_queued: row.changes_queued as number,
    error: (row.error as string | null) ?? null,
  };
}

function rowToRevision(row: Record<string, unknown>): MemoryRevision {
  return {
    id: row.id as number,
    memory_id: row.memory_id as number,
    revision: row.revision as number,
    content: row.content as string,
    content_hash: (row.content_hash as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    observation_count: (row.observation_count as number | null) ?? null,
    metadata: (row.metadata as string | null) ?? '{}',
    tags: JSON.parse((row.tags as string | null) ?? '[]'),
    last_contradicted: (row.last_contradicted as string | null) ?? null,
    deprecated_at: (row.deprecated_at as string | null) ?? null,
    valid_from: (row.valid_from as string | null) ?? null,
    scope: (row.scope as string | null) ?? null,
    type: (row.type as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
    last_seen: (row.last_seen as string | null) ?? null,
    // SQLite stores 0/1; normalize to the boolean the revision surface exposes.
    // `== null` (not `=== null`) so a pre-v10 row, where the column is absent
    // entirely rather than NULL, also reads as "this revision predates the column".
    is_locked: row.is_locked == null ? null : !!row.is_locked,
    created_by_dream_id: (row.created_by_dream_id as number | null) ?? null,
    created_at: row.created_at as string,
  };
}

function rowToAudit(row: Record<string, unknown>): DreamAuditEntry {
  return {
    id: row.id as number,
    dream_id: row.dream_id as number,
    memory_id: (row.memory_id as number | null) ?? null,
    revision_id: (row.revision_id as number | null) ?? null,
    change_class: row.change_class as DreamAuditEntry['change_class'],
    action: (row.action as string | null) ?? null,
    applied_automatically: !!row.applied_automatically,
    before_ref: (row.before_ref as string | null) ?? null,
    after_ref: (row.after_ref as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

function rowToConfig(row: Record<string, unknown>): OperatorConfig {
  return {
    operator_id: row.operator_id as string,
    timezone: (row.timezone as string | null) ?? null,
    quiet_hours_start: (row.quiet_hours_start as string | null) ?? null,
    quiet_hours_end: (row.quiet_hours_end as string | null) ?? null,
    idle_minutes: row.idle_minutes as number,
    dream_cadence: (row.dream_cadence as string | null) ?? null,
    auto_accept_exact_dup: !!row.auto_accept_exact_dup,
    auto_accept_decay: !!row.auto_accept_decay,
    reasoner_provider: (row.reasoner_provider as string | null) ?? null,
    primary_scope: (row.primary_scope as string | null) ?? null,
    config: (row.config as string | null) ?? '{}',
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToLock(row: Record<string, unknown>): ConsolidationLock {
  return {
    operator_id: row.operator_id as string,
    holder: (row.holder as string | null) ?? null,
    acquired_at: (row.acquired_at as string | null) ?? null,
    expires_at: (row.expires_at as string | null) ?? null,
  };
}
