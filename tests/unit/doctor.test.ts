import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runDoctor } from '../../scripts/ops/doctor.js';
import { HOOK_DEFINITIONS, wireClient } from '../../scripts/ops/wire-client.js';

const MEMORY_CONTENT = 'KOPENG doctor marker 4c12b9 remains available through the real recall hook.';

let scratch: string;
let homeDir: string;
let repoRoot: string;
let server: http.Server;
let apiUrl: string;
let doctorEnv: NodeJS.ProcessEnv;

function json(response: http.ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function startServer(): Promise<void> {
  server = http.createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/api/health') {
      json(response, { data: { status: 'ready', embedding: 'loaded', memories: 1 } });
    } else if (request.method === 'GET' && url.startsWith('/api/memories?')) {
      json(response, { data: [{ id: 1, content: MEMORY_CONTENT, type: 'reference', scope: 'global' }] });
    } else if (request.method === 'POST' && url === '/api/memories/recall') {
      json(response, { data: [{ id: 1, content: MEMORY_CONTENT, type: 'reference', score: 0.99 }] });
    } else if (request.method === 'POST' && url === '/api/surface') {
      json(response, { data: { tools: [], skills: [], conventions: [] } });
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

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-doctor-test-'));
  homeDir = path.join(scratch, 'home');
  repoRoot = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"kopeng"}\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'dist', 'index.js'), '// built test entry\n', 'utf8');
  for (const definition of HOOK_DEFINITIONS) {
    fs.copyFileSync(
      path.join(process.cwd(), 'scripts', 'hooks', definition.script),
      path.join(repoRoot, 'scripts', 'hooks', definition.script)
    );
  }
  fs.copyFileSync(
    path.join(process.cwd(), 'scripts', 'hooks', 'canonical-triggers.mjs'),
    path.join(repoRoot, 'scripts', 'hooks', 'canonical-triggers.mjs')
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
  await startServer();
  wireClient({ homeDir, repoRoot, apiUrl, apply: true, log: () => undefined });
});

afterEach(async () => {
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
});
