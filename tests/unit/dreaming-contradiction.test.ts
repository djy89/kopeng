/**
 * D2.2 — reasoner-driven supersession/contradiction routing (plan §2.2 verify list):
 * "pnpm"→"bun" produces a supersession (NOT a silent reinforce); conditional
 * cases encode the branch; contested never auto-picks; unrelated suppresses the
 * junk merge; NOTHING auto-applies — every reasoner outcome lands as pending
 * even with every auto_accept_* flag ON. Plus the ingestion guard
 * (classify-before-reinforce), flag lifecycle, selector guards, the supersede/
 * conditional apply executors, and the v7 migration surface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import {
  runDreamPass, DbWindowMemorySource, withFlaggedPairs, type DreamEngineDeps,
} from '../../src/dreaming/dream-engine.js';
import {
  DuplicateCandidateSelector, DeterministicDiffGenerator, StaticMemorySource, runPipeline,
  type CandidateGroup,
} from '../../src/dreaming/pipeline.js';
import {
  MIN_VERDICT_CONFIDENCE, isConsumableVerdict, pickSupersessionOrder, routeClassifiedPair,
  encodeConditionalContent, classifyForIngestion, buildContradictionFlag, readContradictionFlag,
  CONTRADICTION_FLAG_TAG, CONTRADICTION_FLAG_KEY,
} from '../../src/dreaming/contradiction.js';
import { resolveDream, rollbackMemory, applyEntry, type ApplyDeps } from '../../src/dreaming/apply.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import type {
  ConsolidationReasoner, CandidateMemory, ReasonerContext, PairVerdict, ConditionExtraction, ClusterSynthesis,
} from '../../src/dreaming/reasoner/reasoner.js';
import type { DreamDiff, DreamDiffEntry } from '../../src/types/types.js';

const NOW = Date.parse('2026-06-15T03:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const DIM = 8;

function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

/** Unit vector with cosine `w` against basis(i). */
function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}

function toBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(0));
}

/** Pure CandidateMemory builder for selector/router unit tests. */
function cm(
  id: number,
  content: string,
  embedding: Float32Array | null,
  opts: Partial<CandidateMemory> = {},
): CandidateMemory {
  return {
    id,
    content,
    content_hash: `hash-${id}`,
    summary: null,
    tags: [],
    scope: 'project:x',
    confidence: 0.7,
    is_locked: false,
    created_at: '2026-05-20T12:00:00Z',
    updated_at: '2026-05-20T12:00:00Z',
    embedding,
    metadata: null,
    last_seen: '2026-06-14T12:00:00Z',
    observation_count: 1,
    ...opts,
  };
}

/** Scripted reasoner: fixed verdict + extraction, call counting. */
class FakeReasoner implements ConsolidationReasoner {
  readonly name = 'fake';
  classifyCalls = 0;
  extractCalls = 0;
  constructor(
    private readonly verdict: PairVerdict,
    private readonly extraction: ConditionExtraction | null = null,
  ) {}
  async classifyPair(_a: CandidateMemory, _b: CandidateMemory, _ctx: ReasonerContext): Promise<PairVerdict> {
    this.classifyCalls++;
    return this.verdict;
  }
  async extractCondition(_a: CandidateMemory, _b: CandidateMemory, _ctx: ReasonerContext): Promise<ConditionExtraction | null> {
    this.extractCalls++;
    return this.extraction;
  }
  async synthesizeCluster(_m: CandidateMemory[], _ctx: ReasonerContext): Promise<ClusterSynthesis | null> {
    return null;
  }
}

const verdict = (relation: PairVerdict['relation'], confidence = 0.9): PairVerdict => ({
  relation, confidence, rationale: 'decisive evidence cited from both memory texts',
});

const bandPair = (a: CandidateMemory, b: CandidateMemory): CandidateGroup => ({
  kind: 'pair', members: [a, b], signal: 'near_duplicate', similarity: 0.88,
});

// ── routing core (pure) ──

describe('D2.2 verdict routing (contradiction.ts)', () => {
  const older = cm(1, 'Use pnpm for installs in this repo.', basis(0), { created_at: '2026-05-01T12:00:00Z', updated_at: '2026-05-01T12:00:00Z' });
  const newer = cm(2, 'Use bun for installs in this repo (changed from pnpm).', blend(0, 1, 0.88), { created_at: '2026-06-05T09:00:00Z', updated_at: '2026-06-05T09:00:00Z' });

  it('isConsumableVerdict: NoOp/low-confidence/uncited verdicts are never consumed', () => {
    expect(isConsumableVerdict(null)).toBe(false);
    expect(isConsumableVerdict({ relation: 'unrelated', confidence: 0, rationale: 'noop reasoner: no classification' })).toBe(false);
    expect(isConsumableVerdict({ relation: 'duplicate', confidence: MIN_VERDICT_CONFIDENCE - 0.01, rationale: 'long enough rationale here' })).toBe(false);
    expect(isConsumableVerdict({ relation: 'duplicate', confidence: 0.9, rationale: 'short' })).toBe(false);
    expect(isConsumableVerdict(verdict('duplicate'))).toBe(true);
  });

  it('pickSupersessionOrder: created_at, then updated_at, then no-distinguisher → null', () => {
    expect(pickSupersessionOrder(older, newer)).toEqual({ deprecated: older, current: newer });
    expect(pickSupersessionOrder(newer, older)).toEqual({ deprecated: older, current: newer });

    const a = cm(3, 'a', null, { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-02T00:00:00Z' });
    const b = cm(4, 'b', null, { created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-03T00:00:00Z' });
    expect(pickSupersessionOrder(a, b)).toEqual({ deprecated: a, current: b });

    const tieA = cm(5, 'a', null);
    const tieB = cm(6, 'b', null);
    expect(pickSupersessionOrder(tieA, tieB)).toBeNull();
  });

  it('duplicate → reasoner-driven merge with a keep/archive proposal', () => {
    const entry = routeClassifiedPair(bandPair(older, newer), verdict('duplicate'), null)!;
    expect(entry.change_class).toBe('merge');
    expect(entry.tier).toBe('reasoner-driven');
    expect(entry.after).toEqual({ keep_id: 1, archive_ids: [2] }); // equal confidence → most recently seen... ids tie-break
    expect(entry.rationale).toContain('decisive evidence');
  });

  it('preference_change → supersession (old deprecated, new current, both kept)', () => {
    const entry = routeClassifiedPair(bandPair(older, newer), verdict('preference_change'), null)!;
    expect(entry.change_class).toBe('supersede');
    expect(entry.tier).toBe('reasoner-driven');
    expect(entry.after).toEqual({ supersede: { deprecated_id: 1, current_id: 2 } });
    expect(entry.rationale).toMatch(/supersession, not a truth contest/);
  });

  it('preference_change with indistinguishable timestamps → contested (never auto-pick)', () => {
    const tieA = cm(7, 'always deploy on fridays', basis(2));
    const tieB = cm(8, 'never deploy on fridays', blend(2, 3, 0.9));
    const entry = routeClassifiedPair(bandPair(tieA, tieB), verdict('preference_change'), null)!;
    expect(entry.change_class).toBe('contested');
    expect(entry.after).toBeUndefined();
  });

  it('conditional + extraction → branch encoding with provenance to both', () => {
    const a = cm(9, 'Use PostgreSQL as the database backend.', basis(4), { created_at: '2026-05-01T00:00:00Z' });
    const b = cm(10, 'Use SQLite as the database backend.', blend(4, 5, 0.87));
    const extraction: ConditionExtraction = {
      conditionA: 'in production deployments',
      conditionB: 'during local development',
      rationale: 'A names production, B names local development',
    };
    const entry = routeClassifiedPair(bandPair(a, b), verdict('conditional'), extraction)!;
    expect(entry.change_class).toBe('conditional');
    expect(entry.tier).toBe('reasoner-driven');
    const encode = (entry.after as { encode: { content: string; source_ids: number[] } }).encode;
    expect(encode.source_ids).toEqual([9, 10]);
    expect(encode.content).toBe(
      'When in production deployments: Use PostgreSQL as the database backend.\nWhen during local development: Use SQLite as the database backend.',
    );
    expect(encode.content).toBe(encodeConditionalContent(a, b, extraction));
  });

  it('conditional WITHOUT an extractable distinguisher → contested', () => {
    const entry = routeClassifiedPair(bandPair(older, newer), verdict('conditional'), null)!;
    expect(entry.change_class).toBe('contested');
  });

  it('contested → contested entry; unrelated → no entry at all', () => {
    expect(routeClassifiedPair(bandPair(older, newer), verdict('contested'), null)!.change_class).toBe('contested');
    expect(routeClassifiedPair(bandPair(older, newer), verdict('unrelated'), null)).toBeNull();
  });

  it('unconsumable verdict falls back to Phase-1: band → queued merge, flagged → contested', () => {
    const noop: PairVerdict = { relation: 'unrelated', confidence: 0, rationale: 'noop reasoner: no classification' };
    const band = routeClassifiedPair(bandPair(older, newer), noop, null)!;
    expect(band.change_class).toBe('merge');
    expect(band.tier).toBe('reasoner-driven');
    expect(band.after).toBeUndefined(); // no machine action — exactly the D1.3 band entry

    const flagged: CandidateGroup = { kind: 'pair', members: [older, newer], signal: 'flagged_contradiction', similarity: 0.88 };
    const entry = routeClassifiedPair(flagged, noop, null)!;
    expect(entry.change_class).toBe('contested');
  });

  it('every routed entry is reasoner-driven (the auto-apply gate can never cover it)', () => {
    for (const relation of ['duplicate', 'preference_change', 'conditional', 'contested'] as const) {
      const entry = routeClassifiedPair(bandPair(older, newer), verdict(relation), {
        conditionA: 'x', conditionB: 'y', rationale: 'distinguisher cited',
      });
      if (entry) expect(entry.tier).toBe('reasoner-driven');
    }
  });
});

// ── ingestion guard (classify BEFORE reinforce) ──

describe('D2.2 ingestion guard (classifyForIngestion)', () => {
  const existing = cm(1, 'Use pnpm for installs.', null);
  const incoming = cm(-1, 'Use bun for installs (changed from pnpm).', null);
  const ctx: ReasonerContext = { timeoutMs: 1000 };

  it('confident duplicate → reinforce (the verified Phase-1 path)', async () => {
    const route = await classifyForIngestion(new FakeReasoner(verdict('duplicate')), existing, incoming, ctx);
    expect(route.action).toBe('reinforce');
  });

  it('preference_change/conditional/contested → create_flagged (never reinforce, never pick)', async () => {
    for (const relation of ['preference_change', 'conditional', 'contested'] as const) {
      const route = await classifyForIngestion(new FakeReasoner(verdict(relation)), existing, incoming, ctx);
      expect(route.action).toBe('create_flagged');
    }
  });

  it('confident unrelated (R13 template class) → create without reinforcement', async () => {
    const route = await classifyForIngestion(new FakeReasoner(verdict('unrelated')), existing, incoming, ctx);
    expect(route.action).toBe('create');
  });

  it('NoOp / throwing reasoner → Phase-1 reinforce (flag-off behavior preserved)', async () => {
    expect((await classifyForIngestion(new NoOpReasoner(), existing, incoming, ctx)).action).toBe('reinforce');
    const thrower: ConsolidationReasoner = {
      name: 'broken',
      classifyPair: async () => { throw new Error('provider exploded'); },
      extractCondition: async () => null,
      synthesizeCluster: async () => null,
    };
    expect((await classifyForIngestion(thrower, existing, incoming, ctx)).action).toBe('reinforce');
  });

  it('flag blob round-trips through metadata', () => {
    const flag = buildContradictionFlag(42, verdict('preference_change'), NOW_ISO);
    const metadata = JSON.stringify({ [CONTRADICTION_FLAG_KEY]: flag, other: true });
    expect(readContradictionFlag(metadata)).toEqual(flag);
    expect(readContradictionFlag('{}')).toBeNull();
    expect(readContradictionFlag('not json')).toBeNull();
  });
});

// ── selector guards ──

describe('D2.2 selector guards (DuplicateCandidateSelector)', () => {
  const selector = new DuplicateCandidateSelector({ now: () => new Date(NOW) });

  it('flagged pairs are claimed first as flagged_contradiction groups', async () => {
    const a = cm(1, 'Use pnpm for installs.', basis(0));
    const b = cm(2, 'Use bun for installs.', blend(0, 1, 0.88), {
      tags: [CONTRADICTION_FLAG_TAG],
      metadata: JSON.stringify({ [CONTRADICTION_FLAG_KEY]: buildContradictionFlag(1, verdict('preference_change'), NOW_ISO) }),
    });
    const groups = await selector.select([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('flagged_contradiction');
    expect(groups[0].members.map(m => m.id)).toEqual([1, 2]); // [partner, flagged]
    expect(groups[0].similarity).toBeCloseTo(0.88, 5);
  });

  it('an anchored partner produces no flagged group (Hard Anchor wins)', async () => {
    const anchored = cm(1, 'Operator-confirmed truth.', basis(0), { confidence: 1.0 });
    const flagged = cm(2, 'Contradicting discovery.', blend(0, 1, 0.9), {
      tags: [CONTRADICTION_FLAG_TAG],
      metadata: JSON.stringify({ [CONTRADICTION_FLAG_KEY]: buildContradictionFlag(1, verdict('contested'), NOW_ISO) }),
    });
    expect(await selector.select([anchored, flagged])).toHaveLength(0);
  });

  it('band pairs touching a deprecated memory are not re-litigated', async () => {
    const deprecated = cm(1, 'Use pnpm for installs.', basis(0), { deprecated_at: '2026-06-10T00:00:00Z' });
    const current = cm(2, 'Use bun for installs.', blend(0, 1, 0.9));
    expect(await selector.select([deprecated, current])).toHaveLength(0);
  });

  it('a pair where BOTH carry last_contradicted is not re-banded', async () => {
    const a = cm(1, 'Use PostgreSQL in production.', basis(0), { last_contradicted: NOW_ISO });
    const b = cm(2, 'Use SQLite locally.', blend(0, 1, 0.9), { last_contradicted: NOW_ISO });
    expect(await selector.select([a, b])).toHaveLength(0);
  });

  it('condition-provenance links are never dup edges (collapse or band)', async () => {
    const source = cm(1, 'Use PostgreSQL as the database backend.', basis(0));
    const encoded = cm(3, 'When in production: Use PostgreSQL as the database backend.', blend(0, 1, 0.97), {
      metadata: JSON.stringify({ condition_sources: [1, 2] }),
    });
    expect(await selector.select([source, encoded])).toHaveLength(0);
  });
});

// ── end-to-end: pnpm→bun through a real dream pass ──

describe('D2.2 end-to-end (scratch SQLite)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let index: EmbeddingIndex;

  beforeEach(async () => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    index = new EmbeddingIndex();
    await index.loadFromDatabase([]);
  });

  async function storeMem(opts: {
    content: string;
    vec?: Float32Array;
    confidence?: number;
    tags?: string[];
    metadata?: string;
    created?: string;
  }): Promise<number> {
    const { id } = await queries.store({
      content: opts.content,
      type: 'discovery',
      scope: 'project:x',
      source: 'auto-discovery',
      source_path: null,
      metadata: opts.metadata ?? '{}',
      embedding: opts.vec ? toBuffer(opts.vec) : null,
      embedding_model: 'test',
      created_by: null,
      tags: opts.tags ?? [],
      confidence: opts.confidence ?? 0.7,
    });
    if (opts.vec) await index.add(id, opts.vec);
    const created = opts.created ?? '2026-06-05T09:00:00Z';
    db.prepare(`UPDATE memories SET created_at = ?, updated_at = ?, last_seen = ? WHERE id = ?`)
      .run(created, created, '2026-06-14T12:00:00Z', id);
    return id;
  }

  function engineDeps(reasoner: ConsolidationReasoner, overrides: Partial<DreamEngineDeps> = {}): DreamEngineDeps {
    return {
      dreamStore: store,
      configStore: store,
      source: new DbWindowMemorySource(queries, { limit: 100 }),
      selector: new DuplicateCandidateSelector({ now: () => new Date(NOW) }),
      reasoner,
      diffGen: new DeterministicDiffGenerator(),
      lock: new ConsolidationLockManager({ store, holder: 'd22-test' }),
      tz: 'UTC',
      now: () => NOW,
      apply: { memoryStore: queries, vectorIndex: index },
      ...overrides,
    };
  }

  const fakeEmbed = async (_text: string): Promise<{ vector: Float32Array; model: string }> =>
    ({ vector: basis(7), model: 'test' });

  function applyDeps(withEmbed = true): ApplyDeps {
    return { memoryStore: queries, dreamStore: store, vectorIndex: index, ...(withEmbed ? { embedText: fakeEmbed } : {}) };
  }

  const parseDiff = (raw: string | null): DreamDiff => (raw ? JSON.parse(raw) : { entries: [] });
  const row = (id: number) => db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown>;

  it('"pnpm"→"bun" produces a queued supersession — NOT a silent reinforce, NOTHING auto-applied (all flags ON)', async () => {
    // Every auto-accept flag deliberately ON: reasoner outcomes must still queue.
    await store.updateConfig('default', { auto_accept_exact_dup: true, auto_accept_decay: true });

    const pnpm = await storeMem({ content: 'Use pnpm for installs in this repo.', vec: basis(0), created: '2026-05-01T12:00:00Z' });
    const bun = await storeMem({ content: 'Use bun for installs in this repo (changed from pnpm).', vec: blend(0, 1, 0.88), created: '2026-06-05T09:00:00Z' });
    const confBefore = row(pnpm).confidence;
    const obsBefore = row(pnpm).observation_count;

    const reasoner = new FakeReasoner({
      relation: 'preference_change', confidence: 0.92,
      rationale: '"changed from pnpm" explicitly marks B as superseding the older statement',
    });
    const run = await runDreamPass(engineDeps(reasoner), { trigger: 'manual' });
    expect(run.status).toBe('completed');
    expect(reasoner.classifyCalls).toBe(1);

    const dream = (await store.getDream(run.dream_id!))!;
    expect(dream.acceptance_status).toBe('pending');
    expect(dream.changes_auto_applied).toBe(0);
    expect(dream.changes_queued).toBe(1);

    const entry = parseDiff(dream.output_diff).entries[0];
    expect(entry.change_class).toBe('supersede');
    expect(entry.tier).toBe('reasoner-driven');
    expect(entry.after).toEqual({ supersede: { deprecated_id: pnpm, current_id: bun } });
    expect(entry.rationale).toContain('changed from pnpm');

    // NOT a silent reinforce, and nothing applied: store untouched.
    expect(row(pnpm).confidence).toBe(confBefore);
    expect(row(pnpm).observation_count).toBe(obsBefore);
    expect(row(pnpm).deprecated_at).toBeNull();
    expect(await store.listAuditForDream(dream.id)).toHaveLength(0);
  });

  it('accepting the supersession sets deprecated_at/valid_from, keeps both rows, audits, and rolls back', async () => {
    const pnpm = await storeMem({ content: 'Use pnpm for installs in this repo.', vec: basis(0), created: '2026-05-01T12:00:00Z' });
    const bun = await storeMem({ content: 'Use bun for installs in this repo (changed from pnpm).', vec: blend(0, 1, 0.88), created: '2026-06-05T09:00:00Z' });

    const reasoner = new FakeReasoner(verdict('preference_change', 0.92));
    const run = await runDreamPass(engineDeps(reasoner), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;

    const result = await resolveDream(applyDeps(), dream, 'accept', undefined, NOW_ISO);
    expect(result.applied).toBe(1);

    // Both kept in the chain — neither archived.
    expect(row(pnpm).is_archived).toBe(0);
    expect(row(bun).is_archived).toBe(0);
    expect(row(pnpm).deprecated_at).not.toBeNull();
    expect(row(bun).valid_from).toBe('2026-06-05T09:00:00Z'); // anchored to when stated

    const audit = await store.listAuditForDream(dream.id);
    expect(audit.map(a => [a.change_class, a.action])).toEqual([
      ['supersede', 'deprecate'],
      ['supersede', 'mark_current'],
    ]);
    expect(audit[0].after_ref).toBe(`superseded_by=${bun}`);
    expect(audit[1].after_ref).toBe(`supersedes=${pnpm}`);

    // Rollback restores the pre-supersession temporal markers (v7 round-trip).
    const rolled = await rollbackMemory(applyDeps(), pnpm, 1);
    expect(rolled).not.toBeNull();
    expect(row(pnpm).deprecated_at).toBeNull();
  });

  it('a superseded pair is not re-proposed on the next pass (deprecated band guard)', async () => {
    await storeMem({ content: 'Use pnpm for installs in this repo.', vec: basis(0), created: '2026-05-01T12:00:00Z' });
    await storeMem({ content: 'Use bun for installs in this repo (changed from pnpm).', vec: blend(0, 1, 0.88), created: '2026-06-05T09:00:00Z' });

    const reasoner = new FakeReasoner(verdict('preference_change', 0.92));
    const first = await runDreamPass(engineDeps(reasoner), { trigger: 'manual', windowKey: 'w1' });
    const dream = (await store.getDream(first.dream_id!))!;
    await resolveDream(applyDeps(), dream, 'accept', undefined, NOW_ISO);

    const second = await runDreamPass(engineDeps(reasoner), { trigger: 'manual', windowKey: 'w2' });
    expect(second.changes_proposed).toBe(0);
  });

  it('conditional verdict encodes the branch; accept creates the encoded memory and resets durability', async () => {
    const pg = await storeMem({ content: 'Use PostgreSQL as the database backend.', vec: basis(2), created: '2026-05-01T12:00:00Z' });
    const lite = await storeMem({ content: 'Use SQLite as the database backend.', vec: blend(2, 3, 0.87), created: '2026-06-01T12:00:00Z' });
    db.prepare(`UPDATE memories SET observation_count = 7 WHERE id = ?`).run(pg);

    // Extraction mirrors the real reasoner: conditions follow the (a, b) order
    // the pipeline presents (the window is newest-first, so order isn't fixed).
    const reasoner = new (class extends FakeReasoner {
      override async extractCondition(a: CandidateMemory, _b: CandidateMemory): Promise<ConditionExtraction> {
        const aIsPg = a.content.includes('PostgreSQL');
        return {
          conditionA: aIsPg ? 'in production deployments' : 'during local development',
          conditionB: aIsPg ? 'during local development' : 'in production deployments',
          rationale: 'A and B name different environments',
        };
      }
    })(verdict('conditional', 0.85));
    const run = await runDreamPass(engineDeps(reasoner), { trigger: 'manual' });

    const dream = (await store.getDream(run.dream_id!))!;
    const entry = parseDiff(dream.output_diff).entries[0];
    expect(entry.change_class).toBe('conditional');
    const encode = (entry.after as { encode: { content: string } }).encode;
    expect(encode.content).toContain('When in production deployments: Use PostgreSQL');
    expect(encode.content).toContain('When during local development: Use SQLite');

    const result = await resolveDream(applyDeps(), dream, 'accept', undefined, NOW_ISO);
    expect(result.applied).toBe(1);

    // The encoded memory exists with provenance to both sources.
    const encoded = db.prepare(`SELECT * FROM memories WHERE source = 'dream-consolidation'`).get() as Record<string, unknown>;
    expect(encoded).toBeDefined();
    const meta = JSON.parse(encoded.metadata as string);
    expect([...meta.condition_sources].sort((x: number, y: number) => x - y)).toEqual([pg, lite]);
    expect(encoded.confidence).toBe(0.7); // min of the two

    // Originals kept, stamped, durability reset.
    expect(row(pg).is_archived).toBe(0);
    expect(row(pg).last_contradicted).toBe(NOW_ISO);
    expect(row(pg).observation_count).toBe(1); // reset from 7
    expect(row(lite).last_contradicted).toBe(NOW_ISO);

    const audit = await store.listAuditForDream(dream.id);
    expect(audit.map(a => [a.change_class, a.action])).toEqual([
      ['conditional', 'encode_branch'],
      ['conditional', 'mark_contradicted'],
      ['conditional', 'mark_contradicted'],
    ]);
  });

  it('conditional accept without embedText stays pending (not_actionable)', async () => {
    await storeMem({ content: 'Use PostgreSQL as the database backend.', vec: basis(2), created: '2026-05-01T12:00:00Z' });
    await storeMem({ content: 'Use SQLite as the database backend.', vec: blend(2, 3, 0.87) });

    const reasoner = new FakeReasoner(verdict('conditional', 0.85), {
      conditionA: 'in production', conditionB: 'in development', rationale: 'env split cited',
    });
    const run = await runDreamPass(engineDeps(reasoner), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;

    const result = await resolveDream(applyDeps(false), dream, 'accept', undefined, NOW_ISO);
    expect(result.applied).toBe(0);
    expect(result.results[0].outcome).toBe('not_actionable');
    expect(result.acceptance_status).toBe('pending');
  });

  it('confident unrelated (R13 class) suppresses the junk band merge entirely', async () => {
    await storeMem({ content: 'The file routes.ts is a frequent edit target, modified 9 times.', vec: basis(4) });
    await storeMem({ content: 'The file handlers.ts is a frequent edit target, modified 9 times.', vec: blend(4, 5, 0.92) });

    const run = await runDreamPass(engineDeps(new FakeReasoner(verdict('unrelated', 0.95))), { trigger: 'manual' });
    expect(run.changes_proposed).toBe(0);
    const dream = (await store.getDream(run.dream_id!))!;
    expect(dream.acceptance_status).toBe('empty');
  });

  it('NoOp reasoner keeps exact Phase-1 behavior: band pair → queued reasoner-driven merge', async () => {
    await storeMem({ content: 'Always use tabs for indentation.', vec: basis(4) });
    await storeMem({ content: 'Always use spaces for indentation.', vec: blend(4, 5, 0.9) });

    const run = await runDreamPass(engineDeps(new NoOpReasoner()), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;
    const entry = parseDiff(dream.output_diff).entries[0];
    expect(entry.change_class).toBe('merge');
    expect(entry.tier).toBe('reasoner-driven');
    expect(entry.after).toBeUndefined();
    expect(dream.acceptance_status).toBe('pending');
  });

  it('flagged pair: routed by a fresh verdict, flag consumed, contested accept refused', async () => {
    const pnpm = await storeMem({ content: 'Use pnpm for installs in this repo.', vec: basis(0), created: '2026-05-01T12:00:00Z' });
    const bun = await storeMem({
      content: 'Use bun for installs in this repo.',
      vec: blend(0, 1, 0.88),
      created: '2026-06-05T09:00:00Z',
      tags: ['auto-discovered', CONTRADICTION_FLAG_TAG],
      metadata: JSON.stringify({
        discovered: true,
        [CONTRADICTION_FLAG_KEY]: buildContradictionFlag(pnpm, verdict('preference_change'), NOW_ISO),
      }),
    });

    const run = await runDreamPass(engineDeps(new FakeReasoner(verdict('contested', 0.8))), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;
    const entry = parseDiff(dream.output_diff).entries[0];
    expect(entry.change_class).toBe('contested');
    expect(entry.memory_ids).toEqual([pnpm, bun]);

    // Flag consumed: tag stripped, metadata key gone — the pair will not re-queue.
    const bunRow = (await queries.get(bun))!;
    expect(bunRow.tags).not.toContain(CONTRADICTION_FLAG_TAG);
    expect(CONTRADICTION_FLAG_KEY in JSON.parse(bunRow.metadata)).toBe(false);

    // Contested is review-only: accept refuses, reject resolves.
    const accepted = await resolveDream(applyDeps(), dream, 'accept', undefined, NOW_ISO);
    expect(accepted.applied).toBe(0);
    expect(accepted.results[0].outcome).toBe('not_actionable');
    const fresh = (await store.getDream(run.dream_id!))!;
    const rejected = await resolveDream(applyDeps(), fresh, 'reject', undefined, NOW_ISO);
    expect(rejected.acceptance_status).toBe('rejected');
  });

  it('withFlaggedPairs augments any window with flagged pairs + partners (and preserves rotation methods)', async () => {
    const pnpm = await storeMem({ content: 'Use pnpm for installs in this repo.', vec: basis(0) });
    const bun = await storeMem({
      content: 'Use bun for installs in this repo.',
      vec: blend(0, 1, 0.88),
      tags: [CONTRADICTION_FLAG_TAG],
      metadata: JSON.stringify({ [CONTRADICTION_FLAG_KEY]: buildContradictionFlag(pnpm, verdict('preference_change'), NOW_ISO) }),
    });

    // An empty window still surfaces the flagged pair.
    const source = withFlaggedPairs(new StaticMemorySource([]), queries);
    const fetched = await source.fetch();
    expect(fetched.map(m => m.id).sort()).toEqual([pnpm, bun]);

    // Rotation methods pass through; plain sources stay plain.
    expect('currentCursor' in source).toBe(false);
    let committed = false;
    const rotating = withFlaggedPairs({
      fetch: async () => [],
      currentCursor: async () => 42,
      commit: async () => { committed = true; },
    }, queries);
    expect(await (rotating as { currentCursor(): Promise<number> }).currentCursor()).toBe(42);
    await (rotating as { commit(): Promise<void> }).commit();
    expect(committed).toBe(true);
  });

  it('gate-failed semantic pair with a confident unrelated verdict is suppressed; NoOp keeps the demoted merge', async () => {
    // Burst evidence: one session, one input, zero span → gates fail.
    const burstEvidence = JSON.stringify({
      evidence_snapshot: [
        { session_id: 's1', input_hash: 'h1', at: '2026-06-10T00:00:00Z' },
        { session_id: 's1', input_hash: 'h1', at: '2026-06-10T00:10:00Z' },
      ],
    });
    await storeMem({ content: 'The file routes.ts is a frequent edit target, modified 9 times.', vec: basis(4), metadata: burstEvidence });
    await storeMem({ content: 'The file handlers.ts is a frequent edit target, modified 9 times.', vec: blend(4, 5, 0.96), metadata: burstEvidence });

    const suppressed = await runDreamPass(engineDeps(new FakeReasoner(verdict('unrelated', 0.95))), { trigger: 'manual', windowKey: 'wa' });
    expect(suppressed.changes_proposed).toBe(0);

    const noop = await runDreamPass(engineDeps(new NoOpReasoner()), { trigger: 'manual', windowKey: 'wb' });
    const dream = (await store.getDream(noop.dream_id!))!;
    const entry = parseDiff(dream.output_diff).entries[0];
    expect(entry.change_class).toBe('merge');
    expect(entry.tier).toBe('reasoner-driven');
    expect(entry.rationale).toMatch(/evidence gates failed/);
  });

  it('runPipeline only calls extractCondition for consumable conditional verdicts', async () => {
    const a = cm(1, 'Use PostgreSQL as the database backend.', basis(2));
    const b = cm(2, 'Use SQLite as the database backend.', blend(2, 3, 0.87));
    const dup = new FakeReasoner(verdict('duplicate'));
    await runPipeline(
      new StaticMemorySource([a, b]),
      new DuplicateCandidateSelector({ now: () => new Date(NOW) }),
      dup,
      new DeterministicDiffGenerator(),
      { timeoutMs: 1000 },
    );
    expect(dup.classifyCalls).toBe(1);
    expect(dup.extractCalls).toBe(0);
  });

  // ── v7 migration surface ──

  it("v7: dream_audit_log accepts 'conditional' and still rejects 'contested'", async () => {
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-audit' });
    await expect(store.appendAudit({
      dream_id: dream.id, change_class: 'conditional', action: 'encode_branch',
    })).resolves.toBeDefined();
    await expect(store.appendAudit({
      dream_id: dream.id, change_class: 'contested' as DreamDiffEntry['change_class'], action: 'nope',
    })).rejects.toThrow();
  });

  it('v7: setTemporalMarkers/markContradicted write without touching the decay clock', async () => {
    const id = await storeMem({ content: 'temporal marker target', created: '2026-05-01T12:00:00Z' });
    const before = row(id);

    await queries.setTemporalMarkers(id, { deprecated_at: NOW_ISO });
    expect(row(id).deprecated_at).toBe(NOW_ISO);
    expect(row(id).updated_at).toBe(before.updated_at);
    expect(row(id).last_seen).toBe(before.last_seen);

    await queries.setTemporalMarkers(id, { deprecated_at: null, valid_from: '2026-05-01T12:00:00Z' });
    expect(row(id).deprecated_at).toBeNull();
    expect(row(id).valid_from).toBe('2026-05-01T12:00:00Z');

    db.prepare(`UPDATE memories SET observation_count = 9 WHERE id = ?`).run(id);
    await queries.markContradicted([id], NOW_ISO);
    expect(row(id).last_contradicted).toBe(NOW_ISO);
    expect(row(id).observation_count).toBe(1);
    expect(row(id).last_seen).toBe(before.last_seen);
  });

  it('v7: revisions snapshot and restore the temporal markers', async () => {
    const id = await storeMem({ content: 'revision round-trip target' });
    await queries.setTemporalMarkers(id, { deprecated_at: NOW_ISO, last_contradicted: NOW_ISO });

    const snap = await store.snapshotRevision(id, null);
    const rev = (await store.getRevision(id, snap.revision))!;
    expect(rev.deprecated_at).toBe(NOW_ISO);
    expect(rev.last_contradicted).toBe(NOW_ISO);

    await queries.setTemporalMarkers(id, { deprecated_at: null, last_contradicted: null });
    expect(row(id).deprecated_at).toBeNull();

    await store.restoreRevision(id, snap.revision);
    expect(row(id).deprecated_at).toBe(NOW_ISO);
    expect(row(id).last_contradicted).toBe(NOW_ISO);
  });

  it('Hard Anchor re-check: supersede and conditional refuse anchored rows from stale diffs', async () => {
    const a = await storeMem({ content: 'anchored side A', created: '2026-05-01T12:00:00Z' });
    const b = await storeMem({ content: 'plain side B' });
    db.prepare(`UPDATE memories SET is_locked = 1 WHERE id = ?`).run(a);
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-anchor22' });

    const supersede: DreamDiffEntry = {
      change_class: 'supersede', tier: 'reasoner-driven', memory_ids: [a, b],
      rationale: 'stale', after: { supersede: { deprecated_id: a, current_id: b } },
    };
    expect((await applyEntry(applyDeps(), dream.id, 0, supersede, false)).outcome).toBe('anchored');
    expect(row(a).deprecated_at).toBeNull();

    const conditional: DreamDiffEntry = {
      change_class: 'conditional', tier: 'reasoner-driven', memory_ids: [a, b],
      rationale: 'stale', after: { encode: { content: 'When x: A\nWhen y: B', source_ids: [a, b], condition_a: 'x', condition_b: 'y' } },
    };
    expect((await applyEntry(applyDeps(), dream.id, 0, conditional, false)).outcome).toBe('anchored');
    expect(await store.listAuditForDream(dream.id)).toHaveLength(0);
  });
});
