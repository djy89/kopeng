/**
 * Viz proxy remote read-only enforcement (sweep-3 PB-3).
 *
 * SECURITY.md promised that a remote-bound viz without VIZ_ALLOW_REMOTE_ADMIN is
 * read-only. It wasn't: withholding the admin key only stops routes that REQUIRE
 * it, and the proxy forwarded every method and body, so a remote viewer could
 * POST /api/memories straight through to an ungated route.
 *
 * PB-2 gates core CRUD, but only when ADMIN_API_KEY is configured — and the
 * shipped default configures no key at all. So this proxy-level method
 * restriction is the control that has to hold on a default install, which is
 * exactly why it is pinned here rather than left to the API's own auth.
 *
 * Tested as pure functions: binding a non-loopback interface to prove it
 * end-to-end isn't possible on Windows (only 127.0.0.1 exists, and a wildcard
 * bind is EACCES), and a test that needs real network exposure to run is a test
 * that won't run in CI either.
 */
import { describe, it, expect } from 'vitest';
import { isLoopbackHost, isReadOnlyBlocked } from '../../scripts/viz-server.js';
import { isLoopbackHost as serverIsLoopbackHost } from '../../src/config/first-run.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', 'localhost'])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.0.2.50', '198.51.100.2', 'kopeng.local'])(
    'treats %s as remote',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  // Team-review fix: the viz and the server MUST agree on what "loopback"
  // means — a host the server binds as local (127.0.0.2) must not strand the
  // viz read-only. One probe list, two implementations, identical verdicts.
  it('agrees with src/config/first-run.ts isLoopbackHost on every probe', () => {
    const probes = [
      '127.0.0.1', '127.0.0.2', '127.1.2.3', '::1', 'localhost',
      '0.0.0.0', '::', '', '192.0.2.50', '10.0.0.1', 'kopeng.local',
      '127.example.test', '127.0.0.1.example', '127.1', '0x7f.0.0.1',
      '2130706433', '::ffff:127.0.0.1', '127.256.0.1', 'LOCALHOST',
    ];
    for (const host of probes) {
      expect(isLoopbackHost(host), `viz vs server disagree on '${host}'`).toBe(
        serverIsLoopbackHost(host),
      );
    }
  });
});

describe('remote bind without the admin opt-in is read-only', () => {
  const REMOTE = false; // adminInjectionEnabled === false

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s', (method) => {
    expect(isReadOnlyBlocked(method, REMOTE)).toBe(true);
  });

  it.each(['GET', 'HEAD'])('allows %s', (method) => {
    expect(isReadOnlyBlocked(method, REMOTE)).toBe(false);
  });

  it('allows the SSE stream, which is a GET', () => {
    expect(isReadOnlyBlocked('GET', REMOTE)).toBe(false);
  });
});

describe('loopback bind, or remote with the opt-in, is unrestricted', () => {
  const ALLOWED = true; // adminInjectionEnabled === true

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])('allows %s', (method) => {
    expect(isReadOnlyBlocked(method, ALLOWED)).toBe(false);
  });
});
