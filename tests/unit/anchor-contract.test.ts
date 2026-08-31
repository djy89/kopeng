/**
 * Phase 4, Task 3 (CR-1): THE unified Hard-Anchor contract. One predicate —
 * locked / operator-confirmed / metadata.pinned — consumed by every automated
 * archive path, so no path can archive a row another path refuses.
 */
import { describe, it, expect } from 'vitest';
import { isAnchored, isPinnedMetadata, memoryStrength, isDecayedAtRisk } from '../../src/dreaming/scoring.js';

describe('unified Hard-Anchor contract (CR-1)', () => {
  it('locked anchors — numeric and boolean forms', () => {
    expect(isAnchored({ is_locked: 1, confidence: 0.5 })).toBe(true);
    expect(isAnchored({ is_locked: true, confidence: 0.5 })).toBe(true);
    expect(isAnchored({ is_locked: 0, confidence: 0.5 })).toBe(false);
    expect(isAnchored({ is_locked: null, confidence: 0.5 })).toBe(false);
  });
  it('operator-confirmed anchors', () => {
    expect(isAnchored({ is_locked: 0, confidence: 1.0 })).toBe(true);
  });
  it('pinned metadata anchors — the CR-1 hole', () => {
    expect(isAnchored({ is_locked: 0, confidence: 0.5, metadata: '{"pinned":true}' })).toBe(true);
    expect(isAnchored({ is_locked: 0, confidence: 0.5, metadata: '{"pinned":"yes"}' })).toBe(false);
    expect(isAnchored({ is_locked: 0, confidence: 0.5, metadata: 'not json' })).toBe(false);
    expect(isAnchored({ is_locked: 0, confidence: 0.5, metadata: null })).toBe(false);
    expect(isAnchored({ is_locked: 0, confidence: 0.5 })).toBe(false);
  });
  it('isPinnedMetadata standalone', () => {
    expect(isPinnedMetadata('{"pinned":true}')).toBe(true);
    expect(isPinnedMetadata('{"pinned":false}')).toBe(false);
    expect(isPinnedMetadata(undefined)).toBe(false);
    expect(isPinnedMetadata(null)).toBe(false);
  });
});

describe('WS7.4 B2: is_locked freezes the read-time decay curve', () => {
  it('a locked row at confidence 0.5, last seen 400 days ago, never decays', () => {
    const row = {
      confidence: 0.5,
      observation_count: 1,
      last_seen: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      updated_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      is_locked: true,
    };
    expect(memoryStrength(row)).toBe(0.5);
    expect(isDecayedAtRisk(row, new Date())).toBe(false);
  });

  it('the same row unlocked DOES decay (the freeze is load-bearing, not a fluke of the inputs)', () => {
    const row = {
      confidence: 0.5,
      observation_count: 1,
      last_seen: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      updated_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      is_locked: false,
    };
    expect(memoryStrength(row)).toBeLessThan(0.5);
    expect(isDecayedAtRisk(row, new Date())).toBe(true);
  });

  it('numeric is_locked (SQLite row shape) freezes too', () => {
    const row = {
      confidence: 0.5,
      observation_count: 1,
      last_seen: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      updated_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      is_locked: 1,
    };
    expect(memoryStrength(row)).toBe(0.5);
    expect(isDecayedAtRisk(row, new Date())).toBe(false);
  });
});
