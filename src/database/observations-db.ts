import Database from 'better-sqlite3';
import path from 'path';
import logger from '../utils/logger.js';

let observationsDb: Database.Database | null = null;

const OBSERVATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT,
    session_id TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_summary TEXT,
    output_summary TEXT,
    status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started', 'completed', 'failed')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    duration_ms INTEGER,
    metadata TEXT DEFAULT '{}',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(length(input_summary) <= 5120),
    CHECK(length(output_summary) <= 5120),
    CHECK(length(metadata) <= 10240)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_idempotency
    ON observations(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_obs_project_created
    ON observations(project_scope, created_at);
  CREATE INDEX IF NOT EXISTS idx_obs_session_id
    ON observations(session_id, id);

  CREATE TABLE IF NOT EXISTS discovery_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_scope TEXT NOT NULL,
    observation_start_id INTEGER,
    observation_end_id INTEGER,
    observations_analyzed INTEGER NOT NULL DEFAULT 0,
    patterns_found INTEGER NOT NULL DEFAULT 0,
    memories_created INTEGER NOT NULL DEFAULT 0,
    memories_reinforced INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running', 'completing', 'completed', 'failed')),
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_discovery_project_status
    ON discovery_runs(project_scope, status);

  CREATE TABLE IF NOT EXISTS imported_sessions (
    source_file TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    observation_count INTEGER NOT NULL DEFAULT 0,
    project_scope TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_imported_sessions_project
    ON imported_sessions(project_scope);
  CREATE INDEX IF NOT EXISTS idx_imported_sessions_session
    ON imported_sessions(session_id);
`;

/**
 * Initialize the observations database (separate file from memory.db).
 * This isolates ephemeral observation data from permanent memory storage,
 * providing independent WAL, VACUUM, and no lock contention.
 */
export function getObservationsDatabase(memoryDbPath: string): Database.Database {
  if (observationsDb) return observationsDb;

  const dbDir = path.dirname(memoryDbPath);
  const obsDbPath = path.join(dbDir, 'observations.db');

  logger.info(`Initializing observations database at ${obsDbPath}`);

  observationsDb = new Database(obsDbPath);

  // Configure pragmas for performance
  observationsDb.pragma('journal_mode = WAL');
  observationsDb.pragma('busy_timeout = 5000');
  observationsDb.pragma('auto_vacuum = INCREMENTAL');
  observationsDb.pragma('synchronous = NORMAL');

  // Apply schema (idempotent — all statements use IF NOT EXISTS)
  observationsDb.exec(OBSERVATIONS_SCHEMA);

  logger.info('Observations database initialized');
  return observationsDb;
}

/**
 * Close the observations database connection.
 */
export function closeObservationsDatabase(): void {
  if (observationsDb) {
    observationsDb.close();
    observationsDb = null;
    logger.info('Observations database closed');
  }
}

/**
 * Run incremental vacuum on observations database to reclaim space after purge.
 */
export function vacuumObservationsDatabase(pages: number = 100): void {
  if (observationsDb) {
    observationsDb.pragma(`incremental_vacuum(${pages})`);
  }
}
