import { describe, it, expect } from 'vitest';
import {
  WindowedCandidateSelector, EmptyDiffGenerator, StaticMemorySource, runPipeline, isAnchored,
  classifyDupPair,
} from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import type { CandidateMemory, ReasonerContext } from '../../src/dreaming/reasoner/reasoner.js';

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
    ...overrides,
  };
}

const ctx: ReasonerContext = { timeoutMs: 1000 };

describe('NoOpReasoner (D0.3)', () => {
  const r = new NoOpReasoner();
  const a = mem({ id: 1, content: 'a' });
  const b = mem({ id: 2, content: 'b' });

  it('classifies every pair as unrelated with confidence 0', async () => {
    const v = await r.classifyPair(a, b, ctx);
    expect(v.relation).toBe('unrelated');
    expect(v.confidence).toBe(0);
  });

  it('extracts no conditions and synthesizes no clusters', async () => {
    expect(await r.extractCondition(a, b, ctx)).toBeNull();
    expect(await r.synthesizeCluster([a, b], ctx)).toBeNull();
  });
});

describe('Hard-Anchor predicate (D0.3)', () => {
  it('anchors locked or confidence>=1.0 memories; journal-tier is in-scope', () => {
    expect(isAnchored(mem({ id: 1, content: 'x', confidence: 1.0 }))).toBe(true);
    expect(isAnchored(mem({ id: 2, content: 'x', is_locked: true }))).toBe(true);
    expect(isAnchored(mem({ id: 3, content: 'x', confidence: 0.7 }))).toBe(false);
  });
});

describe('classifyDupPair (ops corpus-health breakdown)', () => {
  it('buckets a pair with any anchored member as anchored (Hard Anchor wins)', () => {
    expect(classifyDupPair(
      mem({ id: 1, content: 'x', confidence: 1.0 }),
      mem({ id: 2, content: 'x' }),
    )).toBe('anchored');
    expect(classifyDupPair(
      mem({ id: 1, content: 'x' }),
      mem({ id: 2, content: 'x', is_locked: true }),
    )).toBe('anchored');
  });

  it('anchored takes precedence over cross-scope (mirrors the selector eligibility filter)', () => {
    expect(classifyDupPair(
      mem({ id: 1, content: 'x', confidence: 1.0, scope: 'project:a' }),
      mem({ id: 2, content: 'x', scope: 'project:b' }),
    )).toBe('anchored');
  });

  it('buckets unanchored different-scope pairs as cross_scope', () => {
    expect(classifyDupPair(
      mem({ id: 1, content: 'x', scope: 'project:a' }),
      mem({ id: 2, content: 'x', scope: 'project:b' }),
    )).toBe('cross_scope');
  });

  it('buckets a condition-encoding and its source as condition_linked (either direction)', () => {
    const encoded = mem({ id: 3, content: 'when x → a; when y → b', metadata: JSON.stringify({ condition_sources: [1, 2] }) });
    const source = mem({ id: 1, content: 'a' });
    expect(classifyDupPair(encoded, source)).toBe('condition_linked');
    expect(classifyDupPair(source, encoded)).toBe('condition_linked');
  });

  it('buckets same-scope unanchored non-provenance pairs as actionable', () => {
    expect(classifyDupPair(
      mem({ id: 1, content: 'x' }),
      mem({ id: 2, content: 'x almost' }),
    )).toBe('actionable');
  });

  it('treats malformed metadata as no provenance link (actionable)', () => {
    expect(classifyDupPair(
      mem({ id: 1, content: 'x', metadata: '{not json' }),
      mem({ id: 2, content: 'x' }),
    )).toBe('actionable');
  });
});

describe('WindowedCandidateSelector (D0.3)', () => {
  const selector = new WindowedCandidateSelector();

  it('groups near-duplicates by normalized content (case/whitespace insensitive)', () => {
    const groups = selector.select([
      mem({ id: 1, content: 'Hello World' }),
      mem({ id: 2, content: 'hello   world' }),
      mem({ id: 3, content: 'unrelated note' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('pair');
    expect(groups[0].members.map(m => m.id).sort()).toEqual([1, 2]);
  });

  it('emits a cluster for 3+ near-dups', () => {
    const groups = selector.select([
      mem({ id: 1, content: 'dup' }),
      mem({ id: 2, content: 'DUP' }),
      mem({ id: 3, content: ' dup ' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('cluster');
    expect(groups[0].members).toHaveLength(3);
  });

  it('excludes anchored memories even when they are exact dups', () => {
    const groups = selector.select([
      mem({ id: 1, content: 'same', confidence: 1.0 }),   // anchored
      mem({ id: 2, content: 'same', is_locked: true }),   // anchored
      mem({ id: 3, content: 'same', confidence: 0.7 }),   // in-scope, but now alone
    ]);
    expect(groups).toHaveLength(0); // only one eligible member → no group
  });

  it('returns no groups when nothing is similar', () => {
    expect(selector.select([mem({ id: 1, content: 'a' }), mem({ id: 2, content: 'b' })])).toEqual([]);
  });
});

describe('runPipeline (D0.3)', () => {
  it('runs end-to-end with NoOp reasoner and produces an empty diff', async () => {
    const source = new StaticMemorySource([
      mem({ id: 1, content: 'Hello World' }),
      mem({ id: 2, content: 'hello world' }),
      mem({ id: 3, content: 'something else' }),
    ]);
    const result = await runPipeline(
      source, new WindowedCandidateSelector(), new NoOpReasoner(), new EmptyDiffGenerator(), ctx,
    );
    expect(result.memoriesExamined).toBe(3);
    expect(result.candidates).toHaveLength(1);            // the near-dup pair was selected
    expect(result.candidates[0].members.map(m => m.id).sort()).toEqual([1, 2]);
    expect(result.diff.entries).toEqual([]);              // NoOp → empty diff
  });

  it('examines zero candidates when all memories are anchored', async () => {
    const source = new StaticMemorySource([
      mem({ id: 1, content: 'dup', confidence: 1.0 }),
      mem({ id: 2, content: 'dup', is_locked: true }),
    ]);
    const result = await runPipeline(
      source, new WindowedCandidateSelector(), new NoOpReasoner(), new EmptyDiffGenerator(), ctx,
    );
    expect(result.memoriesExamined).toBe(2);
    expect(result.candidates).toHaveLength(0);
    expect(result.diff.entries).toEqual([]);
  });
});
