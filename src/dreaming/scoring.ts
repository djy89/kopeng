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
}

/** The stored inputs the Hard-Anchor contract is decided from. Subset of the
 *  Memory row; `is_locked` absorbs the boolean-vs-number split across row
 *  shapes (`CandidateMemory` boolean, `Memory` number, sample rows boolean). */
export interface AnchorInputs {
  is_locked: boolean | number | null;
  confidence: number;
  metadata?: string | null;
}

/** THE Hard-Anchor contract (CR-1): pinned / locked / operator-confirmed rows are
 *  never mutated by ANY automated path. Consumers: dream selector eligibility,
 *  auditedArchiveMemory apply-time re-check, promotion decay selection,
 *  maintenance §2 sweep, corpus-health panel. */
export function isAnchored(m: AnchorInputs): boolean {
  return !!m.is_locked || m.confidence >= 1.0 || isPinnedMetadata(m.metadata);
}

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
    memory.tags
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
    memory.tags
  ) < DECAY_ARCHIVE_THRESHOLD;
}
