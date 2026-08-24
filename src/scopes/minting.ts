/**
 * Phase 3 scope minting — shared vocabulary (plan §Shared vocabulary) plus the
 * pure minting decision (spec §5). Every consumer (registry stores, decision
 * logic, routes) imports the row/request/decision shapes from here so there is
 * one definition. decideMint/buildMintContext are pure — no I/O, no clock, no
 * logger; the caller owns the registry read and the register write.
 */

import { GLOBAL_SCOPE, isScopeForm, slugifyScope } from './resolver.js';
import { ephemeralReason } from './drift.js';

/** Fallback routing target for malformed scopes when no primary_scope is set. */
export const UNROUTED_SCOPE = 'project:_unrouted';

export type ScopeRegistryStatus = 'provisional' | 'confirmed' | 'quarantined';

export interface ScopeRegistryRow {
  scope: string;                 // canonical storage form (PK)
  slug: string | null;           // slugifyScope(claimant_raw) — the collision key
  claimant_raw: string;          // raw string that first claimed it
  origin_cwd: string | null;     // claiming directory when known
  status: ScopeRegistryStatus;
  reserved: boolean;             // system scopes a mint can never claim
  first_seen: string;
  updated_at: string;
  ruled_at: string | null;
}

export interface RegisterRequest {
  scope: string;
  slug: string | null;
  claimant_raw: string;
  origin_cwd: string | null;
  status: ScopeRegistryStatus;
  reserved?: boolean;
}

export type MintDecision =
  | { kind: 'pass'; scope: string }                                  // known, deliberate, global, or ephemeral passthrough
  | { kind: 'resolve'; scope: string }                               // claimant_raw → canonical
  | { kind: 'mint'; scope: string; register: RegisterRequest }       // new scope, slug-adopted
  | { kind: 'quarantine'; scope: string; register: RegisterRequest } // <canonical>--q<n>
  | { kind: 'reroute'; scope: string; raw: string; reason: 'malformed' };

/** Registry snapshot indexed for the decision's three lookups. */
export interface MintContext {
  byScope: Map<string, ScopeRegistryRow>;
  bySlug: Map<string, ScopeRegistryRow[]>;      // keyed by row.slug
  byClaimant: Map<string, ScopeRegistryRow[]>;  // keyed by row.claimant_raw
  primaryScope: string | null;
}

export function buildMintContext(rows: ScopeRegistryRow[], primaryScope: string | null): MintContext {
  const byScope = new Map<string, ScopeRegistryRow>();
  const bySlug = new Map<string, ScopeRegistryRow[]>();
  const byClaimant = new Map<string, ScopeRegistryRow[]>();
  for (const row of rows) {
    byScope.set(row.scope, row);
    if (row.slug !== null) {
      const slugRows = bySlug.get(row.slug) ?? [];
      slugRows.push(row);
      bySlug.set(row.slug, slugRows);
    }
    const claimantRows = byClaimant.get(row.claimant_raw) ?? [];
    claimantRows.push(row);
    byClaimant.set(row.claimant_raw, claimantRows);
  }
  return { byScope, bySlug, byClaimant, primaryScope };
}

/**
 * Next quarantine suffix for a slug: the incumbent counts 1, so the first
 * collision is --q2.
 *
 * INVARIANT (round-2 fix A1): suffix counting is collision-free ONLY because
 * registry rows are NEVER deleted — a rename tombstones the freed scope
 * (reserved + confirmed, original claim slug) precisely so this count still
 * sees every historical claimant, and no sweeper/GC exists anywhere. Any
 * future delete/GC of registry rows must first switch this to max-suffix
 * derivation (scan existing `--q<n>` scopes for the highest n), or a freed
 * suffix gets re-minted and the freed scope's alias entry sweeps a brand-new
 * claimant's rows into the old claimant's project (the R-A cross-claimant
 * merge).
 */
function nextQuarantineN(ctx: MintContext, slug: string | null): number {
  return (slug !== null ? ctx.bySlug.get(slug)?.length ?? 0 : 0) + 1;
}

/**
 * The pure minting decision (spec §5). Executable rule order — global →
 * malformed → ephemeral → claimant+origin exact pair → byScope →
 * byClaimant(unique) → new-scope logic. The claimant+origin pair runs BEFORE
 * the byScope check so a quarantined claimant whose raw equals the incumbent
 * canonical re-resolves to its quarantine scope instead of merging.
 */
export function decideMint(raw: string, origin: string | null, ctx: MintContext): MintDecision {
  // Rule 1: global never registers; explicit global stays a deliberate act (R-D).
  if (raw === GLOBAL_SCOPE) return { kind: 'pass', scope: raw };

  // Rule 2: malformed scope → reroute to the primary scope, else _unrouted (R-C).
  if (!isScopeForm(raw)) {
    return { kind: 'reroute', scope: ctx.primaryScope ?? UNROUTED_SCOPE, raw, reason: 'malformed' };
  }

  // Rule 3: ephemerals never mint — the discovery path holds them upstream
  // (Task 7); a direct API write passes through raw, unregistered.
  if (ephemeralReason(raw) !== null) return { kind: 'pass', scope: raw };

  // Rule 5 (exact pair, hoisted): a known claimant writing from its known
  // origin resolves straight to its registered scope — including a quarantined
  // claimant landing back in its quarantine scope.
  const claimantRows = ctx.byClaimant.get(raw) ?? [];
  if (origin !== null) {
    const exact = claimantRows.find((r) => r.origin_cwd === origin);
    if (exact) return { kind: 'resolve', scope: exact.scope };
  }

  // Rule 4: raw IS a registered canonical.
  const canonical = ctx.byScope.get(raw);
  if (canonical) {
    // No origin → deliberate explicit write (e.g. MCP store_memory).
    if (origin === null) return { kind: 'pass', scope: raw };
    if (canonical.origin_cwd === null || origin === canonical.origin_cwd) return { kind: 'pass', scope: raw };
    // Both claimants self-named identically — pre-existing basename ambiguity,
    // out of scope; P4 markers are the escape hatch.
    if (canonical.claimant_raw === raw) return { kind: 'pass', scope: raw };
    // A differently-named claimant minted this canonical; byte-identical raw
    // from a new origin is the done-when's second install → quarantine.
    const slug = slugifyScope(raw);
    const n = nextQuarantineN(ctx, slug);
    return {
      kind: 'quarantine',
      scope: `${canonical.scope}--q${n}`,
      register: {
        scope: `${canonical.scope}--q${n}`,
        slug,
        claimant_raw: raw,
        origin_cwd: origin,
        status: 'quarantined',
      },
    };
  }

  // Rule 5 (remainder): known claimant, no origin match. Exactly one row →
  // resolve (the claimant string is primary identity — a moved origin still
  // lands home); multiple rows → ambiguous, fail open with raw unchanged.
  if (claimantRows.length === 1) return { kind: 'resolve', scope: claimantRows[0].scope };
  if (claimantRows.length > 1) return { kind: 'pass', scope: raw };

  // Rule 6: new scope.
  const slug = slugifyScope(raw);
  // Defensive: valid non-global scopes always slugify.
  if (slug === null) return { kind: 'pass', scope: raw };

  const collided = ctx.bySlug.get(slug) ?? [];
  if (collided.length > 0) {
    // Slug collision → quarantine off the incumbent. Reserved rows collide
    // like any other (a real dir named `unrouted` quarantines rather than
    // claiming `project:_unrouted`'s slug).
    const base = collided.find((r) => r.scope === slug)?.scope ?? collided[0].scope;
    const n = nextQuarantineN(ctx, slug);
    return {
      kind: 'quarantine',
      scope: `${base}--q${n}`,
      register: { scope: `${base}--q${n}`, slug, claimant_raw: raw, origin_cwd: origin, status: 'quarantined' },
    };
  }

  // Fresh mint: slug-adoption, both prefixes.
  return {
    kind: 'mint',
    scope: slug,
    register: { scope: slug, slug, claimant_raw: raw, origin_cwd: origin, status: 'provisional' },
  };
}
