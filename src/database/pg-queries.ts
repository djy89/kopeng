import type pg from 'pg';
import type { Memory, MemoryType, PromotionRun, ConfidenceTierCount, TopDecayingMemory, CorpusHealthStats, CorpusHealthSampleRow, ScopeAggregateRow } from '../types/types.js';
import { CONTRADICTION_FLAG_TAG } from '../dreaming/contradiction.js';
import type { IMemoryStore } from './interfaces.js';
import { computeContentHash, generateSummary, foldScopeAggregates } from './queries.js';
import { computeDecayScores } from '../promotion/decay.js';
import { ARCHIVED_SQL_PREDICATE } from '../utils/archived.js';

function embeddingBufferToVector(buf: Buffer): string {
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return `[${Array.from(arr).join(',')}]`;
}

function vectorStringToBuffer(vec: string): Buffer {
  const nums = vec.slice(1, -1).split(',').map(Number);
  const arr = new Float32Array(nums);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as number,
    content: row.content as string,
    content_hash: (row.content_hash as string) ?? null,
    summary: (row.summary as string) ?? null,
    type: row.type as MemoryType,
    scope: row.scope as string,
    source: (row.source as string) ?? null,
    source_path: (row.source_path as string) ?? null,
    metadata:
      typeof row.metadata === 'string'
        ? row.metadata
        : JSON.stringify(row.metadata ?? {}),
    embedding: row.embedding
      ? vectorStringToBuffer(row.embedding as string)
      : null,
    embedding_model: (row.embedding_model as string) ?? '',
    created_by: (row.created_by as string) ?? null,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string),
    updated_at:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string),
    archived_at:
      row.archived_at instanceof Date
        ? row.archived_at.toISOString()
        : (row.archived_at as string | null),
    is_archived: row.is_archived ? 1 : 0,
    confidence: (row.confidence as number) ?? 1.0,
    discovery_run_id: (row.discovery_run_id as number) ?? null,
    observation_count: (row.observation_count as number) ?? null,
    last_seen:
      row.last_seen instanceof Date
        ? row.last_seen.toISOString()
        : ((row.last_seen as string) ?? null),
    is_locked: row.is_locked ? 1 : 0,
    deprecated_at:
      row.deprecated_at instanceof Date
        ? row.deprecated_at.toISOString()
        : ((row.deprecated_at as string) ?? null),
    valid_from:
      row.valid_from instanceof Date
        ? row.valid_from.toISOString()
        : ((row.valid_from as string) ?? null),
    last_contradicted:
      row.last_contradicted instanceof Date
        ? row.last_contradicted.toISOString()
        : ((row.last_contradicted as string) ?? null),
  };
}

export class PgQueries implements IMemoryStore {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async store(input: {
    content: string;
    type: MemoryType;
    scope: string;
    source: string | null;
    source_path: string | null;
    metadata: string;
    embedding: Buffer | null;
    embedding_model: string;
    created_by: string | null;
    tags: string[];
    confidence?: number;
    discovery_run_id?: number;
    observation_count?: number;
  }): Promise<{ id: number; deduplicated: boolean }> {
    const contentHash = computeContentHash(input.content);

    // Check for duplicate
    const existing = await this.pool.query(
      'SELECT id FROM memories WHERE content_hash = $1',
      [contentHash]
    );
    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id as number, deduplicated: true };
    }

    const summary = generateSummary(input.content);
    const embeddingValue = input.embedding
      ? embeddingBufferToVector(input.embedding)
      : null;

    // first_seen/last_seen populated at insert (migration v6 left new-row population to D1.1)
    const result = await this.pool.query(
      `INSERT INTO memories (content, content_hash, summary, type, scope, source, source_path, metadata, embedding, embedding_model, created_by, confidence, discovery_run_id, observation_count, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
       RETURNING id`,
      [
        input.content,
        contentHash,
        summary,
        input.type,
        input.scope,
        input.source,
        input.source_path,
        input.metadata,
        embeddingValue,
        input.embedding_model,
        input.created_by,
        // F3/T23 (decision D2): default 0.9 (decay-eligible); explicit 1.0 anchors.
        input.confidence ?? 0.9,
        input.discovery_run_id ?? null,
        Math.max(1, input.observation_count ?? 1),
      ]
    );

    const id = result.rows[0].id as number;

    // Insert tags
    for (const tag of input.tags) {
      await this.pool.query(
        'INSERT INTO memory_tags (memory_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, tag]
      );
    }

    return { id, deduplicated: false };
  }

  async storeBatch(
    items: Parameters<PgQueries['store']>[0][]
  ): Promise<{ ids: number[]; duplicates: number }> {
    const ids: number[] = [];
    let duplicates = 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const item of items) {
        const contentHash = computeContentHash(item.content);

        const existing = await client.query(
          'SELECT id FROM memories WHERE content_hash = $1',
          [contentHash]
        );
        if (existing.rows.length > 0) {
          ids.push(existing.rows[0].id as number);
          duplicates++;
          continue;
        }

        const summary = generateSummary(item.content);
        const embeddingValue = item.embedding
          ? embeddingBufferToVector(item.embedding)
          : null;

        const result = await client.query(
          `INSERT INTO memories (content, content_hash, summary, type, scope, source, source_path, metadata, embedding, embedding_model, created_by, confidence, discovery_run_id, observation_count, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
           RETURNING id`,
          [
            item.content,
            contentHash,
            summary,
            item.type,
            item.scope,
            item.source,
            item.source_path,
            item.metadata,
            embeddingValue,
            item.embedding_model,
            item.created_by,
            // F3/T23 (decision D2): default 0.9 (decay-eligible); explicit 1.0 anchors.
            item.confidence ?? 0.9,
            item.discovery_run_id ?? null,
            Math.max(1, item.observation_count ?? 1),
          ]
        );

        const id = result.rows[0].id as number;
        ids.push(id);

        for (const tag of item.tags) {
          await client.query(
            'INSERT INTO memory_tags (memory_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, tag]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { ids, duplicates };
  }

  async get(id: number): Promise<(Memory & { tags: string[] }) | null> {
    const result = await this.pool.query(
      'SELECT id, content, content_hash, summary, type, scope, source, source_path, metadata, embedding::text, embedding_model, created_by, created_at, updated_at, archived_at, is_archived, confidence, discovery_run_id, observation_count, last_seen, is_locked, deprecated_at, valid_from, last_contradicted FROM memories WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;

    // Log access
    await this.pool.query(
      'INSERT INTO memory_access_log (memory_id) VALUES ($1)',
      [id]
    );

    const memory = rowToMemory(result.rows[0]);
    const tagsResult = await this.pool.query(
      'SELECT tag FROM memory_tags WHERE memory_id = $1',
      [id]
    );
    const tags = tagsResult.rows.map(
      (r: Record<string, unknown>) => r.tag as string
    );

    return { ...memory, tags };
  }

  // Non-reinforcing read — see IMemoryStore.peek.
  async peek(id: number): Promise<(Memory & { tags: string[] }) | null> {
    const result = await this.pool.query(
      'SELECT id, content, content_hash, summary, type, scope, source, source_path, metadata, embedding::text, embedding_model, created_by, created_at, updated_at, archived_at, is_archived, confidence, discovery_run_id, observation_count, last_seen, is_locked, deprecated_at, valid_from, last_contradicted FROM memories WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    const memory = rowToMemory(result.rows[0]);
    const tagsResult = await this.pool.query(
      'SELECT tag FROM memory_tags WHERE memory_id = $1',
      [id]
    );
    return { ...memory, tags: tagsResult.rows.map((r: Record<string, unknown>) => r.tag as string) };
  }

  async update(
    id: number,
    input: {
      content: string;
      type: MemoryType;
      scope: string;
      metadata: string;
      tags: string[];
    }
  ): Promise<{ contentChanged: boolean }> {
    const existing = await this.pool.query(
      'SELECT content_hash, summary FROM memories WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) throw new Error(`Memory ${id} not found`);

    const newHash = computeContentHash(input.content);
    const contentChanged = newHash !== existing.rows[0].content_hash;
    const summary = contentChanged
      ? generateSummary(input.content)
      : existing.rows[0].summary;

    await this.pool.query(
      `UPDATE memories SET
        content = $1,
        content_hash = $2,
        summary = $3,
        type = $4,
        scope = $5,
        metadata = $6,
        updated_at = NOW()
      WHERE id = $7`,
      [input.content, newHash, summary, input.type, input.scope, input.metadata, id]
    );

    // Replace tags
    await this.pool.query('DELETE FROM memory_tags WHERE memory_id = $1', [id]);
    for (const tag of input.tags) {
      await this.pool.query(
        'INSERT INTO memory_tags (memory_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, tag]
      );
    }

    return { contentChanged };
  }

  async setEmbedding(
    id: number,
    embedding: Buffer,
    model: string
  ): Promise<void> {
    const vectorStr = embeddingBufferToVector(embedding);
    await this.pool.query(
      'UPDATE memories SET embedding = $1, embedding_model = $2, updated_at = NOW() WHERE id = $3',
      [vectorStr, model, id]
    );
  }

  async archive(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE memories SET is_archived = true, archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND is_archived = false`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async unarchive(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE memories SET is_archived = false, archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND is_archived = true`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async searchFts(
    query: string,
    limit: number
  ): Promise<{ rowid: number; rank: number }[]> {
    const result = await this.pool.query(
      `SELECT id as rowid, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
       FROM memories
       WHERE search_vector @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, limit]
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      rowid: r.rowid as number,
      rank: parseFloat(r.rank as string),
    }));
  }

  async list(filters: {
    type?: MemoryType;
    scope?: string;
    tags?: string[];
    cursor?: number;
    limit: number;
    include_archived: boolean;
    lite?: boolean;
  }): Promise<{ memories: (Memory & { tags: string[] })[]; has_more: boolean }> {
    const conditions: string[] = [];
    const params: (string | number | string[])[] = [];
    let paramIdx = 1;

    if (!filters.include_archived) {
      conditions.push('m.is_archived = false');
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ANY($${paramIdx}))`);
      params.push(filters.tags);
      paramIdx++;
    }

    if (filters.type) {
      conditions.push(`m.type = $${paramIdx}`);
      params.push(filters.type);
      paramIdx++;
    }
    if (filters.scope) {
      conditions.push(`LOWER(m.scope) = LOWER($${paramIdx})`);
      params.push(filters.scope);
      paramIdx++;
    }
    if (filters.cursor) {
      conditions.push(`m.id < $${paramIdx}`);
      params.push(filters.cursor);
      paramIdx++;
    }

    // Lite drops the embedding column — the vector is by far the widest column
    // (~6 KB serialized per row) and list consumers like the viz never read it.
    const embeddingCol = filters.lite ? '' : ' m.embedding::text,';
    let sql =
      `SELECT m.id, m.content, m.content_hash, m.summary, m.type, m.scope, m.source, m.source_path, m.metadata,${embeddingCol} m.embedding_model, m.created_by, m.created_at, m.updated_at, m.archived_at, m.is_archived, m.confidence, m.discovery_run_id, m.observation_count, m.last_seen, m.is_locked FROM memories m`;

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY m.id DESC LIMIT $${paramIdx}`;
    params.push(filters.limit + 1);

    const result = await this.pool.query(sql, params);
    const rows = result.rows;
    const hasMore = rows.length > filters.limit;
    const memoryRows = rows.slice(0, filters.limit);

    // Batch tag lookup — one query for the whole page instead of one per row.
    const ids = memoryRows.map((r: Record<string, unknown>) => r.id as number);
    const tagsById = new Map<number, string[]>();
    if (ids.length > 0) {
      const tagsResult = await this.pool.query(
        'SELECT memory_id, tag FROM memory_tags WHERE memory_id = ANY($1)',
        [ids]
      );
      for (const r of tagsResult.rows as { memory_id: number; tag: string }[]) {
        const bucket = tagsById.get(r.memory_id);
        if (bucket) bucket.push(r.tag);
        else tagsById.set(r.memory_id, [r.tag]);
      }
    }

    const memories: (Memory & { tags: string[] })[] = memoryRows.map(
      (row: Record<string, unknown>) => ({
        ...rowToMemory(row),
        tags: tagsById.get(row.id as number) ?? [],
      })
    );

    return { memories, has_more: hasMore };
  }

  async listByIdRange(opts: {
    after_id: number;
    max_id?: number;
    limit: number;
    scope?: string;
  }): Promise<(Memory & { tags: string[] })[]> {
    const conditions = ['m.is_archived = false'];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    conditions.push(`m.id > $${paramIdx}`);
    params.push(opts.after_id);
    paramIdx++;
    if (opts.max_id !== undefined) {
      conditions.push(`m.id <= $${paramIdx}`);
      params.push(opts.max_id);
      paramIdx++;
    }
    if (opts.scope) {
      conditions.push(`LOWER(m.scope) = LOWER($${paramIdx})`);
      params.push(opts.scope);
      paramIdx++;
    }

    const sql =
      'SELECT m.id, m.content, m.content_hash, m.summary, m.type, m.scope, m.source, m.source_path, m.metadata, m.embedding::text, m.embedding_model, m.created_by, m.created_at, m.updated_at, m.archived_at, m.is_archived, m.confidence, m.discovery_run_id, m.observation_count, m.last_seen, m.is_locked FROM memories m' +
      ` WHERE ${conditions.join(' AND ')} ORDER BY m.id ASC LIMIT $${paramIdx}`;
    params.push(opts.limit);

    const result = await this.pool.query(sql, params);
    const memories: (Memory & { tags: string[] })[] = [];
    for (const row of result.rows) {
      const memory = rowToMemory(row);
      const tagsResult = await this.pool.query(
        'SELECT tag FROM memory_tags WHERE memory_id = $1',
        [memory.id]
      );
      const tags = tagsResult.rows.map(
        (r: Record<string, unknown>) => r.tag as string
      );
      memories.push({ ...memory, tags });
    }
    return memories;
  }

  async getFilteredIds(filters: {
    type?: MemoryType;
    scope?: string;
    tags?: string[];
    include_archived: boolean;
  }): Promise<number[]> {
    const conditions: string[] = [];
    const params: (string | number | string[])[] = [];
    let paramIdx = 1;

    if (!filters.include_archived) {
      conditions.push('m.is_archived = false');
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ANY($${paramIdx}))`);
      params.push(filters.tags);
      paramIdx++;
    }

    if (filters.type) {
      conditions.push(`m.type = $${paramIdx}`);
      params.push(filters.type);
      paramIdx++;
    }
    if (filters.scope) {
      conditions.push(`LOWER(m.scope) = LOWER($${paramIdx})`);
      params.push(filters.scope);
      paramIdx++;
    }

    let sql = 'SELECT m.id FROM memories m';

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map((r: Record<string, unknown>) => r.id as number);
  }

  async loadAllEmbeddings(): Promise<{ id: number; embedding: Buffer }[]> {
    const result = await this.pool.query(
      'SELECT id, embedding::text FROM memories WHERE embedding IS NOT NULL AND is_archived = false'
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      embedding: vectorStringToBuffer(r.embedding as string),
    }));
  }

  async getCount(): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM memories WHERE is_archived = false'
    );
    return parseInt(result.rows[0].count, 10);
  }

  async getFtsCount(): Promise<number> {
    // In PostgreSQL, every row with content has a tsvector — count non-null search_vectors
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM memories WHERE search_vector IS NOT NULL'
    );
    return parseInt(result.rows[0].count, 10);
  }

  async getTypeStats(): Promise<Record<string, number>> {
    const result = await this.pool.query(
      'SELECT type, COUNT(*) as count FROM memories WHERE is_archived = false GROUP BY type'
    );
    const stats: Record<string, number> = {};
    for (const row of result.rows) {
      stats[row.type as string] = parseInt(row.count, 10);
    }
    return stats;
  }

  async getScopeStats(): Promise<Record<string, number>> {
    const result = await this.pool.query(
      'SELECT scope, COUNT(*) as count FROM memories WHERE is_archived = false GROUP BY scope'
    );
    const stats: Record<string, number> = {};
    for (const row of result.rows) {
      stats[row.scope as string] = parseInt(row.count, 10);
    }
    return stats;
  }

  async updateConfidence(id: number, confidence: number): Promise<void> {
    await this.pool.query(
      'UPDATE memories SET confidence = $1, updated_at = NOW() WHERE id = $2',
      [confidence, id]
    );
  }

  async updateLocked(id: number, locked: boolean): Promise<void> {
    await this.pool.query(
      'UPDATE memories SET is_locked = $1, updated_at = NOW() WHERE id = $2',
      [locked, id]
    );
  }

  async trimAccessLog(days: number): Promise<number> {
    if (days <= 0) return 0; // 0 = keep forever — never run the DELETE
    // Backend-native cutoff (CX-7): interval arithmetic in PG, not a JS string.
    const result = await this.pool.query(
      'DELETE FROM memory_access_log WHERE accessed_at < now() - make_interval(days => $1)',
      [days]
    );
    return result.rowCount ?? 0;
  }

  async reinforceOnAccess(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      'UPDATE memories SET observation_count = COALESCE(observation_count, 1) + 1, last_seen = NOW() WHERE id = ANY($1)',
      [ids]
    );
  }

  async setTemporalMarkers(id: number, markers: {
    deprecated_at?: string | null;
    valid_from?: string | null;
    last_contradicted?: string | null;
  }): Promise<void> {
    const cols = (['deprecated_at', 'valid_from', 'last_contradicted'] as const)
      .filter(c => markers[c] !== undefined);
    if (cols.length === 0) return;
    // No updated_at/last_seen touch — deprecation must not reset the decay clock.
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await this.pool.query(
      `UPDATE memories SET ${setClause} WHERE id = $1`,
      [id, ...cols.map(c => markers[c])]
    );
  }

  async markContradicted(ids: number[], atIso: string): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      'UPDATE memories SET last_contradicted = $1, observation_count = 1 WHERE id = ANY($2)',
      [atIso, ids]
    );
  }

  async rebuildFts(): Promise<void> {
    // In PostgreSQL with GENERATED ALWAYS tsvector, FTS is always up to date.
    // We can force a reindex of the GIN index for maintenance.
    await this.pool.query('REINDEX INDEX idx_memories_search');
  }

  async getConfidenceDistribution(): Promise<ConfidenceTierCount[]> {
    const result = await this.pool.query<{ type: MemoryType; tier: ConfidenceTierCount['tier']; count: string }>(`
      SELECT
        type,
        CASE
          WHEN confidence <= 0.55 THEN 'noted'
          WHEN confidence <= 0.65 THEN 'pattern'
          WHEN confidence <= 0.85 THEN 'actionable'
          ELSE 'confirmed'
        END AS tier,
        COUNT(*) AS count
      FROM memories
      WHERE is_archived = false
      GROUP BY type, tier
    `);
    return result.rows.map(r => ({ type: r.type, tier: r.tier, count: parseInt(r.count, 10) }));
  }

  async getTopDecaying(limit: number): Promise<TopDecayingMemory[]> {
    const scores = await computeDecayScores(this.pool, null);
    if (scores.length === 0) return [];

    const top = scores
      .slice()
      .sort((a, b) => a.totalScore - b.totalScore)
      .slice(0, limit);
    if (top.length === 0) return [];

    const ids = top.map(s => s.memoryId);
    const rows = (await this.pool.query<{
      id: number;
      type: MemoryType;
      scope: string;
      summary: string | null;
      content: string;
      confidence: number;
      last_accessed: Date | null;
      tags: string[] | null;
    }>(
      `SELECT
         m.id,
         m.type,
         m.scope,
         m.summary,
         m.content,
         m.confidence,
         MAX(COALESCE(a.accessed_at, m.created_at)) AS last_accessed,
         ARRAY_AGG(t.tag) FILTER (WHERE t.tag IS NOT NULL) AS tags
       FROM memories m
       LEFT JOIN memory_access_log a ON a.memory_id = m.id
       LEFT JOIN memory_tags t ON t.memory_id = m.id
       WHERE m.id = ANY($1::int[])
       GROUP BY m.id`,
      [ids]
    )).rows;

    const byId = new Map(rows.map(r => [r.id, r]));
    const now = Date.now();
    return top
      .map(score => {
        const row = byId.get(score.memoryId);
        if (!row) return null;
        const lastAccessed = row.last_accessed ? row.last_accessed.getTime() : now;
        const daysSinceAccess = Math.max(0, (now - lastAccessed) / 86400000);
        return {
          id: row.id,
          type: row.type,
          scope: row.scope,
          summary: row.summary ?? row.content?.slice(0, 200) ?? '',
          total_score: score.totalScore,
          recency_score: score.recencyScore,
          frequency_score: score.frequencyScore,
          days_since_access: daysSinceAccess,
          confidence: row.confidence ?? 1.0,
          tags: row.tags ?? [],
        } as TopDecayingMemory;
      })
      .filter((r): r is TopDecayingMemory => r !== null);
  }

  async getLastPromotionRun(): Promise<PromotionRun | null> {
    const result = await this.pool.query(
      'SELECT * FROM promotion_runs ORDER BY started_at DESC, id DESC LIMIT 1'
    );
    return result.rows.length > 0 ? pgRowToPromotionRun(result.rows[0]) : null;
  }

  async listPromotionRuns(limit: number): Promise<PromotionRun[]> {
    const result = await this.pool.query(
      'SELECT * FROM promotion_runs ORDER BY started_at DESC, id DESC LIMIT $1',
      [limit]
    );
    return result.rows.map(pgRowToPromotionRun);
  }

  async getCorpusHealthStats(): Promise<CorpusHealthStats> {
    // Three independent full-corpus counts, so they go out CONCURRENTLY rather
    // than as three sequential round-trips. legacy_anchor_count is the reason
    // this matters: its predicate (is_locked = false AND (confidence >= 1.0 OR
    // a metadata JSON probe)) cannot use an index — it is a sequential scan with
    // a per-row JSON read — and it was added as a third serial hop in front of
    // the already-expensive corpus-health compute. Contained today (one
    // 60s-memoized ops endpoint), but there is no reason to pay for it in series.
    //
    // legacy_anchor_count is TRANSITIONAL: it counts rows still anchored only by
    // a deprecated spelling (confidence >= 1.0 / metadata.pinned) and reads 0
    // once a corpus is migrated onto is_locked. DROP the metric and this query
    // when it reaches 0 corpus-wide — the scan has no other consumer.
    const [aggRes, flaggedRes, legacyAnchorRes] = await Promise.all([
      this.pool.query<{ count: string; mean: number | null }>(
        'SELECT COUNT(*) AS count, AVG(confidence) AS mean FROM memories WHERE is_archived = false'
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT mt.memory_id) AS count
         FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id
         WHERE mt.tag = $1 AND m.is_archived = false`,
        [CONTRADICTION_FLAG_TAG]
      ),
      // WS7.4 B3: rows still anchored by a DEPRECATED spelling and not already
      // is_locked. metadata is already jsonb — ->>'pinned' stringifies the raw
      // scalar, so a JSON boolean true reads 'true' and a JSON number 1 reads
      // '1' (no collision with the SQLite json_extract shape, above).
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memories
         WHERE ${ARCHIVED_SQL_PREDICATE} = false
           AND is_locked = false
           AND (confidence >= 1.0 OR (metadata::jsonb ->> 'pinned') = 'true')`
      ),
    ]);
    const agg = aggRes.rows[0];
    const flagged = flaggedRes.rows[0];
    const legacyAnchor = legacyAnchorRes.rows[0];
    const activeCount = parseInt(agg.count, 10);
    return {
      active_count: activeCount,
      // confidence is DOUBLE PRECISION so AVG already arrives as a number; the
      // Number() is a defensive no-op. null when the corpus is empty.
      mean_confidence: activeCount > 0 && agg.mean != null ? Number(agg.mean) : null,
      contradiction_flagged_count: parseInt(flagged.count, 10),
      legacy_anchor_count: parseInt(legacyAnchor.count, 10),
    };
  }

  async getCorpusHealthSample(limit: number): Promise<CorpusHealthSampleRow[]> {
    const result = await this.pool.query<{
      id: number;
      confidence: number;
      observation_count: number | null;
      last_seen: Date | string | null;
      updated_at: Date | string;
      embedding: string | null;
      scope: string;
      is_locked: boolean;
      metadata: string | Record<string, unknown> | null;
      type: string;
      tags: string[] | null;
    }>(
      `SELECT m.id, m.confidence, m.observation_count, m.last_seen, m.updated_at, m.embedding::text AS embedding, m.scope, m.is_locked, m.metadata, m.type,
              (SELECT array_agg(tag) FROM memory_tags t WHERE t.memory_id = m.id) AS tags
       FROM memories m WHERE m.is_archived = false ORDER BY m.id ASC LIMIT $1`,
      [limit]
    );
    return result.rows.map(r => ({
      id: r.id,
      confidence: r.confidence,
      observation_count: r.observation_count ?? null,
      last_seen: r.last_seen instanceof Date ? r.last_seen.toISOString() : (r.last_seen ?? null),
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      embedding: r.embedding ? vectorStringToBuffer(r.embedding) : null,
      scope: r.scope,
      is_locked: !!r.is_locked,
      // jsonb arrives pre-parsed from the driver; classifyDupPair expects the string form
      metadata: r.metadata == null ? null : typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata),
      type: r.type,
      tags: r.tags ?? [],
    }));
  }

  async getScopeAggregates(): Promise<ScopeAggregateRow[]> {
    // Same shape as the SQLite implementation; `CASE WHEN is_archived THEN`
    // rather than a backend-specific comparison. Timestamps normalized to ISO
    // here because the pg driver hands back Date objects, and foldScopeAggregates
    // compares them as strings.
    const result = await this.pool.query<{
      scope: string; type: string; n: string | number; active: string | number;
      first_write: Date | string | null; last_write: Date | string | null;
    }>(
      `SELECT scope, type,
              COUNT(*) AS n,
              SUM(CASE WHEN is_archived THEN 0 ELSE 1 END) AS active,
              MIN(created_at) AS first_write,
              MAX(created_at) AS last_write
       FROM memories
       GROUP BY scope, type`
    );
    const iso = (v: Date | string | null) => (v instanceof Date ? v.toISOString() : v);
    return foldScopeAggregates(result.rows.map(r => ({
      scope: r.scope,
      type: r.type,
      n: Number(r.n),
      active: Number(r.active),
      first_write: iso(r.first_write),
      last_write: iso(r.last_write),
    })));
  }

  async countActiveByScope(scope: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM memories WHERE scope = $1 AND ${ARCHIVED_SQL_PREDICATE} = false`,
      [scope]
    );
    return parseInt(result.rows[0].count, 10);
  }

  async countActiveWithMetadataKey(key: string): Promise<number> {
    // metadata is JSONB here, so the native top-level key-existence check is
    // both correct and cheaper than the SQLite side's LIKE (which the Task 10
    // brief allows as advisory). jsonb_exists() is the function form of `?`.
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM memories WHERE ${ARCHIVED_SQL_PREDICATE} = false AND jsonb_exists(metadata, $1)`,
      [key]
    );
    return parseInt(result.rows[0].count, 10);
  }
}

function pgRowToPromotionRun(row: Record<string, unknown>): PromotionRun {
  const started = row.started_at;
  const completed = row.completed_at;
  return {
    id: typeof row.id === 'string' ? parseInt(row.id, 10) : (row.id as number),
    started_at: started instanceof Date ? started.toISOString() : (started as string),
    completed_at: completed instanceof Date ? completed.toISOString() : ((completed as string) ?? null),
    status: row.status as PromotionRun['status'],
    dry_run: row.dry_run === true,
    archive_threshold: (row.archive_threshold as number) ?? null,
    similarity_threshold: (row.similarity_threshold as number) ?? null,
    decay_computed: (row.decay_computed as number) ?? 0,
    decay_avg_score: (row.decay_avg_score as number) ?? null,
    decay_below_threshold: (row.decay_below_threshold as number) ?? 0,
    consolidation_candidates: (row.consolidation_candidates as number) ?? 0,
    consolidation_duplicates: (row.consolidation_duplicates as number) ?? 0,
    consolidation_merge_targets: (row.consolidation_merge_targets as number) ?? 0,
    memories_archived: (row.memories_archived as number) ?? 0,
    duration_ms: (row.duration_ms as number) ?? null,
    error: (row.error as string) ?? null,
  };
}
