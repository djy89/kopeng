/**
 * Discovery engine orchestrator.
 *
 * Coordinates observation retrieval, heuristic detection, semantic deduplication,
 * and memory creation for auto-discovered patterns.
 *
 * Key design:
 * - Watermark cursor: each run starts from id > last completed run's end_id
 * - Optimistic locking: checks for active runs, recovers stale (>10min) ones
 * - Three-tier semantic dedup: >=0.95 reinforce, 0.85-0.95 reinforce+log, <0.85 create
 * - Content security denylist: rejects dangerous patterns
 * - Confidence ceiling: 0.85 for auto-discovered memories
 * - Event loop yields between embedding calls
 */

import type { IObservationStore, IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import type { DiscoveryResult, PatternCandidate, DiscoveryConfig } from '../types/types.js';
import { detectPatterns } from './heuristics.js';
import { synthesizePatterns } from './synthesizer.js';
import { computeConfidence, computeErrorPatternConfidence, reinforceConfidence, AUTO_CONFIDENCE_CEILING } from './confidence.js';
import { embed, embeddingToBuffer } from '../embeddings/embedder.js';
import type { ConsolidationReasoner, CandidateMemory } from '../dreaming/reasoner/reasoner.js';
import {
  classifyForIngestion, buildContradictionFlag, CONTRADICTION_FLAG_TAG, CONTRADICTION_FLAG_KEY,
} from '../dreaming/contradiction.js';
import logger from '../utils/logger.js';

/** Stale run threshold in milliseconds (10 minutes). */
const STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Content security denylist patterns.
 * Auto-discovered memories containing these are rejected to prevent memory poisoning.
 */
const CONTENT_DENYLIST: RegExp[] = [
  // URLs (potential phishing/injection)
  /https?:\/\/[^\s]+/i,
  // Dangerous shell patterns
  /curl\s.*\|\s*(?:sh|bash)/i,
  /wget\s.*\|\s*(?:sh|bash)/i,
  /rm\s+-rf\s+\//,
  /eval\s*\(/i,
  /--no-verify/i,
  // Base64-encoded command execution
  /base64\s+-d\s*\|/i,
  // Reverse shells
  /\/dev\/tcp\//i,
  /nc\s+-[elp]/i,
];

/**
 * Check if pattern content passes the security denylist.
 * Returns true if safe, false if blocked.
 */
export function isContentSafe(content: string): boolean {
  for (const pattern of CONTENT_DENYLIST) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return false;
  }
  return true;
}

/**
 * Yield to the event loop to prevent blocking during heavy computation.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export interface DiscoveryEngineOptions {
  config: DiscoveryConfig;
  /** Maximum observations to process per run. Default 1000. */
  maxObservationsPerRun?: number;
  /**
   * D2.2 classify-before-reinforce guard for the 0.85–0.95 dedup tier. Absent
   * (or NoOp/provider-down) → exact Phase-1 behavior (reinforce + log). With a
   * confident verdict, only a true `duplicate` still reinforces — see
   * `classifyForIngestion` in src/dreaming/contradiction.ts.
   */
  reasoner?: ConsolidationReasoner;
}

/**
 * Run a discovery cycle: fetch unprocessed observations, detect patterns, deduplicate
 * against existing memories, and create/reinforce auto-discovered memories.
 */
export async function runDiscovery(
  observationStore: IObservationStore,
  memoryStore: IMemoryStore,
  embeddingIndex: IVectorSearch,
  options: DiscoveryEngineOptions
): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const { config, maxObservationsPerRun = 1000, reasoner } = options;

  // ── Concurrency guard (optimistic locking) ──
  const activeRun = await observationStore.getActiveRun();
  if (activeRun) {
    const runAge = Date.now() - new Date(activeRun.started_at).getTime();
    if (runAge < STALE_RUN_THRESHOLD_MS) {
      logger.info(`Discovery skipped: active run #${activeRun.id} still in progress`);
      return {
        run_id: activeRun.id,
        project_scope: activeRun.project_scope,
        observations_analyzed: 0,
        patterns_found: 0,
        memories_created: 0,
        memories_reinforced: 0,
        duration_ms: Date.now() - startTime,
      };
    }
    // Stale run — mark as failed and proceed
    logger.warn(`Recovering stale discovery run #${activeRun.id} (age: ${Math.round(runAge / 1000)}s)`);
    await observationStore.updateDiscoveryRun(activeRun.id, {
      status: 'failed',
      error: 'Recovered: exceeded stale threshold',
      completed_at: new Date().toISOString(),
    });
  }

  // ── Watermark: determine start point ──
  const lastWatermark = await observationStore.getLastWatermark();
  const observations = await observationStore.getObservationsSince(lastWatermark, undefined, maxObservationsPerRun);

  if (observations.length === 0) {
    logger.info('Discovery skipped: no unprocessed observations');
    return {
      run_id: 0,
      project_scope: 'all',
      observations_analyzed: 0,
      patterns_found: 0,
      memories_created: 0,
      memories_reinforced: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  const endId = observations[observations.length - 1].id;
  const startId = observations[0].id;

  // Group observations by project scope for per-project detection
  const byProject = new Map<string, typeof observations>();
  for (const obs of observations) {
    const existing = byProject.get(obs.project_scope) ?? [];
    existing.push(obs);
    byProject.set(obs.project_scope, existing);
  }

  let totalPatternsFound = 0;
  let totalMemoriesCreated = 0;
  let totalMemoriesReinforced = 0;

  // Process each project scope independently
  for (const [projectScope, projectObs] of byProject) {
    // Create discovery run record
    const run = await observationStore.createDiscoveryRun(projectScope, startId);

    try {
      // ── Pattern detection ──
      const rawCandidates = detectPatterns(projectObs, config);

      // ── Synthesis: aggregate related patterns into actionable insights ──
      const candidates = synthesizePatterns(rawCandidates);
      if (candidates.length !== rawCandidates.length) {
        logger.info(`Synthesizer: ${rawCandidates.length} raw patterns → ${candidates.length} synthesized insights`);
      }

      // Compute confidence for each candidate (error/sequence patterns get enhanced scoring)
      for (const candidate of candidates) {
        if (candidate.pattern_type === 'recurring_error' || candidate.pattern_type === 'error_fix') {
          const hasFix = candidate.has_fix === true;
          const distinctSessions = candidate.distinct_sessions
            ?? new Set(candidate.evidence_snapshot.map(e => e.session_id)).size;
          candidate.confidence = computeErrorPatternConfidence(
            candidate.evidence_count, distinctSessions, hasFix, candidate.observation_span_days
          );
        } else if (candidate.pattern_type === 'sequence') {
          // Sequences use session count as primary signal (cross-session bonus)
          const distinctSessions = candidate.distinct_sessions
            ?? new Set(candidate.evidence_snapshot.map(e => e.session_id)).size;
          candidate.confidence = computeErrorPatternConfidence(
            candidate.evidence_count, distinctSessions, false, candidate.observation_span_days
          );
        } else {
          candidate.confidence = computeConfidence(candidate.evidence_count, candidate.observation_span_days);
        }
      }

      // ── Content security denylist ──
      const safeCandidates = candidates.filter(c => {
        if (!isContentSafe(c.content)) {
          logger.warn(`Denylist blocked pattern: "${c.description.slice(0, 80)}"`);
          return false;
        }
        return true;
      });

      totalPatternsFound += safeCandidates.length;

      // ── Semantic dedup + memory creation ──
      for (const candidate of safeCandidates) {
        await yieldToEventLoop();

        const result = await deduplicateAndStore(
          candidate,
          memoryStore,
          embeddingIndex,
          run.id,
          reasoner
        );

        if (result === 'created') totalMemoriesCreated++;
        else if (result === 'reinforced') totalMemoriesReinforced++;
      }

      // ── Mark run as completed ──
      await observationStore.updateDiscoveryRun(run.id, {
        status: 'completed',
        observation_end_id: endId,
        observations_analyzed: projectObs.length,
        patterns_found: safeCandidates.length,
        memories_created: totalMemoriesCreated,
        memories_reinforced: totalMemoriesReinforced,
        completed_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(`Discovery run #${run.id} failed:`, err);
      await observationStore.updateDiscoveryRun(run.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        observation_end_id: endId,
        completed_at: new Date().toISOString(),
      });
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Discovery completed: ${observations.length} observations, ${totalPatternsFound} patterns, ${totalMemoriesCreated} created, ${totalMemoriesReinforced} reinforced (${duration}ms)`);

  return {
    run_id: 0, // Multiple runs may have been created (one per project)
    project_scope: byProject.size === 1 ? [...byProject.keys()][0] : 'multiple',
    observations_analyzed: observations.length,
    patterns_found: totalPatternsFound,
    memories_created: totalMemoriesCreated,
    memories_reinforced: totalMemoriesReinforced,
    duration_ms: duration,
  };
}

/** Per-call bound for the tier-2 ingestion classify (the guard, not the pass budget). */
const INGESTION_CLASSIFY_TIMEOUT_MS = 10_000;

/** Render an existing memory row as a reasoner CandidateMemory. */
function memoryToCandidate(m: NonNullable<Awaited<ReturnType<IMemoryStore['get']>>>): CandidateMemory {
  return {
    id: m.id,
    content: m.content,
    content_hash: m.content_hash,
    summary: m.summary,
    tags: m.tags,
    scope: m.scope,
    // T31: the referent guard keys on type === 'discovery' (only auto-discovery
    // memories carry the template shapes) — thread the real column through.
    type: m.type,
    confidence: m.confidence,
    is_locked: m.is_locked === 1,
    created_at: m.created_at,
    updated_at: m.updated_at,
    metadata: m.metadata,
    last_seen: m.last_seen,
    observation_count: m.observation_count,
  };
}

/** Render a not-yet-stored pattern candidate as a reasoner CandidateMemory. */
function patternToCandidate(candidate: PatternCandidate, nowIso: string): CandidateMemory {
  return {
    id: -1,
    content: candidate.content,
    content_hash: null,
    summary: null,
    tags: ['auto-discovered', candidate.pattern_type],
    scope: candidate.project_scope,
    type: 'discovery', // what createDiscoveryMemory will store it as (T31 guard rail)
    confidence: candidate.confidence,
    is_locked: false,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Three-tier semantic deduplication:
 * - Similarity >= 0.95: pure reinforcement (bump confidence on existing memory)
 * - Similarity 0.85-0.95: classify-before-reinforce (D2.2) — a confident
 *   `duplicate` reinforces + logs (the Phase-1 behavior, now verified); a
 *   confident non-duplicate keeps BOTH memories (preference changes stop being
 *   silently buried under the stale belief), flagging supersession-shaped pairs
 *   for the dream layer; no reasoner / no consumable verdict → Phase-1
 *   reinforce + log, unchanged.
 * - Similarity < 0.85: create new memory
 *
 * Returns 'created', 'reinforced', or 'skipped'.
 */
async function deduplicateAndStore(
  candidate: PatternCandidate,
  memoryStore: IMemoryStore,
  embeddingIndex: IVectorSearch,
  discoveryRunId: number,
  reasoner?: ConsolidationReasoner
): Promise<'created' | 'reinforced' | 'skipped'> {
  // Skip if embedding index isn't ready (fall back to always-create)
  if (!embeddingIndex.isReady && embeddingIndex.size === 0) {
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, null);
  }

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embed(candidate.content);
  } catch {
    // Embedder not initialized — create without dedup
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, null);
  }

  // Search for existing similar memories in the same project scope
  const candidateIds = await memoryStore.getFilteredIds({
    scope: candidate.project_scope,
    include_archived: false,
  });

  if (candidateIds.length === 0) {
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding);
  }

  const searchResults = await embeddingIndex.search(queryEmbedding, candidateIds, 1);

  if (searchResults.length === 0) {
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding);
  }

  const topMatch = searchResults[0];

  // Tier 1: >= 0.95 — pure reinforcement
  if (topMatch.score >= 0.95) {
    const existing = await memoryStore.get(topMatch.id);
    if (existing) {
      const newConfidence = reinforceConfidence(existing.confidence);
      await memoryStore.updateConfidence(topMatch.id, Math.min(AUTO_CONFIDENCE_CEILING, newConfidence));
      // True re-observation: bump durability + reset the decay clock (D1.1)
      await memoryStore.reinforceOnAccess([topMatch.id]);
      logger.debug(`Reinforced memory #${topMatch.id} (${existing.confidence.toFixed(3)} ��� ${newConfidence.toFixed(3)}, similarity: ${topMatch.score.toFixed(3)})`);
      return 'reinforced';
    }
  }

  // Tier 2: 0.85-0.95 — classify BEFORE reinforcing (D2.2, plan §2.2): the band
  // may hide a preference change or contradiction, and reinforcing it would
  // silently bury the new information under the stale belief.
  if (topMatch.score >= 0.85) {
    const existing = await memoryStore.get(topMatch.id);
    if (existing) {
      const nowIso = new Date().toISOString();
      const route = reasoner
        ? await classifyForIngestion(
            reasoner,
            memoryToCandidate(existing),
            patternToCandidate(candidate, nowIso),
            { timeoutMs: INGESTION_CLASSIFY_TIMEOUT_MS, tokenBudget: 300 },
          )
        : ({ action: 'reinforce', verdict: null } as const);

      if (route.action === 'create_flagged') {
        // Possible supersession/contradiction: keep both, hand the pair to the
        // dream layer via the flag — never reinforce, never auto-pick.
        logger.info(`Tier-2 guard: candidate vs memory #${existing.id} classified '${route.verdict.relation}' — creating + flagging instead of reinforcing`);
        return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding, {
          extraMetadata: { [CONTRADICTION_FLAG_KEY]: buildContradictionFlag(existing.id, route.verdict, nowIso) },
          extraTags: [CONTRADICTION_FLAG_TAG],
        });
      }
      if (route.action === 'create') {
        // Confident unrelated (the R13 template/different-referent class):
        // both memories stand on their own — no reinforce, no flag.
        logger.info(`Tier-2 guard: candidate vs memory #${existing.id} classified 'unrelated' — creating without reinforcement`);
        return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding);
      }

      // Phase-1 reinforce + log (confirmed duplicate, or no consumable verdict).
      const newConfidence = reinforceConfidence(existing.confidence);
      await memoryStore.updateConfidence(topMatch.id, Math.min(AUTO_CONFIDENCE_CEILING, newConfidence));
      await memoryStore.reinforceOnAccess([topMatch.id]);

      // Append new evidence to existing memory's metadata
      try {
        const metadata = JSON.parse(existing.metadata || '{}');
        const history = metadata.reinforcement_history ?? [];
        history.push({
          at: new Date().toISOString(),
          evidence_count: candidate.evidence_count,
          pattern_type: candidate.pattern_type,
          similarity: topMatch.score,
          // Traceability (B1): record the reasoner verdict when one drove this
          // reinforce, so a reasoner-influenced write is distinguishable from
          // the reasoner-off baseline in the audit trail. Absent = baseline.
          ...(route.verdict
            ? { verdict: route.verdict.relation, verdict_confidence: route.verdict.confidence }
            : {}),
        });
        metadata.reinforcement_history = history.slice(-20); // Keep last 20

        await memoryStore.update(topMatch.id, {
          content: existing.content,
          type: existing.type,
          scope: existing.scope,
          metadata: JSON.stringify(metadata),
          tags: existing.tags,
        });
      } catch {
        // Metadata update failed — reinforcement still applied
      }

      logger.debug(`Reinforced+logged memory #${topMatch.id} (similarity: ${topMatch.score.toFixed(3)})`);
      return 'reinforced';
    }
  }

  // Tier 3: < 0.85 — create new memory
  return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding);
}

/**
 * Create a new auto-discovered memory from a pattern candidate.
 * `opts` (D2.2): the tier-2 guard attaches the contradiction flag metadata/tag
 * so the dream layer co-windows and routes the flagged pair.
 */
async function createDiscoveryMemory(
  candidate: PatternCandidate,
  memoryStore: IMemoryStore,
  discoveryRunId: number,
  embedding: Float32Array | null,
  opts: { extraMetadata?: Record<string, unknown>; extraTags?: string[] } = {}
): Promise<'created' | 'skipped'> {
  const metadata: Record<string, unknown> = {
    discovered: true,
    pattern_type: candidate.pattern_type,
    evidence_count: candidate.evidence_count,
    observation_span_days: candidate.observation_span_days,
    evidence_snapshot: candidate.evidence_snapshot,
    reinforcement_history: [],
    ...opts.extraMetadata,
  };

  // Carry error-specific metadata through
  if (candidate.has_fix !== undefined) {
    metadata.has_fix = candidate.has_fix;
  }
  if (candidate.distinct_sessions !== undefined) {
    metadata.distinct_sessions = candidate.distinct_sessions;
  }

  const embeddingBuffer = embedding
    ? embeddingToBuffer(embedding)
    : null;

  const confidence = Math.min(AUTO_CONFIDENCE_CEILING, candidate.confidence);

  // Build tags — error patterns get additional searchable tags, synthesized patterns get category tags
  const tags = ['auto-discovered', candidate.pattern_type];
  if (candidate.pattern_type === 'recurring_error' || candidate.pattern_type === 'error_fix') {
    tags.push('error-pattern');
    const firstEvidence = candidate.evidence_snapshot[0];
    if (firstEvidence?.error_category) {
      tags.push(`error:${firstEvidence.error_category}`);
    }
  }
  if (candidate.synthesized_tags) {
    for (const tag of candidate.synthesized_tags) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  for (const tag of opts.extraTags ?? []) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  try {
    const result = await memoryStore.store({
      content: candidate.content,
      type: 'discovery',
      scope: candidate.project_scope,
      source: 'auto-discovery',
      source_path: null,
      metadata: JSON.stringify(metadata),
      embedding: embeddingBuffer,
      embedding_model: embeddingBuffer ? 'Xenova/all-MiniLM-L6-v2' : '',
      created_by: 'discovery-engine',
      tags,
      confidence,
      discovery_run_id: discoveryRunId,
      observation_count: candidate.evidence_count,
    });

    if (result.deduplicated) {
      logger.debug(`Skipped duplicate discovery (content hash match for memory #${result.id})`);
      return 'skipped';
    }

    // Add to embedding index if we have an embedding
    if (embedding) {
      await embeddingIndex_add(result.id, embedding);
    }

    logger.info(`Created discovery memory #${result.id}: ${candidate.description.slice(0, 80)} (confidence: ${confidence.toFixed(2)})`);
    return 'created';
  } catch (err) {
    logger.error(`Failed to create discovery memory:`, err);
    return 'skipped';
  }
}

/**
 * Wrapper to safely add to embedding index.
 * Separated for testability — the index reference is captured at call time.
 */
let _embeddingIndexRef: IVectorSearch | null = null;

export function setEmbeddingIndexRef(index: IVectorSearch): void {
  _embeddingIndexRef = index;
}

async function embeddingIndex_add(id: number, embedding: Float32Array): Promise<void> {
  if (_embeddingIndexRef) {
    await _embeddingIndexRef.add(id, embedding);
  }
}
