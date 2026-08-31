import type { Memory, MemoryType, Observation, ObservationInput, ObservationComplete, DiscoveryRun, ObservationStats, PromotionRun, ConfidenceTierCount, TopDecayingMemory, CorpusHealthStats, CorpusHealthSampleRow, ScopeAggregateRow, SessionSummary, Dream, DreamDiff, MemoryRevision, DreamAuditEntry, OperatorConfig, DreamMode, DreamTrigger, ConsolidationLock } from '../types/types.js';
import type { VectorSearchResult } from '../embeddings/index.js';
import type { ScopeRegistryRow, RegisterRequest, ScopeRegistryStatus } from '../scopes/minting.js';

export type { ScopeRegistryRow } from '../scopes/minting.js';

/**
 * Abstract interface for memory storage operations.
 * Implemented by MemoryQueries (SQLite) and future PostgreSQL backend.
 */
export interface IMemoryStore {
  store(input: {
    content: string;
    type: MemoryType;
    scope: string;
    source: string | null;
    source_path: string | null;
    metadata: string;
    embedding: Buffer | null;
    embedding_model: string;
    created_by: string | null;
    tags: string[];
    confidence?: number;
    discovery_run_id?: number;
    /** Initial evidence count (defaults 1). Discoveries seed this from evidence_count. */
    observation_count?: number;
  }): Promise<{ id: number; deduplicated: boolean }>;

  storeBatch(items: {
    content: string;
    type: MemoryType;
    scope: string;
    source: string | null;
    source_path: string | null;
    metadata: string;
    embedding: Buffer | null;
    embedding_model: string;
    created_by: string | null;
    tags: string[];
    confidence?: number;
    discovery_run_id?: number;
    observation_count?: number;
  }[]): Promise<{ ids: number[]; duplicates: number }>;

  get(id: number): Promise<(Memory & { tags: string[] }) | null>;

  /**
   * Read WITHOUT touching the access log (team-review #22 P2). `get()` is a
   * surfacing point — it reinforces the decay clock's frequency term. Apply-time
   * revalidation and audit internals inspect members without the operator ever
   * seeing them, so they must use this instead ("member reads are deliberately
   * not reinforcement points", diff-review doctrine).
   */
  peek(id: number): Promise<(Memory & { tags: string[] }) | null>;

  update(id: number, input: {
    content: string;
    type: MemoryType;
    scope: string;
    metadata: string;
    tags: string[];
  }): Promise<{ contentChanged: boolean }>;

  setEmbedding(id: number, embedding: Buffer, model: string): Promise<void>;

  archive(id: number): Promise<boolean>;

  unarchive(id: number): Promise<boolean>;

  searchFts(query: string, limit: number): Promise<{ rowid: number; rank: number }[]>;

  list(filters: {
    type?: MemoryType;
    scope?: string;
    tags?: string[];
    cursor?: number;
    limit: number;
    include_archived: boolean;
    /** Skip the embedding column (returned as null) — for list consumers that never read vectors. */
    lite?: boolean;
  }): Promise<{ memories: (Memory & { tags: string[] })[]; has_more: boolean }>;

  /**
   * Active memories in an ascending id range: `id > after_id` (AND `id <= max_id`
   * when set), ordered by id ASC. Backs the D1.4 rotating dream window — `max_id`
   * is the wrap fetch's upper bound so the wrapped slice never overlaps the tail.
   */
  listByIdRange(opts: {
    after_id: number;
    max_id?: number;
    limit: number;
    scope?: string;
  }): Promise<(Memory & { tags: string[] })[]>;

  getFilteredIds(filters: {
    type?: MemoryType;
    scope?: string;
    tags?: string[];
    include_archived: boolean;
  }): Promise<number[]>;

  loadAllEmbeddings(): Promise<{ id: number; embedding: Buffer }[]>;

  getCount(): Promise<number>;

  getFtsCount(): Promise<number>;

  getTypeStats(): Promise<Record<string, number>>;

  getScopeStats(): Promise<Record<string, number>>;

  updateConfidence(id: number, confidence: number): Promise<void>;

  /**
   * WS7.4 B1: is_locked is THE Hard Anchor write path (deprecating the
   * confidence>=1.0 / metadata.pinned spellings). Mirrors updateConfidence:
   * a targeted column write, called only when the PUT handler's lockChanged
   * check is true. NOT snapshotted into memory_revisions (Ruling 4 — the lock
   * is protection state, not content state) and therefore never restored by
   * rollback.
   */
  updateLocked(id: number, locked: boolean): Promise<void>;

  /**
   * Reinforcement-on-access (D1.1): bump observation_count and refresh last_seen
   * for memories that were genuinely surfaced (recall/search results, direct get).
   * Resets the durability decay clock. Deliberately does NOT touch content,
   * confidence, or updated_at — correction and usage live on different columns.
   */
  reinforceOnAccess(ids: number[]): Promise<void>;

  /**
   * S7 retention: delete memory_access_log rows older than `days` (backend-native
   * cutoff — never a JS ISO string, CX-7). Returns rows deleted; `days <= 0`
   * means keep forever (no DELETE executed). Reporting-only blast radius: the
   * archive line (`isDecayedAtRisk`) reads no access-log rows (CX-14).
   */
  trimAccessLog(days: number): Promise<number>;

  /**
   * D2.2 temporal supersession markers. Sets only the keys present (null clears).
   * Deliberately does NOT touch updated_at/last_seen — marking a memory
   * deprecated must not reset its decay clock.
   */
  setTemporalMarkers(id: number, markers: {
    deprecated_at?: string | null;
    valid_from?: string | null;
    last_contradicted?: string | null;
  }): Promise<void>;

  /**
   * D2.2 conditional-encode side effect: stamp last_contradicted AND reset
   * durability (observation_count → 1) — a contradicted memory must re-earn its
   * decay resistance. Does not touch updated_at/last_seen.
   */
  markContradicted(ids: number[], atIso: string): Promise<void>;

  rebuildFts(): Promise<void>;

  /** Histogram of confidence values, bucketed into tiers and grouped by memory type. */
  getConfidenceDistribution(): Promise<ConfidenceTierCount[]>;

  /** Top N memories ordered by decay score ascending (most-decayed first). On-demand compute. */
  getTopDecaying(limit: number): Promise<TopDecayingMemory[]>;

  /** Most recent promotion_runs row. Returns null if the pipeline has never been run. */
  getLastPromotionRun(): Promise<PromotionRun | null>;

  /** List recent promotion_runs ordered started_at DESC. */
  listPromotionRuns(limit: number): Promise<PromotionRun[]>;

  /** Cheap SQL-only corpus-health aggregates (active count, mean confidence, contradiction-flagged count). */
  getCorpusHealthStats(): Promise<CorpusHealthStats>;

  /**
   * Bounded sample of active memories with the inputs for the derived corpus-health
   * signals (decay strength + duplicate-pair scan). Ordered by id ASC, capped at `limit`.
   */
  getCorpusHealthSample(limit: number): Promise<CorpusHealthSampleRow[]>;

  /**
   * Per-scope aggregates for the T43 scope-drift detector: one row per scope
   * with active/archived split, per-type counts, and first/last write. SQL-only
   * (GROUP BY scope, type) — no content scanning, so it stays cheap enough for
   * an ops poll. Covers ALL rows, archived included: a migration's residual
   * check counts active rows only, so archived rows stranded on an alias scope
   * are exactly the residue nothing else surfaces.
   */
  getScopeAggregates(): Promise<ScopeAggregateRow[]>;

  /** Active-row count for one exact scope (Phase 3 ops: the `project:_unrouted` triage backlog). */
  countActiveByScope(scope: string): Promise<number>;

  /**
   * Active rows whose metadata JSON contains the given top-level key (LIKE '%"raw_scope"%' is
   * acceptable — this endpoint is polled rarely and the count is advisory).
   */
  countActiveWithMetadataKey(key: string): Promise<number>;
}

/**
 * Abstract interface for vector similarity search.
 * Implemented by EmbeddingIndex (in-memory) and future pgvector backend.
 */
export interface IVectorSearch {
  loadFromDatabase(rows: { id: number; embedding: Buffer }[]): Promise<void>;

  add(id: number, embedding: Float32Array): Promise<void>;

  remove(id: number): Promise<void>;

  search(query: Float32Array, candidateIds?: number[], topK?: number): Promise<VectorSearchResult[]>;

  get isReady(): boolean;

  get size(): number;
}

/**
 * Watermark predicates (Phase 3 scope minting, spec §6 — shared vocabulary).
 *
 * The two cursors deliberately diverge on `held` rows. A `held` discovery run
 * records an ephemeral scope (workflow-run, subagent, date-stamped, bare-number
 * — see `ephemeralReason` in src/scopes/drift.ts) whose observations were
 * OBSERVED but never minted from:
 *
 * - The GLOBAL cursor must advance over held rows — otherwise every discovery
 *   pass re-fetches the same held observations forever and real scopes starve
 *   behind the ephemeral ones (the held row IS the record that the batch was
 *   consumed).
 * - The PER-SCOPE cursor must NOT advance — that scope's observations are by
 *   definition unprocessed, so a future re-drive (the scope later ruled real
 *   by the operator) starts from 0 and sees everything.
 *
 * These constants are the single source for both watermark predicates; the
 * observation stores build their SQL from them — no literal status strings.
 */
export const GLOBAL_WATERMARK_STATUSES = ['completed', 'held'] as const;
export const SCOPE_WATERMARK_STATUSES = ['completed'] as const;

/**
 * Abstract interface for observation storage operations.
 * Operates on the separate observations database (observations.db or PG observations table).
 */
export interface IObservationStore {
  /** INSERT a new observation row (tool_start event). */
  storeObservation(input: ObservationInput): Promise<Observation>;

  /** UPDATE an existing observation with completion data (tool_complete event). Additive-only: only fills NULL columns, only transitions status forward. */
  completeObservation(id: number, data: ObservationComplete): Promise<Observation | null>;

  /** Batch INSERT observations. Returns created observations. */
  storeObservationBatch(inputs: ObservationInput[]): Promise<Observation[]>;

  /** Get observations with id > startId, optionally filtered by project_scope. Watermark-based. */
  getObservationsSince(startId: number, projectScope?: string, limit?: number): Promise<Observation[]>;

  /** Get all observations for a given session_id, ordered by id ASC. Used by replay playback. */
  getObservationsBySession(sessionId: string, limit?: number): Promise<Observation[]>;

  /** List recent sessions with aggregate counts. Ordered by started_at DESC. Used by the replay session picker. */
  listSessions(limit?: number): Promise<SessionSummary[]>;

  /** Aggregate counts by project and tool. */
  getObservationStats(projectScope?: string): Promise<ObservationStats>;

  /** Windowed DELETE of observations older than N days. Rows on `exemptScopes` (held/ephemeral scopes whose per-scope watermark never advanced — see `ephemeralReason`) are never deleted. Returns count deleted. */
  purgeOlderThan(olderThanDays: number, batchSize?: number, exemptScopes?: string[]): Promise<number>;

  /** Count observations after the given watermark. */
  getUnprocessedCount(lastWatermark: number, projectScope?: string): Promise<number>;

  /** Get MAX(observation_end_id) from completed discovery runs for a project scope. */
  getLastWatermark(projectScope?: string): Promise<number>;

  /** Get MAX(id) from observations table. Used to compute cursor lag against discovery watermark. */
  getMaxObservationId(): Promise<number>;

  /** MAX(started_at) over all observations as an ISO-8601 UTC string, or null when empty. Durable activity floor for the dream scheduler's idle signal (R3) — survives restarts, unlike the in-process ActivityTracker. */
  getLastObservationAt(): Promise<string | null>;

  /** Create a new discovery run record. Returns the created run. */
  createDiscoveryRun(projectScope: string, observationStartId: number): Promise<DiscoveryRun>;

  /** Update a discovery run (status, counts, end_id, error). */
  updateDiscoveryRun(id: number, updates: Partial<Pick<DiscoveryRun, 'observation_end_id' | 'observations_analyzed' | 'patterns_found' | 'memories_created' | 'memories_reinforced' | 'status' | 'error' | 'completed_at'>>): Promise<void>;

  /** Get the currently active (running/completing) run for a project, if any. */
  getActiveRun(projectScope?: string): Promise<DiscoveryRun | null>;

  /** Get a specific discovery run by ID. */
  getDiscoveryRun(id: number): Promise<DiscoveryRun | null>;

  /** List recent discovery runs, optionally filtered by project scope. */
  listDiscoveryRuns(projectScope?: string, limit?: number): Promise<DiscoveryRun[]>;

  /**
   * GROUP BY project_scope over status='held' runs — the PENDING backlog, not
   * an ever-held ledger (round-2 fix CO6): `observations_pending` counts only
   * held rows whose observation_end_id is ABOVE the scope's completed
   * per-scope watermark (SCOPE_WATERMARK_STATUSES — a completed re-drive run
   * covers everything at or below it); `observations_total` is the all-time
   * held count for context. A fully re-driven scope reads pending 0 and DROPS
   * OUT of the summary (its held history stays visible in the raw
   * /api/discoveries/runs listing).
   */
  getHeldRunSummary(): Promise<{ scope: string; observations_pending: number; observations_total: number; last_end_id: number }[]>;

  /** Close database connection / release resources. */
  close(): void;
}

/**
 * Abstract interface for dreaming-layer storage (D0.2).
 * Implemented by DreamQueries (SQLite) and PgDreamQueries (Postgres).
 * Operates on the dreaming tables added in migration D0.1 plus reinforcement /
 * lock columns on `memories`. Kept separate from IMemoryStore so the existing
 * query classes are untouched.
 */
export interface IDreamStore {
  // ── dreams ──
  /** Insert a new dream pass (status 'running'). Returns the created row. */
  createDream(input: {
    operator_id?: string;
    scope?: string | null;
    mode?: DreamMode;
    trigger_source?: DreamTrigger;
    reason?: string | null;
    window_key?: string | null;
    input_obs_start_id?: number | null;
    input_obs_end_id?: number | null;
  }): Promise<Dream>;

  /** Patch a dream row (counts, status, diff, acceptance, completion). */
  updateDream(id: number, updates: Partial<Pick<Dream,
    'output_diff' | 'acceptance_status' | 'status' | 'completed_at' | 'duration_ms' |
    'memories_examined' | 'changes_auto_applied' | 'changes_queued' | 'error' |
    'input_obs_start_id' | 'input_obs_end_id' | 'reason'>>): Promise<void>;

  getDream(id: number): Promise<Dream | null>;

  /** Idempotency lookup: the dream for a given window, if one already exists. */
  getDreamByWindow(operatorId: string, scope: string | null, mode: DreamMode, windowKey: string): Promise<Dream | null>;

  /** All dreams recorded for a window, newest-first. The engine derives collapse (any non-failed row) and the failed-retry budget from this (R2). */
  listDreamsByWindow(operatorId: string, scope: string | null, mode: DreamMode, windowKey: string): Promise<Dream[]>;

  /** Most recent dream with status='completed' for (operator, scope, mode). Feeds the scheduler's "already ran today" — failed/running dreams must not collapse the day (R2). */
  getLastCompletedDream(operatorId: string, scope: string | null, mode: DreamMode): Promise<Dream | null>;

  listDreams(limit: number): Promise<Dream[]>;

  /** Recent completed dreams (status='completed'), newest first, with offset paging. Backs /api/ops/dream-history. */
  listRecentDreams(limit: number, offset?: number): Promise<Dream[]>;

  /** Completed dreams awaiting operator review (acceptance 'pending' or 'partial'), newest first. */
  listPendingDreams(limit: number): Promise<Dream[]>;

  // ── revisions (stable memories.id; embedding copied in-DB) ──
  /** Snapshot the live memory row into memory_revisions. Returns the new revision id + number. */
  snapshotRevision(memoryId: number, createdByDreamId?: number | null): Promise<{ id: number; revision: number }>;

  listRevisions(memoryId: number): Promise<MemoryRevision[]>;

  getRevision(memoryId: number, revision: number): Promise<MemoryRevision | null>;

  /** Restore a revision over the live row (snapshots current first, so restore is itself reversible). Does NOT touch the in-memory vector index — caller syncs that. */
  restoreRevision(memoryId: number, revision: number): Promise<boolean>;

  /** Permanently delete ONE revision (admin redaction path — may delete dream-linked revisions; the operator is choosing to excise history). Returns whether a row was deleted. */
  deleteRevision(memoryId: number, revision: number): Promise<boolean>;

  /** Permanently delete ALL revisions for a memory (admin redaction path). Returns the count deleted. */
  deleteRevisions(memoryId: number): Promise<number>;

  // ── audit ──
  appendAudit(entry: {
    dream_id: number;
    memory_id?: number | null;
    revision_id?: number | null;
    change_class: DreamAuditEntry['change_class'];
    action?: string | null;
    applied_automatically?: boolean;
    before_ref?: string | null;
    after_ref?: string | null;
  }): Promise<DreamAuditEntry>;

  listAuditForDream(dreamId: number): Promise<DreamAuditEntry[]>;

  // ── reinforcement / anchor on memories ──
  /** Bump observation_count and refresh last_seen (recall/reinforce reset of the decay clock). */
  reinforceMemory(memoryId: number, at?: string): Promise<void>;

  /**
   * DEPRECATED — set the Hard-Anchor lock flag. `IMemoryStore.updateLocked` is the
   * canonical lock write (it is what PUT /api/memories/:id calls) and both backend
   * implementations of this method now FORWARD to it, so there is one implementation
   * per backend, not two that can drift. Retained because it is an exported store
   * method with possible out-of-repo callers; no in-repo production caller. Prefer
   * `updateLocked` in new code.
   */
  setMemoryLock(memoryId: number, locked: boolean): Promise<void>;

  /** Serialize the diff for a dream pass into output_diff. */
  setDreamDiff(id: number, diff: DreamDiff): Promise<void>;

  // ── consolidation lock (single-holder mutex, stale-TTL release) ──
  /**
   * Atomic compare-and-set acquire. Succeeds when the lock is free, already held
   * by `holder` (re-acquire / extend), or stale (`expires_at <= nowIso`). Timestamps
   * are ISO-8601 UTC strings so SQLite lexicographic and Postgres timestamptz
   * comparisons agree. Returns true iff the lock is now held by `holder`.
   */
  tryAcquireLock(operatorId: string, holder: string, nowIso: string, expiresAtIso: string): Promise<boolean>;

  /** Release the lock iff currently held by `holder`. Returns true if a row was cleared. */
  releaseLock(operatorId: string, holder: string): Promise<boolean>;

  /** Current lock state, or null if no row exists for the operator. */
  getLock(operatorId: string): Promise<ConsolidationLock | null>;
}

/**
 * Abstract interface for the single-row operator_config (D0.2).
 */
export interface IOperatorConfigStore {
  /** Fetch the operator config row (seeded 'default'). Returns null only if unseeded. */
  getConfig(operatorId?: string): Promise<OperatorConfig | null>;

  /** Patch operator config fields; bumps updated_at. Returns the updated row. */
  updateConfig(operatorId: string, patch: Partial<Pick<OperatorConfig,
    'timezone' | 'quiet_hours_start' | 'quiet_hours_end' | 'idle_minutes' |
    'dream_cadence' | 'auto_accept_exact_dup' | 'auto_accept_decay' |
    'reasoner_provider' | 'primary_scope' | 'config'>>): Promise<OperatorConfig>;
}

/**
 * Abstract interface for the Phase 3 scope registry (scope_registry table).
 * Row/request shapes live in src/scopes/minting.ts — the shared vocabulary
 * every minting consumer imports.
 */
export interface IScopeRegistryStore {
  listAll(): Promise<ScopeRegistryRow[]>;
  /** Idempotent: ON CONFLICT (scope) DO NOTHING. Returns true when a row was inserted. */
  register(req: RegisterRequest): Promise<boolean>;
  updateStatus(scope: string, status: ScopeRegistryStatus, ruledAt?: string): Promise<void>;
  /** Ruling 'rename': re-key a row. Throws if newScope already exists. */
  rename(oldScope: string, newScope: string, newSlug: string | null): Promise<void>;
}

/**
 * Abstract interface for database lifecycle operations.
 * Wraps initialization, shutdown, stats, and backup.
 */
export interface IDatabaseLifecycle {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getStats(): Promise<{
    total_memories: number;
    active_memories: number;
    archived_memories: number;
    db_size_bytes: number;
    wal_size_bytes: number;
  }>;
  backup(): Promise<string>;
}
