import { describe, it, expect } from 'vitest';
import { DuplicateCandidateSelector, DeterministicDiffGenerator, classifyDupPair } from '../../src/dreaming/pipeline.js';
import type { CandidateMemory } from '../../src/dreaming/reasoner/reasoner.js';

// Hand-crafted unit vectors, replay-harness style — cosine 1.0 between a/b.
const VEC = new Float32Array(384); VEC[0] = 1;

function mem(id: number, scope: string, content: string): CandidateMemory {
  return {
    id, content, content_hash: `hash-${content}`, summary: null, tags: [],
    scope, confidence: 0.6, is_locked: 0, type: 'project',
    created_at: '2026-06-01 00:00:00', updated_at: '2026-06-14 00:00:00',
    last_seen: '2026-06-14 00:00:00', observation_count: 5, embedding: VEC,
  } as CandidateMemory;
}

const TABLE: Record<string, string> = { 'client:Acme-Foods': 'client:acme-foods' };
const canonicalize = (s: string) => TABLE[s] ?? s;

describe('alias-aware selector (Phase 2)', () => {
  it('without canonicalize, alias variants look cross-scope (today\'s behavior)', async () => {
    const groups = await new DuplicateCandidateSelector({ now: () => new Date('2026-06-15T00:00:00Z') })
      .select([mem(1, 'client:Acme-Foods', 'same fact'), mem(2, 'client:acme-foods', 'same fact')]);
    expect(groups.some(g => g.signal === 'cross_scope_duplicate')).toBe(true);
    expect(groups.some(g => g.signal === 'exact_duplicate')).toBe(false);
  });

  it('with canonicalize, alias variants collapse to a same-scope exact dup', async () => {
    const groups = await new DuplicateCandidateSelector({ now: () => new Date('2026-06-15T00:00:00Z'), canonicalize })
      .select([mem(1, 'client:Acme-Foods', 'same fact'), mem(2, 'client:acme-foods', 'same fact')]);
    expect(groups.some(g => g.signal === 'exact_duplicate')).toBe(true);
    expect(groups.some(g => g.signal === 'cross_scope_duplicate')).toBe(false);
  });
});

describe('diff provenance (Phase 2)', () => {
  it('stamps hashes, raw + effective scope, and the alias table version on every entry', async () => {
    const groups = await new DuplicateCandidateSelector({ now: () => new Date('2026-06-15T00:00:00Z'), canonicalize })
      .select([mem(1, 'client:Acme-Foods', 'same fact'), mem(2, 'client:acme-foods', 'same fact')]);
    const diff = new DeterministicDiffGenerator({ aliasVersion: 'v-test-123', canonicalize })
      .generate(groups.map(group => ({ group })));
    expect(diff.entries.length).toBeGreaterThan(0);
    for (const e of diff.entries) {
      expect(e.provenance?.alias_table_version).toBe('v-test-123');
      const m1 = e.provenance?.members.find(m => m.id === 1);
      expect(m1?.scope).toBe('client:Acme-Foods');
      expect(m1?.effective_scope).toBe('client:acme-foods');
      expect(m1?.content_hash).toBe('hash-same fact');
    }
  });
});

// Team-review #22 A2: the corpus-health duplicate breakdown claims to use "the
// SAME predicates as the selector". That is only true if BOTH sides see the
// alias table — this suite pins the agreement so a consumer can't grow its own
// scope semantics again (the Phase-1 composition-net pattern).
describe('ops metric ↔ selector agreement on alias variants (team-review #22)', () => {
  it('classifyDupPair with the closure buckets an alias pair `actionable`, matching the selector\'s same-scope collapse', async () => {
    const a = mem(1, 'client:Acme-Foods', 'same fact');
    const b = mem(2, 'client:acme-foods', 'same fact');

    // Selector verdict: same-scope exact dup (collapse tier — dreaming's to fix).
    const groups = await new DuplicateCandidateSelector({ now: () => new Date('2026-06-15T00:00:00Z'), canonicalize })
      .select([a, b]);
    expect(groups.some(g => g.signal === 'exact_duplicate')).toBe(true);

    // Ops-metric verdict with the SAME closure: actionable (not cross_scope).
    expect(classifyDupPair(a, b, canonicalize)).toBe('actionable');

    // And the divergence the finding describes: no closure ⇒ cross_scope —
    // the watchdog would read healthy during the exact state it must expose.
    expect(classifyDupPair(a, b)).toBe('cross_scope');
  });
});
