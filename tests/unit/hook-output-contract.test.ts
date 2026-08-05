/**
 * Hook stdout CONTRACT tests (sweep-3 PB-1).
 *
 * Claude Code renders `systemMessage` to the OPERATOR and never shows it to the
 * model; model-visible context must ship as `hookSpecificOutput.additionalContext`
 * (or as plain stdout, for UserPromptSubmit/SessionStart). Both context hooks used
 * to emit ONLY `systemMessage`, so every recalled memory reached the transcript and
 * nothing reached Claude — a failure with no symptom, since SETUP's own verification
 * step looked for exactly that shape.
 *
 * These tests pin the COMPLETE stdout shape of both hooks against a stub server, so
 * the regression cannot come back silently:
 *   - recall/session content  → hookSpecificOutput.additionalContext (model sees it)
 *   - operator health alarms  → systemMessage (operator sees it, model does not)
 *   - --codex                 → raw text on stdout (Codex injects stdout, ignores JSON)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECALL_HOOK = resolve(HERE, '../../scripts/hooks/memory-prompt-search.mjs');
const SESSION_HOOK = resolve(HERE, '../../scripts/hooks/memory-session-start.mjs');

const SENTINEL = 'CONTRACT-TEST-MEMORY-SENTINEL';
const LONG_PROMPT = 'what have I been working on in this project lately';

const tmp = mkdtempSync(join(tmpdir(), 'kopeng-hook-contract-'));
const HINTS_DIR = join(tmp, 'hints');
const HINT_FILE = join(HINTS_DIR, 'flush_error.json');
// The session-start hook shells out to git five times with a 4s self-timeout each.
// Pointed at THIS repo (large history, many modified files) those calls get slow
// enough under a parallel suite to time out, and the hook then degrades to {} by
// design — which made the assertion flaky. A throwaway single-commit repo keeps
// every git call trivial, so the test measures the output contract, not git latency.
const GIT_REPO = join(tmp, 'repo');

let server: Server;
let apiUrl = '';

beforeAll(async () => {
  mkdirSync(HINTS_DIR, { recursive: true });

  mkdirSync(GIT_REPO, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', GIT_REPO, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'ci@runner.test');
  git('config', 'user.name', 'contract-test');
  writeFileSync(join(GIT_REPO, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-m', 'fixture commit', '--no-gpg-sign');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (url.startsWith('/api/memories/recall')) {
        res.end(JSON.stringify({ data: [{ id: 1, type: 'project', content: SENTINEL, tags: [] }] }));
      } else if (url.startsWith('/api/surface')) {
        res.end(JSON.stringify({ data: { tools: [], skills: [], conventions: [] } }));
      } else {
        res.end(JSON.stringify({ data: [] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  apiUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const execFileAsync = promisify(execFile);

/**
 * Async on purpose: the stub server runs in THIS process, so a synchronous
 * execFileSync would block the event loop and the hook's fetch would always
 * time out instead of being served.
 */
async function run(script: string, stdinObj: unknown, extraArgs: string[] = [], cwd = tmp): Promise<string> {
  const child = execFileAsync(process.execPath, [script, ...extraArgs], {
    cwd,
    env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_API_URL: apiUrl },
    encoding: 'utf8',
  });
  child.child.stdin?.end(JSON.stringify(stdinObj));
  const { stdout } = await child;
  return stdout;
}

function writeAlarmHint() {
  writeFileSync(HINT_FILE, JSON.stringify({
    reason: 'server-unreachable',
    pending_bytes: 4096,
    timestamp: new Date().toISOString(),
  }));
}

function clearHint() {
  if (existsSync(HINT_FILE)) unlinkSync(HINT_FILE);
}

describe('recall hook (UserPromptSubmit) stdout contract', () => {
  it('ships recalled memory as additionalContext, NOT systemMessage', async () => {
    clearHint();
    const parsed = JSON.parse(await run(RECALL_HOOK, { user_prompt: LONG_PROMPT, cwd: tmp }));

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(SENTINEL);
    // The model-visible payload must not be parked in the operator-only field.
    expect(parsed.systemMessage).toBeUndefined();
  });

  it('keeps the operator health alarm in systemMessage with no context block', async () => {
    writeAlarmHint();
    // Below MIN_PROMPT_LEN: alarm only, no recall.
    const parsed = JSON.parse(await run(RECALL_HOOK, { user_prompt: 'hi', cwd: tmp }));

    expect(parsed.systemMessage).toContain('observation flush is failing');
    expect(parsed.hookSpecificOutput).toBeUndefined();
    clearHint();
  });

  it('separates the two channels when both fire', async () => {
    writeAlarmHint();
    const parsed = JSON.parse(await run(RECALL_HOOK, { user_prompt: LONG_PROMPT, cwd: tmp }));

    expect(parsed.systemMessage).toContain('observation flush is failing');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(SENTINEL);
    // The alarm is for the operator; it must not be duplicated into model context.
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('observation flush is failing');
    clearHint();
  });

  it('emits bare {} when there is nothing to surface', async () => {
    clearHint();
    expect(await run(RECALL_HOOK, { user_prompt: 'hi', cwd: tmp })).toBe('{}');
  });

  it('--codex emits raw text, never JSON', async () => {
    clearHint();
    const out = await run(RECALL_HOOK, { user_prompt: LONG_PROMPT, cwd: tmp }, ['--codex']);
    expect(out).toContain(SENTINEL);
    expect(out.trim().startsWith('{')).toBe(false);
  });
});

describe('session-start hook stdout contract', () => {
  it('ships session context as additionalContext, NOT systemMessage', async () => {
    // Run inside the repo so the git-context branch produces output without a server.
    const parsed = JSON.parse(await run(SESSION_HOOK, { cwd: GIT_REPO }, [], GIT_REPO));

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('SESSION CONTEXT');
    expect(parsed.systemMessage).toBeUndefined();
  });

  it('--codex emits raw text, never JSON', async () => {
    const out = await run(SESSION_HOOK, { cwd: GIT_REPO }, ['--codex'], GIT_REPO);
    expect(out).toContain('SESSION CONTEXT');
    expect(out.trim().startsWith('{')).toBe(false);
  });
});
