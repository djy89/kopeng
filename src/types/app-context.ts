import type { IMemoryStore, IVectorSearch, IDatabaseLifecycle, IObservationStore, IDreamStore, IOperatorConfigStore } from '../database/interfaces.js';
import type { MemoryCache } from '../cache/memory-cache.js';
import type { DiscoveryScheduler } from '../discovery/scheduler.js';
import type { ObservationBus } from '../services/observation-bus.js';
import type { ActivityTracker } from '../dreaming/activity-tracker.js';
import type { RunDreamOptions, DreamRunResult } from '../dreaming/dream-engine.js';
import type { ReasonerLivenessStatus } from '../dreaming/reasoner/liveness.js';

/**
 * Application context container — bundles all stores, services, and lifecycle
 * dependencies needed by route handlers and background tasks.
 *
 * Replaces the growing registerRoutes() parameter list (R7). server.ts builds
 * it; registerRoutes destructures it. Optional members mirror the feature
 * flags that gate their construction.
 */
export interface AppContext {
  stores: {
    queries: IMemoryStore;
    observations?: IObservationStore;
    dreams?: IDreamStore;
    operatorConfig?: IOperatorConfigStore;
  };
  services: {
    embeddingIndex: IVectorSearch;
    memoryCache?: MemoryCache;
    discoveryScheduler?: DiscoveryScheduler;
    observationBus?: ObservationBus;
    activityTracker?: ActivityTracker;
    /** Manual-trigger dream pass (engine's own lock acquisition). */
    dreamRunner?: (opts: RunDreamOptions) => Promise<DreamRunResult>;
    /**
     * T21 read-only reasoner liveness (armed / reachable / model / last-classify-at).
     * Present whenever the dreaming stack is constructed; the ops endpoint
     * degrades to a disarmed status when absent.
     */
    reasonerStatus?: () => Promise<ReasonerLivenessStatus>;
  };
  lifecycle: IDatabaseLifecycle;
}
