/**
 * Verify SQLite -> PostgreSQL migration row counts.
 *
 * Usage: npm run migrate:verify
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import config from '../src/config/config.js';

const { Pool } = pg;

interface CountCheck {
  table: string;
  sqlite: number;
  postgres: number;
  pass: boolean;
}

function sqliteCount(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

async function postgresCount(pool: pg.Pool, table: string): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
  return parseInt(result.rows[0].count, 10);
}

function printChecks(checks: CountCheck[]): void {
  const tableWidth = Math.max('table'.length, ...checks.map(c => c.table.length));
  const sqliteWidth = Math.max('sqlite'.length, ...checks.map(c => String(c.sqlite).length));
  const postgresWidth = Math.max('postgres'.length, ...checks.map(c => String(c.postgres).length));

  console.log([
    'table'.padEnd(tableWidth),
    'sqlite'.padStart(sqliteWidth),
    'postgres'.padStart(postgresWidth),
    'status',
  ].join('  '));
  console.log([
    '-'.repeat(tableWidth),
    '-'.repeat(sqliteWidth),
    '-'.repeat(postgresWidth),
    '------',
  ].join('  '));

  for (const check of checks) {
    console.log([
      check.table.padEnd(tableWidth),
      String(check.sqlite).padStart(sqliteWidth),
      String(check.postgres).padStart(postgresWidth),
      check.pass ? 'PASS' : 'FAIL',
    ].join('  '));
  }
}

async function main(): Promise<void> {
  if (!config.database.postgresUrl) {
    console.error('ERROR: POSTGRES_URL environment variable is required');
    process.exit(1);
  }

  const sqlite = new Database(config.database.path, { readonly: true });
  const pool = new Pool({ connectionString: config.database.postgresUrl });
  const tables = ['memories', 'memory_tags', 'promotion_runs'];

  try {
    const checks: CountCheck[] = [];
    for (const table of tables) {
      const sqliteRows = sqliteCount(sqlite, table);
      const postgresRows = await postgresCount(pool, table);
      checks.push({
        table,
        sqlite: sqliteRows,
        postgres: postgresRows,
        pass: sqliteRows === postgresRows,
      });
    }

    printChecks(checks);

    if (checks.some(c => !c.pass)) process.exitCode = 1;
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration verification failed:', err);
  process.exit(1);
});
