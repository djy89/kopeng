import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  MIN_NODE_MAJOR,
  DEFAULT_PORT,
  PORT_SCAN_START,
  PORT_SCAN_END,
  decideNodeVersion,
  classifyPortProbe,
  decidePortStep,
  resolvePort,
  detectClients,
  buildPreflightReport,
  planEnvFile,
  CORE_ENV_ORDER,
  decideInstallSpec,
  decideInstallAction,
  decideOfflineModels,
  embeddingModelDir,
  parseInitArgs,
  parseYesNo,
  buildConsentScreen,
  decideConsentGate,
  decidePortDivergence,
  InitError,
  derivedInitPaths,
  diagnoseNpmFailure,
  type PreflightReport,
  type PortProbeResult,
} from '../../src/cli/init.js';
import { renderManifest } from '../../src/cli/manifest.js';
import { PROFILE_DESCRIPTIONS } from '../../src/cli/wire-client.js';

// Task 2.2 — every function here is PURE (no fs/network/process access), so
// the whole decision surface is testable with plain inputs. The executors
// that actually touch disk/network/spawn live in tests/integration/init-flow.test.ts
// against injected fakes.

describe('decideNodeVersion', () => {
  it('fails plainly below the minimum, naming the required version', () => {
    const result = decideNodeVersion(18, 'linux');
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`${MIN_NODE_MAJOR}`);
    expect(result.error).not.toMatch(/at Object|\.ts:\d+|\.js:\d+/); // no stack-trace shape
  });

  it('an unrecognized (non-integer) major also fails plainly', () => {
    const result = decideNodeVersion(NaN, 'linux');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unrecognized/);
  });

  it('passes cleanly at and above the minimum on non-win32', () => {
    expect(decideNodeVersion(MIN_NODE_MAJOR, 'linux')).toEqual({ ok: true });
    expect(decideNodeVersion(22, 'darwin')).toEqual({ ok: true });
  });

  it('warns (does not fail) for win32 + Node 24 — the known T52 issue', () => {
    const result = decideNodeVersion(24, 'win32');
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/T52/);
  });

  it('Node 24 on a non-win32 platform gets no warning', () => {
    expect(decideNodeVersion(24, 'linux')).toEqual({ ok: true });
  });
});

describe('classifyPortProbe + decidePortStep (port outcomes)', () => {
  it('no response at all -> free', () => {
    expect(classifyPortProbe({ kind: 'no-response' })).toBe('free');
  });

  it('a kopeng-shaped body (data.status present) -> kopeng', () => {
    expect(classifyPortProbe({ kind: 'response', body: { data: { status: 'ok' } } })).toBe('kopeng');
    expect(classifyPortProbe({ kind: 'response', body: { data: { status: 'unhealthy' } } })).toBe('kopeng');
  });

  it('any other JSON shape (or none) -> foreign', () => {
    expect(classifyPortProbe({ kind: 'response', body: { hello: 'world' } })).toBe('foreign');
    expect(classifyPortProbe({ kind: 'response', body: undefined })).toBe('foreign');
    expect(classifyPortProbe({ kind: 'response', body: 'garbage' })).toBe('foreign');
    expect(classifyPortProbe({ kind: 'response', body: null })).toBe('foreign');
  });

  it('kopeng-shaped -> accept-existing regardless of an explicit --port', () => {
    expect(decidePortStep(3200, 'kopeng')).toBe('accept-existing');
    expect(decidePortStep(undefined, 'kopeng')).toBe('accept-existing');
  });

  it('free -> accept-free regardless of an explicit --port', () => {
    expect(decidePortStep(3200, 'free')).toBe('accept-free');
    expect(decidePortStep(undefined, 'free')).toBe('accept-free');
  });

  it('foreign + explicit --port -> fail-explicit-taken; foreign + no --port -> scan-next', () => {
    expect(decidePortStep(3200, 'foreign')).toBe('fail-explicit-taken');
    expect(decidePortStep(undefined, 'foreign')).toBe('scan-next');
  });
});

describe('resolvePort (executor over an injected probe)', () => {
  function probeSequence(results: PortProbeResult[]): { probe: (port: number) => Promise<PortProbeResult>; calls: number[] } {
    const calls: number[] = [];
    let i = 0;
    return {
      calls,
      probe: async (port) => { calls.push(port); return results[i++] ?? { kind: 'no-response' }; },
    };
  }

  it('default port free -> uses it, not overridden', async () => {
    const { probe, calls } = probeSequence([{ kind: 'no-response' }]);
    const result = await resolvePort(undefined, probe);
    expect(result).toEqual({ port: DEFAULT_PORT, overridden: false, existingServerRunning: false });
    expect(calls).toEqual([DEFAULT_PORT]);
  });

  it('default port already running kopeng -> repair path, not an error', async () => {
    const { probe } = probeSequence([{ kind: 'response', body: { data: { status: 'ok' } } }]);
    const result = await resolvePort(undefined, probe);
    expect(result).toEqual({ port: DEFAULT_PORT, overridden: false, existingServerRunning: true });
  });

  it('default port foreign, no explicit port -> scans and picks the first free alternate', async () => {
    const { probe, calls } = probeSequence([
      { kind: 'response', body: { hello: 'world' } }, // 3200: foreign
      { kind: 'response', body: { hello: 'world' } }, // 3201: foreign
      { kind: 'no-response' }, // 3202: free
    ]);
    const result = await resolvePort(undefined, probe);
    expect(result).toEqual({ port: PORT_SCAN_START + 1, overridden: true, existingServerRunning: false });
    expect(calls).toEqual([DEFAULT_PORT, PORT_SCAN_START, PORT_SCAN_START + 1]);
  });

  it('explicit --port that is foreign -> fails plainly, never scans', async () => {
    const { probe, calls } = probeSequence([{ kind: 'response', body: { hello: 'world' } }]);
    let caught: unknown;
    try { await resolvePort(3200, probe); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(InitError);
    expect((caught as Error).message).toMatch(/3200/);
    expect(calls).toEqual([3200]); // never scans past the explicit port
  });

  it('explicit --port already running kopeng -> accepted as the repair path', async () => {
    const { probe } = probeSequence([{ kind: 'response', body: { data: { status: 'degraded' } } }]);
    const result = await resolvePort(3200, probe);
    expect(result.existingServerRunning).toBe(true);
    expect(result.overridden).toBe(false);
  });

  it('every scan candidate foreign -> fails plainly naming the range', async () => {
    const results: PortProbeResult[] = [{ kind: 'response', body: { x: 1 } }]; // 3200
    for (let p = PORT_SCAN_START; p <= PORT_SCAN_END; p++) results.push({ kind: 'response', body: { x: 1 } });
    const { probe } = probeSequence(results);
    await expect(resolvePort(undefined, probe)).rejects.toThrow(new RegExp(`${PORT_SCAN_START}.*${PORT_SCAN_END}`));
  });
});

describe('detectClients', () => {
  it('detects each client independently and both together', () => {
    expect(detectClients(false, false)).toEqual([]);
    expect(detectClients(true, false)).toEqual(['claude-code']);
    expect(detectClients(false, true)).toEqual(['codex']);
    expect(detectClients(true, true)).toEqual(['claude-code', 'codex']);
  });
});

describe('buildPreflightReport (existing-install mode + full aggregation)', () => {
  function baseInputs() {
    return {
      nodeMajor: 22,
      platform: 'linux' as NodeJS.Platform,
      port: DEFAULT_PORT,
      portOverridden: false,
      existingServerRunning: false,
      diskFreeBytes: 500 * 1024 * 1024,
      diskThresholdBytes: 250 * 1024 * 1024,
      claudeDetected: true,
      codexDetected: false,
      existingInstall: false,
    };
  }

  it('no existing install -> fresh mode', () => {
    const report = buildPreflightReport(baseInputs());
    expect(report.mode).toBe('fresh');
    expect(report.lines.join('\n')).toMatch(/fresh install/);
  });

  it('an existing install -> repair mode', () => {
    const report = buildPreflightReport({ ...baseInputs(), existingInstall: true });
    expect(report.mode).toBe('repair');
    expect(report.lines.join('\n')).toMatch(/repair\/upgrade/);
  });

  it('missing disk info degrades to "unknown" and never fails the report', () => {
    const report = buildPreflightReport({ ...baseInputs(), diskFreeBytes: null });
    expect(report.diskOk).toBe(true);
    expect(report.lines.join('\n')).toMatch(/disk.*unknown/i);
  });

  it('disk below the threshold is flagged but not fatal', () => {
    const report = buildPreflightReport({ ...baseInputs(), diskFreeBytes: 10 * 1024 * 1024 });
    expect(report.diskOk).toBe(false);
  });

  it('no clients detected is reported, not fatal', () => {
    const report = buildPreflightReport({ ...baseInputs(), claudeDetected: false, codexDetected: false });
    expect(report.clients).toEqual([]);
    expect(report.lines.join('\n')).toMatch(/No supported client detected/);
  });

  it('carries the win32/Node24 warning through into the report lines', () => {
    const report = buildPreflightReport({ ...baseInputs(), nodeMajor: 24, platform: 'win32' });
    expect(report.nodeOk).toBe(true);
    expect(report.lines[0]).toMatch(/T52/);
  });
});

describe('planEnvFile (env planning)', () => {
  const desiredCore = {
    PORT: '3200',
    HOST: '127.0.0.1',
    DATABASE_PATH: '/kopeng/data/memory.db',
    MODELS_CACHE_DIR: '/kopeng/models',
    MEMORY_API_URL: 'http://localhost:3200',
    LOG_PATH: '/kopeng/logs',
  };

  it('fresh file: writes every core key plus the profile flags for the chosen profile', () => {
    const plan = planEnvFile('/kopeng/.env', false, '', desiredCore, 'recommended');
    expect(plan.changed).toBe(true);
    expect(plan.addedCoreKeys).toEqual([...CORE_ENV_ORDER]);
    for (const key of CORE_ENV_ORDER) {
      expect(plan.proposed).toContain(`${key}=${desiredCore[key as keyof typeof desiredCore]}`);
    }
    expect(plan.proposed).toContain('OBSERVATION_INGESTION_ENABLED=true');
    expect(plan.proposed).toContain('DISCOVERY_DETECTION_ENABLED=true');
    expect(plan.proposed).not.toContain('DREAMING_ENABLED=true'); // recommended, not everything
  });

  it('minimal profile adds no learning flags on a fresh file', () => {
    const plan = planEnvFile('/kopeng/.env', false, '', desiredCore, 'minimal');
    expect(plan.proposed).not.toContain('OBSERVATION_INGESTION_ENABLED');
    expect(plan.proposed).not.toContain('DISCOVERY_DETECTION_ENABLED');
    expect(plan.proposed).not.toContain('DREAMING_ENABLED');
  });

  it('existing file with all core keys already set: appends nothing for those keys', () => {
    const existing = CORE_ENV_ORDER.map((k) => `${k}=already-here`).join('\n') + '\n';
    const plan = planEnvFile('/kopeng/.env', true, existing, desiredCore, 'minimal');
    expect(plan.addedCoreKeys).toEqual([]);
    expect(plan.proposed).toContain('PORT=already-here');
    expect(plan.proposed).not.toContain('PORT=3200');
  });

  it('existing file missing only some core keys: appends only the missing ones', () => {
    const existing = 'PORT=9999\nHOST=127.0.0.1\n';
    const plan = planEnvFile('/kopeng/.env', true, existing, desiredCore, 'minimal');
    expect(plan.addedCoreKeys.sort()).toEqual(['DATABASE_PATH', 'MEMORY_API_URL', 'MODELS_CACHE_DIR', 'LOG_PATH'].sort());
    expect(plan.proposed).toContain('PORT=9999'); // untouched
  });

  it('admin-key preservation: an existing ADMIN_API_KEY line survives byte-for-byte', () => {
    const existing = '# generated by KOPENG first run\nADMIN_API_KEY=super-secret-value\n';
    const plan = planEnvFile('/kopeng/.env', true, existing, desiredCore, 'minimal');
    expect(plan.proposed).toContain('ADMIN_API_KEY=super-secret-value');
    // and every core key got appended since none were present
    for (const key of CORE_ENV_ORDER) expect(plan.proposed).toContain(key);
  });

  it('a fully-configured existing file (core + profile) is a no-op', () => {
    const existing =
      CORE_ENV_ORDER.map((k) => `${k}=x`).join('\n') + '\nOBSERVATION_INGESTION_ENABLED=true\nDISCOVERY_DETECTION_ENABLED=true\n';
    const plan = planEnvFile('/kopeng/.env', true, existing, desiredCore, 'recommended');
    expect(plan.changed).toBe(false);
    expect(plan.proposed).toBe(existing);
  });
});

describe('decideInstallSpec + decideInstallAction (spec selection)', () => {
  it('--from wins over the pinned version', () => {
    const spec = decideInstallSpec('/tmp/kopeng-1.2.0.tgz', '1.2.0');
    expect(spec).toEqual({ spec: '/tmp/kopeng-1.2.0.tgz', reason: 'from-flag' });
  });

  it('default pins the running CLI version', () => {
    const spec = decideInstallSpec(undefined, '1.2.0');
    expect(spec).toEqual({ spec: 'kopeng@1.2.0', reason: 'pinned-version' });
  });

  it('repair with the same pinned version already installed -> skip', () => {
    const spec = decideInstallSpec(undefined, '1.2.0');
    expect(decideInstallAction(spec, '1.2.0', '1.2.0')).toBe('skip');
  });

  it('repair with a different installed version -> install', () => {
    const spec = decideInstallSpec(undefined, '1.2.0');
    expect(decideInstallAction(spec, '1.1.0', '1.2.0')).toBe('install');
  });

  it('no prior install at all -> install', () => {
    const spec = decideInstallSpec(undefined, '1.2.0');
    expect(decideInstallAction(spec, undefined, '1.2.0')).toBe('install');
  });

  it('--from always installs, even if some version happens to already be present', () => {
    const spec = decideInstallSpec('/tmp/x.tgz', '1.2.0');
    expect(decideInstallAction(spec, '1.2.0', '1.2.0')).toBe('install');
  });
});

describe('decideOfflineModels', () => {
  const dir = '/kopeng/models/Xenova/all-MiniLM-L6-v2';

  it('missing directory -> fails naming what is missing, including the actual directory checked', () => {
    const result = decideOfflineModels(dir, false, []);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no embedding model files were found/i);
    expect(result.detail).toContain(dir);
  });

  it('directory present but empty -> fails', () => {
    expect(decideOfflineModels(dir, true, []).ok).toBe(false);
  });

  it('a zero-byte onnx file does not count as present', () => {
    const result = decideOfflineModels(dir, true, [{ path: '/models/model_quantized.onnx', size: 0 }]);
    expect(result.ok).toBe(false);
  });

  it('a non-onnx file does not count', () => {
    const result = decideOfflineModels(dir, true, [{ path: '/models/readme.txt', size: 100 }]);
    expect(result.ok).toBe(false);
  });

  it('at least one non-empty onnx file -> ok', () => {
    const result = decideOfflineModels(dir, true, [{ path: '/models/model_quantized.onnx', size: 12345 }]);
    expect(result.ok).toBe(true);
  });

  it('embeddingModelDir mirrors the actual on-disk cache layout (Xenova/<name>/...)', () => {
    expect(embeddingModelDir('/kopeng/models')).toBe(path.join('/kopeng/models', 'Xenova', 'all-MiniLM-L6-v2'));
  });
});

describe('parseInitArgs', () => {
  it('defaults: no flags -> everything off/undefined', () => {
    expect(parseInitArgs([])).toEqual({
      yes: false,
      nonInteractive: false,
      profile: undefined,
      from: undefined,
      port: undefined,
      offline: false,
      noAutostart: false,
      noEnsure: false,
    });
  });

  it('parses every flag', () => {
    const options = parseInitArgs([
      '--yes', '--profile', 'everything', '--from', '/tmp/x.tgz', '--port', '4100', '--offline', '--no-autostart', '--no-ensure',
    ]);
    expect(options).toEqual({
      yes: true,
      nonInteractive: false,
      profile: 'everything',
      from: '/tmp/x.tgz',
      port: 4100,
      offline: true,
      noAutostart: true,
      noEnsure: true,
    });
  });

  it('--non-interactive without --profile fails plainly', () => {
    expect(() => parseInitArgs(['--non-interactive'])).toThrow(InitError);
    expect(() => parseInitArgs(['--non-interactive'])).toThrow(/--profile/);
  });

  it('--non-interactive with --profile succeeds (the CI shape)', () => {
    const options = parseInitArgs(['--non-interactive', '--profile', 'minimal']);
    expect(options.nonInteractive).toBe(true);
    expect(options.profile).toBe('minimal');
  });

  it('rejects an invalid --profile value', () => {
    expect(() => parseInitArgs(['--profile', 'bogus'])).toThrow(InitError);
  });

  it('rejects a non-numeric or out-of-range --port', () => {
    expect(() => parseInitArgs(['--port', 'abc'])).toThrow(InitError);
    expect(() => parseInitArgs(['--port', '0'])).toThrow(InitError);
    expect(() => parseInitArgs(['--port', '99999'])).toThrow(InitError);
  });

  it('rejects an unknown argument', () => {
    expect(() => parseInitArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('parseYesNo', () => {
  it('empty answer defaults to yes (matches the [Y/n] prompt)', () => {
    expect(parseYesNo('')).toBe(true);
    expect(parseYesNo('   ')).toBe(true);
  });

  it('y/yes (any case) is yes', () => {
    for (const v of ['y', 'Y', 'yes', 'YES']) expect(parseYesNo(v)).toBe(true);
  });

  it('anything else is no', () => {
    for (const v of ['n', 'no', 'nope', 'x']) expect(parseYesNo(v)).toBe(false);
  });
});

describe('decideConsentGate (fix round 1, finding 2 — non-TTY hang prevention)', () => {
  it('--yes skips the gate regardless of TTY-ness', () => {
    expect(decideConsentGate({ yes: true, nonInteractive: false, isTTY: true })).toBe('skip');
    expect(decideConsentGate({ yes: true, nonInteractive: false, isTTY: false })).toBe('skip');
  });

  it('--non-interactive skips the gate regardless of TTY-ness', () => {
    expect(decideConsentGate({ yes: false, nonInteractive: true, isTTY: true })).toBe('skip');
    expect(decideConsentGate({ yes: false, nonInteractive: true, isTTY: false })).toBe('skip');
  });

  it('neither flag, a real TTY -> prompt', () => {
    expect(decideConsentGate({ yes: false, nonInteractive: false, isTTY: true })).toBe('prompt');
  });

  it('neither flag, non-TTY stdin -> fail-non-tty (never "prompt", which would hang)', () => {
    expect(decideConsentGate({ yes: false, nonInteractive: false, isTTY: false })).toBe('fail-non-tty');
  });
});

describe('decidePortDivergence (fix round 1, finding 3 — repair-path port safety)', () => {
  it('no existing PORT value at all -> no divergence (fresh install)', () => {
    expect(decidePortDivergence(undefined, 3200)).toEqual({ diverges: false });
  });

  it('existing PORT matches the resolved port -> no divergence', () => {
    expect(decidePortDivergence('3200', 3200)).toEqual({ diverges: false, existingPort: 3200 });
  });

  it('existing PORT differs from an explicit --port -> diverges', () => {
    expect(decidePortDivergence('3200', 4100)).toEqual({ diverges: true, existingPort: 3200 });
  });

  it('existing PORT differs from an auto-overridden port -> diverges the same way', () => {
    expect(decidePortDivergence('3200', 3201)).toEqual({ diverges: true, existingPort: 3200 });
  });

  it('a malformed existing PORT value is not this guard\'s job to validate — never blocks on it', () => {
    expect(decidePortDivergence('not-a-number', 3200)).toEqual({ diverges: false });
    expect(decidePortDivergence('', 3200)).toEqual({ diverges: false });
  });
});

describe('buildConsentScreen (consent-screen content)', () => {
  const report: PreflightReport = {
    nodeMajor: 22,
    nodeOk: true,
    port: 3200,
    portOverridden: false,
    existingServerRunning: false,
    diskFreeBytes: 1_000_000_000,
    diskOk: true,
    clients: ['claude-code'],
    mode: 'fresh',
    lines: ['Node.js: v22.x — OK', 'Port 3200: free.'],
  };

  it('includes the manifest block verbatim from the single source (renderManifest)', () => {
    const screen = buildConsentScreen(report, 'recommended');
    expect(screen).toContain(renderManifest('consent'));
  });

  it('includes the preflight lines and the literal no-telemetry / uninstall line', () => {
    const screen = buildConsentScreen(report, 'minimal');
    for (const line of report.lines) expect(screen).toContain(line);
    expect(screen).toContain('Nothing phones home. Everything above is removed by: npx kopeng uninstall');
  });

  it('names the chosen profile using the SAME description wire uses', () => {
    const screen = buildConsentScreen(report, 'everything');
    expect(screen).toContain(`Learning profile: everything — ${PROFILE_DESCRIPTIONS.everything}`);
  });
});

describe('derivedInitPaths', () => {
  it('derives every path under the given kopengHome, pure function of its input', () => {
    const paths = derivedInitPaths('/home/x/.kopeng');
    expect(paths.appDir).toBe(path.join('/home/x/.kopeng', 'app'));
    expect(paths.installedRepoRoot).toBe(path.join('/home/x/.kopeng', 'app', 'node_modules', 'kopeng'));
    expect(paths.serverEntry).toBe(path.join(paths.installedRepoRoot, 'dist', 'server.js'));
    expect(paths.cliEntry).toBe(path.join(paths.installedRepoRoot, 'dist', 'cli', 'index.js'));
    expect(paths.envFile).toBe(path.join('/home/x/.kopeng', '.env'));
  });
});

// Task 2.5.2 — the Install Strategy's plain-language native-build-failure
// diagnosis. Canned transcripts below are shaped like real npm/node-gyp
// output (see ci.yml's own note: "a fresh install on current LTS fell into
// a node-gyp source build and died without VS Build Tools — better-sqlite3
// 9.x shipped no Node 24 prebuild"), not copied from any real machine.
describe('diagnoseNpmFailure', () => {
  const PREBUILD_MISS_TRANSCRIPT = [
    'npm error code 1',
    'npm error path /app/node_modules/better-sqlite3',
    'npm error command failed',
    'npm error command sh -c prebuild-install || node-gyp rebuild',
    'prebuild-install warn install No prebuilt binaries found (target=24.0.0 runtime=node arch=arm64 platform=linux)',
    'gyp info it worked if it ends with ok',
    'gyp info using node-gyp@10.0.1',
    'gyp info find Python using Python version 3.11.6 found at "/usr/bin/python3"',
    'gyp ERR! build error',
    'gyp ERR! stack Error: `make` failed with exit code: 2',
    'gyp ERR! System Linux 6.5.0-1025-azure',
    'gyp ERR! not ok',
    'npm error A complete log of this run can be found in: /root/.npm/_logs/2026-08-28T00_00_00_000Z-debug-0.log',
  ].join('\n');

  const MSBUILD_TRANSCRIPT = [
    'npm error code 1',
    'npm error path C:\\ci\\prefix\\node_modules\\better-sqlite3',
    'npm error command failed',
    'npm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c node-gyp rebuild',
    'gyp info it worked if it ends with ok',
    'gyp info using node-gyp@10.0.1',
    'gyp info find Python using Python version 3.12.1 found at "C:\\Python312\\python.exe"',
    'gyp info spawn C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'MSBUILD : error MSB1009: Project file does not exist.',
    'gyp ERR! build error',
    'gyp ERR! stack Error: `C:\\...\\MSBuild.exe` failed with exit code: 1',
    'gyp ERR! not ok',
  ].join('\n');

  const PYTHON_MISSING_TRANSCRIPT = [
    'npm error code 1',
    'npm error command failed',
    'npm error command sh -c node-gyp rebuild',
    'gyp info it worked if it ends with ok',
    'gyp info using node-gyp@10.0.1',
    'gyp verb find Python Python is not set from command line, environment, or npm configuration',
    'gyp verb find Python checking if "python3" can be used',
    "gyp verb find Python - \"python3\" is not in PATH or produced an error",
    'gyp verb find Python checking if the py launcher can be used to find Python 3',
    'gyp verb find Python - "py.exe" is not in PATH or produced an error',
    'gyp ERR! find Python',
    'gyp ERR! find Python Python is not set from command line or npm configuration',
    'gyp ERR! configure error',
    'gyp ERR! stack Error: Could not find any Python installation to use',
    'gyp ERR! not ok',
  ].join('\n');

  const CLEAN_MISS_TRANSCRIPT = [
    'npm error code E404',
    "npm error 404 Not Found - GET https://registry.npmjs.org/kopeng - Not found",
    'npm error 404',
    "npm error 404  'kopeng@9.9.9' is not in this registry.",
    'npm error A complete log of this run can be found in: /root/.npm/_logs/2026-08-28T00_00_01_000Z-debug-0.log',
  ].join('\n');

  // Fix round 1, Finding 4: a standalone "gyp ERR! only" transcript — no
  // prebuild-install/MSBuild/make/python signature present at all — so the
  // generic node-gyp cause is the one actually selected, not just present
  // in some OTHER test's overlapping transcript.
  const GYP_ERR_ONLY_TRANSCRIPT = [
    'npm error code 1',
    'npm error command failed',
    'npm error command sh -c node-gyp rebuild',
    'gyp info it worked if it ends with ok',
    'gyp info using node-gyp@10.0.1',
    'gyp ERR! build error',
    'gyp ERR! stack Error: `make` failed with exit code: 2',
    'gyp ERR! System Linux 6.5.0-1025-azure',
    'gyp ERR! not ok',
  ].join('\n');

  it('recognizes a prebuild-install fallback with no prebuilt binary for this platform/Node', () => {
    const message = diagnoseNpmFailure(PREBUILD_MISS_TRANSCRIPT);
    // This transcript also contains "gyp ERR!" — asserting the SPECIFIC
    // cause clause (not just that "prebuild-install" appears somewhere,
    // which the raw-output tail would satisfy regardless) proves the more
    // specific signature won, per the most-specific-first ordering.
    expect(message).toContain('a native dependency has no prebuilt binary for this platform/Node version (prebuild-install)');
    expect(message).toContain('Visual Studio Build Tools');
    expect(message).toContain('xcode-select --install');
    expect(message).toContain('build-essential');
    expect(message).toContain('supported Node.js LTS release');
    expect(message).not.toMatch(/does not match a known/);
  });

  it('recognizes an MSBuild failure on Windows', () => {
    const message = diagnoseNpmFailure(MSBUILD_TRANSCRIPT);
    // This transcript also contains "gyp ERR!"; the assertion is on the
    // cause clause specifically, not just "MSBuild" appearing in the tail.
    expect(message).toContain('the Windows native build tools (MSBuild) are missing or misconfigured');
    expect(message).not.toMatch(/does not match a known/);
  });

  it('recognizes a missing-Python failure', () => {
    const message = diagnoseNpmFailure(PYTHON_MISSING_TRANSCRIPT);
    // This transcript also contains "gyp ERR!"; same specificity check.
    expect(message).toContain('python (needed by the native build toolchain) is missing');
    expect(message).not.toMatch(/does not match a known/);
  });

  it('recognizes a bare "gyp ERR!" failure with no more specific signature (the generic node-gyp fallback)', () => {
    const message = diagnoseNpmFailure(GYP_ERR_ONLY_TRANSCRIPT);
    expect(message).toContain('the native build toolchain (node-gyp) failed while compiling a dependency from source');
    expect(message).not.toMatch(/does not match a known/);
  });

  it('falls back to a generic diagnosis (with the log tail) on unrecognized output', () => {
    const message = diagnoseNpmFailure(CLEAN_MISS_TRANSCRIPT);
    expect(message).toContain('does not match a known native-build-tool signature');
    expect(message).toContain("'kopeng@9.9.9' is not in this registry");
  });

  it('never dumps more than the last ~1000 characters of output', () => {
    const huge = `${'x'.repeat(5000)}\ngyp ERR! build error`;
    const message = diagnoseNpmFailure(huge);
    expect(message.length).toBeLessThan(2000);
  });
});
