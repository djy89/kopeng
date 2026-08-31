/**
 * Task 8 (Phase 8, S9/CX-10): npm run clean:client — allowlisted expired
 * hint/cache cleanup.
 *
 * The CX-10 story: a naive directory sweep would delete
 * ~/.kopeng/hints/flush_error.json — the T18 capture-outage alarm that must
 * persist until the flush queue clears — silently restoring an
 * outage-with-no-symptom state. So cleanup is an explicit filename-pattern
 * allowlist: anything not matching a class (flush_error.json,
 * last_error.json, every buffer/queue/poison/overflow file) is skipped by
 * construction, never swept.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DELETABLE_CLASSES, planCleanup, applyCleanup } from '../../scripts/ops/clean-client.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/ops/clean-client.mjs', import.meta.url));

const NOW = Date.now();
const ANCIENT = new Date(NOW - 100 * 24 * 60 * 60_000); // 100 days ago — expired for every class

/** One representative filename per allowlisted class, keyed dir/name. */
const CLASS_MEMBERS: Array<{ dir: string; name: string }> = [
  { dir: 'hints', name: 'sequence_hint.json' },
  { dir: 'hints', name: 'canonical_path.json' },
  { dir: 'hints', name: 'canonical_fallback_state.json' },
  { dir: 'hints', name: 'critical_sess-abc123.json' },
  { dir: 'hints', name: 'ensure_conflict.json' },
  { dir: 'hints', name: 'ensure_spawn.json' },
  { dir: 'cache', name: 'sequences_kopeng.json' },
  { dir: 'cache', name: 'canonical_triggers_kopeng.json' },
];

let tmpDir: string;

function writeFile(dir: string, name: string, mtime?: Date): string {
  const abs = path.join(tmpDir, dir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '{}');
  if (mtime) fs.utimesSync(abs, mtime, mtime);
  return abs;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-clean-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DELETABLE_CLASSES', () => {
  it('covers exactly the eight allowlisted hint/cache classes', () => {
    expect(DELETABLE_CLASSES).toHaveLength(8);
    for (const member of CLASS_MEMBERS) {
      const matches = DELETABLE_CLASSES.filter(
        (c: { dir: string; pattern: RegExp }) => c.dir === member.dir && c.pattern.test(member.name)
      );
      expect(matches, `${member.dir}/${member.name} should match exactly one class`).toHaveLength(1);
    }
  });

  it('never matches the durable alarm/hint files', () => {
    for (const name of ['flush_error.json', 'last_error.json']) {
      for (const cls of DELETABLE_CLASSES) {
        expect(cls.pattern.test(name), `${name} must not match ${cls.pattern}`).toBe(false);
      }
    }
  });
});

describe('planCleanup', () => {
  it('plans deletion for an expired member of every class', () => {
    const expected = CLASS_MEMBERS.map((m) => writeFile(m.dir, m.name, ANCIENT));
    const plan = planCleanup(tmpDir, NOW);
    const planned = plan.deletions.map((d: { path: string }) => d.path).sort();
    expect(planned).toEqual([...expected].sort());
    expect(plan.skipped).toEqual([]);
  });

  it('skips a fresh member of every class', () => {
    const expected = CLASS_MEMBERS.map((m) => writeFile(m.dir, m.name)); // mtime = now
    const plan = planCleanup(tmpDir, NOW);
    expect(plan.deletions).toEqual([]);
    expect([...plan.skipped].sort()).toEqual([...expected].sort());
  });

  it('skips flush_error.json and last_error.json even with ancient mtimes (CX-10)', () => {
    const flushAlarm = writeFile('hints', 'flush_error.json', ANCIENT);
    const lastError = writeFile('hints', 'last_error.json', ANCIENT);
    const plan = planCleanup(tmpDir, NOW);
    expect(plan.deletions).toEqual([]);
    expect(plan.skipped).toContain(flushAlarm);
    expect(plan.skipped).toContain(lastError);
  });

  it('skips unknown files in hints/ and cache/', () => {
    const unknownHint = writeFile('hints', 'some_future_hint.json', ANCIENT);
    const unknownCache = writeFile('cache', 'notes.txt', ANCIENT);
    const plan = planCleanup(tmpDir, NOW);
    expect(plan.deletions).toEqual([]);
    expect(plan.skipped).toContain(unknownHint);
    expect(plan.skipped).toContain(unknownCache);
  });

  it('never enumerates buffer/ — queue/poison/overflow files are untouched and unreported', () => {
    writeFile('buffer', 'observations.jsonl', ANCIENT);
    writeFile('buffer', 'flush-20260101.jsonl', ANCIENT);
    writeFile('buffer', 'poison-20260101.jsonl', ANCIENT);
    writeFile('buffer', 'overflow-20260101.jsonl', ANCIENT);
    const plan = planCleanup(tmpDir, NOW);
    expect(plan.deletions).toEqual([]);
    expect(plan.skipped).toEqual([]); // buffer/ is not even walked
  });

  it('handles a missing kopeng dir without throwing', () => {
    const plan = planCleanup(path.join(tmpDir, 'does-not-exist'), NOW);
    expect(plan.deletions).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('applyCleanup', () => {
  it('unlinks only the planned deletions', () => {
    const expired = writeFile('hints', 'sequence_hint.json', ANCIENT);
    const fresh = writeFile('cache', 'sequences_kopeng.json');
    const plan = planCleanup(tmpDir, NOW);
    const result = applyCleanup(plan);
    expect(result.deleted).toEqual([expired]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('CLI', () => {
  it('dry-run by default: prints the plan and deletes nothing', () => {
    const expired = writeFile('hints', 'sequence_hint.json', ANCIENT);
    const out = execFileSync(process.execPath, [SCRIPT, '--dir', tmpDir], { encoding: 'utf8' });
    expect(fs.existsSync(expired)).toBe(true); // dry-run never unlinks
    expect(out).toContain('sequence_hint.json');
    expect(out.toLowerCase()).toContain('dry-run');
  });

  it('--apply deletes expired allowlisted files but never flush_error.json (the CX-10 pin)', () => {
    const flushAlarm = writeFile('hints', 'flush_error.json', ANCIENT);
    const expired = writeFile('hints', 'canonical_path.json', ANCIENT);
    const fresh = writeFile('cache', 'canonical_triggers_kopeng.json');
    execFileSync(process.execPath, [SCRIPT, '--apply', '--dir', tmpDir], { encoding: 'utf8' });
    expect(fs.existsSync(flushAlarm)).toBe(true); // the T18 alarm survives an apply run
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
