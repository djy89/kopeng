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

import { computeEffectiveConfidence, durabilityFactor } from '../discovery/confidence.js';

export { durabilityFactor };

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
