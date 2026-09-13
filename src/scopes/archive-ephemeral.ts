/**
 * T76 §5.4 — the archive-ephemeral CORE, extracted from the route so the
 * refusal matrix, the F-7 mid-call version stop, and partial-failure semantics
 * are unit-testable without HTTP.
 *
 * Eligibility is the IMPORTED hold predicate (holdVerdict — T-H4: never a
 * fifth spelling) in its STRICT fail-CLOSED direction: a broken table or
 * registry read REFUSES, never archives. It refuses two ways, and the split is
 * positional, not outcome-based: **pre-loop reads THROW, in-loop reads
 * REPRESENT.** The pre-loop read runs before any archive is possible, so the
 * route's 503 is the whole truth. Every IN-LOOP read failure — the per-chunk
 * F-7 re-check (`stopped: 'resolution_read_failed'`) and the page fetch itself
 * (`stopped: 'store_read_failed'`) — instead STOPS and returns the result so
 * far, because from inside the loop the function cannot know whether archives
 * have landed, and an escaping exception would discard `result` entirely:
 * archives that DID happen would be reported as never having happened, and the
 * `dream_id` / `archived_ids` rollback handles would be lost. The rule is
 * therefore uniform rather than conditional on a count — a first-chunk page
 * read that fails returns a truthful `archived: 0` with the `stopped` reason,
 * not a 503, and the caller reads the reason rather than inferring it. Only
 * pre-loop failures escape this function.
 * Everything else is house posture: snapshot-first audited archives via
 * auditedArchiveMemory (change_class 'archive_ephemeral'), one CarrierDream
 * (is_carrier, trigger_source 'manual'), finalize in `finally`, 500-row cap
 * (ruling L-4), partial results represented, never swallowed (F-9).
 */
import { holdVerdict } from '../discovery/hold.js';
import { ephemeralReason } from './ephemeral.js';
import { auditedArchiveMemory } from '../dreaming/apply.js';
import { CarrierDream } from '../dreaming/carrier.js';
import { ARCHIVE_EPHEMERAL_CARRIER_REASON } from '../types/types.js';
import { isAnchored } from '../dreaming/scoring.js';
import type { IMemoryStore, IDreamStore, IVectorSearch } from '../database/interfaces.js';
import logger from '../utils/logger.js';

export const ARCHIVE_CAP = 500;
export const ARCHIVE_CHUNK = 100;
const FAILED_DETAIL_CAP = 20;

/** The scope is not archive-eligible (the route maps this to a 400). */
export class IneligibleScopeError extends Error {}

export interface ArchiveEphemeralDeps {
  memoryStore: IMemoryStore;
  dreamStore: IDreamStore | null;      // null ⇒ WITHHOLD (never bare-archive)
  vectorIndex: IVectorSearch;
  /** STRICT, UNCACHED resolution read — THROWS on failure (route maps → 503).
   *  Re-called per chunk (F-7): rulings serialize on configPatchChain, not the
   *  consolidation lock, so a release-ruling can land mid-call. */
  readResolution: () => Promise<{ table: Record<string, string>; version: string }>;
  /** STRICT ruled-distinct read — THROWS on failure (route maps → 503).
   *  NOT uncached, unlike readResolution: the route supplies
   *  `ScopeRegistryService.isRuledDistinct`, which rides that service's 60s TTL
   *  snapshot cache. A mark_distinct ruling invalidates it in the SAME process,
   *  so the F-7 re-check sees a local release immediately; a ruling made
   *  against a DIFFERENT process against a shared database could be up to 60s
   *  stale here. Single-process is the deployment assumption throughout (the
   *  ops memo and the alias cache carry it too), and the failure it bounds is a
   *  release ruling landing <60s before an archive of the same scope. */
  isRuledDistinct: (scope: string) => Promise<boolean>;
}

export interface ArchiveEphemeralResult {
  scope: string;
  dry_run: boolean;
  archived: number;              // in dry-run: rows that WOULD archive
  /**
   * The ids actually archived, in archive order (empty in dry-run). This is the
   * operator's ROLLBACK ENUMERATION: `dream_id` identifies the carrier, but
   * rollback is per-memory (`POST /api/memories/:id/rollback`), and the rows are
   * archived — so without this list there is no way to enumerate what to undo
   * short of a manual archived-rows query. Naturally capped by ARCHIVE_CAP.
   */
  archived_ids: number[];
  refused_anchored: number;
  failed: { memory_id: number; error: string }[];   // capped at 20 entries
  /** Every failure, including those past the 20-entry detail cap — failures
   *  consume the row budget, so without this the counters don't reconcile on a
   *  heavily-failing scope. Equals `failed.length` while ≤ FAILED_DETAIL_CAP. */
  failed_total: number;
  truncated: boolean;            // 500-row cap hit with rows remaining (L-4)
  alias_table_version: string;   // the version the call archived under
  dream_id?: number;             // the carrier id — the rollback handle
  /** F-7 partial stop. `resolution_read_failed` is the fail-CLOSED direction
   *  applied MID-call: the re-check's inputs became unreadable after earlier
   *  chunks had already archived, so we stop archiving and RETURN what happened
   *  (throwing there would strand real archives behind a 503 that says nothing
   *  happened, and lose the `dream_id` rollback handle). */
  stopped?: 'alias_table_changed' | 'eligibility_changed' | 'resolution_read_failed' | 'store_read_failed';
  /**
   * The carrier's finalize (its diff + completion write) threw. The archives
   * themselves stand and are individually audited, but the carrier row is left
   * mid-flight — `status: 'running'` with stale counters — so dream-history and
   * the ops panel will under-report this pass. Surfaced rather than only logged:
   * a silently half-written audit row is exactly the thing an operator needs to
   * know about before trusting the counts.
   */
  finalization_failed?: true;
  withheld?: 'no_dream_store';   // maintenance §2 posture
  withheld_rows?: number;
}

export async function runArchiveEphemeral(
  deps: ArchiveEphemeralDeps,
  opts: { scope: string; apply: boolean },
): Promise<ArchiveEphemeralResult> {
  const { scope } = opts;

  // Eligibility runs BEFORE the dry-run/apply branch: a ruled or non-ephemeral
  // scope is refused outright, so a dry-run can never preview an archive the
  // apply would refuse.
  const resolution = await deps.readResolution();           // throws ⇒ route 503
  // The verdict's OWN ruled-distinct answer, captured as holdVerdict asks for
  // it, so the refusal message below can name the right clause without a second
  // read (and without re-deriving the verdict). Stays undefined when the shape
  // check short-circuits ahead of it — which is the first message branch anyway.
  let ruledDistinct: boolean | undefined;
  const eligible = await holdVerdict(scope, {
    canonicalize: async (s) => resolution.table[s] ?? s,
    isRuledDistinct: async (s) => (ruledDistinct = await deps.isRuledDistinct(s)), // throws ⇒ route 503
  });
  if (!eligible) {
    // Naming the failing clause is MESSAGING, not a re-derivation: the verdict
    // above came from the one predicate. The clause ORDER mirrors holdVerdict's
    // (shape → ruled-distinct → alias) so the named clause is the one that
    // actually decided; a scope that is both ruled distinct and alias-mapped
    // reads "ruled distinct", exactly as the predicate saw it. The final branch
    // is alias-mapping by elimination, so `resolution.table[scope]` is set.
    const why = ephemeralReason(scope) === null ? 'not ephemeral-shaped'
      : ruledDistinct ? 'ruled distinct'
      : `alias-mapped to "${resolution.table[scope]}" (release already ruled)`;
    throw new IneligibleScopeError(`Scope "${scope}" is not archive-eligible: ${why}`);
  }

  const result: ArchiveEphemeralResult = {
    scope, dry_run: !opts.apply, archived: 0, archived_ids: [], refused_anchored: 0,
    failed: [], failed_total: 0, truncated: false, alias_table_version: resolution.version,
  };

  if (opts.apply && !deps.dreamStore) {
    // Maintenance-§2 posture: no audit path ⇒ WITHHOLD, never bare-archive.
    return {
      ...result, dry_run: true,
      withheld: 'no_dream_store',
      withheld_rows: await deps.memoryStore.countActiveByScope(scope),
    };
  }

  const dreamStore = deps.dreamStore;
  const carrier = opts.apply && dreamStore
    ? new CarrierDream(dreamStore, ARCHIVE_EPHEMERAL_CARRIER_REASON, { trigger_source: 'manual', scope })
    : null;

  // Failures do not land in `failed[]` past FAILED_DETAIL_CAP, but they DO
  // consume the row budget — otherwise a scope whose every row fails would walk
  // its entire active set inside one request. `failed_total` is what makes the
  // reported numbers reconcile past that detail cap.
  const budget = () => result.archived + result.refused_anchored + result.failed_total;

  try {
    // Cursor paging, in BOTH modes. Archived rows leave the active list, but
    // anchored and failed rows do NOT — so re-reading page 1 each chunk (the
    // shape the sketch started from) would recount every survivor forever and,
    // worse, never see past a first page of purely anchored rows. A strictly
    // advancing cursor (`list` is id DESC, cursor is `id < cursor`) makes the
    // pages disjoint by construction: every row is examined exactly once per
    // call, and the loop terminates in ⌈N/ARCHIVE_CHUNK⌉ iterations without a
    // seen-set. The designed L-4 drain is unaffected — it comes from the CAP
    // plus the fact that a re-run's archived rows are gone from the active
    // list, not from where within a call the pages start.
    let cursor: number | undefined;
    let rowsRemain = false;

    while (budget() < ARCHIVE_CAP) {
      if (opts.apply) {
        // F-7: per-chunk re-check under a fresh version-stamped snapshot. Do
        // NOT hold `resolution` stale across chunks — a release ruling can land
        // mid-call, and everything after it must not be archived.
        //
        // A read failure HERE stops-with-partial rather than throwing, unlike
        // the pre-loop read. Both are fail-CLOSED — neither archives another
        // row on an unverifiable table — but earlier chunks may already have
        // archived hundreds of rows, and an escaping exception would discard
        // `result` entirely: the caller would report "nothing happened" (a 503)
        // while the archives stood, and the `dream_id` rollback handle would be
        // lost. The stop applies whether or not anything has been archived yet
        // (an `archived: 0` partial is a truthful answer, not a degenerate one)
        // — F-9: partial results are represented, never swallowed.
        let stop: ArchiveEphemeralResult['stopped'];
        try {
          const fresh = await deps.readResolution();
          if (fresh.version !== resolution.version) stop = 'alias_table_changed';
          else if (!await holdVerdict(scope, {
            canonicalize: async (s) => fresh.table[s] ?? s,
            isRuledDistinct: deps.isRuledDistinct,
          })) stop = 'eligibility_changed';
        } catch (err) {
          logger.warn(
            `archive-ephemeral: eligibility re-check for "${scope}" failed mid-call after ` +
            `${result.archived} archive(s) — stopping with partial results: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          stop = 'resolution_read_failed';
        }
        if (stop) { result.stopped = stop; break; }
      }

      // Same stop-with-partial posture as the F-7 re-check above, for the same
      // reason: a store read that fails on chunk 2 must not discard chunk 1's
      // real, already-audited archives behind a 503 that says nothing happened,
      // nor lose the dream_id / archived_ids rollback handles. Applied
      // uniformly, not only once something has been archived: a FIRST-chunk
      // failure returns `archived: 0` with `stopped: 'store_read_failed'`,
      // which tells the caller what happened, where a throw here would have to
      // be distinguished from the genuinely-nothing-attempted pre-loop case.
      // Pre-loop reads still throw — they run before any archive is possible.
      let page: Awaited<ReturnType<IMemoryStore['list']>>;
      try {
        page = await deps.memoryStore.list({
          scope, limit: ARCHIVE_CHUNK, cursor, include_archived: false, lite: true,
        });
      } catch (err) {
        logger.warn(
          `archive-ephemeral: page read for "${scope}" failed mid-call after ` +
          `${result.archived} archive(s) — stopping with partial results: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        result.stopped = 'store_read_failed';
        break;
      }
      rowsRemain = page.has_more;
      if (page.memories.length === 0) break;

      // `list` filters scope with COLLATE NOCASE (queries.ts) / LOWER() on PG,
      // but eligibility above is EXACT-STRING on the one spelling we were given
      // — the alias-mediated case regime (CLAUDE.md): case variants are
      // DIFFERENT scopes, equated only by the alias table. Without this filter a
      // call for `project:20260901-demo` would archive rows sitting on
      // `project:20260901-Demo` whose own eligibility was never checked — and
      // that twin may be ruled distinct or alias-mapped, i.e. explicitly ruled
      // NOT archivable. Case-variant rows are skipped whole: not archived, not
      // counted in any bucket, not budget-consuming. The operator sees and rules
      // them separately in the drift panel.
      const rows = page.memories.filter(m => m.scope === scope);

      let capped = false;
      for (const mem of rows) {
        if (budget() >= ARCHIVE_CAP) { capped = true; break; }

        if (!carrier) {
          // Dry-run: the same Hard-Anchor contract the apply path re-checks.
          if (isAnchored(mem)) result.refused_anchored++; else result.archived++;
          continue;
        }

        const dream = await carrier.open();
        try {
          // `preloaded` is deliberately not passed: the list rows are `lite`
          // and auditedArchiveMemory's own peek is the authoritative re-check.
          const outcome = await auditedArchiveMemory(
            { memoryStore: deps.memoryStore, dreamStore: dreamStore!, vectorIndex: deps.vectorIndex },
            dream.id, mem.id, 'archive_ephemeral',
            { action: 'archive', appliedAutomatically: true },
          );
          if (outcome.outcome === 'archived') {
            result.archived++;
            result.archived_ids.push(mem.id);
            carrier.recordAuditOnly(true);
          }
          else if (outcome.outcome === 'refused_anchored') { result.refused_anchored++; carrier.recordAuditOnly(false); }
          // skipped_missing / skipped_archived: idempotency skips — count nothing.
        } catch (err) {
          // F-9: auditedArchiveMemory compensated THIS row only (invariant #11);
          // earlier archives stay archived and the loop continues. The attempt
          // is still recorded on the carrier: `memories_examined` counts rows
          // ATTEMPTED, so omitting failures would make the dream row read as
          // though those rows were never looked at.
          result.failed_total++;
          carrier.recordAuditOnly(false);
          if (result.failed.length < FAILED_DETAIL_CAP) {
            result.failed.push({ memory_id: mem.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      if (capped) { result.truncated = true; break; }
      if (!page.has_more) break;
      // The UNFILTERED page's last id: the cursor tracks what the store paged
      // over, not what we processed. Advancing off `rows` would re-fetch (and
      // re-skip) the same case-variant tail forever on a page that held nothing
      // but variants.
      cursor = page.memories[page.memories.length - 1].id;
    }

    // Cap reached exactly at a page boundary with rows still beyond it.
    if (!result.truncated && !result.stopped && budget() >= ARCHIVE_CAP && rowsRemain) {
      result.truncated = true;
    }
  } finally {
    // F-9: the dream row stays truthful on abort.
    if (carrier) {
      try { await carrier.finalize(); } catch (err) {
        logger.warn(`archive-ephemeral: carrier finalize failed: ${err instanceof Error ? err.message : String(err)}`);
        // Reported, not just logged: the archives stand and each is audited,
        // but the carrier row never reached 'completed', so every counter-based
        // view of this pass is now wrong and the operator should know from the
        // response rather than from a server log they may never read.
        result.finalization_failed = true;
      }
    }
  }

  if (carrier?.id !== undefined) result.dream_id = carrier.id;
  return result;
}
