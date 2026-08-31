/**
 * `kopeng init` (Task 2.2, Install Strategy §4.2) — the one-command installer.
 *
 * Flow: preflight -> enumerated consent -> install app -> env -> models ->
 * autostart -> start -> wire -> doctor+canary -> summary. Same dry-run-and-
 * enumerate ethos as `wire` (src/cli/wire-client.ts), extended to the whole
 * install: nothing touches disk before consent, and every step after that is
 * either a pure "decide" function (no I/O, fully unit-testable) or a thin
 * executor that takes its side effects through the injected `InitEffects`
 * bag — so `runInit` itself never calls `fs`/`fetch`/`spawn`/`readline`
 * directly. Real wiring (`createRealInitEffects`) is assembled at the bottom
 * and is never exercised by a test, mirroring autostart.ts's
 * `realAutostartEffects` / ensure.ts's `currentEnsureDeps`.
 *
 * IMPORTANT (mirrors cli/index.ts's runEnsureCommand, "review finding 6"):
 * ensure.ts imports config.ts at module scope for RESOLVED_ENV_FILE, and
 * config.ts eagerly VALIDATES every env var at import time — it can throw on
 * a malformed one. Statically importing ensure.ts here would make `kopeng
 * init` capable of crashing on a poisoned launch environment before it ever
 * gets a chance to help. recall-canary.ts has a milder version of the same
 * hazard (a top-level `dotenv.config()` side effect). Both are imported for
 * TYPES ONLY at the top of this file (erased at compile time, no runtime
 * evaluation) and loaded for real only inside `createRealInitEffects`'s
 * lazy closures, at the moment `kopeng init` actually reaches that step.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

import { KOPENG_VERSION } from '../version.js';
import { KOPENG_HOME } from './paths.js';
import { renderManifest } from './manifest.js';
import {
  wireClient,
  chooseProfile,
  planProfileEnvFromSource,
  PROFILE_DESCRIPTIONS,
  type WireProfile,
} from './wire-client.js';
import { runDoctor, type DoctorOptions, type DoctorReport } from './doctor.js';
import type { CanaryOptions, CanaryResult } from './recall-canary.js';
import { runNpmInstall } from './npm-spawn.js';
import {
  planAutostart,
  registerAutostart,
  realAutostartEffects,
  type AutostartOpts,
  type AutostartEffects,
  type AutostartPlatform,
  type AutostartRegisterResult,
} from './autostart.js';
import type { EnsureDeps, EnsureDecision } from './ensure.js';
import type { CliIo, CommandHandler } from './index.js';

export class InitError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Constants ────────────────────────────────────────────────────────────

export const MIN_NODE_MAJOR = 20;
export const DEFAULT_PORT = 3200;
export const PORT_SCAN_START = 3201;
export const PORT_SCAN_END = 3299;
export const MIN_DISK_FREE_BYTES = 250 * 1024 * 1024;
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'; // matches config.ts's default EMBEDDING_MODEL
export const VIZ_PORT = 8780; // scripts/viz-server.js's default VIZ_PORT
const START_HEALTH_TIMEOUT_MS = 20_000;
// T71: a separate, longer budget for the lazy embedding load. The model files
// are already on disk by this point (realDownloadModels ran earlier), so this
// is a disk read + ONNX init — ~1.2s on CI — but a cold runner can be slower,
// and overrunning it means doctor fails a healthy install.
const START_EMBEDDING_TIMEOUT_MS = 60_000;
const START_HEALTH_POLL_MS = 500;

// ── Install paths (pure — a temp dir in tests, ~/.kopeng for real) ────────

export interface InitPaths {
  kopengHome: string;
  appDir: string;
  dataDir: string;
  modelsDir: string;
  envFile: string;
  hintsDir: string;
  autostartRecordFile: string;
  ensureKnobFile: string;
  /** `<appDir>/node_modules/kopeng` — the installed package root wire/doctor target. */
  installedRepoRoot: string;
  serverEntry: string;
  /** The ensure knob's `script` field — see scripts/hooks/memory-session-start.mjs. */
  cliEntry: string;
}

export function derivedInitPaths(kopengHome: string): InitPaths {
  const appDir = path.join(kopengHome, 'app');
  const installedRepoRoot = path.join(appDir, 'node_modules', 'kopeng');
  return {
    kopengHome,
    appDir,
    dataDir: path.join(kopengHome, 'data'),
    modelsDir: path.join(kopengHome, 'models'),
    envFile: path.join(kopengHome, '.env'),
    hintsDir: path.join(kopengHome, 'hints'),
    autostartRecordFile: path.join(kopengHome, 'autostart.json'),
    ensureKnobFile: path.join(kopengHome, 'ensure.json'),
    installedRepoRoot,
    serverEntry: path.join(installedRepoRoot, 'dist', 'server.js'),
    cliEntry: path.join(installedRepoRoot, 'dist', 'cli', 'index.js'),
  };
}

// ── Step 1: Preflight ───────────────────────────────────────────────────

export function decideNodeVersion(
  major: number,
  platform: NodeJS.Platform
): { ok: boolean; warning?: string; error?: string } {
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      error:
        `KOPENG requires Node.js ${MIN_NODE_MAJOR} or newer; this machine is running ` +
        `${Number.isInteger(major) ? `Node v${major}` : 'an unrecognized Node version'}. ` +
        `Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org and re-run kopeng init.`,
    };
  }
  if (platform === 'win32' && major === 24) {
    return {
      ok: true,
      warning:
        'Node 24 on Windows has a known issue (tracked as T52) that can silently break the ' +
        'recall hook — if recall stops working after install, switch to Node 20 or 22 LTS.',
    };
  }
  return { ok: true };
}

/** What a port probe actually saw — collapsed to what the decision needs. */
export type PortProbeResult = { kind: 'response'; body: unknown } | { kind: 'no-response' };

/**
 * Reimplements ensure.ts's decideEnsure classification (kopeng-shaped body ->
 * already running; no response -> free; anything else -> a foreign process
 * holds the port) rather than importing it — see the file header for why
 * ensure.ts can't be imported as a value here.
 */
export function classifyPortProbe(probe: PortProbeResult): 'kopeng' | 'free' | 'foreign' {
  if (probe.kind === 'no-response') return 'free';
  const body = probe.body;
  const data = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : undefined;
  const looksLikeKopeng = typeof data === 'object' && data !== null && 'status' in (data as Record<string, unknown>);
  return looksLikeKopeng ? 'kopeng' : 'foreign';
}

export type PortStep = 'accept-existing' | 'accept-free' | 'fail-explicit-taken' | 'scan-next';

export function decidePortStep(
  requestedPort: number | undefined,
  classification: 'kopeng' | 'free' | 'foreign'
): PortStep {
  if (classification === 'kopeng') return 'accept-existing';
  if (classification === 'free') return 'accept-free';
  return requestedPort !== undefined ? 'fail-explicit-taken' : 'scan-next';
}

export interface PortResolution {
  port: number;
  overridden: boolean;
  existingServerRunning: boolean;
}

export async function resolvePort(
  requestedPort: number | undefined,
  probePort: (port: number) => Promise<PortProbeResult>
): Promise<PortResolution> {
  const target = requestedPort ?? DEFAULT_PORT;
  const step = decidePortStep(requestedPort, classifyPortProbe(await probePort(target)));
  if (step === 'accept-existing') return { port: target, overridden: false, existingServerRunning: true };
  if (step === 'accept-free') return { port: target, overridden: false, existingServerRunning: false };
  if (step === 'fail-explicit-taken') {
    throw new InitError(
      `Port ${target} is already in use by another (non-KOPENG) process, and --port ${target} was ` +
      'given explicitly. Free it up or pick a different port with --port <N>, then re-run kopeng init.'
    );
  }
  for (let candidate = PORT_SCAN_START; candidate <= PORT_SCAN_END; candidate++) {
    const candidateStep = decidePortStep(undefined, classifyPortProbe(await probePort(candidate)));
    if (candidateStep === 'accept-existing') return { port: candidate, overridden: true, existingServerRunning: true };
    if (candidateStep === 'accept-free') return { port: candidate, overridden: true, existingServerRunning: false };
  }
  throw new InitError(
    `Every port from ${PORT_SCAN_START} to ${PORT_SCAN_END} is already in use. Free one up or pass ` +
    '--port <N>, then re-run kopeng init.'
  );
}

export interface PortDivergence {
  diverges: boolean;
  existingPort?: number;
}

/**
 * Fix round 1, finding 3: planEnvFile only APPENDS missing keys, so a repair
 * run that resolves a different port than the one already pinned in the
 * existing .env (an explicit --port, or an auto-override because the old
 * port is now foreign-occupied) would boot the server on the old port while
 * repointing Claude Code's MCP/hooks at the new one. Pure so it's directly
 * testable against both divergence directions. A malformed existing PORT
 * value is not blocked here — it's not this guard's job to validate syntax.
 */
export function decidePortDivergence(existingPortRaw: string | undefined, resolvedPort: number): PortDivergence {
  if (existingPortRaw === undefined || existingPortRaw.trim() === '') return { diverges: false };
  const existingPort = Number(existingPortRaw);
  // Number('') is 0, not NaN — guard the blank-string case explicitly above,
  // and reject non-positive values here (never a real port).
  if (!Number.isInteger(existingPort) || existingPort <= 0) return { diverges: false };
  return { diverges: existingPort !== resolvedPort, existingPort };
}

export type ClientKind = 'claude-code' | 'codex';

export function detectClients(claudeDetected: boolean, codexDetected: boolean): ClientKind[] {
  const clients: ClientKind[] = [];
  if (claudeDetected) clients.push('claude-code');
  if (codexDetected) clients.push('codex');
  return clients;
}

export interface PreflightInputs {
  nodeMajor: number;
  platform: NodeJS.Platform;
  port: number;
  portOverridden: boolean;
  existingServerRunning: boolean;
  diskFreeBytes: number | null;
  diskThresholdBytes: number;
  claudeDetected: boolean;
  codexDetected: boolean;
  existingInstall: boolean;
}

export interface PreflightReport {
  nodeMajor: number;
  nodeOk: boolean;
  nodeWarning?: string;
  port: number;
  portOverridden: boolean;
  existingServerRunning: boolean;
  diskFreeBytes: number | null;
  diskOk: boolean;
  clients: ClientKind[];
  mode: 'fresh' | 'repair';
  lines: string[];
}

/** Pure: combines every preflight input into one report + human-readable lines. */
export function buildPreflightReport(inputs: PreflightInputs): PreflightReport {
  const nodeDecision = decideNodeVersion(inputs.nodeMajor, inputs.platform);
  const diskOk = inputs.diskFreeBytes === null || inputs.diskFreeBytes >= inputs.diskThresholdBytes;
  const clients = detectClients(inputs.claudeDetected, inputs.codexDetected);
  const mode: 'fresh' | 'repair' = inputs.existingInstall ? 'repair' : 'fresh';

  const lines: string[] = [];
  lines.push(
    `Node.js: v${inputs.nodeMajor}.x — OK` + (nodeDecision.warning ? ` (${nodeDecision.warning})` : '')
  );
  lines.push(
    inputs.existingServerRunning
      ? `Port ${inputs.port}: a KOPENG server is already running here — will repair/reuse it.`
      : inputs.portOverridden
        ? `Port ${inputs.port}: chosen automatically (the default port was in use by another process).`
        : `Port ${inputs.port}: free.`
  );
  lines.push(
    `Disk space: ${inputs.diskFreeBytes === null ? 'unknown' : `${Math.round(inputs.diskFreeBytes / (1024 * 1024))} MB free`}` +
    (diskOk ? '' : ' — below the recommended ~250 MB')
  );
  lines.push(
    clients.length > 0
      ? `Detected client(s): ${clients.join(', ')}.`
      : 'No supported client detected (~/.claude.json or ~/.codex) — the server will still install; wiring is skipped.'
  );
  lines.push(
    mode === 'repair'
      ? 'Existing install found — this will repair/upgrade it.'
      : 'No existing install found — this will be a fresh install.'
  );

  return {
    nodeMajor: inputs.nodeMajor,
    nodeOk: nodeDecision.ok,
    nodeWarning: nodeDecision.warning,
    port: inputs.port,
    portOverridden: inputs.portOverridden,
    existingServerRunning: inputs.existingServerRunning,
    diskFreeBytes: inputs.diskFreeBytes,
    diskOk,
    clients,
    mode,
    lines,
  };
}

// ── Step 4: Env ─────────────────────────────────────────────────────────

export const CORE_ENV_ORDER = ['PORT', 'HOST', 'DATABASE_PATH', 'MODELS_CACHE_DIR', 'MEMORY_API_URL', 'LOG_PATH'] as const;
export type CoreEnvKey = (typeof CORE_ENV_ORDER)[number];
export type CoreEnvValues = Record<CoreEnvKey, string>;

export interface EnvFilePlan {
  path: string;
  exists: boolean;
  proposed: string;
  changed: boolean;
  addedCoreKeys: string[];
  profileChanges: string[];
}

/**
 * Pure. Appends only MISSING core keys (so an admin key the server generated
 * on a prior run — or any other pre-existing value — is never touched), then
 * layers wire's own profile-flag planner (planProfileEnvFromSource, exported
 * from wire-client.ts) on top of the augmented source.
 */
export function planEnvFile(
  envPath: string,
  exists: boolean,
  existingSource: string,
  desiredCore: CoreEnvValues,
  profile: WireProfile
): EnvFilePlan {
  const assigned = new Set(Object.keys(dotenv.parse(existingSource)));
  const additions = CORE_ENV_ORDER.filter((key) => !assigned.has(key));

  let augmented = existingSource;
  if (additions.length > 0) {
    const newline = augmented.includes('\r\n') ? '\r\n' : '\n';
    if (augmented.length > 0 && !augmented.endsWith('\n')) augmented += newline;
    if (!augmented.includes('# KOPENG install configuration')) {
      augmented += `# KOPENG install configuration — written by kopeng init${newline}`;
    }
    augmented += additions.map((key) => `${key}=${desiredCore[key]}`).join(newline) + newline;
  }

  const profilePlan = planProfileEnvFromSource(envPath, exists, augmented, profile);

  return {
    path: envPath,
    exists,
    proposed: profilePlan.proposed,
    changed: existingSource !== profilePlan.proposed,
    addedCoreKeys: [...additions],
    profileChanges: profilePlan.changes,
  };
}

export async function runEnvStep(
  opts: { port: number; envFile: string; dataDir: string; modelsDir: string; kopengHome: string; profile: WireProfile },
  effects: Pick<InitEffects, 'exists' | 'readFile' | 'writeFile'>
): Promise<EnvFilePlan> {
  const exists = effects.exists(opts.envFile);
  const existingSource = exists ? (effects.readFile(opts.envFile) ?? '') : '';
  const desiredCore: CoreEnvValues = {
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    DATABASE_PATH: path.join(opts.dataDir, 'memory.db'),
    MODELS_CACHE_DIR: opts.modelsDir,
    MEMORY_API_URL: `http://localhost:${opts.port}`,
    // Absolute (like DATABASE_PATH), so an autostart-launched server whose
    // cwd is System32/`/`/$HOME (none of them writable/expected) still logs
    // under KOPENG_HOME instead of crashing or scribbling a stray logs/ dir.
    LOG_PATH: path.join(opts.kopengHome, 'logs'),
  };
  const plan = planEnvFile(opts.envFile, exists, existingSource, desiredCore, opts.profile);
  if (plan.changed) effects.writeFile(plan.path, plan.proposed);
  return plan;
}

// ── Step 3: Install app ─────────────────────────────────────────────────

export type InstallSpecReason = 'from-flag' | 'pinned-version';
export interface InstallSpec {
  spec: string;
  reason: InstallSpecReason;
}

/** RULING-D: `--from` exists so CI/preview installs work before first publish. */
export function decideInstallSpec(fromFlag: string | undefined, runningVersion: string): InstallSpec {
  return fromFlag ? { spec: fromFlag, reason: 'from-flag' } : { spec: `kopeng@${runningVersion}`, reason: 'pinned-version' };
}

export type InstallAction = 'skip' | 'install';

export function decideInstallAction(
  spec: InstallSpec,
  installedVersion: string | undefined,
  runningVersion: string
): InstallAction {
  if (spec.reason === 'pinned-version' && installedVersion === runningVersion) return 'skip';
  return 'install';
}

export interface InstallAppResult {
  skipped: boolean;
  spec: string;
}

/**
 * Task 2.5.2 (Install Strategy) — a raw node-gyp/prebuild-install dump on a
 * failed `npm install` is useless to an operator who has never seen one:
 * pages of compiler output ending in an exit code, with the actual cause
 * (no prebuilt binary for this platform/Node combo, and no local toolchain
 * to fall back to compiling with) buried in the middle. Pure string
 * matching over the combined stdout+stderr — no I/O — so it's directly
 * unit-testable against canned transcripts (real ones, redacted, live in
 * the test file). Unrecognized output still gets SOME signal (the last
 * slice of it) rather than nothing.
 *
 * Ordered most-specific-first: a real node-gyp failure almost always ALSO
 * contains the generic "gyp ERR!"/"node-gyp" markers, so those two sit last
 * — naming the actual missing tool (no prebuilt binary, MSBuild, make,
 * Python) is far more actionable than the generic "node-gyp failed".
 */
export function diagnoseNpmFailure(output: string): string {
  const signatures: Array<{ pattern: RegExp; cause: string }> = [
    { pattern: /prebuild-install/i, cause: 'a native dependency has no prebuilt binary for this platform/Node version (prebuild-install)' },
    { pattern: /MSBuild/i, cause: 'the Windows native build tools (MSBuild) are missing or misconfigured' },
    { pattern: /make(?:\.exe)?:\s*(?:\*\*\*\s*)?(?:command\s+)?not found/i, cause: 'the native build tools (make) are missing' },
    {
      pattern: /could not find (?:a|any) python|python(?:3)?['"]?\s+(?:is\s+)?not\s+(?:set|recognized|found|installed)|python was not found|no python installation|command not found:\s*python3?/i,
      cause: 'python (needed by the native build toolchain) is missing',
    },
    { pattern: /gyp ERR!/i, cause: 'the native build toolchain (node-gyp) failed while compiling a dependency from source' },
    { pattern: /node-gyp/i, cause: 'a native dependency needed to compile from source (node-gyp)' },
  ];

  const tail = output.trim().slice(-1000);
  const hit = signatures.find((signature) => signature.pattern.test(output));
  if (!hit) {
    return (
      'npm install failed, and the output does not match a known native-build-tool signature. ' +
      `Last npm output:\n${tail}`
    );
  }

  return (
    `npm install failed because ${hit.cause}. This usually means this platform/Node version has no ` +
    'prebuilt binary for one of KOPENG\'s native dependencies (better-sqlite3, or the onnxruntime backing ' +
    '@xenova/transformers), and the machine has no C++ build toolchain to compile one from source instead.\n\n' +
    'Fix it one of two ways:\n' +
    '  1. Install the platform build tools, then re-run kopeng init:\n' +
    '     - Windows: install "Visual Studio Build Tools" (workload "Desktop development with C++") and Python 3.\n' +
    '     - macOS: run `xcode-select --install`.\n' +
    '     - Linux: install `build-essential` (or your distro\'s equivalent) and python3.\n' +
    '  2. Or switch to a supported Node.js LTS release (20 or 22), where a prebuilt binary is more likely to ' +
    'exist, then re-run kopeng init.\n\n' +
    `Last npm output:\n${tail}`
  );
}

export async function installApp(
  opts: { appDir: string; installedVersion: string | undefined; runningVersion: string; spec: InstallSpec },
  npmInstall: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
): Promise<InstallAppResult> {
  const action = decideInstallAction(opts.spec, opts.installedVersion, opts.runningVersion);
  if (action === 'skip') return { skipped: true, spec: opts.spec.spec };

  const result = await npmInstall(['install', '--prefix', opts.appDir, opts.spec.spec]);
  if (result.code !== 0) {
    throw new InitError(
      `npm install failed (exit ${result.code}) installing ${opts.spec.spec} into ${opts.appDir}.\n\n` +
      diagnoseNpmFailure(`${result.stdout}\n${result.stderr}`)
    );
  }
  return { skipped: false, spec: opts.spec.spec };
}

// ── Step 5: Models ──────────────────────────────────────────────────────

export function embeddingModelDir(modelsDir: string): string {
  return path.join(modelsDir, ...EMBEDDING_MODEL.split('/'));
}

export function decideOfflineModels(
  dir: string,
  dirExists: boolean,
  onnxFiles: Array<{ path: string; size: number }>
): { ok: boolean; detail: string } {
  const valid = onnxFiles.filter((f) => f.path.toLowerCase().endsWith('.onnx') && f.size > 0);
  if (!dirExists || valid.length === 0) {
    return {
      ok: false,
      detail:
        `--offline was given but no embedding model files were found under ${dir}. ` +
        'Copy a pre-downloaded model cache into MODELS_CACHE_DIR first, or drop --offline to download it now.',
    };
  }
  return { ok: true, detail: `Found ${valid.length} embedding model file(s) already present — skipping download (--offline).` };
}

export async function verifyOfflineModels(
  modelsDir: string,
  effects: Pick<InitEffects, 'exists' | 'listFiles'>
): Promise<{ ok: boolean; detail: string }> {
  const dir = embeddingModelDir(modelsDir);
  const dirExists = effects.exists(dir);
  const files = dirExists ? effects.listFiles(dir) : [];
  return decideOfflineModels(dir, dirExists, files);
}

// ── Effects ─────────────────────────────────────────────────────────────

export interface InitEffects {
  paths: InitPaths;
  homeDir: string;
  appDataDir: string;
  platform: NodeJS.Platform;
  nodePath: string;
  nodeMajor: number;
  runningVersion: string;
  startHealthTimeoutMs: number;
  startHealthPollMs: number;
  startEmbeddingTimeoutMs?: number;
  /** Fix round 1, finding 2: whether stdin is a real terminal (process.stdin.isTTY). */
  isTTY: boolean;

  exists: (p: string) => boolean;
  readFile: (p: string) => string | undefined;
  writeFile: (p: string, content: string) => void;
  readInstalledVersion: (repoRoot: string) => string | undefined;
  listFiles: (dir: string) => Array<{ path: string; size: number }>;
  statfs: (dir: string) => Promise<{ freeBytes: number } | null>;
  probePort: (port: number) => Promise<PortProbeResult>;

  npmInstall: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  downloadModels: (opts: { appDir: string; modelsDir: string; kopengHome: string; envFile: string }) => Promise<{ ok: boolean; detail: string }>;

  autostartEffects: AutostartEffects;
  registerAutostart: (plan: ReturnType<typeof planAutostart>, effects: AutostartEffects, recordPath: string) => AutostartRegisterResult;

  fetchImpl: typeof fetch;
  spawnImpl: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
  runEnsure: (deps: EnsureDeps) => Promise<EnsureDecision>;

  wireClient: typeof wireClient;
  chooseProfile: (explicit?: WireProfile) => Promise<WireProfile>;
  confirm: (question: string) => Promise<boolean>;

  runDoctor: (options: DoctorOptions) => Promise<DoctorReport>;
  runCanary: (options: CanaryOptions) => Promise<CanaryResult>;
}

export interface HealthWaitResult {
  /** The server answered /api/health with a well-formed body at least once. */
  ready: boolean;
  /** The embedding index reported `loaded`. */
  embeddingLoaded: boolean;
  /** The embedder reached its TERMINAL failed state (T56) — waiting is pointless. */
  embeddingFailed: boolean;
}

/**
 * Poll /api/health until the server is up AND its embedding index has loaded.
 *
 * T71: this used to return the instant the port answered, discarding the
 * `embeddingLoaded` flag it had already computed. The caller then ran doctor
 * immediately, doctor read the transient `initializing` state as a FAIL, and
 * `kopeng init` exited 1 on a perfectly healthy install — the canary right
 * after it passed 1.2s later, proving the model was fine. The embedding index
 * is lazy-loaded AFTER the server starts accepting requests, so `initializing`
 * is the EXPECTED state on a fresh install, not a failure.
 *
 * Two budgets, because they answer different questions: `timeoutMs` bounds
 * "is the server even alive" (short — a dead server should be reported fast),
 * `embeddingTimeoutMs` bounds "has the model finished loading" (longer — the
 * files are already on disk by this point, but a cold runner can be slow).
 * Omitting `embeddingTimeoutMs` keeps the single-deadline behaviour.
 */
export async function waitForHealth(opts: {
  port: number;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  pollIntervalMs: number;
  embeddingTimeoutMs?: number;
}): Promise<HealthWaitResult> {
  const start = Date.now();
  const readyDeadline = start + opts.timeoutMs;
  const embeddingDeadline = start + Math.max(opts.timeoutMs, opts.embeddingTimeoutMs ?? opts.timeoutMs);
  let ready = false;
  for (;;) {
    try {
      const res = await opts.fetchImpl(`http://127.0.0.1:${opts.port}/api/health`, {
        signal: AbortSignal.timeout(Math.min(2000, opts.timeoutMs)),
      });
      const json: unknown = await res.json();
      const data = typeof json === 'object' && json !== null ? (json as Record<string, unknown>).data : undefined;
      if (typeof data === 'object' && data !== null) {
        ready = true;
        const embedding = (data as Record<string, unknown>).embedding;
        if (embedding === 'loaded') return { ready: true, embeddingLoaded: true, embeddingFailed: false };
        // `error` is terminal, not transient — return rather than burn the budget.
        if (embedding === 'error') return { ready: true, embeddingLoaded: false, embeddingFailed: true };
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() >= (ready ? embeddingDeadline : readyDeadline)) {
      return { ready, embeddingLoaded: false, embeddingFailed: false };
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
}

/**
 * One line describing the outcome of {@link waitForHealth}, shared by init and
 * update so the two commands cannot drift on what a half-ready server reads as.
 */
export function describeHealthWait(health: HealthWaitResult, timeoutMs: number, followUp: string): string {
  if (!health.ready) return `Server did not report ready within ${timeoutMs}ms — ${followUp}`;
  if (health.embeddingLoaded) return 'Server is up.';
  if (health.embeddingFailed) {
    return 'Server is up, but the embedding model failed to load — search falls back to keyword-only. ' +
      'Check the server log, then run kopeng doctor.';
  }
  return `Server is up, but the embedding index was still loading — ${followUp}`;
}

function readAdminKey(effects: Pick<InitEffects, 'readFile'>, envFile: string): string {
  const source = effects.readFile(envFile) ?? '';
  return dotenv.parse(source).ADMIN_API_KEY ?? '';
}

// ── CLI arg parsing ─────────────────────────────────────────────────────

export interface InitCliOptions {
  yes: boolean;
  nonInteractive: boolean;
  profile?: WireProfile;
  from?: string;
  port?: number;
  offline: boolean;
  noAutostart: boolean;
  noEnsure: boolean;
}

export function parseInitArgs(args: string[]): InitCliOptions {
  let yes = false;
  let nonInteractive = false;
  let profile: WireProfile | undefined;
  let from: string | undefined;
  let port: number | undefined;
  let offline = false;
  let noAutostart = false;
  let noEnsure = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes') {
      yes = true;
    } else if (arg === '--non-interactive') {
      nonInteractive = true;
    } else if (arg === '--profile') {
      const value = args[++i];
      if (value !== 'minimal' && value !== 'recommended' && value !== 'everything') {
        throw new InitError(`--profile requires minimal, recommended, or everything (got ${value ?? '<nothing>'}).`);
      }
      profile = value;
    } else if (arg === '--from') {
      from = args[++i];
      if (!from) throw new InitError('--from requires a value (a tarball path, directory, or npm spec).');
    } else if (arg === '--port') {
      const raw = args[++i];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new InitError(`--port requires a valid port number (got ${raw ?? '<nothing>'}).`);
      }
      port = n;
    } else if (arg === '--offline') {
      offline = true;
    } else if (arg === '--no-autostart') {
      noAutostart = true;
    } else if (arg === '--no-ensure') {
      noEnsure = true;
    } else {
      throw new InitError(`Unknown argument: ${arg}`);
    }
  }

  if (nonInteractive && !profile) {
    throw new InitError('--non-interactive requires --profile <minimal|recommended|everything>.');
  }

  return { yes, nonInteractive, profile, from, port, offline, noAutostart, noEnsure };
}

// ── Step 2: Consent ─────────────────────────────────────────────────────

export function parseYesNo(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === '' || normalized === 'y' || normalized === 'yes';
}

export type ConsentGateDecision = 'skip' | 'prompt' | 'fail-non-tty';

/**
 * Fix round 1, finding 2: a piped/non-interactive stdin with neither --yes
 * nor --non-interactive would otherwise `await rl.question(...)` forever —
 * a real hang, verified empirically. Pure so the decision is unit-testable
 * without touching process.stdin.
 */
export function decideConsentGate(opts: { yes: boolean; nonInteractive: boolean; isTTY: boolean }): ConsentGateDecision {
  if (opts.yes || opts.nonInteractive) return 'skip';
  if (!opts.isTTY) return 'fail-non-tty';
  return 'prompt';
}

export function buildConsentScreen(report: PreflightReport, profile: WireProfile): string {
  const lines: string[] = [];
  lines.push('KOPENG install — preflight:');
  for (const line of report.lines) lines.push(`  ${line}`);
  lines.push('');
  lines.push(renderManifest('consent'));
  lines.push('');
  lines.push(`Learning profile: ${profile} — ${PROFILE_DESCRIPTIONS[profile]}`);
  lines.push('');
  lines.push('Nothing phones home. Everything above is removed by: npx kopeng uninstall');
  return lines.join('\n');
}

// ── Orchestrator ────────────────────────────────────────────────────────

function supportedAutostartPlatform(platform: NodeJS.Platform): AutostartPlatform | undefined {
  return platform === 'win32' || platform === 'linux' || platform === 'darwin' ? platform : undefined;
}

export async function runInit(argv: string[], io: CliIo, effects: InitEffects = createRealInitEffects()): Promise<number> {
  let options: InitCliOptions;
  try {
    options = parseInitArgs(argv);
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }

  try {
    const preflight = await runPreflight({ requestedPort: options.port }, effects);
    for (const line of preflight.lines) io.log(line);

    const profile = await effects.chooseProfile(options.profile);
    io.log('');
    io.log(buildConsentScreen(preflight, profile));

    const consentGate = decideConsentGate({ yes: options.yes, nonInteractive: options.nonInteractive, isTTY: effects.isTTY });
    if (consentGate === 'fail-non-tty') {
      throw new InitError(
        'Refusing to prompt for consent on a non-interactive stdin (this would hang forever). ' +
        'Re-run with --yes to accept and proceed, or --non-interactive --profile <minimal|recommended|everything> for a scripted install.'
      );
    }
    if (consentGate === 'prompt') {
      const proceed = await effects.confirm('\nProceed? [Y/n] ');
      if (!proceed) {
        io.log('Nothing was installed.');
        return 0;
      }
    }

    // 3. Install app
    io.log('');
    io.log(`Installing KOPENG into ${effects.paths.appDir} ...`);
    const spec = decideInstallSpec(options.from, effects.runningVersion);
    const installedVersion = effects.readInstalledVersion(effects.paths.installedRepoRoot);
    const installResult = await installApp(
      { appDir: effects.paths.appDir, installedVersion, runningVersion: effects.runningVersion, spec },
      effects.npmInstall
    );
    io.log(installResult.skipped ? `Already up to date (${spec.spec}).` : `Installed ${spec.spec}.`);

    // 4. Env
    const envResult = await runEnvStep(
      { port: preflight.port, envFile: effects.paths.envFile, dataDir: effects.paths.dataDir, modelsDir: effects.paths.modelsDir, kopengHome: effects.paths.kopengHome, profile },
      effects
    );
    io.log(
      envResult.changed
        ? `Wrote ${envResult.addedCoreKeys.length + envResult.profileChanges.length} new setting(s) to ${envResult.path}.`
        : `${envResult.path} already configured — nothing to add.`
    );

    // 5. Models
    let modelsResult: { ok: boolean; detail: string };
    if (options.offline) {
      modelsResult = await verifyOfflineModels(effects.paths.modelsDir, effects);
    } else {
      io.log('Downloading the embedding model (~30 MB, one-time) ...');
      modelsResult = await effects.downloadModels({
        appDir: effects.paths.appDir,
        modelsDir: effects.paths.modelsDir,
        kopengHome: effects.paths.kopengHome,
        envFile: effects.paths.envFile,
      });
    }
    if (!modelsResult.ok) throw new InitError(modelsResult.detail);
    io.log(modelsResult.detail);

    // 6. Autostart + ensure knob
    if (!options.noAutostart) {
      const platform = supportedAutostartPlatform(effects.platform);
      if (platform) {
        const autostartOpts: AutostartOpts = {
          nodePath: effects.nodePath,
          serverEntry: effects.paths.serverEntry,
          kopengHome: effects.paths.kopengHome,
          envFile: effects.paths.envFile,
          homeDir: effects.homeDir,
          appDataDir: effects.appDataDir,
        };
        const plan = planAutostart(platform, autostartOpts);
        const record = effects.registerAutostart(plan, effects.autostartEffects, effects.paths.autostartRecordFile);
        io.log(`Autostart registered via ${record.mechanism}.`);
        if (record.note) io.log(record.note);
      } else {
        io.log(`Autostart is not supported on platform '${effects.platform}' — skipped.`);
      }
    } else {
      io.log('Skipped autostart registration (--no-autostart).');
    }

    if (!options.noEnsure) {
      const knob = { enabled: true, node: effects.nodePath, script: effects.paths.cliEntry };
      effects.writeFile(effects.paths.ensureKnobFile, `${JSON.stringify(knob, null, 2)}\n`);
      io.log(`Wrote the ensure knob to ${effects.paths.ensureKnobFile}.`);
    } else {
      io.log('Skipped writing the ensure knob (--no-ensure).');
    }

    // 7. Start
    io.log('Starting the KOPENG server ...');
    const apiUrl = `http://localhost:${preflight.port}`;
    await effects.runEnsure({
      port: preflight.port,
      nodePath: effects.nodePath,
      serverEntry: effects.paths.serverEntry,
      kopengHome: effects.paths.kopengHome,
      envFile: effects.paths.envFile,
      hintsDir: effects.paths.hintsDir,
      fetchImpl: effects.fetchImpl,
      spawnImpl: effects.spawnImpl,
      writeFile: effects.writeFile,
    });
    const health = await waitForHealth({
      port: preflight.port,
      fetchImpl: effects.fetchImpl,
      timeoutMs: effects.startHealthTimeoutMs,
      pollIntervalMs: effects.startHealthPollMs,
      embeddingTimeoutMs: effects.startEmbeddingTimeoutMs,
    });
    io.log(describeHealthWait(health, effects.startHealthTimeoutMs, 'continuing; check with kopeng doctor.'));

    // 8. Wire
    if (preflight.clients.includes('claude-code')) {
      const result = effects.wireClient({
        homeDir: effects.homeDir,
        repoRoot: effects.paths.installedRepoRoot,
        apply: true,
        profile,
        apiUrl,
        // Finding 1: without this, wireClient's own default targets
        // <installedRepoRoot>/.env — a shadow config INSIDE node_modules
        // that env-resolution's tier 2 would then pick up for any other
        // process (kopeng start, standalone doctor, the MCP entry) that
        // doesn't set KOPENG_ENV_FILE, instead of the real ~/.kopeng/.env.
        envFile: effects.paths.envFile,
        log: io.log,
      });
      io.log(result.changed ? 'Claude Code wired.' : 'Claude Code already wired.');
    }
    if (preflight.clients.includes('codex')) {
      io.log(
        `Codex detected — kopeng wire covers Claude Code only today. See ` +
        `${path.join(effects.paths.installedRepoRoot, 'docs', 'codex-setup.md')} to wire Codex manually.`
      );
    }
    if (preflight.clients.length === 0) {
      io.log('No supported client detected — server installed; wire skipped. Run `kopeng wire --apply` after installing Claude Code or Codex.');
    }

    // 9. Verify
    const doctorReport = await effects.runDoctor({
      homeDir: effects.homeDir,
      repoRoot: effects.paths.installedRepoRoot,
      // The installed package never ships a .env (it lives at KOPENG_HOME/.env,
      // not inside node_modules/kopeng) — without this, doctor's feature-posture
      // check would silently look in the wrong place. See DoctorOptions.envFile.
      envFile: effects.paths.envFile,
      fetchImpl: effects.fetchImpl,
      log: io.log,
    });
    const adminKey = readAdminKey(effects, effects.paths.envFile);
    const canaryResult = await effects.runCanary({
      apiUrl,
      adminKey,
      // Fix round 1, finding 4: recall-canary's own DEFAULT_HOOK_PATH resolves
      // relative to the RUNNING npx-cache CLI, not the just-installed package —
      // every other persistent reference (server entry, cli entry, hooks wire
      // targets) already derives from installedRepoRoot; the canary must too.
      hookPath: path.join(effects.paths.installedRepoRoot, 'scripts', 'hooks', 'memory-prompt-search.mjs'),
    });
    io.log(
      canaryResult.ok
        ? 'Canary passed: store -> embed -> recall verified end to end.'
        : `Canary FAILED at stage '${canaryResult.stage}': ${canaryResult.diagnosis ?? ''}`
    );

    // 10. Summary
    io.log('');
    io.log('KOPENG is installed.');
    io.log(`  App:    ${effects.paths.appDir}`);
    io.log(`  Data:   ${effects.paths.dataDir}`);
    io.log(`  Models: ${effects.paths.modelsDir}`);
    io.log(`  Config: ${effects.paths.envFile}`);
    io.log(doctorReport.ok ? 'Doctor: all checks passed.' : 'Doctor: some checks need attention — see above.');
    io.log(`Watch your memory think:  kopeng viz   ->  http://localhost:${VIZ_PORT}`);

    return doctorReport.ok && canaryResult.ok ? 0 : 1;
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }
}

export async function runPreflight(
  options: { requestedPort?: number },
  effects: Pick<InitEffects, 'nodeMajor' | 'platform' | 'probePort' | 'statfs' | 'exists' | 'readFile' | 'paths' | 'homeDir'>
): Promise<PreflightReport> {
  const nodeDecision = decideNodeVersion(effects.nodeMajor, effects.platform);
  if (!nodeDecision.ok) throw new InitError(nodeDecision.error!);

  const portResolution = await resolvePort(options.requestedPort, effects.probePort);

  // Finding 3: refuse BEFORE any effectful step (install/env/models/...) if
  // an existing .env already pins a DIFFERENT port than this run resolved —
  // before install ever runs, not just before env-writing.
  if (effects.exists(effects.paths.envFile)) {
    const existingPortRaw = dotenv.parse(effects.readFile(effects.paths.envFile) ?? '').PORT;
    const divergence = decidePortDivergence(existingPortRaw, portResolution.port);
    if (divergence.diverges) {
      throw new InitError(
        `${effects.paths.envFile} is already configured for port ${divergence.existingPort}, but this run resolved ` +
        `port ${portResolution.port}` +
        (options.requestedPort !== undefined
          ? ` (from --port ${options.requestedPort})`
          : ` (port ${DEFAULT_PORT} is in use by another process, so a free port was chosen automatically)`) +
        `. Re-run without --port to keep using ${divergence.existingPort}, or edit ${effects.paths.envFile} ` +
        'to change the configured port intentionally, then re-run kopeng init.'
      );
    }
  }

  const disk = await effects.statfs(effects.paths.kopengHome);
  const claudeDetected = effects.exists(path.join(effects.homeDir, '.claude.json'));
  const codexDetected = effects.exists(path.join(effects.homeDir, '.codex'));
  const existingInstall = effects.exists(effects.paths.appDir);

  return buildPreflightReport({
    nodeMajor: effects.nodeMajor,
    platform: effects.platform,
    port: portResolution.port,
    portOverridden: portResolution.overridden,
    existingServerRunning: portResolution.existingServerRunning,
    diskFreeBytes: disk ? disk.freeBytes : null,
    diskThresholdBytes: MIN_DISK_FREE_BYTES,
    claudeDetected,
    codexDetected,
    existingInstall,
  });
}

export const runInitCommand: CommandHandler = runInit;

// ── Real wiring (never invoked by tests) ────────────────────────────────

function realWriteTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* Windows / restrictive filesystem */ }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function realListFiles(dir: string): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try { results.push({ path: full, size: fs.statSync(full).size }); } catch { /* race — skip */ }
      }
    }
  };
  walk(dir);
  return results;
}

async function realStatfs(dir: string): Promise<{ freeBytes: number } | null> {
  try {
    const stats = await fs.promises.statfs(dir);
    return { freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null; // fail-open: disk check is best-effort only
  }
}

async function realProbePort(port: number, fetchImpl: typeof fetch): Promise<PortProbeResult> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    return { kind: 'response', body };
  } catch {
    return { kind: 'no-response' };
  }
}

// quoteArgForShell / planNpmInstallSpawn / runNpmInstall used to live here —
// Task 2.5 fix round 1, Finding 1: extracted into src/cli/npm-spawn.ts, a
// SHARED module, once the reviewer confirmed update.ts's copy-pasted
// realNpmInstall had the identical win32 npm.cmd bug (and, unfixed, a stale
// comment pointing back at this file). Both init.ts and update.ts now import
// the one implementation instead of maintaining two copies that can drift.
function realNpmInstall(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runNpmInstall(args, spawn);
}

function realDownloadModels(opts: { appDir: string; modelsDir: string; kopengHome: string; envFile: string }): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const embedderEntry = path.join(opts.appDir, 'node_modules', 'kopeng', 'dist', 'embeddings', 'embedder.js');
    const entryUrl = pathToFileURL(embedderEntry).href;
    const script =
      'import(process.argv[1]).then(m => m.initEmbedder()).then(() => process.exit(0))' +
      '.catch(e => { console.error(e && e.stack || String(e)); process.exit(1); });';
    const child = spawn(process.execPath, ['-e', script, entryUrl], {
      env: { ...process.env, KOPENG_HOME: opts.kopengHome, KOPENG_ENV_FILE: opts.envFile, MODELS_CACHE_DIR: opts.modelsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
    child.on('error', (err) => resolve({ ok: false, detail: `Could not launch node to download the embedding model: ${err.message}` }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, detail: `Embedding model ready in ${opts.modelsDir}.` });
      else resolve({ ok: false, detail: `Downloading the embedding model failed (exit ${code}).${stderr ? ` ${stderr.trim().slice(-500)}` : ''}` });
    });
  });
}

export function createRealInitEffects(): InitEffects {
  const paths = derivedInitPaths(KOPENG_HOME);
  return {
    paths,
    homeDir: os.homedir(),
    appDataDir: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    platform: process.platform,
    nodePath: process.execPath,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    runningVersion: KOPENG_VERSION,
    startHealthTimeoutMs: START_HEALTH_TIMEOUT_MS,
    startHealthPollMs: START_HEALTH_POLL_MS,
    startEmbeddingTimeoutMs: START_EMBEDDING_TIMEOUT_MS,
    isTTY: process.stdin.isTTY === true,

    exists: (p) => fs.existsSync(p),
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
    writeFile: realWriteTextAtomic,
    readInstalledVersion: (repoRoot) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    },
    listFiles: realListFiles,
    statfs: realStatfs,
    probePort: (port) => realProbePort(port, fetch),

    npmInstall: realNpmInstall,
    downloadModels: realDownloadModels,

    autostartEffects: realAutostartEffects,
    registerAutostart,

    fetchImpl: fetch,
    spawnImpl: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    // Dynamic import: ensure.ts pulls in config.ts at module scope — see the
    // file header. Deferred until `kopeng init` actually reaches this step.
    runEnsure: async (deps) => {
      const { runEnsure } = await import('./ensure.js');
      return runEnsure(deps);
    },

    wireClient,
    chooseProfile,
    confirm: async (question) => {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        return parseYesNo(answer);
      } finally {
        rl.close();
      }
    },

    runDoctor,
    // Dynamic import: recall-canary.ts has a top-level dotenv.config() side
    // effect — see the file header. Deferred until step 9 actually runs.
    runCanary: async (canaryOptions) => {
      const { runCanary } = await import('./recall-canary.js');
      return runCanary(canaryOptions);
    },
  };
}
