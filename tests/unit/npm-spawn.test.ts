import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

import { quoteArgForShell, planNpmInstallSpawn, runNpmInstall } from '../../src/cli/npm-spawn.js';
import { fakeChildProcess } from '../fixtures/fake-child-process.js';

// Task 2.5 fix round 1 — the win32 npm.cmd fix needs its own arg quoting.
// Node's shell:true on Windows just joins [command, ...args] with spaces
// and hands the string to cmd.exe, with NO quoting of individual args, so a
// spaced path (a real "C:\Users\John Smith\..." home directory — the same
// space-path lesson this branch's Task 2.3 autostart fix round already
// learned) would silently split into multiple arguments. This is the
// canonical test suite for the shared src/cli/npm-spawn.ts module — both
// init.ts and update.ts import it rather than each carrying (and drifting)
// their own copy.

describe('quoteArgForShell', () => {
  it('leaves a plain arg with no special characters untouched', () => {
    expect(quoteArgForShell('install')).toBe('install');
    expect(quoteArgForShell('/home/user/.kopeng/app')).toBe('/home/user/.kopeng/app');
    expect(quoteArgForShell('kopeng@1.2.3')).toBe('kopeng@1.2.3');
  });

  it('leaves a plain Windows path with backslashes but NO spaces untouched', () => {
    // A bare backslash is not itself shell-special — quoting every path
    // just because it uses Windows path separators would be wrong.
    expect(quoteArgForShell('C:\\Users\\app\\node_modules\\kopeng')).toBe('C:\\Users\\app\\node_modules\\kopeng');
  });

  it('quotes an arg containing a space', () => {
    expect(quoteArgForShell('C:\\Users\\John Smith\\.kopeng\\app')).toBe('"C:\\Users\\John Smith\\.kopeng\\app"');
  });

  it('escapes an embedded double quote with a single preceding backslash (CommandLineToArgvW convention, not cmd.exe\'s doubled-quote dialect)', () => {
    expect(quoteArgForShell('has "quotes" inside')).toBe('"has \\"quotes\\" inside"');
  });

  it('quotes other cmd.exe-special characters even without whitespace', () => {
    expect(quoteArgForShell('a&b')).toBe('"a&b"');
    expect(quoteArgForShell('a|b')).toBe('"a|b"');
    expect(quoteArgForShell('a^b')).toBe('"a^b"');
  });

  it('quotes an empty string (would otherwise vanish from the joined command line)', () => {
    expect(quoteArgForShell('')).toBe('""');
  });

  // Fix round 1, Finding 2: backslashes immediately preceding the closing
  // quote must be DOUBLED (CommandLineToArgvW convention) or the quote is
  // consumed as data instead of closing the argument, corrupting the parse
  // of everything after it.
  describe('trailing-backslash doubling (Finding 2)', () => {
    it('doubles a single trailing backslash before the closing quote', () => {
      expect(quoteArgForShell('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
    });

    it('doubles two trailing backslashes to four before the closing quote', () => {
      expect(quoteArgForShell('C:\\x y\\\\')).toBe('"C:\\x y\\\\\\\\"');
    });

    it('handles an embedded backslash-quote mid-string (not just at the end)', () => {
      // Input contains: foo \" bar  (one backslash immediately followed by
      // a literal double-quote character). Per the convention, that single
      // backslash must be doubled (2) plus one more backslash to escape the
      // quote itself (3 backslashes total), then the literal quote.
      expect(quoteArgForShell('foo\\"bar')).toBe('"foo\\\\\\"bar"');
    });

    it('plain args with an interior (non-trailing) single backslash before a normal char are unaffected by doubling', () => {
      // The space forces quoting, but the interior "\p" backslash (followed
      // by a normal character, not a quote or end-of-string) stays single —
      // only trailing runs and quote-adjacent runs get doubled.
      expect(quoteArgForShell('C:\\path with space')).toBe('"C:\\path with space"');
    });
  });
});

describe('planNpmInstallSpawn', () => {
  const args = ['install', '--prefix', 'C:\\Users\\John Smith\\.kopeng\\app', 'kopeng@1.2.3'];

  it('on win32: npm.cmd via shell:true, with every arg pre-quoted', () => {
    const plan = planNpmInstallSpawn(args, 'win32');
    expect(plan.command).toBe('npm.cmd');
    expect(plan.shell).toBe(true);
    expect(plan.args).toEqual(['install', '--prefix', '"C:\\Users\\John Smith\\.kopeng\\app"', 'kopeng@1.2.3']);
  });

  it('on linux/darwin: the real npm binary, no shell, args byte-identical (untouched, not even copied)', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const plan = planNpmInstallSpawn(args, platform);
      expect(plan.command).toBe('npm');
      expect(plan.shell).toBe(false);
      expect(plan.args).toBe(args);
    }
  });

  it('on win32 with an UN-spaced args array (the install-smoke sandbox\'s own shape), output values are unchanged by quoting', () => {
    // Pins that the shared-module extraction + Finding 2's quoting rework
    // changed nothing for the common case: a normal Windows path with no
    // spaces (exactly what the local install-smoke acceptance run exercises
    // on this machine) round-trips through planNpmInstallSpawn untouched.
    const unspacedArgs = ['install', '--prefix', 'C:\\Users\\app\\.kopeng\\app', 'kopeng@1.2.3'];
    const plan = planNpmInstallSpawn(unspacedArgs, 'win32');
    expect(plan.command).toBe('npm.cmd');
    expect(plan.shell).toBe(true);
    expect(plan.args).toEqual(unspacedArgs);
  });
});

describe('runNpmInstall', () => {
  it('resolves {code:1,...} when spawn() throws SYNCHRONOUSLY (the win32 EINVAL case) — never rejects', async () => {
    const spawnImpl = vi.fn(() => { throw new Error('spawn EINVAL'); });
    const result = await runNpmInstall(['install'], spawnImpl, 'win32');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('spawn EINVAL');
  });

  it('resolves {code:1,...} when the child emits an async "error" event (e.g. ENOENT)', async () => {
    const { child, emitError } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runNpmInstall(['install'], spawnImpl, 'linux');
    emitError(new Error('spawn npm ENOENT'));
    const result = await promise;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('spawn npm ENOENT');
  });

  it('passes through stdout/stderr/code on a normal completion', async () => {
    const { child, emitStdout, emitStderr, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runNpmInstall(['install'], spawnImpl, 'linux');
    emitStdout('added 42 packages\n');
    emitStderr('npm warn deprecated foo\n');
    emitClose(0);
    const result = await promise;
    expect(result).toEqual({ code: 0, stdout: 'added 42 packages\n', stderr: 'npm warn deprecated foo\n' });
  });

  it('a non-zero close code without an error event still surfaces as {code, stdout, stderr}', async () => {
    const { child, emitStderr, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runNpmInstall(['install'], spawnImpl, 'linux');
    emitStderr('gyp ERR! build error\n');
    emitClose(1);
    const result = await promise;
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'gyp ERR! build error\n' });
  });

  it('quotes a spaced --prefix/tarball path before handing args to spawn on win32', async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runNpmInstall(
      ['install', '--prefix', 'C:\\Users\\John Smith\\.kopeng\\app', 'C:\\Users\\John Smith\\kopeng-1.2.3.tgz'],
      spawnImpl,
      'win32'
    );
    emitClose(0);
    await promise;
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm.cmd',
      ['install', '--prefix', '"C:\\Users\\John Smith\\.kopeng\\app"', '"C:\\Users\\John Smith\\kopeng-1.2.3.tgz"'],
      expect.objectContaining({ shell: true })
    );
  });

  it('passes args through byte-identical on non-win32, with no shell', async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const args = ['install', '--prefix', '/home/user/.kopeng/app', 'kopeng@1.2.3'];
    const promise = runNpmInstall(args, spawnImpl, 'linux');
    emitClose(0);
    await promise;
    expect(spawnImpl).toHaveBeenCalledWith('npm', args, expect.objectContaining({ shell: false }));
  });

  it('defaults platform to process.platform when not given', async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runNpmInstall(['install'], spawnImpl);
    emitClose(0);
    await promise;
    expect(spawnImpl.mock.calls[0][0]).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  });
});

// Fix round 1, Finding 3(b): a cheap, real cmd.exe round-trip — everything
// above tests our OWN understanding of the CommandLineToArgvW convention;
// this proves quoteArgForShell's output actually survives a REAL Windows
// command-line parse, using the exact spawn shape (shell:true, an args
// array) production code uses, substituting a tiny throwaway `node -e`
// probe for npm. Skip-free on win32; skipped everywhere else (the
// convention this function implements is Windows-only, and cmd.exe simply
// doesn't exist elsewhere to round-trip against).
describe('quoteArgForShell — real cmd.exe round-trip (win32 only)', () => {
  // process.execPath is itself commonly spaced ("C:\Program Files\nodejs\
  // node.exe") — it needs the SAME quoting treatment as any other arg when
  // handed to spawnSync's shell:true join, or the probe itself would fail
  // for the wrong reason (this bit the first draft of this test: it failed
  // with "'C:\Program' is not recognized..." before this line was added).
  const probeCommand = quoteArgForShell(process.execPath);
  // `node -e "<script>" <extra args>` has NO script-path slot in argv — the
  // first extra argument lands at argv[1], not argv[2] (verified live).
  const probeScript = 'console.log(process.argv[1])';

  function roundTrip(original: string): string {
    const quoted = quoteArgForShell(original);
    const result = spawnSync(probeCommand, ['-e', probeScript, quoted], {
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  it.skipIf(process.platform !== 'win32')('a spaced path survives a real cmd.exe argv parse unchanged', () => {
    const original = 'C:\\Users\\John Smith\\kopeng test\\app';
    expect(roundTrip(original)).toBe(original);
  });

  it.skipIf(process.platform !== 'win32')('a path with a trailing backslash survives a real cmd.exe argv parse unchanged', () => {
    const original = 'C:\\Users\\John Smith\\.kopeng\\app\\';
    expect(roundTrip(original)).toBe(original);
  });
});
