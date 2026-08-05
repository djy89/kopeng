/**
 * ConsolidationReasoner — the dreaming layer's pluggable reasoning interface (D0.3).
 *
 * Deliberately provider-agnostic: no LLM/Ollama/HTTP types leak in here. A local
 * model adapter (D2.1) and the NoOpReasoner (D0.3) both implement this. The
 * deterministic engine — not the reasoner — owns the rollback-critical write path
 * (invariant #3), so this interface only *classifies* and *proposes*; it never writes.
 */

/** Minimal memory shape the reasoner needs. Decoupled from the full DB `Memory` type. */
export interface CandidateMemory {
  id: number;
  content: string;
  content_hash: string | null;
  summary: string | null;
  tags: string[];
  scope: string;
  confidence: number;
  is_locked: boolean;
  /** T30: memory type — selects the per-type decay half-life in the decay tier.
   *  Optional so legacy fixtures (which omit it) fall back to the default 60d. */
  type?: string;
  created_at: string;
  updated_at: string;
  /** Optional D1.2 inputs — cosine detection, evidence gates, decay scoring.
   *  Absent on legacy fixtures; detectors degrade gracefully without them. */
  embedding?: Float32Array | null;
  metadata?: string | null;
  last_seen?: string | null;
  observation_count?: number | null;
  /** D2.2: set = already superseded. The selector skips band pairs touching a
   *  deprecated memory — its successor relationship is already recorded. */
  deprecated_at?: string | null;
  /** D2.2: both members set = the pair already went through conditional
   *  resolution; the selector does not re-litigate it. */
  last_contradicted?: string | null;
}

/** Relationship between two memories, as judged by the reasoner. */
export type PairRelation =
  | 'duplicate'         // same fact → merge proposal
  | 'preference_change' // temporal supersession (old deprecated, new valid_from)
  | 'conditional'       // both true under different conditions → extract branches
  | 'unrelated'         // no relationship → no-op
  | 'contested';        // looks contradictory but no clear distinguisher → queue for review

/** Per-call execution bounds. Injected at the edge; the reasoner must honor them. */
export interface ReasonerContext {
  timeoutMs: number;
  tokenBudget?: number;
  signal?: AbortSignal;
}

export interface PairVerdict {
  relation: PairRelation;
  /** 0–1. NoOp returns 0. */
  confidence: number;
  rationale: string;
}

export interface ConditionExtraction {
  /** Condition under which memory A holds. */
  conditionA: string;
  /** Condition under which memory B holds. */
  conditionB: string;
  rationale: string;
}

export interface ClusterSynthesis {
  /** Synthesized content merging the cluster. */
  content: string;
  rationale: string;
}

export interface ConsolidationReasoner {
  /** Classify the relationship between two candidate memories. */
  classifyPair(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<PairVerdict>;

  /** For a `conditional` pair, extract the branch conditions. Null if not extractable. */
  extractCondition(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<ConditionExtraction | null>;

  /** Merge a cluster of duplicates into synthesized content. Null if no safe synthesis. */
  synthesizeCluster(members: CandidateMemory[], ctx: ReasonerContext): Promise<ClusterSynthesis | null>;

  /** Stable identifier for provenance/logging (e.g. 'noop', 'ollama:llama3'). */
  readonly name: string;
}
