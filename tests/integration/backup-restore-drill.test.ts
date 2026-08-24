/**
 * Task 6 (S5, CX-2, CX-12) — backup/restore drill.
 *
 * End-to-end drill over scripts/ops/backup-local.ts: seed a real-schema
 * memory.db + observations.db in a temp dir, back them up with a manifest,
 * mutate the original, restore from the backup files, and prove via
 * verifyRestore + direct SQL that the restored corpus IS the backed-up corpus
 * (seeded rows present, post-backup mutation absent, FTS intact).
 *
 * CX-2: the manifest carries each backup DB's SHA-256 plus diagnostic corpus
 * stats, so restore verification proves exact snapshot identity. Both an empty
 * DB and a healthy equal-or-larger wrong corpus MUST fail verification.
 *
 * Temp dirs only — never the live data/ or the repo .env.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import {
  createTestDatabase,
  createTestObservationsDb,
  createTestMemory,
} from '../fixtures/test-helpers.js';
import { runBackup, verifyRestore, type BackupManifest } from '../../scripts/ops/backup-local.js';

/** Materialize an in-memory better-sqlite3 handle to a file on disk. */
async function materialize(db: Database.Database, filePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await db.backup(filePath);
}

/** Seed a memory.db file with the real schema and the given contents. */
async function seedMemoryDb(filePath: string, contents: string[]): Promise<void> {
  const { db, queries } = createTestDatabase();
  for (const content of contents) {
    await queries.store(createTestMemory({ content }));
  }
  await materialize(db, filePath);
  db.close();
}

/** Seed an observations.db file with the real schema and n rows. */
async function seedObservationsDb(filePath: string, n: number): Promise<void> {
  const { db } = createTestObservationsDb();
  const insert = db.prepare(
    `INSERT INTO observations (session_id, project_scope, tool_name, input_summary)
     VALUES (?, ?, ?, ?)`
  );
  for (let i = 0; i < n; i++) {
    insert.run(`drill-session-${i}`, 'project:drill', 'Bash', `npm test ${i}`);
  }
  await materialize(db, filePath);
  db.close();
}

const SEEDED_CONTENTS = [
  'The staging cluster deploys from the release branch every morning',
  'The build server keeps its zebrafish artifact cache under the shared volume',
  'Integration fixtures live beside the schema helpers in the test tree',
];
const MUTATION_CONTENT = 'A fourth memory inserted AFTER the backup was taken';

describe('backup/restore drill (backup-local.ts)', () => {
  let tmpRoot: string;
  let dataDir: string;
  let backupDir: string;
  let manifestPath: string;
  let manifest: BackupManifest;
  let backupFiles: string[];
  let seededNewestHash: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-backup-drill-'));
    dataDir = path.join(tmpRoot, 'data');
    backupDir = path.join(tmpRoot, 'backups');
    await seedMemoryDb(path.join(dataDir, 'memory.db'), SEEDED_CONTENTS);
    await seedObservationsDb(path.join(dataDir, 'observations.db'), 2);

    // Capture what the newest row's hash actually is, straight from the DB —
    // the manifest must agree with the corpus, not with the test's guess.
    const db = new Database(path.join(dataDir, 'memory.db'), { readonly: true });
    seededNewestHash = (
      db.prepare('SELECT content_hash FROM memories ORDER BY id DESC LIMIT 1').get() as {
        content_hash: string;
      }
    ).content_hash;
    db.close();

    const result = await runBackup({ dataDir, backupDir, stamp: '2026-08-21T00-00-00' });
    manifestPath = result.manifestPath;
    manifest = result.manifest;
    backupFiles = result.files;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('produces a manifest that matches the corpus, with integrity ok (CX-2)', () => {
    const mem = manifest.databases.memory;
    expect(mem.active_rows).toBe(3);
    expect(mem.archived_rows).toBe(0);
    expect(mem.max_id).toBe(3);
    expect(mem.newest_content_hash).toBe(seededNewestHash);
    expect(mem.integrity_check).toBe('ok');
    expect(mem.sha256).toBe(
      createHash('sha256')
        .update(fs.readFileSync(path.join(backupDir, 'memory-backup-2026-08-21T00-00-00.db')))
        .digest('hex')
    );

    const obs = manifest.databases.observations;
    expect(obs).toBeDefined();
    expect(obs!.active_rows).toBe(2);
    expect(obs!.archived_rows).toBe(0);
    expect(obs!.max_id).toBe(2);
    expect(obs!.newest_content_hash).toBeNull();
    expect(obs!.integrity_check).toBe('ok');
    expect(obs!.sha256).toBe(
      createHash('sha256')
        .update(fs.readFileSync(path.join(backupDir, 'observations-backup-2026-08-21T00-00-00.db')))
        .digest('hex')
    );

    expect(manifest.created_at).toBeTruthy();
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('writes timestamped backups + memory-backup-latest.db atomically, no tmp litter (CX-12)', () => {
    expect(backupFiles.length).toBeGreaterThanOrEqual(2);
    for (const f of backupFiles) {
      expect(fs.existsSync(f)).toBe(true);
    }
    // The stamped memory backup and the refreshed -latest must both exist.
    expect(backupFiles.some((f) => path.basename(f) === 'memory-backup-2026-08-21T00-00-00.db')).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'memory-backup-latest.db'))).toBe(true);
    // CX-12: temp files are renamed into place, never left behind.
    const leftovers = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('restore drill: restored dir verifies ok and holds exactly the backed-up corpus', async () => {
    // 2. Mutate the ORIGINAL after the backup: insert a 4th memory.
    const live = new Database(path.join(dataDir, 'memory.db'));
    live
      .prepare(
        `INSERT INTO memories (content, content_hash, type, scope, metadata, embedding_model)
         VALUES (?, ?, 'reference', 'global', '{}', 'test-model')`
      )
      .run(MUTATION_CONTENT, 'drill-hash-of-the-fourth-memory');
    live.close();

    // 3. "Restore": move aside the originals (db + WAL/SHM sidecars), copy the
    // backup files in under the live names.
    for (const base of ['memory.db', 'observations.db']) {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = path.join(dataDir, base + suffix);
        if (fs.existsSync(p)) fs.renameSync(p, p + '.pre-restore');
      }
    }
    fs.copyFileSync(
      path.join(backupDir, 'memory-backup-2026-08-21T00-00-00.db'),
      path.join(dataDir, 'memory.db')
    );
    fs.copyFileSync(
      path.join(backupDir, 'observations-backup-2026-08-21T00-00-00.db'),
      path.join(dataDir, 'observations.db')
    );

    // 4. Manifest-checked verification passes on the restored dir.
    const verdict = verifyRestore({ dataDir, manifestPath });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);

    // 5. The restored corpus is the seeded corpus: 3 rows, the post-backup
    // mutation absent, and FTS answers a MATCH query over a seeded token.
    const restored = new Database(path.join(dataDir, 'memory.db'), { readonly: true });
    const rows = restored.prepare('SELECT content FROM memories ORDER BY id').all() as {
      content: string;
    }[];
    expect(rows.map((r) => r.content)).toEqual(SEEDED_CONTENTS);
    expect(rows.some((r) => r.content === MUTATION_CONTENT)).toBe(false);
    const ftsHits = restored
      .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?')
      .all('zebrafish') as { rowid: number }[];
    expect(ftsHits.length).toBe(1);
    restored.close();

    const restoredObs = new Database(path.join(dataDir, 'observations.db'), { readonly: true });
    const obsCount = (
      restoredObs.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number }
    ).c;
    expect(obsCount).toBe(2);
    restoredObs.close();
  });

  it('CX-2 negative: an empty schema-only restore FAILS verification, naming count + hash', async () => {
    const wrongDir = path.join(tmpRoot, 'wrong-restore');
    await seedMemoryDb(path.join(wrongDir, 'memory.db'), []); // schema, zero rows
    await seedObservationsDb(path.join(wrongDir, 'observations.db'), 0);

    const verdict = verifyRestore({ dataDir: wrongDir, manifestPath });
    expect(verdict.ok).toBe(false);
    const joined = verdict.problems.join('\n');
    expect(joined).toMatch(/count/i);
    expect(joined).toMatch(/hash/i);
  });

  it('rejects an equal-or-larger healthy corpus that only contains the manifest newest hash', async () => {
    const wrongDir = path.join(tmpRoot, 'larger-wrong-restore');
    await seedMemoryDb(path.join(wrongDir, 'memory.db'), [
      'An unrelated memory from a different healthy corpus',
      SEEDED_CONTENTS[2], // Makes the old anywhere-in-DB newest-hash check pass.
      'Another unrelated memory with a larger row id',
      'A fourth unrelated memory keeps the active count above the manifest',
    ]);
    await seedObservationsDb(path.join(wrongDir, 'observations.db'), 3);

    const verdict = verifyRestore({ dataDir: wrongDir, manifestPath });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/sha-?256|digest|exact/i);
  });

  it('manifest file allowlist: a foreign `file` value is refused, never used as a path (team-review fix)', () => {
    const evilManifestPath = path.join(tmpRoot, 'evil.manifest.json');
    const evil = {
      created_at: new Date().toISOString(),
      databases: {
        memory: {
          file: '../../outside/memory.db',
          active_rows: 0, archived_rows: 0, max_id: 0,
          newest_content_hash: null, integrity_check: 'ok',
        },
      },
    };
    fs.writeFileSync(evilManifestPath, JSON.stringify(evil), 'utf8');
    const verdict = verifyRestore({ dataDir, manifestPath: evilManifestPath });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/unexpected file/);
  });

  it('absent observations.db: manifest omits it and verification still passes', async () => {
    const soloDataDir = path.join(tmpRoot, 'solo-data');
    const soloBackupDir = path.join(tmpRoot, 'solo-backups');
    await seedMemoryDb(path.join(soloDataDir, 'memory.db'), ['A lone memory in a lone database']);

    const result = await runBackup({ dataDir: soloDataDir, backupDir: soloBackupDir });
    expect(result.manifest.databases.observations).toBeUndefined();
    expect(result.manifest.databases.memory.active_rows).toBe(1);

    const restoredDir = path.join(tmpRoot, 'solo-restored');
    fs.mkdirSync(restoredDir);
    const stampedBackup = result.files.find(
      (f) => path.basename(f).startsWith('memory-backup-') && !f.endsWith('-latest.db')
    );
    expect(stampedBackup).toBeDefined();
    fs.copyFileSync(stampedBackup!, path.join(restoredDir, 'memory.db'));

    const verdict = verifyRestore({ dataDir: restoredDir, manifestPath: result.manifestPath });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
