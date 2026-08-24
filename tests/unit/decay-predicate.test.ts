import { describe, it, expect } from 'vitest';
import { isDecayedAtRisk, DECAY_ARCHIVE_THRESHOLD, memoryStrength } from '../../src/dreaming/scoring.js';

const NOW = new Date('2026-08-20T00:00:00Z');
const old = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();

describe('isDecayedAtRisk — THE archive-line predicate', () => {
  const base = { confidence: 0.6, observation_count: 1, last_seen: null as string | null, updated_at: old(300) };
  it('agrees with memoryStrength < threshold on the same inputs', () => {
    expect(isDecayedAtRisk(base, NOW)).toBe(memoryStrength(base, NOW) < DECAY_ARCHIVE_THRESHOLD);
    expect(isDecayedAtRisk(base, NOW)).toBe(true); // 300d at default 60d half-life
  });
  it('dormancy freezes decay when passed (R4-B)', () => {
    expect(isDecayedAtRisk(base, NOW, { dormant: true })).toBe(false); // frozen at 0.6
  });
  it('threads type/tags — structural floor holds the line', () => {
    const structural = { ...base, type: 'reference', tags: ['structural'] };
    expect(isDecayedAtRisk(structural, NOW)).toBe(false); // floor 0.4 > 0.2
  });
  it('fresh rows are not at risk', () => {
    expect(isDecayedAtRisk({ ...base, last_seen: old(1) }, NOW)).toBe(false);
  });
});
