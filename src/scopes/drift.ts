/**
 * Scope-drift detection (T43 Phase A, detector half).
 *
 * WHY THIS EXISTS: T46's write-time canonicalization is an EXACT-STRING map
 * lookup (`forward.get(scope) ?? scope`), so it only catches variants already in
 * the operator's alias table. A brand-new casing/separator variant of a known
 * entity — `client:Acme-Foods` when the table only knows `client:acme-foods` —
 * lands verbatim, exactly as before T46. The layer closed KNOWN drift; nothing
 * watches for NEW drift. The 2026-08-14 reconciliation was a manual pass over
 * 372 scopes that will be needed again on the same schedule unless something
 * detects it early, which is what this module is for.
 *
 * `clusterScopes` lives here; scripts/ops/propose-scope-aliases.ts imports it
 * so the proposer script and the ops endpoint never drift apart in how they
 * define a cluster — a scope-drift detector with its own drifting definition
 * of drift would be a particularly unhelpful bug. `slugifyScope` has since
 * moved on to src/scopes/resolver.ts (Phase 1); this module re-exports it so
 * existing callers of drift.ts are unaffected.
 *
 * Pure throughout — no I/O, no clock. The caller supplies aggregates and stamps
 * the time, so the whole module is unit-testable without a database.
 *
 * Phase 1: coverage is read from the RESOLVER's accepted map, not a private
 * parser. The detector previously had its own lax reader, so a chained entry —
 * which the write path ignores — still counted as coverage and the report read
 * `active_rows_adrift: 0` during the exact failure it exists to detect. A
 * watchdog with its own definition of the thing it watches is worse than none.
 */

import { slugifyScope, EMPTY_RESOLUTION, type RejectedAlias } from './resolver.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProposerReport {
  mechanical: { canonical: string; variants: { scope: string; count: number }[] }[]; // same prefix, same slug, ≥2 variants (or 1 variant ≠ slug form)
  crossPrefix: { slug: string; scopes: { scope: string; count: number }[] }[];       // client:x + project:x share a slug — judgment call, never auto-proposed
  ephemeral: { scope: string; count: number; reason: string }[];                      // wf_* / agent-<hex> / date-shaped / bare-number — archive candidates, NOT aliases
  passthrough: { scope: string; count: number }[];                                    // already-canonical singletons
  /** same letters after stripping hyphens from the slug — "possible, review" pairs, never auto-proposed */
  nearMiss: { a: string; b: string }[];
}

/** Per-scope aggregates from the store — one row per scope. */
export interface ScopeAggregate {
  scope: string;
  total: number;
  active: number;
  archived: number;
  by_type: Record<string, number>;
  first_write: string | null;
  last_write: string | null;
}

/**
 * One variant within a drift cluster, carrying the evidence that made the
 * 2026-08-14 rulings cheap. `by_type` is the decisive one: in all seven
 * cross-prefix calls the `project:` side was ~96% auto-discovery and the
 * `client:` side held zero, which settled "same entity or genuinely separate
 * workstream?" on sight. `archived` is here because a migration's "residual 0"
 * counts only ACTIVE rows — 178 archived rows stayed behind un-flagged.
 */
export interface ScopeVariantEvidence extends ScopeAggregate {
  /** Non-null when the alias table already maps this variant away. */
  aliased_to: string | null;
}

export interface ScopeDriftCluster {
  /** The shared slug part — the entity the variants disagree about spelling. */
  key: string;
  /**
   * `casing` — same prefix, same slug: mechanically safe to alias.
   * `cross_prefix` — `client:x` AND `project:x`: an operator ruling, never auto-proposed.
   */
  kind: 'casing' | 'cross_prefix';
  /** Proposed canonical. Null for cross_prefix — picking the prefix IS the ruling. */
  canonical: string | null;
  variants: ScopeVariantEvidence[];
  /** Every non-canonical variant is already covered by the alias table. */
  covered: boolean;
  /** Active rows sitting on variants the table does NOT cover — the actionable number. */
  active_rows_adrift: number;
}

export interface ScopeDriftReport {
  summary: {
    scopes_total: number;
    clusters_total: number;
    /**
     * Clusters with at least one un-aliased variant — the STRUCTURAL view.
     * Includes clusters whose only un-aliased rows are archived, so it reads
     * higher than the work actually outstanding; use `clusters_actionable` for
     * "how many rulings do I owe?".
     */
    clusters_uncovered: number;
    /**
     * Uncovered clusters holding LIVE rows — the "needs a ruling now" count.
     * Verified against the real corpus 2026-08-14: 14 uncovered but only 7
     * actionable, the other 7 being archived-only residue of the migration.
     */
    clusters_actionable: number;
    /** THE drift metric: active rows on un-aliased variants. Post-reconciliation this is 0. */
    active_rows_adrift: number;
    ephemeral_scopes: number;
    ephemeral_rows: number;
    near_miss_pairs: number;
    /**
     * Entries the resolver REJECTED (chain, self-map, generic basename,
     * malformed scope). Non-zero means the operator's table contains mappings
     * the write path ignores — the exact condition under which the pre-Phase-1
     * detector reported everything covered while rows kept drifting.
     */
    alias_entries_rejected: number;
    /** Content hash of the accepted table this report was computed against. */
    alias_table_version: string;
  };
  clusters: ScopeDriftCluster[];
  ephemeral: { scope: string; count: number; reason: string }[];
  near_miss: { a: string; b: string }[];
}

// ── Ephemeral shape detection (order matters — first match wins) ───────────

const EPHEMERAL_RULES: { re: RegExp; reason: string }[] = [
  { re: /^project:wf_[0-9a-f]/i, reason: 'workflow-run scope' },
  { re: /^project:agent-[0-9a-f]{8,}/i, reason: 'subagent scope' },
  { re: /^project:\d{8}([-_].*)?$/, reason: 'date-stamped sprint/dir scope' },
  { re: /^project:\d{4}-\d{2}(-\d{2})?([ _-].*)?$/, reason: 'date-stamped sprint/dir scope' },
  { re: /^project:\d{1,3}$/, reason: 'bare-number scope' },
];

export function ephemeralReason(scope: string): string | null {
  for (const { re, reason } of EPHEMERAL_RULES) {
    if (re.test(scope)) return reason;
  }
  return null;
}

// ── Pure clustering ────────────────────────────────────────────────────────

// slugifyScope MOVED to ./resolver.ts in Phase 1 — it is a definition of scope
// string shape, and the validator needs it too. Re-exported so the proposer
// script and the drift tests keep their existing import path.
export { slugifyScope } from './resolver.js';

function stripHyphens(slug: string): string {
  return slug.replace(/-/g, '');
}

/**
 * Clusters a scope→count inventory into mechanical alias proposals,
 * cross-prefix collisions, ephemeral archive candidates, and passthrough
 * singletons. Pure — no I/O.
 */
export function clusterScopes(byScope: Record<string, number>): ProposerReport {
  const ephemeral: ProposerReport['ephemeral'] = [];
  const candidates: { scope: string; count: number; slug: string; prefix: 'client' | 'project' }[] = [];

  for (const [scope, count] of Object.entries(byScope)) {
    const reason = ephemeralReason(scope);
    if (reason) {
      ephemeral.push({ scope, count, reason });
      continue;
    }
    const slug = slugifyScope(scope);
    if (slug === null) continue; // not client:/project: (e.g. 'global') — neither ephemeral nor clusterable
    const prefix = scope.startsWith('client:') ? 'client' : 'project';
    candidates.push({ scope, count, slug, prefix });
  }

  // Group by bare slug part (without prefix) to detect cross-prefix collisions.
  const bySlugPart = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const slugPart = c.slug.slice(c.prefix.length + 1);
    const arr = bySlugPart.get(slugPart) ?? [];
    arr.push(c);
    bySlugPart.set(slugPart, arr);
  }

  const mechanical: ProposerReport['mechanical'] = [];
  const crossPrefix: ProposerReport['crossPrefix'] = [];
  const passthrough: ProposerReport['passthrough'] = [];

  for (const [slugPart, members] of bySlugPart) {
    const prefixesPresent = new Set(members.map(m => m.prefix));
    if (prefixesPresent.size > 1) {
      crossPrefix.push({
        slug: slugPart,
        scopes: members.map(m => ({ scope: m.scope, count: m.count })),
      });
      continue;
    }

    const canonical = members[0].slug;
    const variants = members.filter(m => m.scope !== canonical);

    if (members.length > 1 || (members.length === 1 && members[0].scope !== canonical)) {
      mechanical.push({
        canonical,
        variants: variants.map(v => ({ scope: v.scope, count: v.count })),
      });
    } else {
      passthrough.push({ scope: members[0].scope, count: members[0].count });
    }
  }

  // Near-miss: same letters after stripping hyphens from the slug part,
  // across distinct canonical slugs that did NOT already cluster.
  const nearMiss: ProposerReport['nearMiss'] = [];
  const canonicalSlugs = [
    ...mechanical.map(m => m.canonical),
    ...passthrough.map(p => p.scope),
  ];
  const byStripped = new Map<string, string[]>();
  for (const slug of canonicalSlugs) {
    const stripped = stripHyphens(slug);
    const arr = byStripped.get(stripped) ?? [];
    arr.push(slug);
    byStripped.set(stripped, arr);
  }
  for (const group of byStripped.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        nearMiss.push({ a: group[i], b: group[j] });
      }
    }
  }

  return { mechanical, crossPrefix, ephemeral, passthrough, nearMiss };
}

// ── Drift report ───────────────────────────────────────────────────────────

const EMPTY_AGGREGATE = (scope: string): ScopeAggregate => ({
  scope, total: 0, active: 0, archived: 0, by_type: {}, first_write: null, last_write: null,
});

/**
 * The coverage input: structurally a `ScopeResolution` (src/scopes/resolver.ts).
 * Typed as its own minimal shape so drift.ts stays pure and importable by the
 * proposer script, while still being impossible to satisfy with a hand-rolled
 * `Record<string, string>` — which is how the two definitions diverged.
 *
 * NOTE: structural typing carries no provenance — a consumer COULD hand-build
 * this shape without calling buildScopeResolution, and the compiler would not
 * object. The real guardrail is tests/unit/scope-definition-composition.test.ts,
 * which fails if any consumer's verdicts diverge from the resolver's. Treat the
 * type as a convenience, the composition test as the enforcement.
 */
export interface AliasCoverage {
  table: Record<string, string>;
  rejected: RejectedAlias[];
  version: string;
}

/**
 * Builds the drift report from per-scope aggregates plus the live alias table.
 *
 * The alias table is what turns a raw cluster list into a signal: a cluster
 * whose variants are all already aliased is RESOLVED (kept visible, since its
 * rows may still be mid-migration or archived-and-left-behind) and contributes
 * nothing to `active_rows_adrift`. Anything it does NOT cover is new drift —
 * which is precisely the class the exact-match canonicalizer cannot catch.
 *
 * `active_rows_adrift` counts ACTIVE rows only: archived rows on an alias scope
 * are a known, accepted residue of the migration (recall excludes them), and
 * counting them would make a healthy corpus permanently read as drifting.
 *
 * Pure — no clock, no I/O.
 */
export function buildScopeDrift(
  aggregates: ScopeAggregate[],
  coverage: AliasCoverage = EMPTY_RESOLUTION,
): ScopeDriftReport {
  const byScope = new Map(aggregates.map(a => [a.scope, a]));
  const counts: Record<string, number> = {};
  for (const a of aggregates) counts[a.scope] = a.total;

  const clustered = clusterScopes(counts);

  const evidence = (scope: string): ScopeVariantEvidence => ({
    ...(byScope.get(scope) ?? EMPTY_AGGREGATE(scope)),
    aliased_to: coverage.table[scope] ?? null,
  });

  const clusters: ScopeDriftCluster[] = [];

  for (const m of clustered.mechanical) {
    // The canonical belongs in the cluster even when it holds no rows yet —
    // seeing "the correct spelling has 0 rows" is exactly the useful view.
    const scopes = [m.canonical, ...m.variants.map(v => v.scope)];
    const variants = [...new Set(scopes)].map(evidence);
    const uncovered = variants.filter(v => v.scope !== m.canonical && v.aliased_to === null);
    clusters.push({
      key: m.canonical,
      kind: 'casing',
      canonical: m.canonical,
      variants,
      covered: uncovered.length === 0,
      active_rows_adrift: uncovered.reduce((n, v) => n + v.active, 0),
    });
  }

  for (const c of clustered.crossPrefix) {
    const variants = c.scopes.map(s => evidence(s.scope));
    // No canonical is proposed, so "covered" means the table already routes all
    // but one of them somewhere — i.e. the operator has already ruled.
    const uncovered = variants.filter(v => v.aliased_to === null);
    clusters.push({
      key: c.slug,
      kind: 'cross_prefix',
      canonical: null,
      variants,
      covered: uncovered.length <= 1,
      active_rows_adrift: uncovered.length <= 1 ? 0 : uncovered.reduce((n, v) => n + v.active, 0),
    });
  }

  // Worst first: the clusters holding the most live, un-aliased rows.
  clusters.sort((a, b) => b.active_rows_adrift - a.active_rows_adrift || a.key.localeCompare(b.key));

  const ephemeralRows = clustered.ephemeral.reduce((n, e) => n + e.count, 0);

  return {
    summary: {
      scopes_total: aggregates.length,
      clusters_total: clusters.length,
      clusters_uncovered: clusters.filter(c => !c.covered).length,
      clusters_actionable: clusters.filter(c => !c.covered && c.active_rows_adrift > 0).length,
      active_rows_adrift: clusters.reduce((n, c) => n + c.active_rows_adrift, 0),
      ephemeral_scopes: clustered.ephemeral.length,
      ephemeral_rows: ephemeralRows,
      near_miss_pairs: clustered.nearMiss.length,
      alias_entries_rejected: coverage.rejected.length,
      alias_table_version: coverage.version,
    },
    clusters,
    ephemeral: clustered.ephemeral,
    near_miss: clustered.nearMiss,
  };
}
