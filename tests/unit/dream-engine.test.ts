import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import { runDreamPass, MAX_WINDOW_RETRIES, type DreamEngineDeps } from '../../src/dreaming/dream-engine.js';
import { StaticMemorySource, WindowedCandidateSelector, EmptyDiffGenerator, type DiffGenerator } from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import type { CandidateMemory } from '../../src/dreaming/reasoner/reasoner.js';

/**
 * D0.6 — empty-diff dream runner. The pass writes a `dreams` row under the lock,
 * collapses on a duplicate window, writes nothing in dry-run, and skips when the
 * lock is held elsewhere. Zero LLM (NoOpReasoner), empty diff (EmptyDiffGenerator).
 */
describe('runDreamPass (D0.6 empty-diff engine)', () => {
  let db: Database.Database;
  let store: DreamQueries;
  const NOW = Date.parse('2026-06-15T03:00:00Z'); // local day 2026-06-15 in UTC

  function mem(id: number, content: string): CandidateMemory {
    return {
      id, content, content_hash: `h${id}`, summary: null, tags: [],
      scope: 'global', confidence: 0.7, is_locked: false,
      created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    };
  }

  function deps(overrides: Partial<DreamEngineDeps> = {}): DreamEngineDeps {
    return {
      dreamStore: store,
      source: new StaticMemorySource([mem(1, 'alpha'), mem(2, 'beta'), mem(3, 'gamma')]),
      selector: new WindowedCandidateSelector(),
      reasoner: new NoOpReasoner(),
      diffGen: new EmptyDiffGenerator(),
      lock: new ConsolidationLockManager({ store, holder: 'dream-engine' }),
      tz: 'UTC',
      now: () => NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDatabase().db;
    store = new DreamQueries(db);
  });

  it('writes a completed dream row with an empty diff', async () => {
    const result = await runDreamPass(deps(), { trigger: 'manual' });

    expect(result.status).toBe('completed');
    expect(result.window_key).toBe('2026-06-15');
    expect(result.memories_examined).toBe(3);
    expect(result.changes_proposed).toBe(0);

    const dream = await store.getDream(result.dream_id!);
    expect(dream).not.toBeNull();
    expect(dream!.status).toBe('completed');
    expect(dream!.acceptance_status).toBe('empty');
    expect(dream!.memories_examined).toBe(3);
    expect(dream!.trigger_source).toBe('manual');
    expect(JSON.parse(dream!.output_diff!)).toEqual({ entries: [] });
  });

  it('collapses a duplicate window instead of inserting a second row', async () => {
    const first = await runDreamPass(deps(), { trigger: 'scheduled' });
    const second = await runDreamPass(deps(), { trigger: 'manual' });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('collapsed');
    expect(second.dream_id).toBe(first.dream_id);
    expect((await store.listDreams(10)).length).toBe(1);
  });

  it('R2: a failed dream does not collapse the window — the next pass retries', async () => {
    const boom: DiffGenerator = { generate: () => { throw new Error('boom'); } };
    await expect(runDreamPass(deps({ diffGen: boom }), { trigger: 'scheduled' })).rejects.toThrow('boom');

    const failed = await store.listDreams(10);
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');

    // Retry succeeds: a second row for the SAME window (failed row left the index).
    const retry = await runDreamPass(deps(), { trigger: 'scheduled' });
    expect(retry.status).toBe('completed');
    expect(retry.window_key).toBe('2026-06-15');
    expect((await store.listDreams(10)).length).toBe(2);
  });

  it('R2: failed-window retries are bounded, then the window collapses', async () => {
    const boom: DiffGenerator = { generate: () => { throw new Error('boom'); } };
    for (let attempt = 0; attempt < 1 + MAX_WINDOW_RETRIES; attempt++) {
      await expect(runDreamPass(deps({ diffGen: boom }), { trigger: 'scheduled' })).rejects.toThrow('boom');
    }

    // Budget spent (1 original + MAX_WINDOW_RETRIES retries, all failed) — a
    // further pass collapses without inserting a row, even though it would succeed.
    const exhausted = await runDreamPass(deps(), { trigger: 'scheduled' });
    expect(exhausted.status).toBe('collapsed');
    expect((await store.listDreams(10)).length).toBe(1 + MAX_WINDOW_RETRIES);
  });

  it('R2: a completed dream still collapses the window after an earlier failure', async () => {
    const boom: DiffGenerator = { generate: () => { throw new Error('boom'); } };
    await expect(runDreamPass(deps({ diffGen: boom }), { trigger: 'scheduled' })).rejects.toThrow('boom');
    const retry = await runDreamPass(deps(), { trigger: 'scheduled' });
    expect(retry.status).toBe('completed');

    const third = await runDreamPass(deps(), { trigger: 'manual' });
    expect(third.status).toBe('collapsed');
    expect(third.dream_id).toBe(retry.dream_id);
  });

  it('R2: a manual trigger with an explicit window_key runs after the daily window collapsed', async () => {
    const nightly = await runDreamPass(deps(), { trigger: 'scheduled' });
    expect(nightly.status).toBe('completed');

    // Same (default) window collapses…
    expect((await runDreamPass(deps(), { trigger: 'manual' })).status).toBe('collapsed');

    // …but an explicit window_key opens a fresh window.
    const manual = await runDreamPass(deps(), { trigger: 'manual', windowKey: '2026-06-15-manual-1' });
    expect(manual.status).toBe('completed');
    expect(manual.window_key).toBe('2026-06-15-manual-1');
    expect(manual.dream_id).not.toBe(nightly.dream_id);
  });

  it('dry-run computes but writes nothing', async () => {
    const result = await runDreamPass(deps(), { trigger: 'manual', dryRun: true });

    expect(result.status).toBe('dry_run');
    expect(result.dream_id).toBeNull();
    expect(result.memories_examined).toBe(3);
    expect((await store.listDreams(10)).length).toBe(0);
  });

  it('skips when the consolidation lock is held elsewhere', async () => {
    const other = new ConsolidationLockManager({ store, holder: 'someone-else' });
    expect(await other.acquire()).toBe(true);

    const result = await runDreamPass(deps(), { trigger: 'scheduled' });

    expect(result.status).toBe('skipped');
    expect(result.dream_id).toBeNull();
    expect((await store.listDreams(10)).length).toBe(0);
  });

  it('derives window_key from the operator-local day via tz', async () => {
    // 03:00 UTC = 21:00 the previous local day at UTC-6 (Denver, MDT/summer).
    const result = await runDreamPass(
      deps({ tz: 'America/Denver', source: new StaticMemorySource([]) }),
      { trigger: 'manual' },
    );
    expect(result.window_key).toBe('2026-06-14');
    expect(result.memories_examined).toBe(0);
  });
});
