/**
 * Reports rows where `is_archived` and `archived_at` disagree, and emits the
 * reviewed SQL to fix them. READ-ONLY — it never writes to any database.
 *
 * There is no API endpoint that sets `archived_at` independently of
 * `is_archived`, so this cannot be an audited API-driven migration like
 * migrate-scope-aliases. It is a pure data-consistency fix with no content
 * change, so the correct shape is: this script reports, the operator reviews,
 * the operator runs the SQL inside the container. Copy-first discipline still
 * applies — run the emitted SQL against a copy before live.
 *
 * Usage:
 *   npx tsx scripts/ops/reconcile-archived-columns.ts                 # live Postgres, read-only
 *   npx tsx scripts/ops/reconcile-archived-columns.ts --db <file>     # a SQLite COPY
 *
 * Postgres connection: reads POSTGRES_URL from .env (same var src/config/config.ts
 * uses); set DATABASE_URL to override, e.g. to point at a copy instead of live.
 * Env: KOPENG_PG_CONTAINER names the docker container substituted into the
 * printed `docker exec` line; unset prints the placeholder `<postgres-container>`.
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import pg from 'pg';

interface Divergence { kind: string; count: number; sample_ids: number[] }

const REPORT_SQL = `
  SELECT CASE
           WHEN is_archived = FALSE AND archived_at IS NOT NULL THEN 'active_with_stale_stamp'
           ELSE 'archived_without_stamp'
         END AS kind,
         COUNT(*)::int AS count,
         (ARRAY_AGG(id ORDER BY id))[1:5] AS sample_ids
  FROM memories
  WHERE (is_archived = FALSE AND archived_at IS NOT NULL)
     OR (is_archived = TRUE AND archived_at IS NULL)
  GROUP BY 1
`;

const REPORT_SQL_SQLITE = `
  SELECT CASE
           WHEN is_archived = 0 AND archived_at IS NOT NULL THEN 'active_with_stale_stamp'
           ELSE 'archived_without_stamp'
         END AS kind,
         COUNT(*) AS count,
         GROUP_CONCAT(id) AS ids
  FROM memories
  WHERE (is_archived = 0 AND archived_at IS NOT NULL)
     OR (is_archived = 1 AND archived_at IS NULL)
  GROUP BY 1
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Derives the psql target for the printed SQL from the runtime connection
 * string / env, never from a hard-coded name — the tracked source is public
 * and must carry no deployment-specific names.
 */
/**
 * Only shell-inert identifier characters may reach the printed command; an
 * env-derived value carrying anything else (spaces, quotes, `$`, backticks…)
 * falls back to the placeholder. The script never executes the line itself,
 * but the operator copy-pastes it — it must not be able to smuggle shell
 * metacharacters out of a connection string.
 */
function shellSafe(value: string | undefined, placeholder: string): string {
  return value && /^[A-Za-z0-9_.-]+$/.test(value) ? value : placeholder;
}

function psqlTarget(): { container: string; user: string; database: string } {
  const conn = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  let user: string | undefined;
  let database: string | undefined;
  if (conn) {
    try {
      const url = new URL(conn);
      user = url.username || undefined;
      database = url.pathname.slice(1) || undefined;
    } catch {
      // unparsable connection string — fall through to placeholders
    }
  }
  return {
    container: shellSafe(process.env.KOPENG_PG_CONTAINER, '<postgres-container>'),
    user: shellSafe(user, '<user>'),
    database: shellSafe(database, '<database>'),
  };
}

async function fromSqlite(file: string): Promise<Divergence[]> {
  if (/(^|[\\/])(memory|observations)\.db$/.test(file)) {
    throw new Error(`refusing to open a live database by name: ${file} — use a copy`);
  }
  const db = new Database(file, { readonly: true });
  const rows = db.prepare(REPORT_SQL_SQLITE).all() as { kind: string; count: number; ids: string }[];
  db.close();
  return rows.map(r => ({
    kind: r.kind,
    count: r.count,
    sample_ids: r.ids.split(',').slice(0, 5).map(Number),
  }));
}

async function fromPostgres(): Promise<Divergence[]> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.POSTGRES_URL });
  try {
    const { rows } = await pool.query<Divergence>(REPORT_SQL);
    return rows;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const file = arg('--db');
  const rows = file ? await fromSqlite(file) : await fromPostgres();

  if (rows.length === 0) {
    console.log('reconcile-archived-columns: no divergence — is_archived and archived_at agree on every row.');
    return;
  }

  console.log('reconcile-archived-columns (READ-ONLY report)\n');
  for (const r of rows) {
    console.log(`  ${r.kind}: ${r.count} row(s) — sample ids ${r.sample_ids.join(', ')}`);
  }

  const { container, user, database } = psqlTarget();
  console.log('\nReviewed SQL — run against a COPY first, then live inside the container:');
  console.log(`  docker exec -i ${container} psql -U ${user} -d ${database} <<'SQL'`);
  console.log('  BEGIN;');
  console.log('  -- Active rows carrying a stale archive stamp: is_archived is the definition,');
  console.log('  -- so the stamp is the wrong half. No content, confidence or scope changes.');
  console.log('  UPDATE memories SET archived_at = NULL WHERE is_archived = FALSE AND archived_at IS NOT NULL;');
  console.log('  -- Defensive, currently a no-op: verified 2026-08-17 that ZERO archived rows');
  console.log('  -- lack a stamp (58 / 6998 / 473 across the three states). Back-fills from');
  console.log('  -- updated_at, the closest available evidence of when the archive happened.');
  console.log('  UPDATE memories SET archived_at = updated_at WHERE is_archived = TRUE AND archived_at IS NULL;');
  console.log('  COMMIT;');
  console.log('  SQL');
  console.log('\nRe-run this script afterwards; it must report no divergence.');
}

main().catch(err => {
  console.error(`reconcile-archived-columns failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
