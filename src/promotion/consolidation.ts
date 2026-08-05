import type { IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import logger from '../utils/logger.js';

export interface ConsolidationCandidate {
  memoryId: number;
  similarTo: number;
  similarity: number;
  action: 'merge' | 'archive_duplicate';
}

export async function findConsolidationCandidates(
  queries: IMemoryStore,
  embeddingIndex: IVectorSearch,
  similarityThreshold: number = 0.95
): Promise<ConsolidationCandidate[]> {
  const candidates: ConsolidationCandidate[] = [];
  const seen = new Set<string>();

  // Load all active memory embeddings
  const allEmbeddings = await queries.loadAllEmbeddings();

  if (allEmbeddings.length < 2 || !embeddingIndex.isReady) {
    logger.info('Not enough embeddings for consolidation analysis');
    return candidates;
  }

  // For each memory, find near-duplicates
  for (const entry of allEmbeddings) {
    const embedding = new Float32Array(
      entry.embedding.buffer,
      entry.embedding.byteOffset,
      entry.embedding.byteLength / 4
    );

    const similar = await embeddingIndex.search(embedding, undefined, 5);

    for (const match of similar) {
      if (match.id === entry.id) continue;
      if (match.score < similarityThreshold) continue;

      // Avoid duplicate pairs
      const pairKey = [Math.min(entry.id, match.id), Math.max(entry.id, match.id)].join('-');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      candidates.push({
        memoryId: match.id,
        similarTo: entry.id,
        similarity: match.score,
        action: match.score > 0.99 ? 'archive_duplicate' : 'merge',
      });
    }
  }

  logger.info(`Found ${candidates.length} consolidation candidates`);
  return candidates;
}
