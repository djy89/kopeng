/**
 * Discovery scheduler — debounced interval timer with guards.
 *
 * - Checks unprocessed observation count against triggerEveryN threshold
 * - Also checks for stale unprocessed observations (time-based fallback)
 * - isRunning guard prevents overlapping discovery runs
 * - R5: passes acquire-or-skip the consolidation lock — a held lock (nightly
 *   promotion → dream chain) skips the pass; the counter survives, so the next
 *   debounced tick retries
 * - Runs outside request handlers to avoid event loop blocking from ONNX inference
 */

import type { IObservationStore, IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import type { DiscoveryConfig } from '../types/types.js';
import type { IConsolidationLock } from '../dreaming/lock.js';
import type { ConsolidationReasoner } from '../dreaming/reasoner/reasoner.js';
import { runDiscovery, setEmbeddingIndexRef } from './discovery-engine.js';
import type { HoldPredicate } from './hold.js';
import logger from '../utils/logger.js';

export class DiscoveryScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private observationCounter = 0;

  private observationStore: IObservationStore;
  private memoryStore: IMemoryStore;
  private embeddingIndex: IVectorSearch;
  private config: DiscoveryConfig;
  private lock?: IConsolidationLock;
  private reasoner?: ConsolidationReasoner;
  private canonicalizeScope?: (scope: string) => Promise<string>;
  private resolveScope?: (raw: string, origin: string | null) => Promise<string>;
  private isHeld?: HoldPredicate;

  constructor(
    observationStore: IObservationStore,
    memoryStore: IMemoryStore,
    embeddingIndex: IVectorSearch,
    config: DiscoveryConfig,
    lock?: IConsolidationLock,
    /** D2.2: the tier-2 classify-before-reinforce guard (absent → Phase-1 dedup). */
    reasoner?: ConsolidationReasoner,
    /** T46: write-time scope canonicalization (absent → identity). */
    canonicalizeScope?: (scope: string) => Promise<string>,
    /** Phase 3 (Task 8): registry-aware scope resolution before detection grouping (absent → raw). */
    resolveScope?: (raw: string, origin: string | null) => Promise<string>,
    /** Round-2 CO5: the shared hold predicate (absent → shape-only ephemeralReason). */
    isHeld?: HoldPredicate
  ) {
    this.observationStore = observationStore;
    this.memoryStore = memoryStore;
    this.embeddingIndex = embeddingIndex;
    this.config = config;
    this.lock = lock;
    this.reasoner = reasoner;
    this.canonicalizeScope = canonicalizeScope;
    this.resolveScope = resolveScope;
    this.isHeld = isHeld;

    // Set the embedding index reference for the discovery engine
    setEmbeddingIndexRef(embeddingIndex);
  }

  /**
   * Start the periodic check timer.
   */
  start(): void {
    if (this.intervalId) return;

    logger.info(`Discovery scheduler started (interval: ${this.config.discoveryIntervalMs}ms, trigger every ${this.config.triggerEveryN} observations)`);

    this.intervalId = setInterval(() => {
      this.tick().catch(err => {
        logger.error('Discovery scheduler tick failed:', err);
      });
    }, this.config.discoveryIntervalMs);

    // Don't prevent process exit
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Discovery scheduler stopped');
    }
  }

  /**
   * Increment the observation counter (called by ingestion endpoint).
   * May trigger an immediate discovery run if threshold is reached.
   */
  incrementCounter(): void {
    this.observationCounter++;
  }

  /**
   * Get current counter value (for testing/monitoring).
   */
  getCounter(): number {
    return this.observationCounter;
  }

  /**
   * Check whether the scheduler is currently active.
   */
  get isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Check whether a discovery run is currently executing.
   */
  get isDiscoveryRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Periodic tick: check whether to trigger discovery.
   */
  async tick(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Discovery tick skipped: already running');
      return;
    }

    const shouldRun = await this.shouldTrigger();
    if (!shouldRun) return;

    await this.executeDiscovery();
  }

  /**
   * Force a discovery run (called by manual trigger endpoint).
   */
  async triggerNow(): Promise<ReturnType<typeof runDiscovery>> {
    return this.executeDiscovery();
  }

  /**
   * Determine whether discovery should be triggered.
   * Two conditions (either triggers):
   * 1. Observation counter >= triggerEveryN
   * 2. Starvation: unprocessed observations older than analysisWindowHours
   */
  private async shouldTrigger(): Promise<boolean> {
    // Threshold check
    if (this.observationCounter >= this.config.triggerEveryN) {
      logger.debug(`Discovery trigger: counter (${this.observationCounter}) >= threshold (${this.config.triggerEveryN})`);
      return true;
    }

    // Starvation check: are there old unprocessed observations?
    try {
      const lastWatermark = await this.observationStore.getLastWatermark();
      const unprocessedCount = await this.observationStore.getUnprocessedCount(lastWatermark);

      if (unprocessedCount > 0) {
        // Check if oldest unprocessed observation is past the analysis window
        const observations = await this.observationStore.getObservationsSince(lastWatermark, undefined, 1);
        if (observations.length > 0) {
          const oldestAge = Date.now() - new Date(observations[0].created_at).getTime();
          const windowMs = this.config.analysisWindowHours * 60 * 60 * 1000;
          if (oldestAge > windowMs) {
            logger.debug(`Discovery trigger: starvation (${unprocessedCount} unprocessed, oldest ${Math.round(oldestAge / 3600000)}h old)`);
            return true;
          }
        }
      }
    } catch (err) {
      logger.error('Error checking starvation condition:', err);
    }

    return false;
  }

  /**
   * Execute a discovery run with the isRunning guard.
   *
   * R5: when a consolidation lock is wired, the pass acquires-or-skips it. On
   * skip the observation counter is NOT reset, so shouldTrigger() stays true and
   * the next debounced tick retries once the lock frees up.
   */
  private async executeDiscovery(): Promise<ReturnType<typeof runDiscovery>> {
    if (this.isRunning) {
      logger.debug('Discovery execution skipped: already running');
      return this.skippedResult();
    }

    if (this.lock) {
      const { acquired, result } = await this.lock.withLock(() => this.runGuarded());
      if (!acquired) {
        logger.info('Discovery pass skipped: consolidation lock held elsewhere — next tick retries');
        return this.skippedResult();
      }
      return result!;
    }
    return this.runGuarded();
  }

  private async runGuarded(): Promise<ReturnType<typeof runDiscovery>> {
    this.isRunning = true;
    this.observationCounter = 0; // Reset counter

    try {
      const result = await runDiscovery(
        this.observationStore,
        this.memoryStore,
        this.embeddingIndex,
        { config: this.config, reasoner: this.reasoner, canonicalizeScope: this.canonicalizeScope, resolveScope: this.resolveScope, isHeld: this.isHeld }
      );
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  private skippedResult(): Awaited<ReturnType<typeof runDiscovery>> {
    return {
      run_id: 0,
      project_scope: 'skipped',
      observations_analyzed: 0,
      patterns_found: 0,
      memories_created: 0,
      memories_reinforced: 0,
      duration_ms: 0,
    };
  }
}
