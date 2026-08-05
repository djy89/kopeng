import { describe, it, expect } from 'vitest';
import {
  shouldDreamFire,
  localPartsInTz,
  inQuietWindow,
  type FirePredicateInput,
} from '../../src/dreaming/fire-predicate.js';

/**
 * D0.5 — pure dream fire predicate. Covers the four required cases (fire,
 * already-ran-today, outside-window, idle-not-met) plus DST-correct local-day
 * derivation. No timers, no DB — `now` is injected.
 */
describe('shouldDreamFire (D0.5)', () => {
  // A base "should fire" input: 03:00 UTC (inside the 02–06 quiet window),
  // idle (no activity), and not yet run today.
  const base: FirePredicateInput = {
    now: Date.parse('2026-06-15T03:00:00Z'),
    lastActivityAt: null,
    lastRunDayLocal: null,
    tz: 'UTC',
    idleMs: 30 * 60 * 1000,
    quietStartHour: 2,
    quietEndHour: 6,
  };

  it('fires when in-window, idle, and not run today', () => {
    const d = shouldDreamFire(base);
    expect(d.fire).toBe(true);
    expect(d.reason).toBe('fire');
    expect(d.localDay).toBe('2026-06-15');
  });

  it('does not fire when already run today (operator-local day)', () => {
    const d = shouldDreamFire({ ...base, lastRunDayLocal: '2026-06-15' });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('already_ran_today');
  });

  it('does not fire outside the quiet-hours window', () => {
    // 12:00 UTC is outside [02:00, 06:00).
    const d = shouldDreamFire({ ...base, now: Date.parse('2026-06-15T12:00:00Z') });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('outside_window');
  });

  it('does not fire when the operator was recently active', () => {
    const d = shouldDreamFire({ ...base, lastActivityAt: base.now - 5 * 60 * 1000 });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('idle_not_met');
  });

  it('fires once idle exceeds the threshold', () => {
    const d = shouldDreamFire({ ...base, lastActivityAt: base.now - 31 * 60 * 1000 });
    expect(d.fire).toBe(true);
    expect(d.reason).toBe('fire');
  });

  it('treats a null quiet window as "always allowed"', () => {
    const d = shouldDreamFire({
      ...base,
      now: Date.parse('2026-06-15T12:00:00Z'), // noon — would be outside a real window
      quietStartHour: null,
      quietEndHour: null,
    });
    expect(d.fire).toBe(true);
  });
});

describe('inQuietWindow', () => {
  it('handles a normal daytime window', () => {
    expect(inQuietWindow(3, 2, 6)).toBe(true);
    expect(inQuietWindow(6, 2, 6)).toBe(false); // end is exclusive
    expect(inQuietWindow(1, 2, 6)).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(inQuietWindow(23, 22, 6)).toBe(true);
    expect(inQuietWindow(3, 22, 6)).toBe(true);
    expect(inQuietWindow(12, 22, 6)).toBe(false);
  });

  it('treats null bounds as unrestricted', () => {
    expect(inQuietWindow(12, null, null)).toBe(true);
  });
});

describe('localPartsInTz — DST correctness', () => {
  it('rolls the local day back across the UTC/local boundary, with DST offset', () => {
    // America/Denver: MDT (UTC-6) in summer, MST (UTC-7) in winter.
    // Summer instant: 05:30 UTC → 23:30 the previous local day at UTC-6.
    const summer = localPartsInTz(Date.parse('2026-07-01T05:30:00Z'), 'America/Denver');
    expect(summer.day).toBe('2026-06-30');
    expect(summer.hour).toBe(23);

    // Winter instant: same wall-clock UTC → 22:30 prev day at UTC-7 (DST off).
    const winter = localPartsInTz(Date.parse('2026-01-01T05:30:00Z'), 'America/Denver');
    expect(winter.day).toBe('2025-12-31');
    expect(winter.hour).toBe(22);
  });

  it('keeps already-ran-today correct across a DST shift', () => {
    // A dream "ran" on the local day that the summer instant falls in.
    const d = shouldDreamFire({
      now: Date.parse('2026-07-01T05:30:00Z'),
      lastActivityAt: null,
      lastRunDayLocal: '2026-06-30', // same local day → must NOT fire again
      tz: 'America/Denver',
      idleMs: 30 * 60 * 1000,
      quietStartHour: 22,
      quietEndHour: 6,
    });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('already_ran_today');
  });
});
