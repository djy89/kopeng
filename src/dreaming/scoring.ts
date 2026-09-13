/**
 * Derived memory strength for the dreaming layer (D1.1).
 *
 * Design invariant #2: no stored `strength`. `confidence` is the single stored
 * belief scalar; everything else here is computed on read from the stored
 * inputs (`observation_count`, `last_seen`).
 *
 * The two decay systems are ORTHOGONAL — they answer different questions:
 *
 * - **Storage / belief** (`confidence` + `computeEffectiveConfidence`): "how
 *   much do we still believe this?" Decays by calendar time since the memory
 *   was last *seen* (reinforced or recalled), slowed by durability. Runs at
 *   read time on every search; nothing is written.
 * - **Retrieval / usage** (`src/promotion/decay.ts`): "is this still being
 *   used?" Scored from the access log + `last_seen` by the promotion pipeline
 *   to pick auto-archive candidates. Periodic batch, not per-search.
 *
 * Column ownership (D1.1 fold-in — correction must not masquerade as usage):
 * - `content`, `updated_at` — content correction (`update_memory`)
 * - `confidence` — belief (operator confirm, discovery reinforcement)
 * - `observation_count`, `last_seen` — usage/durability (reinforcement-on-access,
 *   discovery re-observation). Only these reset the decay clock.
 */

import { computeEffectiveConfidence, durabilityFactor, DECAY_ARCHIVE_THRESHOLD } from '../discovery/confidence.js';

export { durabilityFactor, DECAY_ARCHIVE_THRESHOLD };

/** The stored inputs strength is derived from. Subset of the Memory row. */
export interface StrengthInputs {
  confidence: number;
  observation_count: number | null;
  last_seen: string | null;
  updated_at: string;
  // T30: type selects the per-type decay half-life; tags drive error-pattern
  // (fast decay) + structural (floor) detection. Optional — a caller that omits
  // them falls back to the default 60d half-life and no floor (pre-T30 behavior).
  type?: string;
  tags?: readonly string[];
  // WS7.4: is_locked freezes the curve at the stored confidence (THE Hard
  // Anchor). Optional and boolean-or-number — same row-shape split as
  // AnchorInputs, below — a caller that omits it falls back to unfrozen
  // (pre-WS7.4 behavior).
  is_locked?: boolean | number | null;
}

/** The stored inputs the Hard-Anchor contract is decided from. Subset of the
 *  Memory row; `is_locked` absorbs the boolean-vs-number split across row
 *  shapes (`CandidateMemory` boolean, `Memory` number, sample rows boolean). */
export interface AnchorInputs {
  is_locked: boolean | number | null;
  confidence: number;
  metadata?: string | null;
}

/** THE Hard-Anchor contract (CR-1, amended WS7.4): `is_locked` is THE anchor —
 *  `confidence >= 1.0` and `metadata.pinned` are DEPRECATED spellings, still
 *  honored this release (doctor warns; `npm run migrate:anchors` moves them to
 *  `is_locked`). An anchored row is never mutated by ANY automated path, and
 *  (WS7.4 B2) its read-time effective confidence is frozen at the stored value
 *  — see `computeEffectiveConfidence`'s `locked` param. Consumers: dream
 *  selector eligibility, auditedArchiveMemory apply-time re-check, promotion
 *  decay selection, maintenance §2 sweep, corpus-health panel. */
export function isAnchored(m: AnchorInputs): boolean {
  return !!m.is_locked || m.confidence >= 1.0 || isPinnedMetadata(m.metadata);
}

/**
 * The Hard Anchor in SQL, one dialect each — the `ARCHIVED_SQL_PREDICATE`
 * precedent (src/utils/archived.ts). It lives HERE, beside `isAnchored`,
 * because it is the same contract in another language: a per-backend spelling
 * buried in queries.ts / pg-queries.ts would be a fourth and fifth definition
 * of "anchored", and this file's whole reason for existing is that there is
 * exactly one. `tests/unit/anchored-aggregate.test.ts` pins SQL ≡ TS over a
 * corpus exercising all three spellings; the PG twin is in the executed-SQL
 * suite.
 *
 * The dialects genuinely differ and cannot be one string: Postgres stores
 * `metadata` as JSONB (so `->>` is exact and total), while SQLite stores TEXT
 * and `json_extract` RAISES on malformed JSON — which would take down the
 * whole aggregate query for every scope because of one bad row. Hence the
 * `json_valid` CASE, which is lazily evaluated where a bare `AND` is not
 * guaranteed to short-circuit.
 */
export const ANCHORED_SQL_PREDICATE = {
  // `json_type(...) = 'true'`, NEVER `json_extract(...) = 1`: json_extract maps
  // both JSON `true` and the integer 1 to the SQL value 1, so `{"pinned":1}`
  // would count as anchored while `isPinnedMetadata`'s strict `=== true`
  // rejects it — the panel would promise an archive refuses a row that
  // `auditedArchiveMemory` then archives. json_type distinguishes 'true' from
  // 'integer'. (This exact trap is documented at the `legacy_anchor_count`
  // query in queries.ts; the first draft here reintroduced the spelling that
  // comment exists to reject.)
  //
  // COALESCE, not a bare comparison: json_type yields NULL for a missing key —
  // and `metadata` DEFAULTs to '{}' on both backends — so the raw predicate is
  // three-valued. Both current call sites treat NULL as false, but this is an
  // exported general-purpose constant, and the first caller to write
  // `WHERE NOT (…)` would otherwise get zero rows for nearly the whole corpus.
  sqlite:
    "(is_locked = 1 OR confidence >= 1.0 OR COALESCE("
    + "(CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.pinned') ELSE NULL END) = 'true'"
    + ", 0))",
  // `metadata->'pinned' = 'true'::jsonb` (jsonb equality), not
  // `metadata->>'pinned' = 'true'` (text): `->>` unquotes scalars, so the JSON
  // STRING "true" would also match while isAnchored rejects it. Same
  // divergence class as the SQLite trap above, opposite backend.
  postgres:
    "(is_locked OR confidence >= 1.0 OR COALESCE(metadata->'pinned' = 'true'::jsonb, FALSE))",
} as const;

/** `metadata.pinned === true` — the operator pin promotion always honored and
 *  the dream/maintenance paths ignored until CR-1 unified them here. */
export function isPinnedMetadata(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as { pinned?: unknown };
    return parsed.pinned === true;
  } catch {
    return false;
  }
}

/**
 * Derived strength of a memory at a point in time: its effective confidence
 * after durability-scaled decay. This is what candidate selection (Phase 1.2)
 * and ranking compare — never a stored value.
 */
export function memoryStrength(memory: StrengthInputs, now: Date = new Date()): number {
  return computeEffectiveConfidence(
    memory.confidence,
    memory.last_seen ?? memory.updated_at,
    now,
    false,
    memory.observation_count ?? 1,
    memory.type,
    memory.tags,
    !!memory.is_locked
  );
}

export interface DecayPredicateOptions { dormant?: boolean }

/** THE archive-line predicate (ruling R4-B: dormancy is an explicit per-site
 *  input — promotion/dream/panel pass nothing (no freeze), maintenance §2
 *  passes its D1.1 dormant-scope freeze). */
export function isDecayedAtRisk(memory: StrengthInputs, now: Date, opts?: DecayPredicateOptions): boolean {
  return computeEffectiveConfidence(
    memory.confidence,
    memory.last_seen ?? memory.updated_at,
    now,
    opts?.dormant ?? false,
    memory.observation_count ?? 1,
    memory.type,
    memory.tags,
    !!memory.is_locked
  ) < DECAY_ARCHIVE_THRESHOLD;
}
