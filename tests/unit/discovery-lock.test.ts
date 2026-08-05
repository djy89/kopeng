import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestObservationsDb } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import type { ObservationQueries } from '../../src/database/observation-queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager, DEFAULT_OPERATOR_ID } from '../../src/dreaming/lock.js';
import { DiscoveryScheduler } from '../../src/discovery/scheduler.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import config from '../../src/config/config.js';

/**
 * R5 — discovery passes acquire-or-skip the consolidation lock. A pass that
 * finds the lock held (nightly promotion → dream chain mid-flight) skips
 * WITHOUT resetting its observation counter, so the next debounced tick retries.
 */
describe('DiscoveryScheduler consolidation lock (R5)', () => {
  let memoryDb: Database.Database;
  let queries: MemoryQueries;
  let obsQueries: ObservationQueries;
  let dreamStore: DreamQueries;
  let scheduler: DiscoveryScheduler;

  beforeEach(() => {
    const mem = createTestDatabase();
    memoryDb = mem.db;
    queries = mem.queries;
    obsQueries = createTestObservationsDb().obsQueries;
    dreamStore = new DreamQueries(memoryDb);
    scheduler = new DiscoveryScheduler(
      obsQueries,
      queries,
      new EmbeddingIndex(),
      config.discovery,
      new ConsolidationLockManager({ store: dreamStore, holder: 'discovery' }),
    );
  });

  it('skips while the lock is held elsewhere and keeps the counter for retry', async () => {
    const nightly = new ConsolidationLockManager({ store: dreamStore, holder: 'nightly-consolidation' });
    expect(await nightly.acquire()).toBe(true);

    scheduler.incrementCounter();
    scheduler.incrementCounter();
    scheduler.incrementCounter();

    const skipped = await scheduler.triggerNow();
    expect(skipped.project_scope).toBe('skipped');
    expect(skipped.run_id).toBe(0);
    expect(scheduler.getCounter()).toBe(3); // NOT reset — next tick retries

    // Lock still belongs to the nightly chain.
    expect((await dreamStore.getLock(DEFAULT_OPERATOR_ID))?.holder).toBe('nightly-consolidation');
  });

  it('runs once the lock frees up, then releases it', async () => {
    const nightly = new ConsolidationLockManager({ store: dreamStore, holder: 'nightly-consolidation' });
    expect(await nightly.acquire()).toBe(true);
    expect((await scheduler.triggerNow()).project_scope).toBe('skipped');
    expect(await nightly.release()).toBe(true);

    // Retry: empty observation store → engine's no-op result, not a lock skip.
    const result = await scheduler.triggerNow();
    expect(result.project_scope).toBe('all');
    expect(scheduler.getCounter()).toBe(0); // reset by the real run

    // The pass released the lock on the way out.
    expect((await dreamStore.getLock(DEFAULT_OPERATOR_ID))?.holder).toBeNull();
  });

  it('without a lock wired, behavior is unchanged (no lock traffic)', async () => {
    const unlocked = new DiscoveryScheduler(obsQueries, queries, new EmbeddingIndex(), config.discovery);
    const result = await unlocked.triggerNow();
    expect(result.project_scope).toBe('all');
    expect(await dreamStore.getLock(DEFAULT_OPERATOR_ID)).toBeNull();
  });
});
