import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * Review finding 3 — `~/.kopeng/ensure.json` is an exec primitive: the
 * SessionStart hook spawns `knob.node knob.script ensure` DETACHED with stdio
 * discarded on every session start, out of a file nothing else inspects. The
 * hook now fires only for the knob `kopeng init` actually writes (this node
 * binary, a script under KOPENG_HOME) and fail-opens to today's no-op
 * otherwise. These are real child-process runs, because the thing being
 * asserted is "no process was launched" — a claim only a real spawn can make.
 *
 * Every case pins KOPENG_HOME (and HOME/USERPROFILE) at a throwaway dir, so
 * the suite can never read the operator's real knob or launch a real server.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_HOOK = resolve(HERE, '../../scripts/hooks/memory-session-start.mjs');

const execFileAsync = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), 'kopeng-knob-trust-'));

// A plain non-git cwd keeps the hook on its fully synchronous `emit({})` path:
// no git, no network, no breadcrumb — so these cases measure the knob gate and
// nothing else.
const PLAIN_CWD = join(tmp, 'plain-non-git-cwd');
mkdirSync(PLAIN_CWD, { recursive: true });

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes a fixture "ensure" CLI that records the fact it ran, and returns its path. */
function writeFixtureScript(at: string): string {
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(
    at,
    "import { writeFileSync } from 'node:fs';\n" +
    'const marker = process.env.KOPENG_TEST_ENSURE_MARKER;\n' +
    "if (marker) writeFileSync(marker, 'fired');\n"
  );
  return at;
}

function newHome(): string {
  const home = mkdtempSync(join(tmp, 'home-'));
  return home;
}

function writeKnob(kopengHome: string, knob: Record<string, unknown>): void {
  writeFileSync(join(kopengHome, 'ensure.json'), JSON.stringify(knob));
}

async function runHook(kopengHome: string, marker: string): Promise<string> {
  const child = execFileAsync(process.execPath, [SESSION_HOOK], {
    cwd: PLAIN_CWD,
    env: {
      ...process.env,
      KOPENG_HOME: kopengHome,
      HOME: kopengHome,
      USERPROFILE: kopengHome,
      KOPENG_TEST_ENSURE_MARKER: marker,
    },
    encoding: 'utf8',
  });
  child.child.stdin?.end(JSON.stringify({ cwd: PLAIN_CWD }));
  const { stdout } = await child;
  return stdout;
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return existsSync(path);
}

/** Negative assertion: give a would-be spawn the same window before declaring it absent. */
async function stayedQuiet(path: string, windowMs = 400): Promise<boolean> {
  await new Promise((r) => setTimeout(r, windowMs));
  return !existsSync(path);
}

describe('SessionStart ensure-knob trust gate (review finding 3)', () => {
  it('fires for the knob kopeng init writes: this node binary, script under KOPENG_HOME', async () => {
    const home = newHome();
    const marker = join(home, 'fired.marker');
    const script = writeFixtureScript(join(home, 'app', 'node_modules', 'kopeng', 'dist', 'cli', 'index.js'));
    writeKnob(home, { enabled: true, node: process.execPath, script });

    expect(await runHook(home, marker)).toBe('{}');
    expect(await waitForFile(marker)).toBe(true);
  });

  it('ignores a knob whose script lives outside KOPENG_HOME', async () => {
    const home = newHome();
    const marker = join(home, 'fired.marker');
    // The postinstall-foothold shape: a real, runnable script the operator
    // never installed, parked anywhere on disk.
    const script = writeFixtureScript(join(tmp, 'foreign', 'payload.mjs'));
    writeKnob(home, { enabled: true, node: process.execPath, script });

    expect(await runHook(home, marker)).toBe('{}');
    expect(await stayedQuiet(marker)).toBe(true);
  });

  it('ignores a knob that walks out of KOPENG_HOME with ..', async () => {
    const home = newHome();
    const marker = join(home, 'fired.marker');
    writeFixtureScript(join(tmp, 'foreign-traversal', 'payload.mjs'));
    // Resolves to the same escape as above, spelled to look contained.
    writeKnob(home, {
      enabled: true,
      node: process.execPath,
      script: join(home, 'app', '..', '..', 'foreign-traversal', 'payload.mjs'),
    });

    expect(await runHook(home, marker)).toBe('{}');
    expect(await stayedQuiet(marker)).toBe(true);
  });

  it('ignores a knob naming a different node binary', async () => {
    const home = newHome();
    const marker = join(home, 'fired.marker');
    const script = writeFixtureScript(join(home, 'app', 'node_modules', 'kopeng', 'dist', 'cli', 'index.js'));
    // A trusted script path is not enough — the interpreter is the executable
    // that actually runs, so it has to be ours too.
    writeKnob(home, { enabled: true, node: join(home, 'bin', 'not-node'), script });

    expect(await runHook(home, marker)).toBe('{}');
    expect(await stayedQuiet(marker)).toBe(true);
  });

  it('a rejected knob changes nothing about the hook contract (still bare {})', async () => {
    const home = newHome();
    const marker = join(home, 'fired.marker');
    writeKnob(home, { enabled: true, node: process.execPath, script: join(tmp, 'nope.mjs') });
    expect(await runHook(home, marker)).toBe('{}');
  });
});
