/**
 * User-level login autostart (Task 2.3.2, Install Strategy §4.3) — one of the
 * two mechanisms (the other is `kopeng ensure`, src/cli/ensure.ts) that keep
 * the packaged server alive across reboots with zero admin rights.
 *
 * Plan/apply split, matching the repo's doctor.ts/wire-client.ts idiom:
 *   - planAutostart() is a PURE function of its inputs — no filesystem or
 *     process reads, no side effects — so every platform's exact file
 *     content and commands are fully unit-testable.
 *   - registerAutostart()/unregisterAutostart()/autostartStatus() are thin
 *     executors: they take an injected `AutostartEffects` (spawn + fs) so
 *     tests can drive them with a fake recorder and assert commands/files/
 *     the recorded JSON without ever touching a real scheduler or the real
 *     filesystem. The REAL effects (`realAutostartEffects`, spawnSync + real
 *     fs) are wired only by the CLI dispatch and are never exercised by any
 *     test — registration is verified manually by the operator.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { APP_DIR, ENV_FILE, KOPENG_HOME } from './paths.js';

export type AutostartPlatform = 'win32' | 'linux' | 'darwin';

export type AutostartMechanism =
  | 'win32-schtasks'
  | 'win32-startup-folder'
  | 'linux-systemd-user'
  | 'linux-none'
  | 'darwin-launchagent';

/** Inputs a plan is built from — fully explicit so planAutostart stays pure. */
export interface AutostartOpts {
  /** process.execPath — the node executable to run the server with. */
  nodePath: string;
  /** Installed server entry point: `<app>/node_modules/kopeng/dist/server.js`. */
  serverEntry: string;
  /** `~/.kopeng` (honors KOPENG_HOME) — where the win32 shim files live. */
  kopengHome: string;
  /** The resolved .env (Ruling 7) — passed to the server as KOPENG_ENV_FILE. */
  envFile: string;
  /** The user's real home directory — systemd/launchd paths are always here,
   *  independent of a KOPENG_HOME override (multi-instance setups still share
   *  one login session's autostart). */
  homeDir: string;
  /** win32 only: %APPDATA%, for the Startup-folder fallback. */
  appDataDir: string;
}

export interface AutostartFile {
  path: string;
  content: string;
}

export interface AutostartCommand {
  command: string;
  args: string[];
}

/** A secondary mechanism registerAutostart falls back to when the plan's
 *  primary registerCommands fail (non-zero exit or spawn error). */
export interface AutostartFallback {
  mechanism: AutostartMechanism;
  files: AutostartFile[];
  registerCommands: AutostartCommand[];
  unregisterCommands: AutostartCommand[];
  /** Operator-facing explanation — set when the fallback is informational
   *  only (e.g. no user systemd) rather than a real second mechanism. */
  note?: string;
}

export interface AutostartPlan {
  platform: AutostartPlatform;
  mechanism: AutostartMechanism;
  files: AutostartFile[];
  registerCommands: AutostartCommand[];
  unregisterCommands: AutostartCommand[];
  /** win32 only: the scheduled task name (`autostartStatus` queries it). */
  taskName?: string;
  fallback?: AutostartFallback;
}

const TASK_NAME = 'kopeng-server';

// planAutostart takes a PLATFORM argument that may differ from the host OS
// running the CLI (a Windows plan built on a Linux CI runner, in tests) — so
// every path here uses path.win32/path.posix explicitly rather than the
// ambient path.join, which follows the host OS and would otherwise produce
// wrong separators (and non-deterministic test snapshots across CI runners).
function buildWin32Plan(opts: AutostartOpts): AutostartPlan {
  const win = path.win32;
  const autostartDir = win.join(opts.kopengHome, 'autostart');
  const cmdPath = win.join(autostartDir, 'kopeng-server.cmd');
  const vbsPath = win.join(autostartDir, 'kopeng-server.vbs');

  // vbs cannot set env vars directly, so the shim is two files: a .cmd that
  // sets them and starts node, and a .vbs that runs the .cmd hidden (window
  // style 0) via wscript — which is what schtasks (or the Startup folder)
  // actually launches.
  // A schtasks-launched process's cwd is System32 (a LaunchAgent's is `/`, a
  // systemd --user unit's is $HOME) — none of which is writable/expected for
  // the logger's relative default LOG_PATH, so an autostart-launched server
  // crashes (win32/darwin) or scribbles a stray logs/ under the wrong
  // directory (linux) unless the shim sets its own cwd explicitly.
  const cmdContent =
    '@echo off\r\n' +
    `cd /d "${opts.kopengHome}"\r\n` +
    `set "KOPENG_ENV_FILE=${opts.envFile}"\r\n` +
    `set "KOPENG_HOME=${opts.kopengHome}"\r\n` +
    `"${opts.nodePath}" "${opts.serverEntry}"\r\n`;

  const vbsContent =
    'Set objShell = CreateObject("WScript.Shell")\r\n' +
    `objShell.Run """${cmdPath}""", 0, False\r\n`;

  const startupDir = win.join(opts.appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupVbsPath = win.join(startupDir, 'kopeng-server.vbs');

  return {
    platform: 'win32',
    mechanism: 'win32-schtasks',
    files: [
      { path: cmdPath, content: cmdContent },
      { path: vbsPath, content: vbsContent },
    ],
    registerCommands: [
      // The /TR value is a full command line schtasks parses and stores itself
      // (this process's own argv quoting for the `schtasks` call doesn't help —
      // it only protects the boundary of THIS argument, not the sub-command
      // schtasks will later launch). Without quotes around vbsPath, a space in
      // it (e.g. a "John Smith" home directory) splits into multiple arguments
      // and wscript fails to find the script.
      { command: 'schtasks', args: ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', `wscript.exe //B "${vbsPath}"`] },
    ],
    unregisterCommands: [
      { command: 'schtasks', args: ['/Delete', '/F', '/TN', TASK_NAME] },
    ],
    taskName: TASK_NAME,
    // A crash-looping or missing-permission schtasks leaves the task absent —
    // nothing would ever launch the shim. Copying the SAME .vbs (it still
    // points at the .cmd by absolute path) into the Startup folder is an
    // independent, admin-free trigger for the next login.
    fallback: {
      mechanism: 'win32-startup-folder',
      files: [{ path: startupVbsPath, content: vbsContent }],
      registerCommands: [],
      unregisterCommands: [],
    },
  };
}

function buildLinuxPlan(opts: AutostartOpts): AutostartPlan {
  const unitPath = path.posix.join(opts.homeDir, '.config', 'systemd', 'user', 'kopeng.service');

  const unitContent =
    '[Unit]\n' +
    'Description=KOPENG server (user-level autostart)\n' +
    'After=network.target\n' +
    '\n' +
    '[Service]\n' +
    'Type=simple\n' +
    // systemd word-splits unquoted unit-file values on whitespace — a space in
    // any of these paths would otherwise be read as a second/third ExecStart
    // argument or corrupt the Environment= assignment. Quoting unconditionally
    // is always valid systemd syntax, space or not.
    // WorkingDirectory defaults to $HOME for a --user unit, which is not
    // where the logger's relative default LOG_PATH should land.
    `WorkingDirectory="${opts.kopengHome}"\n` +
    `ExecStart="${opts.nodePath}" "${opts.serverEntry}"\n` +
    `Environment="KOPENG_ENV_FILE=${opts.envFile}"\n` +
    `Environment="KOPENG_HOME=${opts.kopengHome}"\n` +
    'Restart=on-failure\n' +
    '\n' +
    '[Install]\n' +
    'WantedBy=default.target\n';

  return {
    platform: 'linux',
    mechanism: 'linux-systemd-user',
    files: [{ path: unitPath, content: unitContent }],
    registerCommands: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'kopeng'] },
    ],
    unregisterCommands: [
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'kopeng'] },
    ],
    // No user systemd (containers, minimal distros, WSL without it enabled):
    // report the gap and lean on `kopeng ensure` from the SessionStart hook
    // instead of failing the whole registration.
    fallback: {
      mechanism: 'linux-none',
      files: [],
      registerCommands: [],
      unregisterCommands: [],
      note: 'no user systemd — use `kopeng ensure` via the SessionStart hook or cron @reboot',
    },
  };
}

/** XML-escapes text content for a plist `<string>` element. A raw `&`/`<`/`>`
 *  in a path (rare but legal on macOS/Windows filesystems) would otherwise
 *  produce malformed, unparseable XML. */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildDarwinPlan(opts: AutostartOpts): AutostartPlan {
  const plistPath = path.posix.join(opts.homeDir, 'Library', 'LaunchAgents', 'net.kopeng.server.plist');

  const plistContent =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '  <key>Label</key>\n' +
    '  <string>net.kopeng.server</string>\n' +
    '  <key>ProgramArguments</key>\n' +
    '  <array>\n' +
    `    <string>${escapeXml(opts.nodePath)}</string>\n` +
    `    <string>${escapeXml(opts.serverEntry)}</string>\n` +
    '  </array>\n' +
    // launchd defaults a LaunchAgent's cwd to `/`, which is not where the
    // logger's relative default LOG_PATH should land.
    '  <key>WorkingDirectory</key>\n' +
    `  <string>${escapeXml(opts.kopengHome)}</string>\n` +
    '  <key>EnvironmentVariables</key>\n' +
    '  <dict>\n' +
    '    <key>KOPENG_ENV_FILE</key>\n' +
    `    <string>${escapeXml(opts.envFile)}</string>\n` +
    '    <key>KOPENG_HOME</key>\n' +
    `    <string>${escapeXml(opts.kopengHome)}</string>\n` +
    '  </dict>\n' +
    '  <key>RunAtLoad</key>\n' +
    '  <true/>\n' +
    '  <key>KeepAlive</key>\n' +
    '  <false/>\n' +
    '</dict>\n' +
    '</plist>\n';

  return {
    platform: 'darwin',
    mechanism: 'darwin-launchagent',
    files: [{ path: plistPath, content: plistContent }],
    registerCommands: [{ command: 'launchctl', args: ['load', plistPath] }],
    unregisterCommands: [{ command: 'launchctl', args: ['unload', plistPath] }],
  };
}

export function planAutostart(platform: AutostartPlatform, opts: AutostartOpts): AutostartPlan {
  switch (platform) {
    case 'win32': return buildWin32Plan(opts);
    case 'linux': return buildLinuxPlan(opts);
    case 'darwin': return buildDarwinPlan(opts);
  }
}

// ── Executors (plan → real effects) ────────────────────────────────────────

export interface SpawnResult {
  status: number | null;
  error?: Error;
}

export interface AutostartFsEffects {
  writeFile: (filePath: string, content: string) => void;
  readFile: (filePath: string) => string | undefined;
  remove: (filePath: string) => void;
}

export interface AutostartEffects {
  spawn: (command: string, args: string[]) => SpawnResult;
  fs: AutostartFsEffects;
}

export interface AutostartRecord {
  mechanism: AutostartMechanism;
  files: string[];
  taskName?: string;
  unregisterCommands: AutostartCommand[];
  note?: string;
}

export interface AutostartRegisterResult extends AutostartRecord {
  /** true when the primary registerCommands failed and the fallback (if any) was used. */
  usedFallback: boolean;
}

/**
 * Writes the plan's files, runs its registerCommands, and — only if one of
 * those commands fails (non-zero status or a spawn error) — writes/runs the
 * plan's fallback instead. Either way, records exactly what happened to
 * `recordPath` so unregisterAutostart can reverse it later without needing
 * the original plan.
 */
export function registerAutostart(plan: AutostartPlan, effects: AutostartEffects, recordPath: string): AutostartRegisterResult {
  for (const file of plan.files) effects.fs.writeFile(file.path, file.content);

  let commandsFailed = false;
  for (const cmd of plan.registerCommands) {
    const result = effects.spawn(cmd.command, cmd.args);
    if (result.error || result.status !== 0) { commandsFailed = true; break; }
  }

  let record: AutostartRecord;
  const usedFallback = commandsFailed && plan.fallback !== undefined;
  if (usedFallback) {
    const fallback = plan.fallback!;
    for (const file of fallback.files) effects.fs.writeFile(file.path, file.content);
    for (const cmd of fallback.registerCommands) effects.spawn(cmd.command, cmd.args);
    record = {
      mechanism: fallback.mechanism,
      files: [...plan.files.map((f) => f.path), ...fallback.files.map((f) => f.path)],
      unregisterCommands: fallback.unregisterCommands,
      note: fallback.note,
    };
  } else {
    record = {
      mechanism: plan.mechanism,
      files: plan.files.map((f) => f.path),
      taskName: plan.taskName,
      unregisterCommands: plan.unregisterCommands,
      // Best-effort platforms (darwin/linux primary success path) with no
      // fallback still record the primary mechanism even if a command failed
      // — the written file (unit/plist) is the actual persistent mechanism
      // there, so a transient `launchctl`/`systemctl` failure isn't fatal.
      note: commandsFailed ? 'a registration command failed; files were written but activation may need a manual retry' : undefined,
    };
  }

  effects.fs.writeFile(recordPath, JSON.stringify(record, null, 2));
  return { ...record, usedFallback };
}

export interface UnregisterAutostartResult {
  reversed: boolean;
  /** Task 2.4 fix round 1 (Finding 6a): true when a record file existed but
   *  was corrupt JSON — there is nothing in it to tell us what to reverse,
   *  but the record itself is best-effort removed anyway rather than left
   *  on disk forever un-actionable. */
  malformed?: boolean;
  /** Entries the record asked for that the allowlist below refused — one
   *  human-readable line each. Reported, never silently dropped: an
   *  uninstall that leaves something behind has to say so. */
  refused?: string[];
}

// ── Untrusted-record guard (fix round 2, Finding 2) ────────────────────────
//
// unregisterAutostart used to run every `unregisterCommands[]` entry and
// rmSync every `files[]` entry VERBATIM out of ~/.kopeng/autostart.json — an
// unvalidated exec/delete primitive lying dormant until the operator runs a
// routine, trusted-looking `kopeng uninstall`. The record is now treated as
// untrusted input: only the three schedulers planAutostart actually drives
// may be spawned, and only files under the four directories planAutostart can
// actually produce may be removed.

/** The only commands any plan's unregisterCommands can contain (buildWin32Plan
 *  / buildLinuxPlan / buildDarwinPlan above) — nothing else is ever legitimate. */
export const AUTOSTART_ALLOWED_COMMANDS = ['schtasks', 'systemctl', 'launchctl'] as const;

export function isAllowedUnregisterCommand(command: string): boolean {
  return (AUTOSTART_ALLOWED_COMMANDS as readonly string[]).includes(command);
}

/**
 * Normalizes a path for containment comparison WITHOUT using the host's
 * `path` module — same reason planAutostart uses path.win32/path.posix
 * explicitly: a win32 record must still be checkable on a linux CI runner,
 * and a linux one on Windows. Both separators fold to `/`, and `.`/`..`
 * segments are resolved away, so a `..` in a tampered record cannot escape
 * the root it is compared against.
 *
 * Comparison is case-insensitive. That is a deliberate widening: the roots
 * are the operator's own home/install directories on filesystems that are
 * themselves usually case-insensitive (NTFS, APFS), and a legitimate
 * uninstall silently refusing to clean up over a casing difference is the
 * worse failure of the two.
 */
export function normalizeAutostartPath(filePath: string): string {
  const absolute = /^[/\\]/.test(filePath);
  const segments: string[] = [];
  for (const segment of filePath.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment);
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`.toLowerCase();
}

/** True when `filePath` is inside (or is) one of `roots`, after normalization. */
export function isRemovableAutostartFile(filePath: string, roots: readonly string[]): boolean {
  const target = normalizeAutostartPath(filePath);
  return roots.some((root) => {
    const normalizedRoot = normalizeAutostartPath(root);
    if (normalizedRoot === '' || normalizedRoot === '/') return false; // never allow "everything"
    return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
  });
}

export interface UnregisterAutostartOptions {
  /** The only directories a recorded file may live under. Defaults to the
   *  four locations planAutostart can produce (see defaultAutostartRoots). */
  allowedRoots?: string[];
}

/** The four directories planAutostart writes into: the install root (the win32
 *  shim pair), the Startup folder, the systemd --user unit dir, and
 *  LaunchAgents. `kopengHome` comes from the record file's own location —
 *  uninstall always reads `<kopengHome>/autostart.json`. */
export function defaultAutostartRoots(recordPath: string, homeDir: string, appDataDir: string): string[] {
  return [
    path.dirname(recordPath),
    path.join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    path.join(homeDir, '.config', 'systemd', 'user'),
    path.join(homeDir, 'Library', 'LaunchAgents'),
  ];
}

/** Reads recordPath and reverses exactly what it recorded — minus anything the
 *  allowlist above refuses (reported via `refused`, never silently skipped). A
 *  missing record is a no-op — nothing to reverse, not an error. A malformed
 *  one can't say what to reverse, but its own file is still cleaned up (see
 *  `malformed`). */
export function unregisterAutostart(
  effects: AutostartEffects,
  recordPath: string,
  options: UnregisterAutostartOptions = {}
): UnregisterAutostartResult {
  const raw = effects.fs.readFile(recordPath);
  if (!raw) return { reversed: false };

  let record: AutostartRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    effects.fs.remove(recordPath);
    return { reversed: false, malformed: true };
  }

  const allowedRoots = options.allowedRoots ?? defaultAutostartRoots(
    recordPath,
    os.homedir(),
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  );
  const refused: string[] = [];

  for (const cmd of record.unregisterCommands ?? []) {
    if (!isAllowedUnregisterCommand(cmd.command)) {
      refused.push(
        `refused to run the recorded command "${cmd.command}" — only ` +
        `${AUTOSTART_ALLOWED_COMMANDS.join('/')} are ever registered by KOPENG`
      );
      continue;
    }
    effects.spawn(cmd.command, cmd.args);
  }
  for (const filePath of record.files ?? []) {
    if (!isRemovableAutostartFile(filePath, allowedRoots)) {
      refused.push(
        `refused to delete the recorded file "${filePath}" — it is outside the KOPENG install ` +
        'and the OS autostart directories'
      );
      continue;
    }
    effects.fs.remove(filePath);
  }
  // The record itself always goes: it lives at the install root by
  // construction, and leaving a record we have just decided not to trust is
  // strictly worse than removing it and naming what we refused.
  effects.fs.remove(recordPath);
  return refused.length > 0 ? { reversed: true, refused } : { reversed: true };
}

export interface AutostartStatus {
  registered: boolean;
  record: AutostartRecord | null;
  /** win32 only: `schtasks /Query /TN <task>` exit status. */
  schtasksQueryStatus?: number | null;
}

/** Best-effort status read: the record file, plus (win32) a live schtasks query. */
export function autostartStatus(effects: AutostartEffects, recordPath: string): AutostartStatus {
  const raw = effects.fs.readFile(recordPath);
  let record: AutostartRecord | null = null;
  if (raw) {
    try {
      record = JSON.parse(raw);
    } catch {
      record = null;
    }
  }

  const status: AutostartStatus = { registered: record !== null, record };
  if (record?.mechanism === 'win32-schtasks' && record.taskName) {
    status.schtasksQueryStatus = effects.spawn('schtasks', ['/Query', '/TN', record.taskName]).status;
  }
  return status;
}

// ── Real wiring (never invoked by tests) ────────────────────────────────────

export const AUTOSTART_RECORD_FILE = path.join(KOPENG_HOME, 'autostart.json');

export const realAutostartEffects: AutostartEffects = {
  spawn: (command, args) => {
    const result = spawnSync(command, args, { windowsHide: true });
    return { status: result.status, error: result.error };
  },
  fs: {
    writeFile: (filePath, content) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    },
    readFile: (filePath) => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        return undefined;
      }
    },
    remove: (filePath) => {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* best-effort */
      }
    },
  },
};

/** Real-environment opts for the CLI's `autostart register` invocation. */
export function currentAutostartOpts(): AutostartOpts {
  return {
    nodePath: process.execPath,
    serverEntry: path.join(APP_DIR, 'node_modules', 'kopeng', 'dist', 'server.js'),
    kopengHome: KOPENG_HOME,
    envFile: ENV_FILE,
    homeDir: os.homedir(),
    appDataDir: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  };
}
