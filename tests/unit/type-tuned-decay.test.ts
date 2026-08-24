import { describe, it, expect } from 'vitest';
import {
  computeEffectiveConfidence,
  resolveHalfLife,
  resolveFloor,
  DECAY_ARCHIVE_THRESHOLD,
  DECAY_HALF_LIVES,
  DEFAULT_HALF_LIFE_DAYS,
  STRUCTURAL_FLOOR,
} from '../../src/discovery/confidence.js';

const NOW = new Date('2026-07-10T00:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('resolveHalfLife (T30)', () => {
  it('maps each tuned type', () => {
    expect(resolveHalfLife('discovery')).toBe(DECAY_HALF_LIVES.discovery); // 25
    expect(resolveHalfLife('project')).toBe(45);
    expect(resolveHalfLife('reference')).toBe(38);
    expect(resolveHalfLife('feedback')).toBe(90);
  });
  it('discovery + an error tag is the fast (error) class', () => {
    expect(resolveHalfLife('discovery', ['error:typescript'])).toBe(DECAY_HALF_LIVES.error); // 11
    expect(resolveHalfLife('discovery', ['recurring_error'])).toBe(11);
  });
  it('unknown/absent type falls back to the default', () => {
    expect(resolveHalfLife()).toBe(DEFAULT_HALF_LIFE_DAYS); // 60
    expect(resolveHalfLife('mystery')).toBe(60);
  });
});

describe('resolveFloor (T30)', () => {
  it('references and structural/canonical-tagged memories are floored', () => {
    expect(resolveFloor('reference')).toBe(STRUCTURAL_FLOOR); // 0.4
    expect(resolveFloor('project', ['structural'])).toBe(0.4);
    expect(resolveFloor('discovery', ['canonical'])).toBe(0.4);
  });
  it('non-structural memories have no floor', () => {
    expect(resolveFloor('project')).toBeNull();
    expect(resolveFloor('discovery', ['error:build'])).toBeNull();
  });
});

describe('per-type decay curves', () => {
  it('a fast-decay type ages BELOW a slow-decay type from an identical start (BACKLOG acceptance)', () => {
    const err = computeEffectiveConfidence(0.9, ago(30), NOW, false, 1, 'discovery', ['error:ts']);
    const ref = computeEffectiveConfidence(0.9, ago(30), NOW, false, 1, 'reference');
    expect(err).toBeLessThan(ref);
    // error (11d) is well down; reference (38d) still healthy.
    expect(err).toBeCloseTo(0.9 * Math.pow(0.5, 30 / 11), 5);
  });

  it('feedback (90d) decays SLOWER than the old global 60d', () => {
    const fb = computeEffectiveConfidence(0.8, ago(60), NOW, false, 1, 'feedback');
    const old = computeEffectiveConfidence(0.8, ago(60), NOW, false, 1); // no type = 60d
    expect(fb).toBeGreaterThan(old);
  });
});

describe('decay floors', () => {
  it('a floored reference never decays below the floor — and never under the 0.2 archive line', () => {
    const ref = computeEffectiveConfidence(0.9, ago(120), NOW, false, 1, 'reference');
    expect(ref).toBeCloseTo(STRUCTURAL_FLOOR, 5); // clamped up to 0.4 from a deep-decayed value
    expect(ref).toBeGreaterThanOrEqual(DECAY_ARCHIVE_THRESHOLD);
  });

  it('the floor never RAISES a genuinely low-stored memory above its stored confidence', () => {
    const ref = computeEffectiveConfidence(0.3, ago(365), NOW, false, 1, 'reference');
    expect(ref).toBeCloseTo(0.3, 5); // min(0.4, 0.3) = 0.3, not 0.4
    expect(ref).toBeLessThanOrEqual(0.3);
  });

  it('a structural TAG floors a non-reference type too', () => {
    const proj = computeEffectiveConfidence(0.9, ago(120), NOW, false, 1, 'project', ['structural']);
    expect(proj).toBeCloseTo(STRUCTURAL_FLOOR, 5);
  });
});

describe('invariants preserved', () => {
  it('Hard Anchor (>=1.0) short-circuits BEFORE any per-type curve or floor', () => {
    expect(computeEffectiveConfidence(1.0, ago(999), NOW, false, 1, 'reference', ['structural'])).toBe(1.0);
    expect(computeEffectiveConfidence(1.0, ago(999), NOW, false, 1, 'discovery', ['error:x'])).toBe(1.0);
  });

  it('omitting type/tags is byte-for-byte the pre-T30 global 60d curve (no floor)', () => {
    const days = 45;
    const got = computeEffectiveConfidence(0.85, ago(days), NOW, false, 3);
    const expected = 0.85 * Math.pow(0.5, days / (1 + Math.log(3)) / 60);
    expect(got).toBeCloseTo(expected, 10);
  });

  it('dormant freeze and daysSinceSeen<=0 still short-circuit', () => {
    expect(computeEffectiveConfidence(0.7, ago(100), NOW, true, 1, 'discovery')).toBe(0.7); // dormant
    expect(computeEffectiveConfidence(0.7, ago(-5), NOW, false, 1, 'discovery')).toBe(0.7); // future last_seen
  });
});
