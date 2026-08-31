import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  decidePurgeGate,
  decidePurgeTarget,
  isKopengHealthBody,
  parsePurgeConfirmation,
  parseUninstallArgs,
  derivedUninstallPaths,
  probeShutdownTarget,
  stopServer,
  UninstallError,
} from '../../src/cli/uninstall.js';

// Task 2.4.3 — the pure decision surface (no fs/network/process access). The
// full runUninstall orchestration is exercised against injected fakes in
// tests/integration/uninstall-flow.test.ts; stopServer's own HTTP shape lives
// here too since fix round 2 (Finding 1), because who does and does not get
// handed the admin key is a security contract that deserves a direct test
// rather than only an emergent one.

describe('parseUninstallArgs', () => {
  it('defaults every flag to false', () => {
    expect(parseUninstallArgs([])).toEqual({ yes: false, purge: false, dryRun: false, force: false });
  });

  it('recognizes --yes, --purge, --dry-run, and --force in any combination', () => {
    expect(parseUninstallArgs(['--yes'])).toEqual({ yes: true, purge: false, dryRun: false, force: false });
    expect(parseUninstallArgs(['--purge'])).toEqual({ yes: false, purge: true, dryRun: false, force: false });
    expect(parseUninstallArgs(['--dry-run'])).toEqual({ yes: false, purge: false, dryRun: true, force: false });
    expect(parseUninstallArgs(['--force'])).toEqual({ yes: false, purge: false, dryRun: false, force: true });
    expect(parseUninstallArgs(['--purge', '--yes'])).toEqual({ yes: true, purge: true, dryRun: false, force: false });
    expect(parseUninstallArgs(['--purge', '--yes', '--force'])).toEqual({ yes: true, purge: true, dryRun: false, force: true });
  });

  it('rejects an unknown argument, naming it', () => {
    expect(() => parseUninstallArgs(['--bogus'])).toThrow(UninstallError);
    expect(() => parseUninstallArgs(['--bogus'])).toThrow(/Unknown argument: --bogus/);
  });
});

describe('decidePurgeGate', () => {
  it('--yes always skips the prompt, TTY or not', () => {
    expect(decidePurgeGate({ yes: true, isTTY: true })).toBe('skip');
    expect(decidePurgeGate({ yes: true, isTTY: false })).toBe('skip');
  });

  it('no --yes on a non-interactive stdin refuses rather than hanging on a prompt', () => {
    expect(decidePurgeGate({ yes: false, isTTY: false })).toBe('fail-non-tty');
  });

  it('no --yes on a real TTY prompts', () => {
    expect(decidePurgeGate({ yes: false, isTTY: true })).toBe('prompt');
  });
});

describe('parsePurgeConfirmation', () => {
  it('accepts exactly the word "purge", case- and whitespace-insensitive', () => {
    expect(parsePurgeConfirmation('purge')).toBe(true);
    expect(parsePurgeConfirmation('Purge')).toBe(true);
    expect(parsePurgeConfirmation('  PURGE  ')).toBe(true);
  });

  it('rejects anything else, including a bare yes/enter', () => {
    expect(parsePurgeConfirmation('')).toBe(false);
    expect(parsePurgeConfirmation('y')).toBe(false);
    expect(parsePurgeConfirmation('yes')).toBe(false);
    expect(parsePurgeConfirmation('purge me')).toBe(false);
  });
});

describe('derivedUninstallPaths', () => {
  it('derives every path from kopengHome, matching the init/autostart layout', () => {
    const kopengHome = path.join('home', 'op', '.kopeng');
    const paths = derivedUninstallPaths(kopengHome);
    expect(paths.appDir).toBe(path.join(kopengHome, 'app'));
    expect(paths.dataDir).toBe(path.join(kopengHome, 'data'));
    expect(paths.modelsDir).toBe(path.join(kopengHome, 'models'));
    expect(paths.envFile).toBe(path.join(kopengHome, '.env'));
    expect(paths.autostartRecordFile).toBe(path.join(kopengHome, 'autostart.json'));
    expect(paths.ensureKnobFile).toBe(path.join(kopengHome, 'ensure.json'));
  });
});

// ── Finding 1: the admin key is never handed to a foreign listener ─────────
//
// stopServer read ADMIN_API_KEY out of the target .env and POSTed it to
// whatever held 127.0.0.1:<PORT>. On a shared POSIX host another local user
// binds that port with a trivial listener, the operator runs the routine
// `kopeng update`/`kopeng uninstall`, and the key gating every mutating
// endpoint arrives in a header — defeating the 0600 .env mode first-run.ts
// deliberately sets, without the attacker ever reading the file.

describe('isKopengHealthBody', () => {
  it('accepts a body carrying data.status, whatever the value', () => {
    expect(isKopengHealthBody({ data: { status: 'ready' } })).toBe(true);
    expect(isKopengHealthBody({ data: { status: 'degraded' } })).toBe(true);
    expect(isKopengHealthBody({ data: { status: null } })).toBe(true);
  });

  it('rejects everything a foreign listener would answer with', () => {
    expect(isKopengHealthBody(undefined)).toBe(false);
    expect(isKopengHealthBody(null)).toBe(false);
    expect(isKopengHealthBody('OK')).toBe(false);
    expect(isKopengHealthBody({})).toBe(false);
    expect(isKopengHealthBody({ status: 'ready' })).toBe(false);
    expect(isKopengHealthBody({ data: 'ready' })).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('probeShutdownTarget', () => {
  it('classifies a KOPENG health body as kopeng', async () => {
    const fetchImpl = (async () => jsonResponse({ data: { status: 'ready' } })) as unknown as typeof fetch;
    await expect(probeShutdownTarget('http://127.0.0.1:3200', fetchImpl)).resolves.toBe('kopeng');
  });

  it('classifies a wrong-shaped or non-JSON answer as foreign', async () => {
    const wrongShape = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    await expect(probeShutdownTarget('http://127.0.0.1:3200', wrongShape)).resolves.toBe('foreign');

    const notJson = (async () => new Response('<html>hello</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(probeShutdownTarget('http://127.0.0.1:3200', notJson)).resolves.toBe('foreign');
  });

  it('classifies silence (refused/timed out) as no-response, and never throws', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(probeShutdownTarget('http://127.0.0.1:3200', dead)).resolves.toBe('no-response');
  });
});

interface StopCall {
  url: string;
  headers: Record<string, string> | undefined;
}

function stopHarness(healthFetch: () => Promise<Response>, envSource = 'PORT=3210\nADMIN_API_KEY=super-secret\n') {
  const calls: StopCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, headers: init?.headers as Record<string, string> | undefined });
    if (urlStr.includes('/api/health')) return healthFetch();
    return jsonResponse({ data: { shutting_down: true } }, 202);
  }) as unknown as typeof fetch;

  const deps = {
    paths: { envFile: path.join('home', 'op', '.kopeng', '.env') },
    readFile: () => envSource,
    fetchImpl,
  };
  return { deps, calls };
}

describe('stopServer withholds the admin key unless a KOPENG server answered', () => {
  it('probes health FIRST, then sends the keyed shutdown to a real KOPENG server', async () => {
    const { deps, calls } = stopHarness(async () => jsonResponse({ data: { status: 'ready' } }));

    const result = await stopServer(deps);

    expect(result).toEqual({ stopped: true, port: 3210 });
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:3210/api/health',
      'http://127.0.0.1:3210/api/admin/shutdown',
    ]);
    // The probe itself is keyless — only the shutdown carries the key.
    expect(calls[0].headers?.['x-api-key']).toBeUndefined();
    expect(calls[1].headers?.['x-api-key']).toBe('super-secret');
  });

  it('sends NOTHING to a foreign listener, and names it in the reason', async () => {
    const { deps, calls } = stopHarness(async () => new Response('not a kopeng server', { status: 200 }));

    const result = await stopServer(deps);

    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/non-KOPENG process is listening on port 3210/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/health');
    // The load-bearing assertion: the key left the process on zero requests.
    expect(calls.some((c) => c.headers?.['x-api-key'] !== undefined)).toBe(false);
  });

  it('sends NOTHING to a listener that answers nothing at all — the same attack, quieter', async () => {
    const { deps, calls } = stopHarness(async () => { throw new Error('ECONNREFUSED'); });

    const result = await stopServer(deps);

    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/unreachable at http:\/\/127\.0\.0\.1:3210 \(no answer on GET/);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.headers?.['x-api-key'] !== undefined)).toBe(false);
  });

  it('still stops a keyless (dev-mode) KOPENG server — the Finding-4 behavior is unchanged', async () => {
    const { deps, calls } = stopHarness(async () => jsonResponse({ data: { status: 'ready' } }), 'PORT=3210\n');

    const result = await stopServer(deps);

    expect(result).toEqual({ stopped: true, port: 3210 });
    expect(calls[1].headers?.['x-api-key']).toBeUndefined();
  });
});

// ── Finding 3: --purge refuses a target that is not an install ────────────
//
// Consent (typing "purge", or --yes) proved the operator meant to purge —
// never that KOPENG_HOME points at an install. KOPENG_HOME is a supported
// override that install-smoke.mjs exports routinely, so one left set in a
// shell turned the documented `kopeng uninstall --purge --yes` into a
// recursive delete of an unrelated tree, with --yes skipping the prompt that
// would have shown the path.

describe('decidePurgeTarget', () => {
  it('allows a normal install (.env plus app/ and data/)', () => {
    expect(decidePurgeTarget({ env: true, app: true, data: true })).toEqual({ allowed: true, missing: [] });
  });

  it('allows an install missing either app/ or data/, but not both', () => {
    expect(decidePurgeTarget({ env: true, app: true, data: false }).allowed).toBe(true);
    expect(decidePurgeTarget({ env: true, app: false, data: true }).allowed).toBe(true);
    expect(decidePurgeTarget({ env: true, app: false, data: false })).toEqual({
      allowed: false,
      missing: ['app/ or data/'],
    });
  });

  it('refuses a directory with no .env, naming what was missing', () => {
    expect(decidePurgeTarget({ env: false, app: true, data: true })).toEqual({ allowed: false, missing: ['.env'] });
    expect(decidePurgeTarget({ env: false, app: false, data: false })).toEqual({
      allowed: false,
      missing: ['.env', 'app/ or data/'],
    });
  });
});
