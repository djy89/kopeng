export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'discovery';

export interface Memory {
  id: number;
  content: string;
  content_hash: string | null;
  summary: string | null;
  type: MemoryType;
  scope: string;
  source: string | null;
  source_path: string | null;
  metadata: string;
  embedding: Buffer | null;
  embedding_model: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  is_archived: number;
  confidence: number;
  discovery_run_id: number | null;
  /** Usage/durability columns (migration v4/v6). Reinforcement-on-access bumps
   *  these; content correction does not (D1.1 column separation). Nullable for
   *  rows read through paths that predate the columns. */
  observation_count: number | null;
  last_seen: string | null;
  /** Hard-Anchor lock flag (migration v4/v6). 1 = never consolidated/decayed. */
  is_locked: number;
  /** Temporal supersession markers (migration v4/v6, written by D2.2 apply):
   *  deprecated_at set = superseded by a newer statement (kept, not archived);
   *  valid_from = when this statement became current (backfilled to created_at);
   *  last_contradicted = last time a contradiction/conditional touched this row. */
  deprecated_at: string | null;
  valid_from: string | null;
  last_contradicted: string | null;
}

export interface MemoryTag {
  memory_id: number;
  tag: string;
}

export interface MemoryAccessLog {
  id: number;
  memory_id: number;
  accessed_at: string;
}

export interface MemoryInput {
  content: string;
  type?: MemoryType;
  scope?: string;
  source?: string;
  source_path?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  created_by?: string;
}

export interface MemoryUpdate {
  content?: string;
  type?: MemoryType;
  scope?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface SearchRequest {
  query: string;
  mode?: 'hybrid' | 'semantic' | 'keyword';
  type?: MemoryType;
  scope?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  include_archived?: boolean;
  rerank?: boolean;
  rerank_candidates?: number;
}

export interface SearchResult {
  memory: Memory & { tags: string[] };
  score: number;
  rerank_score?: number;
  match_type: 'hybrid' | 'semantic' | 'keyword';
}

export interface ListRequest {
  type?: MemoryType;
  scope?: string;
  tags?: string[];
  limit?: number;
  cursor?: number;
  include_archived?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    limit?: number;
    offset?: number;
    cursor?: number;
    has_more?: boolean;
    duration_ms?: number;
  };
}

export interface HealthResponse {
  status: 'ready' | 'loading' | 'error';
  embedding: 'loaded' | 'initializing' | 'error';
  search: 'hybrid' | 'keyword_only' | 'unavailable';
  memories: number;
  uptime_seconds: number;
}

export interface StatsResponse {
  total_memories: number;
  active_memories: number;
  archived_memories: number;
  by_type: Record<MemoryType, number>;
  by_scope: Record<string, number>;
  db_size_bytes: number;
  wal_size_bytes: number;
  embedding_index_size: number;
  fts_entries: number;
}

export interface VectorEntry {
  embedding: Float32Array;
  magnitude: number;
}

// ========== Auto-Discovery Types ==========

export interface Observation {
  id: number;
  idempotency_key: string | null;
  session_id: string;
  project_scope: string;
  tool_name: string;
  input_summary: string | null;
  output_summary: string | null;
  status: 'started' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  metadata: string;
  schema_version: number;
  created_at: string;
}

export interface ObservationInput {
  idempotency_key?: string;
  session_id: string;
  project_scope: string;
  tool_name: string;
  event_type?: 'tool_start' | 'tool_complete' | 'tool_failed';
  input_summary?: string;
  output_summary?: string;
  metadata?: Record<string, unknown>;
}

export interface ObservationComplete {
  output_summary?: string;
  status: 'completed' | 'failed';
  duration_ms?: number;
}

export interface DiscoveryRun {
  id: number;
  project_scope: string;
  observation_start_id: number | null;
  observation_end_id: number | null;
  observations_analyzed: number;
  patterns_found: number;
  memories_created: number;
  memories_reinforced: number;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completing' | 'completed' | 'failed';
  error: string | null;
}

export interface PromotionRun {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'failed';
  dry_run: boolean;
  archive_threshold: number | null;
  similarity_threshold: number | null;
  decay_computed: number;
  decay_avg_score: number | null;
  decay_below_threshold: number;
  consolidation_candidates: number;
  consolidation_duplicates: number;
  consolidation_merge_targets: number;
  memories_archived: number;
  duration_ms: number | null;
  error: string | null;
}

export interface ConfidenceTierCount {
  type: MemoryType;
  tier: 'noted' | 'pattern' | 'actionable' | 'confirmed';
  count: number;
}

export interface TopDecayingMemory {
  id: number;
  type: MemoryType;
  scope: string;
  summary: string;
  total_score: number;
  recency_score: number;
  frequency_score: number;
  days_since_access: number;
  confidence: number;
  tags: string[];
}

/** Cheap SQL-only aggregates over the active corpus, backing /api/ops/corpus-health. */
export interface CorpusHealthStats {
  active_count: number;
  /** Mean confidence over active memories. null when the corpus is empty. */
  mean_confidence: number | null;
  /** Distinct active memories carrying the contradiction-flagged tag. */
  contradiction_flagged_count: number;
}

/**
 * Per-memory inputs for the corpus-health derived signals (decay strength +
 * duplicate-pair scan). A bounded sample — the route documents the cost.
 */
export interface CorpusHealthSampleRow {
  id: number;
  confidence: number;
  observation_count: number | null;
  last_seen: string | null;
  updated_at: string;
  /** Raw embedding BLOB, or null for rows without one. */
  embedding: Buffer | null;
  /** Inputs for the duplicate-pair actionability breakdown (classifyDupPair). */
  scope: string;
  is_locked: boolean;
  metadata: string | null;
}

export interface DiscoveryConfig {
  ingestionEnabled: boolean;
  detectionEnabled: boolean;
  minOccurrences: number;
  minErrorOccurrences: number;
  analysisWindowHours: number;
  observationRetentionDays: number;
  maxInputSize: number;
  maxOutputSize: number;
  maxErrorOutputSize: number;
  confidenceFloor: number;
  maxObservationsTableSize: number;
  triggerEveryN: number;
  discoveryIntervalMs: number;
  apiKey: string;
}

export interface ObservationStats {
  total: number;
  by_project: Record<string, number>;
  by_tool: Record<string, number>;
  oldest: string | null;
  newest: string | null;
}

export interface SessionSummary {
  session_id: string;
  observation_count: number;
  started_at: string;
  ended_at: string | null;
  project_scopes: string[];
  tool_names: string[];
}

export interface DiscoveryResult {
  run_id: number;
  project_scope: string;
  observations_analyzed: number;
  patterns_found: number;
  memories_created: number;
  memories_reinforced: number;
  duration_ms: number;
}

export interface PatternCandidate {
  pattern_type: 'repeated_tool' | 'error_fix' | 'hot_file' | 'workflow' | 'recurring_error' | 'sequence';
  description: string;
  evidence_count: number;
  observation_span_days: number;
  project_scope: string;
  confidence: number;
  content: string;
  evidence_snapshot: EvidenceEntry[];
  /** Whether a successful fix was observed (set by error heuristics). */
  has_fix?: boolean;
  /** Number of distinct sessions in which this pattern was observed. */
  distinct_sessions?: number;
  /** Additional tags from synthesizer (merged with default auto-discovered tags). */
  synthesized_tags?: string[];
}

export interface EvidenceEntry {
  tool: string;
  input_hash: string;
  session_id: string;
  at: string;
  error_category?: string;
  error_signature?: string;
}

// ========== Dreaming Layer Types (D0.2) ==========

export type DreamMode = 'windowed' | 'whole_corpus';
export type DreamTrigger = 'scheduled' | 'manual';
export type DreamAcceptance = 'pending' | 'partial' | 'accepted' | 'rejected' | 'auto_applied' | 'empty';
export type DreamStatus = 'running' | 'completed' | 'failed';
/**
 * `promote_global` (D1.2/R6): cross-scope duplicate routed to the cross-scope
 * promotion path — a diff-only signal (never applied by the dream apply path).
 * `rollback` (D1.3): audit-only — written when a memory_revisions snapshot is
 * restored over the live row; never emitted in a diff. Both are covered by the
 * dream_audit_log CHECK as of SQLite v6 / PG v8.
 * `conditional` (D2.2): reasoner-classified branch pair — apply encodes
 * "when X→A; when Y→B" as a new memory with provenance; audited (SQLite v7 /
 * PG v9). `contested` (D2.2): contradiction with no clear distinguisher —
 * diff-only, queued for the operator, NEVER applied or audited.
 */
export type DreamChangeClass = 'exact_dup' | 'decay' | 'merge' | 'supersede' | 'reinforce' | 'promote_global' | 'rollback' | 'conditional' | 'contested';
/** Deterministic-safe entries may auto-apply; reasoner-driven entries are queued for review. */
export type DreamDiffTier = 'deterministic-safe' | 'reasoner-driven';

/** One dream pass. Mirrors the `dreams` table (D0.1). */
export interface Dream {
  id: number;
  operator_id: string;
  scope: string | null;
  mode: DreamMode;
  trigger_source: DreamTrigger;
  reason: string | null;
  window_key: string | null;
  input_obs_start_id: number | null;
  input_obs_end_id: number | null;
  output_diff: string | null;
  acceptance_status: DreamAcceptance;
  status: DreamStatus;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  memories_examined: number;
  changes_auto_applied: number;
  changes_queued: number;
  error: string | null;
}

/** A single proposed change within a dream pass. Serialized into `dreams.output_diff`. */
export interface DreamDiffEntry {
  change_class: DreamChangeClass;
  tier: DreamDiffTier;
  memory_ids: number[];
  rationale: string;
  before?: unknown;
  after?: unknown;
  /**
   * D1.3 per-entry resolution state, persisted back into `output_diff`.
   * Absent = still pending (queued for operator review).
   */
  resolution?: 'auto_applied' | 'accepted' | 'rejected';
  resolved_at?: string;
}

export interface DreamDiff {
  entries: DreamDiffEntry[];
}

/**
 * Append-only snapshot of a memory before a dream modified it. `memories.id` stays
 * stable; rollback copies a revision back over the live row. Embedding is stored in
 * the row but copied in-DB on snapshot/restore — never surfaced through this type.
 */
export interface MemoryRevision {
  id: number;
  memory_id: number;
  revision: number;
  content: string;
  content_hash: string | null;
  summary: string | null;
  confidence: number | null;
  observation_count: number | null;
  metadata: string;
  tags: string[];
  /** Temporal markers at snapshot time (SQLite v7 / PG v9) — restored on rollback
   *  so a supersession's deprecated_at/valid_from writes are reversible. */
  last_contradicted: string | null;
  deprecated_at: string | null;
  valid_from: string | null;
  created_by_dream_id: number | null;
  created_at: string;
}

/** Append-only audit record of an applied dream change. Mirrors `dream_audit_log`. */
export interface DreamAuditEntry {
  id: number;
  dream_id: number;
  memory_id: number | null;
  revision_id: number | null;
  change_class: DreamChangeClass;
  action: string | null;
  applied_automatically: boolean;
  before_ref: string | null;
  after_ref: string | null;
  created_at: string;
}

/** Single-row operator knobs. Mirrors `operator_config` (seeded with auto-accept OFF). */
export interface OperatorConfig {
  operator_id: string;
  timezone: string | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  idle_minutes: number;
  dream_cadence: string | null;
  auto_accept_exact_dup: boolean;
  auto_accept_decay: boolean;
  reasoner_provider: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}

/**
 * Single-holder consolidation mutex. Mirrors `consolidation_lock` (D0.1).
 * A free/released lock has all three nullable fields NULL; a stale lock has
 * `expires_at` in the past and is reclaimable by any holder.
 */
export interface ConsolidationLock {
  operator_id: string;
  holder: string | null;
  acquired_at: string | null;
  expires_at: string | null;
}
