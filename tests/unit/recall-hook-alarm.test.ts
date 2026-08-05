/**
 * T18 review follow-up — the flush alarm's SURFACING half (memory-prompt-search.mjs).
 * The writer half is covered by observe-hook-flush.test.ts; these tests close the
 * asymmetry the testing review flagged: compose logic (pure), the
 * below-MIN_PROMPT_LEN emit path, and Claude/--codex output parity — the latter
 * two via the real script in a child process with an isolated KOPENG_HINTS_DIR.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../../scripts/hooks/memory-prompt-search.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'kopeng-alarm-'));
const HINTS_DIR = join(tmp, 'hints');
const HINT_FILE = join(HINTS_DIR, 'flush_error.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hook: any;

beforeAll(async () => {
  mkdirSync(HINTS_DIR, { recursive: true });
  // Safe to import: main() is behind an isMain guard (this suite's finding).
  hook = await import('../../scripts/hooks/memory-prompt-search.mjs');
});

function writeHint(hint: Record<string, unknown>) {
  writeFileSync(HINT_FILE, JSON.stringify(hint));
}

function clearHint() {
  if (existsSync(HINT_FILE)) unlinkSync(HINT_FILE);
}

/** Run the real hook script as Claude Code would (JSON on stdin → stdout). */
function runHook(stdinObj: unknown, extraArgs: string[] = []): string {
  return execFileSync(process.execPath, [SCRIPT, ...extraArgs], {
    input: JSON.stringify(stdinObj),
    env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_API_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });
}

describe('composeFlushWarning (pure)', () => {
  const NOW = Date.parse('2026-07-03T12:00:00Z');

  it('renders reason, HTTP status, pending KB, and age', () => {
    const s = hook.composeFlushWarning({
      reason: 'rejected',
      status: 400,
      pending_bytes: 2048,
      timestamp: new Date(NOW - 5 * 60_000).toISOString(),
    }, NOW);
    expect(s).toContain('rejected');
    expect(s).toContain('HTTP 400');
    expect(s).toContain('~2 KB pending');
    expect(s).toContain('5 min ago');
  });

  it('omits the HTTP fragment when status is absent', () => {
    const s = hook.composeFlushWarning({
      reason: 'server-unreachable',
      pending_bytes: 100,
      timestamp: new Date(NOW).toISOString(),
    }, NOW);
    expect(s).toContain('server-unreachable');
    expect(s).not.toContain('HTTP');
  });

  it('returns empty for missing or garbage hints', () => {
    expect(hook.composeFlushWarning(null, NOW)).toBe('');
    expect(hook.composeFlushWarning({}, NOW)).toBe('');
    expect(hook.composeFlushWarning({ timestamp: 'not-a-date' }, NOW)).toBe('');
  });
});

describe('alarm surfacing through the real hook script', () => {
  it('surfaces the alarm even on a prompt below MIN_PROMPT_LEN (Claude JSON shape)', () => {
    writeHint({ reason: 'server-unreachable', pending_bytes: 4096, timestamp: new Date().toISOString() });
    const out = runHook({ user_prompt: 'hi', cwd: 'C:/tmp/alarm-test' });
    const parsed = JSON.parse(out);
    expect(parsed.systemMessage).toContain('observation flush is failing');
    expect(parsed.systemMessage).toContain('server-unreachable');
    clearHint();
  });

  it('emits {} on a short prompt when flushing is healthy (no hint)', () => {
    clearHint();
    const out = runHook({ user_prompt: 'hi', cwd: 'C:/tmp/alarm-test' });
    expect(out).toBe('{}');
  });

  it('--codex emits the warning as raw text, not JSON', () => {
    writeHint({ reason: 'overflow-pending', pending_bytes: 1024, timestamp: new Date().toISOString() });
    const out = runHook({ user_prompt: 'hi', cwd: 'C:/tmp/alarm-test' }, ['--codex']);
    expect(out).toContain('observation flush is failing');
    expect(out.trim().startsWith('{')).toBe(false);
    clearHint();
  });
});
