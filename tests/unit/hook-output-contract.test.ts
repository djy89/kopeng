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
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECALL_HOOK = resolve(HERE, '../../scripts/hooks/memory-prompt-search.mjs');
const SESSION_HOOK = resolve(HERE, '../../scripts/hooks/memory-session-start.mjs');
const SESSION_END_HOOK = resolve(HERE, '../../scripts/hooks/memory-session-end.mjs');

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
// Finding 1 fix (review round 1): a separate single-commit repo carrying a
// `.kopeng.json` `{"project":"client:acme"}` override, used by both the
// session-end breadcrumb-filename case and the session-start search-scope
// case below — kept apart from GIT_REPO so the override never leaks into the
// unmarked session-hook assertions above.
const CLIENT_MARKER_REPO = join(tmp, 'client-marker-repo');

// T57: git is NOT a declared dependency of the suite — a ZIP-download install
// has none, and the suite must skip the git-dependent cases there instead of
// failing on `spawnSync git ENOENT`. Detected once at module scope; the
// session-start describe below is gated on it (the recall-hook cases need no
// git and keep running). CI always has git (actions/checkout requires it), so
// the gated cases still execute there.
const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let server: Server | undefined;
let apiUrl = '';
/** Every recall request body the stub server saw, oldest first (RULING-C scope-derivation case). */
let recallBodies: Array<Record<string, unknown>> = [];
/** Every /api/memories/search request body the stub server saw (finding 1 fix). */
let searchBodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  mkdirSync(HINTS_DIR, { recursive: true });

  if (GIT_AVAILABLE) {
    mkdirSync(GIT_REPO, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', GIT_REPO, ...args], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'ci@runner.test');
    git('config', 'user.name', 'contract-test');
    writeFileSync(join(GIT_REPO, 'README.md'), '# fixture\n');
    git('add', '-A');
    git('commit', '-m', 'fixture commit', '--no-gpg-sign');

    mkdirSync(CLIENT_MARKER_REPO, { recursive: true });
    const gitCm = (...args: string[]) =>
      execFileSync('git', ['-C', CLIENT_MARKER_REPO, ...args], { stdio: 'ignore' });
    gitCm('init', '-b', 'main');
    gitCm('config', 'user.email', 'ci@runner.test');
    gitCm('config', 'user.name', 'contract-test');
    writeFileSync(join(CLIENT_MARKER_REPO, 'README.md'), '# fixture\n');
    gitCm('add', '-A');
    gitCm('commit', '-m', 'fixture commit', '--no-gpg-sign');
    writeFileSync(join(CLIENT_MARKER_REPO, '.kopeng.json'), JSON.stringify({ project: 'client:acme' }));
  }
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (url.startsWith('/api/memories/recall')) {
        try { recallBodies.push(JSON.parse(body)); } catch { /* ignore */ }
        res.end(JSON.stringify({ data: [{ id: 1, type: 'project', content: SENTINEL, tags: [] }] }));
      } else if (url.startsWith('/api/memories/search')) {
        try { searchBodies.push(JSON.parse(body)); } catch { /* ignore */ }
        res.end(JSON.stringify({ data: [] }));
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
  // Defensive: if beforeAll ever fails before the server is assigned, this
  // must not add a second, misleading failure on top of the real one (T57).
  const s = server;
  if (!s) return;
  await new Promise<void>((r) => s.close(() => r()));
});

const execFileAsync = promisify(execFile);

// Task 2.3.4 safety: the session-start hook now ALSO reads
// ~/.kopeng/ensure.json (honoring a KOPENG_HOME override, same convention as
// src/cli/paths.ts) to decide whether to fire a fire-and-forget `kopeng
// ensure` spawn. Every hook invocation in this file must be sandboxed away
// from whatever the real machine's KOPENG_HOME happens to hold — this repo's
// own environment rule is zero real spawns in tests. ENSURE_HOME_DEFAULT has
// no ensure.json in it, so it's the "knob absent" case for every test that
// doesn't explicitly write one.
const ENSURE_HOME_DEFAULT = join(tmp, 'kopeng-home-no-knob');
mkdirSync(ENSURE_HOME_DEFAULT, { recursive: true });

// A plain, non-git cwd — the session-start hook's byte-identical no-op path
// (`emit({})`) doesn't depend on git at all, so the ensure-knob tests below
// run unconditionally (not gated on GIT_AVAILABLE like the session-start
// git-context describe block).
const PLAIN_CWD = join(tmp, 'plain-non-git-cwd');
mkdirSync(PLAIN_CWD, { recursive: true });

// Tiny fixture "ensure" script: writes a marker file named by an env var,
// so a test can prove the hook's fire-and-forget spawn actually launched a
// process without asserting anything about the real `kopeng ensure` CLI.
const ENSURE_FIXTURE_SCRIPT = join(tmp, 'ensure-fixture.mjs');
writeFileSync(
  ENSURE_FIXTURE_SCRIPT,
  "import { writeFileSync } from 'node:fs';\n" +
  'const marker = process.env.KOPENG_TEST_ENSURE_MARKER;\n' +
  "if (marker) writeFileSync(marker, 'fired');\n"
);

async function waitForFile(path: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return existsSync(path);
}

/**
 * Async on purpose: the stub server runs in THIS process, so a synchronous
 * execFileSync would block the event loop and the hook's fetch would always
 * time out instead of being served.
 */
async function run(
  script: string,
  stdinObj: unknown,
  extraArgs: string[] = [],
  cwd = tmp,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const child = execFileAsync(process.execPath, [script, ...extraArgs], {
    cwd,
    env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_API_URL: apiUrl, KOPENG_HOME: ENSURE_HOME_DEFAULT, ...extraEnv },
    encoding: 'utf8',
  });
  child.child.stdin?.end(JSON.stringify(stdinObj));
  const { stdout } = await child;
  return stdout;
}

/**
 * Finding 1 fix: the session hooks resolve breadcrumb paths off `os.homedir()`
 * directly (no env override like KOPENG_HINTS_DIR), so a real spawn without a
 * sandboxed HOME would touch the operator's actual ~/.claude/session-data.
 * `os.homedir()` reads HOME/USERPROFILE, so overriding both redirects it.
 */
async function runWithHome(script: string, stdinObj: unknown, homeDir: string): Promise<string> {
  const child = execFileAsync(process.execPath, [script], {
    cwd: tmp,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, KOPENG_API_URL: apiUrl, KOPENG_HOME: ENSURE_HOME_DEFAULT },
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

  // RULING-C (WS7.6): pure-fs fabrication (no git binary) — runs unconditionally,
  // never gated on GIT_AVAILABLE, unlike the session-start describe below.
  it('derives project:<owner>-<repo> from a fabricated git remote', async () => {
    clearHint();
    const remoteDir = join(tmp, 'remote-derived-cwd');
    const gitDir = join(remoteDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/api.git\n'
    );

    recallBodies = [];
    await run(RECALL_HOOK, { user_prompt: LONG_PROMPT, cwd: remoteDir });

    const withScopes = recallBodies.filter((b) => Array.isArray(b.scopes));
    const scopes = withScopes[withScopes.length - 1]?.scopes as string[] | undefined;
    expect(scopes).toBeDefined();
    expect(scopes).toContain('project:acme-api');
  });
});

// skipIf, not silent absence: on a gitless install these report as SKIPPED in
// vitest's output (the T57 done-when), and still RUN wherever git exists.
describe.skipIf(!GIT_AVAILABLE)('session-start hook stdout contract', () => {
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

  // Finding 1 (review round 1): a `.kopeng.json` `{"project":"client:acme"}` override
  // must produce a Windows-safe, folded breadcrumb filename — not the literal
  // "client:acme" (a colon is invalid in a Windows filename, so writeFileSync would
  // throw and the existing fail-open catch would swallow it, killing the feature
  // silently for that directory).
  it('a client: marker override writes a Windows-safe, folded breadcrumb filename', async () => {
    const sandboxHome = mkdtempSync(join(tmpdir(), 'kopeng-session-home-'));
    try {
      await runWithHome(SESSION_END_HOOK, { cwd: CLIENT_MARKER_REPO }, sandboxHome);
      const sessionDataDir = join(sandboxHome, '.claude', 'session-data');
      const files = readdirSync(sessionDataDir);
      // Folded form of "client:acme" stripped of its prefix is exactly "acme" —
      // no colon, no leftover prefix.
      expect(files).toEqual(['acme.last-session.json']);
      const breadcrumb = JSON.parse(readFileSync(join(sessionDataDir, 'acme.last-session.json'), 'utf8'));
      expect(breadcrumb.project).toBe('acme');
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  // Finding 1 (review round 1): the search call must use the OVERRIDE scope
  // verbatim (`client:acme`), never re-wrapped into the malformed
  // `project:client:acme` the old `project:${project}` reconstruction produced.
  it('a client: marker override reaches the search request as the scope verbatim', async () => {
    // Sandboxed HOME so the hook's breadcrumb READ (part of the same isGit
    // branch that fires the search) never touches the real ~/.claude — isolation,
    // not an assertion; this test only cares about the search request body.
    const sandboxHome = mkdtempSync(join(tmpdir(), 'kopeng-session-home-'));
    try {
      searchBodies = [];
      await runWithHome(SESSION_HOOK, { cwd: CLIENT_MARKER_REPO }, sandboxHome);

      expect(searchBodies.length).toBeGreaterThan(0);
      for (const body of searchBodies) {
        expect(body.scope).toBe('client:acme');
      }
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  });
});

// Task 2.3.4 — the SessionStart hook's `kopeng ensure` fire-and-forget knob.
// Runs unconditionally (no git needed — the non-git `emit({})` path is what
// proves the stdout contract is unchanged either way).
describe('SessionStart ensure-knob fire-and-forget (Task 2.3.4)', () => {
  it('no knob file: byte-identical output, nothing to prove beyond the existing contract', async () => {
    // ENSURE_HOME_DEFAULT (wired into run()'s default env) has no ensure.json —
    // this is the same "knob absent" case every other test in this file already
    // exercises, restated here for the record next to its sibling cases below.
    const out = await run(SESSION_HOOK, { cwd: PLAIN_CWD }, [], PLAIN_CWD);
    expect(out).toBe('{}');
  });

  it('a present + enabled knob fires the spawn (fixture marker appears) AND stdout is unchanged', async () => {
    const ensureHome = mkdtempSync(join(tmpdir(), 'kopeng-ensure-knob-'));
    const marker = join(ensureHome, 'fired.marker');
    // Premise changed (review finding 3): the hook now fires only a knob whose
    // script resolves UNDER KOPENG_HOME, so the shared fixture has to be copied
    // into this sandbox home — pointing at it in `tmp` would be refused by the
    // trust gate and this case would test the refusal, not the spawn.
    const script = join(ensureHome, 'ensure-fixture.mjs');
    copyFileSync(ENSURE_FIXTURE_SCRIPT, script);
    writeFileSync(join(ensureHome, 'ensure.json'), JSON.stringify({
      enabled: true,
      node: process.execPath,
      script,
    }));
    try {
      const out = await run(SESSION_HOOK, { cwd: PLAIN_CWD }, [], PLAIN_CWD, {
        KOPENG_HOME: ensureHome,
        KOPENG_TEST_ENSURE_MARKER: marker,
      });

      // The hook's own stdout contract is byte-identical to the no-knob case —
      // firing ensure must never change what the model/operator sees.
      expect(out).toBe('{}');
      expect(await waitForFile(marker)).toBe(true);
    } finally {
      rmSync(ensureHome, { recursive: true, force: true });
    }
  });

  it('enabled: false does not fire the spawn', async () => {
    const ensureHome = mkdtempSync(join(tmpdir(), 'kopeng-ensure-knob-'));
    const marker = join(ensureHome, 'fired.marker');
    writeFileSync(join(ensureHome, 'ensure.json'), JSON.stringify({
      enabled: false,
      node: process.execPath,
      script: ENSURE_FIXTURE_SCRIPT,
    }));
    try {
      const out = await run(SESSION_HOOK, { cwd: PLAIN_CWD }, [], PLAIN_CWD, {
        KOPENG_HOME: ensureHome,
        KOPENG_TEST_ENSURE_MARKER: marker,
      });
      expect(out).toBe('{}');
      // No polling wait needed for a negative: give it the same window anyway
      // so a slow false-positive spawn can't sneak past a fast assertion.
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(ensureHome, { recursive: true, force: true });
    }
  });

  it('malformed knob JSON: no crash, output unchanged', async () => {
    const ensureHome = mkdtempSync(join(tmpdir(), 'kopeng-ensure-knob-'));
    writeFileSync(join(ensureHome, 'ensure.json'), '{ not valid json');
    try {
      const out = await run(SESSION_HOOK, { cwd: PLAIN_CWD }, [], PLAIN_CWD, { KOPENG_HOME: ensureHome });
      expect(out).toBe('{}');
    } finally {
      rmSync(ensureHome, { recursive: true, force: true });
    }
  });

  // Premise changed (review finding 3): this case used to name a nonexistent
  // `node` binary to prove the hook survives spawn()'s ASYNCHRONOUS ENOENT.
  // The trust gate now refuses any knob whose node isn't process.execPath, so
  // that spawn never happens and the old assertions passed for a reason
  // unrelated to their name. What is true and worth pinning now is the
  // REFUSAL itself: a foreign interpreter launches nothing, and the hook's
  // output contract is untouched either way. (The async-error listener in
  // maybeFireEnsure stays — it still guards resource-exhaustion classes like
  // EMFILE — but a bad node path can no longer reach it through the knob.)
  // GIT_REPO on purpose: its recall search awaits a real fetch, so anything
  // the hook left pending has a tick to surface; a crash would make `run()`
  // REJECT on the non-zero exit and fail this test.
  it.skipIf(!GIT_AVAILABLE)('refuses a knob naming a foreign node binary — nothing launched, output unchanged', async () => {
    const ensureHome = mkdtempSync(join(tmpdir(), 'kopeng-ensure-knob-'));
    const marker = join(ensureHome, 'fired.marker');
    // A perfectly good script under KOPENG_HOME: the interpreter is the only
    // thing wrong, and it is enough to stand the whole spawn down.
    const script = join(ensureHome, 'ensure-fixture.mjs');
    copyFileSync(ENSURE_FIXTURE_SCRIPT, script);
    writeFileSync(join(ensureHome, 'ensure.json'), JSON.stringify({
      enabled: true,
      node: join(ensureHome, 'this-node-binary-does-not-exist'),
      script,
    }));
    try {
      const out = await run(SESSION_HOOK, { cwd: GIT_REPO }, [], GIT_REPO, {
        KOPENG_HOME: ensureHome,
        KOPENG_TEST_ENSURE_MARKER: marker,
      });
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('SESSION CONTEXT');
      expect(parsed.systemMessage).toBeUndefined();
      // The gate ran BEFORE spawn: no child, so no marker.
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(ensureHome, { recursive: true, force: true });
    }
  });

  // The surviving half of the retired ENOENT case: a knob that legitimately
  // PASSES the trust gate and spawns, whose child then dies on its own (the
  // script is missing, so node exits non-zero a tick later). The hook must
  // still finish its own turn normally — a fire-and-forget child's failure is
  // never the hook's problem. GIT_REPO again, for the same yielding reason.
  it.skipIf(!GIT_AVAILABLE)('a trusted knob whose spawned child fails does not disturb the hook', async () => {
    const ensureHome = mkdtempSync(join(tmpdir(), 'kopeng-ensure-knob-'));
    writeFileSync(join(ensureHome, 'ensure.json'), JSON.stringify({
      enabled: true,
      node: process.execPath,
      script: join(ensureHome, 'never-installed-cli.js'),
    }));
    try {
      const out = await run(SESSION_HOOK, { cwd: GIT_REPO }, [], GIT_REPO, { KOPENG_HOME: ensureHome });
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('SESSION CONTEXT');
      expect(parsed.systemMessage).toBeUndefined();
    } finally {
      rmSync(ensureHome, { recursive: true, force: true });
    }
  });
});

// Ecosystem delta (SessionEnd budget note): SessionEnd hooks share a ~1.5s
// budget per current Claude Code docs. memory-session-end.mjs does no
// network I/O at all (it only writes a local breadcrumb), so this is really
// a git-latency check — pinned here so a future regression that adds a slow
// call to this hook fails loudly instead of silently eating the shared budget.
describe.skipIf(!GIT_AVAILABLE)('SessionEnd budget (ecosystem delta)', () => {
  it('completes well under the 1.5s SessionEnd budget', async () => {
    const start = Date.now();
    await run(SESSION_END_HOOK, { cwd: GIT_REPO }, [], GIT_REPO);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
  });
});
