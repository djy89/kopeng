import { describe, it, expect } from 'vitest';
import {
  scrubSecrets,
  stripUnstorableChars,
  stripUnstorableCharsDeep,
} from '../../src/utils/scrubber.js';

/**
 * Regression (2026-07-27): UTF-16LE tool output (e.g. `wsl.exe --list --quiet`)
 * carries NUL bytes, which Postgres rejects with
 *   invalid byte sequence for encoding "UTF8": 0x00
 * That surfaced as a 500, which the observe hook classified as transient — so the
 * chunk retried forever and, because the queue drains oldest-first, head-of-line
 * blocked the ENTIRE flush queue (956 files / ~4.9MB stalled, capture silently
 * buffering for hours). Sanitizing server-side is the real fix; the hook's stall
 * counter (observe-hook-flush.test.ts) is the backstop.
 */
describe('stripUnstorableChars (NUL sanitizing)', () => {
  const NUL = String.fromCharCode(0);

  it('removes NUL bytes', () => {
    expect(stripUnstorableChars(`a${NUL}b`)).toBe('ab');
  });

  it('reconstructs readable text from UTF-16LE-derived output', () => {
    const utf16ish = `U${NUL}b${NUL}u${NUL}n${NUL}t${NUL}u${NUL}`;
    expect(stripUnstorableChars(utf16ish)).toBe('Ubuntu');
  });

  it('leaves NUL-free text byte-identical', () => {
    const clean = 'npm run build\n  62 passed';
    expect(stripUnstorableChars(clean)).toBe(clean);
  });

  it('preserves other C0 controls (legal in PG text)', () => {
    expect(stripUnstorableChars('a\tb\nc')).toBe('a\tb\nc');
  });

  it('handles empty input without throwing', () => {
    expect(stripUnstorableChars('')).toBe('');
  });

  it('is applied by scrubSecrets, the server-side chokepoint', () => {
    expect(scrubSecrets(`out${NUL}put`)).toBe('output');
  });

  it('scrubs secrets and NULs together', () => {
    // Prefix assembled at runtime (see scrubber.test.ts): a literal key-shaped
    // string trips GitHub push protection even when the body is synthetic.
    const key = `sk_${'test'}_abcdefghijklmnopqrstuvwx`;
    const r = scrubSecrets(`api_key=${key}${NUL}`);
    expect(r).not.toContain(NUL);
    expect(r).not.toContain(key);
  });

  it('deep-strips metadata objects (which never pass through scrubSecrets)', () => {
    const meta = { cwd: `C:${NUL}\\tmp`, nested: { arr: [`x${NUL}y`] }, n: 5, nil: null };
    expect(stripUnstorableCharsDeep(meta)).toEqual({
      cwd: 'C:\\tmp',
      nested: { arr: ['xy'] },
      n: 5,
      nil: null,
    });
  });
});
