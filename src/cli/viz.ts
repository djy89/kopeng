/**
 * `kopeng viz` (Task 2.6.1) — foreground launcher for the bundled web
 * dashboard (`scripts/viz-server.js`). Unlike wire/doctor/canary/mcp/start
 * (index.ts's `spawnSibling`, which spawn a COMPILED dist/ sibling of THIS
 * file), viz-server.js is a plain, uncompiled Node script shipped as-is from
 * the package root (see package.json's `files` list: `scripts/viz-server.js`
 * + the whole `viz/` static-asset directory) — so the spawn target is
 * resolved relative to the installed package ROOT, not to dist/cli.
 *
 * viz is attended, not a service: stdio is inherited and the process runs in
 * the foreground until Ctrl-C. viz-server.js resolves its own `viz/` static
 * root and `.env` (for the admin key it injects into proxied requests)
 * relative to ITS OWN file location (`import.meta.url`), not to cwd — so
 * `cwd` here is not load-bearing for the script's own behavior, but is still
 * set to the package root (rather than left as whatever directory `kopeng`
 * was invoked from) for a predictable, debuggable child process.
 *
 * Port: viz-server.js reads `process.env.VIZ_PORT`, defaulting to 8780
 * (`const PORT = parseInt(process.env.VIZ_PORT || '8780', 10);`) — and, with
 * stdio inherited and no `env` override, a child spawned from a normal shell
 * would inherit any `VIZ_PORT` already exported there for free. The only new
 * surface this file adds is an explicit `--port <n>` CLI flag, translated to
 * `VIZ_PORT` for the child; viz-server.js itself gains no new flag or env
 * var (brief 2.6.1: "do not add new features to viz-server.js").
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { CliIo, CommandHandler } from './index.js';

export class VizError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** viz-server.js's own default — verified against scripts/viz-server.js, not guessed. */
export const VIZ_DEFAULT_PORT = 8780;

const VIZ_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** dist/cli -> dist -> package root (same arithmetic as index.ts's spawnSibling '../'s). */
export const VIZ_PACKAGE_ROOT = path.resolve(VIZ_FILE_DIR, '..', '..');

/**
 * Pure: an explicit `--port <n>` wins, then an already-set `VIZ_PORT` in the
 * environment, then viz-server.js's own default. Throws `VizError` on a bad
 * flag or an unrecognized argument — mirrors init.ts's `parseInitArgs`
 * strictness so a typo fails loudly instead of silently launching on the
 * wrong port.
 */
export function resolveVizPort(args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      const raw = args[++i];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new VizError(`--port requires a valid port number (got ${raw ?? '<nothing>'}).`);
      }
      port = n;
    } else {
      throw new VizError(`Unknown argument: ${arg}`);
    }
  }
  if (port !== undefined) return port;
  const envPort = env.VIZ_PORT !== undefined ? Number(env.VIZ_PORT) : NaN;
  return Number.isInteger(envPort) && envPort > 0 ? envPort : VIZ_DEFAULT_PORT;
}

export interface VizSpawnPlan {
  command: string;
  args: string[];
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv };
}

/** Pure: the exact spawn() call `kopeng viz` makes, for unit testing without a real child process. */
export function planVizSpawn(packageRoot: string, port: number, env: NodeJS.ProcessEnv = process.env): VizSpawnPlan {
  return {
    command: process.execPath,
    args: [path.join(packageRoot, 'scripts', 'viz-server.js')],
    options: {
      cwd: packageRoot,
      stdio: 'inherit',
      env: { ...env, VIZ_PORT: String(port) },
    },
  };
}

export type VizSpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Injectable core — tests pass a fake `spawnImpl`; `runViz` below wires the real one. */
export function runVizCommand(
  args: string[],
  io: CliIo,
  spawnImpl: VizSpawnLike,
  packageRoot: string = VIZ_PACKAGE_ROOT,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let port: number;
  try {
    port = resolveVizPort(args, env);
  } catch (err) {
    io.error(messageOf(err));
    return Promise.resolve(1);
  }

  const plan = planVizSpawn(packageRoot, port, env);
  io.log(`Watch your memory think: http://localhost:${port}`);

  return new Promise((resolve, reject) => {
    const child = spawnImpl(plan.command, plan.args, plan.options);
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export const runViz: CommandHandler = (args, io) => runVizCommand(args, io, spawn);
