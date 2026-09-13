/**
 * Ephemeral-scope shape detection — moved here from drift.ts (team review,
 * the `slugifyScope` precedent): this predicate is a definition of scope
 * lifecycle, not a report detail. Its consumers span the WRITE path, so
 * editing the rule list changes system behavior, not just a panel:
 *
 *  - `decideMint` (src/scopes/minting.ts) — ephemeral scopes never mint;
 *  - `buildHoldPredicate` (src/discovery/hold.ts) — unruled matches HOLD
 *    their observations indefinitely under R-B (no auto-expiry);
 *  - the discovery engine's held short-circuit and maintenance §1's purge
 *    exemption — matched scopes' observations are never retention-purged;
 *  - drift clustering / the ops ephemeral list (the report consumers);
 *  - (once T76 ships) the archive-ephemeral route's eligibility — the one
 *    DESTRUCTIVE consumer.
 *
 * A false positive here is therefore not cosmetic, which is why the T77
 * suffix rules are CALENDAR-validated rather than digit-counted.
 *
 * drift.ts re-exports `ephemeralReason`, so existing import sites are
 * unaffected. Pure — no I/O, no clock.
 */

import { slugifyScope } from './resolver.js';

// Order matters — first match wins.
const EPHEMERAL_RULES: { re: RegExp; reason: string }[] = [
  { re: /^project:wf_[0-9a-f]/i, reason: 'workflow-run scope' },
  { re: /^project:agent-[0-9a-f]{8,}/i, reason: 'subagent scope' },
  // The two START-anchored date rules deliberately keep their original loose
  // digit-count shape: tightening them would UN-hold scopes held since they
  // shipped, which is a separate operator decision, and date-FIRST names are
  // rarely id-shaped. They also allow a trailing remainder (date-first is
  // unambiguous), where the suffix rules below anchor hard at end-of-string
  // (a date mid-name is NOT claimed — fewer false positives).
  { re: /^project:\d{8}([-_].*)?$/, reason: 'date-stamped sprint/dir scope' },
  { re: /^project:\d{4}-\d{2}(-\d{2})?([ _-].*)?$/, reason: 'date-stamped sprint/dir scope' },
  // T77 + team review H1: trailing dates are CALENDAR-validated (month 01-12,
  // day 01-31, year 19xx/20xx on the 8-digit form) — digit-count alone also
  // matched ticket/invoice/order ids (`project:ticket-10045512`). A `[ _-]`
  // separator is required so names merely ending in digits never match, and a
  // trailing bare YEAR (`project:budget-2027`) is deliberately not a date —
  // that is a real project-name shape.
  { re: /^project:.+[ _-]\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/, reason: 'date-stamped sprint/dir scope' },
  { re: /^project:.+[ _-](19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/, reason: 'date-stamped sprint/dir scope' },
  // T77: `NNN+`-style dirs (a dir literally named `300+`). The 1-3 digit
  // bound matches the pre-T77 bare-number rule's reach — a 4-digit bare
  // number reads as a year, a real project-name shape.
  { re: /^project:\d{1,3}\+?$/, reason: 'bare-number scope' },
  // T77: sprint-numbered dirs. Bounded at 4 digits — sprint counters are
  // small; 5+ digits reads as an id, not a sprint.
  { re: /^project:sprint[ _-]?\d{1,4}$/i, reason: 'sprint-numbered scope' },
];

function matchRules(scope: string): string | null {
  for (const { re, reason } of EPHEMERAL_RULES) {
    if (re.test(scope)) return reason;
  }
  return null;
}

/**
 * Returns the ephemeral reason for a scope, or null.
 *
 * Separator-robust via the slug fold (team review): real dir names also use
 * `.`, `(`, `)` — the fold normalizes every separator run to `-`, so a dated
 * dir is ephemeral regardless of which separator spelling minted it. The slug
 * is a DETECTION input here, exactly like drift clustering — it never feeds
 * resolution (CLAUDE.md: the fold is many-to-one and must not), and the
 * caller's scope string is never rewritten by this function.
 */
export function ephemeralReason(scope: string): string | null {
  const direct = matchRules(scope);
  if (direct !== null) return direct;
  const slug = slugifyScope(scope);
  if (slug !== null && slug !== scope) return matchRules(slug);
  return null;
}
