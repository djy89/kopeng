import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  computeErrorPatternConfidence,
  reinforceConfidence,
  computeEffectiveConfidence,
  durabilityFactor,
  DECAY_ARCHIVE_THRESHOLD,
  AUTO_CONFIDENCE_CEILING,
} from '../../src/discovery/confidence.js';

describe('computeConfidence', () => {
  it('should return moderate confidence for 3 occurrences (minimum threshold)', () => {
    const c = computeConfidence(3);
    expect(c).toBeGreaterThanOrEqual(0.5);
    expect(c).toBeLessThanOrEqual(0.65);
  });

  it('should increase with more evidence', () => {
    const c3 = computeConfidence(3);
    const c6 = computeConfidence(6);
    const c11 = computeConfidence(11);

    expect(c6).toBeGreaterThan(c3);
    expect(c11).toBeGreaterThan(c6);
  });

  it('should never exceed AUTO_CONFIDENCE_CEILING', () => {
    const c = computeConfidence(1000, 365);
    expect(c).toBeLessThanOrEqual(AUTO_CONFIDENCE_CEILING);
  });

  it('should return 0 for 0 occurrences', () => {
    expect(computeConfidence(0)).toBe(0);
  });

  it('should add temporal spread bonus for multi-day patterns', () => {
    const withoutSpread = computeConfidence(5, 0);
    const withSpread = computeConfidence(5, 7);
    expect(withSpread).toBeGreaterThan(withoutSpread);
  });

  it('should cap temporal spread bonus at 0.05', () => {
    const sevenDays = computeConfidence(5, 7);
    const thirtyDays = computeConfidence(5, 30);
    // Both should get the max bonus — no additional increase past 7 days
    expect(thirtyDays).toBe(sevenDays);
  });
});

describe('reinforceConfidence', () => {
  it('should increase confidence', () => {
    const original = 0.5;
    const reinforced = reinforceConfidence(original);
    expect(reinforced).toBeGreaterThan(original);
  });

  it('should be self-limiting: high confidence gets smaller bumps', () => {
    const lowBump = reinforceConfidence(0.8) - 0.8;
    const highBump = reinforceConfidence(0.3) - 0.3;
    expect(highBump).toBeGreaterThan(lowBump);
  });

  it('should never exceed AUTO_CONFIDENCE_CEILING', () => {
    let c = 0.5;
    for (let i = 0; i < 100; i++) {
      c = reinforceConfidence(c);
    }
    expect(c).toBeLessThanOrEqual(AUTO_CONFIDENCE_CEILING);
  });

  it('should give diminishing returns', () => {
    const c1 = reinforceConfidence(0.5);
    const delta1 = c1 - 0.5;
    const c2 = reinforceConfidence(c1);
    const delta2 = c2 - c1;
    expect(delta2).toBeLessThan(delta1);
  });
});

describe('computeEffectiveConfidence', () => {
  const now = new Date('2026-04-06T12:00:00Z');

  it('should not decay explicit memories (confidence = 1.0)', () => {
    const oneDayAgo = new Date(now.getTime() - 86400000).toISOString();
    expect(computeEffectiveConfidence(1.0, oneDayAgo, now)).toBe(1.0);
  });

  it('should decay auto-discovered memories over time', () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
    const effective = computeEffectiveConfidence(0.7, thirtyDaysAgo, now);
    expect(effective).toBeLessThan(0.7);
    expect(effective).toBeGreaterThan(0);
  });

  it('should halve confidence at the half-life (60 days)', () => {
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString();
    const effective = computeEffectiveConfidence(0.8, sixtyDaysAgo, now);
    expect(effective).toBeCloseTo(0.4, 1);
  });

  it('should not decay for dormant projects', () => {
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString();
    const effective = computeEffectiveConfidence(0.7, ninetyDaysAgo, now, true);
    expect(effective).toBe(0.7);
  });

  it('should return stored confidence if updated_at is in the future', () => {
    const future = new Date(now.getTime() + 86400000).toISOString();
    expect(computeEffectiveConfidence(0.7, future, now)).toBe(0.7);
  });
});

describe('durability (D1.1)', () => {
  const now = new Date('2026-06-09T12:00:00Z');

  it('durabilityFactor is 1 for a single observation and grows logarithmically', () => {
    expect(durabilityFactor(1)).toBe(1);
    expect(durabilityFactor(0)).toBe(1); // clamped
    expect(durabilityFactor(3)).toBeCloseTo(1 + Math.log(3), 5);
    // Self-limiting: 1000 observations still under 8x
    expect(durabilityFactor(1000)).toBeLessThan(8);
  });

  it('a well-evidenced memory decays slower at equal staleness (DoD)', () => {
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString();
    const heavy = computeEffectiveConfidence(0.7, sixtyDaysAgo, now, false, 20);
    const light = computeEffectiveConfidence(0.7, sixtyDaysAgo, now, false, 3);
    expect(heavy).toBeGreaterThan(light);
    // obs=1 must match the pre-D1.1 behavior exactly (durability 1)
    const single = computeEffectiveConfidence(0.7, sixtyDaysAgo, now, false, 1);
    expect(single).toBeCloseTo(0.35, 5);
    expect(light).toBeGreaterThan(single);
  });

  it('confidence = 1.0 is immune regardless of observation count or staleness', () => {
    const twoYearsAgo = new Date(now.getTime() - 730 * 86400000).toISOString();
    expect(computeEffectiveConfidence(1.0, twoYearsAgo, now, false, 1)).toBe(1.0);
    expect(computeEffectiveConfidence(1.0, twoYearsAgo, now, false, 1000)).toBe(1.0);
  });

  it('durability slows but never stops decay', () => {
    const yearAgo = new Date(now.getTime() - 365 * 86400000).toISOString();
    const heavy = computeEffectiveConfidence(0.85, yearAgo, now, false, 50);
    expect(heavy).toBeLessThan(0.85); // still decays
    expect(heavy).toBeGreaterThan(computeEffectiveConfidence(0.85, yearAgo, now, false, 1));
  });
});

describe('computeErrorPatternConfidence', () => {
  it('should give cross-session bonus (+0.10)', () => {
    const singleSession = computeErrorPatternConfidence(3, 1, false);
    const multiSession = computeErrorPatternConfidence(3, 2, false);
    expect(multiSession - singleSession).toBeCloseTo(0.10, 1);
  });

  it('should apply fix shortcut (3 with fix → at least 0.65)', () => {
    const withFix = computeErrorPatternConfidence(3, 2, true);
    expect(withFix).toBeGreaterThanOrEqual(0.65);
  });

  it('should not exceed ceiling', () => {
    const high = computeErrorPatternConfidence(50, 10, true, 30);
    expect(high).toBeLessThanOrEqual(AUTO_CONFIDENCE_CEILING);
  });

  it('should produce Noted-tier confidence for 2 occurrences in 1 session', () => {
    const c = computeErrorPatternConfidence(2, 1, false);
    expect(c).toBeGreaterThanOrEqual(0.40);
    expect(c).toBeLessThan(0.60);
  });

  it('should produce Pattern-tier for 3 cross-session without fix', () => {
    const c = computeErrorPatternConfidence(3, 2, false);
    expect(c).toBeGreaterThanOrEqual(0.55);
    expect(c).toBeLessThan(0.70);
  });

  it('should produce Actionable-tier for 5+ cross-session', () => {
    const c = computeErrorPatternConfidence(5, 3, false);
    expect(c).toBeGreaterThanOrEqual(0.65);
  });
});

describe('DECAY_ARCHIVE_THRESHOLD', () => {
  // The archive-line decision itself lives in isDecayedAtRisk (scoring.ts,
  // covered by tests/unit/decay-predicate.test.ts); this pins the one shared
  // threshold value the predicate compares against, strictly-below.
  it('is the 0.2 archive line', () => {
    expect(DECAY_ARCHIVE_THRESHOLD).toBe(0.2);
  });
});
