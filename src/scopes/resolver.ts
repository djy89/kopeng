/**
 * The single definition of what the operator's scope-alias table MEANS.
 *
 * WHY THIS MODULE EXISTS: the alias-table semantics were implemented four times
 * and disagreed. `ScopeAliasService` rejected self-maps and chains; the drift
 * endpoint's own reader accepted every `{string: string}`; the migration driver
 * checked only string-ness. The failure mode that forced this module: a CHAINED
 * entry made the write path ignore the mapping (new rows kept landing on the
 * alias scope) while the drift detector saw `aliased_to` non-null, called the
 * cluster covered, and reported `active_rows_adrift: 0` — a watchdog reading
 * clean during the exact failure it exists to detect.
 *
 * The fix is not a fifth, stricter parser. Every consumer imports THIS function
 * and reads the SAME accepted map, and `tests/unit/scope-definition-composition.test.ts`
 * fails if one of them starts parsing the blob itself again.
 *
 * Pure throughout — no I/O, no clock, no logger. Callers own caching, logging
 * and fail-open policy (see `ScopeAliasService`).
 */
import { createHash } from 'node:crypto';

/** Why an entry did not make it into the accepted map. */
export type AliasRejectionReason =
  | 'non_string'
  | 'empty'
  | 'self_map'
  | 'chained'
  | 'generic_capture'
  | 'malformed_scope';

export interface RejectedAlias {
  alias: string;
  canonical: unknown;
  reason: AliasRejectionReason;
}

export interface ScopeResolution {
  /**
   * Content hash of the ACCEPTED table (sorted, so key order is irrelevant).
   * Stamped into alias-mediated dream diffs in Phase 2 so an apply can tell
   * whether the table changed under it.
   */
  version: string;
  /** alias → canonical, accepted entries only. */
  forward: Map<string, string>;
  /** canonical → its aliases, accepted entries only. */
  groups: Map<string, string[]>;
  /** Everything skipped, with the reason. Consumers surface this; none ignore it silently. */
  rejected: RejectedAlias[];
  /** The accepted map as a plain object, for consumers that want a record not a Map. */
  table: Record<string, string>;
}

/** The global scope literal. Compared in several subsystems; named once here. */
export const GLOBAL_SCOPE = 'global';

/** True when the scope is the global scope. */
export function isGlobalScope(scope: string): boolean {
  return scope === GLOBAL_SCOPE;
}

/**
 * Legal scope forms: `global`, `project:<name>`, `client:<name>`. A P6 marker
 * finding is the reason this is enforced on both sides of a mapping — three
 * deployed markers carried `status:archived`, which is not a scope and would
 * have ridden along as a dead scope on every recall from those trees.
 */
export function isScopeForm(s: string): boolean {
  return isGlobalScope(s) || /^(project|client):.+$/.test(s);
}

/**
 * Normalizes a client:/project: scope to its canonical slug form: lowercase,
 * non-alphanumerics collapsed to single hyphens, leading/trailing hyphens
 * stripped. Returns null for scopes outside the client:/project: prefixes
 * (`global` included), or when the normalized part is empty.
 *
 * MOVED here from drift.ts in Phase 1 — this is a definition of scope-string
 * shape, so it belongs with the other scope definitions, and having the detector
 * own it while the validator needed it too would have re-created the exact
 * two-copies problem this phase exists to remove. drift.ts re-exports it.
 *
 * Note it is MANY-TO-ONE (`a_b`, `a.b` and `a-b` all collapse), so it is only
 * ever used for DETECTION and VALIDATION — never to resolve one scope to
 * another, which would silently merge genuinely distinct scopes. See
 * SCOPE_CASE_REGIME.
 */
export function slugifyScope(scope: string): string | null {
  const m = /^(client|project):(.+)$/.exec(scope);
  if (!m) return null;
  const [, prefix, part] = m;
  const slug = part.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  return `${prefix}:${slug}`;
}

/** The slug's bare name, without the prefix. Null when not a client:/project: scope. */
function bareName(scope: string): string | null {
  const slug = slugifyScope(scope);
  return slug === null ? null : slug.slice(slug.indexOf(':') + 1);
}

/**
 * Directory basenames that are too generic to identify anything on their own.
 * These are not forbidden as SCOPES — a project genuinely called `api` is fine
 * and always was. They are only meaningful as the left-hand side of the capture
 * test below.
 */
export const GENERIC_BASENAMES: ReadonlySet<string> = new Set([
  'web', 'backup', 'platform', 'src', 'dist', 'build', 'app', 'apps',
  'api', 'docs', 'doc', 'test', 'tests', 'tmp', 'temp', 'data', 'lib', 'main',
  'code', 'project', 'new', 'old', 'work', 'repo', 'server', 'client', 'frontend',
  'backend', 'admin', 'assets', 'public', 'scripts', 'config',
]);

/**
 * CAPTURE: an auto-minted generic key routed into a DIFFERENT namespace (P13).
 *
 * `project:` scopes are minted from `basename(cwd)` — nobody chooses them — and
 * `canonicalizeScope` is an exact-string lookup with no directory context. So
 * `project:web → client:<someone>` asserts "every folder named web, forever,
 * for any client, is that client's work", and `project:src → project:kopeng`
 * asserts it about every project's source directory. Correct as a one-time
 * MIGRATION spec, wrong as a standing write rule — different artifacts, and
 * conflating them is the meta-finding in miniature. Four such keys were loaded
 * on live and removed 2026-08-16.
 *
 * Deliberately NOT capture, so these stay legal:
 *   - `project:Web → project:web` — pure fold of the SAME name, captures nothing.
 *   - `client:<anything> → …`     — a `client:` key is operator-authored, never
 *                                   auto-minted, so it is a deliberate act.
 *   - `project:<specific> → project:data` — a generic name on the RIGHT is just
 *                                   an unhelpful canonical, not a capture.
 *
 * The inverted rule to avoid: rejecting generic keys only when no client scope
 * is present would have PERMITTED all four P13 entries, since every one of them
 * pointed at a client scope. The client on the right is what made them harmful.
 */
function isGenericCapture(alias: string, canonical: string): boolean {
  if (!alias.startsWith('project:')) return false;
  const a = bareName(alias);
  if (a === null || !GENERIC_BASENAMES.has(a)) return false;
  const c = bareName(canonical);
  // Unresolvable canonical (e.g. `global`) counts as capture: generic project
  // rows must not be swept into the global namespace either.
  return c === null || a !== c;
}

function hashTable(table: Record<string, string>): string {
  // JSON-encode the sorted pairs: unambiguous without needing a delimiter that
  // cannot appear in a scope, so {a: 'bc'} and {ab: 'c'} can never collide.
  const sorted = JSON.stringify(Object.keys(table).sort().map(k => [k, table[k]]));
  return createHash('sha256').update(sorted).digest('hex').slice(0, 12);
}

/**
 * Validate a raw `operator_config.config.scope_aliases` blob into the accepted
 * resolution plus the list of what was rejected and why.
 *
 * Rejection order matters only for the reported reason, never for the outcome:
 * a rejected entry is absent from `forward`/`groups`/`table` whichever rule
 * caught it. Chains are forbidden in both directions — no string may be both an
 * alias key and a canonical value — because a chain means the exact-match write
 * path and any transitive-resolution reader would disagree about the result.
 */
export function buildScopeResolution(raw: unknown): ScopeResolution {
  const forward = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const rejected: RejectedAlias[] = [];
  const table: Record<string, string> = {};

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { version: hashTable({}), forward, groups, rejected, table };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  // Chain detection reads canonical values from ALL raw entries, including ones
  // a later rule rejects — so a malformed entry's value can still cause an
  // otherwise-valid entry keyed by that value to reject as `chained`.
  // Deliberate: it fails toward over-rejection (the safe direction — a skipped
  // mapping is a no-op at write time), and narrowing the set to only-valid
  // entries would make one entry's verdict depend on validation order.
  const canonicalValues = new Set<string>();
  for (const [, canonical] of entries) {
    if (typeof canonical === 'string' && canonical.length > 0) canonicalValues.add(canonical);
  }

  for (const [alias, canonical] of entries) {
    const reject = (reason: AliasRejectionReason): void => {
      rejected.push({ alias, canonical, reason });
    };

    if (typeof canonical !== 'string') { reject('non_string'); continue; }
    if (canonical.length === 0) { reject('empty'); continue; }
    if (canonical === alias) { reject('self_map'); continue; }
    if (canonicalValues.has(alias)) { reject('chained'); continue; }
    if (!isScopeForm(alias) || !isScopeForm(canonical)) { reject('malformed_scope'); continue; }
    if (isGenericCapture(alias, canonical)) { reject('generic_capture'); continue; }

    forward.set(alias, canonical);
    table[alias] = canonical;
    const group = groups.get(canonical) ?? [];
    group.push(alias);
    groups.set(canonical, group);
  }

  return { version: hashTable(table), forward, groups, rejected, table };
}

/** The identity resolution — what every fail-open path degrades to. */
export const EMPTY_RESOLUTION: ScopeResolution = buildScopeResolution(null);

/**
 * THE case-sensitivity regime for scopes: **alias-mediated**.
 *
 * Case variants are equated by the operator's alias table and by nothing else.
 * Resolution is exact-string in both directions; the drift detector's slug fold
 * is a DETECTION aid that must never feed resolution (it is many-to-one — `a_b`,
 * `a.b` and `a-b` all collapse — so using it to resolve would silently merge
 * genuinely distinct scopes).
 *
 * Known exception, deliberately still in place: three sites per backend fold
 * case in SQL (`COLLATE NOCASE` in queries.ts, `LOWER(...)` in pg-queries.ts).
 * That fold is why migrate-scope-aliases.ts needs a client-side exact-case
 * filter — without it, a case-only pair sweeps in rows already on the canonical
 * and the residual check matches its own migrated rows. Removing the fold is
 * gated on `active_rows_adrift` reaching 0 on live: while rows still sit on
 * un-tabled case variants, the fold is the only thing keeping them reachable.
 * `tests/unit/scope-case-regime.test.ts` pins the current per-layer behaviour.
 */
export const SCOPE_CASE_REGIME = 'alias-mediated' as const;

/**
 * Are these the same scope? Exact-string, per SCOPE_CASE_REGIME: canonicalization
 * happens at WRITE time, so rows being compared are already canonical, and two
 * surviving case variants are genuine drift rather than a match to be folded
 * away. Open-coded at five sites before Phase 1 — the shared-concept-copy pattern
 * in miniature, since "same scope" is a decision, not a string operation.
 */
export function sameScope(a: string, b: string): boolean {
  return a === b;
}
