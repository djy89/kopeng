import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { isPackagedInstall, runDoctor } from '../../src/cli/doctor.js';
import { wireClient } from '../../src/cli/wire-client.js';

const MEMORY_CONTENT = 'KOPENG doctor marker 4c12b9 remains available through the real recall hook.';
const REPO_VERSION = '1.1.0';

let scratch: string;
let homeDir: string;
let repoRoot: string;
let server: http.Server;
let apiUrl: string;
let doctorEnv: NodeJS.ProcessEnv;
let healthData: Record<string, unknown>;
let corpusHealthData: Record<string, unknown>;

function json(response: http.ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function startServer(): Promise<void> {
  server = http.createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/api/health') {
      json(response, { data: healthData });
    } else if (request.method === 'GET' && url.startsWith('/api/memories?')) {
      json(response, { data: [{ id: 1, content: MEMORY_CONTENT, type: 'reference', scope: 'global' }] });
    } else if (request.method === 'POST' && url === '/api/memories/recall') {
      json(response, { data: [{ id: 1, content: MEMORY_CONTENT, type: 'reference', score: 0.99 }] });
    } else if (request.method === 'POST' && url === '/api/surface') {
      json(response, { data: { tools: [], skills: [], conventions: [] } });
    } else if (request.method === 'GET' && url.startsWith('/api/ops/corpus-health')) {
      json(response, { data: corpusHealthData });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  apiUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function settingsPath(): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

function claudePath(): string {
  return path.join(homeDir, '.claude.json');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function snapshotTree(root: string): Record<string, { content: string; mtimeMs: number }> {
  const snapshot: Record<string, { content: string; mtimeMs: number }> = {};
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const relative = path.relative(root, absolute).replace(/\\/g, '/');
        const stat = fs.statSync(absolute);
        snapshot[relative] = { content: fs.readFileSync(absolute, 'utf8'), mtimeMs: stat.mtimeMs };
      }
    }
  };
  visit(root);
  return snapshot;
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const result = report.checks.find(row => row.name === name);
  expect(result, `missing doctor check ${name}`).toBeDefined();
  return result!;
}

// Task 2.2 fix round 1 (finding 1): wireClient's envFile now defaults via
// resolveEnvFile, which checks env.KOPENG_ENV_FILE FIRST, unconditionally.
// vitest.config.ts pins KOPENG_ENV_FILE globally to a harmless nonexistent
// path for every test — this suite's wireClient() calls (below, and inline
// in the feature-posture tests) rely on the pre-existing <repoRoot>/.env
// placement, so it clears the var for its own scope, same convention
// wire-client.test.ts and first-run.test.ts use.
const ORIGINAL_KOPENG_ENV_FILE = process.env.KOPENG_ENV_FILE;

beforeEach(async () => {
  delete process.env.KOPENG_ENV_FILE;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-doctor-test-'));
  homeDir = path.join(scratch, 'home');
  repoRoot = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), `{"name":"kopeng","version":"${REPO_VERSION}"}\n`, 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist', 'index.js'), '// built test entry\n', 'utf8');
  // Copy the WHOLE hooks directory, never an enumerated subset. The hooks
  // import each other as sibling modules, and a spawned hook that cannot
  // resolve one of those siblings dies before it runs a line — surfacing as a
  // bare `Recall hook: fail` that looks like a product bug rather than a
  // missing fixture file. The enumerated list broke twice this way: once when
  // RULING-C (WS7.6) added project-scope.mjs, and again when T72 added
  // entrypoint.mjs. `package.json` ships `scripts/hooks` wholesale, so copying
  // it wholesale is also the more faithful model of a real install.
  fs.cpSync(
    path.join(process.cwd(), 'scripts', 'hooks'),
    path.join(repoRoot, 'scripts', 'hooks'),
    { recursive: true }
  );
  fs.writeFileSync(
    path.join(repoRoot, '.env'),
    'OBSERVATION_INGESTION_ENABLED=false\nDISCOVERY_DETECTION_ENABLED=false\nDREAMING_ENABLED=false\n',
    'utf8'
  );

  doctorEnv = { ...process.env };
  delete doctorEnv.OBSERVATION_INGESTION_ENABLED;
  delete doctorEnv.DISCOVERY_DETECTION_ENABLED;
  delete doctorEnv.DREAMING_ENABLED;
  healthData = { status: 'ready', embedding: 'loaded', memories: 1, version: REPO_VERSION };
  corpusHealthData = { legacy_anchor_count: 0 };
  await startServer();
  wireClient({ homeDir, repoRoot, apiUrl, apply: true, log: () => undefined });
});

afterEach(async () => {
  if (ORIGINAL_KOPENG_ENV_FILE === undefined) delete process.env.KOPENG_ENV_FILE;
  else process.env.KOPENG_ENV_FILE = ORIGINAL_KOPENG_ENV_FILE;
  await stopServer();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('runDoctor', () => {
  it('passes a wire-created install, exercises the real hook, and changes no config or repo file', async () => {
    const beforeHome = snapshotTree(homeDir);
    const beforeRepo = snapshotTree(repoRoot);
    const output: string[] = [];

    const report = await runDoctor({
      homeDir,
      repoRoot,
      env: doctorEnv,
      log: line => output.push(line),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.every(row => row.state === 'pass')).toBe(true);
    expect(check(report, 'Recall hook').detail).toMatch(/real hook/i);
    expect(report.posture).toContain('Passive learning is OFF');
    expect(report.posture).toContain('observe hooks are wired but inert');
    expect(output.join('\n')).toContain('[INFO] Feature posture:');
    expect(snapshotTree(homeDir)).toEqual(beforeHome);
    expect(snapshotTree(repoRoot)).toEqual(beforeRepo);
  });

  it('reports server-down once and skips the dependent recall check without inventing wiring failures', async () => {
    await stopServer();

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(report.ok).toBe(false);
    expect(check(report, 'Server')).toMatchObject({ state: 'fail' });
    expect(check(report, 'Recall hook')).toMatchObject({ state: 'skip' });
    expect(check(report, 'MCP registration')).toMatchObject({ state: 'pass' });
    expect(check(report, 'Hook UserPromptSubmit')).toMatchObject({ state: 'pass' });
  });

  it('names a missing MCP block and prints the exact wire fix', async () => {
    const claude = readJson(claudePath());
    delete (claude.mcpServers as Record<string, unknown>).kopeng;
    writeJson(claudePath(), claude);

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(check(report, 'MCP registration')).toMatchObject({
      state: 'fail',
      fix: 'npm run wire -- --apply',
    });
    expect(check(report, 'MCP registration').detail).toMatch(/mcpServers\.kopeng is missing/i);
  });

  it('catches missing and stale hook paths individually', async () => {
    const settings = readJson(settingsPath());
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    delete hooks.SessionEnd;
    const staleClone = path.join(scratch, 'old-clone', 'scripts', 'hooks', 'memory-prompt-search.mjs');
    hooks.UserPromptSubmit[0].hooks[0].command = `node "${staleClone}"`;
    writeJson(settingsPath(), settings);

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(check(report, 'Hook SessionEnd')).toMatchObject({ state: 'fail', fix: 'npm run wire -- --apply' });
    expect(check(report, 'Hook UserPromptSubmit').detail).toMatch(/moved clone/i);
    expect(check(report, 'Recall hook')).toMatchObject({ state: 'skip' });
  });

  it('reports a missing current dist entry point as not built', async () => {
    fs.unlinkSync(path.join(repoRoot, 'dist', 'index.js'));

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(check(report, 'MCP entry point')).toMatchObject({ state: 'fail', fix: 'npm run build' });
    expect(check(report, 'MCP entry point').detail).toMatch(/not built/i);
  });

  it('reports the actual enabled feature posture without changing defaults', async () => {
    fs.writeFileSync(path.join(repoRoot, '.env'), '', 'utf8');
    wireClient({ homeDir, repoRoot, profile: 'everything', apply: true, log: () => undefined });

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(report.posture).toContain('Passive learning is ON');
    expect(report.posture).toContain('Dreaming is ON');
  });

  it('reports the passive-learning posture produced by the recommended profile', async () => {
    fs.writeFileSync(path.join(repoRoot, '.env'), '', 'utf8');
    wireClient({ homeDir, repoRoot, profile: 'recommended', apply: true, log: () => undefined });

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(report.posture).toContain('Passive learning is ON');
    expect(report.posture).toContain('Dreaming is OFF');
  });

  it('Task 2.2: an explicit envFile overrides repoRoot/.env — the packaged-install case', async () => {
    // Simulates `kopeng init`: repoRoot is the installed package (never ships
    // a .env), the REAL config lives elsewhere (~/.kopeng/.env). Without the
    // envFile option, featurePosture would silently read repoRoot/.env (empty
    // here) and always report everything OFF.
    fs.writeFileSync(path.join(repoRoot, '.env'), '', 'utf8');
    const packagedEnvFile = path.join(scratch, 'packaged.env');
    fs.writeFileSync(
      packagedEnvFile,
      'OBSERVATION_INGESTION_ENABLED=true\nDISCOVERY_DETECTION_ENABLED=true\nDREAMING_ENABLED=true\n',
      'utf8'
    );

    const withOverride = await runDoctor({ homeDir, repoRoot, env: doctorEnv, envFile: packagedEnvFile, log: () => undefined });
    expect(withOverride.posture).toContain('Passive learning is ON');
    expect(withOverride.posture).toContain('Dreaming is ON');

    const withoutOverride = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });
    expect(withoutOverride.posture).toContain('Passive learning is OFF');
    expect(withoutOverride.posture).toContain('Dreaming is OFF');
  });

  it('Finding 2: an explicit KOPENG_ENV_FILE (carried on the env option) wins over repoRoot/.env', async () => {
    // featurePosture's own default now resolves via resolveEnvFile, whose
    // FIRST check is env.KOPENG_ENV_FILE — this must win outright, same as
    // wire-client's envFile resolution, regardless of what repoRoot/.env says.
    const explicitEnvFile = path.join(scratch, 'explicit-kopeng-env-file.env');
    fs.writeFileSync(
      explicitEnvFile,
      'OBSERVATION_INGESTION_ENABLED=true\nDISCOVERY_DETECTION_ENABLED=true\nDREAMING_ENABLED=true\n',
      'utf8'
    );

    const report = await runDoctor({
      homeDir,
      repoRoot,
      env: { ...doctorEnv, KOPENG_ENV_FILE: explicitEnvFile },
      log: () => undefined,
    });

    // repoRoot/.env (written in beforeEach) is everything OFF, so ON/ON here
    // can only come from the explicit KOPENG_ENV_FILE override.
    expect(report.posture).toContain('Passive learning is ON');
    expect(report.posture).toContain('Dreaming is ON');
  });

  it('fails soft when one client config is invalid JSON', async () => {
    fs.writeFileSync(claudePath(), '{not-json', 'utf8');

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(check(report, 'MCP registration')).toMatchObject({ state: 'fail' });
    expect(check(report, 'MCP registration').detail).toMatch(/invalid JSON/i);
    expect(check(report, 'Server')).toMatchObject({ state: 'pass' });
    expect(check(report, 'Hook UserPromptSubmit')).toMatchObject({ state: 'pass' });
    expect(check(report, 'Recall hook')).toMatchObject({ state: 'pass' });
  });

  it("checks node on the PATH supplied to Claude's hooks", async () => {
    const settings = readJson(settingsPath());
    (settings.env as Record<string, unknown>).PATH = path.join(scratch, 'empty-path');
    fs.mkdirSync(path.join(scratch, 'empty-path'));
    writeJson(settingsPath(), settings);

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(check(report, 'Hook runtime')).toMatchObject({ state: 'fail' });
    expect(check(report, 'Hook runtime').detail).toMatch(/not executable/i);
    expect(check(report, 'Recall hook')).toMatchObject({ state: 'skip' });
  });

  it('does not mask a hook/MCP URL mismatch when invoking the real hook', async () => {
    const settings = readJson(settingsPath());
    (settings.env as Record<string, unknown>).KOPENG_API_URL = 'http://127.0.0.1:1';
    writeJson(settingsPath(), settings);

    const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

    expect(check(report, 'Client URLs')).toMatchObject({
      state: 'fail',
      fix: 'npm run wire -- --apply --api-url http://127.0.0.1:1',
    });
    expect(check(report, 'Client URLs').detail).toContain(apiUrl);
    expect(check(report, 'Server')).toMatchObject({ state: 'fail' });
    expect(check(report, 'Recall hook')).toMatchObject({ state: 'skip' });
  });

  describe('version skew (WS7.1)', () => {
    it('reports ok when the server and local checkout report the same version', async () => {
      const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

      expect(report.ok).toBe(true);
      expect(check(report, 'Version')).toMatchObject({ state: 'pass' });
    });

    it('warns, without failing, on a server/local version mismatch', async () => {
      healthData = { ...healthData, version: '9.9.9' };

      const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

      expect(report.ok).toBe(true);
      const versionCheck = check(report, 'Version');
      expect(versionCheck.state).toBe('warn');
      expect(versionCheck.detail).toContain('9.9.9');
      expect(versionCheck.detail).toContain(REPO_VERSION);
      expect(versionCheck.detail).toMatch(/restart the server/i);
    });

    it('warns, without failing, when the server payload has no version field (older server)', async () => {
      const { version: _unused, ...rest } = healthData;
      healthData = rest;

      const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

      expect(report.ok).toBe(true);
      const versionCheck = check(report, 'Version');
      expect(versionCheck.state).toBe('warn');
      expect(versionCheck.detail).toMatch(/did not report a version|older server/i);
    });
  });

  describe('legacy anchor deprecation warning (WS7.4 B3)', () => {
    it('warns with the count and the migration command when legacy anchors exist', async () => {
      corpusHealthData = { legacy_anchor_count: 3 };

      const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

      const legacyCheck = check(report, 'Legacy anchors');
      expect(legacyCheck.state).toBe('warn');
      expect(legacyCheck.detail).toContain('3');
      // repoRoot here is a from-source checkout (no node_modules segment), so
      // doctor must name the npm script; the packaged branch is pinned below.
      expect(legacyCheck.detail).toContain('npm run migrate:anchors');
      expect(legacyCheck.detail).toContain('npm run migrate:anchors -- --apply');
      expect(report.ok).toBe(true); // a warn never fails doctor
    });

    it('names the PACKAGED command when this copy lives inside node_modules (Finding 3: `npm run migrate:anchors` is unrunnable there — no scripts/ops in `files`, no tsx)', async () => {
      corpusHealthData = { legacy_anchor_count: 2 };
      const packagedRoot = path.join(scratch, 'app', 'node_modules', 'kopeng');

      const report = await runDoctor({ homeDir, repoRoot: packagedRoot, env: doctorEnv, log: () => undefined });

      const legacyCheck = check(report, 'Legacy anchors');
      expect(legacyCheck.state).toBe('warn');
      expect(legacyCheck.detail).toContain('kopeng migrate-anchors');
      expect(legacyCheck.detail).toContain('kopeng migrate-anchors --apply');
      expect(legacyCheck.detail).not.toContain('npm run migrate:anchors');
    });

    it('passes when there are no legacy anchors', async () => {
      corpusHealthData = { legacy_anchor_count: 0 };

      const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

      expect(check(report, 'Legacy anchors')).toMatchObject({ state: 'pass' });
    });

    it('does not fail when an older server does not report legacy_anchor_count at all', async () => {
      corpusHealthData = {}; // field absent — older server

      const report = await runDoctor({ homeDir, repoRoot, env: doctorEnv, log: () => undefined });

      expect(report.ok).toBe(true);
      const legacyCheck = report.checks.find(row => row.name === 'Legacy anchors');
      // Either no check line at all, or a non-failing one — never a fail.
      if (legacyCheck) expect(legacyCheck.state).not.toBe('fail');
    });
  });

  describe('ensure_conflict.json hint (Finding 4)', () => {
    let hintsDir: string;

    beforeEach(() => {
      hintsDir = path.join(scratch, 'hints');
      fs.mkdirSync(hintsDir, { recursive: true });
    });

    function writeHint(timestamp: string): void {
      fs.writeFileSync(
        path.join(hintsDir, 'ensure_conflict.json'),
        JSON.stringify({ port: 3200, reason: 'a non-KOPENG process is already listening on this port', timestamp }),
        'utf8'
      );
    }

    it('warns when a fresh (<24h) ensure_conflict.json hint exists', async () => {
      writeHint(new Date().toISOString());

      const report = await runDoctor({
        homeDir, repoRoot, env: { ...doctorEnv, KOPENG_HINTS_DIR: hintsDir }, log: () => undefined,
      });

      expect(check(report, 'Ensure conflict hint')).toMatchObject({ state: 'warn' });
      expect(check(report, 'Ensure conflict hint').detail).toContain('3200');
      expect(report.ok).toBe(true); // a warn never fails doctor
    });

    it('reports nothing for a stale (>=24h) hint', async () => {
      writeHint(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());

      const report = await runDoctor({
        homeDir, repoRoot, env: { ...doctorEnv, KOPENG_HINTS_DIR: hintsDir }, log: () => undefined,
      });

      expect(report.checks.find(row => row.name === 'Ensure conflict hint')).toBeUndefined();
    });

    it('reports nothing when no hint file exists', async () => {
      const report = await runDoctor({
        homeDir, repoRoot, env: { ...doctorEnv, KOPENG_HINTS_DIR: hintsDir }, log: () => undefined,
      });

      expect(report.checks.find(row => row.name === 'Ensure conflict hint')).toBeUndefined();
    });
  });
});

// Finding 2 (fix round): a standalone `kopeng doctor` (no explicit envFile,
// as `kopeng init`/`update` pass) on a PACKAGED install must default to the
// real ~/.kopeng/.env, not silently read the never-shipped <repoRoot>/.env
// inside node_modules. PACKAGED_ENV_FILE (src/cli/paths.ts) is a module-level
// constant baked from process.env.KOPENG_HOME at import time, so — same
// pattern as tests/unit/first-run.test.ts's config.ts reload block — this
// needs vi.resetModules() + a dynamic re-import to pick up a fresh KOPENG_HOME.
describe('featurePosture default on a packaged install (Finding 2)', () => {
  const ORIGINAL_KOPENG_HOME = process.env.KOPENG_HOME;
  let fakeKopengHome: string;
  let packagedRepoRoot: string;
  let bareHomeDir: string;

  beforeEach(() => {
    fakeKopengHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-doctor-khome-'));
    packagedRepoRoot = path.join(fakeKopengHome, 'app', 'node_modules', 'kopeng');
    fs.mkdirSync(packagedRepoRoot, { recursive: true });
    bareHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-doctor-bhome-'));
    fs.mkdirSync(path.join(bareHomeDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(bareHomeDir, '.claude.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(bareHomeDir, '.claude', 'settings.json'), '{}\n', 'utf8');
  });

  afterEach(() => {
    if (ORIGINAL_KOPENG_HOME === undefined) delete process.env.KOPENG_HOME;
    else process.env.KOPENG_HOME = ORIGINAL_KOPENG_HOME;
    vi.resetModules();
    fs.rmSync(fakeKopengHome, { recursive: true, force: true });
    fs.rmSync(bareHomeDir, { recursive: true, force: true });
  });

  it('a node_modules-resident repoRoot with no explicit envFile reads ~/.kopeng/.env via KOPENG_HOME', async () => {
    fs.writeFileSync(
      path.join(fakeKopengHome, '.env'),
      'OBSERVATION_INGESTION_ENABLED=true\nDISCOVERY_DETECTION_ENABLED=true\nDREAMING_ENABLED=true\n',
      'utf8'
    );
    process.env.KOPENG_HOME = fakeKopengHome;
    vi.resetModules();
    const { runDoctor: freshRunDoctor } = await import('../../src/cli/doctor.js');

    const report = await freshRunDoctor({
      homeDir: bareHomeDir,
      repoRoot: packagedRepoRoot,
      env: {}, // no KOPENG_ENV_FILE, no feature-flag env overrides — file-only
      fetchImpl: (async () => { throw new Error('no server in this test'); }) as unknown as typeof fetch,
      log: () => undefined,
    });

    expect(report.posture).toContain('Passive learning is ON');
    expect(report.posture).toContain('Dreaming is ON');
  });

  it('an explicit KOPENG_ENV_FILE still wins over the packaged ~/.kopeng/.env default', async () => {
    fs.writeFileSync(
      path.join(fakeKopengHome, '.env'),
      'OBSERVATION_INGESTION_ENABLED=true\nDISCOVERY_DETECTION_ENABLED=true\nDREAMING_ENABLED=true\n',
      'utf8'
    );
    const explicitEnvFile = path.join(fakeKopengHome, 'explicit.env');
    fs.writeFileSync(explicitEnvFile, '', 'utf8'); // everything OFF
    process.env.KOPENG_HOME = fakeKopengHome;
    vi.resetModules();
    const { runDoctor: freshRunDoctor } = await import('../../src/cli/doctor.js');

    const report = await freshRunDoctor({
      homeDir: bareHomeDir,
      repoRoot: packagedRepoRoot,
      env: { KOPENG_ENV_FILE: explicitEnvFile },
      fetchImpl: (async () => { throw new Error('no server in this test'); }) as unknown as typeof fetch,
      log: () => undefined,
    });

    expect(report.posture).toContain('Passive learning is OFF');
    expect(report.posture).toContain('Dreaming is OFF');
  });
});

describe('isPackagedInstall (Finding 3 — which fix line doctor may prescribe)', () => {
  it('is true only for a root with a node_modules path segment', () => {
    expect(isPackagedInstall(path.join('C:', 'Users', 'x', '.kopeng', 'app', 'node_modules', 'kopeng'))).toBe(true);
    expect(isPackagedInstall('/home/x/.kopeng/app/node_modules/kopeng')).toBe(true);
    expect(isPackagedInstall('/home/x/code/kopeng')).toBe(false);
    // A directory merely NAMED like the marker is not a segment match.
    expect(isPackagedInstall('/home/x/code/my-node_modules-notes')).toBe(false);
  });
});
