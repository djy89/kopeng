import type { IMemoryStore, IVectorSearch, IDatabaseLifecycle, IObservationStore, IDreamStore, IOperatorConfigStore } from '../database/interfaces.js';
import type { MemoryCache } from '../cache/memory-cache.js';
import type { DiscoveryScheduler } from '../discovery/scheduler.js';
import type { ObservationBus } from '../services/observation-bus.js';
import type { ActivityTracker } from '../dreaming/activity-tracker.js';
import type { RunDreamOptions, DreamRunResult } from '../dreaming/dream-engine.js';
import type { ReasonerLivenessStatus } from '../dreaming/reasoner/liveness.js';
import type { ScopeAliasService } from '../services/scope-alias.js';
import type { ScopeRegistryService } from '../services/scope-registry.js';

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
    /** T46 scope-alias layer: write-time canonicalization + recall expansion. */
    scopeAliases?: ScopeAliasService;
    /** Phase 3 scope registry: write-time minting/quarantine/reroute + primary-scope triage. */
    scopeRegistry?: ScopeRegistryService;
    /**
     * Task 2.4.1: fires the SAME graceful-shutdown routine the SIGTERM/SIGINT
     * handlers use (server.ts wires it to `shutdown`), so `POST
     * /api/admin/shutdown` and a real signal take one code path. Absent only
     * in tests/harnesses that compose routes without the full server.ts
     * wiring — the route degrades to a named refusal rather than crashing.
     */
    requestShutdown?: () => void;
  };
  lifecycle: IDatabaseLifecycle;
}
