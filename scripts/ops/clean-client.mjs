/**
 * npm run clean:client — allowlisted cleanup of expired hint/cache files
 * under ~/.kopeng (Phase 8, S9/CX-10). Invoked as `node scripts/ops/...` —
 * deliberately NO shebang: this file is imported by its unit suite, and a
 * shebang line breaks vite-node's inline transform on Node 20 (CI windows
 * job, "Invalid or unexpected token"); no other test-imported script here
 * carries one.
 *
 * CX-10: this is an explicit filename-pattern allowlist, never a directory
 * sweep. A sweep would delete hints/flush_error.json — the T18 capture-outage
 * alarm that must persist until the flush queue clears — silently restoring
 * an outage-with-no-symptom state. Anything not matching a class below
 * (flush_error.json, last_error.json, and every buffer/queue/poison/overflow
 * file — buffer/ is not even enumerated) is skipped by construction.
 *
 * Usage:
 *   node scripts/ops/clean-client.mjs              # dry-run: print the plan
 *   node scripts/ops/clean-client.mjs --apply      # unlink planned deletions
 *   node scripts/ops/clean-client.mjs --dir <path> # override ~/.kopeng (tests)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// TTL per class = its hook TTL ×10, so cleanup only ever removes files the
// hooks themselves long since stopped reading (they self-expire at 1×).
export const DELETABLE_CLASSES = [
  { dir: 'hints', pattern: /^sequence_hint\.json$/,            ttlMs: 5 * 60_000 * 10 },
  { dir: 'hints', pattern: /^canonical_path\.json$/,           ttlMs: 5 * 60_000 * 10 },
  { dir: 'hints', pattern: /^canonical_fallback_state\.json$/, ttlMs: 30 * 60_000 * 10 },
  { dir: 'hints', pattern: /^critical_[^/\\]+\.json$/,         ttlMs: 5 * 60_000 * 10 },
  { dir: 'cache', pattern: /^sequences_[^/\\]+\.json$/,        ttlMs: 10 * 60_000 * 10 },
  { dir: 'cache', pattern: /^canonical_triggers_[^/\\]+\.json$/, ttlMs: 10 * 60_000 * 10 },
];

// Only these directories are ever enumerated — buffer/ (queue/poison/overflow
// files) is deliberately outside the walk, not merely non-matching.
const SCANNED_DIRS = ['hints', 'cache'];

/**
 * Pure plan: walk hints/ and cache/ under kopengDir, classify each file
 * against the allowlist, and age-check matches by mtime.
 * @returns {{ deletions: Array<{path: string, cls: object}>, skipped: string[] }}
 */
export function planCleanup(kopengDir, now = Date.now()) {
  const deletions = [];
  const skipped = [];
  for (const dir of SCANNED_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(kopengDir, dir), { withFileTypes: true });
    } catch {
      continue; // missing dir — nothing to clean
    }
    for (const entry of entries) {
      const filePath = path.join(kopengDir, dir, entry.name);
      if (!entry.isFile()) continue; // never recurse
      const cls = DELETABLE_CLASSES.find((c) => c.dir === dir && c.pattern.test(entry.name));
      if (!cls) {
        skipped.push(filePath); // allowlist miss — skipped by construction
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        skipped.push(filePath); // vanished/unreadable — fail-open to skip
        continue;
      }
      if (now - stat.mtimeMs > cls.ttlMs) deletions.push({ path: filePath, cls });
      else skipped.push(filePath);
    }
  }
  return { deletions, skipped };
}

/**
 * Unlink the planned deletions only. Per-file failures are collected, never
 * thrown — one locked file must not abort the rest of the cleanup.
 * @returns {{ deleted: string[], failed: Array<{path: string, error: string}> }}
 */
export function applyCleanup(plan) {
  const deleted = [];
  const failed = [];
  for (const { path: filePath } of plan.deletions) {
    try {
      fs.unlinkSync(filePath);
      deleted.push(filePath);
    } catch (err) {
      failed.push({ path: filePath, error: String(err?.message ?? err) });
    }
  }
  return { deleted, failed };
}

function classLabel(cls) {
  return `${cls.dir}/${cls.pattern.source}`;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dirFlag = argv.indexOf('--dir');
  const kopengDir =
    dirFlag !== -1 && argv[dirFlag + 1] ? argv[dirFlag + 1] : path.join(os.homedir(), '.kopeng');

  const plan = planCleanup(kopengDir, Date.now());

  const byClass = new Map();
  for (const { cls } of plan.deletions) {
    const label = classLabel(cls);
    byClass.set(label, (byClass.get(label) ?? 0) + 1);
  }

  console.log(`clean:client ${apply ? 'APPLY' : 'dry-run'} — ${kopengDir}`);
  console.log(`  expired: ${plan.deletions.length}, skipped: ${plan.skipped.length}`);
  for (const [label, count] of byClass) console.log(`  ${label}: ${count}`);
  for (const { path: filePath } of plan.deletions) {
    console.log(`  ${apply ? 'delete' : 'would delete'}: ${filePath}`);
  }

  if (apply) {
    const result = applyCleanup(plan);
    console.log(`  deleted: ${result.deleted.length}, failed: ${result.failed.length}`);
    for (const { path: filePath, error } of result.failed) {
      console.log(`  FAILED: ${filePath} — ${error}`);
    }
    if (result.failed.length > 0) process.exitCode = 1;
  } else if (plan.deletions.length > 0) {
    console.log('  (dry-run — pass --apply to delete)');
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
