import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// B7: backupDatabase() must create a missing backup dir, await the async
// better-sqlite3 backup, and write both the timestamped and latest copies —
// without the unawaited-rejection crash the old sync version could trigger.
// Point the source DB and backup dir at a fresh temp tree; the backup dir is
// deliberately NOT pre-created so the mkdir-recursive path is exercised.
const root = path.join(os.tmpdir(), `kopeng-backup-test-${process.pid}`);
const dbPath = path.join(root, 'db', 'memory.db');
const backupDir = path.join(root, 'backups');

vi.stubEnv('DATABASE_PATH', dbPath);
vi.stubEnv('BACKUP_PATH', backupDir);

const { getDatabase, backupDatabase, closeDatabase } = await import('../../src/database/database.js');

describe('backupDatabase (B7)', () => {
  beforeAll(() => {
    getDatabase(); // opens/creates a real on-disk source DB + runs migrations
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a missing backup dir, awaits the backup, and writes both files', async () => {
    expect(fs.existsSync(backupDir)).toBe(false); // not created by DB init

    const out = await backupDatabase();

    expect(fs.existsSync(backupDir)).toBe(true); // mkdir recursive
    expect(out.startsWith(backupDir)).toBe(true);
    expect(fs.existsSync(out)).toBe(true); // timestamped backup — proves db.backup() was awaited
    expect(fs.existsSync(path.join(backupDir, 'memory-backup-latest.db'))).toBe(true); // latest copy
  });
});
