import { describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import path from 'node:path';

import {
  decideEnsure,
  runEnsure,
  type EnsureDeps,
  type EnsureFetch,
  type EnsureSpawn,
} from '../../src/cli/ensure.js';

// Task 2.3.3 — decideEnsure is pure and tested directly over faked probe
// results. runEnsure is tested with an injected fake fetch + fake spawn + fake
// port probe: the port is ALWAYS a throwaway value here, never 3200, and no
// case may reach a real socket — this suite must never probe or spawn against
// the real server.

describe('decideEnsure (pure)', () => {
  it('a kopeng-shaped JSON body (data.status present, any value) is already-up', () => {
    expect(decideEnsure({ kind: 'response', body: { data: { status: 'ok' } } })).toBe('already-up');
    expect(decideEnsure({ kind: 'response', body: { data: { status: 'unhealthy' } } })).toBe('already-up');
  });

  it('nothing bound to the port is the ONLY state that spawns', () => {
    expect(decideEnsure({ kind: 'no-listener' })).toBe('spawn');
  });

  // Review finding 2: connection-refused and probe-timeout used to collapse
  // into one 'network-error' kind, so a live-but-busy server was
  // indistinguishable from an absent one and attracted a competitor spawn.
  it('a bound-but-silent port is a live process, never a spawn', () => {
    expect(decideEnsure({ kind: 'listener-silent' })).toBe('already-up');
  });

  it('any non-kopeng-shaped response is a port conflict, never a spawn', () => {
    expect(decideEnsure({ kind: 'response', body: { hello: 'world' } })).toBe('port-conflict');
    expect(decideEnsure({ kind: 'response', body: { data: 'not-an-object' } })).toBe('port-conflict');
    expect(decideEnsure({ kind: 'response', body: null })).toBe('port-conflict');
    expect(decideEnsure({ kind: 'response', body: undefined })).toBe('port-conflict'); // non-JSON body
    expect(decideEnsure({ kind: 'response', body: 'garbage string' })).toBe('port-conflict');
  });
});

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const unrefCallOrder: number[] = [];
  const spawnImpl: EnsureSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref: () => { unrefCallOrder.push(calls.length); } };
  };
  return { spawnImpl, calls, unrefCallOrder };
}

function fetchResolving(body: unknown): EnsureFetch {
  return async () => ({ json: async () => body });
}
function fetchRefused(): EnsureFetch {
  return async () => { throw new Error('ECONNREFUSED'); };
}
/** Fails the fast probe, answers the second (longer-budget) one — a busy live server. */
function fetchSlow(body: unknown): EnsureFetch {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw new Error('TimeoutError');
    return { json: async () => body };
  };
}

const HINTS_DIR = '/home/test/.kopeng/hints';
const SPAWN_MARKER = path.join(HINTS_DIR, 'ensure_spawn.json');
const NOW = new Date('2026-08-29T12:00:00.000Z');

/** A cooldown marker reader that serves one marker, `ageMs` old at NOW. */
function markerAged(ageMs: number): (filePath: string) => string {
  return (filePath) => {
    if (filePath !== SPAWN_MARKER) throw new Error('ENOENT');
    return JSON.stringify({ port: 39217, timestamp: new Date(NOW.getTime() - ageMs).toISOString() });
  };
}

function baseDeps(overrides: Partial<EnsureDeps> = {}): EnsureDeps {
  return {
    port: 39217, // throwaway — never the real 3200
    nodePath: '/usr/bin/node',
    serverEntry: '/home/test/.kopeng/app/node_modules/kopeng/dist/server.js',
    kopengHome: '/home/test/.kopeng',
    envFile: '/home/test/.kopeng/.env',
    hintsDir: HINTS_DIR,
    fetchImpl: fetchRefused(),
    spawnImpl: fakeSpawn().spawnImpl,
    writeFile: () => {},
    // Default sandbox: the port is genuinely empty and no cooldown marker
    // exists, i.e. the cold-start case. Never the real socket/fs.
    portOpenImpl: async () => false,
    readFile: () => { throw new Error('ENOENT'); },
    now: () => NOW,
    ...overrides,
  };
}

describe('runEnsure', () => {
  it('already-up: does not spawn and does not write a hint', async () => {
    const spawnRec = fakeSpawn();
    const written = new Map<string, string>();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchResolving({ data: { status: 'ok' } }),
      spawnImpl: spawnRec.spawnImpl,
      writeFile: (p, c) => written.set(p, c),
    }));

    expect(decision).toBe('already-up');
    expect(spawnRec.calls).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('spawn: launches detached + stdio ignore with the right env/cwd, unrefs, and returns immediately', async () => {
    const spawnRec = fakeSpawn();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchRefused(),
      spawnImpl: spawnRec.spawnImpl,
    }));

    expect(decision).toBe('spawn');
    expect(spawnRec.calls).toHaveLength(1);
    const call = spawnRec.calls[0];
    expect(call.command).toBe('/usr/bin/node');
    expect(call.args).toEqual(['/home/test/.kopeng/app/node_modules/kopeng/dist/server.js']);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe('ignore');
    expect(call.options.cwd).toBe('/home/test/.kopeng');
    const env = call.options.env as Record<string, string>;
    expect(env.KOPENG_ENV_FILE).toBe('/home/test/.kopeng/.env');
    expect(env.KOPENG_HOME).toBe('/home/test/.kopeng');
    // unref is called exactly once, right after the one spawn call — no
    // readiness wait in between.
    expect(spawnRec.unrefCallOrder).toEqual([1]);
  });

  it('port-conflict: writes the hint and does NOT spawn', async () => {
    const spawnRec = fakeSpawn();
    const written = new Map<string, string>();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchResolving({ unrelated: 'thing' }),
      spawnImpl: spawnRec.spawnImpl,
      writeFile: (p, c) => written.set(p, c),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    }));

    expect(decision).toBe('port-conflict');
    expect(spawnRec.calls).toEqual([]);
    expect(written.size).toBe(1);
    const [[hintPath, hintContent]] = [...written.entries()];
    expect(hintPath).toBe(path.join('/home/test/.kopeng/hints', 'ensure_conflict.json'));
    const hint = JSON.parse(hintContent);
    expect(hint.port).toBe(39217);
    expect(hint.timestamp).toBe('2026-08-29T00:00:00.000Z');
  });

  it('a writeFile failure on port-conflict is swallowed (fail-open)', async () => {
    const spawnRec = fakeSpawn();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchResolving('garbage'),
      spawnImpl: spawnRec.spawnImpl,
      writeFile: () => { throw new Error('disk full'); },
    }));
    expect(decision).toBe('port-conflict');
    expect(spawnRec.calls).toEqual([]);
  });

  it('probes only 127.0.0.1:<injected port> — never a real address', async () => {
    const seenUrls: string[] = [];
    const fetchImpl: EnsureFetch = async (url) => { seenUrls.push(url); throw new Error('refused'); };
    await runEnsure(baseDeps({ fetchImpl, port: 39217 }));
    expect(seenUrls).toEqual(['http://127.0.0.1:39217/api/health']);
  });
});

// ── Review finding 2: a busy server must not attract a competitor ──────────

describe('runEnsure: slow listener vs empty port', () => {
  it('a port that is OPEN but never answers is already-up, with no spawn and no conflict hint', async () => {
    const spawnRec = fakeSpawn();
    const written = new Map<string, string>();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchRefused(),          // no HTTP answer within either budget
      portOpenImpl: async () => true,     // ... but something holds the port
      spawnImpl: spawnRec.spawnImpl,
      writeFile: (p, c) => written.set(p, c),
    }));

    expect(decision).toBe('already-up');
    expect(spawnRec.calls).toEqual([]);
    // Not a conflict either: a probe timeout is no evidence about WHO holds
    // the port, so accusing it of being foreign would be a false alarm in
    // `kopeng doctor`.
    expect(written.size).toBe(0);
  });

  it('an open port that answers on the second, longer probe is classified from that answer', async () => {
    const spawnRec = fakeSpawn();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchSlow({ data: { status: 'ok' } }),
      portOpenImpl: async () => true,
      spawnImpl: spawnRec.spawnImpl,
    }));
    expect(decision).toBe('already-up');
    expect(spawnRec.calls).toEqual([]);
  });

  it('an open port whose late answer is garbage still earns its port-conflict hint', async () => {
    const written = new Map<string, string>();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchSlow({ nginx: 'hello' }),
      portOpenImpl: async () => true,
      writeFile: (p, c) => written.set(p, c),
    }));
    expect(decision).toBe('port-conflict');
    expect([...written.keys()]).toEqual([path.join(HINTS_DIR, 'ensure_conflict.json')]);
  });

  it('a throwing port probe is read as occupied, not as an empty port', async () => {
    const spawnRec = fakeSpawn();
    const decision = await runEnsure(baseDeps({
      fetchImpl: fetchRefused(),
      portOpenImpl: async () => { throw new Error('EMFILE'); },
      spawnImpl: spawnRec.spawnImpl,
    }));
    expect(decision).toBe('already-up');
    expect(spawnRec.calls).toEqual([]);
  });

  it('no port probe wired (the init/update deps shape) keeps the pre-fix reading: refused means spawn', async () => {
    const spawnRec = fakeSpawn();
    const deps = baseDeps({ fetchImpl: fetchRefused(), spawnImpl: spawnRec.spawnImpl });
    delete deps.portOpenImpl;
    expect(await runEnsure(deps)).toBe('spawn');
    expect(spawnRec.calls).toHaveLength(1);
  });
});

// ── Review finding 1: the spawn storm against the live database ────────────

describe('runEnsure: spawn cooldown', () => {
  it('a spawn stamps the cooldown marker BEFORE launching', async () => {
    const spawnRec = fakeSpawn();
    const written = new Map<string, string>();
    const decision = await runEnsure(baseDeps({
      spawnImpl: spawnRec.spawnImpl,
      writeFile: (p, c) => written.set(p, c),
    }));

    expect(decision).toBe('spawn');
    expect([...written.keys()]).toEqual([SPAWN_MARKER]);
    const marker = JSON.parse(written.get(SPAWN_MARKER)!);
    expect(marker.port).toBe(39217);
    expect(marker.timestamp).toBe(NOW.toISOString());
    expect(spawnRec.calls).toHaveLength(1);
  });

  it('a fresh marker suppresses the next spawn entirely', async () => {
    const spawnRec = fakeSpawn();
    const written = new Map<string, string>();
    const decision = await runEnsure(baseDeps({
      readFile: markerAged(5_000), // mid-boot: the previous spawn is still coming up
      spawnImpl: spawnRec.spawnImpl,
      writeFile: (p, c) => written.set(p, c),
    }));

    expect(decision).toBe('spawn-suppressed');
    expect(spawnRec.calls).toEqual([]);
    // Suppressed means suppressed: it must not refresh the marker either, or
    // a session start every few seconds would extend the window forever.
    expect(written.size).toBe(0);
  });

  it('permits a spawn again once the boot budget has passed', async () => {
    const spawnRec = fakeSpawn();
    const decision = await runEnsure(baseDeps({
      readFile: markerAged(45_000),
      spawnImpl: spawnRec.spawnImpl,
    }));
    expect(decision).toBe('spawn');
    expect(spawnRec.calls).toHaveLength(1);
  });

  it('fails open: a malformed, unstamped or future-dated marker never suppresses', async () => {
    for (const raw of ['{ not json', JSON.stringify({}), JSON.stringify({ timestamp: 'not-a-date' })]) {
      const spawnRec = fakeSpawn();
      const decision = await runEnsure(baseDeps({ readFile: () => raw, spawnImpl: spawnRec.spawnImpl }));
      expect(decision).toBe('spawn');
      expect(spawnRec.calls).toHaveLength(1);
    }
    // Clock skew: a marker stamped in the future would otherwise suppress
    // spawns until the wall clock caught up with it.
    const spawnRec = fakeSpawn();
    expect(await runEnsure(baseDeps({ readFile: markerAged(-600_000), spawnImpl: spawnRec.spawnImpl }))).toBe('spawn');
    expect(spawnRec.calls).toHaveLength(1);
  });

  it('no reader wired (the init/update deps shape) is never suppressed, even by a fresh marker', async () => {
    const spawnRec = fakeSpawn();
    const written = new Map<string, string>();
    const deps = baseDeps({ spawnImpl: spawnRec.spawnImpl, writeFile: (p, c) => written.set(p, c) });
    delete deps.readFile;

    // `kopeng init` / `kopeng update` stop the server and then REQUIRE a
    // spawn; a marker written by some SessionStart seconds earlier must not
    // be able to veto that. They still stamp the marker, so a concurrent hook
    // invocation stands down for them.
    expect(await runEnsure(deps)).toBe('spawn');
    expect(spawnRec.calls).toHaveLength(1);
    expect([...written.keys()]).toEqual([SPAWN_MARKER]);
  });

  it('an unwritable marker still spawns (degrades to the old behavior, never blocks)', async () => {
    const spawnRec = fakeSpawn();
    const decision = await runEnsure(baseDeps({
      spawnImpl: spawnRec.spawnImpl,
      writeFile: () => { throw new Error('EACCES'); },
    }));
    expect(decision).toBe('spawn');
    expect(spawnRec.calls).toHaveLength(1);
  });
});
