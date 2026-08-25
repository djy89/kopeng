import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { HOOK_DEFINITIONS } from './wire-client.js';

type JsonObject = Record<string, unknown>;
type CheckState = 'pass' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  state: CheckState;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  posture: string;
  apiUrl: string;
}

export interface DoctorOptions {
  homeDir?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

interface JsonRead {
  path: string;
  value: JsonObject | null;
  exists: boolean;
  error?: string;
}

interface HookCommand {
  path: string;
  suffix: string;
}

interface HookRun {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_API_URL = 'http://localhost:3200';
const HTTP_TIMEOUT_MS = 5_000;
const HOOK_TIMEOUT_MS = 15_000;
const DOCTOR_PROMPT = 'Please retrieve the saved note used for this KOPENG doctor recall verification.';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): JsonRead {
  if (!fs.existsSync(filePath)) return { path: filePath, value: null, exists: false };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!isObject(parsed)) throw new Error('top level is not an object');
    return { path: filePath, value: parsed, exists: true };
  } catch (error) {
    return {
      path: filePath,
      value: null,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function posixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function samePath(a: string, b: string): boolean {
  const left = posixPath(path.resolve(a));
  const right = posixPath(path.resolve(b));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nestedObject(parent: JsonObject | null, ...keys: string[]): JsonObject | null {
  let current: JsonObject | null = parent;
  for (const key of keys) {
    const next = current?.[key];
    if (!isObject(next)) return null;
    current = next;
  }
  return current;
}

function resolveApiUrl(
  claudeConfig: JsonObject | null,
  settings: JsonObject | null,
  env: NodeJS.ProcessEnv
): { apiUrl: string; mismatch?: { hookUrl: string; mcpUrl: string } } {
  const settingsEnv = nestedObject(settings, 'env');
  const kopeng = nestedObject(claudeConfig, 'mcpServers', 'kopeng');
  const hookUrl = stringValue(settingsEnv?.KOPENG_API_URL)
    ?? stringValue(settingsEnv?.MEMORY_API_URL)
    ?? env.KOPENG_API_URL
    ?? env.MEMORY_API_URL
    ?? DEFAULT_API_URL;
  const mcpUrl = stringValue(nestedObject(kopeng, 'env')?.MEMORY_API_URL)
    ?? env.MEMORY_API_URL
    ?? DEFAULT_API_URL;
  return {
    apiUrl: hookUrl.replace(/\/$/, ''),
    ...(kopeng && settings && hookUrl !== mcpUrl ? { mismatch: { hookUrl, mcpUrl } } : {}),
  };
}

function fail(name: string, detail: string, fix: string): DoctorCheck {
  return { name, state: 'fail', detail, fix };
}

function checkMcp(config: JsonRead, repoRoot: string): DoctorCheck {
  const fixWire = 'npm run wire -- --apply';
  if (!config.exists) return fail('MCP registration', `${config.path} does not exist.`, fixWire);
  if (config.error || !config.value) {
    return fail(
      'MCP registration',
      `${config.path} is invalid JSON (${config.error ?? 'unknown parse error'}).`,
      `repair ${config.path}, then run ${fixWire}`
    );
  }

  const kopeng = nestedObject(config.value, 'mcpServers', 'kopeng');
  if (!kopeng) return fail('MCP registration', 'mcpServers.kopeng is missing.', fixWire);
  if (kopeng.type !== 'stdio' || kopeng.command !== 'node') {
    return fail('MCP registration', 'mcpServers.kopeng must use type "stdio" and command "node".', fixWire);
  }
  if (!Array.isArray(kopeng.args) || typeof kopeng.args[0] !== 'string') {
    return fail('MCP registration', 'mcpServers.kopeng.args has no entry-point path.', fixWire);
  }

  const configured = kopeng.args[0];
  if (!path.isAbsolute(configured)) {
    return fail('MCP registration', `entry-point path is not absolute: ${configured}`, fixWire);
  }
  if (!posixPath(configured).toLowerCase().endsWith('/dist/index.js')) {
    return fail('MCP registration', `entry point is not dist/index.js: ${configured}`, fixWire);
  }

  const expected = path.join(repoRoot, 'dist', 'index.js');
  if (!samePath(configured, expected)) {
    return fail(
      'MCP registration',
      `entry point targets a different or moved clone: ${configured}`,
      fixWire
    );
  }
  if (!fs.existsSync(configured)) {
    return fail(
      'MCP entry point',
      `${configured} does not exist — KOPENG is not built.`,
      'npm run build'
    );
  }
  return { name: 'MCP registration', state: 'pass', detail: `dist/index.js resolves at ${posixPath(configured)}.` };
}

function parseHookCommand(command: string): HookCommand | null {
  const match = command.match(/^node(?:\.exe)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/i);
  if (!match) return null;
  return { path: match[1] ?? match[2] ?? match[3], suffix: (match[4] ?? '').trim() };
}

function hookCandidates(settings: JsonObject, event: string, script: string): Array<{ entry: JsonObject; command: string }> {
  const hooks = nestedObject(settings, 'hooks');
  const entries = hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const needle = `/scripts/hooks/${script.toLowerCase()}`;
  const found: Array<{ entry: JsonObject; command: string }> = [];
  for (const entry of entries) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!isObject(hook) || typeof hook.command !== 'string') continue;
      if (hook.command.replace(/\\/g, '/').toLowerCase().includes(needle)) {
        found.push({ entry, command: hook.command });
      }
    }
  }
  return found;
}

function checkHooks(settingsRead: JsonRead, repoRoot: string): { checks: DoctorCheck[]; promptHookPath?: string } {
  const fixWire = 'npm run wire -- --apply';
  if (!settingsRead.exists) {
    return { checks: [fail('Claude hooks', `${settingsRead.path} does not exist.`, fixWire)] };
  }
  if (settingsRead.error || !settingsRead.value) {
    return {
      checks: [fail(
        'Claude hooks',
        `${settingsRead.path} is invalid JSON (${settingsRead.error ?? 'unknown parse error'}).`,
        `repair ${settingsRead.path}, then run ${fixWire}`
      )],
    };
  }

  const checks: DoctorCheck[] = [];
  let promptHookPath: string | undefined;
  for (const definition of HOOK_DEFINITIONS) {
    const name = `Hook ${definition.event}`;
    const candidates = hookCandidates(settingsRead.value, definition.event, definition.script);
    if (candidates.length === 0) {
      checks.push(fail(name, `${definition.script} is missing from hooks.${definition.event}.`, fixWire));
      continue;
    }
    if (candidates.length > 1) {
      checks.push(fail(name, `${definition.script} appears ${candidates.length} times.`, fixWire));
      continue;
    }

    const candidate = candidates[0];
    const parsed = parseHookCommand(candidate.command);
    if (!parsed) {
      checks.push(fail(name, `command is not a supported node command: ${candidate.command}`, fixWire));
      continue;
    }
    const expectedSuffix = 'suffix' in definition ? definition.suffix : '';
    if (parsed.suffix !== expectedSuffix) {
      checks.push(fail(name, `command has the wrong arguments: ${candidate.command}`, fixWire));
      continue;
    }
    if ('matcher' in definition && candidate.entry.matcher !== definition.matcher) {
      checks.push(fail(name, `matcher must be "${definition.matcher}".`, fixWire));
      continue;
    }
    if (!path.isAbsolute(parsed.path)) {
      checks.push(fail(name, `script path is not absolute: ${parsed.path}`, fixWire));
      continue;
    }

    const expected = path.join(repoRoot, 'scripts', 'hooks', definition.script);
    if (!samePath(parsed.path, expected)) {
      checks.push(fail(name, `script path targets a different or moved clone: ${parsed.path}`, fixWire));
      continue;
    }
    if (!fs.existsSync(parsed.path)) {
      checks.push(fail(
        name,
        `script does not exist: ${parsed.path}`,
        `restore scripts/hooks/${definition.script}, then run ${fixWire}`
      ));
      continue;
    }

    checks.push({ name, state: 'pass', detail: `${definition.script} resolves.` });
    if (definition.event === 'UserPromptSubmit') promptHookPath = parsed.path;
  }
  return { checks, promptHookPath };
}

function hookEnvironment(settings: JsonObject | null, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base };
  const configured = nestedObject(settings, 'env');
  if (!configured) return result;

  for (const [key, value] of Object.entries(configured)) {
    if (typeof value !== 'string') continue;
    if (key.toLowerCase() === 'path') {
      for (const existing of Object.keys(result)) {
        if (existing.toLowerCase() === 'path') delete result[existing];
      }
    }
    result[key] = value;
  }
  return result;
}

function checkNode(env: NodeJS.ProcessEnv): DoctorCheck {
  const run = spawnSync('node', ['--version'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  const fix = 'install Node.js 20+ and put node on the PATH Claude Code inherits, then restart Claude Code';
  if (run.error || run.status !== 0) {
    return fail('Hook runtime', `node is not executable on the hooks' PATH (${run.error?.message ?? `exit ${run.status}`}).`, fix);
  }
  const version = run.stdout.trim();
  const major = Number(version.match(/^v(\d+)/)?.[1]);
  if (!Number.isInteger(major) || major < 20) {
    return fail('Hook runtime', `node resolves to ${version || 'an unknown version'}; KOPENG requires Node 20+.`, fix);
  }
  return { name: 'Hook runtime', state: 'pass', detail: `node ${version} resolves on the hooks' PATH.` };
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* reported as an unexpected shape by the caller */ }
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    return { ok: false, status: 0, json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkHealth(fetchImpl: typeof fetch, apiUrl: string): Promise<DoctorCheck> {
  const response = await fetchJson(fetchImpl, `${apiUrl}/api/health`);
  const fix = `start KOPENG with npm start and verify ${apiUrl}/api/health, then re-run npm run doctor`;
  if (!response.ok) {
    return fail('Server', `not reachable at ${apiUrl} (${response.error ?? `HTTP ${response.status}`}).`, fix);
  }
  const data = isObject(response.json) && isObject(response.json.data) ? response.json.data : null;
  if (!data) return fail('Server', '/api/health returned an unexpected response shape.', fix);
  if (data.embedding !== 'loaded') {
    return fail(
      'Server',
      `reachable, but the embedding index is ${String(data.embedding ?? 'unknown')}.`,
      'wait for the model to load; if it stays unready, check the server log, then re-run npm run doctor'
    );
  }
  return {
    name: 'Server',
    state: 'pass',
    detail: `reachable at ${apiUrl}; embedding index loaded (${String(data.memories ?? '?')} memories).`,
  };
}

function spawnHook(
  hookPath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  prompt: string
): Promise<HookRun> {
  return new Promise(resolvePromise => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-doctor-hook-'));
    const childEnv = {
      ...env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      KOPENG_HINTS_DIR: path.join(sandboxHome, '.kopeng', 'hints'),
    };
    const child = spawn('node', [hookPath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: HookRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(sandboxHome, { recursive: true, force: true });
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ stdout, stderr, code: null, error: `timed out after ${HOOK_TIMEOUT_MS}ms` });
    }, HOOK_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => finish({ stdout, stderr, code: null, error: error.message }));
    child.on('close', code => finish({ stdout, stderr, code }));
    child.stdin.on('error', () => { /* close/error handlers carry the diagnosis */ });
    try {
      child.stdin.write(JSON.stringify({
        user_prompt: prompt,
        cwd: repoRoot,
        session_id: 'kopeng-doctor',
      }));
      child.stdin.end();
    } catch { /* same EPIPE race handled by the child events */ }
  });
}

async function checkRecall(
  fetchImpl: typeof fetch,
  apiUrl: string,
  hookPath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv
): Promise<DoctorCheck> {
  const listed = await fetchJson(fetchImpl, `${apiUrl}/api/memories?fields=lite&limit=1`);
  const fix = 'run npm run wire -- --apply, then re-run npm run doctor';
  if (!listed.ok || !isObject(listed.json) || !Array.isArray(listed.json.data)) {
    return fail(
      'Recall hook',
      `could not read an active-memory probe from the server (${listed.error ?? `HTTP ${listed.status}`}).`,
      'check the server log and /api/memories, then re-run npm run doctor'
    );
  }
  const rows = listed.json.data;
  const content = isObject(rows[0]) && typeof rows[0].content === 'string' ? rows[0].content : '';
  const prompt = content ? `${DOCTOR_PROMPT} ${content.slice(0, 160)}` : DOCTOR_PROMPT;
  const direct = await fetchJson(fetchImpl, `${apiUrl}/api/memories/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: prompt.slice(0, 200),
      scopes: [`project:${path.basename(repoRoot)}`, 'global'],
      threshold: 0.40,
      limit: 3,
    }),
  });
  if (!direct.ok || !isObject(direct.json) || !Array.isArray(direct.json.data)) {
    return fail(
      'Recall hook',
      `the live recall endpoint failed its read-only probe (${direct.error ?? `HTTP ${direct.status}`}).`,
      'check the server log and /api/memories/recall, then re-run npm run doctor'
    );
  }
  const run = await spawnHook(hookPath, repoRoot, env, prompt);
  if (run.error || run.code !== 0) {
    return fail(
      'Recall hook',
      `the real UserPromptSubmit hook failed (${run.error ?? `exit ${run.code}`}${run.stderr ? `; ${run.stderr.slice(0, 160)}` : ''}).`,
      fix
    );
  }

  let parsed: unknown;
  try { parsed = JSON.parse(run.stdout); } catch {
    return fail('Recall hook', `the real hook returned invalid JSON: ${run.stdout.slice(0, 160) || '<empty>'}`, fix);
  }
  if (!isObject(parsed)) return fail('Recall hook', 'the real hook returned a non-object JSON value.', fix);

  const output = isObject(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : null;
  const context = output && typeof output.additionalContext === 'string' ? output.additionalContext : '';
  const directRows = direct.json.data;
  const expectedContent = isObject(directRows[0]) && typeof directRows[0].content === 'string'
    ? directRows[0].content
    : '';
  if (expectedContent) {
    const marker = expectedContent.slice(0, 80);
    if (!context.includes(marker)) {
      return fail(
        'Recall hook',
        'the server has an active memory, but the real hook did not return it in hookSpecificOutput.additionalContext.',
        fix
      );
    }
    return { name: 'Recall hook', state: 'pass', detail: 'live recall returned an active memory through the real hook.' };
  }

  return {
    name: 'Recall hook',
    state: 'pass',
    detail: content
      ? 'the real hook completed a live recall; the read-only probe produced no matching memory.'
      : 'the real hook completed a live recall against the empty store (no memory was expected).',
  };
}

export function featurePosture(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  let fileEnv: Record<string, string> = {};
  const envPath = path.join(repoRoot, '.env');
  try { fileEnv = dotenv.parse(fs.readFileSync(envPath)); } catch { /* missing .env means shipped defaults */ }
  const value = (name: string): string => env[name] ?? fileEnv[name] ?? 'false';
  const ingestion = value('OBSERVATION_INGESTION_ENABLED') === 'true';
  const detection = value('DISCOVERY_DETECTION_ENABLED') === 'true';
  const dreaming = value('DREAMING_ENABLED') === 'true';
  const dreamText = `Dreaming is ${dreaming ? 'ON' : 'OFF'}.`;

  if (ingestion && detection) {
    return `Passive learning is ON — tool-use observations are captured and analyzed. ${dreamText}`;
  }
  if (!ingestion && !detection) {
    return `Passive learning is OFF — the two observe hooks are wired but inert. KOPENG will only remember what you explicitly ask it to. ${dreamText}`;
  }
  if (ingestion) {
    return `Passive learning is PARTIAL — observations are captured, but discovery detection is OFF, so they are not becoming memories. ${dreamText}`;
  }
  return `Passive learning is PARTIAL — discovery detection is ON, but observation ingestion is OFF, so it has no new tool-use input. ${dreamText}`;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const claudeRead = readJson(path.join(homeDir, '.claude.json'));
  const settingsRead = readJson(path.join(homeDir, '.claude', 'settings.json'));
  const resolvedUrl = resolveApiUrl(claudeRead.value, settingsRead.value, env);
  const checks: DoctorCheck[] = [];

  if (resolvedUrl.mismatch) {
    checks.push(fail(
      'Client URLs',
      `hooks use ${resolvedUrl.mismatch.hookUrl}, but MCP uses ${resolvedUrl.mismatch.mcpUrl}.`,
      `npm run wire -- --apply --api-url ${resolvedUrl.mismatch.hookUrl}`
    ));
  }

  checks.push(await checkHealth(fetchImpl, resolvedUrl.apiUrl));
  checks.push(checkMcp(claudeRead, repoRoot));
  const hookResult = checkHooks(settingsRead, repoRoot);
  checks.push(...hookResult.checks);
  const effectiveHookEnv = hookEnvironment(settingsRead.value, env);
  const nodeCheck = checkNode(effectiveHookEnv);
  checks.push(nodeCheck);

  const serverReady = checks.some(check => check.name === 'Server' && check.state === 'pass');
  const promptReady = hookResult.checks.some(check => check.name === 'Hook UserPromptSubmit' && check.state === 'pass');
  if (serverReady && promptReady && nodeCheck.state === 'pass' && hookResult.promptHookPath) {
    checks.push(await checkRecall(
      fetchImpl,
      resolvedUrl.apiUrl,
      hookResult.promptHookPath,
      repoRoot,
      effectiveHookEnv
    ));
  } else {
    checks.push({
      name: 'Recall hook',
      state: 'skip',
      detail: 'not run until the server, UserPromptSubmit path, and hook runtime pass.',
    });
  }

  const posture = featurePosture(repoRoot, env);
  for (const check of checks) {
    log(`[${check.state.toUpperCase()}] ${check.name}: ${check.detail}`);
    if (check.state === 'fail') log(`       Fix: ${check.fix}`);
  }
  log(`[INFO] Feature posture: ${posture}`);

  const ok = checks.every(check => check.state !== 'fail');
  log(ok ? 'Doctor passed: the KOPENG server and Claude Code client wiring are ready.' : 'Doctor failed: apply the fixes above and re-run npm run doctor.');
  return { ok, checks, posture, apiUrl: resolvedUrl.apiUrl };
}

function isDirectRun(): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) {
  if (process.argv.length > 2) {
    console.error(`Doctor failed: unknown argument ${process.argv[2]}`);
    process.exitCode = 1;
  } else {
    runDoctor()
      .then(report => { if (!report.ok) process.exitCode = 1; })
      .catch(error => {
        console.error(`Doctor failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
  }
}
