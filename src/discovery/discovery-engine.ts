/**
 * Discovery engine orchestrator.
 *
 * Coordinates observation retrieval, heuristic detection, semantic deduplication,
 * and memory creation for auto-discovered patterns.
 *
 * Key design:
 * - Watermark cursor: each run starts from id > the global watermark (MAX end_id
 *   over completed AND held runs — see GLOBAL_WATERMARK_STATUSES in interfaces.ts)
 * - Optimistic locking: checks for active runs, recovers stale (>10min) ones
 * - Three-tier semantic dedup: >=0.95 reinforce, 0.85-0.95 reinforce+log, <0.85 create
 * - Content security denylist: rejects dangerous patterns
 * - Confidence ceiling: 0.85 for auto-discovered memories
 * - Event loop yields between embedding calls
 */

import type { IObservationStore, IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import type { DiscoveryResult, PatternCandidate, DiscoveryConfig } from '../types/types.js';
import { SKILL_TAG } from '../types/types.js';
import { detectPatterns } from './heuristics.js';
import { synthesizePatterns } from './synthesizer.js';
import { assignCandidateConfidence, reinforcedConfidenceFor, AUTO_CONFIDENCE_CEILING } from './confidence.js';
import { embed, embeddingToBuffer } from '../embeddings/embedder.js';
import type { ConsolidationReasoner, CandidateMemory } from '../dreaming/reasoner/reasoner.js';
import {
  classifyForIngestion, buildContradictionFlag, CONTRADICTION_FLAG_TAG, CONTRADICTION_FLAG_KEY,
} from '../dreaming/contradiction.js';
import { ephemeralReason } from '../scopes/drift.js';
import { buildHoldPredicate, type HoldPredicate } from './hold.js';
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
  /**
   * T46 write-time scope canonicalization — discovery mints `project:<basename>`
   * scopes from observations, which is exactly the drift the alias table exists
   * to stop. Absent ⇒ identity.
   */
  canonicalizeScope?: (scope: string) => Promise<string>;
  /**
   * Phase 3 registry-aware resolution applied BEFORE grouping; absent ⇒ raw
   * grouping, byte-identical to pre-Phase-3.
   */
  resolveScope?: (raw: string, origin: string | null) => Promise<string>;
  /**
   * Round-2 fix CO5: the SHARED hold predicate (buildHoldPredicate in
   * ./hold.ts) — held iff ephemeral-shaped AND not alias-mapped, so a RULED
   * ephemeral scope's observations resolve to the target instead of being
   * held forever. Absent ⇒ shape-only (`ephemeralReason`), the pre-round-2
   * behavior unit stubs rely on.
   */
  isHeld?: HoldPredicate;
}

/**
 * The mint-origin hint for registry-aware resolution (Task 8): the observing
 * session's cwd when the hook recorded one in metadata. Fail-open — an
 * unparseable or cwd-less metadata blob yields null.
 */
function originOf(obs: { metadata?: string | null }): string | null {
  try {
    const metadata = JSON.parse(obs.metadata || '{}');
    return typeof metadata.cwd === 'string' ? metadata.cwd : null;
  } catch {
    return null;
  }
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
  const { config, maxObservationsPerRun = 1000, reasoner, canonicalizeScope, resolveScope } = options;
  // Shape-only fallback = buildHoldPredicate without an alias closure (CO5).
  const isHeld = options.isHeld ?? buildHoldPredicate();

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

  // ── Two-layer grouping (Task 8) ──
  // raw → observations (lineage layer: run rows, watermarks — Task 6 logic keys
  // on THIS; observation rows themselves are never rewritten).
  const byRawScope = new Map<string, typeof observations>();
  for (const obs of observations) {
    const existing = byRawScope.get(obs.project_scope) ?? [];
    existing.push(obs);
    byRawScope.set(obs.project_scope, existing);
  }

  // raw → resolved (detection layer: which raws pool their evidence), resolved
  // once per raw. HELD raws (the shared predicate: ephemeral-shaped AND not
  // alias-mapped, CO5) are never resolved — they map to themselves and take
  // the Task-6 held short-circuit before any detection. A RULED ephemeral
  // (alias-mapped) is NOT held: it resolves through the normal alias-first
  // path to its target scope and pools evidence there.
  const heldRaws = new Set<string>();
  const resolvedOf = new Map<string, string>();
  for (const raw of byRawScope.keys()) {
    if (await isHeld(raw)) { heldRaws.add(raw); resolvedOf.set(raw, raw); continue; }
    const origin = originOf(byRawScope.get(raw)![0]);
    resolvedOf.set(raw, resolveScope ? await resolveScope(raw, origin) : raw);
  }

  // resolved → member raws, insertion-ordered. No resolveScope ⇒ every raw is
  // its own group ⇒ byte-identical to the pre-Phase-3 per-raw processing.
  const byResolvedScope = new Map<string, string[]>();
  for (const [raw, resolved] of resolvedOf) {
    const members = byResolvedScope.get(resolved) ?? [];
    members.push(raw);
    byResolvedScope.set(resolved, members);
  }

  let totalPatternsFound = 0;
  let totalMemoriesCreated = 0;
  let totalMemoriesReinforced = 0;

  // Process each resolved group independently: detection/synthesis/store see
  // the pooled member observations, while run rows stay one-per-RAW-scope.
  for (const [resolvedScope, memberRaws] of byResolvedScope) {
    // ── Lineage layer: one run row per member raw (Task 6 preserved) ──
    // Per-scope watermark honesty (Phase 3): observations arrive id-ASC and the
    // grouping preserves order, so first/last are each raw's own id range —
    // run rows record what THAT raw consumed, not the whole batch's end id.
    const memberRuns: { raw: string; runId: number; endId: number; count: number }[] = [];
    for (const raw of memberRaws) {
      const rawObs = byRawScope.get(raw)!;
      const scopeStartId = rawObs[0].id;
      const scopeEndId = rawObs[rawObs.length - 1].id;

      // Phase 3 hold (Ruling 2 / R-B): held scopes are observed but never
      // minted. The held row IS the record — it advances the global cursor
      // (starvation fix) while leaving the per-scope watermark at 0 for a
      // future re-drive (see GLOBAL_WATERMARK_STATUSES in interfaces.ts).
      // Membership was decided ONCE above via the shared predicate (CO5);
      // ephemeralReason here only names the shape for the log line.
      if (heldRaws.has(raw)) {
        const holdReason = ephemeralReason(raw) ?? 'held';
        const heldRun = await observationStore.createDiscoveryRun(raw, scopeStartId);
        await observationStore.updateDiscoveryRun(heldRun.id, {
          status: 'held',
          observation_end_id: scopeEndId,
          observations_analyzed: rawObs.length,
          completed_at: new Date().toISOString(),
        });
        logger.info(`Discovery held for ${raw} (${holdReason}): ${rawObs.length} observations recorded, nothing minted`);
        continue;
      }

      const run = await observationStore.createDiscoveryRun(raw, scopeStartId);
      memberRuns.push({ raw, runId: run.id, endId: scopeEndId, count: rawObs.length });
    }
    if (memberRuns.length === 0) continue; // held-only group — nothing to detect

    // ── Detection layer: pooled member observations, id-ASC ──
    const groupObs = memberRuns
      .flatMap(m => byRawScope.get(m.raw)!)
      .sort((a, b) => a.id - b.id);

    // Per-group counters (reset each iteration) — the run rows must record
    // THIS group's own created/reinforced counts, not the cycle-running
    // totals below (which legitimately summarise the whole pass for the log
    // line and the returned DiscoveryResult).
    let scopeMemoriesCreated = 0;
    let scopeMemoriesReinforced = 0;

    try {
      // ── Pattern detection ──
      const rawCandidates = detectPatterns(groupObs, config);

      // ── Synthesis: aggregate related patterns into actionable insights ──
      const candidates = synthesizePatterns(rawCandidates);
      if (candidates.length !== rawCandidates.length) {
        logger.info(`Synthesizer: ${rawCandidates.length} raw patterns → ${candidates.length} synthesized insights`);
      }

      // Compute confidence for each candidate — the SHARED per-pattern-type
      // assignment (A4; the re-drive uses the same one).
      for (const candidate of candidates) assignCandidateConfidence(candidate);

      // ── Content security denylist ──
      const safeCandidates = candidates.filter(c => {
        if (!isContentSafe(c.content)) {
          logger.warn(`Denylist blocked pattern: "${c.description.slice(0, 80)}"`);
          return false;
        }
        return true;
      });

      totalPatternsFound += safeCandidates.length;

      // Candidate scope = the RESOLVED scope (Task 8). The store-time T46
      // canonicalization stays as belt-and-braces on top of it; group-constant,
      // so resolved once per group. candidate.project_scope itself (and
      // discovery_runs rows) keep raw values — observation lineage is untouched.
      const storeScope = canonicalizeScope
        ? await canonicalizeScope(resolvedScope)
        : resolvedScope;

      // ── Semantic dedup + memory creation ──
      for (const candidate of safeCandidates) {
        await yieldToEventLoop();

        const result = await deduplicateAndStore(
          candidate,
          storeScope,
          memoryStore,
          embeddingIndex,
          memberRuns[0].runId,
          reasoner
        );

        if (result === 'created') { totalMemoriesCreated++; scopeMemoriesCreated++; }
        else if (result === 'reinforced') { totalMemoriesReinforced++; scopeMemoriesReinforced++; }
      }

      // ── Mark member runs as completed ──
      // Each raw's row keeps its OWN end id / analyzed count (Task 6). The
      // group-level detection counts land on the FIRST member only, so run-row
      // aggregates (ops cache-stats dedup ratio) still sum to the pass totals
      // instead of double-counting per member.
      for (const [i, m] of memberRuns.entries()) {
        await observationStore.updateDiscoveryRun(m.runId, {
          status: 'completed',
          observation_end_id: m.endId,
          observations_analyzed: m.count,
          patterns_found: i === 0 ? safeCandidates.length : 0,
          memories_created: i === 0 ? scopeMemoriesCreated : 0,
          memories_reinforced: i === 0 ? scopeMemoriesReinforced : 0,
          completed_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      // Group failure marks EVERY member raw's run row failed, each with its
      // own per-raw end id — no member silently claims completion.
      logger.error(`Discovery group for ${resolvedScope} failed:`, err);
      for (const m of memberRuns) {
        await observationStore.updateDiscoveryRun(m.runId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          observation_end_id: m.endId,
          completed_at: new Date().toISOString(),
        });
      }
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Discovery completed: ${observations.length} observations, ${totalPatternsFound} patterns, ${totalMemoriesCreated} created, ${totalMemoriesReinforced} reinforced (${duration}ms)`);

  return {
    run_id: 0, // Multiple runs may have been created (one per project)
    project_scope: byRawScope.size === 1 ? [...byRawScope.keys()][0] : 'multiple',
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
function patternToCandidate(candidate: PatternCandidate, nowIso: string, scope: string): CandidateMemory {
  return {
    id: -1,
    content: candidate.content,
    content_hash: null,
    summary: null,
    tags: ['auto-discovered', candidate.pattern_type],
    scope,
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
 *
 * Exported (Task 9): the time-preserving re-drive (redrive.ts) stores its
 * candidates through the SAME dedup/store path as a live discovery pass.
 */
export async function deduplicateAndStore(
  candidate: PatternCandidate,
  scope: string,
  memoryStore: IMemoryStore,
  embeddingIndex: IVectorSearch,
  discoveryRunId: number,
  reasoner?: ConsolidationReasoner
): Promise<'created' | 'reinforced' | 'skipped'> {
  // Skip if embedding index isn't ready (fall back to always-create)
  if (!embeddingIndex.isReady && embeddingIndex.size === 0) {
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, null, { scope });
  }

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embed(candidate.content);
  } catch {
    // Embedder not initialized — create without dedup
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, null, { scope });
  }

  // Search for existing similar memories in the same (canonical) scope
  const candidateIds = await memoryStore.getFilteredIds({
    scope,
    include_archived: false,
  });

  if (candidateIds.length === 0) {
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding, { scope });
  }

  const searchResults = await embeddingIndex.search(queryEmbedding, candidateIds, 1);

  if (searchResults.length === 0) {
    return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding, { scope });
  }

  const topMatch = searchResults[0];

  // Tier 1: >= 0.95 — pure reinforcement
  if (topMatch.score >= 0.95) {
    const existing = await memoryStore.get(topMatch.id);
    if (existing) {
      const next = reinforcedConfidenceFor(existing.confidence);
      if (next !== null) {
        await memoryStore.updateConfidence(topMatch.id, next);
      }
      // True re-observation: bump durability + reset the decay clock (D1.1).
      // Runs even when the confidence write is suppressed — the memory WAS re-observed.
      await memoryStore.reinforceOnAccess([topMatch.id]);
      logger.debug(`Reinforced memory #${topMatch.id} (${existing.confidence.toFixed(3)} ��� ${next?.toFixed(3) ?? existing.confidence.toFixed(3)}, similarity: ${topMatch.score.toFixed(3)})`);
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
            patternToCandidate(candidate, nowIso, scope),
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
          scope,
        });
      }
      if (route.action === 'create') {
        // Confident unrelated (the R13 template/different-referent class):
        // both memories stand on their own — no reinforce, no flag.
        logger.info(`Tier-2 guard: candidate vs memory #${existing.id} classified 'unrelated' — creating without reinforcement`);
        return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding, { scope });
      }

      // Phase-1 reinforce + log (confirmed duplicate, or no consumable verdict).
      const next = reinforcedConfidenceFor(existing.confidence);
      if (next !== null) {
        await memoryStore.updateConfidence(topMatch.id, next);
      }
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
  return await createDiscoveryMemory(candidate, memoryStore, discoveryRunId, queryEmbedding, { scope });
}

/**
 * Derive a stable surface key + human title for a procedural sequence memory
 * from its structured `steps` (the normalized workflow keys). The key is built
 * verbatim from the steps — which `getSequenceKey` has already canonicalized —
 * so the key stays 1:1 with the memory's content (no case-folding collision).
 * Returns null when the candidate has no usable step chain.
 */
export function deriveSkillKeyAndName(candidate: PatternCandidate): { key: string; name: string } | null {
  const steps = candidate.steps;
  if (!steps || steps.length < 2) return null;
  return {
    key: `${SKILL_TAG}:${steps.join('>')}`,
    name: steps.join(' → '),
  };
}

/**
 * Create a new auto-discovered memory from a pattern candidate.
 * `opts` (D2.2): the tier-2 guard attaches the contradiction flag metadata/tag
 * so the dream layer co-windows and routes the flagged pair.
 * `opts.scope` (T46): the write-time canonical scope to store under, resolved
 * once by the caller — absent ⇒ falls back to `candidate.project_scope`
 * (identity), so existing callers are unaffected.
 */
export async function createDiscoveryMemory(
  candidate: PatternCandidate,
  memoryStore: IMemoryStore,
  discoveryRunId: number,
  embedding: Float32Array | null,
  opts: { extraMetadata?: Record<string, unknown>; extraTags?: string[]; scope?: string } = {}
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

  // Procedural "skill" legibility (thin Skills layer): sequence patterns are
  // repeatable workflows. Derive a stable surface key + title (mirroring the
  // catalog surface shape) so the surface skill lane can materialise them —
  // without a dedicated MemoryType/migration. Computed once and reused for the
  // tag below so the 'skill' tag and external_key stay coupled (only tag what we
  // can key).
  const skillMeta = candidate.pattern_type === 'sequence'
    ? deriveSkillKeyAndName(candidate)
    : null;
  if (skillMeta) {
    metadata.external_key = skillMeta.key;
    metadata.name = skillMeta.name;
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
  if (skillMeta && !tags.includes(SKILL_TAG)) {
    tags.push(SKILL_TAG);
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
      scope: opts.scope ?? candidate.project_scope,
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
