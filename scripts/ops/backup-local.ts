/**
 * Task 6 (S5, CX-2, CX-12) — server-down local SQLite backup + manifest-checked
 * restore verification.
 *
 * Standalone better-sqlite3 script (owns NO src/** code — mirrors the client
 * discipline of the other scripts/ops tools; the src backup path in
 * src/database/database.ts needs a running server, this one needs the server
 * DOWN or at least quiet). Backs up memory.db and, when present, the
 * observations.db beside it.
 *
 * CX-2: every backup writes backup-<stamp>.manifest.json with per-DB active /
 * archived row counts, max id, newest-row content_hash, PRAGMA integrity_check,
 * and the backup file's SHA-256 — so `--verify` proves the restored DB files
 * are the exact snapshots that were backed up, not merely healthy supersets.
 *
 * CX-12: every output file (timestamped backups AND the memory-backup-latest.db
 * refresh) is written to a `.tmp` sibling, integrity-checked, then renamed into
 * place — a crash mid-backup can never leave a torn file under a real name.
 *
 * Usage:
 *   npm run backup                      # backup dataDir → backupDir + manifest
 *   npm run restore:verify              # verify live dataDir against the newest manifest
 *   npm run restore:verify -- --manifest <path>   # verify against a specific manifest
 *
 * Defaults: dataDir = dirname(DATABASE_PATH) (./data), backupDir = BACKUP_PATH
 * (./data/backups). The CLI never touches anything outside those two dirs.
 * DATABASE_TYPE=postgres → this script does not apply; see
 * docs/postgres-maintainer.md (pg_dump owns that path).
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

// ---------------------------------------------------------------------------
// Manifest shapes (the task-6 interface contract)
// ---------------------------------------------------------------------------

export interface DbManifest {
  file: string;
  active_rows: number;
  archived_rows: number;
  max_id: number;
  newest_content_hash: string | null;
  integrity_check: string;
  sha256: string;
}

export interface BackupManifest {
  created_at: string;
  databases: { memory: DbManifest; observations?: DbManifest };
}

const MEMORY_DB = 'memory.db';
const OBSERVATIONS_DB = 'observations.db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function integrityCheck(db: Database.Database): string {
  // First row of PRAGMA integrity_check — 'ok' on a healthy DB, else the
  // first corruption finding.
  const rows = db.pragma('integrity_check') as { integrity_check: string }[];
  return rows[0]?.integrity_check ?? 'no integrity_check result';
}

/** Collect the CX-2 corpus stats for one DB (memory vs observations shape). */
function collectStats(db: Database.Database, file: string): Omit<DbManifest, 'sha256'> {
  if (file === MEMORY_DB) {
    const active = (
      db.prepare('SELECT COUNT(*) AS c FROM memories WHERE is_archived = 0').get() as { c: number }
    ).c;
    const archived = (
      db.prepare('SELECT COUNT(*) AS c FROM memories WHERE is_archived = 1').get() as { c: number }
    ).c;
    const maxId = (
      db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM memories').get() as { m: number }
    ).m;
    const newest = db
      .prepare('SELECT content_hash FROM memories ORDER BY id DESC LIMIT 1')
      .get() as { content_hash: string | null } | undefined;
    return {
      file,
      active_rows: active,
      archived_rows: archived,
      max_id: maxId,
      newest_content_hash: newest?.content_hash ?? null,
      integrity_check: integrityCheck(db),
    };
  }
  // Observations DB: a single COUNT(*) is its row count; there is no archived
  // flag and no content_hash column.
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number }
  ).c;
  const maxId = (
    db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM observations').get() as { m: number }
  ).m;
  return {
    file,
    active_rows: count,
    archived_rows: 0,
    max_id: maxId,
    newest_content_hash: null,
    integrity_check: integrityCheck(db),
  };
}

/** Hash a DB without loading the whole file into memory. */
function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * CX-12 atomic write of one backup file: better-sqlite3 online backup to a
 * `.tmp` sibling (a consistent snapshot under WAL, no sidecars to copy),
 * integrity-check the tmp, then rename into place. On any failure the tmp is
 * removed and the previous file (if any) is untouched.
 */
async function backupAtomically(src: Database.Database, dest: string): Promise<void> {
  const tmpPath = dest + '.tmp';
  try {
    await src.backup(tmpPath);
    const tmpDb = new Database(tmpPath, { readonly: true });
    let result: string;
    try {
      result = integrityCheck(tmpDb);
    } finally {
      tmpDb.close();
    }
    if (result !== 'ok') {
      throw new Error(`integrity_check on ${tmpPath} returned '${result}'`);
    }
    fs.renameSync(tmpPath, dest);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

function defaultStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ---------------------------------------------------------------------------
// runBackup
// ---------------------------------------------------------------------------

export async function runBackup(opts: {
  dataDir: string;
  backupDir: string;
  stamp?: string;
}): Promise<{ manifestPath: string; manifest: BackupManifest; files: string[] }> {
  const { dataDir, backupDir } = opts;
  const stamp = opts.stamp ?? defaultStamp();

  const memoryPath = path.join(dataDir, MEMORY_DB);
  if (!fs.existsSync(memoryPath)) {
    throw new Error(`${MEMORY_DB} not found in ${dataDir} — nothing to back up`);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const files: string[] = [];

  const backupOne = async (file: string): Promise<DbManifest> => {
    const srcPath = path.join(dataDir, file);
    // readonly: the live corpus is only ever READ here — sqlite3_backup works
    // from a read-only source, and a rw handle could create/checkpoint WAL
    // sidecars on the live DB (team-review fix; the drill test covers this path).
    const db = new Database(srcPath, { readonly: true, fileMustExist: true });
    try {
      const stats = collectStats(db, file);
      if (stats.integrity_check !== 'ok') {
        throw new Error(
          `refusing to back up ${srcPath}: integrity_check returned '${stats.integrity_check}'`
        );
      }

      const base = path.basename(file, '.db');
      const stampedDest = path.join(backupDir, `${base}-backup-${stamp}.db`);
      await backupAtomically(db, stampedDest);
      files.push(stampedDest);

      if (file === MEMORY_DB) {
        // Refresh -latest through the same tmp + integrity + rename path — a
        // plain copy over the previous latest would tear it on a crash.
        const latestDest = path.join(backupDir, 'memory-backup-latest.db');
        await backupAtomically(db, latestDest);
        files.push(latestDest);
      }
      return { ...stats, sha256: sha256File(stampedDest) };
    } finally {
      db.close();
    }
  };

  const databases: BackupManifest['databases'] = { memory: await backupOne(MEMORY_DB) };
  if (fs.existsSync(path.join(dataDir, OBSERVATIONS_DB))) {
    databases.observations = await backupOne(OBSERVATIONS_DB);
  }

  const manifest: BackupManifest = { created_at: new Date().toISOString(), databases };
  const manifestPath = path.join(backupDir, `backup-${stamp}.manifest.json`);
  const manifestTmp = manifestPath + '.tmp';
  fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(manifestTmp, manifestPath);

  return { manifestPath, manifest, files };
}

// ---------------------------------------------------------------------------
// verifyRestore
// ---------------------------------------------------------------------------

export function verifyRestore(opts: { dataDir: string; manifestPath: string }): {
  ok: boolean;
  problems: string[];
} {
  const { dataDir, manifestPath } = opts;
  const problems: string[] = [];

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch (err) {
    return {
      ok: false,
      problems: [`cannot read manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const entries: DbManifest[] = [manifest.databases.memory];
  if (manifest.databases.observations) entries.push(manifest.databases.observations);

  for (const expected of entries) {
    // Only the two filenames runBackup ever writes may be verified: the
    // manifest is parsed JSON, so a hand-edited (or hostile) `file` value must
    // not become a path component (team-review fix).
    if (expected.file !== MEMORY_DB && expected.file !== OBSERVATIONS_DB) {
      problems.push(
        `${expected.file}: manifest names an unexpected file (only ${MEMORY_DB} and ${OBSERVATIONS_DB} are ever backed up)`
      );
      continue;
    }
    const livePath = path.join(dataDir, expected.file);
    if (!fs.existsSync(livePath)) {
      problems.push(`${expected.file}: missing from ${dataDir}`);
      continue;
    }

    if (typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      problems.push(`${expected.file}: manifest has no valid SHA-256 digest`);
    } else {
      try {
        const liveSha256 = sha256File(livePath);
        if (liveSha256 !== expected.sha256) {
          problems.push(
            `${expected.file}: SHA-256 ${liveSha256} does not match backup ${expected.sha256}`
          );
        }
      } catch (err) {
        problems.push(
          `${expected.file}: cannot calculate SHA-256: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    let db: Database.Database;
    try {
      db = new Database(livePath, { readonly: true, fileMustExist: true });
    } catch (err) {
      problems.push(
        `${expected.file}: cannot open: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    try {
      const integrity = integrityCheck(db);
      if (integrity !== 'ok') {
        problems.push(`${expected.file}: integrity_check returned '${integrity}' (expected 'ok')`);
      }

      const live = collectStats(db, expected.file);
      if (live.active_rows !== expected.active_rows) {
        problems.push(
          `${expected.file}: active row count ${live.active_rows} != manifest ${expected.active_rows}`
        );
      }
      if (live.archived_rows !== expected.archived_rows) {
        problems.push(
          `${expected.file}: archived row count ${live.archived_rows} != manifest ${expected.archived_rows}`
        );
      }
      if (live.max_id !== expected.max_id) {
        problems.push(`${expected.file}: max id ${live.max_id} != manifest ${expected.max_id}`);
      }
      if (live.newest_content_hash !== expected.newest_content_hash) {
        problems.push(
          `${expected.file}: newest content_hash ${live.newest_content_hash ?? 'null'} != manifest ${expected.newest_content_hash ?? 'null'}`
        );
      }
    } catch (err) {
      problems.push(
        `${expected.file}: verification query failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      db.close();
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// CLI (runs only when invoked directly — never on test import)
// ---------------------------------------------------------------------------

function newestManifest(backupDir: string): string | null {
  if (!fs.existsSync(backupDir)) return null;
  const manifests = fs
    .readdirSync(backupDir)
    .filter((f) => /^backup-.+\.manifest\.json$/.test(f))
    .sort(); // stamps are ISO-derived, so lexicographic order IS time order
  const last = manifests[manifests.length - 1];
  return last ? path.join(backupDir, last) : null;
}

async function main(): Promise<void> {
  // Resolve .env and the default paths from the SCRIPT's location, not the
  // CWD (team-review fix): invoked from an arbitrary directory (direct tsx, a
  // scheduled task), a CWD-relative dotenv would miss DATABASE_TYPE and the
  // Postgres refusal guard below would not fire. Matches recall-canary.ts.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  dotenv.config({ path: path.join(repoRoot, '.env') });

  if (process.env.DATABASE_TYPE === 'postgres') {
    console.error(
      'DATABASE_TYPE=postgres: this script backs up the SQLite backend only.\n' +
        'For Postgres, use the pg_dump-based offsite backup — see docs/postgres-maintainer.md.'
    );
    process.exit(2);
  }

  const dbPath = process.env.DATABASE_PATH || './data/memory.db';
  const dataDir = path.dirname(path.resolve(repoRoot, dbPath));
  const backupDir = path.resolve(repoRoot, process.env.BACKUP_PATH || './data/backups');

  const argv = process.argv.slice(2);
  const verify = argv.includes('--verify');
  const manifestIdx = argv.indexOf('--manifest');
  const manifestArg = manifestIdx >= 0 ? argv[manifestIdx + 1] : undefined;
  if (manifestIdx >= 0 && !manifestArg) {
    throw new Error('--manifest requires a value');
  }
  const manifestValueIdx = manifestIdx >= 0 ? manifestIdx + 1 : -1;
  const unknown = argv.filter(
    (a, i) => a !== '--verify' && a !== '--manifest' && i !== manifestValueIdx
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(' ')} (supported: --verify, --manifest <path>)`);
  }

  if (verify) {
    const manifestPath = manifestArg ? path.resolve(manifestArg) : newestManifest(backupDir);
    if (!manifestPath) {
      throw new Error(`no backup-*.manifest.json found in ${backupDir} (run npm run backup first)`);
    }
    console.log(`Verifying ${dataDir} against ${manifestPath}`);
    const { ok, problems } = verifyRestore({ dataDir, manifestPath });
    if (ok) {
      console.log('restore verification OK — corpus matches the manifest');
      return;
    }
    console.error('restore verification FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const { manifestPath, manifest, files } = await runBackup({ dataDir, backupDir });
  console.log(`Backup complete → ${backupDir}`);
  for (const f of files) console.log(`  ${path.basename(f)}`);
  console.log(`  ${path.basename(manifestPath)}`);
  const mem = manifest.databases.memory;
  console.log(
    `memory.db: ${mem.active_rows} active / ${mem.archived_rows} archived rows, max id ${mem.max_id}, integrity ${mem.integrity_check}`
  );
  const obs = manifest.databases.observations;
  if (obs) {
    console.log(`observations.db: ${obs.active_rows} rows, max id ${obs.max_id}, integrity ${obs.integrity_check}`);
  } else {
    console.log('observations.db: not present, skipped');
  }
}

// Only execute when run directly (not when imported by the drill test).
// Windows-safe: compare on normalized separators + case.
function isDirectRun(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return entry.includes('backup-local');
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    console.error(`backup-local failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
