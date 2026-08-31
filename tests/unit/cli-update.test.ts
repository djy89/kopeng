import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import {
  decideUpdateSpec,
  decideUpdateOutcome,
  parseUpdateArgs,
  derivedUpdatePaths,
  runUpdate,
  UpdateError,
  type UpdateEffects,
} from '../../src/cli/update.js';
import type { DoctorReport } from '../../src/cli/doctor.js';
import type { EnsureDecision } from '../../src/cli/ensure.js';
import { runNpmInstall } from '../../src/cli/npm-spawn.js';
import { fakeChildProcess } from '../fixtures/fake-child-process.js';

// Task 2.4.4 — decideUpdateSpec/decideUpdateOutcome/parseUpdateArgs are pure.
// runUpdate is exercised against fully injected fakes (no real fs/network/
// spawn) — never installs, stops, spawns, or polls anything real.

describe('decideUpdateSpec (pure)', () => {
  it('defaults to kopeng@latest with no --from', () => {
    expect(decideUpdateSpec(undefined)).toEqual({ spec: 'kopeng@latest', reason: 'latest' });
  });

  it('an explicit --from always wins', () => {
    expect(decideUpdateSpec('./kopeng-1.4.0.tgz')).toEqual({ spec: './kopeng-1.4.0.tgz', reason: 'from-flag' });
    expect(decideUpdateSpec('kopeng@1.4.0')).toEqual({ spec: 'kopeng@1.4.0', reason: 'from-flag' });
  });
});

describe('decideUpdateOutcome (pure)', () => {
  it('the same before/after version is no-change', () => {
    expect(decideUpdateOutcome('1.2.3', '1.2.3')).toBe('no-change');
  });

  it('a different version is updated', () => {
    expect(decideUpdateOutcome('1.2.3', '1.3.0')).toBe('updated');
  });

  it('no prior install (before undefined) counts as updated once a version is read', () => {
    expect(decideUpdateOutcome(undefined, '1.2.3')).toBe('updated');
  });

  it('both sides unreadable is a no-change (nothing detectably moved)', () => {
    expect(decideUpdateOutcome(undefined, undefined)).toBe('no-change');
  });
});

describe('parseUpdateArgs', () => {
  it('defaults to no --from', () => {
    expect(parseUpdateArgs([])).toEqual({ from: undefined });
  });

  it('accepts --from with a value', () => {
    expect(parseUpdateArgs(['--from', './kopeng.tgz'])).toEqual({ from: './kopeng.tgz' });
  });

  it('rejects --from with no value', () => {
    expect(() => parseUpdateArgs(['--from'])).toThrow(/--from requires a value/);
  });

  it('rejects an unknown argument', () => {
    expect(() => parseUpdateArgs(['--bogus'])).toThrow(UpdateError);
  });
});

describe('derivedUpdatePaths', () => {
  it('derives the installed-repo-root and server-entry paths from kopengHome', () => {
    const paths = derivedUpdatePaths('/home/op/.kopeng');
    expect(paths.appDir.replace(/\\/g, '/')).toBe('/home/op/.kopeng/app');
    expect(paths.installedRepoRoot.replace(/\\/g, '/')).toBe('/home/op/.kopeng/app/node_modules/kopeng');
    expect(paths.serverEntry.replace(/\\/g, '/')).toBe('/home/op/.kopeng/app/node_modules/kopeng/dist/server.js');
    expect(paths.envFile.replace(/\\/g, '/')).toBe('/home/op/.kopeng/.env');
  });
});

// ── runUpdate over injected fakes ───────────────────────────────────────

function fakeIo(): { io: { log: (l: string) => void; error: (l: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (l) => logs.push(l), error: (l) => errors.push(l) }, logs, errors };
}

interface HarnessOptions {
  versions: string[]; // successive readInstalledVersion() results: [before, after, ...]
  npmInstallCode?: number;
  /** Overrides the response to POST /api/admin/shutdown specifically. */
  shutdownFetch?: typeof fetch;
  /** GET /api/health keeps answering "up" even during the pre-ensure
   *  quiet-wait (Finding 2/3's poll target) — simulates a server that never
   *  actually stops. Ignored once `runEnsure` has been called. */
  neverGoesQuiet?: boolean;
  /** Overrides GET /api/health for stopServer's OWN pre-shutdown target probe
   *  only (fix round 2, Finding 1) — the gate deciding whether the admin key
   *  may be sent at all. Default: a live KOPENG server. */
  preShutdownHealth?: () => Promise<Response>;
  /** What the (mocked) runEnsure call reports. */
  ensureDecision?: EnsureDecision;
  /** GET /api/health's answer to waitForHealth's OWN post-ensure probe. */
  healthReady?: boolean;
  doctorOk?: boolean;
  envSource?: string;
}

interface Harness {
  effects: UpdateEffects;
  order: string[];
  npmInstallCalls: string[][];
  ensureCalls: unknown[];
  doctorCalls: unknown[];
  fetchCalls: string[];
  removedFiles: string[];
}

function createHarness(opts: HarnessOptions): Harness {
  const order: string[] = [];
  const npmInstallCalls: string[][] = [];
  const ensureCalls: unknown[] = [];
  const doctorCalls: unknown[] = [];
  const fetchCalls: string[] = [];
  const removedFiles: string[] = [];
  let versionIndex = 0;
  const versions = opts.versions;
  let ensureCalled = false;
  let shutdownAttempted = false;

  const defaultShutdownFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ data: { shutting_down: true } }), { status: 202 })
  ) as unknown as typeof fetch;

  const effects: UpdateEffects = {
    paths: {
      kopengHome: '/home/test/.kopeng',
      appDir: '/home/test/.kopeng/app',
      envFile: '/home/test/.kopeng/.env',
      hintsDir: '/home/test/.kopeng/hints',
      installedRepoRoot: '/home/test/.kopeng/app/node_modules/kopeng',
      serverEntry: '/home/test/.kopeng/app/node_modules/kopeng/dist/server.js',
    },
    nodePath: '/usr/bin/node',
    startHealthTimeoutMs: 30,
    startHealthPollMs: 5,
    serverDownPoll: { timeoutMs: 30, pollIntervalMs: 5 },

    readInstalledVersion: () => versions[versionIndex++],
    readFile: () => opts.envSource ?? 'PORT=3200\nADMIN_API_KEY=test-admin-key\n',
    writeFile: () => {},
    removeFile: (p) => { removedFiles.push(p); },
    npmInstall: async (args) => {
      order.push('npmInstall');
      npmInstallCalls.push(args);
      return { code: opts.npmInstallCode ?? 0, stdout: '', stderr: opts.npmInstallCode ? 'boom' : '' };
    },

    fetchImpl: (async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      fetchCalls.push(urlStr);
      if (urlStr.includes('/api/admin/shutdown')) {
        order.push('stopServer');
        shutdownAttempted = true;
        return (opts.shutdownFetch ?? defaultShutdownFetch)(url as never, init);
      }
      if (urlStr.includes('/api/health')) {
        // Two DISTINCT pre-ensure phases share this URL since fix round 2
        // (Finding 1). Before the shutdown POST it is stopServer's own target
        // probe — the gate on whether the admin key may be sent at all — so a
        // live install must answer KOPENG-shaped or nothing is stopped. After
        // it, it is waitForServerDown's quiet-wait poll.
        if (!ensureCalled && !shutdownAttempted) {
          return opts.preShutdownHealth
            ? opts.preShutdownHealth()
            : new Response(JSON.stringify({ data: { status: 'ready' } }), { status: 200 });
        }
        if (!ensureCalled && opts.neverGoesQuiet) {
          // Pre-ensure quiet-wait phase: a server that refuses to stop.
          return new Response(JSON.stringify({ data: { status: 'ready' } }), { status: 200 });
        }
        if (!ensureCalled) {
          // Pre-ensure quiet-wait phase, default: goes quiet immediately.
          throw new Error('ECONNREFUSED (fake — server quiet after shutdown)');
        }
        // Post-ensure: waitForHealth's own probe for the restarted server.
        return opts.healthReady === false
          ? Promise.reject(new Error('not up yet'))
          : new Response(JSON.stringify({ data: { status: 'ready', embedding: 'loaded' } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch,
    spawnImpl: () => ({ unref: () => {} }),
    runEnsure: async (deps): Promise<EnsureDecision> => {
      order.push('runEnsure');
      ensureCalls.push(deps);
      ensureCalled = true;
      return opts.ensureDecision ?? 'spawn';
    },
    runDoctor: async (doctorOptions) => {
      order.push('runDoctor');
      doctorCalls.push(doctorOptions);
      return { ok: opts.doctorOk ?? true, checks: [], posture: '', apiUrl: 'http://localhost:3200' } satisfies DoctorReport;
    },
  };

  return { effects, order, npmInstallCalls, ensureCalls, doctorCalls, fetchCalls, removedFiles };
}

describe('runUpdate', () => {
  it('no-change: installs, detects the same version, reports "already up to date", and never restarts', async () => {
    const { io, logs } = fakeIo();
    const { effects, order, npmInstallCalls } = createHarness({ versions: ['1.2.3', '1.2.3'] });

    const code = await runUpdate([], io, effects);

    expect(code).toBe(0);
    expect(npmInstallCalls).toHaveLength(1);
    expect(npmInstallCalls[0]).toEqual(['install', '--prefix', '/home/test/.kopeng/app', 'kopeng@latest']);
    expect(order).toEqual(['npmInstall']); // no stopServer/runEnsure/runDoctor
    expect(logs.join('\n')).toMatch(/already up to date/i);
  });

  it('updated: installs, detects a version change, waits for quiet, and runs stop -> ensure -> health -> doctor in order', async () => {
    const { io, logs } = fakeIo();
    const { effects, order, ensureCalls, doctorCalls } = createHarness({ versions: ['1.2.3', '1.3.0'] });

    const code = await runUpdate([], io, effects);

    expect(code).toBe(0);
    // Exactly one 'stopServer' entry — the quiet-wait polls /api/health, not
    // /api/admin/shutdown, so it is never recorded as a repeated stop.
    expect(order).toEqual(['npmInstall', 'stopServer', 'runEnsure', 'runDoctor']);
    expect(ensureCalls).toHaveLength(1);
    expect(doctorCalls).toHaveLength(1);
    expect(logs.join('\n')).toContain('Updated 1.2.3 -> 1.3.0');
    expect(logs.join('\n')).toMatch(/server stopped for restart/i);
    expect(logs.join('\n')).not.toMatch(/still answering/i);
    expect(logs.join('\n')).toMatch(/new version starting/i);
  });

  it('no prior install (before undefined) still restarts once a version is read', async () => {
    const { io } = fakeIo();
    const { effects, order } = createHarness({ versions: [undefined as unknown as string, '1.3.0'] });

    const code = await runUpdate([], io, effects);

    expect(code).toBe(0);
    expect(order).toEqual(['npmInstall', 'stopServer', 'runEnsure', 'runDoctor']);
  });

  it('passes the --from spec straight to npm install', async () => {
    const { io } = fakeIo();
    const { effects, npmInstallCalls } = createHarness({ versions: ['1.2.3', '1.2.3'] });

    await runUpdate(['--from', './kopeng-1.4.0.tgz'], io, effects);

    expect(npmInstallCalls[0]).toEqual(['install', '--prefix', '/home/test/.kopeng/app', './kopeng-1.4.0.tgz']);
  });

  it('an npm install failure aborts before any restart machinery runs', async () => {
    const { io, errors } = fakeIo();
    const { effects, order } = createHarness({ versions: ['1.2.3', '1.2.3'], npmInstallCode: 1 });

    const code = await runUpdate([], io, effects);

    expect(code).toBe(1);
    expect(order).toEqual(['npmInstall']);
    expect(errors.join('\n')).toMatch(/npm install failed/i);
  });

  it('an unreachable server during the stop step still proceeds to ensure/doctor', async () => {
    const { io, logs } = fakeIo();
    const { effects, order } = createHarness({
      versions: ['1.2.3', '1.3.0'],
      shutdownFetch: (async () => { throw new Error('ECONNREFUSED (fake)'); }) as unknown as typeof fetch,
    });

    const code = await runUpdate([], io, effects);

    expect(code).toBe(0);
    // stopServer is still attempted (and recorded) even though it fails —
    // stopResult.stopped is false, so the quiet-wait is skipped entirely.
    expect(order).toEqual(['npmInstall', 'stopServer', 'runEnsure', 'runDoctor']);
    expect(logs.join('\n')).toMatch(/server not stopped.*unreachable/i);
  });

  describe('keyless .env (fix round 1, Finding 4 — mirrors uninstall)', () => {
    it('attempts the shutdown request keylessly and succeeds against a keyless (dev-mode) server', async () => {
      const { io, logs } = fakeIo();
      const { effects, order, fetchCalls } = createHarness({
        versions: ['1.2.3', '1.3.0'],
        envSource: 'PORT=3200\n', // no ADMIN_API_KEY
      });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(0);
      expect(fetchCalls.some((u) => u.includes('/api/admin/shutdown'))).toBe(true);
      expect(order).toEqual(['npmInstall', 'stopServer', 'runEnsure', 'runDoctor']);
      expect(logs.join('\n')).toMatch(/server stopped for restart/i);
    });

    it('a keyed server\'s 401 to a keyless request degrades to the existing printed-reason path', async () => {
      const { io, logs } = fakeIo();
      const { effects, order } = createHarness({
        versions: ['1.2.3', '1.3.0'],
        envSource: 'PORT=3200\n', // no ADMIN_API_KEY
        shutdownFetch: (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
      });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(0);
      // stopResult.stopped is false (401), so the quiet-wait step is skipped.
      expect(order).toEqual(['npmInstall', 'stopServer', 'runEnsure', 'runDoctor']);
      expect(logs.join('\n')).toMatch(/server not stopped.*requires one.*401/i);
    });
  });

  describe('foreign listener on the port (fix round 2, Finding 1)', () => {
    it('never sends the admin key to a process that is not a KOPENG server', async () => {
      const { io, logs } = fakeIo();
      const { effects, order, fetchCalls } = createHarness({
        versions: ['1.2.3', '1.3.0'],
        // Another local user's trivial listener holds the port. The old code
        // handed it ADMIN_API_KEY in a header on a routine `kopeng update`.
        preShutdownHealth: async () => new Response('hello', { status: 200 }),
      });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(0); // update still completes and reports — never a hard fail
      expect(fetchCalls.some((u) => u.includes('/api/admin/shutdown'))).toBe(false);
      expect(order).toEqual(['npmInstall', 'runEnsure', 'runDoctor']);
      expect(logs.join('\n')).toMatch(/server not stopped.*non-KOPENG process is listening/i);
    });
  });

  describe('post-stop quiet-wait + EnsureDecision consumption (fix round 1, Finding 3)', () => {
    it('a server that never goes quiet is warned about before continuing', async () => {
      const { io, logs } = fakeIo();
      const { effects } = createHarness({ versions: ['1.2.3', '1.3.0'], neverGoesQuiet: true });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(0);
      expect(logs.join('\n')).toMatch(/still answering.*after waiting 30ms/i);
    });

    it('"already-up" after the quiet-wait means the stop did not take effect — reported plainly, non-zero exit', async () => {
      const { io, logs } = fakeIo();
      const { effects, ensureCalls } = createHarness({ versions: ['1.2.3', '1.3.0'], ensureDecision: 'already-up' });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(1);
      expect(ensureCalls).toHaveLength(1); // the decision WAS consumed, not discarded
      expect(logs.join('\n')).toMatch(/still answering.*as the previous version/i);
      expect(logs.join('\n')).not.toMatch(/new version starting/i);
    });

    it('"port-conflict" is reported plainly, cleans up the misleading ensure_conflict hint, non-zero exit', async () => {
      const { io, logs } = fakeIo();
      const { effects, removedFiles } = createHarness({ versions: ['1.2.3', '1.3.0'], ensureDecision: 'port-conflict' });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(/different process is now listening/i);
      expect(removedFiles).toContain(path.join('/home/test/.kopeng', 'hints', 'ensure_conflict.json'));
    });

    it('"spawn" proceeds normally and does not touch the ensure_conflict hint', async () => {
      const { io, logs } = fakeIo();
      const { effects, removedFiles } = createHarness({ versions: ['1.2.3', '1.3.0'], ensureDecision: 'spawn' });

      const code = await runUpdate([], io, effects);

      expect(code).toBe(0);
      expect(removedFiles).toEqual([]);
      expect(logs.join('\n')).toMatch(/new version starting/i);
    });
  });

  it('reports a failing doctor summary with a non-zero exit', async () => {
    const { io, logs } = fakeIo();
    const { effects } = createHarness({ versions: ['1.2.3', '1.3.0'], doctorOk: false });

    const code = await runUpdate([], io, effects);

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/some checks need attention/i);
  });

  it('rejects an unknown argument before touching any effect', async () => {
    const { io, errors } = fakeIo();
    const { effects, order } = createHarness({ versions: ['1.2.3', '1.2.3'] });

    const code = await runUpdate(['--bogus'], io, effects);

    expect(code).toBe(1);
    expect(order).toEqual([]);
    expect(errors.join('\n')).toContain('Unknown argument');
  });
});

// Task 2.5 fix round 1, Finding 1 — the reviewer confirmed update.ts's
// realNpmInstall carried the identical win32 npm.cmd bug as init.ts's
// (bare shell:true, no arg quoting, no sync-throw guard). Both files now
// import the SAME src/cli/npm-spawn.ts implementation; these tests drive
// `runUpdate` itself (not just the shared module in isolation, which
// tests/unit/npm-spawn.test.ts already covers) with `effects.npmInstall`
// wired to `runNpmInstall` + an injected fake spawn — proving update's
// actual npm-install-failure handling (`if (installResult.code !== 0) throw
// new UpdateError(...)`) correctly consumes the shape runNpmInstall
// produces, for both the quoting behavior and the sync-throw closure.
describe('runUpdate — real npm-spawn wiring parity (Task 2.5 fix round 1, Finding 1)', () => {
  it('a spaced appDir path on win32 is correctly quoted before reaching the injected spawn', async () => {
    const { io } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const { effects } = createHarness({ versions: ['1.2.3', '1.2.3'] });
    effects.paths.appDir = 'C:\\Users\\John Smith\\.kopeng\\app';
    effects.npmInstall = (args) => runNpmInstall(args, spawnImpl, 'win32');

    const promise = runUpdate([], io, effects);
    emitClose(0);
    const code = await promise;

    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm.cmd',
      ['install', '--prefix', '"C:\\Users\\John Smith\\.kopeng\\app"', 'kopeng@latest'],
      expect.objectContaining({ shell: true })
    );
  });

  it('a synchronous spawn throw (the win32 EINVAL case) surfaces as a clean UpdateError via io.error, not an uncaught rejection', async () => {
    const { io, errors } = fakeIo();
    const spawnImpl = vi.fn(() => { throw new Error('spawn EINVAL'); });
    const { effects, order } = createHarness({ versions: ['1.2.3', '1.2.3'] });
    effects.npmInstall = (args) => runNpmInstall(args, spawnImpl, 'win32');

    const code = await runUpdate([], io, effects);

    expect(code).toBe(1);
    expect(order).toEqual([]); // aborted before any restart machinery ran
    expect(errors.join('\n')).toMatch(/npm install failed/i);
    expect(errors.join('\n')).toContain('spawn EINVAL');
  });

  it('on non-win32, args reach the injected spawn byte-identical, with no shell', async () => {
    const { io } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const { effects } = createHarness({ versions: ['1.2.3', '1.2.3'] });
    effects.npmInstall = (args) => runNpmInstall(args, spawnImpl, 'linux');

    const promise = runUpdate([], io, effects);
    emitClose(0);
    const code = await promise;

    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '--prefix', '/home/test/.kopeng/app', 'kopeng@latest'],
      expect.objectContaining({ shell: false })
    );
  });
});
