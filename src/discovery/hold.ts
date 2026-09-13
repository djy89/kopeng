/**
 * Round-2 fix CO5+S1a, extended by T76 §5.3/§5.4 — ONE definition of "held",
 * with a `mark_distinct` ruling as a second release path alongside the alias
 * table.
 *
 * A scope is HELD (its observations recorded but never minted from, and exempt
 * from the retention purge) iff:
 *   1. it is ephemeral-SHAPED (`ephemeralReason` from src/scopes/drift.ts — the
 *      shared predicate, imported, never re-derived), AND
 *   2. it has NOT been ruled distinct (T76: `ScopeRegistryService.isRuledDistinct`
 *      — a `mark_distinct` operator ruling releases the scope AS ITSELF, no
 *      alias entry required), AND
 *   3. it is NOT alias-mapped (canonicalize(raw) === raw).
 *
 * Clauses 2 and 3 are the two release paths spec §7/§5.3 promises: an alias
 * RULING (mapping the ephemeral scope to a different real target) releases it
 * to that target; a `mark_distinct` RULING releases it as itself, unrenamed.
 * Either way, new observations resolve through the normal path instead of
 * being held forever, and the purge stops exempting the scope's aged rows,
 * returning them to the normal retention clock.
 *
 * `holdVerdict` is THE single verdict function — it THROWS on any input-read
 * failure, leaving the fail direction to the caller:
 *   - `buildHoldPredicate` (LOOSE, fail-toward-HOLDING): the discovery
 *     scheduler's held short-circuit and maintenance §1's purge exemption. A
 *     broken registry/alias read must never silently mint or purge — holding
 *     is always the safe answer for those two consumers, and the next pass
 *     retries.
 *   - `buildStrictHoldPredicate` (STRICT, fail-CLOSED — T76 §5.4/T-H4): the
 *     archive-ephemeral route's eligibility check (Task 6). There "held" means
 *     "do nothing", so a swallowed read failure there would silently AUTHORIZE
 *     a bulk archive instead of refusing it — the route must see the failure
 *     and refuse (503) rather than get a false answer.
 *
 * Absent `canonicalize`/`isRuledDistinct` ⇒ shape-only behavior (back-compat
 * for unit stubs and installs without the relevant service wired).
 */

import { ephemeralReason } from '../scopes/drift.js';

export type HoldPredicate = (raw: string) => Promise<boolean>;

export interface HoldInputs {
  canonicalize?: (scope: string) => Promise<string>;
  /** T76 §5.3: a mark_distinct ruling releases the scope AS ITSELF. */
  isRuledDistinct?: (scope: string) => Promise<boolean>;
}

/**
 * THE verdict: held iff ephemeral-shaped AND not ruled-distinct AND not
 * alias-mapped. THROWS on any input-read failure — the caller owns the fail
 * direction (loose: hold; strict/archive: refuse). One spelling, two wrappers.
 */
export async function holdVerdict(raw: string, inputs: HoldInputs): Promise<boolean> {
  if (ephemeralReason(raw) === null) return false;
  if (inputs.isRuledDistinct && await inputs.isRuledDistinct(raw)) return false;
  if (!inputs.canonicalize) return true;
  return (await inputs.canonicalize(raw)) === raw;
}

export function buildHoldPredicate(
  canonicalize?: (scope: string) => Promise<string>,
  isRuledDistinct?: (scope: string) => Promise<boolean>,
): HoldPredicate {
  return async (raw: string): Promise<boolean> => {
    try {
      return await holdVerdict(raw, { canonicalize, isRuledDistinct });
    } catch {
      return true; // fail toward holding — never mint or purge on a broken read
    }
  };
}

/**
 * STRICT fail-CLOSED variant (T76 §5.4 / T-H4): the archive-ephemeral route's
 * eligibility. "Held" is safe when it means nothing happens; here a swallowed
 * read failure would AUTHORIZE a bulk archive — so read failures propagate and
 * the route refuses (503) instead of archiving.
 */
export function buildStrictHoldPredicate(inputs: HoldInputs): HoldPredicate {
  return (raw: string) => holdVerdict(raw, inputs);
}
