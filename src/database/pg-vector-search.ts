import type pg from 'pg';
import type { IVectorSearch } from './interfaces.js';
import type { VectorSearchResult } from '../embeddings/index.js';
import logger from '../utils/logger.js';

export class PgVectorSearch implements IVectorSearch {
  private pool: pg.Pool;
  private vectorCount = 0;
  private _ready = false;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async loadFromDatabase(
    _rows: { id: number; embedding: Buffer }[]
  ): Promise<void> {
    // For pgvector, embeddings are stored in the DB — no need to load into memory.
    // Just update the count for the isReady / size getters.
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL AND is_archived = false'
    );
    this.vectorCount = parseInt(result.rows[0].count, 10);
    this._ready = true;
    logger.info(`PgVectorSearch ready: ${this.vectorCount} vectors indexed`);
  }

  async add(_id: number, _embedding: Float32Array): Promise<void> {
    // Embedding is already stored by PgQueries.store / setEmbedding.
    // This is a no-op for pgvector since it's DB-native.
    this.vectorCount++;
  }

  async remove(_id: number): Promise<void> {
    // Embedding removal is handled by archive — no separate action needed.
    this.vectorCount = Math.max(0, this.vectorCount - 1);
  }

  async search(
    query: Float32Array,
    candidateIds?: number[],
    topK: number = 10
  ): Promise<VectorSearchResult[]> {
    const vectorStr = `[${Array.from(query).join(',')}]`;

    let sql: string;
    let params: (string | number | number[])[];

    if (candidateIds && candidateIds.length > 0) {
      sql = `
        SELECT id, 1 - (embedding <=> $1::vector) as score
        FROM memories
        WHERE embedding IS NOT NULL AND is_archived = false
          AND id = ANY($2)
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `;
      params = [vectorStr, candidateIds, topK];
    } else {
      sql = `
        SELECT id, 1 - (embedding <=> $1::vector) as score
        FROM memories
        WHERE embedding IS NOT NULL AND is_archived = false
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `;
      params = [vectorStr, topK];
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      score: parseFloat(r.score as string),
    }));
  }

  get isReady(): boolean {
    return this._ready;
  }

  get size(): number {
    return this.vectorCount;
  }
}
