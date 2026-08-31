import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runUninstall,
  derivedUninstallPaths,
  type UninstallEffects,
} from '../../src/cli/uninstall.js';
import { unregisterAutostart as realUnregisterAutostart, type AutostartEffects } from '../../src/cli/autostart.js';
import { removeClient as realRemoveClient } from '../../src/cli/wire-client.js';

// Task 2.4.3 — full `runUninstall` over injected fakes. Real fs is used ONLY
// inside a temp KOPENG_HOME + a temp fake `~/.claude.json` home (mirrors
// init-flow.test.ts). HTTP (the shutdown POST + health poll) and the
// autostart OS spawn are recorded fakes — this suite never touches port
// 3200, a real scheduler, or the real HOME.

let tmpRoot: string;
let kopengHome: string;
let homeDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-uninstall-flow-'));
  kopengHome = path.join(tmpRoot, 'kopeng-home');
  homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(kopengHome, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeIo(): { io: { log: (l: string) => void; error: (l: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (l) => logs.push(l), error: (l) => errors.push(l) }, logs, errors };
}

function claudeJsonPath(): string {
  return path.join(homeDir, '.claude.json');
}

function settingsJsonPath(): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

/** A realistic post-`kopeng init` client config: kopeng entries PLUS foreign
 *  entries that must survive untouched. */
function seedWiredClientConfig(): void {
  fs.writeFileSync(claudeJsonPath(), JSON.stringify({
    theme: 'dark',
    mcpServers: {
      kopeng: { type: 'stdio', command: 'node', args: ['/repo/dist/index.js'], env: { MEMORY_API_URL: 'http://localhost:3200' } },
      other: { command: 'other' },
    },
  }), 'utf8');
  fs.mkdirSync(path.dirname(settingsJsonPath()), { recursive: true });
  fs.writeFileSync(settingsJsonPath(), JSON.stringify({
    env: { KOPENG_API_URL: 'http://localhost:3200', EXISTING: 'keep-me' },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /repo/scripts/hooks/memory-prompt-search.mjs', timeout: 5 }] }],
      PreToolUse: [{ hooks: [
        { type: 'command', command: 'node /opt/tools/guard.mjs', timeout: 17 },
        { type: 'command', command: 'node /repo/scripts/hooks/kopeng-observe.js tool_start', timeout: 3 },
      ] }],
    },
  }), 'utf8');
}

function seedInstall(paths: ReturnType<typeof derivedUninstallPaths>): void {
  fs.mkdirSync(path.join(paths.appDir, 'node_modules', 'kopeng'), { recursive: true });
  fs.writeFileSync(path.join(paths.appDir, 'node_modules', 'kopeng', 'package.json'), '{"name":"kopeng","version":"1.2.3"}', 'utf8');
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'memory.db'), 'fake-db-bytes', 'utf8');
  fs.mkdirSync(paths.modelsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.modelsDir, 'model.onnx'), 'fake-model-bytes', 'utf8');
  fs.writeFileSync(paths.envFile, 'PORT=3200\nADMIN_API_KEY=test-admin-key\n', 'utf8');
  fs.writeFileSync(paths.ensureKnobFile, JSON.stringify({ enabled: true, node: '/usr/bin/node', script: '/repo/dist/cli/index.js' }), 'utf8');

  const shimPath = path.join(paths.kopengHome, 'autostart', 'kopeng-server.cmd');
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(shimPath, '@echo off\r\n', 'utf8');
  fs.writeFileSync(paths.autostartRecordFile, JSON.stringify({
    mechanism: 'linux-systemd-user',
    files: [shimPath],
    unregisterCommands: [{ command: 'systemctl', args: ['--user', 'disable', '--now', 'kopeng'] }],
  }), 'utf8');
}

interface HarnessOptions {
  /** Overrides the response to POST /api/admin/shutdown specifically. */
  shutdownFetch?: typeof fetch;
  /** When true, GET /api/health keeps answering (200) even after a
   *  successful shutdown POST — simulates a server that never actually goes
   *  quiet, exercising the Finding-2 poll-timeout path. */
  neverGoesQuiet?: boolean;
  serverDownPoll?: { timeoutMs: number; pollIntervalMs: number };
  /** Number of times effects.removeDir(appDir) should throw before
   *  succeeding — simulates a transient EPERM from a residual native-module
   *  handle (Finding 2). */
  appDirRemoveFailures?: number;
  appDirRemoveRetry?: { attempts: number; delayMs: number };
  isTTY?: boolean;
  promptAnswer?: string;
}

interface Harness {
  effects: UninstallEffects;
  order: string[];
  fetchCalls: string[];
  shutdownFetchHeaders: Array<Record<string, string> | undefined>;
  spawnCalls: Array<{ command: string; args: string[] }>;
  removeDirCalls: string[];
  removeFileCalls: string[];
}

function createHarness(opts: HarnessOptions = {}): Harness {
  const order: string[] = [];
  const fetchCalls: string[] = [];
  const shutdownFetchHeaders: Array<Record<string, string> | undefined> = [];
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const removeDirCalls: string[] = [];
  const removeFileCalls: string[] = [];
  const paths = derivedUninstallPaths(kopengHome);

  const autostartEffects: AutostartEffects = {
    spawn: (command, args) => { spawnCalls.push({ command, args }); return { status: 0 }; },
    fs: {
      writeFile: (p, c) => fs.writeFileSync(p, c, 'utf8'),
      readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
      remove: (p) => { try { fs.rmSync(p, { force: true }); } catch { /* noop */ } },
    },
  };

  const defaultShutdownFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ data: { shutting_down: true } }), { status: 202 })
  ) as unknown as typeof fetch;

  // Becomes true once a successful (2xx) shutdown POST is observed, at which
  // point /api/health starts refusing — simulating a real graceful shutdown
  // completing. `neverGoesQuiet` pins it false forever (Finding-2 timeout path).
  let serverWentQuiet = false;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    fetchCalls.push(urlStr);
    if (urlStr.includes('/api/admin/shutdown')) {
      order.push('stopServer');
      shutdownFetchHeaders.push(init?.headers as Record<string, string> | undefined);
      const response = await (opts.shutdownFetch ?? defaultShutdownFetch)(url as never, init);
      if (response.ok && !opts.neverGoesQuiet) serverWentQuiet = true;
      return response;
    }
    // GET /api/health — waitForServerDown's poll target.
    if (serverWentQuiet) throw new Error('ECONNREFUSED (fake — server went quiet after shutdown)');
    return new Response(JSON.stringify({ data: { status: 'ready' } }), { status: 200 });
  }) as unknown as typeof fetch;

  let appDirRemoveAttempts = 0;
  const baseRemoveDir = (p: string): void => {
    removeDirCalls.push(p);
    if (p === paths.appDir && appDirRemoveAttempts < (opts.appDirRemoveFailures ?? 0)) {
      appDirRemoveAttempts++;
      throw new Error('EPERM: operation not permitted, unlink (fake — native module still mapped)');
    }
    fs.rmSync(p, { recursive: true, force: true });
  };

  const effects: UninstallEffects = {
    paths,
    homeDir,
    isTTY: opts.isTTY ?? true,

    exists: (p) => fs.existsSync(p),
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
    removeFile: (p) => { removeFileCalls.push(p); fs.rmSync(p, { force: true }); },
    removeDir: baseRemoveDir,

    fetchImpl,
    serverDownPoll: opts.serverDownPoll ?? { timeoutMs: 100, pollIntervalMs: 10 },
    appDirRemoveRetry: opts.appDirRemoveRetry ?? { attempts: 3, delayMs: 5 },

    autostartEffects,
    unregisterAutostart: (autoEffects, recordPath) => {
      order.push('unregisterAutostart');
      return realUnregisterAutostart(autoEffects, recordPath);
    },

    removeClient: (options) => {
      order.push('removeClient');
      return realRemoveClient(options);
    },

    promptText: async () => opts.promptAnswer ?? '',
  };

  // Wrap removeFile/removeDir a second time so order captures the SPECIFIC
  // steps (ensure knob vs app dir vs purge) rather than just "a removal
  // happened somewhere" — done here (not above) so paths are in scope.
  const baseRemoveFile = effects.removeFile;
  effects.removeFile = (p) => {
    if (p === paths.ensureKnobFile) order.push('removeEnsureKnob');
    baseRemoveFile(p);
  };
  const wrappedRemoveDir = effects.removeDir;
  effects.removeDir = (p) => {
    if (p === paths.appDir) order.push('removeAppDir');
    else if (p === paths.kopengHome) order.push('purgeKopengHome');
    wrappedRemoveDir(p);
  };

  return { effects, order, fetchCalls, shutdownFetchHeaders, spawnCalls, removeDirCalls, removeFileCalls };
}

describe('runUninstall', () => {
  it('runs the steps in order: stop server -> unregister autostart -> ensure knob -> config removal -> app dir', async () => {
    seedInstall(derivedUninstallPaths(kopengHome));
    seedWiredClientConfig();
    const { io } = fakeIo();
    const { effects, order } = createHarness();

    const code = await runUninstall([], io, effects);

    expect(code).toBe(0);
    // Exactly one 'stopServer' entry — the health-quiet poll must not be
    // recorded as a repeated stop step (Finding 2's poll runs AFTER stop,
    // against /api/health, not /api/admin/shutdown).
    expect(order).toEqual([
      'stopServer',
      'unregisterAutostart',
      'removeEnsureKnob',
      'removeClient',
      'removeAppDir',
    ]);
  });

  it('keeps data (db, models, .env) by default; removes the app dir, autostart, ensure knob, and client wiring', async () => {
    const paths = derivedUninstallPaths(kopengHome);
    seedInstall(paths);
    seedWiredClientConfig();
    const { io, logs } = fakeIo();
    const { effects } = createHarness();

    const code = await runUninstall([], io, effects);

    expect(code).toBe(0);
    expect(fs.existsSync(paths.appDir)).toBe(false);
    expect(fs.existsSync(paths.autostartRecordFile)).toBe(false);
    expect(fs.existsSync(paths.ensureKnobFile)).toBe(false);
    expect(fs.existsSync(path.join(paths.kopengHome, 'autostart', 'kopeng-server.cmd'))).toBe(false);

    // Data survives.
    expect(fs.readFileSync(path.join(paths.dataDir, 'memory.db'), 'utf8')).toBe('fake-db-bytes');
    expect(fs.readFileSync(path.join(paths.modelsDir, 'model.onnx'), 'utf8')).toBe('fake-model-bytes');
    expect(fs.readFileSync(paths.envFile, 'utf8')).toContain('ADMIN_API_KEY=test-admin-key');

    const output = logs.join('\n');
    expect(output).toContain(paths.dataDir);
    expect(output).toContain(paths.modelsDir);
    expect(output).toContain(paths.envFile);
    expect(output).toContain('--purge');
    expect(output).toContain('KOPENG has been uninstalled.');
  });

  it('client configs end with zero kopeng entries; foreign entries survive untouched', async () => {
    seedInstall(derivedUninstallPaths(kopengHome));
    seedWiredClientConfig();
    const { io } = fakeIo();
    const { effects } = createHarness();

    await runUninstall([], io, effects);

    const claude = JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(settingsJsonPath(), 'utf8'));
    const raw = JSON.stringify(claude) + JSON.stringify(settings);

    expect(raw).not.toContain('kopeng');
    expect(claude.mcpServers.other).toEqual({ command: 'other' });
    expect(settings.env.EXISTING).toBe('keep-me');
    expect(settings.hooks.PreToolUse[0].hooks).toEqual([
      { type: 'command', command: 'node /opt/tools/guard.mjs', timeout: 17 },
    ]);
  });

  it('an unreachable server still completes the full flow', async () => {
    seedInstall(derivedUninstallPaths(kopengHome));
    seedWiredClientConfig();
    const { io, logs } = fakeIo();
    const { effects } = createHarness({
      shutdownFetch: (async () => { throw new Error('ECONNREFUSED (fake)'); }) as unknown as typeof fetch,
    });

    const code = await runUninstall([], io, effects);

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/server not stopped.*unreachable/i);
    expect(fs.existsSync(derivedUninstallPaths(kopengHome).appDir)).toBe(false);
  });

  describe('keyless .env (fix round 1, Finding 4)', () => {
    it('attempts the shutdown request keylessly and succeeds against a keyless (dev-mode) server', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      fs.writeFileSync(paths.envFile, 'PORT=3200\n', 'utf8'); // no ADMIN_API_KEY
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects, fetchCalls, shutdownFetchHeaders } = createHarness();

      const code = await runUninstall([], io, effects);

      expect(code).toBe(0);
      expect(fetchCalls.some((u) => u.includes('/api/admin/shutdown'))).toBe(true);
      // No x-api-key sent when .env has none.
      expect(shutdownFetchHeaders[0]?.['x-api-key']).toBeUndefined();
      expect(logs.join('\n')).toMatch(/server stopped/i);
    });

    it('attempts the shutdown request keylessly, and a keyed server\'s 401 degrades to the existing printed-reason path', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      fs.writeFileSync(paths.envFile, 'PORT=3200\n', 'utf8'); // no ADMIN_API_KEY
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects, fetchCalls } = createHarness({
        shutdownFetch: (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
      });

      const code = await runUninstall([], io, effects);

      expect(code).toBe(0);
      expect(fetchCalls.some((u) => u.includes('/api/admin/shutdown'))).toBe(true);
      expect(logs.join('\n')).toMatch(/server not stopped.*requires one.*401/i);
    });
  });

  it('an older server (404 on the shutdown route) is reported and does not block completion', async () => {
    seedInstall(derivedUninstallPaths(kopengHome));
    seedWiredClientConfig();
    const { io, logs } = fakeIo();
    const { effects } = createHarness({
      shutdownFetch: (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch,
    });

    const code = await runUninstall([], io, effects);

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/server not stopped.*older server/i);
  });

  it('a malformed ~/.claude.json degrades to a printed reason, the rest of the flow still completes, and the exit code is non-zero (fix round 1, Finding 2 honesty)', async () => {
    const paths = derivedUninstallPaths(kopengHome);
    seedInstall(paths);
    fs.writeFileSync(claudeJsonPath(), '{ not valid json', 'utf8');
    const { io, logs } = fakeIo();
    const { effects } = createHarness();

    const code = await runUninstall([], io, effects);

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/could not update the claude code config/i);
    expect(logs.join('\n')).toMatch(/completed with issues/i);
    // The rest of the flow still ran despite the config-removal failure.
    expect(fs.existsSync(paths.appDir)).toBe(false);
    expect(fs.existsSync(paths.autostartRecordFile)).toBe(false);
  });

  describe('post-stop quiet-wait (fix round 1, Finding 2)', () => {
    it('waits for the port to go quiet before removing the app dir, then removes it cleanly with no issue', async () => {
      seedInstall(derivedUninstallPaths(kopengHome));
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects } = createHarness(); // default: goes quiet immediately after the 202

      const code = await runUninstall([], io, effects);

      expect(code).toBe(0);
      expect(logs.join('\n')).not.toMatch(/still answering/i);
      expect(logs.join('\n')).not.toMatch(/completed with issues/i);
    });

    it('a server that never goes quiet is flagged as an issue, but the app dir is still (best-effort) removed and the flow still completes', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects, order } = createHarness({
        neverGoesQuiet: true,
        serverDownPoll: { timeoutMs: 60, pollIntervalMs: 10 },
      });

      const code = await runUninstall([], io, effects);

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(/still answering.*after waiting 60ms/i);
      expect(logs.join('\n')).toMatch(/completed with issues/i);
      expect(order).toContain('removeAppDir');
      expect(fs.existsSync(paths.appDir)).toBe(false); // a temp dir has no real lock to fail on
    });
  });

  describe('app-dir removal retry (fix round 1, Finding 2)', () => {
    it('retries a transient EPERM-shaped failure and succeeds cleanly, with no issue reported', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects, removeDirCalls } = createHarness({ appDirRemoveFailures: 2 });

      const code = await runUninstall([], io, effects);

      expect(code).toBe(0);
      expect(logs.join('\n')).not.toMatch(/completed with issues/i);
      expect(fs.existsSync(paths.appDir)).toBe(false);
      // Two failed attempts + one success, all against the same path.
      expect(removeDirCalls.filter((p) => p === paths.appDir)).toHaveLength(3);
    });

    it('exhausting every retry attempt is reported as an issue and the flow still completes', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects } = createHarness({ appDirRemoveFailures: 99, appDirRemoveRetry: { attempts: 2, delayMs: 5 } });

      const code = await runUninstall([], io, effects);

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(/could not remove.*app.*continuing/i);
      expect(logs.join('\n')).toMatch(/completed with issues/i);
      // Never actually removed (every attempt failed) — but the run still
      // reached the summary rather than aborting.
      expect(fs.existsSync(paths.appDir)).toBe(true);
      expect(logs.join('\n')).toContain('KOPENG data is KEPT');
    });
  });

  describe('malformed autostart record (fix round 1, Finding 6a)', () => {
    it('removes the corrupt record file, reports it honestly instead of "not registered", and flags it as an issue', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      fs.writeFileSync(paths.autostartRecordFile, '{ not valid json', 'utf8');
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects } = createHarness();

      const code = await runUninstall([], io, effects);

      expect(code).toBe(1);
      const output = logs.join('\n');
      expect(output).not.toMatch(/no autostart entry was registered/i);
      expect(output).toMatch(/malformed autostart record/i);
      expect(output).toMatch(/completed with issues/i);
      expect(fs.existsSync(paths.autostartRecordFile)).toBe(false);
    });
  });

  describe('--dry-run', () => {
    it('touches nothing: no fs removal, no HTTP call, no spawn call', async () => {
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      seedWiredClientConfig();
      const beforeClaude = fs.readFileSync(claudeJsonPath(), 'utf8');
      const beforeSettings = fs.readFileSync(settingsJsonPath(), 'utf8');
      const { io, logs } = fakeIo();
      const { effects, fetchCalls, spawnCalls, removeDirCalls, removeFileCalls } = createHarness();

      const code = await runUninstall(['--dry-run'], io, effects);

      expect(code).toBe(0);
      expect(fetchCalls).toEqual([]);
      expect(spawnCalls).toEqual([]);
      expect(removeDirCalls).toEqual([]);
      expect(removeFileCalls).toEqual([]);
      expect(fs.existsSync(paths.appDir)).toBe(true);
      expect(fs.existsSync(paths.autostartRecordFile)).toBe(true);
      expect(fs.existsSync(paths.ensureKnobFile)).toBe(true);
      expect(fs.readFileSync(claudeJsonPath(), 'utf8')).toBe(beforeClaude);
      expect(fs.readFileSync(settingsJsonPath(), 'utf8')).toBe(beforeSettings);
      expect(logs.join('\n')).toContain('dry run');
    });

    it('--dry-run --purge reports the plan without deleting KOPENG_HOME', async () => {
      seedInstall(derivedUninstallPaths(kopengHome));
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects, removeDirCalls } = createHarness();

      const code = await runUninstall(['--dry-run', '--purge'], io, effects);

      expect(code).toBe(0);
      expect(removeDirCalls).toEqual([]);
      expect(fs.existsSync(kopengHome)).toBe(true);
      expect(logs.join('\n')).toContain('would permanently delete');
    });
  });

  describe('--purge', () => {
    it('with --yes purges KOPENG_HOME entirely, leaving zero residue', async () => {
      seedInstall(derivedUninstallPaths(kopengHome));
      seedWiredClientConfig();
      const { io } = fakeIo();
      const { effects, order } = createHarness();

      const code = await runUninstall(['--purge', '--yes'], io, effects);

      expect(code).toBe(0);
      expect(fs.existsSync(kopengHome)).toBe(false);
      expect(order[order.length - 1]).toBe('purgeKopengHome');
    });

    it('without --yes on a non-interactive stdin refuses the purge, keeps data, and exits non-zero (fix round 1, Finding 5)', async () => {
      seedInstall(derivedUninstallPaths(kopengHome));
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects } = createHarness({ isTTY: false });

      const code = await runUninstall(['--purge'], io, effects);

      expect(code).toBe(1);
      expect(fs.existsSync(kopengHome)).toBe(true);
      expect(logs.join('\n')).toMatch(/refus.*purge/i);
      expect(logs.join('\n')).toMatch(/pass --yes/i);
    });

    it('an interactive prompt requires the literal word "purge" — anything else cancels', async () => {
      seedInstall(derivedUninstallPaths(kopengHome));
      seedWiredClientConfig();
      const { io, logs } = fakeIo();
      const { effects } = createHarness({ isTTY: true, promptAnswer: 'yes' });

      const code = await runUninstall(['--purge'], io, effects);

      expect(code).toBe(0);
      expect(fs.existsSync(kopengHome)).toBe(true);
      expect(logs.join('\n')).toMatch(/not confirmed/i);
    });

    it('a declined purge confirmation still exits non-zero when an earlier step degraded (Finding 5, fix round 2)', async () => {
      // Every OTHER closing site ties its exit code to issues.length; this
      // one used to hardcode 0 regardless, hiding an earlier degraded step
      // even though closingLine() above it already printed "... with issues".
      const paths = derivedUninstallPaths(kopengHome);
      seedInstall(paths);
      fs.writeFileSync(claudeJsonPath(), '{ not valid json', 'utf8'); // forces the client-config step to degrade
      const { io, logs } = fakeIo();
      const { effects } = createHarness({ isTTY: true, promptAnswer: 'no' });

      const code = await runUninstall(['--purge'], io, effects);

      expect(code).toBe(1);
      expect(fs.existsSync(kopengHome)).toBe(true); // purge declined — data kept
      expect(logs.join('\n')).toMatch(/purge not confirmed/i);
      expect(logs.join('\n')).toMatch(/completed with issues/i);
    });

    it('an interactive prompt answering exactly "purge" (any case/whitespace) confirms', async () => {
      seedInstall(derivedUninstallPaths(kopengHome));
      seedWiredClientConfig();
      const { io } = fakeIo();
      const { effects } = createHarness({ isTTY: true, promptAnswer: '  Purge  ' });

      const code = await runUninstall(['--purge'], io, effects);

      expect(code).toBe(0);
      expect(fs.existsSync(kopengHome)).toBe(false);
    });
  });

  it('rejects an unknown argument', async () => {
    const { io, errors } = fakeIo();
    const { effects } = createHarness();

    const code = await runUninstall(['--bogus'], io, effects);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Unknown argument');
  });
});
