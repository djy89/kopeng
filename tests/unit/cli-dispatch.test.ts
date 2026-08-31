import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMING_SOON_COMMANDS,
  IMPLEMENTED_COMMANDS,
  dispatch,
  resolveCommand,
  runAutostart,
  runCanary,
  runDoctor,
  runEnsureCommand,
  runInit,
  runMcp,
  runMigrateAnchors,
  runStart,
  runUninstall,
  runUpdate,
  runViz,
  runWire,
  usageText,
  type CliIo,
} from '../../src/cli/index.js';

// Task 2.1.2 — dispatch resolution is pure: these tests check the
// command->handler MAPPING and the no-op exit paths (unknown, not-yet-
// implemented, help, version). They deliberately never invoke the real
// wire/doctor/canary/mcp/start handlers, which spawn child processes —
// those are exercised by their own suites (wire-client.test.ts,
// doctor.test.ts, the recall-canary integration suite) and by the tarball
// smoke, not here.

function fakeIo(): { io: CliIo; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (l) => logs.push(l), error: (l) => errors.push(l) }, logs, errors };
}

describe('resolveCommand', () => {
  it('maps each implemented command name to its own handler', () => {
    expect(resolveCommand('wire')?.handler).toBe(runWire);
    expect(resolveCommand('doctor')?.handler).toBe(runDoctor);
    expect(resolveCommand('canary')?.handler).toBe(runCanary);
    expect(resolveCommand('mcp')?.handler).toBe(runMcp);
    expect(resolveCommand('start')?.handler).toBe(runStart);
    expect(resolveCommand('autostart')?.handler).toBe(runAutostart);
    expect(resolveCommand('ensure')?.handler).toBe(runEnsureCommand);
    expect(resolveCommand('init')?.handler).toBe(runInit);
    expect(resolveCommand('uninstall')?.handler).toBe(runUninstall);
    expect(resolveCommand('update')?.handler).toBe(runUpdate);
    expect(resolveCommand('viz')?.handler).toBe(runViz);
    expect(resolveCommand('migrate-anchors')?.handler).toBe(runMigrateAnchors);
  });

  it('returns undefined for a coming-soon or unknown command', () => {
    for (const name of COMING_SOON_COMMANDS) expect(resolveCommand(name)).toBeUndefined();
    expect(resolveCommand('bogus')).toBeUndefined();
  });

  it('lists exactly the commands wired so far (Task 2.1.2 + 2.3.2 autostart + 2.3.3 ensure + 2.2 init + 2.4 uninstall/update + 2.6 viz + migrate-anchors)', () => {
    expect(IMPLEMENTED_COMMANDS.map((c) => c.name).sort()).toEqual(
      ['autostart', 'canary', 'doctor', 'ensure', 'init', 'mcp', 'migrate-anchors', 'start', 'uninstall', 'update', 'viz', 'wire'].sort()
    );
  });

  it('has no coming-soon commands left — Task 2.6 wires the last one named in the Install Strategy roadmap', () => {
    expect(COMING_SOON_COMMANDS).toEqual([]);
  });
});

describe('runAutostart', () => {
  function fakeIo(): { io: CliIo; logs: string[]; errors: string[] } {
    const logs: string[] = [];
    const errors: string[] = [];
    return { io: { log: (l) => logs.push(l), error: (l) => errors.push(l) }, logs, errors };
  }

  it('exits 2 with usage for a missing/unknown subcommand', async () => {
    const { io, errors } = fakeIo();
    const code = await runAutostart([], io);
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('kopeng autostart <status|register|unregister>');
  });

  it('exits 2 with usage for a bogus subcommand', async () => {
    const { io, errors } = fakeIo();
    const code = await runAutostart(['bogus'], io);
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('Usage: kopeng autostart');
  });

  // register/status against the REAL scheduler are deliberately not exercised
  // here — src/cli/autostart.ts's own suite covers that logic fully via a
  // faked executor. This suite pins dispatch's routing, its unknown-subcommand
  // behavior, and (below) how it REPORTS what unregisterAutostart hands back.
});

// `unregisterAutostart`'s untrusted-record guard can refuse entries (a command
// outside the schtasks/systemctl/launchctl allowlist, a file outside the four
// roots planAutostart can produce), and a corrupt record is unreversible.
// Either way something is still on the machine. `runAutostart` used to print
// only `reversed` and return 0, so `kopeng autostart unregister` reported
// clean while a scheduled task survived — the exact shape `runUninstall`
// already guards against. These pin that it no longer can.
//
// The real autostart module is mocked and re-imported in isolation (same
// pattern as the poisoned-env block below) so this never touches the OS
// scheduler and never leaks a mock into the other suites in this file.
describe('runAutostart unregister: refusals and corrupt records are reported, not dropped', () => {
  afterEach(() => {
    vi.doUnmock('../../src/cli/autostart.js');
    vi.resetModules();
  });

  async function withUnregisterResult(result: Record<string, unknown>) {
    vi.resetModules();
    const actual = await vi.importActual<typeof import('../../src/cli/autostart.js')>('../../src/cli/autostart.js');
    vi.doMock('../../src/cli/autostart.js', () => ({ ...actual, unregisterAutostart: () => result }));
    return await import('../../src/cli/index.js');
  }

  it('exits 0 and says so when nothing was refused', async () => {
    const fresh = await withUnregisterResult({ reversed: true });
    const { io, logs, errors } = fakeIo();
    expect(await fresh.runAutostart(['unregister'], io)).toBe(0);
    expect(logs.join('\n')).toContain('Autostart entry removed.');
    expect(errors).toEqual([]);
  });

  it('exits 1 and NAMES every refused entry (was: silently dropped, exit 0)', async () => {
    const fresh = await withUnregisterResult({
      reversed: true,
      refused: ['refused command "curl" (not schtasks/systemctl/launchctl)', 'refused file "/etc/rc.local" (outside the plan roots)'],
    });
    const { io, errors } = fakeIo();
    expect(await fresh.runAutostart(['unregister'], io)).toBe(1);
    const text = errors.join('\n');
    expect(text).toContain('refused command "curl"');
    expect(text).toContain('refused file "/etc/rc.local"');
    expect(text).toContain('Left behind: 2 autostart entries');
  });

  it('exits 1 on a malformed record instead of claiming the entry was removed', async () => {
    const fresh = await withUnregisterResult({ reversed: false, malformed: true });
    const { io, logs, errors } = fakeIo();
    expect(await fresh.runAutostart(['unregister'], io)).toBe(1);
    expect(errors.join('\n')).toContain('malformed autostart record');
    expect(logs.join('\n')).not.toContain('Autostart entry removed.');
  });
});

describe('dispatch', () => {
  it('prints usage and exits 0 for no arguments', async () => {
    const { io, logs } = fakeIo();
    const code = await dispatch([], io);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Usage: kopeng');
  });

  it('prints usage and exits 0 for help / --help / -h', async () => {
    for (const arg of ['help', '--help', '-h']) {
      const { io, logs } = fakeIo();
      const code = await dispatch([arg], io);
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('Usage: kopeng');
    }
  });

  it('prints a semver-looking version and exits 0 for version / --version', async () => {
    for (const arg of ['version', '--version']) {
      const { io, logs } = fakeIo();
      const code = await dispatch([arg], io);
      expect(code).toBe(0);
      expect(logs.join('\n')).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  // Vacuous while COMING_SOON_COMMANDS is empty (Task 2.6 wired the last
  // roadmap command) — kept so it re-activates automatically the moment a
  // future command is added to the list ahead of being wired.
  it('exits 1 with a clear message naming the command for every not-yet-implemented subcommand', async () => {
    for (const name of COMING_SOON_COMMANDS) {
      const { io, errors } = fakeIo();
      const code = await dispatch([name], io);
      expect(code).toBe(1);
      const message = errors.join('\n');
      expect(message).toContain(name);
      expect(message.toLowerCase()).toContain('coming');
    }
  });

  it('exits 2 with usage for an unrecognized command', async () => {
    const { io, errors } = fakeIo();
    const code = await dispatch(['bogus'], io);
    expect(code).toBe(2);
    const message = errors.join('\n');
    expect(message).toContain('Unknown command');
    expect(message).toContain('Usage: kopeng');
  });
});

// Review finding 6: `ensure.js` (imported statically by cli/index.ts before
// this fix) drags in ../config/config.js, which eagerly VALIDATES every env
// var at module-load time and THROWS on a malformed one — e.g. a negative
// ACCESS_LOG_RETENTION_DAYS. A static top-level import made that throw
// happen the moment cli/index.ts's module graph was evaluated, crashing
// EVERY command (including help/version, which have nothing to do with
// ensure) on a poisoned launch environment. The fix moved the ensure.js
// import to inside runEnsureCommand (dynamic, evaluated only when the
// `ensure` subcommand actually runs).
describe('CLI robustness: a poisoned launch env never breaks unrelated commands (review finding 6)', () => {
  const ORIGINAL = process.env.ACCESS_LOG_RETENTION_DAYS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ACCESS_LOG_RETENTION_DAYS;
    else process.env.ACCESS_LOG_RETENTION_DAYS = ORIGINAL;
    vi.resetModules();
  });

  it('help and version still succeed when the module graph loads under a poisoned env', async () => {
    process.env.ACCESS_LOG_RETENTION_DAYS = '-1'; // config.ts throws: "must be >= 0"
    vi.resetModules();
    // A FRESH import, evaluated WITH the poisoned env already present — this
    // is what actually reproduces the regression (a static import crashing
    // at module-load time, before dispatch() ever runs). A stale cached
    // module from before the poisoning would prove nothing.
    const fresh = await import('../../src/cli/index.js');

    const { io: helpIo, logs: helpLogs } = fakeIo();
    expect(await fresh.dispatch(['help'], helpIo)).toBe(0);
    expect(helpLogs.join('\n')).toContain('Usage: kopeng');

    const { io: versionIo, logs: versionLogs } = fakeIo();
    expect(await fresh.dispatch(['version'], versionIo)).toBe(0);
    expect(versionLogs.join('\n')).toMatch(/\d+\.\d+\.\d+/);
  });

  it('doctor, autostart, ensure, init, uninstall, and update dispatch resolution is also unaffected (their imports never touch config.ts eagerly)', async () => {
    process.env.ACCESS_LOG_RETENTION_DAYS = '-1';
    vi.resetModules();
    const fresh = await import('../../src/cli/index.js');
    expect(fresh.resolveCommand('doctor')).toBeDefined();
    expect(fresh.resolveCommand('autostart')).toBeDefined();
    expect(fresh.resolveCommand('ensure')).toBeDefined();
    expect(fresh.resolveCommand('init')).toBeDefined();
    expect(fresh.resolveCommand('uninstall')).toBeDefined();
    expect(fresh.resolveCommand('update')).toBeDefined();
  });
});

describe('usageText', () => {
  it('lists every implemented subcommand and every coming-soon subcommand', () => {
    const text = usageText();
    for (const spec of IMPLEMENTED_COMMANDS) expect(text).toContain(spec.name);
    for (const name of COMING_SOON_COMMANDS) expect(text).toContain(name);
    // Task 2.6 wired the last roadmap command (viz), so COMING_SOON_COMMANDS
    // is empty and usageText's "(coming in this release)" line has nothing
    // left to render — this only re-appears if a future command is added
    // to COMING_SOON_COMMANDS before it's wired.
    if (COMING_SOON_COMMANDS.length > 0) {
      expect(text.toLowerCase()).toContain('coming in this release');
    }
  });
});
