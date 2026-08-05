import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager, DEFAULT_OPERATOR_ID } from '../../src/dreaming/lock.js';
import { ConsolidationSupervisor, type SupervisorStep } from '../../src/dreaming/supervisor.js';

/**
 * D0.4 — Consolidation supervisor: ordered steps under one lock, acquire-or-skip,
 * failure isolation. The canonical step set is discovery → promotion → dream.
 */
describe('ConsolidationSupervisor (D0.4)', () => {
  let db: Database.Database;
  let store: DreamQueries;

  beforeEach(() => {
    db = createTestDatabase().db;
    store = new DreamQueries(db);
  });

  function step(name: string, log: string[], fn?: () => void): SupervisorStep {
    return {
      name,
      async run() {
        if (fn) fn();
        log.push(name);
      },
    };
  }

  it('runs steps in order under the lock, then releases', async () => {
    const order: string[] = [];
    const lock = new ConsolidationLockManager({ store, holder: 'supervisor' });
    const sup = new ConsolidationSupervisor(lock, [
      step('discovery', order),
      step('promotion', order),
      step('dream', order),
    ]);

    const result = await sup.runOnce();

    expect(result.acquired).toBe(true);
    expect(order).toEqual(['discovery', 'promotion', 'dream']);
    expect(result.steps.map(s => s.status)).toEqual(['completed', 'completed', 'completed']);

    const held = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(held?.holder).toBeNull(); // released after the run
  });

  it('skips all steps when the lock is already held', async () => {
    const other = new ConsolidationLockManager({ store, holder: 'other' });
    expect(await other.acquire()).toBe(true);

    const order: string[] = [];
    const lock = new ConsolidationLockManager({ store, holder: 'supervisor' });
    const sup = new ConsolidationSupervisor(lock, [step('discovery', order), step('promotion', order)]);

    const result = await sup.runOnce();

    expect(result.acquired).toBe(false);
    expect(result.steps).toEqual([]);
    expect(order).toEqual([]); // nothing ran

    const held = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(held?.holder).toBe('other'); // the original holder still owns it
  });

  it('isolates step failures: a throwing step does not starve the rest', async () => {
    const order: string[] = [];
    const lock = new ConsolidationLockManager({ store, holder: 'supervisor' });
    const sup = new ConsolidationSupervisor(lock, [
      step('discovery', order),
      step('promotion', order, () => { throw new Error('promotion exploded'); }),
      step('dream', order),
    ]);

    const result = await sup.runOnce();

    expect(result.acquired).toBe(true);
    expect(order).toEqual(['discovery', 'dream']); // promotion threw before logging
    expect(result.steps.map(s => s.status)).toEqual(['completed', 'failed', 'completed']);
    expect(result.steps[1].error).toContain('promotion exploded');

    const held = await store.getLock(DEFAULT_OPERATOR_ID);
    expect(held?.holder).toBeNull(); // still releases despite the failure
  });
});
