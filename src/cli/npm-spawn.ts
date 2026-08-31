/**
 * Shared win32-safe npm-install spawn machinery (Task 2.5 fix round 1,
 * Finding 1) — extracted from a copy-pasted-twice `realNpmInstall` in
 * init.ts and update.ts so there is exactly ONE implementation, imported by
 * both. History: `kopeng init`'s "Installing KOPENG..." step (and
 * `update`'s equivalent) crashed on every native Windows machine with a bare
 * `spawn EINVAL` — `child_process.spawn('npm.cmd', ...)` cannot execute a
 * batch file directly (Windows `CreateProcess` needs `cmd.exe` to interpret
 * it) — found live via Task 2.5's install-smoke acceptance run. The first
 * fix (`shell: process.platform === 'win32'`) closed that crash but
 * introduced a quieter one: Node's own shell:true handling on Windows just
 * joins `[command, ...args]` with spaces and hands the whole string to
 * `cmd.exe /d /s /c` — it does NOT quote individual arguments itself
 * (documented Node caveat) — so any arg containing a space (a real
 * `C:\Users\John Smith\...` install path, the same space-path lesson this
 * branch's Task 2.3 autostart fix round already learned) silently splits
 * into multiple arguments.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * CommandLineToArgvW-compatible argument quoting (the same algorithm behind
 * Python's `subprocess.list2cmdline`) — needed because Node's shell:true
 * join does none of this itself. A plain argument with no whitespace or
 * shell-special character is returned untouched (the common case: bare
 * subcommand names, unspaced paths); everything else is wrapped in double
 * quotes with backslashes and embedded quotes escaped per the Windows
 * argv-parsing convention:
 *   - a literal `"` is escaped by doubling every backslash immediately
 *     preceding it, plus one more backslash before the quote;
 *   - a run of backslashes at the very END of the argument (immediately
 *     before the closing quote this function appends) must ALSO be
 *     doubled — otherwise the parser reads the closing quote as escaped
 *     data instead of the delimiter, corrupting everything after it once
 *     this argument is joined into the rest of the command line.
 * Fix round 1, Finding 2: the first version of this function only checked
 * for whitespace/special characters and wrapped in quotes — it never
 * doubled a trailing backslash, so a spaced path ending in `\` (a bare
 * drive-relative directory, `C:\Users\John Smith\`) would corrupt the
 * parse. Verified against a REAL cmd.exe round-trip on win32 (see
 * tests/unit/npm-spawn.test.ts).
 */
export function quoteArgForShell(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>%!]/.test(arg)) return arg;

  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Flush any trailing run of backslashes, doubled, before the closing quote.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

export interface NpmSpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Pure: decides the actual command/args/shell spawn() should receive for a
 * given platform. win32 needs `npm.cmd` via `shell: true` (see the file
 * header) with each arg pre-quoted (`quoteArgForShell`). Every other
 * platform runs the real `npm` binary directly with no shell and no
 * quoting — byte-identical (same array reference, not even copied) to the
 * pre-Task-2.5 behavior.
 */
export function planNpmInstallSpawn(args: string[], platform: NodeJS.Platform): NpmSpawnPlan {
  if (platform === 'win32') {
    return { command: 'npm.cmd', args: args.map(quoteArgForShell), shell: true };
  }
  return { command: 'npm', args, shell: false };
}

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Runs npm install through an injected `spawn` (the real `node:child_process`
 * one in production, a fake in tests) and ALWAYS resolves to a
 * `{code, stdout, stderr}` shape — never rejects, never throws — so a
 * caller's own npm-install-failure handling (init's `diagnoseNpmFailure`,
 * update's plain `UpdateError`) always gets a chance to run instead of a
 * raw crash reaching the operator. Closes BOTH failure paths to that same
 * shape: a `spawn()` call that throws SYNCHRONOUSLY (the original win32
 * EINVAL bug, kept closed here so it can never regress silently) and a
 * `spawn()` that returns successfully but the child emits an ASYNC 'error'
 * event (e.g. ENOENT — npm genuinely missing from PATH).
 */
export function runNpmInstall(
  args: string[],
  spawnImpl: SpawnLike,
  platform: NodeJS.Platform = process.platform
): Promise<{ code: number; stdout: string; stderr: string }> {
  const plan = planNpmInstallSpawn(args, platform);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawnImpl(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: plan.shell });
    } catch (err) {
      resolve({ code: 1, stdout, stderr: messageOf(err) });
      return;
    }
    child.stdout!.on('data', (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
