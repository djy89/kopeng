import { describe, it, expect } from 'vitest';
import { isLoopbackHost, assertBindAllowed, BindRefusedError } from '../../src/config/first-run.js';

describe('isLoopbackHost (CX-4)', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) {
    it(`${h} is loopback`, () => expect(isLoopbackHost(h)).toBe(true));
  }
  for (const h of ['0.0.0.0', '::', '', '192.168.1.5', '10.0.0.1', 'example.com',
                   '127.example.test', '127.0.0.1.example', '127.1']) {
    it(`${h || '(empty)'} is NOT loopback`, () => expect(isLoopbackHost(h)).toBe(false));
  }
});

describe('assertBindAllowed', () => {
  const e = (host: string, a: string, o: string) =>
    ({ host, adminApiKey: a, observationApiKey: o });
  it('loopback always allowed, keys or not', () => {
    expect(() => assertBindAllowed(e('127.0.0.1', '', ''))).not.toThrow();
  });
  it('non-loopback with both keys allowed', () => {
    expect(() => assertBindAllowed(e('0.0.0.0', 'a', 'b'))).not.toThrow();
  });
  it('non-loopback missing keys → refused, message names each missing key + SECURITY.md', () => {
    for (const [a, o, names] of [['', '', ['ADMIN_API_KEY', 'OBSERVATION_API_KEY']],
                                 ['a', '', ['OBSERVATION_API_KEY']],
                                 ['', 'o', ['ADMIN_API_KEY']]] as const) {
      let err: unknown;
      try { assertBindAllowed(e('0.0.0.0', a, o)); } catch (x) { err = x; }
      expect(err).toBeInstanceOf(BindRefusedError);
      for (const n of names) expect((err as Error).message).toContain(n);
      expect((err as Error).message).toContain('SECURITY.md');
    }
  });
});
