/**
 * Unit tests for the T24 corpus-health snapshot script's pure helpers.
 *
 * Pure unit tests — NO network, NO server, NO filesystem writes.
 * The helpers are imported directly from the script (tsx resolves .ts);
 * main() only runs when the script is invoked directly, so importing here
 * has no side effects.
 */

import { describe, it, expect } from 'vitest';
import {
  composeSnapshotLine,
  parseArgs,
  defaultOutPath,
  DEFAULT_URL,
  type OpsEnvelope,
} from '../../scripts/ops/corpus-health-snapshot.js';

const HEALTH: OpsEnvelope = {
  data: {
    active_memory_count: 4400,
    mean_confidence: 0.71,
    contradiction_flagged_count: 2,
    duplicate_pair_count: 134,
    duplicate_pairs: { total: 134, actionable: 0, anchored: 31, cross_scope: 103, condition_linked: 0 },
    decayed_at_risk_count: 12,
  },
  meta: { sample_size: 2000, sampled: true, note: 'bounded sample' },
};

const DIST: OpsEnvelope = {
  data: {
    by_type: [{ type: 'discovery', tier: 'noted', count: 100 }],
    by_tier: { noted: 100, pattern: 0, actionable: 0, confirmed: 0 },
  },
};

describe('composeSnapshotLine', () => {
  it('produces a single-line JSON string with ts, corpus_health, confidence_distribution', () => {
    const line = composeSnapshotLine(HEALTH, DIST, '2026-07-10T12:00:00.000Z');
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed)).toEqual(['ts', 'corpus_health', 'confidence_distribution']);
    expect(parsed.ts).toBe('2026-07-10T12:00:00.000Z');
    expect(parsed.corpus_health.active_memory_count).toBe(4400);
    expect(parsed.corpus_health.duplicate_pairs.actionable).toBe(0);
    expect(parsed.confidence_distribution.by_tier.noted).toBe(100);
  });

  it('folds the corpus-health meta (sample_size/sampled) into corpus_health.meta', () => {
    const parsed = JSON.parse(composeSnapshotLine(HEALTH, DIST, '2026-07-10T12:00:00.000Z'));
    expect(parsed.corpus_health.meta).toEqual({ sample_size: 2000, sampled: true, note: 'bounded sample' });
  });

  it('omits corpus_health.meta when the endpoint returned none', () => {
    const parsed = JSON.parse(
      composeSnapshotLine({ data: { active_memory_count: 1 } }, DIST, '2026-07-10T12:00:00.000Z'),
    );
    expect('meta' in parsed.corpus_health).toBe(false);
  });

  it('two snapshots with different ts / counts produce different lines', () => {
    const a = composeSnapshotLine(HEALTH, DIST, '2026-07-10T12:00:00.000Z');
    const b = composeSnapshotLine(
      { ...HEALTH, data: { ...HEALTH.data, active_memory_count: 4401 } },
      DIST,
      '2026-07-17T12:00:00.000Z',
    );
    expect(a).not.toBe(b);
    expect(JSON.parse(a).corpus_health.active_memory_count).toBe(4400);
    expect(JSON.parse(b).corpus_health.active_memory_count).toBe(4401);
  });
});

describe('parseArgs', () => {
  it('defaults: env url wins over the built-in, out defaults to ~/.kopeng/metrics/corpus-health.jsonl', () => {
    const args = parseArgs([], 'http://envhost:1234', '/home/op');
    expect(args.url).toBe('http://envhost:1234');
    expect(args.outPath).toBe(defaultOutPath('/home/op'));
    expect(args.outPath.replace(/\\/g, '/')).toBe('/home/op/.kopeng/metrics/corpus-health.jsonl');
  });

  it('falls back to the built-in default url when no env url is set', () => {
    expect(parseArgs([], undefined, '/home/op').url).toBe(DEFAULT_URL);
    expect(DEFAULT_URL).toBe('http://localhost:3200');
  });

  it('--url and --out override defaults; trailing slash on url is stripped', () => {
    const args = parseArgs(
      ['--url', 'http://localhost:9999/', '--out', './scratch/verify.jsonl'],
      'http://envhost:1234',
      '/home/op',
    );
    expect(args.url).toBe('http://localhost:9999');
    expect(args.outPath).toBe('./scratch/verify.jsonl');
  });

  it('throws on a flag missing its value', () => {
    expect(() => parseArgs(['--url'], undefined, '/home/op')).toThrow('--url requires a value');
    expect(() => parseArgs(['--out'], undefined, '/home/op')).toThrow('--out requires a value');
  });

  it('throws on unknown arguments (a typo must not silently snapshot elsewhere)', () => {
    expect(() => parseArgs(['--output', 'x.jsonl'], undefined, '/home/op')).toThrow('Unknown argument: --output');
  });
});
