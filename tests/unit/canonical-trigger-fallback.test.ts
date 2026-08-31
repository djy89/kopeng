/**
 * T32 — mid-turn injection blind spot: guard-side trigger-term fallback.
 *
 * The recall hook is UserPromptSubmit-only, so a mid-turn injected message never
 * arms ~/.kopeng/hints/canonical_path.json and the WebSearch/WebFetch guard stayed
 * dark (the incident that motivated T32, 2026-07-11). These tests prove the fallback:
 * with NO pre-armed hint, an "acme"-bearing WebSearch is denied straight off the
 * cached trigger-term index, the deny self-arms the standard hint (so the existing
 * observe-hook read-to-unlock clears it), a cooldown bounds re-denies, and every
 * failure mode falls OPEN (allow).
 *
 * Child-process pattern mirrors tests/unit/recall-hook-alarm.test.ts: the real
 * hook scripts run under an isolated KOPENG_HINTS_DIR / KOPENG_CACHE_DIR /
 * KOPENG_BUFFER_DIR. The recall-hook writer side runs against an in-test HTTP
 * server (async execFile — execFileSync would block the server's event loop).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '../../scripts/hooks/canonical-path-guard.mjs');
const OBSERVE = resolve(HERE, '../../scripts/hooks/kopeng-observe.js');
const RECALL = resolve(HERE, '../../scripts/hooks/memory-prompt-search.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'kopeng-t32-'));
const HINTS_DIR = join(tmp, 'hints');
const CACHE_DIR = join(tmp, 'cache');
const BUFFER_DIR = join(tmp, 'buffer');
const HINT_FILE = join(HINTS_DIR, 'canonical_path.json');
const STATE_FILE = join(HINTS_DIR, 'canonical_fallback_state.json');

// Must be a REAL absolute path on the host OS, outside any git repo, and it must
// exist. It was `'C:/tmp/projX'` until WS0, which is absolute only on Windows —
// on POSIX it is a RELATIVE path (a dir literally named `C:`), so it resolved
// inside the repo checkout. That was harmless while the scope was just
// basename(cwd), but WS7.6 made deriveProjectScope walk UP for `.git/config`:
// on Linux the walk climbed out of the fake path into the real repo and returned
// the repo's own `project:<owner>-<repo>` instead of `project:projX`. The cache
// was then written under a different filename (ENOENT) and the guard never
// matched the project, so it emitted nothing and parseDeny died on empty input —
// green on Windows, six failures on Linux CI. Keep this derived from tmpdir().
const PROJECT_CWD = join(tmp, 'projX');
const PROJECT_SCOPE = 'project:projX';
const CACHE_FILE = join(CACHE_DIR, 'canonical_triggers_project_projX.json');
const SESSION = 'sessA';
const CRITICAL_FILE = join(HINTS_DIR, `critical_${SESSION}.json`);

// A #3892-shaped canonical path — synthetic fixture (Windows backslash form).
const CANON_PATH = 'C:\\Users\\example\\Projects\\acme-design-system';
const CANON_CONTENT =
  `Acme DS ALWAYS refers to the operator's internal design system at ${CANON_PATH} — never a similarly named public library. Read it before any web search.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let triggers: any;

beforeAll(async () => {
  mkdirSync(HINTS_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(BUFFER_DIR, { recursive: true });
  // The fake project dir must exist: the hooks resolve their scope by walking UP
  // from cwd, and the walk should terminate in tmpdir() with no `.git` above it.
  mkdirSync(PROJECT_CWD, { recursive: true });
  // The module resolves KOPENG_CACHE_DIR at load — set it BEFORE the dynamic
  // import so the in-process pure tests read/write the isolated tmp cache.
  process.env.KOPENG_CACHE_DIR = CACHE_DIR;
  // Safe to import: pure module, no main().
  triggers = await import('../../scripts/hooks/canonical-triggers.mjs');
});

function fixtureEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 3892,
    scope: 'global',
    type: 'reference',
    terms: ['acme'],
    paths: [CANON_PATH],
    excerpt: CANON_CONTENT.slice(0, 100),
    critical: true,
    ...overrides,
  };
}

function writeCache(entries: unknown[], fetchedAt = new Date().toISOString()) {
  writeFileSync(CACHE_FILE, JSON.stringify({ fetched_at: fetchedAt, project: PROJECT_SCOPE, entries }));
}

function clean(...files: string[]) {
  for (const f of files) { if (existsSync(f)) unlinkSync(f); }
}

/** Run the guard as Claude Code would. Allow = empty stdout; deny = JSON on stdout. */
function runGuard(stdinObj: unknown, env: Record<string, string | undefined> = {}): string {
  const base = { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_CACHE_DIR: CACHE_DIR, ...env };
  delete base.CLAUDE_CWD;
  delete base.CLAUDE_SESSION_ID;
  delete base.CLAUDE_CODE_SESSION_ID;
  return execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify(stdinObj),
    env: base,
    encoding: 'utf8',
  });
}

function webSearch(query: string, session = SESSION) {
  return { tool_name: 'WebSearch', tool_input: { query }, session_id: session, cwd: PROJECT_CWD };
}

function parseDeny(out: string) {
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return String(parsed.hookSpecificOutput.permissionDecisionReason);
}

// ── Pure: trigger-index build + match ────────────────────────────────────────

describe('extractTriggerEntry / buildTriggerEntries (pure)', () => {
  const memory = {
    id: 3892,
    scope: 'global',
    content: CANON_CONTENT,
    metadata: JSON.stringify({ trigger_terms: ['Acme'] }),
  };

  it('builds an entry from a qualifying memory (metadata as JSON string)', () => {
    const e = triggers.extractTriggerEntry(memory);
    expect(e).not.toBeNull();
    expect(e.id).toBe(3892);
    expect(e.terms).toEqual(['acme']); // lowercased
    expect(e.paths).toEqual([CANON_PATH]);
    expect(e.critical).toBe(true); // SOT phrasing points AT the path
  });

  it('accepts metadata as an object (PG jsonb shape)', () => {
    const e = triggers.extractTriggerEntry({ ...memory, metadata: { trigger_terms: ['acme'] } });
    expect(e?.terms).toEqual(['acme']);
  });

  it('rejects memories without trigger_terms, SOT phrasing, or a path', () => {
    expect(triggers.extractTriggerEntry({ ...memory, metadata: '{}' })).toBeNull();
    expect(triggers.extractTriggerEntry({ ...memory, content: `Some note about ${CANON_PATH}` })).toBeNull();
    expect(triggers.extractTriggerEntry({ ...memory, content: 'Acme DS ALWAYS refers to the design system.' })).toBeNull();
  });

  it('drops too-short terms and dedups; caps the entry list', () => {
    const e = triggers.extractTriggerEntry({ ...memory, metadata: { trigger_terms: ['ac', 'ACME', 'acme '] } });
    expect(e?.terms).toEqual(['acme']);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...memory, id: i + 1 }));
    expect(triggers.buildTriggerEntries(many)).toHaveLength(50);
    // dedup by id
    expect(triggers.buildTriggerEntries([memory, memory])).toHaveLength(1);
  });
});

describe('matchTrigger (pure)', () => {
  const entries = [fixtureEntry()];

  it('matches a word-bounded term case-insensitively inside stringified input', () => {
    const text = JSON.stringify({ query: 'skin ableton to look like Acme UI' });
    const m = triggers.matchTrigger(entries, text, PROJECT_SCOPE);
    expect(m?.term).toBe('acme');
  });

  it('does not match inside a longer word', () => {
    expect(triggers.matchTrigger(entries, 'pacme systems review', PROJECT_SCOPE)).toBeNull();
    expect(triggers.matchTrigger(entries, 'acmestation', PROJECT_SCOPE)).toBeNull();
  });

  it('honors scope: project entries only match their own project; global matches anywhere', () => {
    const projEntry = [fixtureEntry({ scope: 'project:other' })];
    expect(triggers.matchTrigger(projEntry, 'acme', PROJECT_SCOPE)).toBeNull();
    expect(triggers.matchTrigger(projEntry, 'acme', 'project:other')).not.toBeNull();
    expect(triggers.matchTrigger(entries, 'acme', 'project:anything')).not.toBeNull();
  });
});

// ── Guard fallback: the simulated injected-message flow ─────────────────────

describe('canonical-path-guard trigger-term fallback (child process)', () => {
  beforeEach(() => {
    clean(HINT_FILE, STATE_FILE, CRITICAL_FILE);
    writeCache([fixtureEntry()]);
  });

  it('ACCEPTANCE 1: no armed hint (mid-turn injection) — an "acme" WebSearch is denied naming the canonical path', () => {
    const reason = parseDeny(runGuard(webSearch('skin ableton to look like acme ui')));
    expect(reason).toContain(CANON_PATH);
    expect(reason).toContain('acme');
    expect(reason).toContain('trigger-term fallback');

    // The deny SELF-ARMS the standard hint so the existing window machinery owns escape.
    const hint = JSON.parse(readFileSync(HINT_FILE, 'utf8'));
    expect(hint.source).toBe('trigger_fallback');
    expect(hint.paths).toEqual([CANON_PATH]);
    expect(hint.session_id).toBe(SESSION);
    expect(hint.project).toBe(PROJECT_SCOPE);

    // Cooldown window recorded per (session, memory).
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    expect(state[`${SESSION}|3892`]).toBeTruthy();

    // (c) critical entry also arms the T29 turn gate for this session.
    const crit = JSON.parse(readFileSync(CRITICAL_FILE, 'utf8'));
    expect(crit.session_id).toBe(SESSION);
    expect(crit.items).toHaveLength(1);
    expect(crit.items[0]).toMatchObject({ id: 3892, memory_type: 'reference', consulted: false, nudged: false });
    expect(crit.items[0].referents).toEqual([CANON_PATH]);
  });

  it('repeat search inside the armed window is still denied (armed-hint path)', () => {
    parseDeny(runGuard(webSearch('what is acme')));
    const reason = parseDeny(runGuard(webSearch('what is acme')));
    expect(reason).toContain(CANON_PATH);
    expect(reason).toContain('trigger-term fallback'); // armed-via-fallback wording, not "surfaced in recall"
  });

  it('ACCEPTANCE 2: read-to-unlock — touching the path via the observe hook clears the denial and the cooldown holds', () => {
    parseDeny(runGuard(webSearch('what is acme ui')));
    expect(existsSync(HINT_FILE)).toBe(true);

    // The REAL observe hook (tool_start) sees a Read inside the canonical dir.
    execFileSync(process.execPath, [OBSERVE, 'tool_start'], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: `${CANON_PATH}\\tokens.json` },
        session_id: SESSION,
        cwd: PROJECT_CWD,
      }),
      env: {
        ...process.env,
        KOPENG_HINTS_DIR: HINTS_DIR,
        KOPENG_BUFFER_DIR: BUFFER_DIR,
        KOPENG_API_URL: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
    });

    expect(existsSync(HINT_FILE)).toBe(false); // read-to-unlock cleared the window
    const crit = JSON.parse(readFileSync(CRITICAL_FILE, 'utf8'));
    expect(crit.items[0].consulted).toBe(true); // T29 touch path also satisfied

    // Post-touch, term searches pass (cooldown — no immediate re-deny loop).
    expect(runGuard(webSearch('acme design tokens best practice'))).toBe('');
  });

  it('cooldown expiry re-opens exactly one new deny-window', () => {
    parseDeny(runGuard(webSearch('acme?')));
    clean(HINT_FILE); // window expired/cleared
    expect(runGuard(webSearch('acme again'))).toBe(''); // inside cooldown → allow
    writeFileSync(STATE_FILE, JSON.stringify({ [`${SESSION}|3892`]: new Date(Date.now() - 31 * 60_000).toISOString() }));
    parseDeny(runGuard(webSearch('acme once more'))); // cooldown lapsed → new window
  });

  it('unrelated searches are never fallback-blocked', () => {
    expect(runGuard(webSearch('best midi controllers 2026'))).toBe('');
  });

  it('a different project does not match a project-scoped entry', () => {
    writeCache([fixtureEntry({ scope: 'project:other' })]);
    expect(runGuard(webSearch('acme ui'))).toBe('');
  });

  it('non-web tools pass through untouched', () => {
    const out = runGuard({ tool_name: 'Read', tool_input: { file_path: 'x' }, session_id: SESSION, cwd: PROJECT_CWD });
    expect(out).toBe('');
  });
});

// ── Fail-open proofs ─────────────────────────────────────────────────────────

describe('fallback fail-open (child process)', () => {
  beforeEach(() => {
    clean(HINT_FILE, STATE_FILE, CRITICAL_FILE, CACHE_FILE);
  });

  it('missing cache file ⇒ allow', () => {
    expect(runGuard(webSearch('acme ui'))).toBe('');
  });

  it('corrupt cache JSON ⇒ allow', () => {
    writeFileSync(CACHE_FILE, 'not json {{{');
    expect(runGuard(webSearch('acme ui'))).toBe('');
  });

  it('malformed entries ⇒ allow (shape-checked out)', () => {
    writeCache([{ id: 1, scope: 'global', terms: 'acme', paths: [] }, 42, null]);
    expect(runGuard(webSearch('acme ui'))).toBe('');
  });

  it('stale cache (past the guard trust window) ⇒ allow', () => {
    writeCache([fixtureEntry()], new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    expect(runGuard(webSearch('acme ui'))).toBe('');
  });

  it('unreadable cache dir (path is a file) ⇒ allow', () => {
    const bogus = join(tmp, 'cache-as-file');
    writeFileSync(bogus, 'i am a file, not a directory');
    expect(runGuard(webSearch('acme ui'), { KOPENG_CACHE_DIR: bogus })).toBe('');
  });

  it('no cwd on stdin or env ⇒ allow (no project identity, fail open)', () => {
    writeFileSync(join(CACHE_DIR, 'canonical_triggers_project_.json'), JSON.stringify({
      fetched_at: new Date().toISOString(), entries: [fixtureEntry()],
    }));
    const out = runGuard({ tool_name: 'WebSearch', tool_input: { query: 'acme ui' }, session_id: SESSION });
    expect(out).toBe('');
  });

  it('garbage stdin ⇒ allow', () => {
    const out = execFileSync(process.execPath, [GUARD], {
      input: 'not json',
      env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_CACHE_DIR: CACHE_DIR },
      encoding: 'utf8',
    });
    expect(out).toBe('');
  });
});

// ── Recall-hook writer side (arming the index) ───────────────────────────────

describe('memory-prompt-search trigger-cache refresh (child process + local server)', () => {
  let server: Server;
  let port = 0;
  let listGets = 0;
  const WRITER_CACHE_DIR = join(tmp, 'cache-writer');
  const WRITER_CACHE_FILE = join(WRITER_CACHE_DIR, 'canonical_triggers_project_projX.json');

  beforeAll(async () => {
    mkdirSync(WRITER_CACHE_DIR, { recursive: true });
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && url.pathname === '/api/memories') {
        listGets++;
        const scope = url.searchParams.get('scope');
        const data = scope === 'global'
          ? [{
              id: 3892,
              scope: 'global',
              type: 'reference',
              content: CANON_CONTENT,
              metadata: JSON.stringify({ trigger_terms: ['acme'] }),
              embedding: null,
            }]
          : [];
        res.end(JSON.stringify({ data, meta: {} }));
        return;
      }
      // recall + surface: empty results
      res.end(JSON.stringify({ data: url.pathname === '/api/surface' ? { tools: [], skills: [], conventions: [] } : [] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  async function runWithStdin(extraArgs: string[] = [], env: Record<string, string> = {}) {
    const child = execFile(process.execPath, [RECALL, ...extraArgs], {
      env: {
        ...process.env,
        KOPENG_API_URL: `http://127.0.0.1:${port}`,
        KOPENG_HINTS_DIR: HINTS_DIR,
        KOPENG_CACHE_DIR: WRITER_CACHE_DIR,
        ...env,
      },
    });
    const out: Promise<string> = new Promise((resolveOut, rejectOut) => {
      let buf = '';
      child.stdout?.on('data', (d) => { buf += d; });
      child.on('close', () => resolveOut(buf));
      child.on('error', rejectOut);
    });
    child.stdin?.end(JSON.stringify({
      user_prompt: 'a prompt comfortably above the minimum length gate for recall',
      cwd: PROJECT_CWD,
      session_id: 'sessB',
    }));
    return out;
  }

  it('refresh-due prompt fetches lite pages and writes the trigger index', async () => {
    rmSync(WRITER_CACHE_FILE, { force: true });
    const out = await runWithStdin();
    expect(out).toBe('{}'); // nothing surfaced — recall/surface empty
    const cache = JSON.parse(readFileSync(WRITER_CACHE_FILE, 'utf8'));
    expect(cache.entries).toHaveLength(1);
    expect(cache.entries[0]).toMatchObject({ id: 3892, terms: ['acme'], critical: true });
    expect(cache.entries[0].paths).toEqual([CANON_PATH]);
  });

  it('a fresh cache suppresses the refresh (stale-while-revalidate gate)', async () => {
    const before = listGets;
    const out = await runWithStdin();
    expect(out).toBe('{}');
    expect(listGets).toBe(before); // no new /api/memories fetches
  });

  it('--codex output shape is untouched (plain text, empty here — never JSON)', async () => {
    const out = await runWithStdin(['--codex']);
    expect(out).toBe('');
  });

  it('server down ⇒ exits clean, cache NOT overwritten with emptiness', async () => {
    const good = readFileSync(WRITER_CACHE_FILE, 'utf8');
    // Force refresh-due by aging the cache stamp, then point at a dead port.
    const parsed = JSON.parse(good);
    parsed.fetched_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(WRITER_CACHE_FILE, JSON.stringify(parsed));
    const out = await runWithStdin([], { KOPENG_API_URL: 'http://127.0.0.1:9' });
    expect(out).toBe('{}');
    const after = JSON.parse(readFileSync(WRITER_CACHE_FILE, 'utf8'));
    expect(after.entries).toHaveLength(1); // good entries preserved
  });

  it('triggerCacheRefreshDue: due when missing or past 80% of TTL, not due when fresh', async () => {
    // In-process import shares the already-loaded canonical-triggers module,
    // whose KOPENG_CACHE_DIR was pinned to the tmp cache in beforeAll.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook: any = await import('../../scripts/hooks/memory-prompt-search.mjs');
    rmSync(CACHE_FILE, { force: true });
    expect(hook.triggerCacheRefreshDue(PROJECT_SCOPE)).toBe(true); // missing
    writeCache([fixtureEntry()]);
    expect(hook.triggerCacheRefreshDue(PROJECT_SCOPE)).toBe(false); // fresh
    writeCache([fixtureEntry()], new Date(Date.now() - 9 * 60_000).toISOString());
    expect(hook.triggerCacheRefreshDue(PROJECT_SCOPE)).toBe(true); // 9 min > 80% of 10-min TTL
    writeFileSync(CACHE_FILE, 'corrupt');
    expect(hook.triggerCacheRefreshDue(PROJECT_SCOPE)).toBe(true); // corrupt ⇒ refresh
    rmSync(CACHE_FILE, { force: true });
  });
});
