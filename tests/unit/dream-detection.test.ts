/**
 * D1.2 — real candidate detection + deterministic diff (plan §1.2 verify list):
 * exact/cosine≥0.95 collapse tier, 0.85–0.95 reasoner-driven band, evidence
 * gates rejecting burst/low-diversity, Hard-Anchor skip, R6 cross-scope
 * promote-not-collapse, durability-aware decay proposals.
 */
import { describe, it, expect } from 'vitest';
import {
  DuplicateCandidateSelector, DeterministicDiffGenerator, StaticMemorySource, runPipeline,
  cosineSimilarity, pickKeepTarget, COSINE_DUPLICATE_THRESHOLD, NEAR_DUP_BAND_MIN,
} from '../../src/dreaming/pipeline.js';
import { evidenceGate, MIN_DISTINCT_SESSIONS } from '../../src/dreaming/gates.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import type { CandidateMemory, ReasonerContext, PairVerdict } from '../../src/dreaming/reasoner/reasoner.js';

const NOW = new Date('2026-06-15T03:00:00Z');
const DIM = 8;

function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}

function mem(overrides: Partial<CandidateMemory> & { id: number; content: string }): CandidateMemory {
  return {
    content_hash: null,
    summary: null,
    tags: [],
    scope: 'project:x',
    confidence: 0.7,
    is_locked: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    embedding: null,
    metadata: null,
    last_seen: null,
    observation_count: 1,
    ...overrides,
  };
}

/** Burst evidence: one session, one input, zero span — must fail every gate. */
function burstMetadata(): string {
  return JSON.stringify({
    evidence_snapshot: [
      { tool: 'Bash', input_hash: 'h1', session_id: 's1', at: '2026-06-01T10:00:00Z' },
      { tool: 'Bash', input_hash: 'h1', session_id: 's1', at: '2026-06-01T10:01:00Z' },
      { tool: 'Bash', input_hash: 'h1', session_id: 's1', at: '2026-06-01T10:02:00Z' },
    ],
  });
}

/** Diverse evidence: 3 sessions, 2 inputs, multi-day span — passes the gates. */
function diverseMetadata(): string {
  return JSON.stringify({
    evidence_snapshot: [
      { tool: 'Bash', input_hash: 'h1', session_id: 's1', at: '2026-06-01T10:00:00Z' },
      { tool: 'Bash', input_hash: 'h2', session_id: 's2', at: '2026-06-02T15:00:00Z' },
      { tool: 'Bash', input_hash: 'h1', session_id: 's3', at: '2026-06-04T09:00:00Z' },
    ],
  });
}

const selector = new DuplicateCandidateSelector({ now: () => NOW });
const diffGen = new DeterministicDiffGenerator();
const ctx: ReasonerContext = { timeoutMs: 1000 };

async function generate(memories: CandidateMemory[]) {
  const groups = await selector.select(memories);
  return { groups, diff: diffGen.generate(groups.map(group => ({ group, verdict: null }))) };
}

describe('cosineSimilarity', () => {
  it('computes exact cosines for the blend fixtures', async () => {
    expect(cosineSimilarity(basis(0), basis(0))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(basis(0), basis(1))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(basis(0), blend(0, 1, 0.9))).toBeCloseTo(0.9, 6);
  });
});

describe('DuplicateCandidateSelector (D1.2)', () => {
  it('groups exact normalized dups without embeddings', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'Same Fact' }),
      mem({ id: 2, content: 'same   fact' }),
      mem({ id: 3, content: 'different fact' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('exact_duplicate');
    expect(groups[0].members.map(m => m.id).sort()).toEqual([1, 2]);
  });

  it('collapse tier: cosine >= 0.95 groups as semantic_duplicate', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'fact worded one way', embedding: basis(0) }),
      mem({ id: 2, content: 'fact worded differently', embedding: blend(0, 1, 0.96) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('semantic_duplicate');
    expect(groups[0].similarity).toBeCloseTo(0.96, 5);
  });

  it('band tier: 0.85 <= cosine < 0.95 is near_duplicate, never merged transitively', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'deploy on fridays', embedding: basis(0) }),
      mem({ id: 2, content: 'never deploy on fridays', embedding: blend(0, 1, 0.90) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('near_duplicate');
  });

  it('sub-band similarity (cosine < 0.85) produces no group', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'redis stores context', embedding: basis(0) }),
      mem({ id: 2, content: 'redis is optional', embedding: blend(0, 1, 0.7) }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('Hard Anchor: locked and confidence=1.0 memories never enter any tier', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'anchored truth', confidence: 1.0, embedding: basis(0) }),
      mem({ id: 2, content: 'anchored truth', is_locked: true, embedding: basis(0) }),
      mem({ id: 3, content: 'anchored truth', embedding: basis(0) }), // journal twin, now alone
      // anchored + stale: must not produce a decay proposal either
      mem({ id: 4, content: 'old locked memo', is_locked: true, confidence: 0.4, last_seen: '2025-12-01T00:00:00Z' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('R6: same content across scopes is a cross_scope_duplicate, not a same-scope group', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'absolute paths on windows', scope: 'project:a' }),
      mem({ id: 2, content: 'absolute paths on windows', scope: 'global' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('cross_scope_duplicate');
  });

  it('decay tier: stale low-confidence memory yields a single decayed group; fresh does not', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'stale workaround', confidence: 0.45, last_seen: '2026-01-05T00:00:00Z' }),
      mem({ id: 2, content: 'fresh note', confidence: 0.7, last_seen: '2026-06-10T00:00:00Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('decayed');
    expect(groups[0].kind).toBe('single');
    expect(groups[0].members[0].id).toBe(1);
  });

  it('durability rescues a stale memory from the decay tier (D1.1 integration)', async () => {
    const { groups } = await generate([
      mem({ id: 1, content: 'stale but heavily evidenced', confidence: 0.45, last_seen: '2026-01-05T00:00:00Z', observation_count: 40 }),
    ]);
    expect(groups).toHaveLength(0); // durability 4.7 → effective days ~34 → strength ~0.3
  });
});

describe('evidence gates (D1.2)', () => {
  it('rejects single-session burst evidence with reasons', async () => {
    const result = evidenceGate([mem({ id: 1, content: 'x', metadata: burstMetadata() })]);
    expect(result.pass).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2); // sessions + span (+ inputs)
    expect(result.reasons.join(' ')).toContain(`${MIN_DISTINCT_SESSIONS}`);
  });

  it('passes diverse cross-session evidence', async () => {
    expect(evidenceGate([mem({ id: 1, content: 'x', metadata: diverseMetadata() })]).pass).toBe(true);
  });

  it('passes trivially when no member carries evidence (operator-written memories)', async () => {
    const result = evidenceGate([mem({ id: 1, content: 'x' }), mem({ id: 2, content: 'y' })]);
    expect(result.pass).toBe(true);
    expect(result.evidence_count).toBe(0);
  });
});

describe('DeterministicDiffGenerator (D1.2)', () => {
  it('exact dups → exact_dup, deterministic-safe, keep the highest-confidence copy', async () => {
    const { diff } = await generate([
      mem({ id: 1, content: 'same fact', confidence: 0.6 }),
      mem({ id: 2, content: 'Same Fact', confidence: 0.8 }),
    ]);
    expect(diff.entries).toHaveLength(1);
    const e = diff.entries[0];
    expect(e.change_class).toBe('exact_dup');
    expect(e.tier).toBe('deterministic-safe');
    expect((e.after as { keep_id: number }).keep_id).toBe(2);
    expect((e.after as { archive_ids: number[] }).archive_ids).toEqual([1]);
  });

  it('semantic dup with diverse evidence stays deterministic-safe; burst evidence demotes it', async () => {
    const safe = (await generate([
      mem({ id: 1, content: 'fact A', embedding: basis(0), metadata: diverseMetadata() }),
      mem({ id: 2, content: 'fact A reworded', embedding: blend(0, 1, 0.97), metadata: diverseMetadata() }),
    ])).diff.entries[0];
    expect(safe.change_class).toBe('merge');
    expect(safe.tier).toBe('deterministic-safe');

    const demoted = (await generate([
      mem({ id: 1, content: 'fact B', embedding: basis(0), metadata: burstMetadata() }),
      mem({ id: 2, content: 'fact B reworded', embedding: blend(0, 1, 0.97), metadata: burstMetadata() }),
    ])).diff.entries[0];
    expect(demoted.change_class).toBe('merge');
    expect(demoted.tier).toBe('reasoner-driven'); // gates reject burst/low-diversity
    expect(demoted.rationale).toContain('gates failed');
  });

  it('band pairs → merge, reasoner-driven, no apply proposal', async () => {
    const { diff } = await generate([
      mem({ id: 1, content: 'deploy fridays', embedding: basis(0) }),
      mem({ id: 2, content: 'never deploy fridays', embedding: blend(0, 1, 0.9) }),
    ]);
    expect(diff.entries[0].tier).toBe('reasoner-driven');
    expect(diff.entries[0].after).toBeUndefined();
  });

  it('cross-scope dup → promote_global with source ids, never a collapse', async () => {
    const { diff } = await generate([
      mem({ id: 1, content: 'shared fact', scope: 'project:a' }),
      mem({ id: 2, content: 'shared fact', scope: 'project:b' }),
    ]);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].change_class).toBe('promote_global');
    expect((diff.entries[0].after as { promote_scope: string }).promote_scope).toBe('global');
  });

  it('thresholds are what the plan says they are', async () => {
    expect(COSINE_DUPLICATE_THRESHOLD).toBe(0.95);
    expect(NEAR_DUP_BAND_MIN).toBe(0.85);
  });
});

describe('pickKeepTarget', () => {
  it('prefers confidence, then recency, then lowest id', async () => {
    expect(pickKeepTarget([
      mem({ id: 1, content: 'x', confidence: 0.6 }),
      mem({ id: 2, content: 'x', confidence: 0.8 }),
    ]).id).toBe(2);
    expect(pickKeepTarget([
      mem({ id: 1, content: 'x', last_seen: '2026-06-01T00:00:00Z' }),
      mem({ id: 2, content: 'x', last_seen: '2026-06-10T00:00:00Z' }),
    ]).id).toBe(2);
    expect(pickKeepTarget([mem({ id: 5, content: 'x' }), mem({ id: 3, content: 'x' })]).id).toBe(3);
  });
});

describe('runPipeline classification routing (LLM-last)', () => {
  class SpyReasoner extends NoOpReasoner {
    pairs: Array<[number, number]> = [];
    override async classifyPair(a: CandidateMemory, b: CandidateMemory, c: ReasonerContext): Promise<PairVerdict> {
      this.pairs.push([a.id, b.id]);
      return super.classifyPair(a, b, c);
    }
  }

  it('classifies only near-dup band pairs — deterministic signals skip the reasoner', async () => {
    const spy = new SpyReasoner();
    const source = new StaticMemorySource([
      mem({ id: 1, content: 'exact dup' }),
      mem({ id: 2, content: 'EXACT DUP' }),                                       // exact pair → skip
      mem({ id: 3, content: 'banded a', embedding: basis(2) }),
      mem({ id: 4, content: 'banded b', embedding: blend(2, 3, 0.9) }),           // band pair → classify
      mem({ id: 5, content: 'cross', scope: 'project:a' }),
      mem({ id: 6, content: 'cross', scope: 'project:b' }),                       // cross-scope → skip
    ]);
    const result = await runPipeline(source, selector, spy, diffGen, ctx);
    expect(result.candidates).toHaveLength(3);
    expect(spy.pairs).toEqual([[3, 4]]);
  });
});
