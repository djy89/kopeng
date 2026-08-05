import type { IMemoryStore, IDreamStore, IVectorSearch } from '../database/interfaces.js';
import type { DreamDiffEntry } from '../types/types.js';
import type { DecayScore } from './decay.js';
import { memoryStrength } from '../dreaming/scoring.js';
import { shouldArchive } from '../discovery/confidence.js';
import { applyEntry, type ApplyDeps } from '../dreaming/apply.js';
import logger from '../utils/logger.js';

export interface ArchiveResult {
  archived: number[];
  skipped: number;
  threshold: number;
  /** GATE 1: count of candidates withheld because auto_accept_decay is off. */
  withheld?: number;
  /** R14: the dream row the audited archives were attached to (rollback handle). */
  dream_id?: number;
}

/**
 * DEPRECATED (R14): the un-audited, score-driven archiver. No longer on the
 * promotion path — `runPromotion` now uses `autoArchiveDecayed` (audited, dream
 * apply path, memoryStrength formula). Retained only for the D1.1 retune
 * regression in `durability-archive.test.ts`; do NOT wire it back into the
 * promotion pipeline (it produces no snapshot/audit row and is not rollback-able).
 */
export async function autoArchive(
  queries: IMemoryStore,
  scores: DecayScore[],
  threshold: number = 0.1,
  dryRun: boolean = false
): Promise<ArchiveResult> {
  const toArchive = scores
    .filter(s => s.totalScore < threshold)
    .sort((a, b) => a.totalScore - b.totalScore);

  const archived: number[] = [];

  if (dryRun) {
    logger.info(`[DRY RUN] Would archive ${toArchive.length} memories below threshold ${threshold}`);
    return { archived: toArchive.map(s => s.memoryId), skipped: 0, threshold };
  }

  for (const score of toArchive) {
    try {
      const success = await queries.archive(score.memoryId);
      if (success) {
        archived.push(score.memoryId);
        logger.info(`Auto-archived memory ${score.memoryId} (score: ${score.totalScore.toFixed(3)})`);
      }
    } catch (err) {
      logger.error(`Failed to archive memory ${score.memoryId}:`, err);
    }
  }

  logger.info(`Auto-archive complete: ${archived.length} archived, ${toArchive.length - archived.length} skipped`);
  return { archived, skipped: toArchive.length - archived.length, threshold };
}

/**
 * Stores needed to run a promotion decay archive through the audited dream apply
 * path. `dreamStore`/`vectorIndex` are only required for a real (non-dry) archive;
 * a dry pass just selects + counts candidates and needs neither.
 */
export interface AuditedArchiveDeps {
  memoryStore: IMemoryStore;
  dreamStore?: IDreamStore | null;
  vectorIndex?: IVectorSearch | null;
}

/**
 * R14 (GATE 1 fix): decay archival is no longer a bare `queries.archive(id)` with
 * no snapshot/audit and a divergent formula. It now:
 *
 *  1. selects candidates with the SAME predicate as the dream `decay` tier —
 *     `memoryStrength(memory) < 0.2` (durability-aware effective confidence,
 *     `shouldArchive`), eliminating the old `computeDecayScores < 0.1` divergence;
 *  2. routes each archive through the audited dream apply path (`applyEntry` over a
 *     `decay` diff entry attached to a real `dreams` row) — snapshot to
 *     `memory_revisions` → archive → append `dream_audit_log` (compensate-unarchive
 *     on audit failure, invariant #11) → drop from the vector index;
 *  3. re-checks Hard Anchor at apply time (pinned/`is_locked`/`confidence>=1.0`),
 *     so a stale candidate is refused, not mutated.
 *
 * The result is rollback-able via the existing `POST /api/memories/:id/rollback`
 * (revisions carry `created_by_dream_id`, so the rollback audits under this dream).
 *
 * MUST run inside the consolidation lock (both call sites hold it).
 */
export async function autoArchiveDecayed(
  deps: AuditedArchiveDeps,
  threshold: number,
  dryRun: boolean,
  now: Date = new Date(),
): Promise<ArchiveResult> {
  const candidates = await selectDecayCandidates(deps.memoryStore, now);

  if (dryRun) {
    logger.info(`[DRY RUN] Would archive ${candidates.length} memories (memoryStrength < 0.2)`);
    return { archived: candidates.map(c => c.id), skipped: 0, threshold };
  }

  if (candidates.length === 0) {
    return { archived: [], skipped: 0, threshold };
  }

  // A real archive must be auditable — the dream store + vector index are the
  // snapshot/audit/index-sync machinery. Refuse rather than archive unaudited.
  const { dreamStore, vectorIndex } = deps;
  if (!dreamStore || !vectorIndex) {
    throw new Error('autoArchiveDecayed: a non-dry decay archive requires dreamStore + vectorIndex (R14: no unaudited archives)');
  }

  // One dream row holds every audited archive in this pass (rollback handle +
  // FK target for the audit/revision rows). mode 'whole_corpus' marks it as a
  // promotion-driven decay pass rather than a windowed dream.
  const dream = await dreamStore.createDream({
    mode: 'whole_corpus',
    trigger_source: 'scheduled',
    reason: 'promotion decay archival (R14 audited path)',
  });

  const applyDeps: ApplyDeps = {
    memoryStore: deps.memoryStore,
    dreamStore,
    vectorIndex,
  };

  const archived: number[] = [];
  let skipped = 0;
  const entries: DreamDiffEntry[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const entry: DreamDiffEntry = {
      change_class: 'decay',
      tier: 'deterministic-safe',
      memory_ids: [c.id],
      rationale: `Effective confidence ${c.strength.toFixed(3)} below the 0.2 archive threshold (durability-aware decay) — promotion decay archive (R14 audited).`,
      after: { archive_ids: [c.id] },
    };
    try {
      const result = await applyEntry(applyDeps, dream.id, i, entry, true);
      if (result.outcome === 'applied' && result.archived_ids.length > 0) {
        archived.push(c.id);
        entry.resolution = 'auto_applied';
        entry.resolved_at = now.toISOString();
        logger.info(`Auto-archived memory ${c.id} (memoryStrength ${c.strength.toFixed(3)}) — audited under dream ${dream.id}`);
      } else {
        // anchored / vanished / already-archived — left untouched, reported skipped.
        skipped++;
        logger.warn(`Promotion decay archive: memory ${c.id} not archived (${result.detail ?? result.outcome})`);
      }
    } catch (err) {
      // applyEntry already compensated (unarchived) on audit failure — count as skipped.
      skipped++;
      logger.error(`Promotion decay archive: memory ${c.id} failed — left active:`, err);
    }
    entries.push(entry);
  }

  // Persist the diff + completion so the dream is reviewable/auditable and the
  // archives are reachable from the dream review surface and rollback path.
  await dreamStore.setDreamDiff(dream.id, { entries });
  await dreamStore.updateDream(dream.id, {
    status: 'completed',
    completed_at: now.toISOString(),
    acceptance_status: archived.length > 0 ? 'auto_applied' : 'empty',
    memories_examined: candidates.length,
    changes_auto_applied: archived.length,
    changes_queued: 0,
  });

  logger.info(`Auto-archive complete: ${archived.length} archived, ${skipped} skipped (audited under dream ${dream.id})`);
  return { archived, skipped, threshold, dream_id: dream.id };
}

interface DecayCandidate {
  id: number;
  strength: number;
}

/**
 * Decay candidates by the dream-tier predicate: active, non-anchored memories
 * whose durability-aware effective confidence is below the 0.2 archive threshold.
 * Hard Anchor (pinned/`is_locked`/`confidence>=1.0`) is excluded here AND
 * re-checked at apply time (`applyEntry`), so a stale candidate can never archive
 * an anchored row.
 */
async function selectDecayCandidates(store: IMemoryStore, now: Date): Promise<DecayCandidate[]> {
  const candidates: DecayCandidate[] = [];
  let cursor: number | undefined;
  // Page through all active memories. list() excludes archived rows by default.
  for (;;) {
    const { memories, has_more } = await store.list({ limit: 500, cursor, include_archived: false });
    if (memories.length === 0) break;
    for (const m of memories) {
      cursor = m.id;
      // Hard Anchor: never decay-archive pinned / locked / operator-confirmed.
      if (m.is_locked === 1 || m.confidence >= 1.0 || isPinned(m.metadata)) continue;
      const strength = memoryStrength(
        {
          confidence: m.confidence,
          observation_count: m.observation_count ?? 1,
          last_seen: m.last_seen ?? null,
          updated_at: m.updated_at,
          type: m.type,
          tags: m.tags,
        },
        now,
      );
      if (shouldArchive(strength)) {
        candidates.push({ id: m.id, strength });
      }
    }
    if (!has_more) break;
  }
  return candidates;
}

function isPinned(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as { pinned?: unknown };
    return parsed.pinned === true;
  } catch {
    return false;
  }
}
