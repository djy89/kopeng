/**
 * Carrier-dream lifecycle (team-review #22 A7): ONE definition of the
 * create → record → finalize shape both audited-archive batch paths use
 * (promotion decay archival in `promotion/auto-archive.ts`, discovery
 * maintenance in `discovery/maintenance.ts`). The two previously carried
 * hand-rolled copies whose counter semantics had already diverged — the
 * shared-concept-copy failure mode the Phase 1 meta-finding warns about.
 *
 * Counter semantics (the single definition):
 *  - `memories_examined` = entries RECORDED (attempted), applied or not, PLUS
 *    audit-only records (T76: rows whose per-row record lives in
 *    dream_audit_log and has no diff-entry spelling);
 *  - `changes_auto_applied` = entries that actually applied;
 *  - `acceptance_status` = 'auto_applied' iff anything applied, else 'empty'
 *    (a carrier is never operator-pending — its writers resolve every entry).
 *
 * Lazy: `open()` creates the dream row on first use, so a run that finds
 * nothing to do never writes a carrier.
 */

import type { IDreamStore } from '../database/interfaces.js';
import type { Dream, DreamDiffEntry, DreamTrigger } from '../types/types.js';

export class CarrierDream {
  private dream: Dream | null = null;
  readonly entries: DreamDiffEntry[] = [];
  private applied = 0;
  private auditOnly = 0;

  constructor(
    private dreamStore: IDreamStore,
    private reason: string,
    private opts: { trigger_source?: DreamTrigger; scope?: string | null } = {},
  ) {}

  /** Create the carrier row on first call; idempotent thereafter. */
  async open(): Promise<Dream> {
    if (!this.dream) {
      this.dream = await this.dreamStore.createDream({
        mode: 'whole_corpus',
        trigger_source: this.opts.trigger_source ?? 'scheduled',
        reason: this.reason,
        // T76: the carrier's scope, when its writer works one scope (the
        // archive-ephemeral action does). Omitted by the corpus-wide callers,
        // where the row genuinely has no single scope.
        scope: this.opts.scope ?? null,
        // T-H3: the WRITE site is part of the contract — a carrier created
        // through the helper is excluded from the scheduler/review queries by
        // COLUMN, never by reason-string matching.
        is_carrier: true,
      });
    }
    return this.dream;
  }

  /** The carrier's dream id, when one has been opened (the rollback handle). */
  get id(): number | undefined {
    return this.dream?.id;
  }

  get appliedCount(): number {
    return this.applied;
  }

  /** Record one attempted entry; `applied` stamps its resolution. */
  record(entry: DreamDiffEntry, applied: boolean, at: Date = new Date()): void {
    if (applied) {
      entry.resolution = 'auto_applied';
      entry.resolved_at = at.toISOString();
      this.applied++;
    }
    this.entries.push(entry);
  }

  /**
   * T76: count-only record for operations whose per-row record lives in
   * dream_audit_log (archive_ephemeral is audit-only — tsc refuses it as a
   * diff-entry class, deliberately). Keeps finalize()'s counters truthful
   * while output_diff stays empty; dream-history falls back to the row
   * counters for exactly this case.
   */
  recordAuditOnly(applied: boolean): void {
    if (applied) this.applied++;
    this.auditOnly++;
  }

  /** Persist the diff + completion. No-op if the carrier was never opened. */
  async finalize(at: Date = new Date()): Promise<void> {
    if (!this.dream) return;
    await this.dreamStore.setDreamDiff(this.dream.id, { entries: this.entries });
    await this.dreamStore.updateDream(this.dream.id, {
      status: 'completed',
      completed_at: at.toISOString(),
      acceptance_status: this.applied > 0 ? 'auto_applied' : 'empty',
      memories_examined: this.entries.length + this.auditOnly,
      changes_auto_applied: this.applied,
      changes_queued: 0,
    });
  }
}
