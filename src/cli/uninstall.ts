/**
 * `kopeng uninstall` (Task 2.4.3, Install Strategy §4.4) — the symmetric
 * reversal of `kopeng init`. Reverses exactly what init installed (app,
 * autostart, config merges) and KEEPS data (the database, models, .env)
 * unless `--purge` is also given.
 *
 * Same injected-effects idiom as init.ts: runUninstall never calls
 * fs/fetch/spawn/readline directly — every side effect goes through the
 * `UninstallEffects` bag, so the whole flow is testable against a temp
 * KOPENG_HOME + temp fake client configs with no real side effects. Order:
 * stop server -> unregister autostart -> remove the ensure knob -> reverse
 * config merges -> remove the app dir -> summary (+ optional --purge).
 *
 * Do NOT statically import config.ts here (same finding-6 pattern as
 * init.ts/index.ts) — this file reads the target install's .env directly via
 * dotenv.parse, never through config.ts's eager-validating singleton.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';

import { renderManifest } from './manifest.js';
import {
  unregisterAutostart as realUnregisterAutostart,
  realAutostartEffects,
  type AutostartEffects,
  type UnregisterAutostartResult,
} from './autostart.js';
import { removeClient as realRemoveClient, type WireRemoveOptions, type WireRemoveResult } from './wire-client.js';
import { KOPENG_HOME } from './paths.js';
import type { CliIo, CommandHandler } from './index.js';
import { isEntrypoint } from '../utils/entrypoint.js';

export class UninstallError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_PORT = 3200;
const STOP_TIMEOUT_MS = 500;
const SERVER_DOWN_POLL_TIMEOUT_MS = 5_000;
const SERVER_DOWN_POLL_INTERVAL_MS = 250;
const APP_DIR_REMOVE_ATTEMPTS = 3;
const APP_DIR_REMOVE_RETRY_DELAY_MS = 500;

// ── Paths ───────────────────────────────────────────────────────────────

export interface UninstallPaths {
  kopengHome: string;
  appDir: string;
  dataDir: string;
  modelsDir: string;
  envFile: string;
  autostartRecordFile: string;
  ensureKnobFile: string;
}

export function derivedUninstallPaths(kopengHome: string): UninstallPaths {
  return {
    kopengHome,
    appDir: path.join(kopengHome, 'app'),
    dataDir: path.join(kopengHome, 'data'),
    modelsDir: path.join(kopengHome, 'models'),
    envFile: path.join(kopengHome, '.env'),
    autostartRecordFile: path.join(kopengHome, 'autostart.json'),
    ensureKnobFile: path.join(kopengHome, 'ensure.json'),
  };
}

// ── Step 1: stop server ────────────────────────────────────────────────

export interface StopServerResult {
  stopped: boolean;
  reason?: string;
  /** The port stopServer resolved from .env (or the shipped default) —
   *  reused by the caller's post-stop quiet-wait (`waitForServerDown`) and,
   *  on `kopeng update`, the restart probe, so neither has to re-parse the
   *  target .env a second time. */
  port: number;
}

export interface StopServerDeps {
  paths: Pick<UninstallPaths, 'envFile'>;
  readFile: (p: string) => string | undefined;
  fetchImpl: typeof fetch;
}

export type ShutdownTarget = 'kopeng' | 'foreign' | 'no-response';

/**
 * True for a body carrying `data.status` (any value) — the shape a KOPENG
 * /api/health answers with.
 *
 * This mirrors `isKopengHealthBody` in ensure.ts rather than importing it:
 * ensure.ts pulls in config.ts's eager-validating singleton at module scope,
 * which is exactly what the file header forbids here (init.ts/update.ts get
 * away with it only because they import ensure.js DYNAMICALLY, inside their
 * real-effects factories). An uninstall must not become un-runnable because
 * a broken .env made config.ts throw on import. The predicate is four lines
 * and is pinned on both sides by its own tests.
 */
export function isKopengHealthBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const data = (body as Record<string, unknown>).data;
  return typeof data === 'object' && data !== null && 'status' in (data as Record<string, unknown>);
}

/** Keyless GET /api/health — the gate on whether the admin key may be sent
 *  (Finding 1). Never throws: every failure mode collapses to 'no-response'. */
export async function probeShutdownTarget(apiUrl: string, fetchImpl: typeof fetch): Promise<ShutdownTarget> {
  try {
    const res = await fetchImpl(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(STOP_TIMEOUT_MS) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined; // non-JSON body — a foreign listener, not a KOPENG server
    }
    return isKopengHealthBody(body) ? 'kopeng' : 'foreign';
  } catch {
    return 'no-response';
  }
}

/**
 * Reads the admin key + port straight out of the target install's .env
 * (dotenv.parse — never config.ts) and POSTs /api/admin/shutdown. Every
 * failure mode (no .env, unreachable, or an older server that predates the
 * endpoint) degrades to a named, non-throwing reason — this is called from
 * both `kopeng uninstall` and `kopeng update`, and neither may hard-fail
 * just because the server was already down.
 *
 * Fix round 1 (Finding 4): a keyless .env still ATTEMPTS the request (no
 * `x-api-key` header) rather than skipping it — `requireAdminKey` treats a
 * falsy `ADMIN_API_KEY` as open dev mode server-side too (routes.ts), so a
 * keyless local .env genuinely stops a keyless (dev-mode) server. Against a
 * keyed server it costs one 401, which degrades through the existing
 * printed-reason path exactly like a wrong key would.
 *
 * Fix round 2 (Finding 1): the shutdown POST is preceded by a KEYLESS
 * GET /api/health, and the key only goes out when that answers KOPENG-shaped.
 * Previously the key was handed to WHATEVER held the port: on a shared POSIX
 * host, another local user binds 127.0.0.1:<PORT> with a trivial listener,
 * the operator runs `kopeng update`/`kopeng uninstall`, and the admin key
 * gating every mutating endpoint arrives in a header — defeating the 0600
 * .env mode first-run.ts deliberately sets (the attacker never has to read
 * the file) and opening the way to a planted memory that gets recalled into
 * the operator's model context on a later prompt. A listener that says
 * nothing at all is the SAME attack, so a no-response probe withholds the key
 * too: nothing that answers /api/health is nothing we can gracefully stop.
 */
export async function stopServer(deps: StopServerDeps): Promise<StopServerResult> {
  const source = deps.readFile(deps.paths.envFile);
  if (source === undefined) {
    return { stopped: false, reason: `no .env found at ${deps.paths.envFile}`, port: DEFAULT_PORT };
  }

  const parsed = dotenv.parse(source);
  const parsedPort = parsed.PORT ? parseInt(parsed.PORT, 10) : NaN;
  const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
  const adminKey = parsed.ADMIN_API_KEY;
  const apiUrl = `http://127.0.0.1:${port}`;

  const probe = await probeShutdownTarget(apiUrl, deps.fetchImpl);
  if (probe === 'no-response') {
    return { stopped: false, reason: `server unreachable at ${apiUrl} (no answer on GET /api/health)`, port };
  }
  if (probe === 'foreign') {
    return { stopped: false, reason: `a non-KOPENG process is listening on port ${port}`, port };
  }

  try {
    const res = await deps.fetchImpl(`${apiUrl}/api/admin/shutdown`, {
      method: 'POST',
      headers: adminKey ? { 'x-api-key': adminKey } : {},
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return { stopped: false, reason: 'server does not expose /api/admin/shutdown (an older server)', port };
    }
    if (res.status === 401) {
      return {
        stopped: false,
        reason: adminKey
          ? 'shutdown request failed (HTTP 401) — the admin key in .env does not match the running server'
          : 'no ADMIN_API_KEY in .env, and the running server requires one (HTTP 401)',
        port,
      };
    }
    if (!res.ok) {
      return { stopped: false, reason: `shutdown request failed (HTTP ${res.status})`, port };
    }
    return { stopped: true, port };
  } catch (err) {
    return { stopped: false, reason: `server unreachable at ${apiUrl} (${messageOf(err)})`, port };
  }
}

// ── Post-stop quiet-wait (Finding 2 / Finding 3) ────────────────────────

export interface WaitForServerDownDeps {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Polls `/api/health` until the connection is refused (the listener is
 * actually gone) or the timeout elapses. A response — even a non-2xx one,
 * such as Fastify's `return503OnClosing` reply while connections are still
 * draining — is NOT "down": only a network error proves the port is free.
 * `stopServer`'s 202 means the request was ACCEPTED, not that the process
 * has exited yet (`requestShutdown` finishes the real shutdown async and
 * only then calls `process.exit` — see server.ts). Used before deleting the
 * app dir (a still-running server has `better_sqlite3.node`/onnxruntime
 * native modules mapped — unlinking them is an EPERM on Windows) and, in
 * `kopeng update`, before probing for a restart (a closing-but-still-
 * listening port reads as `already-up` or `port-conflict`, never `spawn`).
 */
export async function waitForServerDown(apiUrl: string, deps: WaitForServerDownDeps): Promise<boolean> {
  const deadline = Date.now() + deps.timeoutMs;
  for (;;) {
    try {
      await deps.fetchImpl(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(Math.min(1000, deps.timeoutMs)) });
    } catch {
      return true; // connection refused / no response — the port is free
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, deps.pollIntervalMs));
  }
}

/** Retries a throwing sync effect a bounded number of times with a delay
 *  between attempts (Finding 2) — a residual native-module handle can take a
 *  moment to release even after the process has fully exited. Re-throws the
 *  last error if every attempt fails. */
async function retryRemoval(remove: () => void, attempts: number, delayMs: number): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      remove();
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ── --purge confirmation gate ───────────────────────────────────────────

export type PurgeGateDecision = 'skip' | 'prompt' | 'fail-non-tty';

/**
 * Pure, mirrors init.ts's decideConsentGate. --yes always skips the prompt;
 * a non-interactive stdin without --yes refuses rather than hanging forever
 * on a readline question nobody can answer.
 */
export function decidePurgeGate(opts: { yes: boolean; isTTY: boolean }): PurgeGateDecision {
  if (opts.yes) return 'skip';
  if (!opts.isTTY) return 'fail-non-tty';
  return 'prompt';
}

/** Purge is the one destructive act here — require the operator to type the
 *  literal word, not a bare Enter/"y" the way the init consent prompt takes. */
export function parsePurgeConfirmation(answer: string): boolean {
  return answer.trim().toLowerCase() === 'purge';
}

// ── --purge target validity (fix round 2, Finding 3) ────────────────────────

export interface PurgeMarkers {
  /** `<kopengHome>/.env` — written by every init. */
  env: boolean;
  /** `<kopengHome>/app` — the installed server. */
  app: boolean;
  /** `<kopengHome>/data` — the memory database. */
  data: boolean;
}

export interface PurgeTargetDecision {
  allowed: boolean;
  /** Human-readable names of the markers that were absent — empty when allowed. */
  missing: string[];
}

/**
 * Consent was the only gate on the recursive delete: `--purge --yes` never
 * asked whether the target is an install at all. `KOPENG_HOME` is a supported
 * override (install-smoke.mjs exports it routinely), so an operator with it
 * still set in a shell, pointing somewhere that is not an install, ran the
 * documented command and lost that tree — and `--yes` skipped the prompt that
 * would have shown them the path.
 *
 * So require the markers an install always has before deleting: `.env`, plus
 * at least one of `app/` (the server) or `data/` (the database) — either can
 * legitimately be absent (a `--purge` right after a failed install, or an
 * install whose app dir step 5 already removed). Same convention as
 * `dream:effectiveness` and `triage:anchors`, which refuse by name rather
 * than trusting the caller's aim.
 */
export function decidePurgeTarget(markers: PurgeMarkers): PurgeTargetDecision {
  const missing: string[] = [];
  if (!markers.env) missing.push('.env');
  if (!markers.app && !markers.data) missing.push('app/ or data/');
  return { allowed: missing.length === 0, missing };
}

// ── Closing summary (Finding 2) ─────────────────────────────────────────

/**
 * The unconditional "KOPENG has been uninstalled." line used to print even
 * when a step above had degraded to "could not remove ...; continuing" —
 * true for the steps that ran, but not an honest summary of the whole
 * command. Success wording only when nothing was left behind; otherwise
 * name what remains so the operator doesn't have to scroll back up.
 */
export function closingLine(issues: readonly string[]): string {
  return issues.length === 0
    ? 'KOPENG has been uninstalled.'
    : `KOPENG uninstall completed with issues: ${issues.join('; ')}.`;
}

// ── CLI arg parsing ─────────────────────────────────────────────────────

export interface UninstallCliOptions {
  yes: boolean;
  purge: boolean;
  dryRun: boolean;
  /** Overrides the install-marker check `--purge` runs on its target
   *  (Finding 3) — deliberately separate from `--yes`, which only skips the
   *  confirmation prompt. */
  force: boolean;
}

export function parseUninstallArgs(args: string[]): UninstallCliOptions {
  let yes = false;
  let purge = false;
  let dryRun = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--yes') yes = true;
    else if (arg === '--purge') purge = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else throw new UninstallError(`Unknown argument: ${arg}`);
  }
  return { yes, purge, dryRun, force };
}

// ── Effects ─────────────────────────────────────────────────────────────

export interface UninstallEffects {
  paths: UninstallPaths;
  homeDir: string;
  isTTY: boolean;

  exists: (p: string) => boolean;
  readFile: (p: string) => string | undefined;
  removeFile: (p: string) => void;
  removeDir: (p: string) => void;

  fetchImpl: typeof fetch;
  /** Finding 2/3: bounds for the post-stop quiet-wait. Real defaults are
   *  ~5s/250ms; tests inject much shorter values to stay fast. */
  serverDownPoll: { timeoutMs: number; pollIntervalMs: number };
  /** Finding 2: bounds for the app-dir removal retry (a residual native-
   *  module handle can take a moment to release). Real default is 3
   *  attempts / 500ms apart; tests inject a much shorter delay. */
  appDirRemoveRetry: { attempts: number; delayMs: number };

  autostartEffects: AutostartEffects;
  unregisterAutostart: (effects: AutostartEffects, recordPath: string) => UnregisterAutostartResult;

  removeClient: (options: WireRemoveOptions) => WireRemoveResult;

  promptText: (question: string) => Promise<string>;
}

// ── Orchestrator ────────────────────────────────────────────────────────

export async function runUninstall(
  argv: string[],
  io: CliIo,
  effects: UninstallEffects = createRealUninstallEffects()
): Promise<number> {
  let options: UninstallCliOptions;
  try {
    options = parseUninstallArgs(argv);
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }

  const dryRun = options.dryRun;
  // Fix round 1 (Finding 2): every step that leaves something behind
  // records why here, so the closing line can be honest instead of always
  // claiming success.
  const issues: string[] = [];

  try {
    io.log(dryRun ? 'Uninstalling KOPENG (dry run — nothing will be changed) ...' : 'Uninstalling KOPENG ...');

    // Finding 3: sampled HERE, before step 5 removes the app dir — the
    // question `--purge` needs answered is "was this an install when the
    // command started", not "is it still one after we took it apart".
    const purgeTarget = decidePurgeTarget({
      env: effects.exists(effects.paths.envFile),
      app: effects.exists(effects.paths.appDir),
      data: effects.exists(effects.paths.dataDir),
    });

    // 1. Stop server, then wait for the port to actually go quiet before any
    // step that could race a still-running process (Finding 2/3).
    if (dryRun) {
      io.log('Would attempt to stop the server via POST /api/admin/shutdown.');
    } else {
      const stopResult = await stopServer(effects);
      io.log(
        stopResult.stopped
          ? 'Server stopped.'
          : `Server not stopped (${stopResult.reason}); it will not restart after autostart removal.`
      );
      if (stopResult.stopped) {
        const apiUrl = `http://127.0.0.1:${stopResult.port}`;
        const wentQuiet = await waitForServerDown(apiUrl, { fetchImpl: effects.fetchImpl, ...effects.serverDownPoll });
        if (!wentQuiet) {
          const issue =
            `the server was still answering ${apiUrl} after waiting ${effects.serverDownPoll.timeoutMs}ms for it ` +
            'to stop — app-dir removal below may fail while it holds files open';
          io.log(`Warning: ${issue}.`);
          issues.push(issue);
        }
      }
    }

    // 2. Unregister autostart
    if (dryRun) {
      io.log(`Would remove the autostart registration recorded at ${effects.paths.autostartRecordFile}.`);
    } else {
      try {
        const autostartResult = effects.unregisterAutostart(effects.autostartEffects, effects.paths.autostartRecordFile);
        if (autostartResult.malformed) {
          const issue =
            `found a malformed autostart record at ${effects.paths.autostartRecordFile} — removed the file, but ` +
            'could not reverse whatever it had registered; check your OS scheduler/startup items manually';
          io.log(`${issue}.`);
          issues.push(issue);
        } else {
          io.log(autostartResult.reversed ? 'Autostart entry removed.' : 'No autostart entry was registered.');
        }
        // Fix round 2 (Finding 2): the allowlist refusals are the operator's
        // problem to finish, so they are named here and counted as issues —
        // an uninstall that left something behind must not read as clean.
        for (const refusal of autostartResult.refused ?? []) {
          io.log(`Autostart record: ${refusal}.`);
          issues.push(refusal);
        }
      } catch (err) {
        const issue = `could not remove the autostart entry (${messageOf(err)})`;
        io.log(`${issue}; continuing.`);
        issues.push(issue);
      }
    }

    // 3. Remove the ensure knob
    if (dryRun) {
      io.log(`Would remove the ensure knob at ${effects.paths.ensureKnobFile}.`);
    } else {
      try {
        if (effects.exists(effects.paths.ensureKnobFile)) {
          effects.removeFile(effects.paths.ensureKnobFile);
          io.log(`Removed ${effects.paths.ensureKnobFile}.`);
        }
      } catch (err) {
        const issue = `could not remove the ensure knob (${messageOf(err)})`;
        io.log(`${issue}; continuing.`);
        issues.push(issue);
      }
    }

    // 4. Reverse config merges (Claude Code via 2.4.2; Codex is manual)
    try {
      const removeResult = effects.removeClient({ homeDir: effects.homeDir, apply: !dryRun, log: io.log });
      if (removeResult.changed) {
        io.log(dryRun ? 'Would remove KOPENG entries from the Claude Code config.' : 'Claude Code client wiring removed.');
      } else {
        io.log('No Claude Code client wiring found.');
      }
    } catch (err) {
      const issue =
        `could not update the Claude Code config (${messageOf(err)}) — remove KOPENG entries from ` +
        '~/.claude.json and ~/.claude/settings.json manually if needed';
      io.log(`${issue}; continuing.`);
      issues.push(issue);
    }
    if (effects.exists(path.join(effects.homeDir, '.codex'))) {
      io.log(
        'Codex detected — `kopeng wire` never manages Codex, so nothing was reversed there. ' +
        'If you wired it manually, remove those entries yourself.'
      );
    }

    // 5. Remove the app dir (Finding 2: retry — a residual native-module
    // handle can take a moment to release even after the process has exited).
    if (dryRun) {
      io.log(`Would remove ${effects.paths.appDir}.`);
    } else {
      try {
        if (effects.exists(effects.paths.appDir)) {
          await retryRemoval(() => effects.removeDir(effects.paths.appDir), effects.appDirRemoveRetry.attempts, effects.appDirRemoveRetry.delayMs);
          io.log(`Removed ${effects.paths.appDir}.`);
        }
      } catch (err) {
        const issue =
          `could not remove ${effects.paths.appDir} (${messageOf(err)}) — it may still be held by a running ` +
          'kopeng process; stop it and delete the directory manually';
        io.log(`${issue}; continuing.`);
        issues.push(issue);
      }
    }

    // 6. Summary
    io.log('');
    io.log(renderManifest('uninstall'));
    io.log('');
    io.log('KOPENG data is KEPT (pass --purge to remove it too):');
    io.log(`  Database: ${effects.paths.dataDir}`);
    io.log(`  Models:   ${effects.paths.modelsDir}`);
    io.log(`  Config:   ${effects.paths.envFile}`);

    if (!options.purge) {
      io.log('');
      io.log(`Run \`kopeng uninstall --purge\` to also remove ${effects.paths.kopengHome} entirely (including your memory database).`);
      io.log(closingLine(issues));
      return issues.length === 0 ? 0 : 1;
    }

    // --purge: the one destructive act here — gated accordingly. Target
    // validity first (Finding 3): consent proves the operator meant to purge,
    // never that KOPENG_HOME points at an install.
    const purgeRefusal = purgeTarget.allowed || options.force
      ? undefined
      : `${effects.paths.kopengHome} does not look like a KOPENG install (missing ${purgeTarget.missing.join(' and ')}) — ` +
        'refusing to delete it; check KOPENG_HOME, or pass --force if you are certain';

    if (dryRun) {
      io.log('');
      if (purgeRefusal) {
        io.log(`--purge: would REFUSE — ${purgeRefusal}.`);
      } else {
        io.log(`--purge: would permanently delete ${effects.paths.kopengHome} (including your memory database).`);
        if (options.force && !purgeTarget.allowed) {
          io.log(`  (--force: the install markers ${purgeTarget.missing.join(' and ')} are absent and the check was overridden.)`);
        }
      }
      io.log('KOPENG has been uninstalled (dry run).');
      return 0;
    }

    if (purgeRefusal) {
      io.log('');
      io.log(`Refusing to purge: ${purgeRefusal}.`);
      issues.push(`--purge was requested but refused (${purgeTarget.missing.join(' and ')} absent); data was kept`);
      io.log(closingLine(issues));
      return 1;
    }
    if (options.force && !purgeTarget.allowed) {
      io.log('');
      io.log(`--force: ${effects.paths.kopengHome} is missing ${purgeTarget.missing.join(' and ')}; purging anyway as instructed.`);
    }

    const gate = decidePurgeGate({ yes: options.yes, isTTY: effects.isTTY });
    if (gate === 'fail-non-tty') {
      // Fix round 1 (Finding 5): a CI `--purge` without --yes must not exit 0
      // claiming success while the data it was told to purge survives.
      io.log('');
      io.log('Refusing to purge on non-interactive stdin without --yes — pass --yes to purge non-interactively.');
      issues.push('--purge was requested but refused (non-interactive stdin without --yes); data was kept');
      io.log(closingLine(issues));
      return 1;
    }

    let confirmed = gate === 'skip';
    if (gate === 'prompt') {
      const answer = await effects.promptText(`Type "purge" to permanently delete ${effects.paths.kopengHome}: `);
      confirmed = parsePurgeConfirmation(answer);
    }

    if (!confirmed) {
      io.log('');
      io.log('Purge not confirmed — data was kept.');
      io.log(closingLine(issues));
      // Finding 5 (fix round): the other three closing sites tie exit code to
      // issues.length — this one hardcoded 0, hiding earlier steps (stop
      // server, unregister autostart, remove app dir, ...) that degraded with
      // an issue, even though closingLine() above already printed it.
      return issues.length === 0 ? 0 : 1;
    }

    try {
      effects.removeDir(effects.paths.kopengHome);
      io.log('');
      io.log(`Purged ${effects.paths.kopengHome} — all data removed.`);
    } catch (err) {
      io.log(`Could not purge ${effects.paths.kopengHome} (${messageOf(err)}).`);
      return 1;
    }

    io.log(closingLine(issues));
    return issues.length === 0 ? 0 : 1;
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }
}

export const runUninstallCommand: CommandHandler = runUninstall;

// ── Real wiring (never invoked by a test) ──────────────────────────────

function realRemoveFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

function realRemoveDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

export function createRealUninstallEffects(): UninstallEffects {
  return {
    paths: derivedUninstallPaths(KOPENG_HOME),
    homeDir: os.homedir(),
    isTTY: process.stdin.isTTY === true,

    exists: (p) => fs.existsSync(p),
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
    removeFile: realRemoveFile,
    removeDir: realRemoveDir,

    fetchImpl: fetch,
    serverDownPoll: { timeoutMs: SERVER_DOWN_POLL_TIMEOUT_MS, pollIntervalMs: SERVER_DOWN_POLL_INTERVAL_MS },
    appDirRemoveRetry: { attempts: APP_DIR_REMOVE_ATTEMPTS, delayMs: APP_DIR_REMOVE_RETRY_DELAY_MS },

    autostartEffects: realAutostartEffects,
    unregisterAutostart: realUnregisterAutostart,

    removeClient: realRemoveClient,

    promptText: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

function isDirectRun(): boolean {
  // Symlink-safe (T72). The obvious argv[1]-vs-import.meta.url comparison
  // reads false through a symlink and this module silently does nothing.
  return isEntrypoint(import.meta.url);
}

if (isDirectRun()) {
  const io: CliIo = { log: (line) => console.log(line), error: (line) => console.error(line) };
  runUninstall(process.argv.slice(2), io)
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
