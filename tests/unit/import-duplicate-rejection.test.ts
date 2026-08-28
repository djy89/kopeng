/**
 * Fail-open regression net for the embedding-model load (stranger-install
 * finding #2, 2026-08-26).
 *
 * On a machine without the VC++ Redistributable, onnxruntime-node's native
 * binding fails to dlopen. `initEmbedder()` is deliberately fired without
 * awaiting in `main()`, with a `.catch` that logs "Continuing with keyword-only
 * search" — the designed degradation. The server logged exactly that and then
 * died anyway, exit 1, `triggerUncaughtException ... fromPromise: true`.
 *
 * Root cause: on Node <= 20, when a CommonJS dependency throws while an
 * ESM graph is being linked, Node rejects TWO promises with the SAME error
 * object — the one `import()` returns (ours, caught) and an internal
 * module-job promise no caller can reach. With no `unhandledRejection`
 * listener registered, that unreachable twin is fatal. Node 22 does not
 * emit it. Attaching another `.catch` to the promise `import()` returned
 * does NOT suppress it; it is a different promise.
 *
 * `importWithoutDuplicateRejection` absorbs ONLY a rejection whose reason is
 * identical (===) to the error the wrapped import already reported, and
 * preserves Node's fail-fast default for everything else.
 *
 * The child-process cases are the real pin: they assert the PROCESS survives,
 * which cannot be observed from inside the test process. CI runs `npm run
 * build` before the suite on Node 20 — the affected version — so these
 * genuinely exercise the bug there rather than passing vacuously.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { importWithoutDuplicateRejection } from '../../src/utils/import-safely.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

/** The compiled helper the spawned children import. Present in CI (build runs first). */
const DIST_HELPER = resolve(HERE, '../../dist/utils/import-safely.js');
const DIST_BUILT = existsSync(DIST_HELPER);

// The public-export gate scans file TEXT for relative import specifiers, so a
// literal './...' inside the fixture sources below would read as this test file
// importing modules that are not in the published cut. Assemble them at runtime
// — the same reason the scrubber fixtures assemble credential prefixes.
const BOOM_CJS = ['.', '/boom.cjs'].join('');
const ESM_BOOM = ['.', '/esm-boom.mjs'].join('');

const tmp = mkdtempSync(join(tmpdir(), 'kopeng-import-guard-'));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// A CJS module that throws on load, imported statically by an ESM module: the
// exact shape of `@xenova/transformers` -> `onnxruntime-node` -> binding.node.
// Reproducing it with a fixture keeps the test self-contained — no onnxruntime,
// no VC++ manipulation, and it fails the same way on every platform.
writeFileSync(join(tmp, 'boom.cjs'),
  `const e = new Error('simulated native binding failure');\ne.code = 'ERR_DLOPEN_FAILED';\nthrow e;\n`);
writeFileSync(join(tmp, 'esm-boom.mjs'), `import '${BOOM_CJS}';\nexport const value = 1;\n`);

const HELPER_URL = DIST_BUILT ? pathToFileURL(DIST_HELPER).href : '';

/** Mirrors main()'s embedder block: fire-and-forget with a .catch that degrades. */
writeFileSync(join(tmp, 'guarded.mjs'), `
import { importWithoutDuplicateRejection } from ${JSON.stringify(HELPER_URL)};
importWithoutDuplicateRejection(() => import('${ESM_BOOM}'))
  .then(() => console.log('EMBEDDER_READY'))
  .catch(() => console.log('KEYWORD_ONLY'));
setTimeout(() => console.log('STILL_ALIVE'), 400);
`);

/** The pre-fix shape, kept as the control that shows the guard is load-bearing. */
writeFileSync(join(tmp, 'unguarded.mjs'), `
import('${ESM_BOOM}')
  .then(() => console.log('EMBEDDER_READY'))
  .catch(() => console.log('KEYWORD_ONLY'));
setTimeout(() => console.log('STILL_ALIVE'), 400);
`);

/** A genuine unhandled rejection during the guard's window must STILL be fatal. */
writeFileSync(join(tmp, 'unrelated.mjs'), `
import { importWithoutDuplicateRejection } from ${JSON.stringify(HELPER_URL)};
importWithoutDuplicateRejection(() => import('${ESM_BOOM}')).catch(() => console.log('KEYWORD_ONLY'));
Promise.reject(new Error('a genuine bug, unrelated to the import'));
setTimeout(() => console.log('STILL_ALIVE'), 400);
`);

async function run(file: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(tmp, file)], { cwd: tmp });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('importWithoutDuplicateRejection', () => {
  it('passes the module through when the import succeeds', async () => {
    const mod = await importWithoutDuplicateRejection(() => import('node:path'));
    expect(typeof (mod as { join: unknown }).join).toBe('function');
  });

  it('still rejects with the original error, so callers can degrade', async () => {
    const boom = Object.assign(new Error('nope'), { code: 'ERR_DLOPEN_FAILED' });
    await expect(importWithoutDuplicateRejection(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('removes its process listener once the import window closes', async () => {
    // Let any guard still pending release from an earlier test drain first —
    // the listener outlives its import by one macrotask by design.
    await new Promise((r) => setTimeout(r, 50));
    const before = process.listenerCount('unhandledRejection');
    await importWithoutDuplicateRejection(() => import('node:url'));
    await new Promise((r) => setTimeout(r, 50));
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});

describe('fail-open survives a native-binding load failure (child processes)', () => {
  it.skipIf(!DIST_BUILT)('keeps the process alive and degrades to keyword-only', async () => {
    const guarded = await run('guarded.mjs');
    expect(guarded.stdout).toContain('KEYWORD_ONLY');
    expect(guarded.stdout).toContain('STILL_ALIVE');
    expect(guarded.code).toBe(0);

    // Control: on Node <= 20 the un-guarded shape logs the SAME fallback and
    // then dies. Recording it here is what makes the assertion above meaningful
    // rather than vacuous on a Node version that never had the bug.
    const control = await run('unguarded.mjs');
    expect(control.stdout).toContain('KEYWORD_ONLY');
    if (control.code !== 0) {
      expect(control.stderr).toMatch(/ERR_DLOPEN_FAILED/);
      expect(guarded.code).toBe(0);
    }
  }, 30_000);

  it.skipIf(!DIST_BUILT)('does not swallow a genuine unhandled rejection', async () => {
    const res = await run('unrelated.mjs');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/a genuine bug, unrelated to the import/);
  }, 30_000);
});
