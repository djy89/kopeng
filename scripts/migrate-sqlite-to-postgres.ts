/**
 * Migration script: SQLite -> PostgreSQL
 *
 * Reads all memories and tags from the SQLite database and inserts them
 * into PostgreSQL, preserving IDs. Requires both DATABASE_PATH (SQLite)
 * and POSTGRES_URL to be set in .env.
 *
 * Usage: npm run migrate:postgres
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPgMigrations } from '../src/database/pg-migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../');
dotenv.config({ path: path.join(projectRoot, '.env') });

const { Pool } = pg;

// Schema parity audit notes:
// - memory.db tables migrated here: memories, memory_tags, memory_access_log, promotion_runs.
// - observations.db tables are intentionally out of scope for this memory-store cutover.
//   That includes observations, discovery_runs, and imported_sessions. discovery_run_id is
//   preserved on memories, but the current SQLite and Postgres DDL do not enforce it as an FK.
// - SQLite FTS5 tables/triggers are not copied; Postgres derives search_vector and indexes it
//   with GIN. Embeddings are converted from raw float32 BLOBs to pgvector vector(384) text.
// - Postgres uses a HNSW index for embedding search; SQLite uses in-process vector search.

interface SqliteMemory {
  id: number;
  content: string;
  content_hash: string | null;
  summary: string | null;
  type: string;
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
}

interface SqliteTag {
  memory_id: number;
  tag: string;
}

interface SqliteAccessLog {
  id: number;
  memory_id: number;
  accessed_at: string;
}

interface SqlitePromotionRun {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  dry_run: number;
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

function embeddingBufferToVector(buf: Buffer): string {
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`Invalid embedding byte length ${buf.byteLength}; expected a float32 buffer`);
  }
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (arr.length !== 384) {
    throw new Error(`Invalid embedding dimension ${arr.length}; expected 384`);
  }
  return `[${Array.from(arr).join(',')}]`;
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName);
  return row !== undefined;
}

async function main() {
  const sqlitePath = process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'memory.db');
  const postgresUrl = process.env.POSTGRES_URL;

  if (!postgresUrl) {
    console.error('ERROR: POSTGRES_URL environment variable is required');
    process.exit(1);
  }

  console.log(`Source: SQLite at ${sqlitePath}`);
  console.log(`Target: PostgreSQL at ${postgresUrl.replace(/:[^:@]*@/, ':***@')}`);

  // Open SQLite
  const sqlite = new Database(sqlitePath, { readonly: true });
  const memories = sqlite.prepare('SELECT * FROM memories ORDER BY id').all() as SqliteMemory[];
  const tags = sqlite.prepare('SELECT * FROM memory_tags ORDER BY memory_id').all() as SqliteTag[];
  const accessLogs = sqlite.prepare('SELECT * FROM memory_access_log ORDER BY id').all() as SqliteAccessLog[];
  const promotionRuns = tableExists(sqlite, 'promotion_runs')
    ? sqlite.prepare('SELECT * FROM promotion_runs ORDER BY id').all() as SqlitePromotionRun[]
    : [];

  console.log(
    `Found ${memories.length} memories, ${tags.length} tags, ` +
    `${accessLogs.length} access log rows, and ${promotionRuns.length} promotion runs in SQLite`
  );
  console.log('Scope: migrates memory.db tables only. observations.db tables are not migrated by this script.');
  console.log('Schema audit notes:');
  console.log('- Postgres uses generated tsvector + GIN instead of SQLite FTS5 virtual tables/triggers.');
  console.log('- Postgres uses HNSW pgvector indexing; SQLite stores raw float32 embedding blobs.');
  console.log('- discovery_run_id is preserved as a nullable value; neither current SQLite nor Postgres DDL enforces it as an FK.');

  if (memories.length === 0) {
    console.log('Nothing to migrate.');
    sqlite.close();
    return;
  }

  // Connect to PostgreSQL
  const pool = new Pool({ connectionString: postgresUrl });
  await runPgMigrations(pool);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;

    for (const mem of memories) {
      // Check if already exists (idempotent migration)
      const existing = await client.query('SELECT id FROM memories WHERE id = $1', [mem.id]);
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      const embeddingValue = mem.embedding
        ? embeddingBufferToVector(mem.embedding)
        : null;

      // Insert with explicit ID (requires setting the sequence after)
      await client.query(
        `INSERT INTO memories (id, content, content_hash, summary, type, scope, source, source_path, metadata, embedding, embedding_model, created_by, created_at, updated_at, archived_at, is_archived, confidence, discovery_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (id) DO NOTHING`,
        [
          mem.id,
          mem.content,
          mem.content_hash,
          mem.summary,
          mem.type,
          mem.scope,
          mem.source,
          mem.source_path,
          mem.metadata,
          embeddingValue,
          mem.embedding_model,
          mem.created_by,
          mem.created_at,
          mem.updated_at,
          mem.archived_at,
          mem.is_archived === 1,
          mem.confidence ?? 1.0,
          mem.discovery_run_id ?? null,
        ]
      );

      inserted++;
    }

    for (const t of tags) {
      await client.query(
        'INSERT INTO memory_tags (memory_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [t.memory_id, t.tag]
      );
    }

    for (const log of accessLogs) {
      await client.query(
        `INSERT INTO memory_access_log (id, memory_id, accessed_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [log.id, log.memory_id, log.accessed_at]
      );
    }

    for (const run of promotionRuns) {
      await client.query(
        `INSERT INTO promotion_runs (
           id, started_at, completed_at, status, dry_run, archive_threshold,
           similarity_threshold, decay_computed, decay_avg_score,
           decay_below_threshold, consolidation_candidates,
           consolidation_duplicates, consolidation_merge_targets,
           memories_archived, duration_ms, error
         )
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO NOTHING`,
        [
          run.id,
          run.started_at,
          run.completed_at,
          run.status,
          run.dry_run === 1,
          run.archive_threshold,
          run.similarity_threshold,
          run.decay_computed,
          run.decay_avg_score,
          run.decay_below_threshold,
          run.consolidation_candidates,
          run.consolidation_duplicates,
          run.consolidation_merge_targets,
          run.memories_archived,
          run.duration_ms,
          run.error,
        ]
      );
    }

    // Reset the sequence to max(id) + 1 so new inserts get correct IDs
    await client.query(
      "SELECT setval('memories_id_seq', COALESCE((SELECT MAX(id) FROM memories), 1), (SELECT COUNT(*) > 0 FROM memories))"
    );
    await client.query(
      "SELECT setval('memory_access_log_id_seq', COALESCE((SELECT MAX(id) FROM memory_access_log), 1), (SELECT COUNT(*) > 0 FROM memory_access_log))"
    );
    await client.query(
      "SELECT setval('promotion_runs_id_seq', COALESCE((SELECT MAX(id) FROM promotion_runs), 1), (SELECT COUNT(*) > 0 FROM promotion_runs))"
    );

    await client.query('COMMIT');

    // Verify counts
    const pgCount = await client.query('SELECT COUNT(*) as count FROM memories');
    const pgTagCount = await client.query('SELECT COUNT(*) as count FROM memory_tags');
    const pgAccessLogCount = await client.query('SELECT COUNT(*) as count FROM memory_access_log');
    const pgPromotionRunCount = await client.query('SELECT COUNT(*) as count FROM promotion_runs');

    console.log('\n--- Migration Results ---');
    console.log(`Inserted: ${inserted}`);
    console.log(`Skipped (already existed): ${skipped}`);
    console.log(`SQLite memories: ${memories.length}`);
    console.log(`PostgreSQL memories: ${pgCount.rows[0].count}`);
    console.log(`SQLite tags: ${tags.length}`);
    console.log(`PostgreSQL tags: ${pgTagCount.rows[0].count}`);
    console.log(`SQLite access log rows: ${accessLogs.length}`);
    console.log(`PostgreSQL access log rows: ${pgAccessLogCount.rows[0].count}`);
    console.log(`SQLite promotion runs: ${promotionRuns.length}`);
    console.log(`PostgreSQL promotion runs: ${pgPromotionRunCount.rows[0].count}`);

    const pgTotal = parseInt(pgCount.rows[0].count, 10);
    if (pgTotal === memories.length) {
      console.log('\nMigration completed successfully — counts match.');
    } else {
      console.warn(`\nWARNING: Count mismatch! SQLite=${memories.length}, PostgreSQL=${pgTotal}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
