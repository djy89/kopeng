/**
 * Phase 3 round-2 fix CO5+S1a — ONE definition of "held".
 *
 * A scope is HELD (its observations recorded but never minted from, and exempt
 * from the retention purge) iff BOTH:
 *   1. it is ephemeral-SHAPED (`ephemeralReason` from src/scopes/drift.ts — the
 *      shared predicate, imported, never re-derived), AND
 *   2. the operator's alias table does NOT map it (canonicalize(raw) === raw).
 *
 * The second clause is what makes spec §7's release semantics true in code:
 * a RULING (an alias entry mapping the ephemeral scope to its real target)
 * releases the scope — new observations resolve through the normal alias-first
 * path to the target scope instead of being held forever, and the purge stops
 * exempting its aged rows, returning them to the normal retention clock. Both
 * consumers (the discovery engine's held short-circuit and maintenance §1's
 * exemption computation) key on THIS predicate; shape-only checks at either
 * site would re-open the held-forever / exempt-forever divergence.
 *
 * Fail direction: a canonicalize failure counts as HELD — holding is the safe
 * side (nothing minted, nothing purged); the next pass retries. Absent
 * canonicalize ⇒ shape-only behavior (back-compat for unit stubs and installs
 * without an alias service).
 */

import { ephemeralReason } from '../scopes/drift.js';

export type HoldPredicate = (raw: string) => Promise<boolean>;

export function buildHoldPredicate(
  canonicalize?: (scope: string) => Promise<string>,
): HoldPredicate {
  return async (raw: string): Promise<boolean> => {
    if (ephemeralReason(raw) === null) return false;
    if (!canonicalize) return true;
    try {
      return (await canonicalize(raw)) === raw;
    } catch {
      return true; // fail toward holding — never mint or purge on a broken table read
    }
  };
}
