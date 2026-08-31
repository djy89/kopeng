/**
 * T72 — the entry-guard symlink bug.
 *
 * `npx kopeng init` exited 0 in ~76ms on macos-latest having printed nothing
 * and written no `.env`. Root cause: every entry guard in the shipped tree was
 * spelled as a direct comparison between `process.argv[1]` (the path as typed)
 * and `import.meta.url` (which Node's ESM loader has already REALPATH'd). Under
 * a symlink the two disagree, the guard reads false, `main()` never runs, and
 * the process exits 0 having done nothing. macOS `os.tmpdir()` is
 * `/var/folders/...` and `/var` is a symlink to `/private/var`, so the CI
 * sandbox hit it every time; pnpm's symlinked `node_modules` hits it on every
 * platform.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntrypoint } from '../../src/utils/entrypoint.js';
// @ts-expect-error — the hook tree is plain ESM with no type declarations by design.
import { isEntrypoint as isEntrypointHook } from '../../scripts/hooks/entrypoint.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HOOK_HELPER = path.join(REPO_ROOT, 'scripts', 'hooks', 'entrypoint.mjs');

/** The exact spelling that shipped, kept here so the bug stays demonstrable. */
function brokenGuard(importMetaUrl: string): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry.toLowerCase() === fileURLToPath(importMetaUrl).toLowerCase();
}

const originalArgv1 = process.argv[1];
const tempDirs: string[] = [];

afterEach(() => {
  process.argv[1] = originalArgv1;
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Build `<tmp>/real/mod.mjs` plus `<tmp>/link -> <tmp>/real`.
 * Returns null when the platform refuses to make the link (unprivileged
 * Windows without Developer Mode), so the suite skips instead of failing.
 */
function makeSymlinkedModule(): { realFile: string; linkedFile: string } | null {
  // realpathSync the base: on macOS the tmpdir is ITSELF symlinked, which would
  // otherwise make the "control" case indistinguishable from the bug.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kopeng-entry-')));
  tempDirs.push(base);
  const realDir = path.join(base, 'real');
  mkdirSync(realDir, { recursive: true });
  const realFile = path.join(realDir, 'mod.mjs');
  writeFileSync(realFile, 'export const marker = 1;\n');
  const linkDir = path.join(base, 'link');
  try {
    symlinkSync(realDir, linkDir, 'junction');
  } catch {
    return null;
  }
  return { realFile, linkedFile: path.join(linkDir, 'mod.mjs') };
}

describe('isEntrypoint', () => {
  it('is true when argv[1] is the module path verbatim', () => {
    process.argv[1] = fileURLToPath(import.meta.url);
    expect(isEntrypoint(import.meta.url)).toBe(true);
  });

  it('is false when argv[1] is some other file (module was imported, not run)', () => {
    process.argv[1] = path.join(REPO_ROOT, 'some', 'other', 'entry.js');
    expect(isEntrypoint(import.meta.url)).toBe(false);
  });

  it('is false when there is no argv[1] at all', () => {
    process.argv[1] = undefined as unknown as string;
    expect(isEntrypoint(import.meta.url)).toBe(false);
  });

  it('is false for a malformed module URL rather than throwing', () => {
    process.argv[1] = fileURLToPath(import.meta.url);
    expect(isEntrypoint('not-a-url')).toBe(false);
  });

  it('RED-proof: the shipped spelling breaks through a symlink, isEntrypoint does not', () => {
    const made = makeSymlinkedModule();
    if (!made) return; // platform refuses symlinks — nothing to prove here
    const { realFile, linkedFile } = made;
    // Node hands the module its REALPATH in import.meta.url...
    const metaUrl = pathToFileURL(realFile).href;
    // ...while argv[1] keeps the symlinked path the user actually typed.
    process.argv[1] = linkedFile;

    expect(brokenGuard(metaUrl)).toBe(false);   // the T72 bug, reproduced
    expect(isEntrypoint(metaUrl)).toBe(true);   // the fix
  });

  it('still resolves when argv[1] is already real but the module URL carries the link', () => {
    const made = makeSymlinkedModule();
    if (!made) return;
    process.argv[1] = made.realFile;
    expect(isEntrypoint(pathToFileURL(made.linkedFile).href)).toBe(true);
  });
});

describe('the hook-tree twin agrees with the src implementation', () => {
  it('returns the same answer for every case above', () => {
    const made = makeSymlinkedModule();
    const here = fileURLToPath(import.meta.url);
    const cases: Array<[string | undefined, string]> = [
      [here, import.meta.url],
      [path.join(REPO_ROOT, 'nope.js'), import.meta.url],
      [undefined, import.meta.url],
      [here, 'not-a-url'],
    ];
    if (made) {
      cases.push([made.linkedFile, pathToFileURL(made.realFile).href]);
      cases.push([made.realFile, pathToFileURL(made.linkedFile).href]);
    }
    for (const [argv1, metaUrl] of cases) {
      process.argv[1] = argv1 as string;
      expect(isEntrypointHook(metaUrl), `argv1=${argv1} meta=${metaUrl}`)
        .toBe(isEntrypoint(metaUrl));
    }
  });

  it('a real child process reached through a symlink runs its main()', () => {
    const made = makeSymlinkedModule();
    if (!made) return;
    const probe = path.join(path.dirname(made.realFile), 'probe.mjs');
    writeFileSync(probe,
      `import { isEntrypoint } from ${JSON.stringify(pathToFileURL(HOOK_HELPER).href)};\n` +
      `console.log(isEntrypoint(import.meta.url) ? 'MAIN_RAN' : 'MAIN_SKIPPED');\n`);
    const viaLink = path.join(path.dirname(made.linkedFile), 'probe.mjs');
    const out = execFileSync(process.execPath, [viaLink], { encoding: 'utf8' }).trim();
    expect(out).toBe('MAIN_RAN');
  });
});

/**
 * Anti-drift guard, in the house style: the broken spelling must not come back
 * anywhere in the SHIPPED tree (package.json `files` = dist + scripts/hooks +
 * scripts/viz-server.js). Any file that reasons about `argv[1]` within arm's
 * reach of `import.meta.url` is deciding entry by hand instead of calling the
 * shared helper.
 */
describe('no shipped module hand-rolls the entry guard', () => {
  const ALLOWLIST = new Set([
    // The two helpers are the one place the comparison is allowed to live.
    path.join('src', 'utils', 'entrypoint.ts'),
    path.join('scripts', 'hooks', 'entrypoint.mjs'),
  ]);

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('keeps argv[1] and import.meta.url apart outside the helpers', () => {
    const shipped = execFileSync('git', ['ls-files', 'src', 'scripts/hooks', 'scripts/viz-server.js'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    }).split('\n').filter((f) => /\.(ts|js|mjs)$/.test(f));

    expect(shipped.length).toBeGreaterThan(20); // the listing itself must not silently go empty

    const offenders: string[] = [];
    for (const rel of shipped) {
      if (ALLOWLIST.has(path.normalize(rel))) continue;
      const text = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8')).replace(/\s+/g, ' ');
      for (const match of text.matchAll(/argv\[1\]/g)) {
        const window = text.slice(Math.max(0, match.index - 160), match.index + 160);
        if (window.includes('import.meta.url')) offenders.push(rel);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
