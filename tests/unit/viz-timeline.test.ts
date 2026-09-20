import { describe, it, expect } from 'vitest';
import { buildTimeline, presentAt, visibleAt, diffVisible, lifecycleOf, parseDbTime } from '../../viz/timeline.mjs';

const mem = (id: number, created_at: string, is_archived = false) => ({ id, created_at, is_archived });
const ev = (id: number, memory_id: number | null, change_class: string, created_at: string,
            opts: { action?: string; raw_after_ref?: string | null; group_key?: string | null } = {}) =>
  ({ id, memory_id, change_class, created_at, dream_id: 1, relation: null,
     action: opts.action ?? null, raw_after_ref: opts.raw_after_ref ?? null, group_key: opts.group_key ?? null });

describe('parseDbTime', () => {
  it('parses SQLite datetime as UTC', () => {
    expect(parseDbTime('2026-09-15 03:00:00')).toBe(Date.parse('2026-09-15T03:00:00Z'));
  });
});

describe('lifecycleOf', () => {
  it.each([
    ['decay archive',        'decay',          null,                  'archived',                        'absent'],
    ['exact_dup archive',    'exact_dup',      'archive',             'archived;kept=7',                 'absent'],
    ['rollback archives a dream creation', 'rollback', 'archive_creation', 'archived',                   'absent'],
    ['rollback restores',    'rollback',       'restore_revision',    'revision:3',                      'present'],
    ['promote_global archives the local dup', 'promote_global', 'archive', 'promoted_to=6',              'absent'],
    ['promote_global rescopes the survivor (marker)', 'promote_global', 'rescope', 'scope=global;from=project:acme-web', null],
    ['promote compensation', 'promote_global', 'compensate_unarchive','unarchived;group_declined:dup',   'present'],
    ['supersede old row is a MARKER (nothing archived)', 'supersede', 'deprecate', 'superseded_by=12',   null],
    ['supersede new row is a MARKER', 'supersede', 'mark_current',    'supersedes=8',                    null],
    ['reinforce',            'reinforce',      null,                  null,                              null],
    ['crystallize',          'crystallize',    'confidence_promote',  'crystallized;confidence=0.97',    null],
  ])('%s', (_name, change_class, action, raw_after_ref, expected) => {
    expect(lifecycleOf({ change_class, action, raw_after_ref } as never)).toBe(expected);
  });
});

describe('buildTimeline', () => {
  it('handles archive → rollback-restore → re-archive (membership toggles twice)', () => {
    const tl = buildTimeline(
      [mem(1, '2026-01-01 00:00:00', true)],
      [ev(10, 1, 'decay',    '2026-02-01 00:00:00', { raw_after_ref: 'archived' }),
       ev(11, 1, 'rollback', '2026-03-01 00:00:00', { action: 'restore_revision', raw_after_ref: 'revision:1' }),
       ev(12, 1, 'decay',    '2026-04-01 00:00:00', { raw_after_ref: 'archived' })],
    );
    const r = tl.records.get(1)!;
    expect(presentAt(r, parseDbTime('2026-01-15 00:00:00'))).toBe(true);
    expect(presentAt(r, parseDbTime('2026-02-15 00:00:00'))).toBe(false);
    expect(presentAt(r, parseDbTime('2026-03-15 00:00:00'))).toBe(true);
    expect(presentAt(r, parseDbTime('2026-05-01 00:00:00'))).toBe(false);
    expect(tl.unknownIds).toEqual([]); // recorded end-state matches is_archived
  });

  it('supersede rows do NOT remove either memory', () => {
    const tl = buildTimeline(
      [mem(8, '2026-01-01 00:00:00'), mem(12, '2026-02-01 00:00:00')],
      [ev(10, 8,  'supersede', '2026-03-01 00:00:00', { action: 'deprecate',    raw_after_ref: 'superseded_by=12' }),
       ev(11, 12, 'supersede', '2026-03-01 00:00:00', { action: 'mark_current', raw_after_ref: 'supersedes=8' })],
    );
    const t = parseDbTime('2026-04-01 00:00:00');
    expect([...visibleAt(tl, t)].sort((a, b) => a - b)).toEqual([8, 12]); // both still present
    expect(tl.records.get(8)!.markers).toHaveLength(1);    // filed as marker
  });

  it('orders same-second events by audit id', () => {
    const T = '2026-02-01 00:00:00';
    const tl = buildTimeline(
      [mem(1, '2026-01-01 00:00:00', false)],
      [ev(11, 1, 'rollback', T, { action: 'restore_revision', raw_after_ref: 'revision:1' }), // LATER id wins
       ev(10, 1, 'decay',    T, { raw_after_ref: 'archived' })],
    );
    expect(presentAt(tl.records.get(1)!, parseDbTime('2026-02-02 00:00:00'))).toBe(true);
  });

  it('flags unknown when recorded history disagrees with current is_archived', () => {
    const tl = buildTimeline(
      [mem(1, '2026-01-01 00:00:00', true)], // archived NOW, but no recorded archive event
      [],
    );
    expect(tl.unknownIds).toEqual([1]);
    expect(tl.records.get(1)!.state).toBe('unknown');
  });

  it('treats a memory as absent before its birth', () => {
    const tl = buildTimeline([mem(1, '2026-06-01 00:00:00')], []);
    expect(presentAt(tl.records.get(1)!, parseDbTime('2026-05-01 00:00:00'))).toBe(false);
  });
});

describe('visibleAt / diffVisible', () => {
  it('reverse seek equals forward seek at the same t', () => {
    const tl = buildTimeline(
      [mem(1, '2026-01-01 00:00:00'), mem(2, '2026-03-01 00:00:00', true)],
      [ev(10, 2, 'decay', '2026-04-01 00:00:00', { raw_after_ref: 'archived' })],
    );
    const t = parseDbTime('2026-03-15 00:00:00');
    const forward = visibleAt(tl, t);
    visibleAt(tl, parseDbTime('2026-06-01 00:00:00')); // seek past, then back
    expect(visibleAt(tl, t)).toEqual(forward);
    expect([...forward].sort()).toEqual([1, 2]);
  });

  it('diffVisible computes enter/exit', () => {
    expect(diffVisible(new Set([1, 2]), new Set([2, 3]))).toEqual({ enter: [3], exit: [1] });
  });
});
