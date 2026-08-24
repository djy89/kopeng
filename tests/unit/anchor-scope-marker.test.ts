/**
 * P4 anchor-marker scope resolution (memory-prompt-search.mjs).
 *
 * A `.kopeng.json` in a directory declares the scopes that directory belongs to;
 * the recall hook walks UP from the payload's cwd and ADDS them to the recall
 * request. Two halves are pinned here:
 *
 *   - readAnchorScopes (pure-ish, fs-only): the walk itself — marker in cwd, in an
 *     ancestor, absent, malformed — plus the fail-open and bounding guarantees.
 *   - the real hook in a child process against a stub server that CAPTURES the
 *     recall request body, so "the scopes actually reach the request" is a fact,
 *     not an inference, and the no-marker request is byte-identical to pre-P4.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../../scripts/hooks/memory-prompt-search.mjs');

const LONG_PROMPT = 'what have I been working on in this project lately';

const tmp = mkdtempSync(join(tmpdir(), 'kopeng-anchor-'));
const HINTS_DIR = join(tmp, 'hints');
// T9 (Phase 4): point the trigger-cache at a temp dir so (a) the suite never
// writes into the operator's real ~/.kopeng/cache, and (b) refresh is
// deterministically DUE for every fresh per-test project scope (no cache file
// ⇒ triggerCacheRefreshDue → true), so the trigger-cache list requests are
// always observable at the stub.
const CACHE_DIR = join(tmp, 'cache');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hook: any;

/** Every recall request body the stub server saw, oldest first. */
let recallBodies: Array<Record<string, unknown>> = [];
/** Every /api/surface request body the stub server saw, oldest first (T9). */
let surfaceBodies: Array<Record<string, unknown>> = [];
/** Every GET /api/memories list URL the stub saw — the trigger-cache refresh (T9). */
let listUrls: string[] = [];
let server: Server;
let apiUrl = '';

function makeDir(...parts: string[]): string {
  const dir = join(tmp, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker(dir: string, content: string) {
  writeFileSync(join(dir, '.kopeng.json'), content);
}

beforeAll(async () => {
  mkdirSync(HINTS_DIR, { recursive: true });
  // Safe to import: main() is behind an isMain guard.
  hook = await import('../../scripts/hooks/memory-prompt-search.mjs');

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (url.startsWith('/api/memories/recall')) {
        try { recallBodies.push(JSON.parse(body)); } catch { /* ignore */ }
        res.end(JSON.stringify({ data: [] }));
      } else if (url.startsWith('/api/surface')) {
        try { surfaceBodies.push(JSON.parse(body)); } catch { /* ignore */ }
        res.end(JSON.stringify({ data: { tools: [], skills: [], conventions: [] } }));
      } else if (url.startsWith('/api/memories?')) {
        listUrls.push(url);
        res.end(JSON.stringify({ data: [] }));
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
 * Async on purpose: the stub server runs in THIS process, so execFileSync would
 * block the event loop and every hook fetch would time out instead of being served.
 */
async function runHook(cwd: string): Promise<string> {
  const child = execFileAsync(process.execPath, [SCRIPT], {
    cwd,
    env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_API_URL: apiUrl, KOPENG_CACHE_DIR: CACHE_DIR },
    encoding: 'utf8',
  });
  child.child.stdin?.end(JSON.stringify({ user_prompt: LONG_PROMPT, cwd }));
  const { stdout } = await child;
  return stdout;
}

/** The scopes of the main (multi-scope) recall call — the tool call sends `scope`, not `scopes`. */
function lastRecallScopes(): string[] {
  const withScopes = recallBodies.filter((b) => Array.isArray(b.scopes));
  return (withScopes[withScopes.length - 1]?.scopes as string[]) ?? [];
}

describe('readAnchorScopes — the walk', () => {
  it('reads a marker in the starting directory', () => {
    const dir = makeDir('walk', 'in-cwd');
    writeMarker(dir, JSON.stringify({ scopes: ['client:northwind', 'project:fuel-dashboard'] }));

    expect(hook.readAnchorScopes(dir)).toEqual(['client:northwind', 'project:fuel-dashboard']);
  });

  it('finds a marker on an ancestor several levels up', () => {
    const root = makeDir('walk', 'ancestor');
    writeMarker(root, JSON.stringify({ scopes: ['client:acme-supply'] }));
    const deep = makeDir('walk', 'ancestor', 'a', 'b', 'c');

    expect(hook.readAnchorScopes(deep)).toEqual(['client:acme-supply']);
  });

  it('merges markers nearest-first and dedupes repeated scopes', () => {
    // The survey deliberately repeats the parent client scope at the child, so the
    // child marker is independently understandable — the merge must not double it.
    const parent = makeDir('walk', 'merge');
    writeMarker(parent, JSON.stringify({ scopes: ['client:northwind'] }));
    const child = makeDir('walk', 'merge', 'fuel');
    writeMarker(child, JSON.stringify({ scopes: ['client:northwind', 'project:fuel-dashboard'] }));

    expect(hook.readAnchorScopes(child)).toEqual(['client:northwind', 'project:fuel-dashboard']);
  });

  it('returns [] when no marker exists anywhere up the tree', () => {
    expect(hook.readAnchorScopes(makeDir('walk', 'bare', 'x', 'y'))).toEqual([]);
  });

  it('returns [] for an empty or missing cwd', () => {
    expect(hook.readAnchorScopes('')).toEqual([]);
    expect(hook.readAnchorScopes(undefined)).toEqual([]);
    expect(hook.readAnchorScopes(join(tmp, 'does', 'not', 'exist'))).toEqual([]);
  });

  it('terminates at the filesystem root without throwing', () => {
    expect(hook.readAnchorScopes(parsePath(resolve(tmp)).root)).toEqual([]);
  });
});

describe('readAnchorScopes — fail-open on bad markers', () => {
  it('skips malformed JSON instead of throwing', () => {
    const dir = makeDir('bad', 'malformed');
    writeMarker(dir, '{ "scopes": ["client:oops"'); // truncated

    expect(hook.readAnchorScopes(dir)).toEqual([]);
  });

  it('keeps walking past a malformed child marker to a good ancestor', () => {
    // The core fail-open guarantee: one broken marker must not hide a valid parent.
    const parent = makeDir('bad', 'continue');
    writeMarker(parent, JSON.stringify({ scopes: ['client:example-co'] }));
    const child = makeDir('bad', 'continue', 'broken');
    writeMarker(child, 'not json at all');

    expect(hook.readAnchorScopes(child)).toEqual(['client:example-co']);
  });

  it('ignores a marker whose scopes key is missing or not an array', () => {
    const missing = makeDir('bad', 'no-key');
    writeMarker(missing, JSON.stringify({ note: 'wrong shape' }));
    expect(hook.readAnchorScopes(missing)).toEqual([]);

    const wrongType = makeDir('bad', 'not-array');
    writeMarker(wrongType, JSON.stringify({ scopes: 'client:northwind' }));
    expect(hook.readAnchorScopes(wrongType)).toEqual([]);
  });

  it('drops non-string and blank entries, trimming the rest', () => {
    const dir = makeDir('bad', 'entries');
    writeMarker(dir, JSON.stringify({ scopes: ['  client:orchid  ', 42, null, '', '   ', 'global'] }));

    expect(hook.readAnchorScopes(dir)).toEqual(['client:orchid', 'global']);
  });

  // F-A (team round): the server sanitizes oversized entries too, but a
  // well-formed marker must never DEPEND on server tolerance — the hook drops
  // them at the source, beside its other entry filters.
  it('drops entries longer than 128 chars, keeping the valid ones', () => {
    const dir = makeDir('bad', 'oversized');
    const oversized = 'client:' + 'x'.repeat(140);
    writeMarker(dir, JSON.stringify({ scopes: [oversized, 'client:fits'] }));

    expect(hook.readAnchorScopes(dir)).toEqual(['client:fits']);
  });
});

describe('readAnchorScopes — bounds', () => {
  it('stops after maxDepth levels', () => {
    const root = makeDir('bounds', 'depth');
    writeMarker(root, JSON.stringify({ scopes: ['client:too-far'] }));
    const deep = makeDir('bounds', 'depth', 'a', 'b', 'c');

    expect(hook.readAnchorScopes(deep, { maxDepth: 2 })).toEqual([]);
    expect(hook.readAnchorScopes(deep, { maxDepth: 4 })).toEqual(['client:too-far']);
  });

  it('caps the number of scopes one tree can contribute', () => {
    const dir = makeDir('bounds', 'width');
    writeMarker(dir, JSON.stringify({ scopes: ['a', 'b', 'c', 'd', 'e'] }));

    expect(hook.readAnchorScopes(dir, { maxScopes: 3 })).toEqual(['a', 'b', 'c']);
  });
});

describe('anchor scopes through the real hook script', () => {
  it('adds declared scopes to the recall request, keeping project + global', async () => {
    const dir = makeDir('e2e', 'marked');
    writeMarker(dir, JSON.stringify({ scopes: ['client:northwind', 'project:fuel-dashboard'] }));

    recallBodies = [];
    await runHook(dir);

    expect(lastRecallScopes()).toEqual(['project:marked', 'global', 'client:northwind', 'project:fuel-dashboard']);
  });

  it('sends exactly the pre-P4 scopes when no marker exists', async () => {
    const dir = makeDir('e2e', 'unmarked');

    recallBodies = [];
    await runHook(dir);

    expect(lastRecallScopes()).toEqual(['project:unmarked', 'global']);
  });

  it('does not duplicate a marker scope that equals the cwd project scope', async () => {
    const dir = makeDir('e2e', 'selfsame');
    writeMarker(dir, JSON.stringify({ scopes: ['project:selfsame', 'client:example-co'] }));

    recallBodies = [];
    await runHook(dir);

    expect(lastRecallScopes()).toEqual(['project:selfsame', 'global', 'client:example-co']);
  });

  it('keeps the stdout contract intact with a marker present (JSON and --codex)', async () => {
    const dir = makeDir('e2e', 'shape');
    writeMarker(dir, JSON.stringify({ scopes: ['client:northwind'] }));

    // Stub returns no memories and no surface items, so the hook emits bare {}.
    expect(await runHook(dir)).toBe('{}');

    const child = execFileAsync(process.execPath, [SCRIPT, '--codex'], {
      cwd: dir,
      env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_API_URL: apiUrl, KOPENG_CACHE_DIR: CACHE_DIR },
      encoding: 'utf8',
    });
    child.child.stdin?.end(JSON.stringify({ user_prompt: LONG_PROMPT, cwd: dir }));
    const { stdout } = await child;
    expect(stdout).toBe(''); // --codex never emits JSON, and there is nothing to say
  });

  it('survives a malformed marker without breaking recall', async () => {
    const dir = makeDir('e2e', 'broken');
    writeMarker(dir, '}{ not json');

    recallBodies = [];
    const out = await runHook(dir);

    expect(out).toBe('{}');
    expect(lastRecallScopes()).toEqual(['project:broken', 'global']);
  });
});

/**
 * Task 9 (Phase 4): REQUEST shapes of the hook's other two server calls.
 * The output contract is pinned in hook-output-contract.test.ts; these pin the
 * request side — anchor scopes reach /api/surface (Task 8's `scopes` field) and
 * the trigger-cache refresh opts into alias expansion (Task 7's expand=aliases).
 */
describe('Task 9: anchor scopes to /api/surface + expand=aliases on the trigger-cache refresh', () => {
  it('sends declared anchor scopes in the /api/surface body', async () => {
    const dir = makeDir('t9', 'surface-marked');
    writeMarker(dir, JSON.stringify({ scopes: ['client:variant-x'] }));

    surfaceBodies = [];
    await runHook(dir);

    const surfaceBody = surfaceBodies[surfaceBodies.length - 1];
    expect(surfaceBody).toBeDefined();
    expect(surfaceBody.scopes).toEqual(['client:variant-x']);
    // The pre-Task-9 fields are untouched.
    expect(surfaceBody.prompt).toBe(LONG_PROMPT);
    expect(surfaceBody.project_scope).toBe('project:surface-marked');
  });

  it('a marker with an oversized scope entry sends only the valid ones to /api/surface (F-A)', async () => {
    const dir = makeDir('t9', 'surface-oversized');
    writeMarker(dir, JSON.stringify({ scopes: ['client:' + 'x'.repeat(140), 'client:valid-anchor'] }));

    surfaceBodies = [];
    await runHook(dir);

    const surfaceBody = surfaceBodies[surfaceBodies.length - 1];
    expect(surfaceBody).toBeDefined();
    expect(surfaceBody.scopes).toEqual(['client:valid-anchor']);
  });

  it('omits the scopes field entirely when no marker exists (old-server compatibility)', async () => {
    const dir = makeDir('t9', 'surface-unmarked');

    surfaceBodies = [];
    await runHook(dir);

    const surfaceBody = surfaceBodies[surfaceBodies.length - 1];
    expect(surfaceBody).toBeDefined();
    // Omitted, not sent as [] — the cleaner old-server-compatible shape.
    expect('scopes' in surfaceBody).toBe(false);
    expect(surfaceBody.prompt).toBe(LONG_PROMPT);
    expect(surfaceBody.project_scope).toBe('project:surface-unmarked');
  });

  it('adds expand=aliases to both trigger-cache list requests', async () => {
    // Fresh project scope + temp cache dir ⇒ no cache file ⇒ refresh is due,
    // so the hook fetches one lite page per scope (global + project).
    const dir = makeDir('t9', 'trigger');

    listUrls = [];
    await runHook(dir);

    const triggerUrls = listUrls.filter((u) => u.includes('fields=lite'));
    expect(triggerUrls.length).toBe(2);
    for (const u of triggerUrls) {
      expect(u).toContain('expand=aliases');
      // The pre-Task-9 params are untouched.
      expect(u).toContain('fields=lite');
      expect(u).toContain('limit=500');
    }
  });
});
