import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { runMigrations } from './migrations.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  const dbDir = path.dirname(config.database.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.database.path);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // Startup WAL checkpoint
  db.pragma('wal_checkpoint(TRUNCATE)');

  logger.info(`Database opened: ${config.database.path}`);

  // Run migrations
  runMigrations(db);

  // Log diagnostics
  const stats = getDatabaseStats(db);
  logger.info(`Database stats: ${stats.total_memories} memories, ${stats.db_size_bytes} bytes`);

  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    logger.info('Database closed');
  } catch (error) {
    logger.error('Error closing database:', error);
  }
  db = null;
}

export function getDatabaseStats(database?: Database.Database): {
  total_memories: number;
  active_memories: number;
  archived_memories: number;
  db_size_bytes: number;
  wal_size_bytes: number;
} {
  const d = database || db;
  if (!d) {
    return { total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 };
  }

  const total = (d.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
  const active = (d.prepare('SELECT COUNT(*) as count FROM memories WHERE is_archived = 0').get() as { count: number }).count;
  const archived = total - active;

  let dbSize = 0;
  let walSize = 0;
  try {
    const dbStat = fs.statSync(config.database.path);
    dbSize = dbStat.size;
    const walPath = config.database.path + '-wal';
    if (fs.existsSync(walPath)) {
      walSize = fs.statSync(walPath).size;
    }
  } catch {
    // Ignore stat errors
  }

  return {
    total_memories: total,
    active_memories: active,
    archived_memories: archived,
    db_size_bytes: dbSize,
    wal_size_bytes: walSize,
  };
}

export async function backupDatabase(): Promise<string> {
  if (!db) throw new Error('Database not initialized');

  // better-sqlite3's backup() is the one async API — it must be awaited before
  // the timestamped file exists. Ensure the target dir exists first (the
  // .env.example default ./data/backups is not created by normal DB init); an
  // unawaited rejection here would be an unhandledRejection that can crash Node.
  fs.mkdirSync(config.database.backupPath, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `memory-backup-${timestamp}.db`;
  const backupPath = path.join(config.database.backupPath, backupName);
  const latestPath = path.join(config.database.backupPath, 'memory-backup-latest.db');

  await db.backup(backupPath);
  // Also copy to latest
  fs.copyFileSync(backupPath, latestPath);

  logger.info(`Database backed up to ${backupPath}`);
  return backupPath;
}
