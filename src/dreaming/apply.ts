/**
 * Dream apply path (D1.3) — the FIRST code that mutates memories. Every write
 * here is snapshot-first, audited, and reversible:
 *
 *   snapshot to memory_revisions → mutate the live row → append dream_audit_log
 *
 * Invariants honored:
 *  - #3  The deterministic engine writes; the reasoner never reaches this file.
 *  - #4  Everything rollback-able via memory_revisions (stable memories.id).
 *  - #8  Hard Anchor re-checked at apply time (defense in depth — the selector
 *        already excludes anchored memories, but the diff may be stale).
 *  - #10 D1.3 actions never change content, so no re-embed is needed; the vector
 *        index is kept in sync (archived ids removed, restored ids re-added).
 *        Rollback restores the stored embedding alongside the content, so the
 *        vector never goes stale. Neo4j stays read-only to dreams (invariant #7).
 *  - #11 An unaudited change must not survive: if the audit append fails, the
 *        mutation is compensated (unarchived) and the entry fails.
 *
 * Auto-apply gating (operator decision, plan §1.3): ONLY the two classes with an
 * explicit operator_config flag auto-apply — `exact_dup` ⇐ auto_accept_exact_dup,
 * `decay` ⇐ auto_accept_decay (both default OFF until GATE 1). Deterministic-safe
 * `merge` (cosine ≥0.95) and `promote_global` (diff-only signal for the
 * maintenance promotion path) always queue for review; reasoner-driven entries
 * always queue.
 *
 * D2.2 adds two operator-accept executors (both reasoner-driven, so they can
 * ONLY run through resolveDream — never auto-apply):
 *  - `supersede`: deprecated_at on the old statement, valid_from on the new;
 *    BOTH rows stay active (supersession is a chain, not an archive).
 *  - `conditional`: the branch encoding becomes a NEW memory (embedded via the
 *    injected `embedText` — invariant #10's re-embed clause) with provenance to
 *    both sources; the originals get last_contradicted + a durability reset.
 *  `contested` entries are review-only: accept is refused (not_actionable) —
 *  the operator acts via update/archive_memory and rejects the entry.
 */
import type { IMemoryStore, IDreamStore, IVectorSearch } from '../database/interfaces.js';
import type { Dream, DreamAcceptance, DreamAuditEntry, DreamDiff, DreamDiffEntry, Memory, OperatorConfig } from '../types/types.js';
import { normalizeContent } from './pipeline.js';
import { isAnchored, isPinnedMetadata } from './scoring.js';
import logger from '../utils/logger.js';

export interface ApplyDeps {
  memoryStore: IMemoryStore;
  dreamStore: IDreamStore;
  vectorIndex: IVectorSearch;
  /**
   * D2.2: embeds the content of a conditional branch encoding (the only apply
   * action that creates content). Absent → conditional entries are refused as
   * not_actionable and stay pending; all other classes are unaffected.
   */
  embedText?: (text: string) => Promise<{ vector: Float32Array; model: string }>;
  /**
   * Phase 2: CURRENT alias resolution, used to prefer an already-canonical
   * survivor on exact_dup collapses. `pickKeepTarget` (the selector's own
   * keep-choice) never considers scope canonicality, so an alias-scoped row
   * routinely gets proposed as the keep target over its canonical-scoped
   * duplicate — this corrects that for essentially every cross-alias
   * exact_dup group, not just diffs generated under a stale table. Absent ⇒
   * no canonical-survivor preference; the staleness checks above still run.
   */
  canonicalizeScope?: (scope: string) => Promise<string>;
}

/** Why an entry did (not) apply. `anchored`/`not_actionable` leave it pending. */
export type EntryOutcome = 'applied' | 'rejected' | 'not_actionable' | 'anchored' | 'already_resolved' | 'failed';

export interface EntryResult {
  index: number;
  outcome: EntryOutcome;
  archived_ids: number[];
  revision_ids: number[];
  detail?: string;
}

/** The machine-actionable half of a diff entry's `after` proposal. */
interface CollapseProposal {
  keep_id: number | null;
  archive_ids: number[];
}

/**
 * Extract the actionable proposal from an entry. Returns null for entries the
 * D1.3 apply path cannot execute: near-dup band merges (no `after` — Phase 2
 * classifies them) and `promote_global` (diff-only signal; the cross-scope
 * promotion lives in discovery/maintenance.ts).
 */
export function actionableProposal(entry: DreamDiffEntry): CollapseProposal | null {
  const after = entry.after as { keep_id?: unknown; archive_ids?: unknown } | undefined;
  if (!after || typeof after !== 'object' || !Array.isArray(after.archive_ids)) return null;
  if (!after.archive_ids.every(id => typeof id === 'number')) return null;

  switch (entry.change_class) {
    case 'exact_dup':
    case 'merge':
      return typeof after.keep_id === 'number'
        ? { keep_id: after.keep_id, archive_ids: after.archive_ids as number[] }
        : null;
    case 'decay':
      return { keep_id: null, archive_ids: after.archive_ids as number[] };
    default:
      return null;
  }
}

/**
 * Auto-apply gate: deterministic-safe AND covered by an explicit operator flag.
 * Flags ship OFF; GATE 1 governs the flip.
 */
export function isAutoApplicable(entry: DreamDiffEntry, config: OperatorConfig | null): boolean {
  if (!config || entry.tier !== 'deterministic-safe' || entry.resolution) return false;
  switch (entry.change_class) {
    case 'exact_dup': return config.auto_accept_exact_dup;
    case 'decay': return config.auto_accept_decay;
    default: return false;
  }
}

/**
 * Dream-level acceptance derived from per-entry resolutions.
 * 'partial' = some entries still pending, or a mixed accept/reject outcome.
 */
export function computeAcceptance(entries: DreamDiffEntry[]): DreamAcceptance {
  if (entries.length === 0) return 'empty';
  const resolved = entries.filter(e => e.resolution);
  if (resolved.length === 0) return 'pending';
  if (resolved.length < entries.length) return 'partial';
  if (entries.every(e => e.resolution === 'rejected')) return 'rejected';
  if (entries.every(e => e.resolution === 'auto_applied')) return 'auto_applied';
  if (entries.some(e => e.resolution === 'rejected')) return 'partial';
  return 'accepted';
}

/**
 * Phase 2: THE audited-archive primitive for every automated CONTENT-MUTATING
 * archive. snapshot → archive → audit (compensate-unarchive on audit
 * failure, invariant #11) → drop from the vector index. Re-checks
 * missing/anchored/already-archived so callers stay idempotent.
 *
 * Bounded exception (ruling 4): `rollbackDreamCreation` archives directly with
 * a BEST-EFFORT audit — a rollback's undo record is the operator action itself,
 * and compensating there would un-do the rollback the operator just asked for.
 */
export async function auditedArchiveMemory(
  deps: Pick<ApplyDeps, 'memoryStore' | 'dreamStore' | 'vectorIndex'>,
  dreamId: number,
  memoryId: number,
  changeClass: DreamAuditEntry['change_class'],
  opts: { action?: string; appliedAutomatically?: boolean; afterRef?: string; preloaded?: Memory | null } = {},
): Promise<{ outcome: 'archived' | 'skipped_missing' | 'skipped_archived' | 'refused_anchored'; revision_id?: number }> {
  // peek, not get: an audit-internal inspection must not write an access-log
  // row (team-review #22 P2 — member reads are not reinforcement points).
  // `preloaded` lets applyEntry reuse its revalidation reads (same lock hold).
  const mem = opts.preloaded ?? await deps.memoryStore.peek(memoryId);
  if (!mem) return { outcome: 'skipped_missing' };
  if (isAnchored(mem)) {
    // Hard Anchor (invariant #8) — never mutate, even if a stale diff asks.
    logger.warn(`Dream ${dreamId} apply: memory ${memoryId} is anchored (locked=${mem.is_locked}, conf=${mem.confidence}, pinned=${isPinnedMetadata(mem.metadata)}) — refusing`);
    return { outcome: 'refused_anchored' };
  }
  if (mem.is_archived) return { outcome: 'skipped_archived' };

  const snap = await deps.dreamStore.snapshotRevision(memoryId, dreamId);
  await deps.memoryStore.archive(memoryId);
  try {
    await deps.dreamStore.appendAudit({
      dream_id: dreamId,
      memory_id: memoryId,
      revision_id: snap.id,
      change_class: changeClass,
      action: opts.action ?? 'archive',
      applied_automatically: opts.appliedAutomatically ?? false,
      before_ref: `revision:${snap.revision}`,
      after_ref: opts.afterRef ?? 'archived',
    });
  } catch (err) {
    await deps.memoryStore.unarchive(memoryId).catch(e =>
      logger.error(`auditedArchiveMemory: compensation unarchive of ${memoryId} failed:`, e));
    throw err;
  }
  try {
    await deps.vectorIndex.remove(memoryId);
  } catch (err) {
    logger.warn(`auditedArchiveMemory: vector index remove(${memoryId}) failed (search filters archived ids):`, err);
  }
  return { outcome: 'archived', revision_id: snap.id };
}

/**
 * Execute one entry's proposal: archive every `archive_ids` member, each one
 * snapshot-first and audited. MUST run inside the consolidation lock.
 *
 * Per-memory re-checks make retries idempotent: a vanished row is skipped, an
 * already-archived row is already at its end state, and an anchored row
 * (is_locked / confidence >= 1.0) is refused — anchored refusals fail the whole
 * entry so it stays pending instead of silently half-applying.
 */
export async function applyEntry(
  deps: ApplyDeps,
  dreamId: number,
  index: number,
  entry: DreamDiffEntry,
  appliedAutomatically: boolean,
  nowIso: string = new Date().toISOString(),
): Promise<EntryResult> {
  // D2.2 executors — reasoner-driven by construction, reachable only via
  // operator accept (resolveDream); the auto-apply gate never covers them.
  switch (entry.change_class) {
    case 'supersede':
      return applySupersession(deps, dreamId, index, entry, appliedAutomatically, nowIso);
    case 'conditional':
      return applyConditionalEncode(deps, dreamId, index, entry, appliedAutomatically, nowIso);
    case 'contested':
      return {
        index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
        detail: 'contested entries are review-only — resolve the contradiction via update/archive_memory, then reject the entry',
      };
    default:
      break;
  }

  const proposal = actionableProposal(entry);
  if (!proposal) {
    return {
      index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
      detail: entry.change_class === 'promote_global'
        ? 'promote_global is a diff-only signal — the cross-scope promotion path applies it'
        : 'no machine-actionable proposal (reasoner-driven entries are classified in Phase 2)',
    };
  }

  // One non-reinforcing read per member per apply (team-review #22 P2): the
  // three revalidation steps + the archive loop previously re-`get()`ed the
  // same rows ~3x each, planting an access-log row per read — on refused-stale
  // entries that reinforced members of a proposal that applied NOTHING. Reads
  // are cached for this applyEntry invocation only, so retries stay fresh.
  const memberCache = new Map<number, Memory | null>();
  const peekMember = async (id: number): Promise<Memory | null> => {
    if (!memberCache.has(id)) memberCache.set(id, await deps.memoryStore.peek(id));
    return memberCache.get(id)!;
  };

  // ── Phase 2 apply-time revalidation (stale-diff defense) ──
  // 1. Keep-target liveness (G3): archiving members toward a dead survivor
  //    is data loss — refuse and leave the entry pending for review.
  let keepMem: Memory | null = null;
  if (proposal.keep_id !== null) {
    keepMem = await peekMember(proposal.keep_id);
    if (!keepMem || keepMem.is_archived) {
      return {
        index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
        detail: `stale diff: keep target #${proposal.keep_id} ${keepMem ? 'was archived' : 'no longer exists'} since the proposal — entry left pending`,
      };
    }
  }
  // 2. Content-hash revalidation (provenance present ⇒ Phase 2 diff).
  if (entry.provenance) {
    for (const p of entry.provenance.members) {
      if (!p.content_hash) continue;
      const live = await peekMember(p.id);
      if (live && live.content_hash !== p.content_hash) {
        return {
          index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
          detail: `stale diff: memory #${p.id} content changed since the proposal — entry left pending`,
        };
      }
    }
  }
  // 3. Canonical-survivor preference (exact_dup only — the group is already
  //    normalized-content-equal by construction, so swapping survivors
  //    changes no information, only which scope wins). Gated on the SAME
  //    predicate the selector used to form the exact_dup group in the first
  //    place (normalizeContent), not raw content_hash equality: exact_dup
  //    pairs are typically case/whitespace variants with DIFFERENT hashes
  //    (content_hash is also globally unique, so two live rows can never
  //    share one) — a hash-equality gate would make this branch dead code.
  if (entry.change_class === 'exact_dup' && keepMem && deps.canonicalizeScope) {
    const keepEffective = await deps.canonicalizeScope(keepMem.scope);
    if (keepMem.scope !== keepEffective) {
      const keepNorm = normalizeContent(keepMem.content);
      for (const candidateId of proposal.archive_ids) {
        const cand = await peekMember(candidateId);
        if (cand && !cand.is_archived && cand.scope === keepEffective
            && normalizeContent(cand.content) === keepNorm) {
          const originalKeepId = proposal.keep_id!;
          logger.info(`Dream ${dreamId} apply: preferring already-canonical survivor #${candidateId} (${cand.scope}) over #${originalKeepId} (${keepMem.scope})`);
          proposal.archive_ids = proposal.archive_ids.filter(id => id !== candidateId).concat(originalKeepId);
          proposal.keep_id = candidateId;
          // The persisted diff (GET /api/dreams/:id/diff) must show the TRUE
          // survivor, not the stale pre-swap proposal — merge the swapped
          // values over `after` rather than replacing it wholesale.
          entry.after = {
            ...(typeof entry.after === 'object' && entry.after !== null ? entry.after : {}),
            keep_id: candidateId,
            archive_ids: proposal.archive_ids,
          };
          // Marker-guarded so a re-run of a pending entry (swap performed but
          // not yet persisted) doesn't append the note twice.
          if (!entry.rationale.includes('[apply-time: canonical-survivor swap')) {
            entry.rationale += ` [apply-time: canonical-survivor swap — kept #${candidateId} on ${cand.scope}, archived proposed keep #${originalKeepId}]`;
          }
          break;
        }
      }
    }
  }

  const archivedIds: number[] = [];
  const revisionIds: number[] = [];
  let anchoredSkips = 0;

  for (const id of proposal.archive_ids) {
    const res = await auditedArchiveMemory(deps, dreamId, id, entry.change_class, {
      action: 'archive',
      appliedAutomatically,
      afterRef: proposal.keep_id !== null ? `archived;kept=${proposal.keep_id}` : 'archived',
      preloaded: memberCache.has(id) ? memberCache.get(id) : undefined,
    });
    switch (res.outcome) {
      case 'skipped_missing':
        logger.warn(`Dream ${dreamId} apply: memory ${id} no longer exists — skipping`);
        continue;
      case 'refused_anchored':
        // Hard Anchor (invariant #8) — never mutate, even if a stale diff asks.
        // auditedArchiveMemory already logged the locked/confidence detail.
        anchoredSkips++;
        continue;
      case 'skipped_archived':
        continue; // already at the proposed end state
      case 'archived':
        archivedIds.push(id);
        revisionIds.push(res.revision_id!);
        continue;
    }
  }

  if (anchoredSkips > 0) {
    return {
      index, outcome: 'anchored', archived_ids: archivedIds, revision_ids: revisionIds,
      detail: `${anchoredSkips} anchored member(s) refused — entry left pending for review`,
    };
  }
  return { index, outcome: 'applied', archived_ids: archivedIds, revision_ids: revisionIds };
}

/** Hard Anchor on a live row (invariant #8) — apply-time re-check, stale-diff
 *  defense. Delegates to THE contract (CR-1) so the supersede/conditional
 *  executors honor `metadata.pinned` like every other automated mutation path. */
function isAnchoredRow(mem: Memory): boolean {
  return isAnchored(mem);
}

/**
 * D2.2 supersession executor: deprecated_at on the old statement, valid_from on
 * the new (anchored to when the new statement was CREATED, not when the dream
 * applied — the preference changed when it was stated). Both rows stay active;
 * the chain lives in the temporal markers + the audit pair. Snapshot-first per
 * row; an audit failure compensates by restoring the snapshot (invariant #11).
 * Idempotent: a row already at its end state is skipped.
 */
async function applySupersession(
  deps: ApplyDeps,
  dreamId: number,
  index: number,
  entry: DreamDiffEntry,
  appliedAutomatically: boolean,
  nowIso: string,
): Promise<EntryResult> {
  const after = entry.after as { supersede?: { deprecated_id?: unknown; current_id?: unknown } } | undefined;
  const deprecatedId = after?.supersede?.deprecated_id;
  const currentId = after?.supersede?.current_id;
  if (typeof deprecatedId !== 'number' || typeof currentId !== 'number' || deprecatedId === currentId) {
    return {
      index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
      detail: 'no machine-actionable supersede proposal',
    };
  }

  // peek, not get — apply-time revalidation reads are not reinforcement points
  // (team-review #22 r2: the executors must follow the same doctrine applyEntry does).
  const oldMem = await deps.memoryStore.peek(deprecatedId);
  const newMem = await deps.memoryStore.peek(currentId);
  if (!oldMem || !newMem) {
    return {
      index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
      detail: `stale diff: memory ${!oldMem ? deprecatedId : currentId} no longer exists`,
    };
  }
  if (isAnchoredRow(oldMem) || isAnchoredRow(newMem)) {
    logger.warn(`Dream ${dreamId} supersede: pair ${deprecatedId}/${currentId} touches an anchored memory — refusing`);
    return {
      index, outcome: 'anchored', archived_ids: [], revision_ids: [],
      detail: 'anchored member refused — entry left pending for review',
    };
  }

  const revisionIds: number[] = [];

  // Old side: mark deprecated (skip if already at the end state).
  if (!oldMem.deprecated_at) {
    const snap = await deps.dreamStore.snapshotRevision(deprecatedId, dreamId);
    await deps.memoryStore.setTemporalMarkers(deprecatedId, { deprecated_at: nowIso });
    try {
      await deps.dreamStore.appendAudit({
        dream_id: dreamId,
        memory_id: deprecatedId,
        revision_id: snap.id,
        change_class: 'supersede',
        action: 'deprecate',
        applied_automatically: appliedAutomatically,
        before_ref: `revision:${snap.revision}`,
        after_ref: `superseded_by=${currentId}`,
      });
    } catch (err) {
      // Invariant #11: no unaudited change survives — compensate, then fail.
      await deps.memoryStore.setTemporalMarkers(deprecatedId, { deprecated_at: null }).catch(e =>
        logger.error(`Dream ${dreamId} supersede: compensation un-deprecate of ${deprecatedId} failed:`, e));
      throw err;
    }
    revisionIds.push(snap.id);
  }

  // New side: ensure valid_from is set (backfill usually has; the audit row is
  // the supersedes link either way).
  const validFrom = newMem.valid_from ?? newMem.created_at;
  const snapNew = await deps.dreamStore.snapshotRevision(currentId, dreamId);
  await deps.memoryStore.setTemporalMarkers(currentId, { valid_from: validFrom });
  try {
    await deps.dreamStore.appendAudit({
      dream_id: dreamId,
      memory_id: currentId,
      revision_id: snapNew.id,
      change_class: 'supersede',
      action: 'mark_current',
      applied_automatically: appliedAutomatically,
      before_ref: `revision:${snapNew.revision}`,
      after_ref: `supersedes=${deprecatedId}`,
    });
  } catch (err) {
    await deps.memoryStore.setTemporalMarkers(currentId, { valid_from: newMem.valid_from ?? null }).catch(e =>
      logger.error(`Dream ${dreamId} supersede: compensation on ${currentId} failed:`, e));
    throw err;
  }
  revisionIds.push(snapNew.id);

  return {
    index, outcome: 'applied', archived_ids: [], revision_ids: revisionIds,
    detail: `#${currentId} supersedes #${deprecatedId} — both kept (deprecated_at/valid_from set)`,
  };
}

/**
 * D2.2 conditional executor: the branch encoding ("when X→A; when Y→B")
 * becomes a NEW memory — embedded via deps.embedText (invariant #10), with
 * provenance to both sources in metadata.condition_sources — and the originals
 * get last_contradicted + a durability reset (observation_count → 1: a
 * contradicted memory re-earns its decay resistance). Originals stay active.
 *
 * Ordered so a failure never leaves an unaudited write: the new memory is
 * created and audited FIRST (compensation: archive it); each original is then
 * snapshot → markContradicted → audit, compensated by restoring its snapshot.
 * Retry-safe: the content-hash dedup reuses (and unarchives) a previously
 * created encoding instead of duplicating it.
 */
async function applyConditionalEncode(
  deps: ApplyDeps,
  dreamId: number,
  index: number,
  entry: DreamDiffEntry,
  appliedAutomatically: boolean,
  nowIso: string,
): Promise<EntryResult> {
  if (!deps.embedText) {
    return {
      index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
      detail: 'conditional encoding requires the embedder (embedText not wired) — left pending',
    };
  }
  const after = entry.after as {
    encode?: { content?: unknown; source_ids?: unknown; condition_a?: unknown; condition_b?: unknown };
  } | undefined;
  const enc = after?.encode;
  const sourceIds = Array.isArray(enc?.source_ids) ? enc.source_ids : null;
  if (
    !enc || typeof enc.content !== 'string' || !enc.content.trim()
    || !sourceIds || sourceIds.length !== 2 || !sourceIds.every((id): id is number => typeof id === 'number')
  ) {
    return {
      index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
      detail: 'no machine-actionable encode proposal',
    };
  }

  const sources: Memory[] = [];
  for (const id of sourceIds) {
    const mem = await deps.memoryStore.peek(id);
    if (!mem) {
      return {
        index, outcome: 'not_actionable', archived_ids: [], revision_ids: [],
        detail: `stale diff: source memory ${id} no longer exists`,
      };
    }
    if (isAnchoredRow(mem)) {
      logger.warn(`Dream ${dreamId} conditional: source ${id} is anchored — refusing`);
      return {
        index, outcome: 'anchored', archived_ids: [], revision_ids: [],
        detail: 'anchored source refused — entry left pending for review',
      };
    }
    sources.push(mem);
  }
  const [a, b] = sources;

  // 1. Create (or reuse) the encoded memory, audited before anything else moves.
  const { vector, model } = await deps.embedText(enc.content);
  const { id: encodedId, deduplicated } = await deps.memoryStore.store({
    content: enc.content,
    type: a.type === b.type ? a.type : 'project',
    scope: a.scope,
    source: 'dream-consolidation',
    source_path: null,
    metadata: JSON.stringify({
      condition_sources: sourceIds,
      condition_a: typeof enc.condition_a === 'string' ? enc.condition_a : null,
      condition_b: typeof enc.condition_b === 'string' ? enc.condition_b : null,
      encoded_by_dream: dreamId,
    }),
    embedding: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    embedding_model: model,
    created_by: null,
    tags: ['dream-encoded', 'conditional'],
    confidence: Math.min(a.confidence, b.confidence),
  });
  if (deduplicated) {
    // A prior (possibly compensated) attempt already created this encoding.
    const existing = await deps.memoryStore.peek(encodedId);
    if (existing?.is_archived) await deps.memoryStore.unarchive(encodedId);
  }
  try {
    await deps.vectorIndex.add(encodedId, vector);
  } catch (err) {
    logger.warn(`Dream ${dreamId} conditional: vector index add(${encodedId}) failed:`, err);
  }
  try {
    await deps.dreamStore.appendAudit({
      dream_id: dreamId,
      memory_id: encodedId,
      revision_id: null,
      change_class: 'conditional',
      action: 'encode_branch',
      applied_automatically: appliedAutomatically,
      before_ref: null,
      after_ref: `created:${encodedId};sources:${sourceIds.join(',')}`,
    });
  } catch (err) {
    await deps.memoryStore.archive(encodedId).catch(e =>
      logger.error(`Dream ${dreamId} conditional: compensation archive of ${encodedId} failed:`, e));
    await deps.vectorIndex.remove(encodedId).catch(() => { /* search filters archived ids */ });
    throw err;
  }

  // 2. Stamp the originals: snapshot → last_contradicted + durability reset → audit.
  const revisionIds: number[] = [];
  for (const mem of sources) {
    const snap = await deps.dreamStore.snapshotRevision(mem.id, dreamId);
    await deps.memoryStore.markContradicted([mem.id], nowIso);
    try {
      await deps.dreamStore.appendAudit({
        dream_id: dreamId,
        memory_id: mem.id,
        revision_id: snap.id,
        change_class: 'conditional',
        action: 'mark_contradicted',
        applied_automatically: appliedAutomatically,
        before_ref: `revision:${snap.revision}`,
        after_ref: `encoded_in=${encodedId}`,
      });
    } catch (err) {
      // Invariant #11: restore the snapshot (last_contradicted + observation_count).
      await deps.dreamStore.restoreRevision(mem.id, snap.revision).catch(e =>
        logger.error(`Dream ${dreamId} conditional: compensation restore of ${mem.id} failed:`, e));
      throw err;
    }
    revisionIds.push(snap.id);
  }

  return {
    index, outcome: 'applied', archived_ids: [], revision_ids: revisionIds,
    detail: `branch encoded as #${encodedId}; originals kept with last_contradicted + durability reset`,
  };
}

export interface AutoApplyResult {
  applied: number;
  queued: number;
}

/**
 * The engine's auto-apply step (runs inside runDreamPass's lock hold, after the
 * diff is stored). Mutates `entries` in place with resolutions; per-entry
 * failures are caught and leave that entry pending — generation never fails
 * because apply hiccuped.
 */
export async function autoApplyDiff(
  deps: ApplyDeps,
  dreamId: number,
  entries: DreamDiffEntry[],
  config: OperatorConfig | null,
  nowIso: string,
): Promise<AutoApplyResult> {
  let applied = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isAutoApplicable(entry, config)) continue;
    try {
      const result = await applyEntry(deps, dreamId, i, entry, true, nowIso);
      if (result.outcome === 'applied') {
        entry.resolution = 'auto_applied';
        entry.resolved_at = nowIso;
        applied++;
      } else {
        logger.warn(`Dream ${dreamId} auto-apply: entry ${i} (${entry.change_class}) not applied: ${result.detail ?? result.outcome}`);
      }
    } catch (err) {
      logger.error(`Dream ${dreamId} auto-apply: entry ${i} (${entry.change_class}) failed — left pending:`, err);
    }
  }
  return { applied, queued: entries.length - applied };
}

export interface ResolveResult {
  dream_id: number;
  action: 'accept' | 'reject';
  acceptance_status: DreamAcceptance;
  results: EntryResult[];
  applied: number;
  rejected: number;
  skipped: number;
}

/**
 * Operator resolution of queued entries (D1.3 review path). `entryIndices`
 * narrows the action to a subset — that is how a partial resolution happens.
 * Accept MUST be called inside the consolidation lock (it mutates memories);
 * reject only writes the dream row.
 */
export async function resolveDream(
  deps: ApplyDeps,
  dream: Dream,
  action: 'accept' | 'reject',
  entryIndices: number[] | undefined,
  nowIso: string,
): Promise<ResolveResult> {
  const diff: DreamDiff = dream.output_diff ? JSON.parse(dream.output_diff) : { entries: [] };
  const entries = diff.entries ?? [];
  const targets = entryIndices ?? entries.map((_, i) => i);

  const results: EntryResult[] = [];
  let applied = 0, rejected = 0, skipped = 0;

  for (const index of targets) {
    const entry = entries[index];
    if (!entry) {
      results.push({ index, outcome: 'failed', archived_ids: [], revision_ids: [], detail: 'no such entry index' });
      skipped++;
      continue;
    }
    if (entry.resolution) {
      results.push({ index, outcome: 'already_resolved', archived_ids: [], revision_ids: [], detail: entry.resolution });
      skipped++;
      continue;
    }

    if (action === 'reject') {
      entry.resolution = 'rejected';
      entry.resolved_at = nowIso;
      results.push({ index, outcome: 'rejected', archived_ids: [], revision_ids: [] });
      rejected++;
      continue;
    }

    try {
      const result = await applyEntry(deps, dream.id, index, entry, false, nowIso);
      results.push(result);
      if (result.outcome === 'applied') {
        entry.resolution = 'accepted';
        entry.resolved_at = nowIso;
        applied++;
      } else {
        skipped++;
      }
    } catch (err) {
      results.push({
        index, outcome: 'failed', archived_ids: [], revision_ids: [],
        detail: err instanceof Error ? err.message : String(err),
      });
      skipped++;
    }
  }

  const acceptance = computeAcceptance(entries);
  await deps.dreamStore.setDreamDiff(dream.id, { entries });
  await deps.dreamStore.updateDream(dream.id, {
    acceptance_status: acceptance,
    changes_queued: entries.filter(e => !e.resolution).length,
  });

  return { dream_id: dream.id, action, acceptance_status: acceptance, results, applied, rejected, skipped };
}

export interface RollbackResult {
  memory_id: number;
  restored_revision: number;
  /** The pre-rollback state was snapshotted as this revision (restore is itself reversible). */
  pre_rollback_revision: number;
  unarchived: boolean;
  /** True when the "rollback" archived a dream-CREATED memory (no prior state to restore). */
  archived_creation?: boolean;
}

/**
 * Rollback API (plan §1.3): restore a memory_revisions snapshot over the live
 * row — content, embedding, tags, confidence, observation_count. The store's
 * restoreRevision snapshots the current state first, so rollback is itself
 * reversible. If the live row was archived (the D1.3 apply action), it is
 * unarchived; the vector index is re-synced from the restored embedding.
 * MUST run inside the consolidation lock. Returns null if the revision (or
 * memory) does not exist.
 */
export async function rollbackMemory(
  deps: ApplyDeps,
  memoryId: number,
  revision?: number,
): Promise<RollbackResult | null> {
  const revisions = await deps.dreamStore.listRevisions(memoryId);
  if (revisions.length === 0) {
    // No prior state to restore. A memory a dream CREATED (e.g. a conditional
    // branch encoding) has no revision to roll back to — it is undone instead
    // by archiving the creation (B5). Non-dream memories still return null (404).
    return await rollbackDreamCreation(deps, memoryId);
  }
  const maxRevision = revisions[0].revision; // listRevisions orders revision DESC
  const target = revision ?? maxRevision;
  const rev = revisions.find(r => r.revision === target);
  if (!rev) return null;

  const restored = await deps.dreamStore.restoreRevision(memoryId, target);
  if (!restored) return null;

  const mem = await deps.memoryStore.get(memoryId);
  let unarchived = false;
  if (mem?.is_archived) {
    unarchived = await deps.memoryStore.unarchive(memoryId);
  }

  // Phase 2 rescue semantics (operator ruling 2026-08-18): a rollback is the
  // strongest access signal — refresh the decay clock so the next promotion
  // pass cannot immediately re-archive what the operator just restored.
  // (restoreRevision restored the snapshotted clock, which for a decay
  // archive is by definition ancient.)
  await deps.dreamStore.reinforceMemory(memoryId);

  // Vector index sync: the restored embedding came back with the row (stored,
  // not recomputed — content and vector stay consistent by construction).
  try {
    if (mem?.embedding) {
      const buf = mem.embedding as Buffer;
      await deps.vectorIndex.add(memoryId, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    } else {
      await deps.vectorIndex.remove(memoryId);
    }
  } catch (err) {
    logger.warn(`Rollback: vector index sync for memory ${memoryId} failed:`, err);
  }

  // Audit the reversal under the dream that created the snapshot, when known.
  // restoreRevision snapshotted the pre-rollback state as revision maxRevision+1.
  if (rev.created_by_dream_id !== null) {
    await deps.dreamStore.appendAudit({
      dream_id: rev.created_by_dream_id,
      memory_id: memoryId,
      revision_id: rev.id,
      change_class: 'rollback',
      action: 'restore_revision',
      applied_automatically: false,
      before_ref: `revision:${maxRevision + 1}`,
      after_ref: `revision:${target}`,
    }).catch(err => logger.warn(`Rollback audit for memory ${memoryId} failed:`, err));
  }

  return {
    memory_id: memoryId,
    restored_revision: target,
    pre_rollback_revision: maxRevision + 1,
    unarchived,
  };
}

/**
 * Undo a dream-CREATED memory (B5). Creations have no prior state to restore, so
 * "rollback" archives the memory (audited under the dream that created it). Only
 * dream-consolidation memories carrying `encoded_by_dream` qualify — any other
 * memory with no revisions genuinely has nothing to undo, so returns null (404).
 */
async function rollbackDreamCreation(deps: ApplyDeps, memoryId: number): Promise<RollbackResult | null> {
  // peek — this path ARCHIVES the row (or 404s); reinforcing it would be
  // backwards, and the 404 path must not touch the access log at all.
  const mem = await deps.memoryStore.peek(memoryId);
  if (!mem || mem.is_archived) return null;

  let encodedByDream: number | null = null;
  try {
    const meta = JSON.parse(mem.metadata || '{}');
    if (typeof meta.encoded_by_dream === 'number') encodedByDream = meta.encoded_by_dream;
  } catch {
    // unparseable metadata → not a recognizable dream creation
  }
  if (mem.source !== 'dream-consolidation' || encodedByDream === null) return null;

  await deps.memoryStore.archive(memoryId);
  try {
    await deps.vectorIndex.remove(memoryId);
  } catch {
    // search filters archived ids regardless
  }
  await deps.dreamStore.appendAudit({
    dream_id: encodedByDream,
    memory_id: memoryId,
    revision_id: null,
    change_class: 'rollback',
    action: 'archive_creation',
    applied_automatically: false,
    before_ref: `created:${memoryId}`,
    after_ref: 'archived',
  }).catch(err => logger.warn(`Rollback (archive creation) audit for memory ${memoryId} failed:`, err));

  return {
    memory_id: memoryId,
    restored_revision: 0,
    pre_rollback_revision: 0,
    unarchived: false,
    archived_creation: true,
  };
}
