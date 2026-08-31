#!/usr/bin/env node
/**
 * kopeng — the packaged CLI (Task 2.1.2). Dispatch is pure and cheap: it
 * resolves a command name to a handler and, for the five commands this task
 * wires (wire/doctor/canary/mcp/start), spawns the corresponding compiled
 * sibling script with inherited stdio — the same thing the equivalent
 * `npm run <x>` / `node dist/<x>.js` already does, so behavior (interactive
 * prompts, exit codes, output) is unchanged from running those scripts
 * directly. An unrecognized or not-yet-implemented command exits 1 with a
 * clear message instead of crashing on a missing module.
 * init/ensure/autostart/uninstall/update/viz are wired directly (in-process
 * handlers, not spawned siblings) since they have no legacy `npm run <x>`
 * predecessor script — viz.ts spawns `scripts/viz-server.js` itself, from
 * the package root rather than dist/cli (see viz.ts's own header).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { KOPENG_VERSION } from '../version.js';
import { runInit } from './init.js';
import { runUninstall } from './uninstall.js';
import { runUpdate } from './update.js';
import { runViz } from './viz.js';
import { isEntrypoint } from '../utils/entrypoint.js';
import {
  planAutostart,
  registerAutostart,
  unregisterAutostart,
  autostartStatus,
  currentAutostartOpts,
  realAutostartEffects,
  AUTOSTART_RECORD_FILE,
  type AutostartPlatform,
} from './autostart.js';
// Review finding 6: NOT a static import. ensure.js pulls in
// ../config/config.js (for RESOLVED_ENV_FILE), which eagerly VALIDATES every
// env var at module-load time and throws on a malformed one (e.g. a negative
// ACCESS_LOG_RETENTION_DAYS). A static import here would make that config.ts
// side effect run for every dispatch — including `kopeng help`/`version`,
// which have nothing to do with ensure and must keep working regardless of
// launch-env poisoning. Deferred to inside runEnsureCommand instead.

// init.ts constructs its own effects lazily and never statically imports
// ensure.js/recall-canary.js as VALUES (see init.ts's own file header) — so,
// unlike ensure.js, importing it here at the top is safe. uninstall.ts and
// update.ts follow the same discipline (type-only EnsureDeps/EnsureDecision
// imports, ensure.js loaded dynamically inside their own real-effects code).
export { runInit, runUninstall, runUpdate, runViz };

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: CliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type CommandHandler = (args: string[], io: CliIo) => Promise<number>;

export interface CommandSpec {
  name: string;
  summary: string;
  handler: CommandHandler;
}

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spawns a sibling compiled script (resolved relative to this file's own
 * directory, so it works identically under dist/cli/ in the checkout and
 * under node_modules/kopeng/dist/cli/ once installed) with inherited stdio,
 * and resolves with its exit code. Never rejects on a non-zero exit — only
 * on a spawn failure (e.g. the target file is missing).
 */
function spawnSibling(relativePath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = path.resolve(CLI_DIR, relativePath);
    const child = spawn(process.execPath, [target, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export const runWire: CommandHandler = (args) => spawnSibling('wire-client.js', args);
export const runDoctor: CommandHandler = (args) => spawnSibling('doctor.js', args);
export const runCanary: CommandHandler = (args) => spawnSibling('recall-canary.js', args);
export const runMcp: CommandHandler = (args) => spawnSibling('../index.js', args);
export const runStart: CommandHandler = (args) => spawnSibling('../server.js', args);
// Spawned, not imported, for the same reason as the five above: it is a
// long-running driver with its own exit-code contract, and keeping it off the
// dispatch module graph means `kopeng help`/`version` never pay for its
// imports. It reaches `src/dreaming/scoring.js`, which pulls in
// `discovery/confidence.js` and nothing else — no config.ts, so the
// poisoned-env guarantee holds either way, but the pattern stays uniform.
export const runMigrateAnchors: CommandHandler = (args) => spawnSibling('migrate-anchors.js', args);

function supportedAutostartPlatform(): AutostartPlatform | undefined {
  return process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'
    ? process.platform
    : undefined;
}

/**
 * Minimal `kopeng autostart status|register|unregister` surface over
 * src/cli/autostart.ts's plan/apply split (Task 2.3.2) — wired here rather
 * than folded into `doctor` because register/unregister are OPERATOR ACTIONS
 * (they touch the OS scheduler), unlike doctor's read-only checks.
 */
export const runAutostart: CommandHandler = async (args, io) => {
  const platform = supportedAutostartPlatform();
  if (!platform) {
    io.error(`kopeng autostart is not supported on platform '${process.platform}'.`);
    return 1;
  }

  const sub = args[0];
  if (sub === 'register') {
    const plan = planAutostart(platform, currentAutostartOpts());
    const record = registerAutostart(plan, realAutostartEffects, AUTOSTART_RECORD_FILE);
    io.log(`Registered autostart via ${record.mechanism}.`);
    if (record.note) io.log(record.note);
    return 0;
  }
  if (sub === 'unregister') {
    const result = unregisterAutostart(realAutostartEffects, AUTOSTART_RECORD_FILE);
    // The untrusted-record guard in autostart.ts can REFUSE entries (a command
    // outside schtasks/systemctl/launchctl, a file outside the four roots
    // planAutostart can produce) and a corrupt record is unreversible — both
    // mean something was left on the machine. Printing only `reversed` dropped
    // them silently, so this path reported clean while a scheduled task or a
    // startup file survived. `runUninstall` already reports both and returns 1
    // when anything is left behind; this mirrors that convention rather than
    // inventing one.
    const leftBehind: string[] = [];
    if (result.malformed) {
      leftBehind.push(
        `found a malformed autostart record at ${AUTOSTART_RECORD_FILE} — removed the file, but `
        + 'could not reverse whatever it had registered; check your OS scheduler/startup items manually'
      );
    } else {
      io.log(result.reversed ? 'Autostart entry removed.' : 'No autostart entry was registered.');
    }
    for (const refusal of result.refused ?? []) leftBehind.push(refusal);

    if (leftBehind.length === 0) return 0;
    for (const issue of leftBehind) io.error(`Autostart record: ${issue}.`);
    io.error(
      `Left behind: ${leftBehind.length} autostart ${leftBehind.length === 1 ? 'entry' : 'entries'} `
      + 'this command refused to act on — remove them yourself.'
    );
    return 1;
  }
  if (sub === 'status') {
    const status = autostartStatus(realAutostartEffects, AUTOSTART_RECORD_FILE);
    if (!status.registered) {
      io.log('Not registered.');
    } else {
      io.log(`Registered via ${status.record?.mechanism}.`);
      if (status.record?.note) io.log(status.record.note);
      if (status.schtasksQueryStatus !== undefined) {
        io.log(`schtasks /Query exit code: ${status.schtasksQueryStatus}`);
      }
    }
    return 0;
  }

  io.error('Usage: kopeng autostart <status|register|unregister>');
  return 2;
};

/**
 * Fire-and-forget health probe + self-heal spawn (Task 2.3.3). Meant to be
 * called from the SessionStart hook on every prompt — logs a one-line
 * decision and returns; never waits for a spawned server to become ready.
 */
export const runEnsureCommand: CommandHandler = async (_args, io) => {
  const { runEnsure, currentEnsureDeps } = await import('./ensure.js');
  const decision = await runEnsure(currentEnsureDeps());
  switch (decision) {
    case 'already-up':
      io.log('kopeng server is already running.');
      break;
    case 'spawn':
      io.log('kopeng server was not running — launched it in the background.');
      break;
    case 'port-conflict':
      io.log('A non-KOPENG process is already listening on the configured port — not spawning. See `kopeng doctor`.');
      break;
  }
  return 0;
};

export const IMPLEMENTED_COMMANDS: readonly CommandSpec[] = [
  {
    name: 'wire',
    summary: 'Merge KOPENG into the local Claude Code / Codex client config (MCP + hooks).',
    handler: runWire,
  },
  {
    name: 'doctor',
    summary: 'Verify the server, client wiring, and recall hook are healthy.',
    handler: runDoctor,
  },
  {
    name: 'canary',
    summary: 'First-run proof that store -> embed -> semantic recall works end to end.',
    handler: runCanary,
  },
  {
    name: 'mcp',
    summary: 'Run the MCP stdio server (what Claude Code / Codex launches).',
    handler: runMcp,
  },
  {
    name: 'start',
    summary: 'Run the REST API server.',
    handler: runStart,
  },
  {
    name: 'autostart',
    summary: 'Manage user-level login autostart (status|register|unregister).',
    handler: runAutostart,
  },
  {
    name: 'ensure',
    summary: 'Fire-and-forget: start the server if it is not already running.',
    handler: runEnsureCommand,
  },
  {
    name: 'init',
    summary: 'One-command install: app, models, autostart, client wiring, and verification.',
    handler: runInit,
  },
  {
    name: 'uninstall',
    summary: 'Reverse init: stop the server, remove autostart and client wiring. Keeps data unless --purge.',
    handler: runUninstall,
  },
  {
    name: 'update',
    summary: 'Install a newer KOPENG release and restart the server if the version changed.',
    handler: runUpdate,
  },
  {
    name: 'viz',
    summary: 'Launch the web dashboard in the foreground (Ctrl-C stops it).',
    handler: runViz,
  },
  {
    name: 'migrate-anchors',
    summary: 'Lock memories still anchored by a deprecated spelling (dry-run unless --apply).',
    handler: runMigrateAnchors,
  },
];

/** Subcommands named in the Install Strategy roadmap but not wired yet. */
export const COMING_SOON_COMMANDS: readonly string[] = [];

export function resolveCommand(name: string): CommandSpec | undefined {
  return IMPLEMENTED_COMMANDS.find((spec) => spec.name === name);
}

export function usageText(): string {
  const nameWidth = Math.max(...IMPLEMENTED_COMMANDS.map((c) => c.name.length), ...COMING_SOON_COMMANDS.map((c) => c.length), 'version'.length);
  const lines = ['Usage: kopeng <command> [args]', '', 'Commands:'];
  for (const spec of IMPLEMENTED_COMMANDS) {
    lines.push(`  ${spec.name.padEnd(nameWidth)}  ${spec.summary}`);
  }
  for (const name of COMING_SOON_COMMANDS) {
    lines.push(`  ${name.padEnd(nameWidth)}  (coming in this release)`);
  }
  lines.push(`  ${'version'.padEnd(nameWidth)}  Print the installed kopeng version.`);
  lines.push(`  ${'help'.padEnd(nameWidth)}  Show this message.`);
  return lines.join('\n');
}

export async function dispatch(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.log(usageText());
    return 0;
  }
  if (command === 'version' || command === '--version') {
    io.log(KOPENG_VERSION);
    return 0;
  }

  const spec = resolveCommand(command);
  if (spec) return spec.handler(rest, io);

  if (COMING_SOON_COMMANDS.includes(command)) {
    io.error(
      `'${command}' is coming in a future release of kopeng — not wired yet. ` +
      `This release supports: ${IMPLEMENTED_COMMANDS.map((c) => c.name).join(', ')}, version, help.`
    );
    return 1;
  }

  io.error(`Unknown command: ${command}\n\n${usageText()}`);
  return 2;
}

function isDirectRun(): boolean {
  // Symlink-safe (T72). The obvious argv[1]-vs-import.meta.url comparison
  // reads false through a symlink and this module silently does nothing.
  return isEntrypoint(import.meta.url);
}

if (isDirectRun()) {
  dispatch(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`kopeng CLI failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
