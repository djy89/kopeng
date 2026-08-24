/**
 * Phase 8 (S8, CX-9) — scheduled-task heartbeat staleness evaluator.
 *
 * The two scheduled runners (sync-indexes-task.ps1 daily, corpus-health-task.ps1
 * weekly) append one JSON line per run to ~/.kopeng/metrics/heartbeats.jsonl:
 *   {"ts":"<ISO>","task":"<name>","ok":true|false}
 * A task that fails still writes a line (ok:false) — but a task that is
 * disabled, deleted, or never started writes NOTHING and stays silent. This
 * evaluator's non-zero exit on MISSING is the whole point (CX-9): it is the
 * only signal that distinguishes "healthy silence" from "the task is gone".
 *
 * READ-ONLY: this script never writes anything, anywhere.
 *
 * Usage:
 *   npm run heartbeats
 *   npm run heartbeats -- --expect sync-indexes:24 --expect corpus-health:168
 *
 * States per expected task (checked in this order):
 *   missing — no heartbeat line for the task, ever (or no heartbeats file)
 *   stale   — last seen older than 2x the task's cadence
 *   failing — fresh, but the latest heartbeat has ok:false
 *   ok      — fresh and ok:true
 * Exit code 0 only when EVERY expected task is 'ok'.
 *
 * Default expectations come from ~/.kopeng/metrics/expected-tasks.json. The
 * installers add an entry only after registration succeeds and remove it only
 * on explicit -Uninstall. A disabled/deleted task therefore remains expected,
 * including before its first run: no heartbeat is a hard MISSING. A fresh
 * install has no registry entries and exits 0 with "no scheduled tasks
 * installed". Explicit --expect entries bypass the registry.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { expectedTasksPath, readExpectedTasks } from './expected-tasks.mjs';

// ---------------------------------------------------------------------------
// Pure helpers — exported so unit tests can import them with no network/FS
// side effects. main() runs only when the script is invoked directly.
// ---------------------------------------------------------------------------

export interface ExpectedTask {
  task: string;
  cadenceHours: number;
}

export interface TaskStatus {
  task: string;
  lastSeen: string | null;
  lastOk: boolean | null;
  state: 'ok' | 'failing' | 'stale' | 'missing';
}

interface HeartbeatLine {
  ts: string;
  tsMs: number;
  task: string;
  ok: boolean;
}

/** Parse one JSONL line; null for anything malformed (never throws). */
function parseHeartbeatLine(line: string): HeartbeatLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.ts !== 'string' || typeof rec.task !== 'string' || typeof rec.ok !== 'boolean') {
    return null;
  }
  const tsMs = Date.parse(rec.ts);
  if (Number.isNaN(tsMs)) return null;
  return { ts: rec.ts, tsMs, task: rec.task, ok: rec.ok };
}

/**
 * Evaluate raw JSONL lines against the expected task list at a given clock.
 * Malformed lines are skipped silently; the latest heartbeat per task (by ts,
 * not file order) decides its state. One status row per expected task, in
 * expected-list order.
 */
export function evaluateHeartbeats(
  lines: string[],
  expected: ExpectedTask[],
  now: Date
): TaskStatus[] {
  const latest = new Map<string, HeartbeatLine>();
  for (const line of lines) {
    const hb = parseHeartbeatLine(line);
    if (!hb) continue;
    const prev = latest.get(hb.task);
    if (!prev || hb.tsMs > prev.tsMs) latest.set(hb.task, hb);
  }

  return expected.map(({ task, cadenceHours }) => {
    const hb = latest.get(task);
    if (!hb) return { task, lastSeen: null, lastOk: null, state: 'missing' as const };
    const ageMs = now.getTime() - hb.tsMs;
    const staleAfterMs = 2 * cadenceHours * 60 * 60 * 1000;
    const state = ageMs > staleAfterMs ? 'stale' : hb.ok ? 'ok' : 'failing';
    return { task, lastSeen: hb.ts, lastOk: hb.ok, state };
  });
}

/**
 * Parse `--expect name:hours` overrides from argv (already sliced past
 * node+script). Returns null when no overrides were given (use
 * DEFAULT_EXPECTED). Malformed values and unknown flags throw — a typo'd flag
 * silently evaluating the wrong task set would defeat the missing-task alarm.
 */
export function parseExpectOverrides(argv: string[]): ExpectedTask[] | null {
  const overrides: ExpectedTask[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--expect') {
      throw new Error(`Unknown argument: ${arg} (supported: --expect <name>:<hours>)`);
    }
    const v = argv[++i];
    if (!v) throw new Error('--expect requires a value of the form <name>:<hours>');
    const sep = v.lastIndexOf(':');
    const task = sep > 0 ? v.slice(0, sep) : '';
    const hours = sep > 0 ? Number(v.slice(sep + 1)) : NaN;
    if (!task || !Number.isFinite(hours) || hours <= 0) {
      throw new Error(`Invalid --expect value: ${v} (expected <name>:<hours>, hours > 0)`);
    }
    overrides.push({ task, cadenceHours: hours });
  }
  return overrides.length > 0 ? overrides : null;
}

export function defaultHeartbeatsPath(homedir: string = os.homedir()): string {
  return path.join(homedir, '.kopeng', 'metrics', 'heartbeats.jsonl');
}

export interface ResolvedExpected {
  expected: ExpectedTask[];
  /** true when the list came from --expect overrides. */
  explicit: boolean;
}

/**
 * Resolve the expected task list for one run. Explicit --expect overrides are
 * returned as-is. With no overrides, load the installer's durable registry.
 * The loader is lazy so an explicit override can still diagnose heartbeats if
 * the default registry is damaged.
 */
export function resolveExpectedTasks(
  argv: string[],
  loadRegistered: () => ExpectedTask[]
): ResolvedExpected {
  const overrides = parseExpectOverrides(argv);
  if (overrides) return { expected: overrides, explicit: true };
  return { expected: loadRegistered(), explicit: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const { expected } = resolveExpectedTasks(process.argv.slice(2), () =>
    readExpectedTasks(expectedTasksPath()) as ExpectedTask[]
  );
  if (expected.length === 0) {
    console.log('heartbeats: no scheduled tasks installed — nothing to evaluate.');
    return;
  }

  const hbPath = defaultHeartbeatsPath();
  let lines: string[] = [];
  if (fs.existsSync(hbPath)) {
    lines = fs.readFileSync(hbPath, 'utf8').split(/\r?\n/);
  } else {
    console.log(`No heartbeats file at ${hbPath} — every expected task will read MISSING.`);
  }

  const statuses = evaluateHeartbeats(lines, expected, new Date());

  const header = ['TASK', 'STATE', 'LAST SEEN', 'LAST OK'];
  const rows = statuses.map((s) => [
    s.task,
    s.state.toUpperCase(),
    s.lastSeen ?? '-',
    s.lastOk === null ? '-' : String(s.lastOk),
  ]);
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const fmt = (r: string[]) => r.map((cell, col) => cell.padEnd(widths[col])).join('  ');
  console.log(fmt(header));
  for (const r of rows) console.log(fmt(r));

  const bad = statuses.filter((s) => s.state !== 'ok');
  if (bad.length > 0) {
    console.error(
      `heartbeats: ${bad.length} task(s) not ok: ` +
        bad.map((s) => `${s.task}=${s.state}`).join(', ')
    );
    process.exitCode = 1;
  } else {
    console.log('heartbeats: all expected tasks ok');
  }
}

// Only execute when run directly (not when imported by tests). Compare the
// entry-point path to this file's name — works with tsx direct execution.
function isDirectRun(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return entry.includes('heartbeats-report');
}

if (isDirectRun()) {
  try {
    main();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`heartbeats-report failed: ${msg}`);
    process.exit(1);
  }
}
