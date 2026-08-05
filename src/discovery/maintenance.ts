/**
 * Discovery maintenance — separate from the standard promotion pipeline.
 *
 * Operations:
 * 1. Purge processed observations older than retention period
 * 2. Archive auto-discovered memories where effective confidence < 0.2
 * 3. Scope promotion: same content appearing in 3+ distinct project scopes → create global
 * 4. Incremental vacuum on observations.db after purge
 */

import type { IObservationStore, IMemoryStore } from '../database/interfaces.js';
import { computeEffectiveConfidence, shouldArchive } from './confidence.js';
import { vacuumObservationsDatabase } from '../database/observations-db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

export interface MaintenanceResult {
  observations_purged: number;
  memories_archived: number;
  memories_promoted: number;
  duration_ms: number;
}

/**
 * Run discovery maintenance cycle.
 * Independent from runPromotion() — different cadence, different concerns.
 */
export async function runDiscoveryMaintenance(
  observationStore: IObservationStore,
  memoryStore: IMemoryStore
): Promise<MaintenanceResult> {
  const start = Date.now();
  let observationsPurged = 0;
  let memoriesArchived = 0;
  let memoriesPromoted = 0;

  // ── 1. Purge old observations ──
  try {
    const retentionDays = config.discovery.observationRetentionDays;
    observationsPurged = await observationStore.purgeOlderThan(retentionDays);
    if (observationsPurged > 0) {
      logger.info(`Purged ${observationsPurged} observations older than ${retentionDays} days`);
      // Incremental vacuum to reclaim space
      vacuumObservationsDatabase(100);
    }
  } catch (err) {
    logger.error('Observation purge failed:', err);
  }

  // ── 2. Archive low-confidence discoveries ──
  try {
    const { memories } = await memoryStore.list({
      type: 'discovery',
      limit: 500,
      include_archived: false,
    });

    // Dormant-project freeze (D1.1 decision): wired HERE, where archival has
    // teeth and the observation store is at hand — not at search time (hot
    // path, cross-DB, ingestion may be off; durability covers retrieval).
    // A scope with no observations in 30+ days freezes its memories' decay.
    const dormantCutoffMs = Date.now() - 30 * 86400000;
    const scopeDormant = new Map<string, boolean>();
    const isScopeDormant = async (scope: string): Promise<boolean> => {
      const cached = scopeDormant.get(scope);
      if (cached !== undefined) return cached;
      let dormant = false;
      try {
        const stats = await observationStore.getObservationStats(scope);
        dormant = stats.newest !== null && new Date(stats.newest).getTime() < dormantCutoffMs;
      } catch {
        // No observation data → can't claim dormancy; let decay apply
      }
      scopeDormant.set(scope, dormant);
      return dormant;
    };

    for (const memory of memories) {
      const effectiveConf = computeEffectiveConfidence(
        memory.confidence,
        memory.last_seen ?? memory.updated_at,
        new Date(),
        await isScopeDormant(memory.scope),
        memory.observation_count ?? 1,
        memory.type,
        memory.tags
      );

      if (shouldArchive(effectiveConf)) {
        await memoryStore.archive(memory.id);
        memoriesArchived++;
        logger.debug(`Archived low-confidence discovery #${memory.id} (effective: ${effectiveConf.toFixed(3)})`);
      }
    }

    if (memoriesArchived > 0) {
      logger.info(`Archived ${memoriesArchived} low-confidence discoveries`);
    }
  } catch (err) {
    logger.error('Discovery archival failed:', err);
  }

  // ── 3. Scope promotion: discoveries appearing in 3+ project scopes ──
  try {
    const { memories: allDiscoveries } = await memoryStore.list({
      type: 'discovery',
      limit: 1000,
      include_archived: false,
    });

    // Group by content_hash to find cross-project patterns
    const byHash = new Map<string, typeof allDiscoveries>();
    for (const mem of allDiscoveries) {
      if (!mem.content_hash || mem.scope === 'global') continue;
      const existing = byHash.get(mem.content_hash) ?? [];
      existing.push(mem);
      byHash.set(mem.content_hash, existing);
    }

    for (const [, group] of byHash) {
      // Count distinct project scopes
      const distinctScopes = new Set(group.map(m => m.scope));
      if (distinctScopes.size < 3) continue;

      // Check average confidence threshold
      const avgConfidence = group.reduce((sum, m) => sum + m.confidence, 0) / group.length;
      if (avgConfidence < 0.8) continue;

      // Promote: create global memory from the highest-confidence version
      const best = group.reduce((a, b) => a.confidence > b.confidence ? a : b);

      const metadata = JSON.parse(best.metadata || '{}');
      metadata.promoted_from = group.map(m => ({ id: m.id, scope: m.scope }));
      metadata.promotion_scopes = [...distinctScopes];

      const result = await memoryStore.store({
        content: best.content,
        type: 'discovery',
        scope: 'global',
        source: 'auto-discovery',
        source_path: null,
        metadata: JSON.stringify(metadata),
        embedding: best.embedding,
        embedding_model: best.embedding_model,
        created_by: 'discovery-maintenance',
        tags: [...(best.tags || []), 'scope-promoted'],
        confidence: Math.min(0.85, avgConfidence),
      });

      if (!result.deduplicated) {
        memoriesPromoted++;

        // Archive the project-scoped originals with promoted_to reference
        for (const mem of group) {
          const origMeta = JSON.parse(mem.metadata || '{}');
          origMeta.promoted_to = result.id;
          await memoryStore.update(mem.id, {
            content: mem.content,
            type: mem.type,
            scope: mem.scope,
            metadata: JSON.stringify(origMeta),
            tags: mem.tags,
          });
          await memoryStore.archive(mem.id);
        }

        logger.info(`Promoted discovery to global scope (${distinctScopes.size} scopes, confidence: ${avgConfidence.toFixed(2)})`);
      }
    }
  } catch (err) {
    logger.error('Scope promotion failed:', err);
  }

  const duration = Date.now() - start;
  logger.info(`Discovery maintenance completed: ${observationsPurged} purged, ${memoriesArchived} archived, ${memoriesPromoted} promoted (${duration}ms)`);

  return {
    observations_purged: observationsPurged,
    memories_archived: memoriesArchived,
    memories_promoted: memoriesPromoted,
    duration_ms: duration,
  };
}
