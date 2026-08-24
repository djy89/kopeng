import { describe, it, expect } from 'vitest';
import {
  reinforcedConfidenceFor,
  AUTO_CONFIDENCE_CEILING,
  reinforceConfidence,
} from '../../src/discovery/confidence.js';

describe('reinforcedConfidenceFor', () => {
  it('returns null for a Hard Anchor — never writes confidence', () => {
    expect(reinforcedConfidenceFor(1.0)).toBeNull();
  });

  it('returns null for a crystallized memory (0.97)', () => {
    expect(reinforcedConfidenceFor(0.97)).toBeNull();
  });

  it('returns null exactly above the ceiling, writes exactly at it', () => {
    expect(reinforcedConfidenceFor(AUTO_CONFIDENCE_CEILING + 0.0001)).toBeNull();
    expect(reinforcedConfidenceFor(AUTO_CONFIDENCE_CEILING)).toBe(AUTO_CONFIDENCE_CEILING);
  });

  it('reinforces normally below the ceiling, still clamped', () => {
    const from = 0.5;
    expect(reinforcedConfidenceFor(from)).toBeCloseTo(reinforceConfidence(from), 10);
    expect(reinforcedConfidenceFor(0.84)).toBeLessThanOrEqual(AUTO_CONFIDENCE_CEILING);
  });

  // The composition test — this is the bug that actually shipped.
  it('does not fight crystallization: crystallize -> reinforce leaves 0.97 intact', () => {
    const crystallized = 0.97;
    expect(reinforcedConfidenceFor(crystallized)).toBeNull();
  });
});
