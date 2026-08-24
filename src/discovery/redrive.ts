/**
 * Phase 3 time-preserving re-drive for held scopes (Prereq 3).
 *
 * A held (ephemeral) scope's observations were recorded but never minted — the
 * held run rows advanced only the GLOBAL watermark, leaving the per-scope
 * watermark at 0 (Task 6). Once the operator RULES the scope (an alias-table
 * entry, a registry ruling, or a `confirmed` registry row), this module
 * re-drives the full detection pipeline over those stored observations and
 * stores the results under the ruled target scope.
 *
 * Invariant (spec §8): a re-drive creates no observation rows and rewrites no
 * timestamps — all signals compute from stored `started_at`. The evidence
 * spans, session counts, and confidence a re-drive produces are exactly what a
 * live pass would have produced at the time; the only writes this module
 * performs are discovery_runs bookkeeping (raw-scope lineage, same as a live
 * pass) and memory creation under the resolved scope.
 *
 * Global-watermark bound (final review I2): a re-drive only RE-COVERS ids the
 * live path already consumed (completed or held run rows) — it captures the
 * GLOBAL watermark at start and never processes an observation above it, so
 * its completed run rows can never stamp an end id past OTHER scopes'
 * unprocessed observations (which the next live pass would then silently
 * skip). Held-scope observations ingested after the last live pass wait for
 * their next held row + a later re-drive. Corollary: a re-drive before any
 * live pass is a clean no-op (empty result, no run row).
 *
 * Refusal contract: an UNRULED scope is refused with RedriveNotRuledError
 * (the route maps it to 409) — re-driving into an unruled scope would just
 * re-create the mess the hold existed to prevent.
 */

import type { IObservationStore, IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import type { DiscoveryResult, DiscoveryConfig } from '../types/types.js';
import type { ConsolidationReasoner } from '../dreaming/reasoner/reasoner.js';
import { detectPatterns } from './heuristics.js';
import { synthesizePatterns } from './synthesizer.js';
import { assignCandidateConfidence } from './confidence.js';
import { isContentSafe, deduplicateAndStore } from './discovery-engine.js';
import logger from '../utils/logger.js';

/**
 * Thrown when the requested scope has no operator ruling: `resolveTo` returned
 * it unchanged AND it is not a `confirmed` registry row. The route maps this
 * to 409 — the operator must rule the scope (alias it, or confirm it) first.
 */
export class RedriveNotRuledError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(
      `Scope "${scope}" has no ruling: resolution returns it unchanged and its registry row is not confirmed. ` +
      `Rule the scope first (alias it to its real target, or confirm it in the scope registry), then re-drive.`,
    );
    this.name = 'RedriveNotRuledError';
    this.scope = scope;
  }
}

export interface RedriveOptions {
  /** The RAW held scope whose stored observations should be re-driven. */
  scope: string;
  /** Ruled resolution (the route wires the alias→registry chain; tests stub it). */
  resolveTo: (raw: string) => Promise<string>;
  /**
   * Second half of the refusal predicate: is the scope's registry row
   * `confirmed`? Consulted only when `resolveTo` returns the scope unchanged —
   * a confirmed row means "this scope is legitimate as-is", so the re-drive
   * proceeds into it. Absent ⇒ treated as not confirmed (an unchanged
   * resolution always refuses).
   */
  isConfirmed?: (scope: string) => Promise<boolean>;
  config: DiscoveryConfig;
  /** Page size for walking the stored observations. Default 1000. */
  maxObservationsPerRun?: number;
  /** Optional D2.2 tier-2 dedup guard — same semantics as runDiscovery. */
  reasoner?: ConsolidationReasoner;
}

/** Yield to the event loop between store calls (same convention as runDiscovery). */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Re-drive the detection pipeline over a held scope's stored observations.
 *
 * Pages `getObservationsSince(perScopeWatermark, scope, pageSize)`; per page:
 * one raw-scope run row → detect/synthesize/confidence/denylist (identical to
 * runDiscovery's per-group processing) → store under the RESOLVED scope via
 * `deduplicateAndStore` → complete the run row with the page's own max id, so
 * the per-scope watermark advances and a repeat re-drive is a no-op. An empty
 * FIRST page returns a zero result without writing any run row — an empty
 * re-drive leaves no trace to misread.
 */
export async function runRedrive(
  observationStore: IObservationStore,
  memoryStore: IMemoryStore,
  embeddingIndex: IVectorSearch,
  options: RedriveOptions,
): Promise<DiscoveryResult & { resolved_scope: string }> {
  const startTime = Date.now();
  const { scope, resolveTo, isConfirmed, config, maxObservationsPerRun = 1000, reasoner } = options;

  // ── Refusal gate: the scope must be ruled before anything is written ──
  const resolvedScope = await resolveTo(scope);
  if (resolvedScope === scope) {
    const confirmed = isConfirmed ? await isConfirmed(scope) : false;
    if (!confirmed) throw new RedriveNotRuledError(scope);
  }

  // ── I2 bound: only re-cover ids the live path already consumed ──
  // The GLOBAL watermark (completed + held runs) at re-drive start; anything
  // above it belongs to a future held row + re-drive, never this one.
  const bound = await observationStore.getLastWatermark();

  let cursor = await observationStore.getLastWatermark(scope);
  let runId = 0;
  let totalObservations = 0;
  let totalPatternsFound = 0;
  let totalMemoriesCreated = 0;
  let totalMemoriesReinforced = 0;

  for (;;) {
    const fetched = await observationStore.getObservationsSince(cursor, scope, maxObservationsPerRun);
    // ids arrive ASC, so the in-bound rows are a prefix of the fetch.
    const page = fetched.filter(o => o.id <= bound);
    if (page.length === 0) break; // first page empty ⇒ totals stay 0, no run row

    const pageEndId = page[page.length - 1].id;
    const run = await observationStore.createDiscoveryRun(scope, page[0].id);
    runId = run.id;

    try {
      // ── Detection over the page (stored started_at drives every signal) ──
      const rawCandidates = detectPatterns(page, config);
      const candidates = synthesizePatterns(rawCandidates);

      // Confidence — the SHARED per-pattern-type assignment (A4): the same
      // function runDiscovery calls, so a live pass and a re-drive can't drift.
      for (const candidate of candidates) assignCandidateConfidence(candidate);

      // ── Content security denylist ──
      const safeCandidates = candidates.filter(c => {
        if (!isContentSafe(c.content)) {
          logger.warn(`Denylist blocked re-driven pattern: "${c.description.slice(0, 80)}"`);
          return false;
        }
        return true;
      });

      // ── Store under the RESOLVED scope (raw stays on run rows only) ──
      let pageMemoriesCreated = 0;
      let pageMemoriesReinforced = 0;
      for (const candidate of safeCandidates) {
        await yieldToEventLoop();
        const result = await deduplicateAndStore(
          candidate, resolvedScope, memoryStore, embeddingIndex, run.id, reasoner
        );
        if (result === 'created') pageMemoriesCreated++;
        else if (result === 'reinforced') pageMemoriesReinforced++;
      }

      await observationStore.updateDiscoveryRun(run.id, {
        status: 'completed',
        observation_end_id: pageEndId,
        observations_analyzed: page.length,
        patterns_found: safeCandidates.length,
        memories_created: pageMemoriesCreated,
        memories_reinforced: pageMemoriesReinforced,
        completed_at: new Date().toISOString(),
      });

      totalObservations += page.length;
      totalPatternsFound += safeCandidates.length;
      totalMemoriesCreated += pageMemoriesCreated;
      totalMemoriesReinforced += pageMemoriesReinforced;
    } catch (err) {
      // A failed run row does NOT advance the per-scope watermark
      // (SCOPE_WATERMARK_STATUSES is completed-only), so a retry re-covers
      // this page.
      await observationStore.updateDiscoveryRun(run.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        observation_end_id: pageEndId,
        completed_at: new Date().toISOString(),
      });
      throw err;
    }

    // Short fetch ⇒ no more stored rows; truncated page ⇒ every later id is
    // above the bound too. Either way this re-drive is done.
    if (fetched.length < maxObservationsPerRun || page.length < fetched.length) break;
    cursor = pageEndId;
  }

  const duration = Date.now() - startTime;
  if (totalObservations > 0) {
    logger.info(
      `Re-drive ${scope} → ${resolvedScope}: ${totalObservations} observations, ` +
      `${totalPatternsFound} patterns, ${totalMemoriesCreated} created, ${totalMemoriesReinforced} reinforced (${duration}ms)`
    );
  } else {
    logger.info(`Re-drive ${scope}: no unprocessed observations (watermark already advanced)`);
  }

  return {
    run_id: runId, // the LAST page's run row (0 when nothing was processed)
    project_scope: scope,
    observations_analyzed: totalObservations,
    patterns_found: totalPatternsFound,
    memories_created: totalMemoriesCreated,
    memories_reinforced: totalMemoriesReinforced,
    duration_ms: duration,
    resolved_scope: resolvedScope,
  };
}
