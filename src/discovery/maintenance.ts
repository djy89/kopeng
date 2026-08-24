/**
 * Discovery maintenance — separate from the standard promotion pipeline.
 *
 * Operations:
 * 1. Purge processed observations older than retention period
 * 2. Archive auto-discovered memories where effective confidence < 0.2
 * 3. Scope promotion: same content appearing in 3+ distinct project scopes → re-scope to global
 * 4. Incremental vacuum on observations.db after purge
 *
 * Phase 2: both archive sites (§2, §3) go through the audited dream apply path
 * — every archive is snapshot-first + `dream_audit_log`-audited + rollback-able,
 * under one lazily-created "maintenance carrier" dream row (never a real dream
 * pass; excluded from getLastCompletedDream/listPendingDreams like the promotion
 * carrier, but VISIBLE in dream-history since team-review #22 — it performs real
 * archives, so it must have an operator-facing record). Without audit deps,
 * neither site bare-archives: §2 withholds candidates and §3 skips the whole
 * group.
 *
 * Team-review #22:
 *  - §2 honors `auto_accept_decay` (GATE 1): the sweep's entries are `decay`
 *    class, so the operator flag that governs automated decay archival governs
 *    them too. Flag off (or unreadable) ⇒ candidates are WITHHELD, not archived.
 *  - §3 groups by `normalizeContent` — the SAME predicate as the dream
 *    selector's cross-scope tier. The old `content_hash` grouping was
 *    unreachable: the hash carries a GLOBAL unique index, so cross-scope rows
 *    can never share one.
 *  - §3 promotes by RE-SCOPING the best original to `global` (snapshot-first,
 *    audited `promote_global`/`rescope`, reversible — Phase 2 revisions restore
 *    `scope`), not by creating a new row: `store()`'s scope-agnostic hash dedup
 *    made create-from-best structurally impossible, and a created row had no
 *    undo path. Order is archives-first, rescope-last, with an anchored-member
 *    pre-scan — so "no global promotion without an audited archive of its
 *    originals" holds even on mid-group failure.
 */

import type { IObservationStore, IMemoryStore, IDreamStore, IVectorSearch, IOperatorConfigStore } from '../database/interfaces.js';
import { vacuumObservationsDatabase } from '../database/observations-db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { isGlobalScope } from '../scopes/resolver.js';
import { buildHoldPredicate, type HoldPredicate } from './hold.js';
import { MAINTENANCE_CARRIER_REASON, type DreamDiffEntry } from '../types/types.js';
import { applyEntry, auditedArchiveMemory, type ApplyDeps } from '../dreaming/apply.js';
import { normalizeContent } from '../dreaming/pipeline.js';
import { isAnchored, isDecayedAtRisk, memoryStrength, DECAY_ARCHIVE_THRESHOLD } from '../dreaming/scoring.js';
import { CarrierDream } from '../dreaming/carrier.js';

export interface MaintenanceResult {
  observations_purged: number;
  memories_archived: number;
  memories_promoted: number;
  /** GATE-style posture (Phase 2): candidates that would have archived, withheld — no audit deps, `auto_accept_decay` off (§2), an anchored group member (§3), or a refused/failed apply. */
  memories_withheld: number;
  /** The maintenance carrier dream row the audited archives were attached to (rollback handle). Absent when nothing was audited. */
  dream_id?: number;
  /** Held scopes exempted from the §1 purge — the shared hold predicate (ephemeral-shaped AND not alias-mapped, see ./hold.ts) over the live scope inventory (Phase 3, additive). */
  observations_exempted_scopes: string[];
  duration_ms: number;
}

/** Stores needed to route discovery-maintenance archives through the audited dream apply path. */
export interface MaintenanceAuditDeps {
  dreamStore: IDreamStore;
  vectorIndex: IVectorSearch;
  /** Source of the `auto_accept_decay` + `auto_promote_global` flags (GATE 1). Absent ⇒ both OFF — §2 and §3 withhold. */
  configStore?: IOperatorConfigStore | null;
  /**
   * Alias resolution for §3's distinct-scope count (team-review #22 r2): without
   * it, three casing variants of ONE client scope satisfy the "3 distinct
   * scopes" bar and promote a single project's content to global. Absent ⇒ raw
   * scopes (identity), same as everywhere else in the alias layer.
   */
  canonicalizeScope?: (scope: string) => Promise<string>;
  /**
   * Alias-group expansion for §2's dormancy freeze (Phase 4): a scope's
   * dormancy is judged over its WHOLE alias group (canonical + every variant),
   * so a memory stranded on an alias variant shares its siblings' activity
   * signal instead of reading "no observations ⇒ not dormant ⇒ decays" — and a
   * stale variant can't stay frozen while its canonical sibling is active.
   * Absent ⇒ raw single-scope lookup, byte-identical to pre-Phase-4.
   */
  expandScope?: (scope: string) => Promise<string[]>;
}

/**
 * Config-blob key (operator_config.config) gating §3 scope promotion — same
 * GATE-1 posture and blob mechanism as T30.3's `auto_crystallize`. §3 archives
 * N originals AND widens content to the `global` scope (surfaced in EVERY
 * project), a larger blast radius than the §2 decay sweep, so it must not be
 * the one ungated automated archiver (team-review #22 r2). Default OFF.
 */
export const AUTO_PROMOTE_GLOBAL_KEY = 'auto_promote_global';

/** Read the auto_promote_global flag from an operator_config `config` JSON blob. Default OFF. */
export function readAutoPromoteGlobal(configJson: string | null | undefined): boolean {
  if (!configJson) return false;
  try {
    return JSON.parse(configJson)?.[AUTO_PROMOTE_GLOBAL_KEY] === true;
  } catch {
    return false;
  }
}

/** Optional knobs that apply with or without audit deps (round-2 fix CO5+S1a). */
export interface MaintenanceOptions {
  /**
   * The SHARED hold predicate (buildHoldPredicate in ./hold.ts) driving §1's
   * purge exemption: exempt iff ephemeral-shaped AND not alias-mapped — the
   * SAME predicate the discovery engine's held short-circuit uses, so a RULED
   * ephemeral scope stops being exempt the moment its alias entry lands and
   * its aged observations return to the normal retention clock (spec §7).
   * Absent ⇒ shape-only (`ephemeralReason`), the pre-round-2 behavior.
   */
  isHeld?: HoldPredicate;
}

/**
 * Run discovery maintenance cycle.
 * Independent from runPromotion() — different cadence, different concerns.
 */
export async function runDiscoveryMaintenance(
  observationStore: IObservationStore,
  memoryStore: IMemoryStore,
  audit?: MaintenanceAuditDeps,
  opts: MaintenanceOptions = {}
): Promise<MaintenanceResult> {
  const start = Date.now();
  let observationsPurged = 0;
  let memoriesArchived = 0;
  let memoriesPromoted = 0;
  let memoriesWithheld = 0;

  // One dream row carries every audited archive this run makes (rollback handle
  // + FK target for revision/audit rows). Lazily opened by the shared helper —
  // a run that withholds or finds nothing to do never writes a carrier.
  const carrier = audit ? new CarrierDream(audit.dreamStore, MAINTENANCE_CARRIER_REASON) : null;

  // ── 1. Purge old observations ──
  let observationsExemptedScopes: string[] = [];
  try {
    const retentionDays = config.discovery.observationRetentionDays;
    // HELD observations are exempt: their per-scope watermark never advanced
    // (see SCOPE_WATERMARK_STATUSES), so purging them would destroy the only
    // copy before a future operator ruling can re-drive the scope. The exempt
    // list is the SHARED hold predicate (CO5+S1a: ephemeral-shaped AND not
    // alias-mapped — an alias entry IS the ruling, so a ruled scope's rows
    // return to the normal retention clock) over the live scope inventory.
    // Registry statuses are deliberately NOT consulted here: quarantine is not
    // a hold (R-A) — a quarantined scope's observations were minted from
    // normally and age out normally.
    const isHeld = opts.isHeld ?? buildHoldPredicate();
    const stats = await observationStore.getObservationStats();
    observationsExemptedScopes = [];
    for (const scope of Object.keys(stats.by_project)) {
      if (await isHeld(scope)) observationsExemptedScopes.push(scope);
    }
    observationsExemptedScopes.sort();
    observationsPurged = await observationStore.purgeOlderThan(retentionDays, undefined, observationsExemptedScopes);
    if (observationsPurged > 0) {
      logger.info(`Purged ${observationsPurged} observations older than ${retentionDays} days`);
      // Incremental vacuum to reclaim space
      vacuumObservationsDatabase(100);
    }
  } catch (err) {
    logger.error('Observation purge failed:', err);
  }

  // GATE 1 flags, read once (team-review #22): §2's decay-class archives are
  // governed by `auto_accept_decay`; §3's archive-and-globalize is governed by
  // the `auto_promote_global` config-blob flag. Off, unreadable, or no config
  // store wired ⇒ the section withholds.
  const cfg = audit?.configStore ? await audit.configStore.getConfig().catch(() => null) : null;
  const decayArmed = cfg?.auto_accept_decay === true;
  const promoteArmed = readAutoPromoteGlobal(cfg?.config);

  // ── 2. Archive low-confidence discoveries ──
  try {
    if (audit && !decayArmed) {
      logger.info('Discovery maintenance: auto_accept_decay is off — low-confidence candidates will be withheld, not archived (GATE 1)');
    }

    // Dormant-project freeze (D1.1 decision): wired HERE, where archival has
    // teeth and the observation store is at hand — not at search time (hot
    // path, cross-DB, ingestion may be off; durability covers retrieval).
    // A scope with no observations in 30+ days freezes its memories' decay.
    // Phase 4: the verdict is per ALIAS GROUP — cache keyed on the canonical
    // scope, recency aggregated group-newest over every member — so alias
    // variants of one client share one activity clock. No closures ⇒ raw
    // single-scope lookup, byte-identical to pre-Phase-4.
    const dormantCutoffMs = Date.now() - 30 * 86400000;
    const scopeDormant = new Map<string, boolean>();
    const isScopeDormant = async (scope: string): Promise<boolean> => {
      const canonical = audit?.canonicalizeScope ? await audit.canonicalizeScope(scope).catch(() => scope) : scope;
      const cached = scopeDormant.get(canonical);
      if (cached !== undefined) return cached;
      let dormant = false;
      try {
        const group = audit?.expandScope ? await audit.expandScope(canonical) : [scope];
        let newest: number | null = null;
        for (const s of group) {
          const stats = await observationStore.getObservationStats(s);
          if (stats.newest !== null) {
            const t = new Date(stats.newest).getTime();
            if (newest === null || t > newest) newest = t;
          }
        }
        dormant = newest !== null && newest < dormantCutoffMs;
      } catch {
        // Fail-open: no observation data → can't claim dormancy; let decay apply
      }
      scopeDormant.set(canonical, dormant);
      return dormant;
    };

    // Full paging (Phase 4, CR-3): the old single list() call silently capped
    // the sweep at the first 500 rows. Same cursor contract as
    // selectDecayCandidates (auto-archive.ts): cursor = last-seen id per row,
    // loop until !has_more.
    let sweepCursor: number | undefined;
    for (;;) {
      const { memories, has_more } = await memoryStore.list({
        type: 'discovery',
        limit: 500,
        cursor: sweepCursor,
        include_archived: false,
        lite: true, // r2: neither sweep reads vectors — skip ~6KB/row of embedding
      });
      if (memories.length === 0) break;

      for (const memory of memories) {
        sweepCursor = memory.id;
        // Hard Anchor (CR-1): pinned / locked / operator-confirmed never sweep.
        if (isAnchored(memory)) continue;
        const inputs = {
          confidence: memory.confidence,
          observation_count: memory.observation_count ?? 1,
          last_seen: memory.last_seen ?? null,
          updated_at: memory.updated_at,
          type: memory.type,
          tags: memory.tags,
        };
        const now = new Date();
        if (!isDecayedAtRisk(inputs, now, { dormant: await isScopeDormant(memory.scope) })) continue;
        // Numeric for the rationale/log only — the decision above is the predicate's.
        const effectiveConf = memoryStrength(inputs, now);

        if (!audit) {
          memoriesWithheld++;
          logger.warn(`Discovery maintenance: withholding archive of low-confidence discovery #${memory.id} (effective: ${effectiveConf.toFixed(3)}) — no audit deps wired (Phase 2: never an unaudited archive)`);
          continue;
        }
        if (!decayArmed) {
          memoriesWithheld++;
          continue;
        }

        const carrierDream = await carrier!.open();
        const entry: DreamDiffEntry = {
          change_class: 'decay',
          tier: 'deterministic-safe',
          memory_ids: [memory.id],
          rationale: `Effective confidence ${effectiveConf.toFixed(3)} below the ${DECAY_ARCHIVE_THRESHOLD} archive threshold — discovery-maintenance low-confidence sweep (Phase 2 audited).`,
          after: { archive_ids: [memory.id] },
        };
        const applyDeps: ApplyDeps = { memoryStore, dreamStore: audit.dreamStore, vectorIndex: audit.vectorIndex };
        let applied = false;
        try {
          const result = await applyEntry(applyDeps, carrierDream.id, carrier!.entries.length, entry, true);
          applied = result.outcome === 'applied' && result.archived_ids.length > 0;
          if (applied) {
            memoriesArchived++;
            logger.debug(`Archived low-confidence discovery #${memory.id} (effective: ${effectiveConf.toFixed(3)}) — audited under dream ${carrierDream.id}`);
          } else {
            // Refused (anchored) / vanished mid-run — the run DECLINED this
            // candidate, which the posture signal must reflect (team-review #22).
            memoriesWithheld++;
            logger.warn(`Discovery maintenance: memory ${memory.id} not archived (${result.detail ?? result.outcome})`);
          }
        } catch (err) {
          // applyEntry already compensated (unarchived) on audit failure.
          memoriesWithheld++;
          logger.error(`Discovery maintenance: low-confidence archive of memory ${memory.id} failed — left active:`, err);
        }
        carrier!.record(entry, applied);
      }
      if (!has_more) break;
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
      lite: true, // r2: §3 never reads vectors (rescope, not re-embed); compensation re-reads via peek
    });

    // Effective (canonicalized) scope for the distinct-count and global check —
    // alias variants of one client must never fake the 3-scope bar (r2).
    const effScope = async (scope: string): Promise<string> =>
      audit?.canonicalizeScope ? await audit.canonicalizeScope(scope) : scope;

    // Group by normalized content — the dream selector's cross-scope predicate.
    const byNorm = new Map<string, typeof allDiscoveries>();
    for (const mem of allDiscoveries) {
      if (isGlobalScope(await effScope(mem.scope))) continue;
      const key = normalizeContent(mem.content);
      const existing = byNorm.get(key) ?? [];
      existing.push(mem);
      byNorm.set(key, existing);
    }

    for (const [, group] of byNorm) {
      // Count distinct project scopes (canonicalized)
      const distinctScopes = new Set<string>();
      for (const m of group) distinctScopes.add(await effScope(m.scope));
      if (distinctScopes.size < 3) continue;

      // Check average confidence threshold
      const avgConfidence = group.reduce((sum, m) => sum + m.confidence, 0) / group.length;
      if (avgConfidence < 0.8) continue;

      if (!audit) {
        // No global promotion without an audited archive of its originals.
        memoriesWithheld += group.length;
        logger.warn(`Discovery maintenance: withholding scope promotion for ${group.length} originals across ${distinctScopes.size} scopes — no audit deps wired (Phase 2: never an unaudited archive)`);
        continue;
      }
      if (!promoteArmed) {
        // GATE 1 (r2): §3 archives N originals AND globalizes content — it must
        // not be the one ungated automated archiver. Arm via the
        // `auto_promote_global` config-blob flag.
        memoriesWithheld += group.length;
        logger.info(`Discovery maintenance: auto_promote_global is off — withholding scope promotion for ${group.length} originals across ${distinctScopes.size} scopes (GATE 1)`);
        continue;
      }

      // Group atomicity pre-scan (team-review #22 A3): an anchored member would
      // be refused at archive time, stranding a half-promoted group — decline
      // the whole group up front instead.
      const anchored = group.filter(m => isAnchored(m));
      if (anchored.length > 0) {
        memoriesWithheld += group.length;
        logger.warn(`Discovery maintenance: withholding scope promotion — member(s) ${anchored.map(m => `#${m.id}`).join(', ')} anchored (group of ${group.length})`);
        continue;
      }

      const best = group.reduce((a, b) => a.confidence > b.confidence ? a : b);
      const others = group.filter(m => m.id !== best.id);
      const carrierDream = await carrier!.open();
      const auditDeps = { memoryStore, dreamStore: audit.dreamStore, vectorIndex: audit.vectorIndex };

      // Archives FIRST, rescope LAST — and on ANY group failure the members
      // archived so far are COMPENSATED (unarchive + vector re-add + best-effort
      // audit note), so the group reverts whole (r2 NEW-2: "originals archived,
      // no global row" is loss of reachability, the worse failure mode — a stray
      // global dup would merely self-heal via corpus-health/dreaming).
      const archivedThisGroup: Array<{ id: number }> = [];
      const compensateGroup = async (reason: string) => {
        for (const { id } of archivedThisGroup) {
          try {
            await memoryStore.unarchive(id);
            const row = await memoryStore.peek(id);
            if (row?.embedding) {
              const buf = row.embedding as Buffer;
              await audit.vectorIndex.add(id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
            }
            await audit.dreamStore.appendAudit({
              dream_id: carrierDream.id,
              memory_id: id,
              revision_id: null,
              change_class: 'promote_global',
              action: 'compensate_unarchive',
              applied_automatically: true,
              before_ref: 'archived',
              after_ref: `unarchived;group_declined:${reason}`,
            }).catch(e => logger.warn(`Discovery maintenance: compensation audit for #${id} failed (row IS unarchived):`, e));
          } catch (err) {
            logger.error(`Discovery maintenance: compensation unarchive of #${id} FAILED — recover via rollback under carrier ${carrierDream.id}:`, err);
          }
        }
      };

      let groupFailed = false;
      for (const mem of others) {
        const entry: DreamDiffEntry = {
          change_class: 'promote_global',
          tier: 'deterministic-safe',
          memory_ids: [mem.id],
          rationale: `Same normalized content across ${distinctScopes.size} scopes (avg confidence ${avgConfidence.toFixed(2)}) — canonical survivor #${best.id} re-scoped to global; discovery-maintenance (Phase 2 audited).`,
          after: { promote_scope: 'global', source_ids: [mem.id], promoted_to: best.id },
        };
        let applied = false;
        try {
          const res = await auditedArchiveMemory(
            auditDeps, carrierDream.id, mem.id, 'promote_global',
            { action: 'archive', appliedAutomatically: true, afterRef: `promoted_to=${best.id}` },
          );
          applied = res.outcome === 'archived';
          if (applied) {
            archivedThisGroup.push({ id: mem.id });
            // Stamp promoted_to AFTER the successful archive (r2 NEW-4): the
            // snapshot then predates the stamp, and a refused member never
            // carries a dangling pointer to a promotion that didn't happen.
            try {
              const origMeta = JSON.parse(mem.metadata || '{}');
              origMeta.promoted_to = best.id;
              await memoryStore.update(mem.id, {
                content: mem.content, type: mem.type, scope: mem.scope,
                metadata: JSON.stringify(origMeta), tags: mem.tags,
              });
            } catch (err) {
              logger.warn(`Discovery maintenance: promoted_to stamp on archived #${mem.id} failed (archive stands, audit has the pointer):`, err);
            }
          } else {
            logger.warn(`Discovery maintenance: original #${mem.id} not archived for scope promotion (${res.outcome}) — group declined`);
          }
        } catch (err) {
          logger.error(`Discovery maintenance: archive of original #${mem.id} failed — group declined:`, err);
        }
        carrier!.record(entry, applied);
        if (!applied) { groupFailed = true; break; }
      }

      if (groupFailed) {
        await compensateGroup('member archive refused/failed');
        memoriesWithheld += group.length;
        continue;
      }

      // Rescope the survivor to global: fresh re-read + anchor re-check first
      // (r2: the pre-scan read a stale list; core PUTs don't take the
      // consolidation lock, so an operator anchor/edit mid-run must win), then
      // snapshot → update → audit, compensated on failure (invariant #11).
      // Reversible via rollback — Phase 2 revisions snapshot + restore `scope`.
      const rescopeEntry: DreamDiffEntry = {
        change_class: 'promote_global',
        tier: 'deterministic-safe',
        memory_ids: [best.id],
        rationale: `Survivor of a ${distinctScopes.size}-scope group (avg confidence ${avgConfidence.toFixed(2)}) — re-scoped ${best.scope} → global; discovery-maintenance (Phase 2 audited).`,
        after: { promote_scope: 'global', rescoped_id: best.id, from_scope: best.scope },
      };
      try {
        const bestLive = await memoryStore.peek(best.id);
        if (!bestLive || bestLive.is_archived || isAnchored(bestLive)) {
          logger.warn(`Discovery maintenance: survivor #${best.id} ${!bestLive ? 'vanished' : bestLive.is_archived ? 'was archived' : 'became anchored'} mid-run — group declined`);
          await compensateGroup('survivor unavailable/anchored at rescope time');
          memoriesWithheld += group.length;
          carrier!.record(rescopeEntry, false);
          continue;
        }
        const bestMeta = JSON.parse(bestLive.metadata || '{}');
        bestMeta.promoted_from = others.map(m => ({ id: m.id, scope: m.scope }));
        bestMeta.promotion_scopes = [...distinctScopes];
        const snap = await audit.dreamStore.snapshotRevision(best.id, carrierDream.id);
        // Write back from the FRESH row, so a concurrent content/tag edit is
        // not lost-updated by stale list() values.
        await memoryStore.update(best.id, {
          content: bestLive.content,
          type: bestLive.type,
          scope: 'global',
          metadata: JSON.stringify(bestMeta),
          tags: [...new Set([...(bestLive.tags || []), 'scope-promoted'])],
        });
        try {
          await audit.dreamStore.appendAudit({
            dream_id: carrierDream.id,
            memory_id: best.id,
            revision_id: snap.id,
            change_class: 'promote_global',
            action: 'rescope',
            applied_automatically: true,
            before_ref: `revision:${snap.revision}`,
            after_ref: `scope=global;from=${bestLive.scope}`,
          });
        } catch (err) {
          // Invariant #11: no unaudited change survives — restore the snapshot.
          await audit.dreamStore.restoreRevision(best.id, snap.revision).catch(e =>
            logger.error(`Discovery maintenance: compensation restore of #${best.id} failed:`, e));
          throw err;
        }
      } catch (err) {
        logger.error(`Discovery maintenance: rescope of #${best.id} failed — group compensated:`, err);
        await compensateGroup('rescope failed');
        memoriesWithheld += group.length;
        carrier!.record(rescopeEntry, false);
        continue;
      }

      carrier!.record(rescopeEntry, true);
      memoriesPromoted++;
      // §3's archives were invisible in the result counters (r2 NEW-3).
      memoriesArchived += archivedThisGroup.length;
      logger.info(`Promoted discovery #${best.id} to global scope (${distinctScopes.size} scopes, confidence: ${avgConfidence.toFixed(2)})`);
    }
  } catch (err) {
    logger.error('Scope promotion failed:', err);
  }

  // ── Finalize the carrier dream, if one was opened ──
  // Guarded (team-review #22 A9): a finalize failure must not 500 the route and
  // strand the run's RESULT — the archives themselves are already audited row
  // by row; only the carrier's summary row is at stake.
  try {
    await carrier?.finalize();
  } catch (err) {
    logger.error(`Discovery maintenance: carrier finalize failed — audit rows are intact, carrier ${carrier?.id} left incomplete:`, err);
  }

  const duration = Date.now() - start;
  logger.info(`Discovery maintenance completed: ${observationsPurged} purged, ${memoriesArchived} archived, ${memoriesPromoted} promoted, ${memoriesWithheld} withheld (${duration}ms)`);

  return {
    observations_purged: observationsPurged,
    memories_archived: memoriesArchived,
    memories_promoted: memoriesPromoted,
    memories_withheld: memoriesWithheld,
    dream_id: carrier?.id,
    observations_exempted_scopes: observationsExemptedScopes,
    duration_ms: duration,
  };
}
