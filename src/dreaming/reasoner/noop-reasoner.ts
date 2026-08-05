import type {
  ConsolidationReasoner, CandidateMemory, ReasonerContext,
  PairVerdict, ConditionExtraction, ClusterSynthesis,
} from './reasoner.js';

/**
 * NoOpReasoner — the zero-LLM default (D0.3).
 *
 * Every method returns the safe, no-change answer: pairs are 'unrelated' with
 * confidence 0, no conditions extracted, no cluster synthesis. With this reasoner
 * the pipeline produces an empty diff and makes zero model calls — the Phase-0
 * harness baseline. When `DREAM_REASONER_ENABLED` is off or the provider is down,
 * the engine degrades to this.
 */
export class NoOpReasoner implements ConsolidationReasoner {
  readonly name = 'noop';

  async classifyPair(_a: CandidateMemory, _b: CandidateMemory, _ctx: ReasonerContext): Promise<PairVerdict> {
    return { relation: 'unrelated', confidence: 0, rationale: 'noop reasoner: no classification' };
  }

  async extractCondition(_a: CandidateMemory, _b: CandidateMemory, _ctx: ReasonerContext): Promise<ConditionExtraction | null> {
    return null;
  }

  async synthesizeCluster(_members: CandidateMemory[], _ctx: ReasonerContext): Promise<ClusterSynthesis | null> {
    return null;
  }
}
