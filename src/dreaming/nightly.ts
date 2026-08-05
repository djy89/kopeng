/**
 * Nightly consolidation chain (R5): the dream scheduler's fire action runs
 * `promotion → dream` as a ConsolidationSupervisor pass under ONE lock hold —
 * which finally puts the promotion pipeline on a schedule.
 *
 * The dream step receives `heldLockPassthrough`: the supervisor already owns
 * the lock (and its heartbeat keeps it alive), so the engine must not try to
 * re-acquire — its own acquisition stays reserved for manual triggers.
 *
 * If the lock is held elsewhere (a discovery pass mid-flight) the whole fire is
 * skipped; the fire predicate still sees no completed dream for the window, so
 * the next scheduler tick retries.
 */
import type { DreamTrigger } from '../types/types.js';
import { ConsolidationSupervisor, type SupervisorRunResult } from './supervisor.js';
import type { IConsolidationLock } from './lock.js';
import logger from '../utils/logger.js';

export interface NightlyConsolidationDeps {
  /** The single hold spanning the whole chain (holder e.g. 'nightly-consolidation'). */
  lock: IConsolidationLock;
  /** The promotion pipeline (writes `promotion_runs` rows). */
  runPromotionStep: () => Promise<void>;
  /** The dream pass — MUST run on `heldLockPassthrough`, not its own lock. */
  runDreamStep: (trigger: DreamTrigger, reason: string) => Promise<void>;
  now?: () => number;
}

export function createNightlyConsolidation(deps: NightlyConsolidationDeps) {
  return async (trigger: DreamTrigger, reason: string): Promise<SupervisorRunResult> => {
    const supervisor = new ConsolidationSupervisor(
      deps.lock,
      [
        { name: 'promotion', run: () => deps.runPromotionStep() },
        { name: 'dream', run: () => deps.runDreamStep(trigger, reason) },
      ],
      deps.now ?? Date.now,
    );
    const result = await supervisor.runOnce();
    if (!result.acquired) {
      logger.info('Nightly consolidation skipped: lock held elsewhere — next tick retries');
    }
    return result;
  };
}
