/**
 * Dream fire predicate (D0.5) — the pure, side-effect-free decision of whether a
 * dream pass should run *right now*. The scheduler owns the clock, the stores, and
 * the timer; this function owns only the logic, so it is exhaustively unit-testable
 * (including a DST boundary) without a server, a DB, or a fake timer.
 *
 * A dream fires only when ALL hold:
 *   1. it has NOT already run today (in the operator's local day), and
 *   2. the operator is idle (no request for at least `idleMs`), and
 *   3. the local clock is inside the quiet-hours window (the human is away).
 *
 * Local day / hour are derived from the injected epoch `now` via the operator
 * timezone using Intl (full ICU in Node) — so DST shifts and "what day is it
 * locally" are correct without a date library and without `Date.now()` here.
 */

export interface FirePredicateInput {
  /** Epoch ms, injected at the edge (never read from the clock in here). */
  now: number;
  /** Epoch ms of the last operator request, or null if none seen this process. */
  lastActivityAt: number | null;
  /** Local-day string ('YYYY-MM-DD' in `tz`) of the most recent dream, or null. */
  lastRunDayLocal: string | null;
  /** IANA timezone for "local day" + quiet-hours evaluation. */
  tz: string;
  /** Required idle span before dreaming. */
  idleMs: number;
  /** Quiet-window start hour [0..23], or null for "no window restriction". */
  quietStartHour: number | null;
  /** Quiet-window end hour [0..23] (exclusive), or null for "no window restriction". */
  quietEndHour: number | null;
}

export type FireReason =
  | 'fire'
  | 'already_ran_today'
  | 'idle_not_met'
  | 'outside_window';

export interface FireDecision {
  fire: boolean;
  reason: FireReason;
  /** The local day computed for `now` — handy for the caller to stamp on the run. */
  localDay: string;
}

interface LocalParts {
  day: string; // YYYY-MM-DD
  hour: number; // 0..23
}

/** Extract local day + hour for an epoch in a timezone. DST-correct via ICU. */
export function localPartsInTz(epochMs: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0; // some ICU builds emit '24' at midnight
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

/** Is `hour` inside [start, end)? Handles windows that wrap midnight (e.g. 23→6). */
export function inQuietWindow(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null) return true; // no restriction configured
  if (start === end) return true; // degenerate "all day"
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // wraps past midnight
}

export function shouldDreamFire(input: FirePredicateInput): FireDecision {
  const { day: localDay, hour } = localPartsInTz(input.now, input.tz);

  // 1. Already ran today — never dream twice in one local day.
  if (input.lastRunDayLocal !== null && input.lastRunDayLocal === localDay) {
    return { fire: false, reason: 'already_ran_today', localDay };
  }

  // 2. Quiet-hours window — only dream while the operator is away.
  if (!inQuietWindow(hour, input.quietStartHour, input.quietEndHour)) {
    return { fire: false, reason: 'outside_window', localDay };
  }

  // 3. Idle gate — a recent request means the operator is active; back off.
  //    A null lastActivityAt means no activity observed → treated as idle.
  if (input.lastActivityAt !== null && input.now - input.lastActivityAt < input.idleMs) {
    return { fire: false, reason: 'idle_not_met', localDay };
  }

  return { fire: true, reason: 'fire', localDay };
}
