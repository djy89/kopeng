import type pg from 'pg';
import type Database from 'better-sqlite3';
import type { IMemoryStore, IVectorSearch, IDreamStore } from '../database/interfaces.js';
import { computeDecayScores } from './decay.js';
import { findConsolidationCandidates } from './consolidation.js';
import { autoArchiveDecayed, type ArchiveResult } from './auto-archive.js';
import logger from '../utils/logger.js';
import { crystallizeEligible, type CrystallizeResult } from './crystallize.js';
import config from '../config/config.js';

export interface PromotionResult {
  timestamp: string;
  run_id: number | null;
  decayScores: {
    computed: number;
    avgScore: number;
    belowThreshold: number;
  };
  consolidation: {
    candidates: number;
    duplicates: number;
    mergeTargets: number;
  };
  archive: ArchiveResult;
  /** T30.3: audited auto-crystallization result (absent when not requested). */
  crystallize?: CrystallizeResult;
  duration_ms: number;
}

interface PromotionRunCounts {
  decayComputed: number;
  decayAvgScore: number;
  decayBelowThreshold: number;
  consolidationCandidates: number;
  consolidationDuplicates: number;
  consolidationMergeTargets: number;
  memoriesArchived: number;
}

async function startPromotionRun(
  pool: pg.Pool | null,
  sqliteDb: Database.Database | null,
  archiveThreshold: number,
  similarityThreshold: number,
  dryRun: boolean
): Promise<number | null> {
  try {
    if (pool) {
      const result = await pool.query(
        `INSERT INTO promotion_runs (status, dry_run, archive_threshold, similarity_threshold)
         VALUES ('running', $1, $2, $3) RETURNING id`,
        [dryRun, archiveThreshold, similarityThreshold]
      );
      return result.rows[0].id as number;
    }
    if (sqliteDb) {
      const stmt = sqliteDb.prepare(
        `INSERT INTO promotion_runs (status, dry_run, archive_threshold, similarity_threshold)
         VALUES ('running', ?, ?, ?)`
      );
      const result = stmt.run(dryRun ? 1 : 0, archiveThreshold, similarityThreshold);
      return result.lastInsertRowid as number;
    }
  } catch (err) {
    logger.warn('Failed to insert promotion_runs row (table may not exist yet):', err);
  }
  return null;
}

async function completePromotionRun(
  pool: pg.Pool | null,
  sqliteDb: Database.Database | null,
  runId: number,
  counts: PromotionRunCounts,
  durationMs: number,
  status: 'completed' | 'failed',
  error: string | null
): Promise<void> {
  try {
    if (pool) {
      await pool.query(
        `UPDATE promotion_runs SET
           completed_at = NOW(),
           status = $1,
           decay_computed = $2,
           decay_avg_score = $3,
           decay_below_threshold = $4,
           consolidation_candidates = $5,
           consolidation_duplicates = $6,
           consolidation_merge_targets = $7,
           memories_archived = $8,
           duration_ms = $9,
           error = $10
         WHERE id = $11`,
        [
          status,
          counts.decayComputed,
          counts.decayAvgScore,
          counts.decayBelowThreshold,
          counts.consolidationCandidates,
          counts.consolidationDuplicates,
          counts.consolidationMergeTargets,
          counts.memoriesArchived,
          durationMs,
          error,
          runId,
        ]
      );
      return;
    }
    if (sqliteDb) {
      const stmt = sqliteDb.prepare(
        `UPDATE promotion_runs SET
           completed_at = datetime('now'),
           status = ?,
           decay_computed = ?,
           decay_avg_score = ?,
           decay_below_threshold = ?,
           consolidation_candidates = ?,
           consolidation_duplicates = ?,
           consolidation_merge_targets = ?,
           memories_archived = ?,
           duration_ms = ?,
           error = ?
         WHERE id = ?`
      );
      stmt.run(
        status,
        counts.decayComputed,
        counts.decayAvgScore,
        counts.decayBelowThreshold,
        counts.consolidationCandidates,
        counts.consolidationDuplicates,
        counts.consolidationMergeTargets,
        counts.memoriesArchived,
        durationMs,
        error,
        runId
      );
    }
  } catch (err) {
    logger.warn('Failed to update promotion_runs row:', err);
  }
}

export async function runPromotion(
  queries: IMemoryStore,
  embeddingIndex: IVectorSearch,
  pool: pg.Pool | null,
  sqliteDb: Database.Database | null,
  options: {
    archiveThreshold?: number;
    similarityThreshold?: number;
    dryRun?: boolean;
    /**
     * R14: the dream store, required to perform an AUDITED decay archive
     * (snapshot + dream_audit_log + rollback). When absent, a non-dry decay
     * archive is WITHHELD rather than done unaudited — promotion never mutates
     * memories without a snapshot/audit row again (the GATE 1 fix).
     */
    dreamStore?: IDreamStore | null;
    /**
     * GATE 1: decay archival is opt-in (⇐ auto_accept_decay, default OFF) — a
     * non-dry run still computes and reports everything, but mutates nothing
     * without the flag. Duplicate archival was RETIRED at GATE 1:
     * the un-gated >0.99-cosine archiver caused false-positive archivals
     * (cross-scope, Hard-Anchor, and template false positives, no
     * snapshot/audit). Duplicate collapse now flows exclusively through the
     * dream apply path (scope-tiered, anchor-checked, snapshot-first, audited);
     * promotion only DETECTS and reports consolidation candidates.
     */
    archiveDecayed?: boolean;
    /**
     * T30.3: run the audited auto-crystallization pass (⇐ auto_crystallize,
     * default OFF). Promotes durable memories to 0.97 (sticky, reversible); needs
     * the dream store to audit, else candidates are reported withheld.
     */
    crystallize?: boolean;
  } = {}
): Promise<PromotionResult> {
  const start = Date.now();
  const archiveThreshold = options.archiveThreshold ?? 0.1;
  const similarityThreshold = options.similarityThreshold ?? 0.95;
  const dryRun = options.dryRun ?? false;
  const archiveDecayed = options.archiveDecayed ?? false;
  const crystallize = options.crystallize ?? false;
  const dreamStore = options.dreamStore ?? null;

  logger.info(`Running promotion pipeline (dryRun: ${dryRun})`);

  const runId = await startPromotionRun(pool, sqliteDb, archiveThreshold, similarityThreshold, dryRun);

  try {
    // Step 1: Compute decay scores
    const scores = await computeDecayScores(pool, sqliteDb);
    const avgScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + s.totalScore, 0) / scores.length
      : 0;
    const belowThreshold = scores.filter(s => s.totalScore < archiveThreshold).length;

    logger.info(`Decay scores: ${scores.length} memories, avg=${avgScore.toFixed(3)}, ${belowThreshold} below threshold`);

    // Step 2: Find consolidation candidates
    const consolidationCandidates = await findConsolidationCandidates(queries, embeddingIndex, similarityThreshold);
    const duplicates = consolidationCandidates.filter(c => c.action === 'archive_duplicate');
    const mergeTargets = consolidationCandidates.filter(c => c.action === 'merge');

    // Step 3 (RETIRED, GATE 1): duplicate candidates are reported above but
    // never archived here — the dream apply path owns duplicate collapse.
    if (duplicates.length > 0) {
      logger.info(`${duplicates.length} duplicate candidate(s) detected — reported only; duplicate collapse is owned by the dream apply path (GATE 1 retirement)`);
    }

    // Step 4: Auto-archive decayed memories (R14: AUDITED via the dream apply
    // path, formula matched to the dream `decay` tier — memoryStrength < 0.2 —
    // not the old computeDecayScores < 0.1 divergence). Gated: a dry pass when
    // auto_accept_decay is off, so candidates are still reported. An audited
    // archive needs the dream store; without it a non-dry pass WITHHOLDS rather
    // than archiving unaudited.
    const decayArchiveDry = dryRun || !archiveDecayed;
    let archiveResult: ArchiveResult;
    if (!dryRun && archiveDecayed && !dreamStore) {
      // Can't audit without the dream store — withhold (never archive unaudited).
      logger.warn('Decay archive requested but no dream store available — withholding (R14: no unaudited archives)');
      const dry = await autoArchiveDecayed({ memoryStore: queries }, archiveThreshold, true);
      archiveResult = { archived: [], skipped: 0, threshold: dry.threshold, withheld: dry.archived.length };
    } else {
      archiveResult = await autoArchiveDecayed(
        { memoryStore: queries, dreamStore, vectorIndex: embeddingIndex },
        archiveThreshold,
        decayArchiveDry,
      );
    }
    if (!dryRun && !archiveDecayed) {
      // Withheld is not archived: don't present would-archive ids as archived
      // (the inverse of the incident's memories_archived:0 masking).
      const wouldArchive = archiveResult.archived.length;
      if (wouldArchive > 0) {
        logger.info(`Withheld ${wouldArchive} decay archive(s): auto_accept_decay is off (GATE 1)`);
      }
      archiveResult = { archived: [], skipped: 0, threshold: archiveResult.threshold, withheld: wouldArchive };
    }
    // A true dry run keeps would-archive ids in `archived` (established dry-run
    // reporting); the run row never counts a dry/gated pass as archived.
    const archivedCount = decayArchiveDry ? 0 : archiveResult.archived.length;

    // Step 5 (T30.3): auto-crystallization — promote durable memories to 0.97
    // (sticky, not a Hard Anchor). Audited (snapshot-first, reversible) and gated
    // by auto_crystallize; a dry pass or a missing dream store reports candidates
    // as withheld without mutating.
    let crystallizeResult: CrystallizeResult | undefined;
    if (crystallize) {
      crystallizeResult = await crystallizeEligible({ memoryStore: queries, dreamStore, dryRun });
    }

    // Step 6 (S7): access-log retention — trim rows past the window after a
    // real pass. Reporting-only data (the archive line reads no access log,
    // CX-14); logged only, never part of PromotionResult, never fatal.
    if (!dryRun) {
      try {
        const trimmed = await queries.trimAccessLog(config.retention.accessLogDays);
        if (trimmed > 0) {
          logger.info(`access-log retention: trimmed ${trimmed} rows older than ${config.retention.accessLogDays}d`);
        }
      } catch (err) {
        logger.warn('access-log retention failed (non-fatal):', err);
      }
    }

    const duration = Date.now() - start;
    logger.info(`Promotion pipeline complete in ${duration}ms`);

    if (runId != null) {
      await completePromotionRun(pool, sqliteDb, runId, {
        decayComputed: scores.length,
        decayAvgScore: avgScore,
        decayBelowThreshold: belowThreshold,
        consolidationCandidates: consolidationCandidates.length,
        consolidationDuplicates: duplicates.length,
        consolidationMergeTargets: mergeTargets.length,
        memoriesArchived: archivedCount,
      }, duration, 'completed', null);
    }

    return {
      timestamp: new Date().toISOString(),
      run_id: runId,
      decayScores: {
        computed: scores.length,
        avgScore,
        belowThreshold,
      },
      consolidation: {
        candidates: consolidationCandidates.length,
        duplicates: duplicates.length,
        mergeTargets: mergeTargets.length,
      },
      archive: archiveResult,
      crystallize: crystallizeResult,
      duration_ms: duration,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    if (runId != null) {
      await completePromotionRun(pool, sqliteDb, runId, {
        decayComputed: 0,
        decayAvgScore: 0,
        decayBelowThreshold: 0,
        consolidationCandidates: 0,
        consolidationDuplicates: 0,
        consolidationMergeTargets: 0,
        memoriesArchived: 0,
      }, duration, 'failed', message);
    }
    throw err;
  }
}
