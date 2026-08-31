/**
 * `kopeng update` (Task 2.4.4, Install Strategy §4.4) — the version-bump
 * path. `npm install --prefix <appDir>` a newer package, and only if the
 * installed version actually changed: stop the running server (the same
 * mechanics `kopeng uninstall`'s step 1 uses), fire-and-forget spawn it back
 * via `kopeng ensure`, poll health, and summarize with `kopeng doctor`.
 * Migrations run at server boot through the existing ladder — update does no
 * extra migration work of its own.
 *
 * Same injected-effects idiom as init.ts/uninstall.ts: runUpdate never calls
 * fs/fetch/spawn directly. Do NOT statically import config.ts here (same
 * finding-6 pattern) — ensure.ts is dynamically imported, exactly as init.ts
 * does, because it pulls in config.ts's eager-validating singleton.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';

import { KOPENG_HOME } from './paths.js';
import { waitForHealth, describeHealthWait } from './init.js';
import { runDoctor, type DoctorOptions, type DoctorReport } from './doctor.js';
import { stopServer, waitForServerDown, type StopServerResult } from './uninstall.js';
import { runNpmInstall } from './npm-spawn.js';
import type { EnsureDeps, EnsureDecision } from './ensure.js';
import type { CliIo, CommandHandler } from './index.js';
import { isEntrypoint } from '../utils/entrypoint.js';

export class UpdateError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const START_HEALTH_TIMEOUT_MS = 20_000;
const START_EMBEDDING_TIMEOUT_MS = 60_000;
const START_HEALTH_POLL_MS = 500;
const SERVER_DOWN_POLL_TIMEOUT_MS = 5_000;
const SERVER_DOWN_POLL_INTERVAL_MS = 250;

// ── Paths ───────────────────────────────────────────────────────────────

export interface UpdatePaths {
  kopengHome: string;
  appDir: string;
  envFile: string;
  hintsDir: string;
  installedRepoRoot: string;
  serverEntry: string;
}

export function derivedUpdatePaths(kopengHome: string): UpdatePaths {
  const appDir = path.join(kopengHome, 'app');
  const installedRepoRoot = path.join(appDir, 'node_modules', 'kopeng');
  return {
    kopengHome,
    appDir,
    envFile: path.join(kopengHome, '.env'),
    hintsDir: path.join(kopengHome, 'hints'),
    installedRepoRoot,
    serverEntry: path.join(installedRepoRoot, 'dist', 'server.js'),
  };
}

// ── Pure decisions ──────────────────────────────────────────────────────

export type UpdateSpecReason = 'from-flag' | 'latest';
export interface UpdateSpec {
  spec: string;
  reason: UpdateSpecReason;
}

/** Mirrors init.ts's decideInstallSpec: an explicit --from always wins;
 *  otherwise update always asks npm for the newest published release
 *  (init's own default is the version currently RUNNING, since init just
 *  wants to reproduce itself — update's whole purpose is to move forward). */
export function decideUpdateSpec(fromFlag: string | undefined): UpdateSpec {
  return fromFlag ? { spec: fromFlag, reason: 'from-flag' } : { spec: 'kopeng@latest', reason: 'latest' };
}

export type UpdateOutcome = 'no-change' | 'updated';

/** Pure: restart machinery only runs when the installed version actually
 *  moved. `npm install` completing with exit 0 is not itself evidence of a
 *  change — an already-current install re-resolves the same version. */
export function decideUpdateOutcome(before: string | undefined, after: string | undefined): UpdateOutcome {
  return before === after ? 'no-change' : 'updated';
}

// ── CLI arg parsing ─────────────────────────────────────────────────────

export interface UpdateCliOptions {
  from?: string;
}

export function parseUpdateArgs(args: string[]): UpdateCliOptions {
  let from: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from') {
      from = args[++i];
      if (!from) throw new UpdateError('--from requires a value (a tarball path, directory, or npm spec).');
    } else {
      throw new UpdateError(`Unknown argument: ${arg}`);
    }
  }
  return { from };
}

// ── Effects ─────────────────────────────────────────────────────────────

export interface UpdateEffects {
  paths: UpdatePaths;
  nodePath: string;
  startHealthTimeoutMs: number;
  startHealthPollMs: number;
  startEmbeddingTimeoutMs?: number;
  /** Fix round 1 (Finding 3): bounds for the post-stop quiet-wait before
   *  probing for a restart — real defaults ~5s/250ms; tests inject much
   *  shorter values. */
  serverDownPoll: { timeoutMs: number; pollIntervalMs: number };

  readInstalledVersion: (repoRoot: string) => string | undefined;
  readFile: (p: string) => string | undefined;
  writeFile: (p: string, content: string) => void;
  /** Fix round 1 (Finding 3): best-effort cleanup of the misleading
   *  ensure_conflict.json hint `runEnsure` writes on a 'port-conflict'
   *  decision — that hint is meant for a genuine foreign-process conflict,
   *  not update's own transient restart race. */
  removeFile: (p: string) => void;
  npmInstall: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

  fetchImpl: typeof fetch;
  spawnImpl: (command: string, args: string[], options: SpawnOptions) => { unref(): void };
  runEnsure: (deps: EnsureDeps) => Promise<EnsureDecision>;
  runDoctor: (options: DoctorOptions) => Promise<DoctorReport>;
}

// ── Orchestrator ────────────────────────────────────────────────────────

export async function runUpdate(
  argv: string[],
  io: CliIo,
  effects: UpdateEffects = createRealUpdateEffects()
): Promise<number> {
  let options: UpdateCliOptions;
  try {
    options = parseUpdateArgs(argv);
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }

  try {
    const spec = decideUpdateSpec(options.from);
    const before = effects.readInstalledVersion(effects.paths.installedRepoRoot);
    io.log(`Updating KOPENG (${spec.spec})${before ? ` — currently ${before}` : ''} ...`);

    const installResult = await effects.npmInstall(['install', '--prefix', effects.paths.appDir, spec.spec]);
    if (installResult.code !== 0) {
      throw new UpdateError(
        `npm install failed (exit ${installResult.code}) installing ${spec.spec} into ${effects.paths.appDir}.` +
        (installResult.stderr ? ` ${installResult.stderr.trim().slice(-500)}` : '')
      );
    }

    const after = effects.readInstalledVersion(effects.paths.installedRepoRoot);
    const outcome = decideUpdateOutcome(before, after);

    if (outcome === 'no-change') {
      io.log(`Already up to date (${after ?? 'unknown version'}).`);
      return 0;
    }

    io.log(`Updated ${before ?? '<none>'} -> ${after ?? 'unknown version'}.`);

    const stopResult: StopServerResult = await stopServer({
      paths: effects.paths,
      readFile: effects.readFile,
      fetchImpl: effects.fetchImpl,
    });
    io.log(
      stopResult.stopped
        ? 'Server stopped for restart.'
        : `Server not stopped (${stopResult.reason}); attempting to start the new version anyway.`
    );

    // Fix round 1 (Finding 3): probing for a restart immediately after a
    // 202 races the server's own async shutdown — the closing server either
    // still answers kopeng-shaped ('already-up', no spawn) or Fastify's
    // return503OnClosing answers non-kopeng ('port-conflict', no spawn).
    // Wait for the port to actually go quiet first.
    const apiUrl = `http://127.0.0.1:${stopResult.port}`;
    if (stopResult.stopped) {
      const wentQuiet = await waitForServerDown(apiUrl, { fetchImpl: effects.fetchImpl, ...effects.serverDownPoll });
      if (!wentQuiet) {
        io.log(`Warning: the server was still answering ${apiUrl} after waiting ${effects.serverDownPoll.timeoutMs}ms for it to stop.`);
      }
    }

    const ensureDecision = await effects.runEnsure({
      port: stopResult.port,
      nodePath: effects.nodePath,
      serverEntry: effects.paths.serverEntry,
      kopengHome: effects.paths.kopengHome,
      envFile: effects.paths.envFile,
      hintsDir: effects.paths.hintsDir,
      fetchImpl: effects.fetchImpl,
      spawnImpl: effects.spawnImpl,
      writeFile: effects.writeFile,
    });

    // Consume the decision instead of discarding it — 'spawn' is the only
    // outcome that actually starts the new version.
    let restartFailed = false;
    if (ensureDecision === 'spawn') {
      io.log('New version starting.');
    } else if (ensureDecision === 'already-up') {
      restartFailed = true;
      io.log(
        `The server at ${apiUrl} is still answering as the PREVIOUS version — the stop did not take effect. ` +
        'The new version is installed on disk and will run once that process actually exits; stop it manually ' +
        'or re-run `kopeng update`.'
      );
    } else {
      restartFailed = true;
      io.log(
        `A different process is now listening on ${apiUrl} — the new version was not started. ` +
        'Free the port and run `kopeng ensure`, or investigate what is using it.'
      );
      // This hint is meant for a genuine foreign-process conflict (surfaced
      // to `doctor` via the SessionStart-hook path); leaving it here would
      // misreport update's own transient restart race as a persistent one.
      try {
        effects.removeFile(path.join(effects.paths.hintsDir, 'ensure_conflict.json'));
      } catch { /* best-effort */ }
    }

    const health = await waitForHealth({
      port: stopResult.port,
      fetchImpl: effects.fetchImpl,
      timeoutMs: effects.startHealthTimeoutMs,
      pollIntervalMs: effects.startHealthPollMs,
      embeddingTimeoutMs: effects.startEmbeddingTimeoutMs,
    });
    io.log(describeHealthWait(health, effects.startHealthTimeoutMs, 'check with kopeng doctor.'));

    const doctorReport = await effects.runDoctor({
      envFile: effects.paths.envFile,
      fetchImpl: effects.fetchImpl,
      log: io.log,
    });
    io.log(doctorReport.ok ? 'Doctor: all checks passed (version-skew check should now read matched).' : 'Doctor: some checks need attention — see above.');

    return restartFailed || !doctorReport.ok ? 1 : 0;
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }
}

export const runUpdateCommand: CommandHandler = runUpdate;

// ── Real wiring (never invoked by a test) ──────────────────────────────

// Task 2.5 fix round 1, Finding 1: this used to be a second, independently
// broken copy of init.ts's realNpmInstall (bare shell:true, no arg quoting,
// no sync-throw guard — the exact win32 EINVAL / spaced-path bug, confirmed
// still present by the reviewer). Both files now share ONE implementation —
// see src/cli/npm-spawn.ts's header for the full history.
function realNpmInstall(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runNpmInstall(args, spawn);
}

function realWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function realRemoveFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

export function createRealUpdateEffects(): UpdateEffects {
  return {
    paths: derivedUpdatePaths(KOPENG_HOME),
    nodePath: process.execPath,
    startHealthTimeoutMs: START_HEALTH_TIMEOUT_MS,
    startHealthPollMs: START_HEALTH_POLL_MS,
    startEmbeddingTimeoutMs: START_EMBEDDING_TIMEOUT_MS,
    serverDownPoll: { timeoutMs: SERVER_DOWN_POLL_TIMEOUT_MS, pollIntervalMs: SERVER_DOWN_POLL_INTERVAL_MS },

    readInstalledVersion: (repoRoot) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    },
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
    writeFile: realWriteFile,
    removeFile: realRemoveFile,
    npmInstall: realNpmInstall,

    fetchImpl: fetch,
    spawnImpl: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    // Dynamic import: ensure.ts pulls in config.ts at module scope — see the
    // file header. Deferred until `kopeng update` actually reaches this step.
    runEnsure: async (deps) => {
      const { runEnsure } = await import('./ensure.js');
      return runEnsure(deps);
    },
    runDoctor,
  };
}

function isDirectRun(): boolean {
  // Symlink-safe (T72). The obvious argv[1]-vs-import.meta.url comparison
  // reads false through a symlink and this module silently does nothing.
  return isEntrypoint(import.meta.url);
}

if (isDirectRun()) {
  const io: CliIo = { log: (line) => console.log(line), error: (line) => console.error(line) };
  runUpdate(process.argv.slice(2), io)
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
