import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { ObservationQueries } from '../../src/database/observation-queries.js';
import { OBSERVATIONS_SCHEMA } from '../../src/database/observations-db.js';
import type { MemoryType, ObservationInput } from '../../src/types/types.js';
import config from '../../src/config/config.js';

/**
 * T27: the mutating operator endpoints (operator-config PATCH, dream
 * trigger/resolve, rollback, admin promote) are admin-key gated when the
 * developer's .env sets ADMIN_API_KEY (config loads it at import time). Tests
 * send the key exactly like real clients do; with no key configured this is an
 * empty header set and the routes are open.
 */
export function adminHeaders(): Record<string, string> {
  return config.server.adminApiKey ? { 'x-api-key': config.server.adminApiKey } : {};
}

export function createTestDatabase(): { db: Database.Database; queries: MemoryQueries } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  return { db, queries };
}

/**
 * Create an in-memory observations database for testing.
 * Round-2 fix A9: built from the EXPORTED production schema
 * (OBSERVATIONS_SCHEMA in src/database/observations-db.ts) — the previous
 * hand-copied DDL was an acknowledged drift hazard.
 */
export function createTestObservationsDb(): { db: Database.Database; obsQueries: ObservationQueries } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(OBSERVATIONS_SCHEMA);
  const obsQueries = new ObservationQueries(db);
  return { db, obsQueries };
}

export function createTestMemory(overrides: Partial<{
  content: string;
  type: MemoryType;
  scope: string;
  tags: string[];
  metadata: string;
  created_by: string | null;
  confidence: number;
  discovery_run_id: number;
}> = {}) {
  return {
    content: overrides.content ?? 'Test memory content for unit testing',
    type: overrides.type ?? 'reference' as const,
    scope: overrides.scope ?? 'global',
    source: null,
    source_path: null,
    metadata: overrides.metadata ?? '{}',
    embedding: null,
    embedding_model: 'test-model',
    created_by: overrides.created_by ?? null,
    tags: overrides.tags ?? [],
    confidence: overrides.confidence,
    discovery_run_id: overrides.discovery_run_id,
  };
}

export function createTestObservation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    session_id: overrides.session_id ?? 'test-session-1',
    project_scope: overrides.project_scope ?? 'project:test',
    tool_name: overrides.tool_name ?? 'Bash',
    input_summary: overrides.input_summary ?? 'npm test',
    output_summary: overrides.output_summary,
    event_type: overrides.event_type,
    idempotency_key: overrides.idempotency_key,
    metadata: overrides.metadata,
  };
}
