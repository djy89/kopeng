import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';
import type { RerankCandidate, RerankResult } from '../../src/search/reranker.js';
import { hybridSearch } from '../../src/search/hybrid.js';

const { rerankMock } = vi.hoisted(() => ({
  rerankMock: vi.fn(),
}));

vi.mock('../../src/search/reranker.js', () => ({
  initReranker: vi.fn(async () => {}),
  isRerankerReady: () => true,
  rerank: rerankMock,
}));

vi.mock('../../src/embeddings/embedder.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
}));

/** Stub vector index — keyword mode never touches it. */
const stubIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

/** Equal rerank scores for all candidates (relevance tie). */
function equalScores(_query: string, candidates: RerankCandidate[]): Promise<RerankResult[]> {
  return Promise.resolve(
    candidates.map(c => ({ id: c.id, rerank_score: 1.0, originalScore: c.originalScore }))
  );
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('hybridSearch — reranked path confidence pipeline (R1)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeEach(() => {
    ({ db, queries } = createTestDatabase());
    rerankMock.mockReset();
    rerankMock.mockImplementation(equalScores);
  });

  async function createMemory(opts: {
    content: string;
    type?: 'reference' | 'discovery';
    confidence?: number;
    updatedDaysAgo?: number;
  }): Promise<number> {
    const memory = await queries.store(createTestMemory({
      content: opts.content,
      type: opts.type ?? 'reference',
      confidence: opts.confidence,
    }));
    if (opts.updatedDaysAgo) {
      // Age both clocks: updated_at (content age) and last_seen (decay anchor since D1.1)
      const ts = daysAgoIso(opts.updatedDaysAgo);
      db.prepare('UPDATE memories SET updated_at = ?, last_seen = ? WHERE id = ?')
        .run(ts, ts, memory.id);
    }
    return memory.id;
  }

  function search(overrides: Partial<Parameters<typeof hybridSearch>[2]> = {}) {
    return hybridSearch(queries, stubIndex, {
      query: 'deploy',
      mode: 'keyword',
      limit: 10,
      offset: 0,
      include_archived: false,
      rerank: true,
      ...overrides,
    });
  }

  it('min_confidence excludes low-effective-confidence results', async () => {
    const freshId = await createMemory({ content: 'fresh deploy runbook', confidence: 1.0 });
    // confidence 0.5, 60 days stale → effective 0.25 (one half-life)
    const staleId = await createMemory({
      content: 'stale deploy pattern',
      type: 'discovery',
      confidence: 0.5,
      updatedDaysAgo: 60,
    });

    const { results, reranked } = await search({ min_confidence: 0.4 });

    expect(reranked).toBe(true);
    const ids = results.map(r => r.memory.id);
    expect(ids).toContain(freshId);
    expect(ids).not.toContain(staleId);

    // Filtered before rerank — the cross-encoder never saw the stale memory
    const candidateIds = (rerankMock.mock.calls[0][1] as RerankCandidate[]).map(c => c.id);
    expect(candidateIds).not.toContain(staleId);
  });

  it('include_discoveries: false excludes discoveries', async () => {
    const refId = await createMemory({ content: 'deploy checklist', confidence: 1.0 });
    const discId = await createMemory({
      content: 'deploy sequence pattern',
      type: 'discovery',
      confidence: 0.85,
    });

    const { results, reranked } = await search({ include_discoveries: false });

    expect(reranked).toBe(true);
    const ids = results.map(r => r.memory.id);
    expect(ids).toContain(refId);
    expect(ids).not.toContain(discId);

    const candidateIds = (rerankMock.mock.calls[0][1] as RerankCandidate[]).map(c => c.id);
    expect(candidateIds).not.toContain(discId);
  });

  it('caps discoveries at 30% of limit', async () => {
    for (let i = 0; i < 6; i++) {
      await createMemory({ content: `deploy pattern variant ${i}`, type: 'discovery', confidence: 0.85 });
    }
    for (let i = 0; i < 6; i++) {
      await createMemory({ content: `deploy guide chapter ${i}`, confidence: 1.0 });
    }

    const { results, reranked } = await search({ limit: 10 });

    expect(reranked).toBe(true);
    const discoveryCount = results.filter(r => r.memory.type === 'discovery').length;
    expect(discoveryCount).toBeLessThanOrEqual(3); // floor(10 * 0.3)
    expect(results.filter(r => r.memory.type !== 'discovery').length).toBe(6);
  });

  it('D1.1: a 20-obs memory outranks a 3-obs one at equal staleness (durability)', async () => {
    // Equal confidence, equal updated_at/last_seen (60 days stale), equal relevance —
    // only observation_count differs. Durability must decide the ordering.
    const heavyId = await createMemory({
      content: 'deploy pipeline pattern alpha',
      type: 'discovery',
      confidence: 0.7,
      updatedDaysAgo: 60,
    });
    const lightId = await createMemory({
      content: 'deploy pipeline pattern beta',
      type: 'discovery',
      confidence: 0.7,
      updatedDaysAgo: 60,
    });
    db.prepare('UPDATE memories SET observation_count = ? WHERE id = ?').run(20, heavyId);
    db.prepare('UPDATE memories SET observation_count = ? WHERE id = ?').run(3, lightId);

    const { results, reranked } = await search();

    expect(reranked).toBe(true);
    expect(results.map(r => r.memory.id)).toEqual([heavyId, lightId]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('ranks a 60-day stale discovery below a fresh equal-relevance memory', async () => {
    const staleId = await createMemory({
      content: 'deploy via blue-green swap',
      type: 'discovery',
      confidence: 0.85,
      updatedDaysAgo: 60,
    });
    const freshId = await createMemory({ content: 'deploy via canary rollout', confidence: 1.0 });

    // equalScores mock: identical rerank logits → confidence decides ordering
    const { results, reranked } = await search();

    expect(reranked).toBe(true);
    expect(results.map(r => r.memory.id)).toEqual([freshId, staleId]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].rerank_score).toBe(1.0);
  });

  it('keyword path honors include_archived without type/scope/tags filters (D1.3 finding)', async () => {
    // FTS rows survive archival, and without type/scope/tags there is no
    // candidateIds pre-filter — an archived memory (e.g. a dream-applied dup)
    // must still be excluded from default search results.
    const liveId = await createMemory({ content: 'deploy runbook current', confidence: 0.8 });
    const archivedId = await createMemory({ content: 'deploy runbook duplicate', confidence: 0.6 });
    await queries.archive(archivedId);

    const defaults = await search({ rerank: false });
    expect(defaults.results.map(r => r.memory.id)).toContain(liveId);
    expect(defaults.results.map(r => r.memory.id)).not.toContain(archivedId);

    const reranked = await search({ rerank: true });
    expect(reranked.results.map(r => r.memory.id)).not.toContain(archivedId);

    const withArchived = await search({ rerank: false, include_archived: true });
    expect(withArchived.results.map(r => r.memory.id)).toContain(archivedId);
  });
});

describe('hybridSearch — scopes[] union prefilter (CR-2)', () => {
  let queries: MemoryQueries;

  // Deliberately NOT case variants of each other: SQLite scope filtering is
  // COLLATE NOCASE (documented T46 exception), so a case-only pair would match
  // through the fold alone and never prove the union did the work.
  const SCOPE_A = 'client:variant-x';
  const SCOPE_B = 'client:legacy-tool';

  beforeEach(() => {
    ({ queries } = createTestDatabase());
  });

  async function seed(content: string, scope: string): Promise<number> {
    const memory = await queries.store(createTestMemory({ content, scope, confidence: 1.0 }));
    return memory.id;
  }

  function search(overrides: Partial<Parameters<typeof hybridSearch>[2]> = {}) {
    return hybridSearch(queries, stubIndex, {
      query: 'gronkle',
      mode: 'keyword',
      limit: 10,
      offset: 0,
      include_archived: false,
      rerank: false,
      ...overrides,
    });
  }

  it('scopes[] prefilters on the union of all listed scopes', async () => {
    const aId = await seed('gronkle probe content alpha', SCOPE_A);
    const bId = await seed('gronkle probe content beta', SCOPE_B);
    await seed('gronkle probe content gamma', 'project:elsewhere');

    const { results } = await search({ scopes: [SCOPE_A, SCOPE_B] });
    expect(results.map(r => r.memory.id).sort((x, y) => x - y))
      .toEqual([aId, bId].sort((x, y) => x - y));
    expect(results.map(r => r.memory.scope).sort()).toEqual([SCOPE_A, SCOPE_B].sort());
  });

  it('scopes wins over scope when both are present', async () => {
    const aId = await seed('gronkle probe content alpha', SCOPE_A);
    const bId = await seed('gronkle probe content beta', SCOPE_B);
    const otherId = await seed('gronkle probe content gamma', 'project:elsewhere');

    const { results } = await search({ scope: 'project:elsewhere', scopes: [SCOPE_A, SCOPE_B] });
    const ids = results.map(r => r.memory.id);
    expect(ids.sort((x, y) => x - y)).toEqual([aId, bId].sort((x, y) => x - y));
    expect(ids).not.toContain(otherId);
  });

  it('single-scope `scope` filtering is unchanged (back-compat)', async () => {
    const aId = await seed('gronkle probe content alpha', SCOPE_A);
    const bId = await seed('gronkle probe content beta', SCOPE_B);

    const { results } = await search({ scope: SCOPE_A });
    expect(results.map(r => r.memory.id)).toEqual([aId]);
    expect(results.map(r => r.memory.id)).not.toContain(bId);
  });

  it('an empty scopes[] union early-returns empty results', async () => {
    await seed('gronkle probe content alpha', SCOPE_A);

    const { results, total } = await search({ scopes: ['client:nowhere-1', 'client:nowhere-2'] });
    expect(results).toEqual([]);
    expect(total).toBe(0);
  });
});
