import Database from 'better-sqlite3';
import logger from '../utils/logger.js';

interface Migration {
  version: number;
  description: string;
  up: string[];
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema — memories, tags, access log, FTS5',
    up: [
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now')),
        description TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        content_hash TEXT,
        summary TEXT,
        type TEXT NOT NULL DEFAULT 'reference'
          CHECK(type IN ('user','feedback','project','reference')),
        scope TEXT NOT NULL DEFAULT 'global'
          CHECK(scope = 'global' OR scope LIKE 'project:%' OR scope LIKE 'client:%'),
        source TEXT,
        source_path TEXT,
        metadata TEXT DEFAULT '{}',
        embedding BLOB,
        embedding_model TEXT DEFAULT 'all-MiniLM-L6-v2',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        archived_at TEXT,
        is_archived INTEGER DEFAULT 0 CHECK(is_archived IN (0, 1))
      )`,

      `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(is_archived)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash) WHERE content_hash IS NOT NULL`,

      `CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tag ON memory_tags(tag)`,

      `CREATE TABLE IF NOT EXISTS memory_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        accessed_at TEXT DEFAULT (datetime('now'))
      )`,

      `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, summary,
        content='memories', content_rowid='id'
      )`,

      // FTS5 sync triggers
      `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, summary)
        VALUES (new.id, new.content, new.summary);
      END`,

      `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES ('delete', old.id, old.content, old.summary);
      END`,

      `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, summary ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES ('delete', old.id, old.content, old.summary);
        INSERT INTO memories_fts(rowid, content, summary)
        VALUES (new.id, new.content, new.summary);
      END`,
    ],
  },
  {
    version: 2,
    description: 'Add confidence column and discovery type for auto-discovery pipeline',
    up: [
      // Add confidence column (defaults to 1.0 — existing memories unaffected)
      `ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0`,

      // Add discovery_run_id for traceability of auto-discovered memories
      `ALTER TABLE memories ADD COLUMN discovery_run_id INTEGER`,

      // Remove the old CHECK constraint on type by recreating via a new column approach.
      // SQLite cannot ALTER CHECK constraints, so we enforce type validation in the
      // application layer (Zod) instead. The existing CHECK still applies to old rows
      // but new 'discovery' type values are allowed because SQLite CHECK on
      // ALTER TABLE ADD COLUMN only applies to that column, not existing CHECKs.
      // The existing CHECK constraint is on the original CREATE TABLE and remains,
      // but we need to handle 'discovery' type. Since SQLite CHECKs are not strictly
      // enforced on ALTER TABLE columns and the type column already exists, we handle
      // this by inserting via a workaround: the CHECK is only enforced on INSERT/UPDATE.
      // We'll create a trigger-based approach or simply rely on application-layer validation.
      //
      // Pragmatic solution: SQLite enforces CHECK constraints, so we need to recreate
      // the table. We do this in a safe migration:

      // Step 1: Create new table with updated CHECK
      `CREATE TABLE IF NOT EXISTS memories_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        content_hash TEXT,
        summary TEXT,
        type TEXT NOT NULL DEFAULT 'reference'
          CHECK(type IN ('user','feedback','project','reference','discovery')),
        scope TEXT NOT NULL DEFAULT 'global'
          CHECK(scope = 'global' OR scope LIKE 'project:%' OR scope LIKE 'client:%'),
        source TEXT,
        source_path TEXT,
        metadata TEXT DEFAULT '{}',
        embedding BLOB,
        embedding_model TEXT DEFAULT 'all-MiniLM-L6-v2',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        archived_at TEXT,
        is_archived INTEGER DEFAULT 0 CHECK(is_archived IN (0, 1)),
        confidence REAL NOT NULL DEFAULT 1.0,
        discovery_run_id INTEGER
      )`,

      // Step 2: Copy data
      `INSERT INTO memories_new (id, content, content_hash, summary, type, scope, source,
        source_path, metadata, embedding, embedding_model, created_by, created_at,
        updated_at, archived_at, is_archived, confidence, discovery_run_id)
       SELECT id, content, content_hash, summary, type, scope, source,
        source_path, metadata, embedding, embedding_model, created_by, created_at,
        updated_at, archived_at, is_archived, 1.0, NULL
       FROM memories`,

      // Step 3: Drop old table
      `DROP TABLE memories`,

      // Step 4: Rename new table
      `ALTER TABLE memories_new RENAME TO memories`,

      // Step 5: Recreate indexes
      `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(is_archived)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash) WHERE content_hash IS NOT NULL`,

      // Step 6: Recreate FTS5 triggers (FTS table itself persists)
      `DROP TRIGGER IF EXISTS memories_ai`,
      `DROP TRIGGER IF EXISTS memories_ad`,
      `DROP TRIGGER IF EXISTS memories_au`,

      `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, summary)
        VALUES (new.id, new.content, new.summary);
      END`,

      `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES ('delete', old.id, old.content, old.summary);
      END`,

      `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, summary ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES ('delete', old.id, old.content, old.summary);
        INSERT INTO memories_fts(rowid, content, summary)
        VALUES (new.id, new.content, new.summary);
      END`,
    ],
  },
  {
    version: 3,
    description: 'Add promotion_runs table for operational tracking of runPromotion() invocations',
    up: [
      `CREATE TABLE IF NOT EXISTS promotion_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running', 'completed', 'failed')),
        dry_run INTEGER NOT NULL DEFAULT 0 CHECK(dry_run IN (0, 1)),
        archive_threshold REAL,
        similarity_threshold REAL,
        decay_computed INTEGER NOT NULL DEFAULT 0,
        decay_avg_score REAL,
        decay_below_threshold INTEGER NOT NULL DEFAULT 0,
        consolidation_candidates INTEGER NOT NULL DEFAULT 0,
        consolidation_duplicates INTEGER NOT NULL DEFAULT 0,
        consolidation_merge_targets INTEGER NOT NULL DEFAULT 0,
        memories_archived INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_promotion_runs_started ON promotion_runs(started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_promotion_runs_status ON promotion_runs(status)`,
    ],
  },
  {
    version: 4,
    description: 'Dreaming layer (D0.1): reinforcement cols + memory_revisions, dreams, dream_audit_log, operator_config, consolidation_lock',
    up: [
      // ── memories: additive reinforcement / temporal / anchor columns ──
      // SQLite ADD COLUMN cannot use datetime('now') as a default, so timestamp
      // columns are nullable and backfilled below; new-row population lands in D1.1.
      `ALTER TABLE memories ADD COLUMN observation_count INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE memories ADD COLUMN first_seen TEXT`,
      `ALTER TABLE memories ADD COLUMN last_seen TEXT`,
      `ALTER TABLE memories ADD COLUMN last_contradicted TEXT`,
      `ALTER TABLE memories ADD COLUMN criticality INTEGER NOT NULL DEFAULT 0 CHECK(criticality IN (0, 1))`,
      `ALTER TABLE memories ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0 CHECK(is_locked IN (0, 1))`,
      `ALTER TABLE memories ADD COLUMN deprecated_at TEXT`,
      `ALTER TABLE memories ADD COLUMN valid_from TEXT`,
      `ALTER TABLE memories ADD COLUMN source_observation_ids TEXT NOT NULL DEFAULT '[]'`,

      // Backfill (documented lossy): seed temporal markers from existing timestamps,
      // observation_count from any captured evidence_count, else 1.
      `UPDATE memories SET first_seen = created_at WHERE first_seen IS NULL`,
      `UPDATE memories SET last_seen = updated_at WHERE last_seen IS NULL`,
      `UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL`,
      `UPDATE memories SET observation_count = COALESCE(CAST(json_extract(metadata, '$.evidence_count') AS INTEGER), 1)`,

      // ── dreams: one row per dream pass (mirrors discovery_runs / promotion_runs) ──
      `CREATE TABLE IF NOT EXISTS dreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id TEXT NOT NULL DEFAULT 'default',
        scope TEXT,
        mode TEXT NOT NULL DEFAULT 'windowed'
          CHECK(mode IN ('windowed', 'whole_corpus')),
        trigger_source TEXT NOT NULL DEFAULT 'scheduled'
          CHECK(trigger_source IN ('scheduled', 'manual')),
        reason TEXT,
        window_key TEXT,
        input_obs_start_id INTEGER,
        input_obs_end_id INTEGER,
        output_diff TEXT,
        acceptance_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(acceptance_status IN ('pending', 'partial', 'accepted', 'rejected', 'auto_applied', 'empty')),
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running', 'completed', 'failed')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        duration_ms INTEGER,
        memories_examined INTEGER NOT NULL DEFAULT 0,
        changes_auto_applied INTEGER NOT NULL DEFAULT 0,
        changes_queued INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )`,
      // Idempotency: one dream per (operator, scope, mode, window). Empty/manual runs
      // with no window_key are exempt (partial index).
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_dreams_window
        ON dreams(operator_id, scope, mode, window_key) WHERE window_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_dreams_started ON dreams(started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_dreams_status ON dreams(status)`,

      // ── memory_revisions: append-only history; memories.id stays stable ──
      `CREATE TABLE IF NOT EXISTS memory_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT,
        summary TEXT,
        embedding BLOB,
        embedding_model TEXT,
        confidence REAL,
        observation_count INTEGER,
        metadata TEXT DEFAULT '{}',
        tags TEXT DEFAULT '[]',
        created_by_dream_id INTEGER REFERENCES dreams(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, revision)`,

      // ── dream_audit_log: append-only record of every applied change ──
      `CREATE TABLE IF NOT EXISTS dream_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dream_id INTEGER NOT NULL REFERENCES dreams(id) ON DELETE CASCADE,
        memory_id INTEGER,
        revision_id INTEGER,
        change_class TEXT NOT NULL
          CHECK(change_class IN ('exact_dup', 'decay', 'merge', 'supersede', 'reinforce')),
        action TEXT,
        applied_automatically INTEGER NOT NULL DEFAULT 0 CHECK(applied_automatically IN (0, 1)),
        before_ref TEXT,
        after_ref TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_dream_audit_dream ON dream_audit_log(dream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_dream_audit_memory ON dream_audit_log(memory_id)`,

      // ── operator_config: single-row knobs (cadence, quiet hours, auto-accept) ──
      `CREATE TABLE IF NOT EXISTS operator_config (
        operator_id TEXT PRIMARY KEY DEFAULT 'default',
        timezone TEXT,
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        idle_minutes INTEGER NOT NULL DEFAULT 15,
        dream_cadence TEXT,
        auto_accept_exact_dup INTEGER NOT NULL DEFAULT 0 CHECK(auto_accept_exact_dup IN (0, 1)),
        auto_accept_decay INTEGER NOT NULL DEFAULT 0 CHECK(auto_accept_decay IN (0, 1)),
        reasoner_provider TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      // Seed the default operator row (auto-accept flags ship OFF).
      `INSERT OR IGNORE INTO operator_config (operator_id) VALUES ('default')`,

      // ── consolidation_lock: single-holder mutex with stale-TTL release ──
      `CREATE TABLE IF NOT EXISTS consolidation_lock (
        operator_id TEXT PRIMARY KEY DEFAULT 'default',
        holder TEXT,
        acquired_at TEXT,
        expires_at TEXT
      )`,
    ],
  },
  {
    version: 5,
    description: 'R2: failed dreams leave the window unique index so a failed window can be retried',
    up: [
      // A failed dream must not collapse its window (R2) — the engine retries it
      // (bounded). The unique constraint therefore only covers live rows: a row
      // leaves the index when its status flips to 'failed', freeing the window
      // for the retry INSERT.
      `DROP INDEX IF EXISTS idx_dreams_window`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_dreams_window
        ON dreams(operator_id, scope, mode, window_key)
        WHERE window_key IS NOT NULL AND status != 'failed'`,
    ],
  },
  {
    version: 6,
    description: "D1.3: extend dream_audit_log change_class CHECK with 'promote_global' (R6 signal) and 'rollback' (revision restores are audited too)",
    up: [
      // SQLite cannot ALTER a CHECK constraint — rebuild the (small, append-only) table.
      `CREATE TABLE IF NOT EXISTS dream_audit_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dream_id INTEGER NOT NULL REFERENCES dreams(id) ON DELETE CASCADE,
        memory_id INTEGER,
        revision_id INTEGER,
        change_class TEXT NOT NULL
          CHECK(change_class IN ('exact_dup', 'decay', 'merge', 'supersede', 'reinforce', 'promote_global', 'rollback')),
        action TEXT,
        applied_automatically INTEGER NOT NULL DEFAULT 0 CHECK(applied_automatically IN (0, 1)),
        before_ref TEXT,
        after_ref TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `INSERT INTO dream_audit_log_new (id, dream_id, memory_id, revision_id, change_class,
        action, applied_automatically, before_ref, after_ref, created_at)
       SELECT id, dream_id, memory_id, revision_id, change_class,
        action, applied_automatically, before_ref, after_ref, created_at
       FROM dream_audit_log`,
      `DROP TABLE dream_audit_log`,
      `ALTER TABLE dream_audit_log_new RENAME TO dream_audit_log`,
      `CREATE INDEX IF NOT EXISTS idx_dream_audit_dream ON dream_audit_log(dream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_dream_audit_memory ON dream_audit_log(memory_id)`,
    ],
  },
  {
    version: 7,
    description: "D2.2: 'conditional' in dream_audit_log change_class CHECK (branch encoding is audited); temporal markers snapshotted in memory_revisions so supersession rolls back ('contested' stays diff-only, never audited)",
    up: [
      // SQLite cannot ALTER a CHECK constraint — rebuild the (small, append-only) table.
      `CREATE TABLE IF NOT EXISTS dream_audit_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dream_id INTEGER NOT NULL REFERENCES dreams(id) ON DELETE CASCADE,
        memory_id INTEGER,
        revision_id INTEGER,
        change_class TEXT NOT NULL
          CHECK(change_class IN ('exact_dup', 'decay', 'merge', 'supersede', 'reinforce', 'promote_global', 'rollback', 'conditional')),
        action TEXT,
        applied_automatically INTEGER NOT NULL DEFAULT 0 CHECK(applied_automatically IN (0, 1)),
        before_ref TEXT,
        after_ref TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `INSERT INTO dream_audit_log_new (id, dream_id, memory_id, revision_id, change_class,
        action, applied_automatically, before_ref, after_ref, created_at)
       SELECT id, dream_id, memory_id, revision_id, change_class,
        action, applied_automatically, before_ref, after_ref, created_at
       FROM dream_audit_log`,
      `DROP TABLE dream_audit_log`,
      `ALTER TABLE dream_audit_log_new RENAME TO dream_audit_log`,
      `CREATE INDEX IF NOT EXISTS idx_dream_audit_dream ON dream_audit_log(dream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_dream_audit_memory ON dream_audit_log(memory_id)`,

      // memory_revisions: snapshot the temporal markers so a supersession (which
      // sets deprecated_at/valid_from on live rows) restores cleanly via rollback.
      `ALTER TABLE memory_revisions ADD COLUMN last_contradicted TEXT`,
      `ALTER TABLE memory_revisions ADD COLUMN deprecated_at TEXT`,
      `ALTER TABLE memory_revisions ADD COLUMN valid_from TEXT`,
    ],
  },
];

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now')),
    description TEXT
  )`);

  const currentVersion = db.prepare(
    'SELECT MAX(version) as version FROM schema_version'
  ).get() as { version: number | null } | undefined;

  const current = currentVersion?.version ?? 0;

  for (const migration of migrations) {
    if (migration.version <= current) continue;

    logger.info(`Applying migration v${migration.version}: ${migration.description}`);

    const runMigration = db.transaction(() => {
      for (const sql of migration.up) {
        db.exec(sql);
      }
      db.prepare(
        'INSERT INTO schema_version (version, description) VALUES (?, ?)'
      ).run(migration.version, migration.description);
    });

    runMigration();
    logger.info(`Migration v${migration.version} applied successfully`);
  }
}
