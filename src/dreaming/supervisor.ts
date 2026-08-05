/**
 * Consolidation supervisor (D0.4): runs an ordered set of consolidation steps —
 * canonically discovery → promotion → dream — under one consolidation lock.
 *
 * - Acquire-or-skip: if the lock is held elsewhere the whole run is skipped
 *   (`acquired: false`), so two supervisors never consolidate the same scope at once.
 * - Sequential: steps run in the order given; the caller owns the ordering.
 * - Failure-isolated: one step throwing is logged and recorded, the rest still run —
 *   a discovery hiccup must not starve promotion (the path D0.4 finally schedules).
 *
 * The steps are injected so this stays free of the not-yet-built dream engine
 * (D0.6) and dream scheduler (D0.5); they supply the concrete step set.
 */
import type { IConsolidationLock } from './lock.js';
import logger from '../utils/logger.js';

export interface SupervisorStep {
  name: string;
  run(): Promise<void>;
}

export interface StepOutcome {
  name: string;
  status: 'completed' | 'failed';
  durationMs: number;
  error?: string;
}

export interface SupervisorRunResult {
  /** False when the lock was held elsewhere and the run was skipped wholesale. */
  acquired: boolean;
  steps: StepOutcome[];
}

export class ConsolidationSupervisor {
  constructor(
    private readonly lock: IConsolidationLock,
    private readonly steps: SupervisorStep[],
    private readonly now: () => number = Date.now,
  ) {}

  async runOnce(): Promise<SupervisorRunResult> {
    const { acquired, result } = await this.lock.withLock(async () => {
      const outcomes: StepOutcome[] = [];
      for (const step of this.steps) {
        const start = this.now();
        try {
          await step.run();
          outcomes.push({ name: step.name, status: 'completed', durationMs: this.now() - start });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.error(`Consolidation step '${step.name}' failed:`, err);
          outcomes.push({ name: step.name, status: 'failed', durationMs: this.now() - start, error });
        }
      }
      return outcomes;
    });
    return { acquired, steps: result ?? [] };
  }
}
