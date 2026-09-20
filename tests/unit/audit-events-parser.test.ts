import { describe, it, expect } from 'vitest';
import { toUtcIso, parseAfterRef, groupKeyFor, toStructuredEvent } from '../../src/api/audit-events.js';

describe('toUtcIso', () => {
  it('normalizes SQLite datetime to ISO UTC', () => {
    expect(toUtcIso('2026-09-15 03:00:00')).toBe('2026-09-15T03:00:00Z');
  });
  it('leaves ISO strings untouched', () => {
    expect(toUtcIso('2026-09-15T03:00:00.000Z')).toBe('2026-09-15T03:00:00.000Z');
  });
});

describe('parseAfterRef', () => {
  it.each([
    ['archived;kept=7',        { kind: 'kept', target_id: 7 }],
    ['superseded_by=12',       { kind: 'superseded_by', target_id: 12 }],
    ['supersedes=8',           { kind: 'supersedes', target_id: 8 }],
    ['created:14;sources:3,9', { kind: 'encoded', target_id: 14, source_ids: [3, 9] }],
    ['encoded_in=14',          { kind: 'encoded_in', target_id: 14 }],
    ['promoted_to=6',          { kind: 'promoted_to', target_id: 6 }],
  ])('parses %s', (raw, expected) => {
    expect(parseAfterRef(raw)).toEqual(expected);
  });

  it.each([null, '', 'archived', 'crystallized;confidence=0.97', 'confidence=0.9',
           'revision:3', 'unarchived;group_declined:scope_mismatch',
           'scope=global;from=project:acme-web',
           'archived;kept=', 'kept=x', 'created:;sources:', 'utter garbage;;='])(
    'returns null for %s (never throws)', raw => {
      expect(parseAfterRef(raw as string | null)).toBeNull();
    });
});

describe('groupKeyFor — both rows of one operation share a key', () => {
  const row = (dream_id: number, change_class: string, memory_id: number | null, action: string | null = null) =>
    ({ dream_id, change_class, memory_id, action }) as never;

  it('supersede: old row (superseded_by=new) and new row (supersedes=old) match', () => {
    const oldRow = groupKeyFor(row(5, 'supersede', 8),  { kind: 'superseded_by', target_id: 12 });
    const newRow = groupKeyFor(row(5, 'supersede', 12), { kind: 'supersedes', target_id: 8 });
    expect(oldRow).toBe('5:supersede:new=12');
    expect(newRow).toBe('5:supersede:new=12');
  });

  it('conditional: encoded row and encoded_in source rows match', () => {
    const enc = groupKeyFor(row(5, 'conditional', 14), { kind: 'encoded', target_id: 14, source_ids: [3, 9] });
    const src = groupKeyFor(row(5, 'conditional', 3),  { kind: 'encoded_in', target_id: 14 });
    expect(enc).toBe('5:conditional:encoded=14');
    expect(src).toBe('5:conditional:encoded=14');
  });

  it('promote_global: archive rows AND the survivor rescope row all share the target key', () => {
    // One promotion emits promoted_to= archive rows for the losers (maintenance.ts:405)
    // PLUS one action:'rescope' row on the survivor with after_ref 'scope=global;from=…'
    // (maintenance.ts:474-483) — no id in the survivor's ref; its memory_id IS the target.
    const a = groupKeyFor(row(5, 'promote_global', 3, 'archive'), { kind: 'promoted_to', target_id: 6 });
    const b = groupKeyFor(row(5, 'promote_global', 4, 'archive'), { kind: 'promoted_to', target_id: 6 });
    const survivor = groupKeyFor(row(5, 'promote_global', 6, 'rescope'), null);
    expect(a).toBe('5:promote_global:target=6');
    expect(b).toBe('5:promote_global:target=6');
    expect(survivor).toBe('5:promote_global:target=6');
  });

  it('two exact_dup operations in one dream with different kept ids stay separate', () => {
    const a = groupKeyFor(row(5, 'exact_dup', 1), { kind: 'kept', target_id: 7 });
    const b = groupKeyFor(row(5, 'exact_dup', 2), { kind: 'kept', target_id: 9 });
    expect(a).not.toBeNull();
    expect(a).not.toEqual(b);
  });

  it('same kept id in different dreams does NOT share a key', () => {
    expect(groupKeyFor(row(5, 'merge', 1), { kind: 'kept', target_id: 7 }))
      .not.toEqual(groupKeyFor(row(6, 'merge', 1), { kind: 'kept', target_id: 7 }));
  });

  it('null relation ⇒ null key (ungrouped, never invented)', () => {
    expect(groupKeyFor(row(5, 'decay', 1), null)).toBeNull();
  });
});

describe('toStructuredEvent', () => {
  it('carries raw_after_ref verbatim, normalizes created_at, never drops a row', () => {
    const ev = toStructuredEvent({
      id: 3, dream_id: 5, memory_id: 9, revision_id: null,
      change_class: 'exact_dup', action: 'archive', applied_automatically: true,
      before_ref: null, after_ref: 'archived;kept=7', created_at: '2026-09-15 03:00:00',
    } as never);
    expect(ev.relation).toEqual({ kind: 'kept', target_id: 7 });
    expect(ev.group_key).toBe('5:exact_dup:kept=7');
    expect(ev.raw_after_ref).toBe('archived;kept=7');
    expect(ev.created_at).toBe('2026-09-15T03:00:00Z');
  });
});
