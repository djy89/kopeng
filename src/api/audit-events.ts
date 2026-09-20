import type { DreamAuditEntry } from '../types/types.js';

export interface AuditRelation {
  kind: 'kept' | 'superseded_by' | 'supersedes' | 'encoded' | 'encoded_in' | 'promoted_to';
  target_id: number;
  source_ids?: number[];
}
export interface StructuredAuditEvent {
  id: number; dream_id: number; memory_id: number | null; revision_id: number | null;
  change_class: string; action: string | null; applied_automatically: boolean;
  created_at: string;          // ALWAYS normalized to ISO-8601 UTC (see toUtcIso)
  relation: AuditRelation | null; group_key: string | null;
  raw_after_ref: string | null;
}

/** SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' (UTC, no marker);
 *  Date.parse on that shape is implementation-defined. Normalize before any parse. */
export function toUtcIso(s: string): string {
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}

export function parseAfterRef(afterRef: string | null): AuditRelation | null {
  if (!afterRef) return null;
  let m = /^archived;kept=(\d+)$/.exec(afterRef);
  if (m) return { kind: 'kept', target_id: Number(m[1]) };
  m = /^superseded_by=(\d+)$/.exec(afterRef);
  if (m) return { kind: 'superseded_by', target_id: Number(m[1]) };
  m = /^supersedes=(\d+)$/.exec(afterRef);
  if (m) return { kind: 'supersedes', target_id: Number(m[1]) };
  m = /^created:(\d+);sources:(\d+(?:,\d+)*)$/.exec(afterRef);
  if (m) return { kind: 'encoded', target_id: Number(m[1]), source_ids: m[2].split(',').map(Number) };
  m = /^encoded_in=(\d+)$/.exec(afterRef);
  if (m) return { kind: 'encoded_in', target_id: Number(m[1]) };
  m = /^promoted_to=(\d+)$/.exec(afterRef);
  if (m) return { kind: 'promoted_to', target_id: Number(m[1]) };
  return null; // unknown/legacy/malformed ⇒ ungrouped, raw_after_ref preserved
}

export function groupKeyFor(
  row: Pick<DreamAuditEntry, 'dream_id' | 'change_class' | 'memory_id' | 'action'>,
  rel: AuditRelation | null,
): string | null {
  // NO early `if (!rel) return null` — promote_global's survivor row groups
  // WITHOUT a relation (its key comes from action + memory_id).
  switch (row.change_class) {
    case 'exact_dup':
    case 'merge':
      return rel?.kind === 'kept' ? `${row.dream_id}:${row.change_class}:kept=${rel.target_id}` : null;
    case 'supersede':
      // Normalize both directions to the NEW memory's id:
      // old row: superseded_by=<new> ⇒ new = target; new row: supersedes=<old> ⇒ new = memory_id.
      if (rel?.kind === 'superseded_by') return `${row.dream_id}:supersede:new=${rel.target_id}`;
      if (rel?.kind === 'supersedes' && row.memory_id != null) return `${row.dream_id}:supersede:new=${row.memory_id}`;
      return null;
    case 'conditional':
      if (rel?.kind === 'encoded') return `${row.dream_id}:conditional:encoded=${rel.target_id}`;
      if (rel?.kind === 'encoded_in') return `${row.dream_id}:conditional:encoded=${rel.target_id}`;
      return null;
    case 'promote_global':
      // Archive rows carry promoted_to=<survivor> (maintenance.ts:405); the
      // survivor's own rescope row has no id in its ref ('scope=global;from=…',
      // maintenance.ts:482) — its memory_id IS the target. Compensation rows
      // ('unarchived;group_declined:…') stay ungrouped.
      if (rel?.kind === 'promoted_to') return `${row.dream_id}:promote_global:target=${rel.target_id}`;
      if (row.action === 'rescope' && row.memory_id != null) return `${row.dream_id}:promote_global:target=${row.memory_id}`;
      return null;
    default:
      return null;
  }
}

export function toStructuredEvent(row: DreamAuditEntry): StructuredAuditEvent {
  const relation = parseAfterRef(row.after_ref);
  return {
    id: row.id, dream_id: row.dream_id, memory_id: row.memory_id,
    revision_id: row.revision_id, change_class: row.change_class,
    action: row.action, applied_automatically: !!row.applied_automatically,
    created_at: toUtcIso(row.created_at), relation,
    group_key: groupKeyFor(row, relation), raw_after_ref: row.after_ref,
  };
}
