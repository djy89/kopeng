import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { runReplay, runScenario } from '../../src/dreaming/replay.js';
import { SYNTHETIC_CORPUS, GOLD_CASES, ANCHOR_DECOYS } from '../fixtures/dreaming/corpus.js';
import { R2_SCENARIOS } from '../fixtures/dreaming/r2-scenarios.js';

/**
 * D0.7 — replay + metrics harness over the synthetic gold set. Zero LLM calls
 * everywhere (NoOpReasoner); the Phase-0 baseline is: normalized-content dups
 * detected, later-phase classes not yet, empty diff, anchored memories invisible.
 */
describe('dream replay harness (D0.7)', () => {
  const NOW = Date.parse('2026-06-15T03:00:00Z'); // local day 2026-06-15 in UTC

  function freshStore() {
    return new DreamQueries(createTestDatabase().db);
  }

  async function replay(corpus = SYNTHETIC_CORPUS) {
    const store = freshStore();
    const result = await runReplay({ corpus, gold: GOLD_CASES, dreamStore: store, now: () => NOW });
    return { store, ...result };
  }

  it('fixture integrity: every gold member id exists exactly once in the corpus', () => {
    const corpusIds = SYNTHETIC_CORPUS.map(m => m.id);
    expect(new Set(corpusIds).size).toBe(corpusIds.length);
    for (const gold of GOLD_CASES) {
      for (const id of gold.member_ids) {
        expect(corpusIds, `gold case ${gold.id} references missing memory ${id}`).toContain(id);
      }
    }
  });

  it('full pass with NoOpReasoner: empty diff, correct dreams row, zero LLM calls', async () => {
    const { store, run, metrics } = await replay();

    expect(run.status).toBe('completed');
    expect(run.window_key).toBe('2026-06-15');
    expect(run.memories_examined).toBe(SYNTHETIC_CORPUS.length);
    expect(run.changes_proposed).toBe(0);

    const dream = await store.getDream(run.dream_id!);
    expect(dream!.status).toBe('completed');
    expect(dream!.acceptance_status).toBe('empty');
    expect(dream!.memories_examined).toBe(SYNTHETIC_CORPUS.length);
    expect(JSON.parse(dream!.output_diff!)).toEqual({ entries: [] });

    expect(metrics.diff.entries_total).toBe(0);
    expect(metrics.diff.by_change_class).toEqual({});
    expect(metrics.reasoner.name).toBe('noop');
    expect(metrics.reasoner.llm_calls).toBe(0);
    // The reasoner interface IS exercised (pair groups get classified) — just with no model behind it.
    expect(metrics.reasoner.classify_calls).toBeGreaterThan(0);
  });

  it('detection metrics: phase-0 cases fully recalled, later-phase classes not yet, zero false positives', async () => {
    const { metrics } = await replay();
    const d = metrics.detection;

    // Phase-0 detectable: dup-exact-pair, dup-exact-cluster, cross-scope-dup.
    expect(d.phase0_recall).toBe(1);
    expect(d.gold_detected).toBe(GOLD_CASES.filter(g => g.detectable_phase === 0).length);
    expect(d.recall).toBeCloseTo(d.gold_detected / GOLD_CASES.length);

    // Distractors and later-phase cases produce no groups → perfect precision.
    expect(d.false_positive_groups).toBe(0);
    expect(d.precision).toBe(1);
    expect(d.false_positive_rate).toBe(0);

    expect(d.by_class.duplicate).toEqual({ total: 6, detected: 2 }); // paraphrase + the 3 straddle pairs wait for 1.2
    expect(d.by_class.cross_scope_duplicate).toEqual({ total: 1, detected: 1 });
    expect(d.by_class.contradiction).toEqual({ total: 1, detected: 0 }); // waits for phase 2
    expect(d.by_class.preference_change).toEqual({ total: 1, detected: 0 }); // waits for phase 2
  });

  it('Hard Anchor: anchored memories never appear in candidates or diff', async () => {
    const { metrics } = await replay();
    expect(metrics.anchor_violations).toEqual([]);
  });

  it('anchor decoys are real bait: stripping the anchor exposes the duplicate pairs', async () => {
    const unanchored = SYNTHETIC_CORPUS.map(m =>
      ANCHOR_DECOYS.some(d => d.anchored_id === m.id)
        ? { ...m, confidence: 0.7, is_locked: false }
        : m,
    );
    const { metrics } = await replay(unanchored);

    // Both decoy pairs now group — and since they are not gold cases, they
    // surface as false positives. This proves the anchored fixtures would be
    // detected if the Hard-Anchor bypass ever regressed.
    expect(metrics.detection.false_positive_groups).toBe(ANCHOR_DECOYS.length);
    expect(metrics.anchor_violations).toEqual([]); // nothing is anchored anymore
  });

  for (const scenario of R2_SCENARIOS) {
    it(`R2 scenario: ${scenario.name}`, async () => {
      const result = await runScenario(scenario, freshStore, { now: () => NOW });
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
