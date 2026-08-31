import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runInit,
  derivedInitPaths,
  type InitEffects,
  type PortProbeResult,
} from '../../src/cli/init.js';
import { registerAutostart as realRegisterAutostart, type AutostartEffects } from '../../src/cli/autostart.js';
import { wireClient as realWireClient } from '../../src/cli/wire-client.js';

// Task 2.2 — full `runInit` over injected fakes. Real fs is used ONLY inside
// a temp KOPENG_HOME + a temp fake `~/.claude.json` home. Every other side
// effect that could touch the real machine (npm, model download, port
// probes, autostart registration, the ensure spawn) is a recorded fake —
// this suite never installs, registers, downloads, probes, or spawns for
// real, and never goes near port 3200 or the real HOME.

let tmpRoot: string;
let kopengHome: string;
let homeDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-init-flow-'));
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

function writeClaudeJson(content: unknown = {}): void {
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify(content), 'utf8');
}

function readEnvFile(paths: ReturnType<typeof derivedInitPaths>): string {
  return fs.readFileSync(paths.envFile, 'utf8');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface AutostartState {
  written: Map<string, string>;
  spawnCalls: Array<{ command: string; args: string[] }>;
}

function freshAutostartState(): AutostartState {
  return { written: new Map(), spawnCalls: [] };
}

function realListFiles(dir: string): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { try { results.push({ path: full, size: fs.statSync(full).size }); } catch { /* race */ } }
    }
  };
  walk(dir);
  return results;
}

interface HarnessOptions {
  confirmAnswer?: boolean;
  profile?: 'minimal' | 'recommended' | 'everything';
  autostartState?: AutostartState;
  isTTY?: boolean;
}

interface Harness {
  effects: InitEffects;
  order: string[];
  npmInstallCalls: string[][];
  ensureCalls: unknown[];
  autostart: AutostartState;
  canaryCalls: Array<{ apiUrl: string; adminKey: string; hookPath?: string }>;
}

function createHarness(opts: HarnessOptions = {}): Harness {
  const order: string[] = [];
  const npmInstallCalls: string[][] = [];
  const ensureCalls: unknown[] = [];
  const canaryCalls: Array<{ apiUrl: string; adminKey: string; hookPath?: string }> = [];
  const autostart = opts.autostartState ?? freshAutostartState();
  const paths = derivedInitPaths(kopengHome);

  const autostartEffects: AutostartEffects = {
    spawn: (command, args) => { autostart.spawnCalls.push({ command, args }); return { status: 0 }; },
    fs: {
      writeFile: (p, c) => autostart.written.set(p, c),
      readFile: (p) => autostart.written.get(p),
      remove: (p) => autostart.written.delete(p),
    },
  };

  const effects: InitEffects = {
    paths,
    homeDir,
    appDataDir: path.join(homeDir, 'AppData', 'Roaming'),
    platform: 'linux',
    nodePath: '/usr/bin/node',
    nodeMajor: 22,
    runningVersion: '1.2.3',
    startHealthTimeoutMs: 30,
    startHealthPollMs: 5,
    isTTY: opts.isTTY ?? true, // simulates a real interactive terminal by default

    exists: (p) => fs.existsSync(p),
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
    writeFile: (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); },
    readInstalledVersion: (repoRoot) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    },
    listFiles: realListFiles,
    statfs: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
    probePort: async (): Promise<PortProbeResult> => ({ kind: 'no-response' }), // default port always free

    npmInstall: async (args) => {
      order.push('npmInstall');
      npmInstallCalls.push(args);
      // Simulate what a real `npm install --prefix <appDir> kopeng@x` leaves
      // behind — just enough for wireClient's validateRepoRoot to accept it.
      const repoRoot = paths.installedRepoRoot;
      fs.mkdirSync(path.join(repoRoot, 'scripts', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'kopeng', version: '1.2.3' }), 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    },
    downloadModels: async () => { order.push('downloadModels'); return { ok: true, detail: 'model ready (fake)' }; },

    autostartEffects,
    registerAutostart: (plan, autoEffects, recordPath) => {
      order.push('registerAutostart');
      return realRegisterAutostart(plan, autoEffects, recordPath);
    },

    fetchImpl: (async () => { throw new Error('ECONNREFUSED (fake — nothing is ever really listening)'); }) as unknown as typeof fetch,
    spawnImpl: () => ({ unref: () => {} }),
    runEnsure: async (deps) => { order.push('runEnsure'); ensureCalls.push(deps); return 'spawn'; },

    wireClient: (options) => { order.push('wireClient'); return realWireClient(options); },
    chooseProfile: async (explicit) => explicit ?? opts.profile ?? 'minimal',
    confirm: async () => opts.confirmAnswer ?? true,

    runDoctor: async () => { order.push('runDoctor'); return { ok: true, checks: [], posture: 'fake posture', apiUrl: 'http://localhost:0' }; },
    runCanary: async (canaryOptions) => { order.push('runCanary'); canaryCalls.push(canaryOptions); return { ok: true, stage: 'done' }; },
  };

  return { effects, order, npmInstallCalls, ensureCalls, autostart, canaryCalls };
}

describe('runInit — fresh install', () => {
  it('performs install -> env -> models -> autostart -> knob -> start -> wire -> doctor+canary, in order', async () => {
    writeClaudeJson();
    const { io, logs } = fakeIo();
    const harness = createHarness();

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(0);
    expect(harness.order).toEqual([
      'npmInstall', 'downloadModels', 'registerAutostart', 'runEnsure', 'wireClient', 'runDoctor', 'runCanary',
    ]);

    // .env written with the core keys + no learning-profile flags (minimal)
    const envContent = readEnvFile(harness.effects.paths);
    expect(envContent).toContain('PORT=3200');
    expect(envContent).toContain('HOST=127.0.0.1');
    expect(envContent).toContain('MEMORY_API_URL=http://localhost:3200');
    expect(envContent).toContain('DATABASE_PATH=');
    expect(envContent).toContain('MODELS_CACHE_DIR=');
    // Finding 1: an autostart-launched server's cwd is never KOPENG_HOME
    // (System32/`/`/$HOME), so LOG_PATH must be written absolute, same as
    // DATABASE_PATH, rather than left at the logger's relative './logs' default.
    expect(envContent).toContain(`LOG_PATH=${path.join(harness.effects.paths.kopengHome, 'logs')}`);

    // ensure knob written
    const knob = JSON.parse(fs.readFileSync(harness.effects.paths.ensureKnobFile, 'utf8'));
    expect(knob).toEqual({ enabled: true, node: '/usr/bin/node', script: harness.effects.paths.cliEntry });

    // autostart record written (via the fake AutostartEffects, not real fs)
    expect(harness.autostart.written.has(harness.effects.paths.autostartRecordFile)).toBe(true);

    // wireClient really ran against the temp homeDir
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.UserPromptSubmit).toBeDefined();

    // viz URL printed, never opened (RULING-F) — no launcher call exists to assert against;
    // the absence of one plus the printed line is the whole contract.
    expect(logs.join('\n')).toContain('kopeng viz');
    expect(logs.join('\n')).toContain('http://localhost:8780');
    expect(logs.join('\n')).not.toMatch(/opening|launching a browser/i);

    // Finding 4: canary's hookPath is derived from the INSTALLED package, not
    // the running CLI's own scripts/hooks (recall-canary's own default).
    expect(harness.canaryCalls).toHaveLength(1);
    expect(harness.canaryCalls[0].hookPath).toBe(
      path.join(harness.effects.paths.installedRepoRoot, 'scripts', 'hooks', 'memory-prompt-search.mjs')
    );
  });

  it('--non-interactive --profile everything --from <path> runs end-to-end with zero prompts (the CI shape)', async () => {
    writeClaudeJson();
    const { io } = fakeIo();
    const harness = createHarness();
    let confirmCalled = false;
    harness.effects.confirm = async () => { confirmCalled = true; return true; };

    const code = await runInit(['--non-interactive', '--profile', 'everything', '--from', '/tmp/kopeng-1.2.3.tgz'], io, harness.effects);

    expect(code).toBe(0);
    expect(confirmCalled).toBe(false); // never prompted
    expect(harness.npmInstallCalls[0]).toEqual(['install', '--prefix', harness.effects.paths.appDir, '/tmp/kopeng-1.2.3.tgz']);
    const envContent = readEnvFile(harness.effects.paths);
    expect(envContent).toContain('DREAMING_ENABLED=true'); // everything profile
  });
});

describe('runInit — repair (re-run on an existing install)', () => {
  it('is idempotent: no duplicate env keys, autostart re-registers cleanly, wire runs again without duplicating hooks', async () => {
    writeClaudeJson();
    const sharedAutostart = freshAutostartState();

    const first = createHarness({ autostartState: sharedAutostart });
    const { io: io1, logs: logs1 } = fakeIo();
    expect(await runInit([], io1, first.effects)).toBe(0);
    expect(logs1.join('\n')).toMatch(/fresh install/i);

    const second = createHarness({ autostartState: sharedAutostart });
    const { io: io2, logs: logs2 } = fakeIo();
    expect(await runInit([], io2, second.effects)).toBe(0);

    // Repair mode detected, and the pinned-version install was skipped entirely.
    expect(logs2.join('\n')).toMatch(/repair\/upgrade/i);
    expect(logs2.join('\n')).toMatch(/Already up to date/i);
    expect(second.order).not.toContain('npmInstall');
    expect(second.order).toEqual(['downloadModels', 'registerAutostart', 'runEnsure', 'wireClient', 'runDoctor', 'runCanary']);

    // No duplicate core .env keys after two runs.
    const envContent = readEnvFile(second.effects.paths);
    expect(occurrences(envContent, 'PORT=3200')).toBe(1);
    expect(occurrences(envContent, 'MEMORY_API_URL=')).toBe(1);

    // Autostart record is one coherent object, not accumulated garbage.
    const recordRaw = sharedAutostart.written.get(second.effects.paths.autostartRecordFile);
    expect(recordRaw).toBeDefined();
    const record = JSON.parse(recordRaw!);
    expect(record.mechanism).toBe('linux-systemd-user');
    expect(Array.isArray(record.files)).toBe(true);
    expect(new Set(record.files).size).toBe(record.files.length); // no duplicate file paths

    // Wire ran again but did not duplicate any of the five hooks.
    const settings = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'));
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event] as Array<{ hooks: unknown[] }>;
      const totalHookCommands = entries.reduce((sum, e) => sum + e.hooks.length, 0);
      expect(totalHookCommands).toBe(1);
    }
  });
});

describe('runInit — declined consent', () => {
  it('exits 0 and touches nothing: no .env, no app dir, no autostart record, homeDir unchanged', async () => {
    writeClaudeJson({ existing: 'marker' });
    const { io, logs } = fakeIo();
    const harness = createHarness({ confirmAnswer: false });

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/nothing was installed/i);
    expect(harness.order).toEqual([]); // no install/env/models/autostart/start/wire/verify step ran

    expect(fs.existsSync(harness.effects.paths.envFile)).toBe(false);
    expect(fs.existsSync(harness.effects.paths.appDir)).toBe(false);
    expect(fs.existsSync(harness.effects.paths.ensureKnobFile)).toBe(false);
    expect(harness.autostart.written.size).toBe(0);

    // homeDir's pre-existing file is byte-identical — wire never ran.
    expect(fs.existsSync(path.join(homeDir, '.claude', 'settings.json'))).toBe(false);
    const claudeJson = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
    expect(claudeJson).toEqual({ existing: 'marker' });
  });

  it('--yes skips the prompt entirely (never calls confirm)', async () => {
    writeClaudeJson();
    const { io } = fakeIo();
    const harness = createHarness();
    let confirmCalled = false;
    harness.effects.confirm = async () => { confirmCalled = true; return false; };

    const code = await runInit(['--yes'], io, harness.effects);

    expect(code).toBe(0);
    expect(confirmCalled).toBe(false);
    expect(harness.order).toContain('npmInstall'); // proceeded despite confirm being wired to "decline"
  });
});

describe('runInit — --offline', () => {
  it('with an empty models dir, fails naming the missing file and never reaches autostart/start/wire/verify', async () => {
    writeClaudeJson();
    const { io, errors } = fakeIo();
    const harness = createHarness();

    const code = await runInit(['--offline'], io, harness.effects);

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/no embedding model files were found/i);
    expect(errors.join('\n')).toMatch(/--offline/);
    expect(harness.order).toEqual(['npmInstall']); // install ran; nothing after the failed models step
  });

  it('with a real (non-empty) onnx file already present, succeeds and skips the download', async () => {
    writeClaudeJson();
    const { io } = fakeIo();
    const harness = createHarness();
    const modelFile = path.join(harness.effects.paths.modelsDir, 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx');
    fs.mkdirSync(path.dirname(modelFile), { recursive: true });
    fs.writeFileSync(modelFile, Buffer.from([1, 2, 3, 4]));

    const code = await runInit(['--offline'], io, harness.effects);

    expect(code).toBe(0);
    expect(harness.order).not.toContain('downloadModels');
  });
});

describe('runInit — npm install failure diagnosis (Task 2.5.2)', () => {
  it('a node-gyp-shaped npm install failure surfaces the plain-language diagnosis, not a raw exit-code dump', async () => {
    writeClaudeJson();
    const { io, errors } = fakeIo();
    const harness = createHarness();
    harness.effects.npmInstall = async (args) => ({
      code: 1,
      stdout: '',
      stderr: [
        'npm error command failed',
        'npm error command sh -c prebuild-install || node-gyp rebuild',
        'prebuild-install warn install No prebuilt binaries found (target=24.0.0 runtime=node arch=arm64 platform=linux)',
        'gyp ERR! build error',
        'gyp ERR! not ok',
      ].join('\n'),
    });

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toMatch(/npm install failed/i);
    expect(combined).toContain('a native dependency has no prebuilt binary for this platform/Node version (prebuild-install)');
    expect(combined).toMatch(/supported Node\.js LTS release/);
    expect(harness.order).toEqual([]); // the overridden npmInstall never reaches downloadModels/autostart/etc.
  });

  it('an unrecognized npm install failure still fails plainly, with the log tail rather than nothing', async () => {
    writeClaudeJson();
    const { io, errors } = fakeIo();
    const harness = createHarness();
    harness.effects.npmInstall = async () => ({
      code: 1,
      stdout: '',
      stderr: "npm error 404 'kopeng@1.2.3' is not in this registry.",
    });

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toMatch(/does not match a known native-build-tool signature/);
    expect(combined).toContain("'kopeng@1.2.3' is not in this registry");
  });
});

describe('runInit — wire env targeting (fix round 1, finding 1)', () => {
  it('with profile recommended, the learning flags land in the REAL env file exactly once, never inside the installed package', async () => {
    writeClaudeJson();
    const { io } = fakeIo();
    const harness = createHarness({ profile: 'recommended' });

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(0);
    // No shadow .env under the fake installed package root — wire's own
    // internal default (<repoRoot>/.env) must never win over init's explicit
    // envFile.
    expect(fs.existsSync(path.join(harness.effects.paths.installedRepoRoot, '.env'))).toBe(false);
    const envContent = readEnvFile(harness.effects.paths);
    expect(occurrences(envContent, 'OBSERVATION_INGESTION_ENABLED=true')).toBe(1);
    expect(occurrences(envContent, 'DISCOVERY_DETECTION_ENABLED=true')).toBe(1);
  });
});

describe('runInit — non-interactive stdin without --yes/--non-interactive (fix round 1, finding 2)', () => {
  it('fails plainly instead of hanging on the consent prompt, naming both escape flags, and touches nothing', async () => {
    writeClaudeJson({ existing: 'marker' });
    const { io, errors } = fakeIo();
    const harness = createHarness({ isTTY: false });
    let confirmCalled = false;
    harness.effects.confirm = async () => { confirmCalled = true; return true; };

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(1);
    expect(confirmCalled).toBe(false); // never even attempted the prompt
    expect(errors.join('\n')).toContain('--yes');
    expect(errors.join('\n')).toContain('--non-interactive');
    expect(harness.order).toEqual([]);
    expect(fs.existsSync(harness.effects.paths.envFile)).toBe(false);
    expect(fs.existsSync(harness.effects.paths.appDir)).toBe(false);
  });

  it('--yes bypasses the TTY guard entirely (a piped/CI install with --yes still runs)', async () => {
    writeClaudeJson();
    const { io } = fakeIo();
    const harness = createHarness({ isTTY: false });

    const code = await runInit(['--yes'], io, harness.effects);

    expect(code).toBe(0);
    expect(harness.order).toContain('npmInstall');
  });

  it('--non-interactive --profile also bypasses the TTY guard (the documented CI shape)', async () => {
    writeClaudeJson();
    const { io } = fakeIo();
    const harness = createHarness({ isTTY: false });

    const code = await runInit(['--non-interactive', '--profile', 'minimal'], io, harness.effects);

    expect(code).toBe(0);
    expect(harness.order).toContain('npmInstall');
  });
});

describe('runInit — port divergence on repair (fix round 1, finding 3)', () => {
  // The NON-divergent repair path (re-run resolves the SAME port as the
  // existing .env) is already covered end-to-end by the "repair" describe
  // block above — both runs there share one probePort fake that always
  // reports the default port free, so PORT never changes across the two runs.

  async function seedExistingEnvWithPort(port: number): Promise<void> {
    writeClaudeJson();
    const { io } = fakeIo();
    const seedHarness = createHarness();
    expect(await runInit([], io, seedHarness.effects)).toBe(0);
    expect(readEnvFile(seedHarness.effects.paths)).toContain(`PORT=${port}`);
  }

  it('an explicit --port that diverges from the existing .env refuses before any effectful step', async () => {
    await seedExistingEnvWithPort(3200);

    const { io, errors } = fakeIo();
    const harness = createHarness();
    harness.effects.probePort = async () => ({ kind: 'no-response' }); // 4100 probes free

    const code = await runInit(['--port', '4100'], io, harness.effects);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('3200');
    expect(errors.join('\n')).toContain('4100');
    expect(errors.join('\n')).toMatch(/--port/);
    expect(harness.order).toEqual([]); // refused before install ever ran
  });

  it('an auto-overridden port (the old port is now foreign-occupied) that diverges from the existing .env also refuses', async () => {
    await seedExistingEnvWithPort(3200);

    const { io, errors } = fakeIo();
    const harness = createHarness();
    harness.effects.probePort = async (port) =>
      port === 3200 ? { kind: 'response', body: { hello: 'world' } } : { kind: 'no-response' };

    const code = await runInit([], io, harness.effects);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('3200');
    expect(errors.join('\n')).toContain('3201');
    expect(harness.order).toEqual([]);
  });
});
