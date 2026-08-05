import type pg from 'pg';
import logger from '../utils/logger.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash VARCHAR(64),
        summary TEXT,
        type VARCHAR(20) NOT NULL DEFAULT 'project',
        scope VARCHAR(255) NOT NULL DEFAULT 'global',
        source VARCHAR(255),
        source_path TEXT,
        metadata JSONB DEFAULT '{}',
        embedding vector(384),
        embedding_model VARCHAR(100) DEFAULT '',
        created_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        archived_at TIMESTAMPTZ,
        is_archived BOOLEAN DEFAULT false,
        search_vector tsvector GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, ''))
        ) STORED
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash
        ON memories (content_hash) WHERE content_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (type);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope);
      CREATE INDEX IF NOT EXISTS idx_memories_is_archived ON memories (is_archived);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING gin (search_vector);

      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        tag VARCHAR(100) NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags (tag);

      CREATE TABLE IF NOT EXISTS memory_access_log (
        id SERIAL PRIMARY KEY,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        accessed_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_access_log_memory_id ON memory_access_log (memory_id);
    `,
  },
  {
    version: 2,
    name: 'hnsw_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_memories_embedding
        ON memories USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    `,
  },
  {
    version: 3,
    name: 'auto_discovery',
    sql: `
      -- Add confidence and discovery tracking to memories
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS discovery_run_id INTEGER;

      -- Update type constraint to include 'discovery'
      ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
      ALTER TABLE memories ADD CONSTRAINT memories_type_check
        CHECK (type IN ('user', 'feedback', 'project', 'reference', 'discovery'));

      -- Observations table (single-row-per-invocation)
      CREATE TABLE IF NOT EXISTS observations (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key TEXT,
        session_id TEXT NOT NULL,
        project_scope TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_summary TEXT,
        output_summary TEXT,
        status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started', 'completed', 'failed')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        metadata JSONB DEFAULT '{}',
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_idempotency
        ON observations(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_obs_project_created
        ON observations(project_scope, created_at);
      CREATE INDEX IF NOT EXISTS idx_obs_session_id
        ON observations(session_id, id);

      -- Discovery runs tracking
      CREATE TABLE IF NOT EXISTS discovery_runs (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        project_scope TEXT NOT NULL,
        observation_start_id BIGINT,
        observation_end_id BIGINT,
        observations_analyzed INTEGER NOT NULL DEFAULT 0,
        patterns_found INTEGER NOT NULL DEFAULT 0,
        memories_created INTEGER NOT NULL DEFAULT 0,
        memories_reinforced INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running', 'completing', 'completed', 'failed')),
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_project_status
        ON discovery_runs(project_scope, status);
    `,
  },
  {
    version: 4,
    name: 'promotion_runs',
    sql: `
      CREATE TABLE IF NOT EXISTS promotion_runs (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running', 'completed', 'failed')),
        dry_run BOOLEAN NOT NULL DEFAULT false,
        archive_threshold DOUBLE PRECISION,
        similarity_threshold DOUBLE PRECISION,
        decay_computed INTEGER NOT NULL DEFAULT 0,
        decay_avg_score DOUBLE PRECISION,
        decay_below_threshold INTEGER NOT NULL DEFAULT 0,
        consolidation_candidates INTEGER NOT NULL DEFAULT 0,
        consolidation_duplicates INTEGER NOT NULL DEFAULT 0,
        consolidation_merge_targets INTEGER NOT NULL DEFAULT 0,
        memories_archived INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_promotion_runs_started
        ON promotion_runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_promotion_runs_status
        ON promotion_runs(status);
    `,
  },
  {
    version: 5,
    name: 'sqlite_schema_parity',
    sql: `
      ALTER TABLE memories ALTER COLUMN type SET DEFAULT 'reference';
      ALTER TABLE memories ALTER COLUMN embedding_model SET DEFAULT 'all-MiniLM-L6-v2';

      DROP INDEX IF EXISTS idx_memories_content_hash;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash
        ON memories (content_hash) WHERE content_hash IS NOT NULL;
    `,
  },
  {
    version: 6,
    name: 'dreaming_layer',
    sql: `
      -- ── memories: additive reinforcement / temporal / anchor columns ──
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_contradicted TIMESTAMPTZ;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS criticality BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_observation_ids JSONB NOT NULL DEFAULT '[]';

      -- Backfill (documented lossy): seed temporal markers from existing timestamps;
      -- observation_count from any captured evidence_count (guarded against non-numeric), else 1.
      UPDATE memories SET first_seen = created_at WHERE first_seen IS NULL;
      UPDATE memories SET last_seen = updated_at WHERE last_seen IS NULL;
      UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
      UPDATE memories SET observation_count = CASE
        WHEN metadata->>'evidence_count' ~ '^[0-9]+$' THEN (metadata->>'evidence_count')::INTEGER
        ELSE 1 END;

      -- ── dreams: one row per dream pass (mirrors discovery_runs / promotion_runs) ──
      CREATE TABLE IF NOT EXISTS dreams (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        operator_id TEXT NOT NULL DEFAULT 'default',
        scope TEXT,
        mode TEXT NOT NULL DEFAULT 'windowed'
          CHECK(mode IN ('windowed', 'whole_corpus')),
        trigger_source TEXT NOT NULL DEFAULT 'scheduled'
          CHECK(trigger_source IN ('scheduled', 'manual')),
        reason TEXT,
        window_key TEXT,
        input_obs_start_id BIGINT,
        input_obs_end_id BIGINT,
        output_diff JSONB,
        acceptance_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(acceptance_status IN ('pending', 'partial', 'accepted', 'rejected', 'auto_applied', 'empty')),
        status TEXT NOT NULL DEFAULT 'running'
          CHECK(status IN ('running', 'completed', 'failed')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        memories_examined INTEGER NOT NULL DEFAULT 0,
        changes_auto_applied INTEGER NOT NULL DEFAULT 0,
        changes_queued INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dreams_window
        ON dreams(operator_id, scope, mode, window_key) WHERE window_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_dreams_started ON dreams(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dreams_status ON dreams(status);

      -- ── memory_revisions: append-only history; memories.id stays stable ──
      CREATE TABLE IF NOT EXISTS memory_revisions (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash VARCHAR(64),
        summary TEXT,
        embedding vector(384),
        embedding_model VARCHAR(100),
        confidence DOUBLE PRECISION,
        observation_count INTEGER,
        metadata JSONB DEFAULT '{}',
        tags JSONB DEFAULT '[]',
        created_by_dream_id BIGINT REFERENCES dreams(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, revision);

      -- ── dream_audit_log: append-only record of every applied change ──
      CREATE TABLE IF NOT EXISTS dream_audit_log (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        dream_id BIGINT NOT NULL REFERENCES dreams(id) ON DELETE CASCADE,
        memory_id INTEGER,
        revision_id BIGINT,
        change_class TEXT NOT NULL
          CHECK(change_class IN ('exact_dup', 'decay', 'merge', 'supersede', 'reinforce')),
        action TEXT,
        applied_automatically BOOLEAN NOT NULL DEFAULT false,
        before_ref TEXT,
        after_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dream_audit_dream ON dream_audit_log(dream_id);
      CREATE INDEX IF NOT EXISTS idx_dream_audit_memory ON dream_audit_log(memory_id);

      -- ── operator_config: single-row knobs (cadence, quiet hours, auto-accept) ──
      CREATE TABLE IF NOT EXISTS operator_config (
        operator_id TEXT PRIMARY KEY DEFAULT 'default',
        timezone TEXT,
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        idle_minutes INTEGER NOT NULL DEFAULT 15,
        dream_cadence TEXT,
        auto_accept_exact_dup BOOLEAN NOT NULL DEFAULT false,
        auto_accept_decay BOOLEAN NOT NULL DEFAULT false,
        reasoner_provider TEXT,
        config JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO operator_config (operator_id) VALUES ('default')
        ON CONFLICT (operator_id) DO NOTHING;

      -- ── consolidation_lock: single-holder mutex with stale-TTL release ──
      CREATE TABLE IF NOT EXISTS consolidation_lock (
        operator_id TEXT PRIMARY KEY DEFAULT 'default',
        holder TEXT,
        acquired_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ
      );
    `,
  },
  {
    version: 7,
    name: 'dream_window_retry',
    sql: `
      -- R2: a failed dream must not collapse its window — the engine retries it
      -- (bounded). The unique constraint therefore only covers live rows: a row
      -- leaves the index when its status flips to 'failed', freeing the window
      -- for the retry INSERT.
      DROP INDEX IF EXISTS idx_dreams_window;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dreams_window
        ON dreams(operator_id, scope, mode, window_key)
        WHERE window_key IS NOT NULL AND status != 'failed';
    `,
  },
  {
    version: 8,
    name: 'dream_audit_promote_rollback',
    sql: `
      -- D1.3: extend the change_class CHECK with 'promote_global' (R6 diff-only
      -- signal) and 'rollback' (revision restores are audited too). The inline
      -- column CHECK from v6 carries Postgres's auto-generated name.
      ALTER TABLE dream_audit_log DROP CONSTRAINT IF EXISTS dream_audit_log_change_class_check;
      ALTER TABLE dream_audit_log ADD CONSTRAINT dream_audit_log_change_class_check
        CHECK(change_class IN ('exact_dup', 'decay', 'merge', 'supersede', 'reinforce', 'promote_global', 'rollback'));
    `,
  },
  {
    version: 9,
    name: 'dream_audit_conditional_revision_temporal',
    sql: `
      -- D2.2: 'conditional' joins the audited change classes (branch encoding
      -- mutates the originals: last_contradicted + durability reset). 'contested'
      -- is deliberately absent — it is diff-only and never reaches the audit log.
      ALTER TABLE dream_audit_log DROP CONSTRAINT IF EXISTS dream_audit_log_change_class_check;
      ALTER TABLE dream_audit_log ADD CONSTRAINT dream_audit_log_change_class_check
        CHECK(change_class IN ('exact_dup', 'decay', 'merge', 'supersede', 'reinforce', 'promote_global', 'rollback', 'conditional'));

      -- memory_revisions: snapshot the temporal markers so a supersession (which
      -- sets deprecated_at/valid_from on live rows) restores cleanly via rollback.
      ALTER TABLE memory_revisions ADD COLUMN IF NOT EXISTS last_contradicted TIMESTAMPTZ;
      ALTER TABLE memory_revisions ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;
      ALTER TABLE memory_revisions ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
    `,
  },
];

export async function runPgMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Create schema_version table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get current version
    const result = await client.query(
      'SELECT COALESCE(MAX(version), 0) as current_version FROM schema_version'
    );
    const currentVersion = parseInt(result.rows[0].current_version, 10);
    logger.info(`PostgreSQL schema version: ${currentVersion}`);

    // Apply pending migrations
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;

      logger.info(`Applying migration ${migration.version}: ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_version (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );
        await client.query('COMMIT');
        logger.info(`Migration ${migration.version} applied successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Migration ${migration.version} failed:`, err);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
