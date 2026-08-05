import type { VectorEntry } from '../types/types.js';
import type { IVectorSearch } from '../database/interfaces.js';
import { bufferToEmbedding } from './embedder.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

export interface VectorSearchResult {
  id: number;
  score: number;
}

function computeMagnitude(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: Float32Array, aMag: number, b: Float32Array, bMag: number): number {
  if (aMag === 0 || bMag === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot / (aMag * bMag);
}

export class EmbeddingIndex implements IVectorSearch {
  private vectors: Map<number, VectorEntry> = new Map();
  private ready = false;

  async loadFromDatabase(rows: { id: number; embedding: Buffer }[]): Promise<void> {
    const startTime = Date.now();
    this.vectors.clear();

    for (const row of rows) {
      const embedding = bufferToEmbedding(row.embedding);
      const magnitude = computeMagnitude(embedding);
      this.vectors.set(row.id, { embedding, magnitude });
    }

    this.ready = true;
    const elapsed = Date.now() - startTime;
    logger.info(`Embedding index loaded: ${this.vectors.size} vectors in ${elapsed}ms`);

    if (this.vectors.size > config.embedding.maxWarning) {
      logger.warn(`Embedding index has ${this.vectors.size} entries — performance may degrade above ${config.embedding.maxWarning}`);
    }
  }

  async add(id: number, embedding: Float32Array): Promise<void> {
    const magnitude = computeMagnitude(embedding);
    this.vectors.set(id, { embedding, magnitude });
  }

  async remove(id: number): Promise<void> {
    this.vectors.delete(id);
  }

  async search(query: Float32Array, candidateIds?: number[], topK: number = 10): Promise<VectorSearchResult[]> {
    const queryMag = computeMagnitude(query);
    if (queryMag === 0) return [];

    const results: VectorSearchResult[] = [];

    if (candidateIds) {
      for (const id of candidateIds) {
        const entry = this.vectors.get(id);
        if (!entry) continue;
        const score = cosineSimilarity(query, queryMag, entry.embedding, entry.magnitude);
        results.push({ id, score });
      }
    } else {
      for (const [id, entry] of this.vectors) {
        const score = cosineSimilarity(query, queryMag, entry.embedding, entry.magnitude);
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get size(): number {
    return this.vectors.size;
  }
}
