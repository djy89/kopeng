/**
 * Confidence scoring for auto-discovered memories.
 *
 * - computeConfidence: evidence count → initial confidence (3→0.5, 6→0.7, 11→0.85)
 * - reinforceConfidence: self-limiting bump (+0.05*(1-current)), capped at 0.85 auto
 * - computeEffectiveConfidence: read-time decay (durability-scaled) with dormant project freeze
 * - durabilityFactor: 1 + ln(observation_count) — derived, never stored (D1.1)
 */

import type { PatternCandidate } from '../types/types.js';

/** Maximum confidence auto-discovery can assign. Operator must explicitly confirm for higher. */
export const AUTO_CONFIDENCE_CEILING = 0.85;

/**
 * The confidence a re-observation should WRITE, or null meaning "write nothing".
 *
 * Autonomous reinforcement may never REDUCE confidence. `reinforceConfidence` clamps
 * internally (`Math.min(CEILING, currentConfidence + delta)`), so a bare ceiling-clamp
 * on its output demotes a deliberate Hard Anchor (1.0) and a crystallized memory (0.97)
 * to 0.85 (P1, tracker Round 12). Every other consumer of the anchor concept checks it;
 * this is the highest-frequency writer and it did not.
 *
 * Callers MUST still bump usage (`reinforceOnAccess`) when this returns null: the memory
 * was genuinely re-observed, so its decay clock and durability should advance. Only the
 * confidence write is suppressed.
 */
export function reinforcedConfidenceFor(existing: number): number | null {
  if (existing > AUTO_CONFIDENCE_CEILING) return null;
  return reinforceConfidence(existing);
}

/** Default half-life (days) for types without a T30 tuned value. */
export const DEFAULT_HALF_LIFE_DAYS = 60;

/**
 * Per-type decay half-lives (days) — T30. Volatile classes fade fast, structural
 * classes slow (and are additionally floored, see STRUCTURAL_FLOOR). `error` is a
 * discovery memory carrying an error-pattern tag. Validated by a read-only
 * corpus-modeling pass (see `npm run analyze:type-decay`).
 */
export const DECAY_HALF_LIVES: Record<string, number> = {
  error: 11,
  discovery: 25,
  project: 45,
  reference: 38,
  feedback: 90,
  user: DEFAULT_HALF_LIFE_DAYS, // ~always anchored (>=1.0 short-circuits); value unused in practice
};

/**
 * Confidence floor for structural facts (T30). A floored memory's effective
 * confidence never decays below this (clamped to at most its stored confidence,
 * so a genuinely-low memory is never raised). Keeps paths / endpoints /
 * conventions above the 0.2 archive line while still true.
 */
export const STRUCTURAL_FLOOR = 0.4;

const ERROR_TAG_RE = /^error/;

/** True for discovery memories carrying an error-pattern tag (fastest decay). */
function isErrorClass(type: string | undefined, tags: readonly string[] | undefined): boolean {
  if (type !== 'discovery' || !tags) return false;
  return tags.some((t) => ERROR_TAG_RE.test(t) || t === 'recurring_error');
}

/**
 * True for structural facts that get a decay floor: `reference` type, or an
 * explicit `structural`/`canonical` tag (the canonical recall signal, per the
 * locked T30 decision — no content-regex detection).
 */
function isStructural(type: string | undefined, tags: readonly string[] | undefined): boolean {
  if (type === 'reference') return true;
  return !!tags && tags.some((t) => t === 'structural' || t === 'canonical');
}

/** Resolve the decay half-life (days) for a memory's type/tags (T30). */
export function resolveHalfLife(type?: string, tags?: readonly string[]): number {
  if (isErrorClass(type, tags)) return DECAY_HALF_LIVES.error;
  if (type && type in DECAY_HALF_LIVES) return DECAY_HALF_LIVES[type];
  return DEFAULT_HALF_LIFE_DAYS;
}

/** Resolve the confidence floor for a memory's type/tags, or null (T30). */
export function resolveFloor(type?: string, tags?: readonly string[]): number | null {
  return isStructural(type, tags) ? STRUCTURAL_FLOOR : null;
}

/** Reinforcement delta multiplier. */
const REINFORCE_DELTA = 0.05;

/**
 * Compute initial confidence from evidence count and temporal spread.
 * More evidence over longer periods = higher confidence.
 *
 * Base curve: logarithmic mapping from evidence count.
 * - 3 occurrences → ~0.50
 * - 6 occurrences → ~0.65
 * - 11 occurrences → ~0.80
 *
 * Temporal spread bonus: up to +0.05 for patterns spanning 7+ days.
 */
export function computeConfidence(evidenceCount: number, observationSpanDays: number = 0): number {
  if (evidenceCount < 1) return 0;

  // Logarithmic curve: 0.5 at 3, approaching ceiling asymptotically
  // f(n) = 0.5 + 0.35 * (1 - 1/ln(n+1)) for n >= 3
  const base = evidenceCount <= 2
    ? 0.3 + 0.1 * evidenceCount  // 1→0.4, 2→0.5
    : 0.5 + 0.35 * (1 - 1 / Math.log(evidenceCount + 1));

  // Temporal spread bonus: patterns observed over days are more reliable
  // than patterns observed in a single burst
  const spreadBonus = observationSpanDays > 0
    ? Math.min(0.05, 0.05 * (observationSpanDays / 7))
    : 0;

  return Math.min(AUTO_CONFIDENCE_CEILING, base + spreadBonus);
}

/**
 * Per-pattern-type confidence assignment for detected candidates (round-2 fix
 * A4 — ONE definition; runDiscovery and the re-drive both call this, so the
 * two paths cannot drift):
 * - recurring_error / error_fix → enhanced error scoring (cross-session bonus,
 *   fix shortcut) with `has_fix` honored;
 * - sequence → the same session-count-primary curve, never with a fix bonus;
 * - everything else → the base evidence-count curve.
 * `distinct_sessions` falls back to counting the evidence snapshot's session
 * ids when the detector didn't precompute it. Mutates `candidate.confidence`.
 */
export function assignCandidateConfidence(candidate: PatternCandidate): void {
  if (candidate.pattern_type === 'recurring_error' || candidate.pattern_type === 'error_fix') {
    const hasFix = candidate.has_fix === true;
    const distinctSessions = candidate.distinct_sessions
      ?? new Set(candidate.evidence_snapshot.map(e => e.session_id)).size;
    candidate.confidence = computeErrorPatternConfidence(
      candidate.evidence_count, distinctSessions, hasFix, candidate.observation_span_days
    );
  } else if (candidate.pattern_type === 'sequence') {
    // Sequences use session count as primary signal (cross-session bonus)
    const distinctSessions = candidate.distinct_sessions
      ?? new Set(candidate.evidence_snapshot.map(e => e.session_id)).size;
    candidate.confidence = computeErrorPatternConfidence(
      candidate.evidence_count, distinctSessions, false, candidate.observation_span_days
    );
  } else {
    candidate.confidence = computeConfidence(candidate.evidence_count, candidate.observation_span_days);
  }
}

/**
 * Self-limiting confidence reinforcement.
 * Each reinforcement adds +0.05 * (1 - currentConfidence).
 * High-confidence memories get smaller bumps — prevents echo chamber.
 * Capped at AUTO_CONFIDENCE_CEILING (0.85). Only operator confirmation can exceed this.
 */
export function reinforceConfidence(currentConfidence: number): number {
  const delta = REINFORCE_DELTA * (1 - currentConfidence);
  return Math.min(AUTO_CONFIDENCE_CEILING, currentConfidence + delta);
}

/**
 * Durability factor derived from evidence volume (D1.1). Never stored —
 * `observation_count` is the stored input, durability is computed on read.
 * Logarithmic, so it is self-limiting: 1 obs → 1.0, 3 → 2.1, 20 → 4.0, 1000 → 7.9.
 */
export function durabilityFactor(observationCount: number): number {
  return 1 + Math.log(Math.max(1, observationCount));
}

/**
 * Compute effective confidence at read time, applying time-based decay.
 *
 * Formula: confidence * pow(0.5, (daysSinceSeen / durability) / halfLife)
 * where durability = 1 + ln(observation_count) — well-evidenced memories
 * decay slower (D1.1).
 *
 * Rules:
 * - Explicit memories (confidence >= 1.0) never decay
 * - Dormant projects (no observations in 30+ days) freeze confidence
 * - Archive threshold: effective < 0.2
 *
 * Column semantics (D1.1): the decay clock anchors on `last_seen` (bumped by
 * reinforcement-on-access), falling back to `updated_at` for legacy rows.
 * Content correction (`update_memory`) bumps only `updated_at` — it must NOT
 * reset the decay clock or inflate durability.
 *
 * @param storedConfidence The confidence value stored in the database
 * @param lastSeenAt ISO timestamp of last reinforcement — pass `last_seen ?? updated_at`
 * @param now Current time (injectable for testing)
 * @param projectDormant Whether the project has had no observations in 30+ days
 * @param observationCount Stored evidence/usage count (memories.observation_count)
 * @param type Memory type — selects the per-type decay half-life (T30)
 * @param tags Memory tags — error-pattern (fast decay) + structural (floor) detection (T30)
 */
export function computeEffectiveConfidence(
  storedConfidence: number,
  lastSeenAt: string,
  now: Date = new Date(),
  projectDormant: boolean = false,
  observationCount: number = 1,
  type?: string,
  tags?: readonly string[]
): number {
  // Explicit memories (operator-set confidence of 1.0) never decay (Hard Anchor —
  // checked FIRST so no per-type curve or floor can touch a deliberate anchor).
  if (storedConfidence >= 1.0) return 1.0;

  // Dormant project: freeze confidence — pattern may still be valid, project just inactive
  if (projectDormant) return storedConfidence;

  const lastSeenMs = new Date(lastSeenAt).getTime();
  const daysSinceSeen = (now.getTime() - lastSeenMs) / (1000 * 60 * 60 * 24);

  if (daysSinceSeen <= 0) return storedConfidence;

  // T30: per-type half-life (volatile types fade fast, structural slow).
  const halfLife = resolveHalfLife(type, tags);
  const effectiveDays = daysSinceSeen / durabilityFactor(observationCount);
  const decayed = storedConfidence * Math.pow(0.5, effectiveDays / halfLife);

  // T30: structural facts never decay below their floor (clamped to at most the
  // stored confidence, so a genuinely-low memory is never raised).
  const floor = resolveFloor(type, tags);
  if (floor !== null) return Math.max(decayed, Math.min(floor, storedConfidence));
  return decayed;
}

/**
 * Compute confidence for error pattern candidates.
 * More aggressive than standard: cross-session bonus, fix shortcut.
 *
 * Maps to tiering model:
 * - 2 occurrences, 1 session → ~0.50 (Noted — search only)
 * - 3 occurrences, 2+ sessions → ~0.60 (Pattern — appears in recall)
 * - 3 occurrences, 2+ sessions, with fix → 0.65 (Actionable — proactive)
 * - 5+ occurrences → 0.70+ (Actionable)
 */
export function computeErrorPatternConfidence(
  evidenceCount: number,
  distinctSessions: number,
  hasConsistentFix: boolean,
  observationSpanDays: number = 0
): number {
  let base = computeConfidence(evidenceCount, observationSpanDays);

  // Cross-session bonus: patterns seen in 2+ sessions are more reliable
  if (distinctSessions >= 2) {
    base = Math.min(AUTO_CONFIDENCE_CEILING, base + 0.10);
  }

  // Fix shortcut: if 3+ occurrences and a consistent fix was observed, jump to actionable
  if (hasConsistentFix && evidenceCount >= 3) {
    base = Math.max(base, 0.65);
  }

  return Math.min(AUTO_CONFIDENCE_CEILING, base);
}

/**
 * THE archive line: effective confidence below this makes a memory a
 * decay-archive candidate everywhere (dream decay tier, promotion, maintenance
 * §2, corpus-health panel, effectiveness harness). The decision itself is
 * `isDecayedAtRisk` in src/dreaming/scoring.ts, which re-exports this constant
 * — it lives here (not there) only because scoring.ts already imports this
 * module and the reverse import would be a cycle. ONE definition either way.
 */
export const DECAY_ARCHIVE_THRESHOLD = 0.2;

// ── T30.3 auto-crystallization ──────────────────────────────────────────────
//
// A memory that has proven durable — reinforced past CRYSTALLIZE_MIN_OBSERVATIONS
// and older than CRYSTALLIZE_MIN_AGE_DAYS, while already believed at
// >= CRYSTALLIZE_MIN_CONFIDENCE — is promoted to CRYSTALLIZE_TARGET (0.97):
// "sticky, not a Hard Anchor". At 0.97 it decays very slowly (and, if structural,
// is floored) but stays consolidation-visible and supersedable — so 1.0 remains
// the DELIBERATE operator anchor (T23). The promotion is snapshot-first + audited
// + reversible (see src/promotion/crystallize.ts), and idempotent: once at the
// target it is no longer < target, so it never re-fires.
//
// NOTE on the durability gate: the plan called for "≥3 distinct sessions", but
// memory_access_log carries no session_id and session data lives in a separate DB
// (observations.db) — not cheaply joinable here. CRYSTALLIZE_MIN_AGE_DAYS is the
// cheap, equivalent "durable over time, not a single-session burst" proxy.

/** Confidence a crystallized memory is promoted to — sticky, below the 1.0 anchor. */
export const CRYSTALLIZE_TARGET = 0.97;
/** Reinforcement count (observation_count) required to crystallize. */
export const CRYSTALLIZE_MIN_OBSERVATIONS = 10;
/** Minimum age (days, from created_at) — the cross-session/anti-burst proxy. */
export const CRYSTALLIZE_MIN_AGE_DAYS = 7;
/** A memory must already be believed at least this much to be crystallized. */
export const CRYSTALLIZE_MIN_CONFIDENCE = 0.6;

/** Stored inputs the crystallization gate reads. Subset of the Memory row. */
export interface CrystallizeInputs {
  confidence: number;
  observation_count: number | null;
  is_locked: number;
  created_at: string;
}

/** True if a memory has proven durable enough to auto-crystallize (T30.3). */
export function isCrystallizationCandidate(m: CrystallizeInputs, now: Date = new Date()): boolean {
  if (m.is_locked === 1) return false; // deliberate anchor — leave it
  if (m.confidence >= CRYSTALLIZE_TARGET) return false; // already sticky/anchor — idempotent
  if (m.confidence < CRYSTALLIZE_MIN_CONFIDENCE) return false; // must already be believed
  if ((m.observation_count ?? 0) < CRYSTALLIZE_MIN_OBSERVATIONS) return false;
  const ageDays = (now.getTime() - new Date(m.created_at).getTime()) / 86_400_000;
  return ageDays >= CRYSTALLIZE_MIN_AGE_DAYS;
}
