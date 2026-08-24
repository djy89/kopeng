/**
 * Phase 4, Task 3 (CR-1): THE unified Hard-Anchor contract. One predicate —
 * locked / operator-confirmed / metadata.pinned — consumed by every automated
 * archive path, so no path can archive a row another path refuses.
 */
import { describe, it, expect } from 'vitest';
import { isAnchored, isPinnedMetadata } from '../../src/dreaming/scoring.js';

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
