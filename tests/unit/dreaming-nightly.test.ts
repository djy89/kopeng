import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager, heldLockPassthrough, DEFAULT_OPERATOR_ID } from '../../src/dreaming/lock.js';
import { createNightlyConsolidation } from '../../src/dreaming/nightly.js';
import { runDreamPass } from '../../src/dreaming/dream-engine.js';
import { StaticMemorySource, WindowedCandidateSelector, EmptyDiffGenerator } from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import { runPromotion } from '../../src/promotion/promotion-engine.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';

/**
 * R5 — the nightly fire runs the supervisor chain `promotion → dream` under ONE
 * consolidation lock hold: promotion_runs rows finally appear on a schedule, the
 * dream step writes its row under the same hold (heldLockPassthrough), and a
 * held lock skips the whole fire (the next scheduler tick retries).
 */
describe('createNightlyConsolidation (R5)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;
  let embeddingIndex: EmbeddingIndex;
  const NOW = Date.parse('2026-06-15T03:00:00Z');

  beforeEach(() => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    dreamStore = new DreamQueries(db);
    embeddingIndex = new EmbeddingIndex();
  });

  function nightly(holdersSeen: string[]) {
    return createNightlyConsolidation({
      lock: new ConsolidationLockManager({ store: dreamStore, holder: 'nightly-consolidation' }),
      runPromotionStep: async () => {
        holdersSeen.push((await dreamStore.getLock(DEFAULT_OPERATOR_ID))?.holder ?? '<free>');
        await runPromotion(queries, embeddingIndex, null, db);
      },
      runDreamStep: async (trigger, reason) => {
        holdersSeen.push((await dreamStore.getLock(DEFAULT_OPERATOR_ID))?.holder ?? '<free>');
        await runDreamPass({
          dreamStore,
          source: new StaticMemorySource([]),
          selector: new WindowedCandidateSelector(),
          reasoner: new NoOpReasoner(),
          diffGen: new EmptyDiffGenerator(),
          lock: heldLockPassthrough, // the supervisor already holds the lock
          tz: 'UTC',
          now: () => NOW,
        }, { trigger, reason });
      },
    });
  }

  it('one lock hold spans promotion → dream; both rows land', async () => {
    const holdersSeen: string[] = [];
    const result = await nightly(holdersSeen)('scheduled', 'test fire');

    expect(result.acquired).toBe(true);
    expect(result.steps.map(s => ({ name: s.name, status: s.status }))).toEqual([
      { name: 'promotion', status: 'completed' },
      { name: 'dream', status: 'completed' },
    ]);
    // Both steps observed the SAME holder — one hold across the chain.
    expect(holdersSeen).toEqual(['nightly-consolidation', 'nightly-consolidation']);

    // Promotion is finally scheduled: a promotion_runs row was written.
    const promoRuns = db.prepare('SELECT status FROM promotion_runs').all() as Array<{ status: string }>;
    expect(promoRuns).toHaveLength(1);
    expect(promoRuns[0].status).toBe('completed');

    // The dream pass wrote its row under the supervisor's hold.
    const dreams = await dreamStore.listDreams(10);
    expect(dreams).toHaveLength(1);
    expect(dreams[0].status).toBe('completed');
    expect(dreams[0].trigger_source).toBe('scheduled');

    // Released after the chain.
    expect((await dreamStore.getLock(DEFAULT_OPERATOR_ID))?.holder).toBeNull();
  });

  it('skips the whole fire when the lock is held elsewhere — nothing written', async () => {
    const discovery = new ConsolidationLockManager({ store: dreamStore, holder: 'discovery' });
    expect(await discovery.acquire()).toBe(true);

    const holdersSeen: string[] = [];
    const result = await nightly(holdersSeen)('scheduled', 'test fire');

    expect(result.acquired).toBe(false);
    expect(result.steps).toEqual([]);
    expect(holdersSeen).toEqual([]); // neither step ran
    expect(db.prepare('SELECT COUNT(*) AS c FROM promotion_runs').get()).toEqual({ c: 0 });
    expect(await dreamStore.listDreams(10)).toHaveLength(0);
  });

  it('a promotion failure does not starve the dream step (failure isolation)', async () => {
    const result = await createNightlyConsolidation({
      lock: new ConsolidationLockManager({ store: dreamStore, holder: 'nightly-consolidation' }),
      runPromotionStep: async () => { throw new Error('promotion boom'); },
      runDreamStep: async (trigger, reason) => {
        await runDreamPass({
          dreamStore,
          source: new StaticMemorySource([]),
          selector: new WindowedCandidateSelector(),
          reasoner: new NoOpReasoner(),
          diffGen: new EmptyDiffGenerator(),
          lock: heldLockPassthrough,
          tz: 'UTC',
          now: () => NOW,
        }, { trigger, reason });
      },
    })('scheduled', 'test fire');

    expect(result.acquired).toBe(true);
    expect(result.steps[0]).toMatchObject({ name: 'promotion', status: 'failed', error: 'promotion boom' });
    expect(result.steps[1]).toMatchObject({ name: 'dream', status: 'completed' });
    expect((await dreamStore.listDreams(10))[0]?.status).toBe('completed');
  });
});
