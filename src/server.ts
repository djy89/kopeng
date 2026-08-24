import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config/config.js';
import logger from './utils/logger.js';
import { getDatabase, closeDatabase, getDatabaseStats, backupDatabase } from './database/database.js';
import { MemoryQueries } from './database/queries.js';
import { EmbeddingIndex } from './embeddings/index.js';
import { initEmbedder, embedWithModel } from './embeddings/embedder.js';
import { registerRoutes } from './api/routes.js';
import type { IMemoryStore, IVectorSearch, IDatabaseLifecycle, IObservationStore, IDreamStore, IOperatorConfigStore } from './database/interfaces.js';
import { PgQueries } from './database/pg-queries.js';
import { PgVectorSearch } from './database/pg-vector-search.js';
import { initPostgres, closePool, createPgLifecycle } from './database/postgres.js';
// Phase 2: Neo4j
import { initNeo4j, closeNeo4j } from './graph/neo4j.js';
// Phase 3: Redis
import { initRedis, closeRedis } from './cache/redis.js';
import { MemoryCache } from './cache/memory-cache.js';
// Phase 4: MinIO
import { initMinio } from './storage/minio.js';
// Auto-discovery
import { getObservationsDatabase, closeObservationsDatabase } from './database/observations-db.js';
import { ObservationQueries } from './database/observation-queries.js';
import { PgObservationQueries } from './database/pg-observation-queries.js';
import { DiscoveryScheduler } from './discovery/scheduler.js';
import { DreamQueries } from './database/dream-queries.js';
import { PgDreamQueries } from './database/pg-dream-queries.js';
import { DreamScheduler } from './dreaming/scheduler.js';
import { ActivityTracker } from './dreaming/activity-tracker.js';
import { runDreamPass, RotatingWindowMemorySource, WholeCorpusMemorySource, withFlaggedPairs, type RunDreamOptions, type DreamRunResult } from './dreaming/dream-engine.js';
import { DuplicateCandidateSelector, DeterministicDiffGenerator } from './dreaming/pipeline.js';
import { NoOpReasoner } from './dreaming/reasoner/noop-reasoner.js';
import { LocalOllamaReasoner, resolveLocalReasonerSettings } from './dreaming/reasoner/local-reasoner.js';
import { ReasonerActivity, buildReasonerStatus } from './dreaming/reasoner/liveness.js';
import type { ReasonerLivenessStatus } from './dreaming/reasoner/liveness.js';
import { ConsolidationLockManager, heldLockPassthrough, uniqueHolder, type IConsolidationLock } from './dreaming/lock.js';
import { createNightlyConsolidation } from './dreaming/nightly.js';
import { ObservationBus } from './services/observation-bus.js';
import { ScopeAliasService } from './services/scope-alias.js';
import { ScopeRegistryService, resolveWriteThroughAliases } from './services/scope-registry.js';
import { buildHoldPredicate } from './discovery/hold.js';
import { ScopeRegistryQueries } from './database/scope-registry-queries.js';
import { PgScopeRegistryQueries } from './database/pg-scope-registry-queries.js';
import { UNROUTED_SCOPE } from './scopes/minting.js';
import { slugifyScope } from './scopes/resolver.js';
import { runFirstRunPreflight } from './config/first-run.js';
import type { AppContext } from './types/app-context.js';
import type pg from 'pg';
import type Database from 'better-sqlite3';

export interface ComposedServer {
  app: FastifyInstance;
  ctx: AppContext;
  /** Stops schedulers, closes the app, optional services, and the DB. Never calls process.exit. */
  shutdown: (signal?: string) => Promise<void>;
  /** Starts the discovery/dream schedulers — main() calls this once the embedder settles; composeServer never does. */
  startSchedulers: () => void;
}

/**
 * Build every store/service/closure and register routes — but do NOT listen,
 * do NOT start schedulers, do NOT call initEmbedder. The construction seam the
 * server-wiring tests drive; main() (entry-guarded below) adds the runtime.
 */
export async function composeServer(): Promise<ComposedServer> {
  let queries: IMemoryStore;
  let embeddingIndex: IVectorSearch;
  let dbLifecycle: IDatabaseLifecycle;
  let shutdownDb: () => Promise<void> | void;
  // Dreaming-layer stores (D0.2) — one instance implements both interfaces.
  let dreamStore: (IDreamStore & IOperatorConfigStore) | undefined;
  // Raw connections, kept for the promotion pipeline (decay scoring + promotion_runs).
  let pgPool: pg.Pool | null = null;
  let sqliteDb: Database.Database | null = null;

  if (config.database.type === 'postgres') {
    logger.info('Using PostgreSQL backend');
    const pool = await initPostgres();
    pgPool = pool;
    queries = new PgQueries(pool);
    embeddingIndex = new PgVectorSearch(pool);
    dbLifecycle = createPgLifecycle();
    dreamStore = new PgDreamQueries(pool);
    shutdownDb = async () => { await closePool(); };
  } else {
    logger.info('Using SQLite backend');
    const db = getDatabase();
    sqliteDb = db;
    queries = new MemoryQueries(db);
    embeddingIndex = new EmbeddingIndex();
    dreamStore = new DreamQueries(db);
    dbLifecycle = {
      async initialize() {
        getDatabase();
      },
      async close() {
        closeDatabase();
      },
      async getStats() {
        return getDatabaseStats();
      },
      async backup() {
        return backupDatabase();
      },
    };
    shutdownDb = () => { closeDatabase(); };
  }

  // T46: operator-curated scope-alias resolution — write-time canonicalization
  // + recall-time expansion. Lives on the same store as operator_config, so
  // it's available whenever dreamStore is (both backends construct it above).
  const scopeAliases = dreamStore ? new ScopeAliasService(dreamStore) : undefined;

  // Phase 3: scope registry — write-time minting/quarantine/reroute + the
  // primary-scope triage for scopeless writes (operator_config.primary_scope
  // over the PRIMARY_SCOPE env default).
  const scopeRegistryStore = pgPool ? new PgScopeRegistryQueries(pgPool) : new ScopeRegistryQueries(sqliteDb!);
  const scopeRegistry = new ScopeRegistryService({
    registry: scopeRegistryStore,
    configStore: dreamStore,
    envPrimaryScope: config.scopes.primaryScope || undefined,
    // Round-2 CO1: the primary scope is alias-canonicalized where it is LOADED,
    // so the scopeless branch and decideMint's malformed reroute agree.
    canonicalize: scopeAliases ? (s: string) => scopeAliases.canonicalize(s) : undefined,
  });
  // Seed the reserved triage scope (idempotent — register is ON CONFLICT DO
  // NOTHING; R-D: a mint can never claim a reserved scope).
  await scopeRegistryStore.register({
    scope: UNROUTED_SCOPE, slug: slugifyScope(UNROUTED_SCOPE),
    claimant_raw: UNROUTED_SCOPE, origin_cwd: null, status: 'confirmed', reserved: true,
  });

  logger.info('Database initialized');

  // Load existing embeddings into index
  const embeddings = await queries.loadAllEmbeddings();
  await embeddingIndex.loadFromDatabase(embeddings);

  // Initialize optional services
  let memoryCache: MemoryCache | undefined;
  let observationStore: IObservationStore | undefined;
  let discoveryScheduler: DiscoveryScheduler | undefined;
  let observationBus: ObservationBus | undefined;
  let activityTracker: ActivityTracker | undefined;
  let dreamScheduler: DreamScheduler | undefined;
  let dreamRunner: ((opts: RunDreamOptions) => Promise<DreamRunResult>) | undefined;

  // Auto-discovery: observation store
  if (config.discovery.ingestionEnabled) {
    try {
      if (config.database.type === 'postgres') {
        const { getPool } = await import('./database/postgres.js');
        observationStore = new PgObservationQueries(getPool());
        logger.info('PostgreSQL observation store enabled');
      } else {
        const obsDb = getObservationsDatabase(config.database.path);
        observationStore = new ObservationQueries(obsDb);
        logger.info('SQLite observation store enabled (observations.db)');
      }
    } catch (err) {
      logger.error('Observation store initialization failed — ingestion disabled:', err);
    }
  }

  // D2.1/D2.2: ONE shared reasoner — the dream pipeline's classify path and the
  // discovery tier-2 classify-before-reinforce guard use the same provider.
  // Env-flag-gated (DREAM_REASONER_ENABLED); OFF or provider-down degrades to
  // NoOp, i.e. exact Phase-1 behavior everywhere it is consulted. Knobs
  // (url/model/timeouts) resolve per call from operator_config's
  // `dream_reasoner` blob over the env defaults — hot-editable.
  const dreamStoreForSettings = dreamStore;
  // T21: shared in-process liveness stamp — the live reasoner marks each
  // successful classify and the ops reasoner-status endpoint reads it.
  const reasonerActivity = new ReasonerActivity();
  const reasoner = config.dreaming.reasoner.enabled
    ? new LocalOllamaReasoner({
        settings: () => resolveLocalReasonerSettings(dreamStoreForSettings, config.dreaming.reasoner),
        onClassify: () => reasonerActivity.stampClassify(),
      })
    : new NoOpReasoner();

  // T21: read-only reasoner liveness for GET /api/ops/reasoner-status. Resolves
  // the same per-call settings the reasoner uses (operator_config over env),
  // probes the provider fail-soft, and folds in the last-classify stamp.
  const reasonerStatus = (): Promise<ReasonerLivenessStatus> => buildReasonerStatus({
    armed: config.dreaming.reasoner.enabled,
    settings: async () => {
      if (!dreamStoreForSettings) return { url: config.dreaming.reasoner.url, model: config.dreaming.reasoner.model };
      const s = await resolveLocalReasonerSettings(dreamStoreForSettings, config.dreaming.reasoner);
      return { url: s.url, model: s.model };
    },
    activity: reasonerActivity,
  });

  // T21: persist reasoner_provider='ollama' for display truth (viz review tab /
  // get_operator_config read this column). Read-merge-write so a boot doesn't
  // rewrite an already-correct row; only the reasoner_provider COLUMN is patched
  // (updateConfig is column-targeted), so the `config` JSON blob — where the
  // whole-corpus/rotation cursors live — is never touched. Fire-and-forget +
  // fail-soft: a config write must never block startup. (TOCTOU note: two boots
  // racing this read-then-write both converge on 'ollama', so the race is benign.)
  if (config.dreaming.reasoner.enabled && dreamStore) {
    void (async () => {
      try {
        const cfg = await dreamStore.getConfig('default');
        if (cfg && cfg.reasoner_provider !== 'ollama') {
          await dreamStore.updateConfig('default', { reasoner_provider: 'ollama' });
          logger.info("Reasoner armed — set operator_config.reasoner_provider = 'ollama' (display truth)");
        }
      } catch (err) {
        logger.warn(`Could not set reasoner_provider display truth: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // Auto-discovery: scheduler (requires both ingestion and detection).
  // R5: discovery passes acquire-or-skip the consolidation lock, so a pass can't
  // rewrite memories mid-dream (and vice versa). Skipped passes keep their
  // observation counter and retry on the next debounced tick.
  if (config.discovery.detectionEnabled && observationStore) {
    discoveryScheduler = new DiscoveryScheduler(
      observationStore,
      queries,
      embeddingIndex,
      config.discovery,
      dreamStore ? new ConsolidationLockManager({ store: dreamStore, holder: 'discovery' }) : undefined,
      reasoner,
      scopeAliases ? (s: string) => scopeAliases.canonicalize(s) : undefined,
      // Phase 3 (Task 8): registry-aware resolution BEFORE detection grouping,
      // so alias-cased raw scopes pool their evidence; raw stays lineage.
      // Round-2 A3: the SHARED alias-first composition — never hand-rolled
      // (the hand-rolled registry-only version here was the final-review
      // Critical).
      async (raw: string, origin: string | null) =>
        (await resolveWriteThroughAliases(scopeAliases, scopeRegistry, raw, origin)).scope,
      // Round-2 CO5: held iff ephemeral-shaped AND not alias-mapped — a ruled
      // ephemeral scope's observations resolve to the target instead of being
      // held forever.
      buildHoldPredicate(scopeAliases ? (s: string) => scopeAliases.canonicalize(s) : undefined)
    );
  }

  // Dreaming: activity tracker + scheduler (D0.5). Feature-flagged; mirrors the
  // discovery scheduler's lifecycle. The fire ACTION is a logged stub until D0.6
  // wires the dream engine — the offline-detection firing itself is live here.
  if (config.dreaming.enabled && dreamStore) {
    activityTracker = new ActivityTracker();
    // The dream engine (D0.6 runner + D1.2 detection/diff + D1.3 apply). Scheduler
    // firing and the manual trigger endpoint both go through this one runner,
    // differing only by trigger/dry-run.
    const dreamStoreRef = dreamStore;
    // The optional lock override lets the nightly supervisor chain run the dream
    // step under ITS hold (heldLockPassthrough); manual triggers omit it and the
    // engine acquires for itself (R5).
    const runDreamWithLock = async (opts: RunDreamOptions, lockOverride?: IConsolidationLock) => {
      // T6: the manual whole-corpus activation path (T17) swaps the rotating
      // window for the WholeCorpusMemorySource — every active id, with the
      // id-segment reasoner gate. Default stays the nightly rotating window.
      // Whole-corpus already co-windows the entire corpus, so it is NOT wrapped
      // with withFlaggedPairs (that exists only to rescue flagged pairs from the
      // rotation blind spot). Reachable via an explicit mode:'whole_corpus'
      // trigger AND (T6.3) the scheduler's monthly cadence — which ships 'off',
      // so no scheduled sweep fires until the operator flips the review-tab toggle.
      const wholeCorpus = opts.mode === 'whole_corpus';
      // Phase 2: alias-aware pass — one resolution snapshot per pass, sync
      // closures downstream. No service / snapshot failure ⇒ identity (fail-open).
      const resolution = scopeAliases ? await scopeAliases.snapshot().catch(() => null) : null;
      const canonicalize = resolution ? (s: string) => resolution.forward.get(s) ?? s : undefined;
      return runDreamPass({
      dreamStore: dreamStoreRef,
      configStore: dreamStoreRef,
      mode: wholeCorpus ? 'whole_corpus' : 'windowed',
      // D1.4: rotating window — each pass takes the next 500-id segment (cursor in
      // operator_config.config), wrapping at the top, so the whole corpus is
      // revisited instead of only the newest 500 forever. D2.2: every window is
      // augmented with ingestion-flagged contradiction pairs + their partners —
      // a flagged pair never waits for rotation to co-window it.
      source: wholeCorpus
        ? new WholeCorpusMemorySource(queries, dreamStoreRef, {})
        : withFlaggedPairs(
            new RotatingWindowMemorySource(queries, dreamStoreRef, { limit: 500 }),
            queries,
          ),
      selector: new DuplicateCandidateSelector({ canonicalize }),
      // D2.1/D2.2: the shared local reasoner (classify + extract-condition;
      // invariant #3 — the deterministic engine owns every write).
      reasoner,
      diffGen: new DeterministicDiffGenerator({ aliasVersion: resolution?.version ?? null, canonicalize }),
      // R9: unique per-acquisition holder — concurrent manual triggers must not
      // co-acquire via same-holder re-entry (the loser would release the
      // winner's hold mid-write).
      lock: lockOverride ?? new ConsolidationLockManager({ store: dreamStoreRef, holder: uniqueHolder('dream-engine') }),
      tz: config.dreaming.defaultTimezone,
      // Aligns the pipeline's per-call Promise.race cap (R4b enforcement)
      // with the adapter's own timeout; the pass budget still bounds the total.
      reasonerTimeoutMs: config.dreaming.reasoner.timeoutMs,
      // D1.3 apply path: deterministic-safe entries auto-apply ONLY when the
      // operator_config auto_accept_* flags are ON (they ship OFF; GATE 1
      // governs the flip). Everything else queues as pending. embedText (D2.2)
      // only ever runs on operator-accepted conditional encodings.
      apply: {
        memoryStore: queries, vectorIndex: embeddingIndex, embedText: embedWithModel,
        // Team-review #22 r2 NEW-1: the canonical-survivor preference must run on
        // the auto-apply path too, not only on operator resolve (routes.ts).
        canonicalizeScope: scopeAliases ? (s: string) => scopeAliases.canonicalize(s) : undefined,
      },
    }, opts);
    };
    dreamRunner = (opts: RunDreamOptions) => runDreamWithLock(opts);

    // R5: the nightly fire runs promotion → dream under ONE lock hold — this is
    // also what finally puts the promotion pipeline on a schedule.
    const nightlyConsolidation = createNightlyConsolidation({
      lock: new ConsolidationLockManager({ store: dreamStoreRef, holder: 'nightly-consolidation' }),
      runPromotionStep: async () => {
        const { runPromotion } = await import('./promotion/promotion-engine.js');
        const { readAutoCrystallize } = await import('./promotion/crystallize.js');
        // GATE 1: the scheduled promotion pass may only archive classes the
        // operator has flipped on — same flags that gate the dream apply path.
        // Duplicate archival is retired (GATE 1): the dream apply path owns
        // dup collapse; promotion only reports candidates.
        const cfg = await dreamStoreRef.getConfig().catch(() => null);
        await runPromotion(queries, embeddingIndex, pgPool, sqliteDb, {
          archiveDecayed: cfg?.auto_accept_decay ?? false,
          // T30.3: audited auto-crystallization, gated by the config-blob flag
          // (default OFF) — same GATE posture as the auto_accept_* classes.
          crystallize: readAutoCrystallize(cfg?.config),
          // R14: route decay archival through the audited dream apply path.
          dreamStore: dreamStoreRef,
        });
      },
      runDreamStep: async (trigger, reason) => {
        await runDreamWithLock({ trigger, reason }, heldLockPassthrough);
      },
    });

    dreamScheduler = new DreamScheduler({
      dreamStore,
      configStore: dreamStore,
      activity: activityTracker,
      // R3: observation recency floors the idle signal so a restart can't fake
      // idleness. Undefined when ingestion is off — tracker-only behavior.
      observationStore,
      runDream: async (trigger, reason, mode) => {
        // T6.3: a scheduled whole-corpus sweep runs the engine directly — it
        // acquires the consolidation lock itself (acquire-or-skip: a busy
        // nightly chain just defers the sweep to a later tick). The nightly
        // pass keeps the R5 promotion → dream supervisor chain.
        if (mode === 'whole_corpus') {
          await runDreamWithLock({ trigger, reason, mode: 'whole_corpus' });
          return;
        }
        await nightlyConsolidation(trigger, reason);
      },
      intervalMs: config.dreaming.intervalMs,
      defaults: {
        tz: config.dreaming.defaultTimezone,
        idleMinutes: config.dreaming.defaultIdleMinutes,
        quietStartHour: config.dreaming.defaultQuietStartHour,
        quietEndHour: config.dreaming.defaultQuietEndHour,
      },
    });
    logger.info('Dream scheduler wired to nightly consolidation chain (R5: promotion → dream under one lock hold; D1.3 apply gated by operator_config auto_accept_* — ship OFF)');
    logger.info(config.dreaming.reasoner.enabled
      ? `Dream reasoner enabled (D2.2: classify + extract-condition; discovery tier-2 guard armed): ${config.dreaming.reasoner.model} @ ${config.dreaming.reasoner.url} — operator_config dream_reasoner overrides apply per call`
      : 'Dream reasoner disabled (DREAM_REASONER_ENABLED=false) — NoOp, Phase-1 behavior');
  }

  // Live observation bus (in-process pub/sub for the SSE endpoint).
  // Bound to observation ingestion — no observations means no events to emit.
  if (observationStore) {
    observationBus = new ObservationBus();
    logger.info('Observation event bus initialized');
  }

  // Neo4j (Phase 2)
  if (config.neo4j.enabled) {
    try {
      await initNeo4j();
      logger.info('Neo4j graph memory enabled');
    } catch (err) {
      logger.error('Neo4j initialization failed — graph features disabled:', err);
    }
  }

  // Redis (Phase 3)
  if (config.redis.enabled) {
    try {
      const redis = await initRedis();
      memoryCache = new MemoryCache(redis);
      logger.info('Redis working memory enabled');
    } catch (err) {
      logger.error('Redis initialization failed — caching disabled:', err);
    }
  }

  // MinIO (Phase 4)
  if (config.minio.enabled) {
    try {
      await initMinio();
      logger.info('MinIO artifact storage enabled');
    } catch (err) {
      logger.error('MinIO initialization failed — artifact storage disabled:', err);
    }
  }

  // Create Fastify app
  const app = Fastify({
    logger: false, // We use Winston
    bodyLimit: config.search.maxContentSize * 2,
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
    // Exempt loopback from rate limiting. Local tooling — the viz proxy and the
    // recall/observe hooks — funnels every request through 127.0.0.1, and a single
    // viz graph load pages the whole corpus (~45 sequential /api/memories calls),
    // which trips the 100/min cap and surfaces as "error: memories: 429". Remote
    // clients (e.g. VPN peers) stay rate-limited; loopback is same-machine
    // and already trusted (ops/SSE endpoints are open under the same model).
    allowList: (req) => {
      const ip = req.ip || '';
      return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
    },
  });

  // Zod error handler
  app.setErrorHandler((error, _request, reply) => {
    // Fastify v5 types the error-handler param as `unknown`; narrow to the
    // Error-with-statusCode shape we rely on.
    const err = error as Error & { statusCode?: number };
    if (err.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(err.message) });
      return;
    }
    logger.error('Request error:', err);
    reply.status(err.statusCode || 500).send({ error: err.message || 'Internal server error' });
  });

  // Register routes (R7: one AppContext instead of a positional parameter list)
  const ctx: AppContext = {
    stores: {
      queries,
      observations: observationStore,
      dreams: dreamStore,
      operatorConfig: dreamStore,
    },
    services: {
      embeddingIndex,
      memoryCache,
      discoveryScheduler,
      observationBus,
      activityTracker,
      dreamRunner,
      reasonerStatus,
      scopeAliases,
      scopeRegistry,
    },
    lifecycle: dbLifecycle,
  };
  registerRoutes(app, ctx);

  // Graceful shutdown minus process.exit — main() wraps it with the exit.
  const shutdown = async (signal?: string) => {
    logger.info(`Received ${signal ?? 'shutdown'}, shutting down...`);
    if (discoveryScheduler) discoveryScheduler.stop();
    if (dreamScheduler) dreamScheduler.stop();
    await app.close();
    if (config.neo4j.enabled) await closeNeo4j();
    if (config.redis.enabled) await closeRedis();
    if (config.discovery.ingestionEnabled) closeObservationsDatabase();
    await shutdownDb();
  };

  const startSchedulers = () => {
    if (discoveryScheduler) {
      discoveryScheduler.start();
    }
    if (dreamScheduler) {
      dreamScheduler.start();
    }
  };

  return { app, ctx, shutdown, startSchedulers };
}

async function main() {
  logger.info(`Starting KOPENG REST server v${config.mcp.version}`);

  // First-run preflight (S1/S2): resolve-or-generate the admin key and refuse a
  // keyless non-loopback bind BEFORE composition. config is post-dotenv, so its
  // values are the launch-env channel first-run.ts expects (it never reads
  // process.env for resolution). server.ts sits in src/ (or dist/), so '..' is
  // the repo root in both layouts — same .env config.ts loads.
  const envPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.env');
  const firstRunEnv = {
    host: config.server.host,
    adminApiKey: config.server.adminApiKey,
    observationApiKey: config.discovery.apiKey,
  };
  runFirstRunPreflight(envPath, firstRunEnv);
  config.server.adminApiKey = firstRunEnv.adminApiKey;

  const { app, ctx, shutdown, startSchedulers } = await composeServer();

  // S7: access-log retention — boot trim BEFORE listen (team-review fix): the
  // SQLite DELETE is synchronous on the event loop (~100ms at live scale on a
  // first catch-up trim), so it must finish before requests can queue behind
  // it. Failure is never fatal.
  try {
    const trimmed = await ctx.stores.queries.trimAccessLog(config.retention.accessLogDays);
    if (trimmed > 0) logger.info(`access-log retention: trimmed ${trimmed} rows older than ${config.retention.accessLogDays}d`);
  } catch (err) {
    logger.warn('access-log retention failed (non-fatal):', err);
  }

  // Start server
  await app.listen({ port: config.server.port, host: config.server.host });
  logger.info(`REST API listening on ${config.server.host}:${config.server.port}`);

  // Load embedding model in background (server is already accepting keyword-only requests)
  initEmbedder().then(() => {
    logger.info('Embedding model ready — hybrid search enabled');
    // Start schedulers after embedding model is ready
    startSchedulers();
  }).catch((err) => {
    logger.error('Failed to load embedding model:', err);
    logger.warn('Continuing with keyword-only search');
    // Start schedulers anyway — they handle missing embeddings gracefully
    startSchedulers();
  });

  // Log startup diagnostics
  const stats = await ctx.stores.queries.getCount();
  const ftsCount = await ctx.stores.queries.getFtsCount();
  logger.info(`Startup diagnostics: ${stats} memories, ${ftsCount} FTS entries, ${ctx.services.embeddingIndex.size} embeddings`);

  const stop = async (signal: string) => {
    await shutdown(signal);
    process.exit(0);
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

// Boot only when server.ts is the process entry (node dist/server.js) — the
// viz-server.js pattern, so tests can import composeServer without booting.
const isMain = process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    logger.error('Fatal startup error:', error);
    process.stderr.write(`kopeng server failed: ${error.message || error}\n`);
    process.exit(1);
  });
}
