import pg from 'pg';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import type { IDatabaseLifecycle } from './interfaces.js';
import { runPgMigrations } from './pg-migrations.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.database.postgresUrl,
    max: 20,
    // T9: the dream scheduler reads once per minute; a 30s idle reaper left every
    // tick racing a half-closed socket → recurring "Connection terminated due to
    // connection timeout". Keep idle conns alive past the tick interval and enable
    // TCP keepalive so the server/NAT doesn't silently drop them.
    idleTimeoutMillis: 120000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
  });

  pool.on('error', (err) => {
    logger.error('Unexpected PostgreSQL pool error:', err);
  });

  return pool;
}

const STARTUP_RETRY_DELAY_MS = 5_000;

export async function initPostgres(): Promise<pg.Pool> {
  const p = getPool();
  // Test connection. Retry indefinitely: after an unattended reboot the Docker
  // containers (login-bound Docker Desktop) can come up hours after this
  // service — better to wait in-process than fatally crash-loop under NSSM.
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await p.connect();
      try {
        await client.query('SELECT 1');
        logger.info(`PostgreSQL connection established${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
      } finally {
        client.release();
      }
      break;
    } catch (err) {
      // ~Every 30s, not every attempt — a multi-hour wait shouldn't flood the log.
      if (attempt === 1 || attempt % 6 === 0) {
        logger.warn(`PostgreSQL not reachable (attempt ${attempt}), retrying every ${STARTUP_RETRY_DELAY_MS / 1000}s: ${err instanceof Error ? err.message : err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, STARTUP_RETRY_DELAY_MS));
    }
  }

  // Run migrations
  await runPgMigrations(p);

  return p;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
  logger.info('PostgreSQL pool closed');
}

export function createPgLifecycle(): IDatabaseLifecycle {
  return {
    async initialize() {
      await initPostgres();
    },
    async close() {
      await closePool();
    },
    async getStats() {
      const p = getPool();
      const totalResult = await p.query('SELECT COUNT(*) as count FROM memories');
      const activeResult = await p.query(
        'SELECT COUNT(*) as count FROM memories WHERE is_archived = false'
      );
      const total = parseInt(totalResult.rows[0].count, 10);
      const active = parseInt(activeResult.rows[0].count, 10);

      // Get database size
      const sizeResult = await p.query(
        'SELECT pg_database_size(current_database()) as size'
      );
      const dbSize = parseInt(sizeResult.rows[0].size, 10);

      return {
        total_memories: total,
        active_memories: active,
        archived_memories: total - active,
        db_size_bytes: dbSize,
        wal_size_bytes: 0, // WAL not tracked the same way in PG
      };
    },
    async backup(): Promise<string> {
      // PostgreSQL backups are not performed in-process. Fail loudly (501)
      // rather than return a path the operator might trust as a real backup —
      // use pg_dump or your managed-snapshot tooling. Only the SQLite backend
      // implements the file-level POST /api/admin/backup.
      logger.warn('POST /api/admin/backup called on the PostgreSQL backend — not supported (use pg_dump).');
      const err = new Error(
        'Backup is not supported on the PostgreSQL backend — use pg_dump or a managed snapshot. Only the SQLite backend implements POST /api/admin/backup.'
      ) as Error & { statusCode?: number };
      err.statusCode = 501;
      throw err;
    },
  };
}
