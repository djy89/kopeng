/**
 * Smoke coverage for the dream-effectiveness harness building blocks:
 *  - the pure retrieval metrics factored out of eval-core (P@k/R@k/MRR/NDCG)
 *  - the synthetic corpus shape (it must actually contain the dups + decayed rows
 *    the harness claims dreaming will clean)
 *
 * The full end-to-end pass is exercised by `npm run dream:effectiveness`; this
 * test guards the math + fixtures that the headline depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  computeNDCG, computePrecision, computeRecall, computeMRR, scoreQuery,
} from '../../scripts/lib/retrieval-metrics.js';
import {
  EFFECTIVENESS_CORPUS, EFFECTIVENESS_GOLD, basis, blend,
} from '../../scripts/lib/effectiveness-corpus.js';
import { cosineSimilarity, COSINE_DUPLICATE_THRESHOLD } from '../../src/dreaming/pipeline.js';

describe('retrieval metrics (pure)', () => {
  it('precision = relevant ∩ retrieved / retrieved', () => {
    expect(computePrecision([1, 2, 3, 4], new Set([1, 3]))).toBe(0.5);
    expect(computePrecision([], new Set([1]))).toBe(0);
  });

  it('recall = relevant ∩ retrieved / relevant', () => {
    expect(computeRecall([1, 2], new Set([1, 2, 3, 4]))).toBe(0.5);
    expect(computeRecall([1], new Set())).toBe(0);
  });

  it('MRR = 1 / rank of first relevant hit', () => {
    expect(computeMRR([5, 1, 2], new Set([1]))).toBe(0.5); // first hit at rank 2
    expect(computeMRR([1], new Set([1]))).toBe(1);
    expect(computeMRR([5, 6], new Set([1]))).toBe(0);
  });

  it('NDCG = 1 when the single relevant id ranks first', () => {
    expect(computeNDCG([1, 2, 3], new Set([1]), 3)).toBe(1);
    expect(computeNDCG([2, 1, 3], new Set([1]), 3)).toBeLessThan(1);
    expect(computeNDCG([2, 3], new Set([1]), 3)).toBe(0);
  });

  it('scoreQuery bundles the four metrics', () => {
    const s = scoreQuery([1, 2, 3, 4, 5], [1], 5);
    expect(s.mrr).toBe(1);
    expect(s.ndcg_at_k).toBe(1);
    expect(s.recall_at_k).toBe(1);
    expect(s.precision_at_k).toBeCloseTo(0.2, 5);
  });
});

describe('effectiveness synthetic corpus', () => {
  it('contains exact-dup copies dreaming will collapse', () => {
    const dups = EFFECTIVENESS_CORPUS.filter(m => m.role === 'exact_dup');
    expect(dups.length).toBeGreaterThanOrEqual(3);
    // Each exact_dup normalizes to an anchor's content (case/whitespace only).
    const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const anchorNorms = new Set(
      EFFECTIVENESS_CORPUS.filter(m => m.role === 'anchor').map(m => norm(m.content)),
    );
    for (const d of dups) expect(anchorNorms.has(norm(d.content))).toBe(true);
  });

  it('contains decayed rows below confidence with old last_seen', () => {
    const decayed = EFFECTIVENESS_CORPUS.filter(m => m.role === 'decayed');
    expect(decayed.length).toBeGreaterThanOrEqual(2);
    for (const d of decayed) {
      expect(d.confidence).toBeLessThan(0.5);
      expect(d.last_seen).toBeTruthy();
    }
  });

  it('gold relevance is fact-level (canonical anchor only, not the dup copies)', () => {
    const keys = new Set(EFFECTIVENESS_CORPUS.map(m => m.key));
    const anchorKeys = new Set(
      EFFECTIVENESS_CORPUS.filter(m => m.role === 'anchor').map(m => m.key),
    );
    for (const g of EFFECTIVENESS_GOLD) {
      expect(g.relevant_keys.length).toBeGreaterThan(0);
      for (const k of g.relevant_keys) {
        expect(keys.has(k)).toBe(true);
        // Relevant keys must be anchors — never a soon-to-be-archived dup copy.
        expect(anchorKeys.has(k)).toBe(true);
      }
    }
  });

  it('blend produces an exact cosine against the basis', () => {
    expect(cosineSimilarity(blend(2, 3, 0.98), basis(2))).toBeCloseTo(0.98, 5);
    // The planted paraphrase sits at/above the deterministic dup threshold.
    expect(0.98).toBeGreaterThanOrEqual(COSINE_DUPLICATE_THRESHOLD);
  });
});
