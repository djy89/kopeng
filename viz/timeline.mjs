// T43 GrowingGraph reducer — pure functions, zero DOM. Consumed by viz/app.js,
// tested by tests/unit/viz-timeline.test.ts. Semantics: RECORDED membership
// (spec: docs/superpowers/specs/2026-09-15-viz-phase3-growinggraph-design.md).
// Unaudited operator mutations are invisible here by design; divergence between
// recorded end-state and current is_archived surfaces as state 'unknown'.

/** SQLite datetime('now') has no timezone marker and Date.parse would read it
 *  as local time — normalize to ISO UTC before parsing. */
export function parseDbTime(s) {
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}

/** Lifecycle from (change_class, action, after_ref) — NEVER from class alone:
 *  supersede archives nothing (both rows kept, apply.ts:445); rollback both
 *  archives (archive_creation) and restores (restore_revision); promote_global
 *  both archives and compensation-restores. The after_ref END STATE is the
 *  truthful signal, with one action-based case for restore_revision. */
export function lifecycleOf(e) {
  const ref = e.raw_after_ref ?? '';
  if (ref === 'archived' || ref.startsWith('archived;')) return 'absent';
  // promote_global's archive rows say 'promoted_to=<survivor>', not 'archived…'
  // (maintenance.ts:405) — the shared audited-archive helper's action is the signal.
  if (e.action === 'archive') return 'absent';
  if (ref.startsWith('unarchived')) return 'present';
  if (e.change_class === 'rollback' && e.action === 'restore_revision') return 'present';
  return null; // marker
}

export function buildTimeline(memories, events) {
  const records = new Map();
  for (const m of memories) {
    records.set(m.id, {
      id: m.id,
      born: parseDbTime(m.created_at),
      transitions: [],
      markers: [],
      state: 'recorded',
      _currentArchived: !!m.is_archived,
    });
  }

  // (t, id) order — id breaks SQLite's second-resolution timestamp ties. Sort
  // on the parsed numeric t, not the raw created_at STRING: parseDbTime accepts
  // both space- and T-form timestamps, and a mixed corpus sorts all space-form
  // rows first under a string comparison ('0x20' < 'T'), silently misordering
  // globalEvents and breaking every binary search over it.
  const withT = events.map(e => ({ ...e, t: parseDbTime(e.created_at) }));
  const globalEvents = withT.sort((a, b) => a.t === b.t ? a.id - b.id : a.t - b.t);

  for (const e of globalEvents) {
    const t = e.t;
    if (e.memory_id == null) continue;
    const rec = records.get(e.memory_id);
    if (!rec) continue;
    const life = lifecycleOf(e);
    if (life === 'absent') {
      rec.transitions.push({ t, present: false, eventId: e.id });
    } else if (life === 'present') {
      rec.transitions.push({ t, present: true, eventId: e.id });
    } else {
      rec.markers.push({ t, change_class: e.change_class, eventId: e.id, group_key: e.group_key });
    }
  }

  const unknownIds = [];
  for (const rec of records.values()) {
    const recordedPresent = rec.transitions.length
      ? rec.transitions[rec.transitions.length - 1].present
      : true;
    if (recordedPresent !== !rec._currentArchived) {
      rec.state = 'unknown';
      unknownIds.push(rec.id);
    }
  }
  return { records, globalEvents, unknownIds };
}

export function presentAt(rec, t) {
  if (t < rec.born) return false;
  let present = true;
  for (const tr of rec.transitions) {
    if (tr.t <= t) present = tr.present;
    else break;
  }
  return present;
}

export function visibleAt(timeline, t) {
  const out = new Set();
  for (const rec of timeline.records.values()) {
    if (presentAt(rec, t)) out.add(rec.id);
  }
  return out;
}

export function diffVisible(prev, next) {
  const enter = [], exit = [];
  for (const id of next) if (!prev.has(id)) enter.push(id);
  for (const id of prev) if (!next.has(id)) exit.push(id);
  return { enter, exit };
}
