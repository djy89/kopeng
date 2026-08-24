import { describe, expect, it } from 'vitest';
import {
  drillSucceeded,
  observedChecksPass,
  requiredChecksPass,
} from '../../scripts/lib/drill-verdict.js';

describe('dream drill verdict mutation guards', () => {
  it('does not let an empty observed class pass vacuously', () => {
    expect(observedChecksPass(0, true)).toBe(false);
    expect(observedChecksPass(2, true)).toBe(true);
  });

  it('requires every named probe to be present and passing', () => {
    const checks = [
      { id: 'P1', pass: true },
      { id: 'P2', pass: true },
      { id: 'P4', pass: true },
    ];
    expect(requiredChecksPass(checks, ['P1', 'P2', 'P3', 'P4'])).toBe(false);
    expect(requiredChecksPass([...checks, { id: 'P3', pass: true }], ['P1', 'P2', 'P3', 'P4'])).toBe(true);
  });

  it('fails the process verdict when any hard-correctness case fails', () => {
    const gates = [{ id: 'H1', pass: true }];
    expect(drillSucceeded(gates, [{ status: 'fail' }])).toBe(false);
    expect(drillSucceeded(gates, [{ status: 'pass' }, { status: 'soft_miss' }])).toBe(true);
  });
});
