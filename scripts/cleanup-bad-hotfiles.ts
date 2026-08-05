/**
 * One-shot cleanup after the extractFilePaths fix:
 * 1. Delete hot_file memories created during the JSONL backfill day (2026-05-13)
 *    — the buggy regex polluted them with comment markers, regex content, etc.
 * 2. Reset the discovery watermark for projects affected by the backfill so
 *    the fixed code re-processes the imported observations.
 *
 * Idempotent: safe to run multiple times. The re-run of `npm run discover`
 * after this script will recreate clean hot_file memories from the same obs.
 *
 *   npx tsx scripts/cleanup-bad-hotfiles.ts [--dry-run]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const MEMORY_DB = process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'memory.db');
const OBSERVATIONS_DB = process.env.OBSERVATIONS_DB_PATH || path.join(projectRoot, 'data', 'observations.db');

const dryRun = process.argv.includes('--dry-run');

console.log(`Cleanup-bad-hotfiles ${dryRun ? '(DRY RUN)' : ''}`);
console.log(`  memory.db:       ${MEMORY_DB}`);
console.log(`  observations.db: ${OBSERVATIONS_DB}\n`);

// ── 1. Delete backfill-day hot_file memories ──

const mem = new Database(MEMORY_DB);
const beforeMem = mem.prepare(`
  SELECT COUNT(*) as c FROM memories
  WHERE type='discovery'
    AND content LIKE 'The file %frequent edit target%'
    AND created_at > '2026-05-13 00:00:00'
`).get() as { c: number };
console.log(`Backfill-day hot_file memories: ${beforeMem.c}`);

if (!dryRun) {
  const r = mem.prepare(`
    DELETE FROM memories
    WHERE type='discovery'
      AND content LIKE 'The file %frequent edit target%'
      AND created_at > '2026-05-13 00:00:00'
  `).run();
  console.log(`  Deleted ${r.changes} memories`);
}

// ── 2. Find earliest jsonl_import observation per project, reset watermark ──

const obs = new Database(OBSERVATIONS_DB);

// For each project that has jsonl_import obs, find the lowest obs ID
const projectMinIds = obs.prepare(`
  SELECT project_scope, MIN(id) as min_id
  FROM observations
  WHERE json_extract(metadata, '$.source') = 'jsonl_import'
  GROUP BY project_scope
`).all() as Array<{ project_scope: string; min_id: number }>;

console.log(`\nProjects with imported observations: ${projectMinIds.length}`);

let totalRunsDeleted = 0;
for (const { project_scope, min_id } of projectMinIds) {
  // Count how many discovery_runs would be reset
  const affected = obs.prepare(`
    SELECT COUNT(*) as c FROM discovery_runs
    WHERE project_scope = ?
      AND observation_end_id >= ?
  `).get(project_scope, min_id) as { c: number };
  if (affected.c === 0) continue;

  console.log(`  ${project_scope}: ${affected.c} runs >= obs ${min_id}`);

  if (!dryRun) {
    // Delete discovery_runs rows >= the import start. Next discovery call
    // re-pulls observations from where the cursor was, which is now the
    // pre-import position.
    const r = obs.prepare(`
      DELETE FROM discovery_runs
      WHERE project_scope = ?
        AND observation_end_id >= ?
    `).run(project_scope, min_id);
    totalRunsDeleted += r.changes;
  }
}

if (!dryRun) {
  console.log(`\nTotal discovery_runs deleted: ${totalRunsDeleted}`);
}

mem.close();
obs.close();

console.log(`\n${dryRun ? 'Dry run complete. Re-run without --dry-run to apply.' : 'Cleanup complete.'}`);
console.log(`Next step: run \`npm run discover\` in a loop until cursor exhausts.`);
