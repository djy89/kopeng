import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { HOOK_DEFINITIONS } from './wire-client.js';
import { ENV_FILE as PACKAGED_ENV_FILE, KOPENG_HOME } from './paths.js';
import { resolveEnvFile } from '../config/env-resolution.js';
// RULING-C (WS7.6): the recall probe below must derive its scope the same way
// the real hooks do — a plain path.basename would silently diverge the moment
// repoRoot sits under a git remote.
//
// Task 2.1: this file lives two levels below the repo/package root in both
// layouts (src/cli/ in the checkout, dist/cli/ once compiled, node_modules/
// kopeng/dist/cli/ once installed), and scripts/hooks/ always sits at that
// same root — so the same relative specifier resolves correctly everywhere.
import { deriveProjectScope } from '../../scripts/hooks/project-scope.mjs';
import { isEntrypoint } from '../utils/entrypoint.js';

type JsonObject = Record<string, unknown>;
type CheckState = 'pass' | 'fail' | 'skip' | 'warn';

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
  /**
   * Task 2.2 (fix round: Finding 2): the resolved .env path for feature-
   * posture reporting. Defaults to `resolveEnvFile` — the same
   * KOPENG_ENV_FILE > from-source `<repoRoot>/.env` > packaged
   * `~/.kopeng/.env` resolution `wire-client.ts` uses — so a standalone
   * `kopeng doctor` on a packaged install reads the REAL .env instead of
   * silently missing it at `<repoRoot>/.env` (which doesn't exist once
   * repoRoot is inside node_modules). `kopeng init`/`update` still pass the
   * resolved .env explicitly; this default only matters for a bare `doctor`.
   */
  envFile?: string;
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

async function checkHealth(fetchImpl: typeof fetch, apiUrl: string): Promise<{ check: DoctorCheck; data: JsonObject | null }> {
  const response = await fetchJson(fetchImpl, `${apiUrl}/api/health`);
  const fix = `start KOPENG with npm start and verify ${apiUrl}/api/health, then re-run npm run doctor`;
  if (!response.ok) {
    return { check: fail('Server', `not reachable at ${apiUrl} (${response.error ?? `HTTP ${response.status}`}).`, fix), data: null };
  }
  const data = isObject(response.json) && isObject(response.json.data) ? response.json.data : null;
  if (!data) return { check: fail('Server', '/api/health returned an unexpected response shape.', fix), data: null };
  if (data.embedding !== 'loaded') {
    return {
      check: fail(
        'Server',
        `reachable, but the embedding index is ${String(data.embedding ?? 'unknown')}.`,
        'wait for the model to load; if it stays unready, check the server log, then re-run npm run doctor'
      ),
      data,
    };
  }
  return {
    check: {
      name: 'Server',
      state: 'pass',
      detail: `reachable at ${apiUrl}; embedding index loaded (${String(data.memories ?? '?')} memories).`,
    },
    data,
  };
}

/**
 * WS7.1: compares the server-reported version against the LOCAL checkout's
 * package.json. A mismatch is expected whenever a running server hasn't
 * picked up a newer checkout yet, so this warns rather than fails doctor.
 */
function checkVersion(healthData: JsonObject | null, repoRoot: string): DoctorCheck {
  if (!healthData) {
    return { name: 'Version', state: 'skip', detail: 'not checked — the server is unreachable.' };
  }
  const localRead = readJson(path.join(repoRoot, 'package.json'));
  const localVersion = stringValue(localRead.value?.version);
  if (!localVersion) {
    return { name: 'Version', state: 'skip', detail: `${localRead.path} has no version field.` };
  }
  const serverVersion = stringValue(healthData.version);
  if (!serverVersion) {
    return {
      name: 'Version',
      state: 'warn',
      detail: `server did not report a version (older server); local checkout is v${localVersion} — upgrade the server to get version reporting.`,
    };
  }
  if (serverVersion !== localVersion) {
    return {
      name: 'Version',
      state: 'warn',
      detail: `server is v${serverVersion}, local checkout is v${localVersion} — restart the server after updating.`,
    };
  }
  return { name: 'Version', state: 'pass', detail: `server and local checkout both report v${localVersion}.` };
}

/**
 * True when this copy of KOPENG is an INSTALLED package (its root has a
 * `node_modules` path segment, e.g. `~/.kopeng/app/node_modules/kopeng`)
 * rather than a from-source checkout. Same heuristic `env-resolution.ts` uses
 * to pick the packaged `.env`; duplicated as a one-liner rather than exported
 * from there because that module's copy is private to the `.env` tiering.
 *
 * It exists so doctor never prescribes a command the operator cannot run: a
 * packaged install has no `scripts/ops/` (not in package.json's `files`) and
 * no `tsx` (a devDependency), so every `npm run <ops-script>` fix line is a
 * dead end there.
 */
export function isPackagedInstall(repoRoot: string): boolean {
  return repoRoot.split(/[/\\]+/).some(segment => segment.toLowerCase() === 'node_modules');
}

/**
 * WS7.4 B3: is_locked is THE Hard Anchor now; confidence>=1.0 and
 * metadata.pinned are deprecated spellings, still honored this release. Warns
 * the operator toward the anchor migration when the corpus still holds any —
 * naming the command that actually works for THIS install shape (`kopeng
 * migrate-anchors` when packaged, `npm run migrate:anchors` from source;
 * both drive `src/cli/migrate-anchors.ts`, dry-run unless `--apply`).
 * Degrades like `checkVersion`: unreachable server or a pre-WS7.4 server
 * that doesn't report the field skips silently rather than failing doctor.
 */
async function checkLegacyAnchors(fetchImpl: typeof fetch, apiUrl: string, repoRoot: string): Promise<DoctorCheck> {
  const response = await fetchJson(fetchImpl, `${apiUrl}/api/ops/corpus-health`);
  if (!response.ok || !isObject(response.json) || !isObject(response.json.data)) {
    return { name: 'Legacy anchors', state: 'skip', detail: 'not checked — /api/ops/corpus-health is unreachable.' };
  }
  const count = response.json.data.legacy_anchor_count;
  if (count === undefined) {
    return { name: 'Legacy anchors', state: 'skip', detail: 'server did not report legacy_anchor_count (older server).' };
  }
  if (typeof count !== 'number' || count <= 0) {
    return { name: 'Legacy anchors', state: 'pass', detail: 'no memories anchored by a deprecated spelling.' };
  }
  const [dry, write] = isPackagedInstall(repoRoot)
    ? ['kopeng migrate-anchors', 'kopeng migrate-anchors --apply']
    : ['npm run migrate:anchors', 'npm run migrate:anchors -- --apply'];
  return {
    name: 'Legacy anchors',
    state: 'warn',
    detail: `${count} memories anchored by deprecated confidence-1.0/pinned — run \`${dry}\` to preview, then \`${write}\`.`,
  };
}

const ENSURE_CONFLICT_HINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Finding 4 (fix round): `kopeng ensure` writes `ensure_conflict.json` (see
 * ensure.ts) when it finds a foreign, non-KOPENG process already holding the
 * port — this is the reader that makes that write actionable. Absent or
 * stale (older than the ensure probe cadence — the operator has likely
 * already resolved it, or it predates this check) reports nothing; only a
 * hint still fresh enough to be worth acting on right now surfaces a WARN.
 */
function checkEnsureConflictHint(hintsDir: string, now: Date): DoctorCheck | null {
  const hintPath = path.join(hintsDir, 'ensure_conflict.json');
  if (!fs.existsSync(hintPath)) return null;
  let hint: { port?: unknown; timestamp?: unknown };
  try {
    hint = JSON.parse(fs.readFileSync(hintPath, 'utf8'));
  } catch {
    return null; // malformed hint — nothing actionable to report
  }
  const timestampMs = typeof hint.timestamp === 'string' ? Date.parse(hint.timestamp) : NaN;
  if (!Number.isFinite(timestampMs) || now.getTime() - timestampMs >= ENSURE_CONFLICT_HINT_MAX_AGE_MS) return null;
  const port = typeof hint.port === 'number' ? hint.port : 'unknown';
  return {
    name: 'Ensure conflict hint',
    state: 'warn',
    detail: `a recent \`kopeng ensure\` run found port ${port} occupied by a non-KOPENG service.`,
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
      scopes: [deriveProjectScope(repoRoot).scope, 'global'],
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

export function featurePosture(repoRoot: string, env: NodeJS.ProcessEnv = process.env, envFile?: string): string {
  let fileEnv: Record<string, string> = {};
  const envPath = envFile ?? resolveEnvFile({ env, projectRoot: repoRoot, packagedEnvFile: PACKAGED_ENV_FILE });
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

  const healthResult = await checkHealth(fetchImpl, resolvedUrl.apiUrl);
  checks.push(healthResult.check);
  checks.push(checkVersion(healthResult.data, repoRoot));
  checks.push(await checkLegacyAnchors(fetchImpl, resolvedUrl.apiUrl, repoRoot));
  checks.push(checkMcp(claudeRead, repoRoot));
  const hookResult = checkHooks(settingsRead, repoRoot);
  checks.push(...hookResult.checks);
  const effectiveHookEnv = hookEnvironment(settingsRead.value, env);
  const nodeCheck = checkNode(effectiveHookEnv);
  checks.push(nodeCheck);

  // Finding 4: same KOPENG_HINTS_DIR override ensure.ts itself honors
  // (currentEnsureDeps in ensure.ts), so a redirected hints dir is found
  // the same way on both sides of the write/read.
  const hintsDir = env.KOPENG_HINTS_DIR || path.join(KOPENG_HOME, 'hints');
  const ensureConflictCheck = checkEnsureConflictHint(hintsDir, new Date());
  if (ensureConflictCheck) checks.push(ensureConflictCheck);

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

  const posture = featurePosture(repoRoot, env, options.envFile);
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
  // Symlink-safe (T72). The obvious argv[1]-vs-import.meta.url comparison
  // reads false through a symlink and this module silently does nothing.
  return isEntrypoint(import.meta.url);
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
