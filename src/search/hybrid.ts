import type { IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import type { VectorSearchResult } from '../embeddings/index.js';
import { embed } from '../embeddings/embedder.js';
import { rerank, isRerankerReady, initReranker } from './reranker.js';
import type { MemoryType, SearchResult } from '../types/types.js';
import { computeEffectiveConfidence } from '../discovery/confidence.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

interface HybridSearchOptions {
  query: string;
  mode: 'hybrid' | 'semantic' | 'keyword';
  type?: MemoryType;
  scope?: string;
  tags?: string[];
  limit: number;
  offset: number;
  include_archived: boolean;
  rerank?: boolean;
  rerank_candidates?: number;
  /** Minimum confidence for results. Default: no filter. */
  min_confidence?: number;
  /** Include auto-discovered memories. Default: true. */
  include_discoveries?: boolean;
}

export async function hybridSearch(
  queries: IMemoryStore,
  embeddingIndex: IVectorSearch,
  options: HybridSearchOptions
): Promise<{ results: SearchResult[]; total: number; reranked: boolean }> {
  const { query, mode, limit, offset } = options;
  const shouldRerank = options.rerank ?? config.reranker.enabled;
  const rerankCandidates = options.rerank_candidates ?? config.reranker.defaultCandidates;

  // Pre-filter candidates by type/scope/tags
  let candidateIds: number[] | undefined;
  if (options.type || options.scope || options.tags?.length) {
    candidateIds = await queries.getFilteredIds({
      type: options.type,
      scope: options.scope,
      tags: options.tags,
      include_archived: options.include_archived,
    });
    if (candidateIds.length === 0) {
      return { results: [], total: 0, reranked: false };
    }
  }

  let semanticResults: VectorSearchResult[] = [];
  let ftsResults: { rowid: number; rank: number }[] = [];
  // When reranking, fetch more candidates for the reranker to work with
  const fetchLimit = shouldRerank
    ? Math.max(rerankCandidates, limit + offset + 50)
    : limit + offset + 50;

  // Semantic search
  if (mode !== 'keyword' && embeddingIndex.isReady) {
    const queryEmbedding = await embed(query);
    semanticResults = await embeddingIndex.search(queryEmbedding, candidateIds, fetchLimit);
  }

  // Keyword search
  if (mode !== 'semantic') {
    ftsResults = await queries.searchFts(query, fetchLimit);
    // If we have candidate filters, intersect
    if (candidateIds) {
      const idSet = new Set(candidateIds);
      ftsResults = ftsResults.filter(r => idSet.has(r.rowid));
    }
  }

  // Merge results
  let scoredIds: Map<number, number>;

  if (mode === 'semantic') {
    scoredIds = new Map(semanticResults.map(r => [r.id, r.score]));
  } else if (mode === 'keyword') {
    // Normalize FTS rank (higher is better, rank is negative BM25)
    scoredIds = new Map();
    ftsResults.forEach((r, i) => {
      scoredIds.set(r.rowid, 1 / (1 + i)); // simple rank-based score
    });
  } else {
    // Hybrid: reciprocal rank fusion
    scoredIds = reciprocalRankFusion(semanticResults, ftsResults, config.search.rrfK);
  }

  // Sort by score descending
  const sortedEntries = [...scoredIds.entries()]
    .sort((a, b) => b[1] - a[1]);

  // Reranking pass
  if (shouldRerank && sortedEntries.length > 0) {
    // Lazy-load the reranker on first use
    if (!isRerankerReady()) {
      try {
        await initReranker();
      } catch (err) {
        logger.warn('Reranker failed to load, returning results without reranking:', err);
        return buildResults(queries, sortedEntries, offset, limit, mode, false, options);
      }
    }

    // Collect top-N candidates for reranking, applying the confidence and
    // discovery filters up front so cross-encoder calls aren't spent on
    // results that would be dropped anyway. Filtered-out slots are backfilled
    // from lower-ranked entries.
    const minConfidence = options.min_confidence;
    const includeDiscoveries = options.include_discoveries ?? true;
    const candidates: { id: number; content: string; originalScore: number }[] = [];
    const candidateMeta = new Map<number, { memory: SearchResult['memory']; effectiveConfidence: number }>();

    for (const [id, score] of sortedEntries) {
      if (candidates.length >= rerankCandidates) break;
      const memory = await queries.get(id);
      if (!memory) continue;
      // FTS rows survive archival (the trigger only fires on content/summary
      // updates), so the keyword path must honor include_archived here — the
      // candidateIds pre-filter only exists when type/scope/tags are set.
      if (memory.is_archived && !options.include_archived) continue;
      if (!includeDiscoveries && memory.type === 'discovery') continue;

      // Decay clock anchors on last_seen (reinforcement-on-access); durability from
      // observation_count slows decay for well-evidenced memories (D1.1). The dormant
      // freeze is intentionally not wired here — see maintenance.ts.
      const effectiveConfidence = computeEffectiveConfidence(
        memory.confidence,
        memory.last_seen ?? memory.updated_at,
        new Date(),
        false,
        memory.observation_count ?? 1,
        memory.type,
        memory.tags
      );
      if (minConfidence !== undefined && effectiveConfidence < minConfidence) continue;

      candidateMeta.set(id, { memory, effectiveConfidence });
      candidates.push({ id, content: memory.content, originalScore: score });
    }

    if (candidates.length > 0) {
      try {
        const reranked = await rerank(query, candidates);

        // Blend confidence into the final ordering. Rerank scores are raw
        // logits (~-12 to +10), so sigmoid-normalize to (0,1) before the
        // multiplicative blend — same formula as buildResults.
        const confidenceFloor = config.discovery?.confidenceFloor ?? 0.5;
        const matchType = mode === 'hybrid' ? 'hybrid' : mode;
        const scored: SearchResult[] = [];

        for (const r of reranked) {
          const meta = candidateMeta.get(r.id);
          if (!meta) continue;
          const normalized = 1 / (1 + Math.exp(-r.rerank_score));
          const adjustedScore =
            normalized * (confidenceFloor + (1 - confidenceFloor) * meta.effectiveConfidence);
          scored.push({
            memory: meta.memory,
            score: adjustedScore,
            rerank_score: r.rerank_score,
            match_type: matchType,
          });
        }

        scored.sort((a, b) => b.score - a.score);
        const results = partitionByDiscovery(scored.slice(offset), limit);
        return { results, total: reranked.length, reranked: true };
      } catch (err) {
        logger.warn('Reranking failed, falling back to standard results:', err);
      }
    }
  }

  return buildResults(queries, sortedEntries, offset, limit, mode, false, options);
}

async function buildResults(
  queries: IMemoryStore,
  sortedEntries: [number, number][],
  offset: number,
  limit: number,
  mode: 'hybrid' | 'semantic' | 'keyword',
  reranked: boolean,
  options?: HybridSearchOptions
): Promise<{ results: SearchResult[]; total: number; reranked: boolean }> {
  const confidenceFloor = config.discovery?.confidenceFloor ?? 0.5;
  const minConfidence = options?.min_confidence;
  const includeDiscoveries = options?.include_discoveries ?? true;

  const sliced = sortedEntries.slice(offset, offset + limit * 2); // fetch extra for partitioning
  const filtered: SearchResult[] = [];

  for (const [id, rawScore] of sliced) {
    const memory = await queries.get(id);
    if (!memory) continue;

    // FTS rows survive archival — honor include_archived on the keyword path
    // (the candidateIds pre-filter only exists when type/scope/tags are set).
    if (memory.is_archived && !options?.include_archived) continue;

    // Skip discoveries if not included
    if (!includeDiscoveries && memory.type === 'discovery') continue;

    // Apply confidence blending: score * (floor + (1-floor) * effectiveConfidence)
    const effectiveConf = computeEffectiveConfidence(
      memory.confidence,
      memory.last_seen ?? memory.updated_at,
      new Date(),
      false,
      memory.observation_count ?? 1,
      memory.type,
      memory.tags
    );

    // Apply min_confidence filter
    if (minConfidence !== undefined && effectiveConf < minConfidence) continue;

    const adjustedScore = rawScore * (confidenceFloor + (1 - confidenceFloor) * effectiveConf);

    const matchType = mode === 'hybrid' ? 'hybrid' : mode;
    filtered.push({ memory, score: adjustedScore, match_type: matchType });
  }

  const results = partitionByDiscovery(filtered, limit);

  return { results, total: sortedEntries.length, reranked };
}

const MAX_DISCOVERY_RATIO = 0.3; // 30% cap on discovery results

/**
 * Result partitioning: cap discoveries at MAX_DISCOVERY_RATIO of limit, fill
 * the remaining slots with explicit memories, merge sorted by final score.
 */
function partitionByDiscovery(results: SearchResult[], limit: number): SearchResult[] {
  const maxDiscoveries = Math.floor(limit * MAX_DISCOVERY_RATIO);
  const discoverySlice = results
    .filter(r => r.memory.type === 'discovery')
    .slice(0, maxDiscoveries);
  const explicitSlice = results
    .filter(r => r.memory.type !== 'discovery')
    .slice(0, limit - discoverySlice.length);

  return [...explicitSlice, ...discoverySlice]
    .sort((a, b) => b.score - a.score);
}

function reciprocalRankFusion(
  semantic: VectorSearchResult[],
  fts: { rowid: number; rank: number }[],
  k: number
): Map<number, number> {
  const scores = new Map<number, number>();

  semantic.forEach((r, i) => {
    const rrf = 1 / (k + i + 1);
    scores.set(r.id, (scores.get(r.id) || 0) + rrf);
  });

  fts.forEach((r, i) => {
    const rrf = 1 / (k + i + 1);
    scores.set(r.rowid, (scores.get(r.rowid) || 0) + rrf);
  });

  return scores;
}
