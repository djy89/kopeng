import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import { runDreamPass } from '../../src/dreaming/dream-engine.js';
import {
  StaticMemorySource, WindowedCandidateSelector, EmptyDiffGenerator,
  runPipeline, DreamPassDeadlineError,
} from '../../src/dreaming/pipeline.js';
import type { ConsolidationReasoner, CandidateMemory } from '../../src/dreaming/reasoner/reasoner.js';

/**
 * R4b — the pipeline enforces its own pass deadline. A reasoner adapter that
 * never resolves (or quietly ignores ctx.timeoutMs) cannot push a pass past its
 * budget; in the engine, the deadline abort marks the dream `failed`.
 */

/** Adapter that ignores every bound it was given — the R4b adversary. */
const neverResolves: ConsolidationReasoner = {
  name: 'never-resolves',
  classifyPair: () => new Promise(() => { /* hangs forever */ }),
  extractCondition: () => new Promise(() => { /* hangs forever */ }),
  synthesizeCluster: () => new Promise(() => { /* hangs forever */ }),
};

function mem(id: number, content: string): CandidateMemory {
  return {
    id, content, content_hash: `h${id}`, summary: null, tags: [],
    scope: 'global', confidence: 0.7, is_locked: false,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  };
}

/** Two same-content memories → one signal-less pair → one reasoner call. */
const pairSource = () => new StaticMemorySource([mem(1, 'same fact'), mem(2, 'same fact')]);

describe('runPipeline deadline enforcement (R4b)', () => {
  it('a never-resolving reasoner call is aborted at the pass budget', async () => {
    await expect(runPipeline(
      pairSource(), new WindowedCandidateSelector(), neverResolves, new EmptyDiffGenerator(),
      { timeoutMs: 60_000 }, // adapter cap is generous — the PASS budget must win
      { passBudgetMs: 50 },
    )).rejects.toThrow(DreamPassDeadlineError);
  });

  it('a never-resolving reasoner call is aborted at the per-call cap (ctx.timeoutMs)', async () => {
    await expect(runPipeline(
      pairSource(), new WindowedCandidateSelector(), neverResolves, new EmptyDiffGenerator(),
      { timeoutMs: 30 }, // per-call cap is the binding constraint here
      { passBudgetMs: 60_000 },
    )).rejects.toThrow(DreamPassDeadlineError);
  });

  it('a spent budget aborts before the next reasoner call is made', async () => {
    let calls = 0;
    const counting: ConsolidationReasoner = {
      ...neverResolves,
      name: 'counting',
      classifyPair: () => { calls++; return new Promise(() => {}); },
    };
    await expect(runPipeline(
      pairSource(), new WindowedCandidateSelector(), counting, new EmptyDiffGenerator(),
      { timeoutMs: 60_000 },
      { passBudgetMs: 0 },
    )).rejects.toThrow(DreamPassDeadlineError);
    expect(calls).toBe(0);
  });

  it('no budget (scaffold/test callers) leaves behavior unchanged', async () => {
    const instant: ConsolidationReasoner = {
      ...neverResolves,
      name: 'instant',
      classifyPair: async () => ({ relation: 'unrelated', confidence: 0, rationale: 'test' }),
    };
    const result = await runPipeline(
      pairSource(), new WindowedCandidateSelector(), instant, new EmptyDiffGenerator(),
      { timeoutMs: 60_000 },
    );
    expect(result.memoriesExamined).toBe(2);
  });
});

describe('runDreamPass deadline abort (R4b)', () => {
  let db: Database.Database;
  let store: DreamQueries;

  beforeEach(() => {
    db = createTestDatabase().db;
    store = new DreamQueries(db);
  });

  it('marks the dream failed when the pass exceeds its budget', async () => {
    await expect(runDreamPass({
      dreamStore: store,
      source: pairSource(),
      selector: new WindowedCandidateSelector(),
      reasoner: neverResolves,
      diffGen: new EmptyDiffGenerator(),
      lock: new ConsolidationLockManager({ store, holder: 'dream-engine' }),
      tz: 'UTC',
      passBudgetMs: 50,
    }, { trigger: 'manual' })).rejects.toThrow(DreamPassDeadlineError);

    const dreams = await store.listDreams(10);
    expect(dreams).toHaveLength(1);
    expect(dreams[0].status).toBe('failed');
    expect(dreams[0].error).toContain('exceeded');
  });
});
