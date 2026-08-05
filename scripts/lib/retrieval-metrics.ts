/**
 * Pure retrieval-quality metrics — P@k, R@k, MRR, NDCG@k.
 *
 * Factored out of `eval-core.ts` (which is REST-coupled) so both the live eval
 * harness (`npm run eval`) and the in-process effectiveness harness
 * (`npm run dream:effectiveness`) compute identical math against the same code.
 * NO I/O, NO REST, NO model — every function here is a pure transform from a
 * ranked id list + a relevant-id set to a number.
 */

/** NDCG@k with binary relevance: a relevant hit at rank i contributes 1/log2(i+2). */
export function computeNDCG(retrievedIds: number[], relevantSet: ReadonlySet<number>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(retrievedIds.length, k); i++) {
    if (relevantSet.has(retrievedIds[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  let idcg = 0;
  const idealCount = Math.min(relevantSet.size, k);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/** Precision@k = |relevant ∩ retrieved| / |retrieved|. 0 when nothing retrieved. */
export function computePrecision(retrievedIds: number[], relevantSet: ReadonlySet<number>): number {
  if (retrievedIds.length === 0) return 0;
  const hits = retrievedIds.filter(id => relevantSet.has(id)).length;
  return hits / retrievedIds.length;
}

/** Recall@k = |relevant ∩ retrieved| / |relevant|. 0 when nothing is relevant. */
export function computeRecall(retrievedIds: number[], relevantSet: ReadonlySet<number>): number {
  if (relevantSet.size === 0) return 0;
  const hits = retrievedIds.filter(id => relevantSet.has(id)).length;
  return hits / relevantSet.size;
}

/** Mean reciprocal rank for a single query: 1/(rank of first relevant hit). 0 if none. */
export function computeMRR(retrievedIds: number[], relevantSet: ReadonlySet<number>): number {
  for (let i = 0; i < retrievedIds.length; i++) {
    if (relevantSet.has(retrievedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface RetrievalScores {
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
  ndcg_at_k: number;
}

/** Score one ranked result list against a relevant-id set, for cutoff k. */
export function scoreQuery(retrievedIds: number[], relevantIds: number[], k: number): RetrievalScores {
  const relevantSet = new Set(relevantIds);
  return {
    precision_at_k: computePrecision(retrievedIds, relevantSet),
    recall_at_k: computeRecall(retrievedIds, relevantSet),
    mrr: computeMRR(retrievedIds, relevantSet),
    ndcg_at_k: computeNDCG(retrievedIds, relevantSet, k),
  };
}
