import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  VIZ_DEFAULT_PORT,
  VIZ_PACKAGE_ROOT,
  VizError,
  planVizSpawn,
  resolveVizPort,
  runVizCommand,
} from '../../src/cli/viz.js';
import { fakeChildProcess } from '../fixtures/fake-child-process.js';

function fakeIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (l: string) => logs.push(l), error: (l: string) => errors.push(l) }, logs, errors };
}

// Task 2.6.1 — verified against scripts/viz-server.js: `const PORT =
// parseInt(process.env.VIZ_PORT || '8780', 10);`. Do not change this without
// re-reading that file — the whole point of this pin is that the CLI's
// printed URL and spawn env can never silently drift from the real default.
describe('VIZ_DEFAULT_PORT', () => {
  it('matches scripts/viz-server.js\'s real default (8780)', () => {
    expect(VIZ_DEFAULT_PORT).toBe(8780);
  });
});

describe('resolveVizPort', () => {
  it('defaults to 8780 with no --port and no VIZ_PORT env', () => {
    expect(resolveVizPort([], {})).toBe(VIZ_DEFAULT_PORT);
  });

  it('honors an already-set VIZ_PORT in the environment', () => {
    expect(resolveVizPort([], { VIZ_PORT: '9100' })).toBe(9100);
  });

  it('an explicit --port wins over the environment', () => {
    expect(resolveVizPort(['--port', '9200'], { VIZ_PORT: '9100' })).toBe(9200);
  });

  it('throws VizError on a non-numeric --port', () => {
    expect(() => resolveVizPort(['--port', 'nope'], {})).toThrow(VizError);
  });

  it('throws VizError on an out-of-range --port', () => {
    expect(() => resolveVizPort(['--port', '0'], {})).toThrow(VizError);
    expect(() => resolveVizPort(['--port', '70000'], {})).toThrow(VizError);
  });

  it('throws VizError when --port has no value', () => {
    expect(() => resolveVizPort(['--port'], {})).toThrow(VizError);
  });

  it('throws VizError on an unrecognized argument', () => {
    expect(() => resolveVizPort(['--bogus'], {})).toThrow(VizError);
  });

  it('falls back to the default when VIZ_PORT is present but garbage', () => {
    expect(resolveVizPort([], { VIZ_PORT: 'nope' })).toBe(VIZ_DEFAULT_PORT);
  });
});

describe('planVizSpawn', () => {
  it('spawns node against scripts/viz-server.js under the package root, cwd = package root, stdio inherited', () => {
    const plan = planVizSpawn('/opt/kopeng', 8780, {});
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toEqual([path.join('/opt/kopeng', 'scripts', 'viz-server.js')]);
    expect(plan.options.cwd).toBe('/opt/kopeng');
    expect(plan.options.stdio).toBe('inherit');
  });

  it('sets VIZ_PORT in the child env to the resolved port, preserving the rest of the environment', () => {
    const plan = planVizSpawn('/opt/kopeng', 9200, { KOPENG_API_URL: 'http://localhost:3200', PATH: '/usr/bin' });
    expect(plan.options.env).toEqual({
      KOPENG_API_URL: 'http://localhost:3200',
      PATH: '/usr/bin',
      VIZ_PORT: '9200',
    });
  });
});

describe('VIZ_PACKAGE_ROOT', () => {
  it('resolves two levels up from its own file (src/cli/viz.ts -> repo/package root) — the same arithmetic dist/cli/viz.js uses once installed', () => {
    // In the test runtime this module loads from its real src/cli/viz.ts
    // location, so "two levels up" lands on the repo root — the exact
    // scripts/ and viz/ sibling directories viz-server.js and its static
    // assets live under, both here and once installed under
    // <app>/node_modules/kopeng/dist/cli/viz.js (same two-level arithmetic
    // as index.ts's spawnSibling('../index.js')).
    const testFileDir = path.dirname(fileURLToPath(import.meta.url)); // <repoRoot>/tests/unit
    const repoRoot = path.resolve(testFileDir, '..', '..');
    expect(VIZ_PACKAGE_ROOT).toBe(repoRoot);
  });
});

describe('runVizCommand', () => {
  it('prints the URL line using the real default port BEFORE spawning', async () => {
    const { io, logs } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runVizCommand([], io, spawnImpl, '/opt/kopeng', {});
    // The log call happens synchronously before spawnImpl is invoked.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('http://localhost:8780');
    emitClose(0);
    await promise;
  });

  it('records the exact spawn args: script path under packageRoot, cwd, stdio', async () => {
    const { io } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runVizCommand([], io, spawnImpl, '/opt/kopeng', { PATH: '/usr/bin' });
    emitClose(0);
    await promise;

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [path.join('/opt/kopeng', 'scripts', 'viz-server.js')],
      {
        cwd: '/opt/kopeng',
        stdio: 'inherit',
        env: { PATH: '/usr/bin', VIZ_PORT: '8780' },
      }
    );
  });

  it('honors --port in both the printed URL and the spawn env', async () => {
    const { io, logs } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runVizCommand(['--port', '9200'], io, spawnImpl, '/opt/kopeng', {});
    emitClose(0);
    await promise;

    expect(logs.join('\n')).toContain('http://localhost:9200');
    expect(spawnImpl.mock.calls[0][2]).toMatchObject({ env: { VIZ_PORT: '9200' } });
  });

  it('resolves to the child close code', async () => {
    const { io } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runVizCommand([], io, spawnImpl, '/opt/kopeng', {});
    emitClose(3);
    expect(await promise).toBe(3);
  });

  it('resolves to 1 on a null close code', async () => {
    const { io } = fakeIo();
    const { child, emitClose } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runVizCommand([], io, spawnImpl, '/opt/kopeng', {});
    emitClose(null);
    expect(await promise).toBe(1);
  });

  it('rejects when the child emits an async "error" event (e.g. viz-server.js missing)', async () => {
    const { io } = fakeIo();
    const { child, emitError } = fakeChildProcess();
    const spawnImpl = vi.fn(() => child);
    const promise = runVizCommand([], io, spawnImpl, '/opt/kopeng', {});
    emitError(new Error('spawn ENOENT'));
    await expect(promise).rejects.toThrow('spawn ENOENT');
  });

  it('exits 1 with a clear message and never spawns on a bad --port', async () => {
    const { io, errors } = fakeIo();
    const spawnImpl = vi.fn();
    const code = await runVizCommand(['--port', 'nope'], io, spawnImpl, '/opt/kopeng', {});
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--port');
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
