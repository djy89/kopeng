/**
 * T30.3 — auto-crystallization pass.
 *
 * Promotes memories that have proven durable (reinforced past
 * CRYSTALLIZE_MIN_OBSERVATIONS, older than CRYSTALLIZE_MIN_AGE_DAYS, already
 * believed at >= CRYSTALLIZE_MIN_CONFIDENCE, unlocked) to CRYSTALLIZE_TARGET
 * (0.97 — "sticky, not a Hard Anchor"). Runs as an audited step of the promotion
 * pass (it holds the dream store + the consolidation lock), acting on the
 * `observation_count` the reinforcement paths accrue — "after N reinforcements"
 * without touching the hot recall path.
 *
 * Every promotion is snapshot-first (memory_revisions, via the dream store) then
 * updateConfidence, then audit-logged under a carrier dream (`change_class:
 * 'crystallize'`, invariant #2: snapshot → mutate → append audit, compensating
 * back to the pre-crystallize confidence if the audit append fails) — identical
 * to the T22 confidence-change / dream apply discipline, so each is reversible
 * with POST /api/memories/:id/rollback. The confidence bump changes no content,
 * so no re-embed and Neo4j stays read-only. Idempotent: at 0.97 a memory is no
 * longer < target, so it never re-fires.
 *
 * Gated OFF by default (operator_config.config.auto_crystallize) — an autonomous
 * mutation, so it ships behind a flag like the auto_accept_* classes. Without a
 * dream store (no audit path) a live pass WITHHOLDS rather than mutating unaudited.
 */

import type { IMemoryStore, IDreamStore } from '../database/interfaces.js';
import { isCrystallizationCandidate, CRYSTALLIZE_TARGET } from '../discovery/confidence.js';
import { CarrierDream } from '../dreaming/carrier.js';
import logger from '../utils/logger.js';

/** Reason string on the crystallization carrier dream (T43 audited path). */
export const CRYSTALLIZE_CARRIER_REASON = 'auto-crystallization (T43 audited path)';

/** Config-blob key (operator_config.config) gating the crystallization pass. */
export const AUTO_CRYSTALLIZE_KEY = 'auto_crystallize';

/** Read the auto_crystallize flag from an operator_config `config` JSON blob. Default OFF. */
export function readAutoCrystallize(configJson: string | null | undefined): boolean {
  if (!configJson) return false;
  try {
    return JSON.parse(configJson)?.[AUTO_CRYSTALLIZE_KEY] === true;
  } catch {
    return false;
  }
}

export interface CrystallizeResult {
  /** Ids promoted to CRYSTALLIZE_TARGET (audited, reversible). */
  crystallized: number[];
  /** Eligible candidates found (== crystallized.length on a successful live run). */
  candidates: number;
  /** Eligible candidates NOT applied (dry-run, or no dream store to audit). */
  withheld: number;
  dry_run: boolean;
}

export interface CrystallizeDeps {
  memoryStore: IMemoryStore;
  /** Required to actually crystallize — the snapshot/audit path. Absent ⇒ withhold. */
  dreamStore?: IDreamStore | null;
  now?: Date;
  dryRun?: boolean;
}

const PAGE = 500;

export async function crystallizeEligible(deps: CrystallizeDeps): Promise<CrystallizeResult> {
  const now = deps.now ?? new Date();
  const dryRun = deps.dryRun ?? false;
  const audited = !dryRun && !!deps.dreamStore;

  const crystallized: number[] = [];
  let candidates = 0;
  let withheld = 0;
  let cursor: number | undefined;

  // One carrier dream holds every audited crystallization in this pass — lazy,
  // so a run that finds nothing eligible never writes a dream row.
  const carrier = audited ? new CarrierDream(deps.dreamStore!, CRYSTALLIZE_CARRIER_REASON) : null;

  // Page through all active memories (list() excludes archived) — same walk as
  // selectDecayCandidates.
  for (;;) {
    const { memories, has_more } = await deps.memoryStore.list({ limit: PAGE, cursor, include_archived: false });
    if (memories.length === 0) break;
    for (const m of memories) {
      cursor = m.id;
      if (!isCrystallizationCandidate(m, now)) continue;
      candidates++;
      if (!audited) {
        withheld++;
        continue;
      }
      try {
        const dream = await carrier!.open();
        const prev = m.confidence;
        // Snapshot BEFORE the mutation (invariant #2) — rollback restores the
        // pre-crystallize confidence; the revision links to the carrier.
        const { id: revisionId } = await deps.dreamStore!.snapshotRevision(m.id, dream.id);
        await deps.memoryStore.updateConfidence(m.id, CRYSTALLIZE_TARGET);
        try {
          await deps.dreamStore!.appendAudit({
            dream_id: dream.id,
            memory_id: m.id,
            revision_id: revisionId,
            change_class: 'crystallize',
            action: 'confidence_promote',
            applied_automatically: true,
            before_ref: `confidence=${prev}`,
            after_ref: `crystallized;confidence=${CRYSTALLIZE_TARGET}`,
          });
          crystallized.push(m.id);
          carrier!.recordAuditOnly(true);
        } catch (auditErr) {
          // Invariant #2 compensation: an unaudited mutation may not stand.
          await deps.memoryStore.updateConfidence(m.id, prev);
          carrier!.recordAuditOnly(false);
          logger.error(`crystallize ${m.id}: audit append failed — confidence restored to ${prev}:`, auditErr);
        }
      } catch (err) {
        logger.warn(`crystallize ${m.id} failed:`, err);
      }
    }
    if (!has_more) break;
  }

  if (carrier) await carrier.finalize(now);

  if (candidates > 0) {
    logger.info(
      audited
        ? `Crystallized ${crystallized.length}/${candidates} durable memories → ${CRYSTALLIZE_TARGET} (snapshot-first, reversible)`
        : `Crystallization candidates: ${candidates} withheld (${dryRun ? 'dry-run' : 'no dream store to audit'})`,
    );
  }

  return { crystallized, candidates, withheld, dry_run: dryRun };
}
