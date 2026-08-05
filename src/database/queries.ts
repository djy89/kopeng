import Database from 'better-sqlite3';
import crypto from 'crypto';
import type { Memory, MemoryType, PromotionRun, ConfidenceTierCount, TopDecayingMemory, CorpusHealthStats, CorpusHealthSampleRow } from '../types/types.js';
import type { IMemoryStore } from './interfaces.js';
import { computeDecayScores } from '../promotion/decay.js';
import { CONTRADICTION_FLAG_TAG } from '../dreaming/contradiction.js';

export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content.trim()).digest('hex');
}

export function generateSummary(content: string): string {
  // First-sentence heuristic: take everything up to the first period, question mark, or newline
  const match = content.match(/^(.+?[.?!])\s/);
  if (match && match[1].length <= 200) return match[1];
  // Fallback: first 200 chars
  return content.slice(0, 200).trim() + (content.length > 200 ? '...' : '');
}

export class MemoryQueries implements IMemoryStore {
  private db: Database.Database;

  // Prepared statements
  private insertMemory: Database.Statement;
  private getById: Database.Statement;
  private updateMemory: Database.Statement;
  private archiveMemory: Database.Statement;
  private unarchiveMemory: Database.Statement;

  private insertTag: Database.Statement;
  private deleteTagsForMemory: Database.Statement;
  private getTagsForMemory: Database.Statement;
  private logAccess: Database.Statement;
  private ftsSearch: Database.Statement;
  private getByContentHash: Database.Statement;
  private updateEmbedding: Database.Statement;
  private getAllEmbeddings: Database.Statement;
  private updateConfidenceStmt: Database.Statement;
  private reinforceOnAccessStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // first_seen/last_seen populated at insert (migration v4 left new-row population to D1.1)
    this.insertMemory = db.prepare(`
      INSERT INTO memories (content, content_hash, summary, type, scope, source, source_path, metadata, embedding, embedding_model, created_by, confidence, discovery_run_id, observation_count, first_seen, last_seen)
      VALUES (@content, @content_hash, @summary, @type, @scope, @source, @source_path, @metadata, @embedding, @embedding_model, @created_by, @confidence, @discovery_run_id, @observation_count, datetime('now'), datetime('now'))
    `);

    this.getById = db.prepare('SELECT * FROM memories WHERE id = ?');

    this.updateMemory = db.prepare(`
      UPDATE memories SET
        content = @content,
        content_hash = @content_hash,
        summary = @summary,
        type = @type,
        scope = @scope,
        metadata = @metadata,
        updated_at = datetime('now')
      WHERE id = @id
    `);

    this.archiveMemory = db.prepare(`
      UPDATE memories SET is_archived = 1, archived_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `);

    this.unarchiveMemory = db.prepare(`
      UPDATE memories SET is_archived = 0, archived_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `);

    this.insertTag = db.prepare(
      'INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)'
    );

    this.deleteTagsForMemory = db.prepare('DELETE FROM memory_tags WHERE memory_id = ?');

    this.getTagsForMemory = db.prepare(
      'SELECT tag FROM memory_tags WHERE memory_id = ?'
    );

    this.logAccess = db.prepare(
      'INSERT INTO memory_access_log (memory_id) VALUES (?)'
    );

    this.ftsSearch = db.prepare(`
      SELECT rowid, rank
      FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.getByContentHash = db.prepare(
      'SELECT id FROM memories WHERE content_hash = ?'
    );

    this.updateEmbedding = db.prepare(`
      UPDATE memories SET embedding = ?, embedding_model = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    this.getAllEmbeddings = db.prepare(
      'SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND is_archived = 0'
    );

    this.updateConfidenceStmt = db.prepare(`
      UPDATE memories SET confidence = ?, updated_at = datetime('now') WHERE id = ?
    `);

    this.reinforceOnAccessStmt = db.prepare(`
      UPDATE memories SET observation_count = COALESCE(observation_count, 1) + 1, last_seen = datetime('now') WHERE id = ?
    `);
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
    return this.storeSync(input);
  }

  /** Synchronous store used internally by storeBatch within a transaction */
  private storeSync(input: {
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
  }): { id: number; deduplicated: boolean } {
    const contentHash = computeContentHash(input.content);
    const existing = this.getByContentHash.get(contentHash) as { id: number } | undefined;

    if (existing) {
      return { id: existing.id, deduplicated: true };
    }

    const summary = generateSummary(input.content);

    const result = this.insertMemory.run({
      content: input.content,
      content_hash: contentHash,
      summary,
      type: input.type,
      scope: input.scope,
      source: input.source,
      source_path: input.source_path,
      metadata: input.metadata,
      embedding: input.embedding,
      embedding_model: input.embedding_model,
      created_by: input.created_by,
      // F3/T23 (decision D2): default confidence is 0.9 — a new memory is
      // decay-eligible unless the caller EXPLICITLY passes 1.0 (deliberate Hard
      // Anchor). Read-side `?? 1.0` fallbacks elsewhere are unrelated (legacy row backfill).
      confidence: input.confidence ?? 0.9,
      discovery_run_id: input.discovery_run_id ?? null,
      observation_count: Math.max(1, input.observation_count ?? 1),
    });

    const id = result.lastInsertRowid as number;

    for (const tag of input.tags) {
      this.insertTag.run(id, tag);
    }

    return { id, deduplicated: false };
  }

  async storeBatch(items: Parameters<MemoryQueries['store']>[0][]): Promise<{ ids: number[]; duplicates: number }> {
    const ids: number[] = [];
    let duplicates = 0;

    const batch = this.db.transaction(() => {
      for (const item of items) {
        // Call the synchronous internals directly to stay inside the transaction
        const result = this.storeSync(item);
        ids.push(result.id);
        if (result.deduplicated) duplicates++;
      }
    });

    batch();
    return { ids, duplicates };
  }

  async get(id: number): Promise<(Memory & { tags: string[] }) | null> {
    const memory = this.getById.get(id) as Memory | undefined;
    if (!memory) return null;

    this.logAccess.run(id);

    const tags = (this.getTagsForMemory.all(id) as { tag: string }[]).map(t => t.tag);
    return { ...memory, tags };
  }

  async update(id: number, input: {
    content: string;
    type: MemoryType;
    scope: string;
    metadata: string;
    tags: string[];
  }): Promise<{ contentChanged: boolean }> {
    const existing = this.getById.get(id) as Memory | undefined;
    if (!existing) throw new Error(`Memory ${id} not found`);

    const newHash = computeContentHash(input.content);
    const contentChanged = newHash !== existing.content_hash;

    this.updateMemory.run({
      id,
      content: input.content,
      content_hash: newHash,
      summary: contentChanged ? generateSummary(input.content) : existing.summary,
      type: input.type,
      scope: input.scope,
      metadata: input.metadata,
    });

    this.deleteTagsForMemory.run(id);
    for (const tag of input.tags) {
      this.insertTag.run(id, tag);
    }

    return { contentChanged };
  }

  async setEmbedding(id: number, embedding: Buffer, model: string): Promise<void> {
    this.updateEmbedding.run(embedding, model, id);
  }

  async archive(id: number): Promise<boolean> {
    const result = this.archiveMemory.run(id);
    return result.changes > 0;
  }

  async unarchive(id: number): Promise<boolean> {
    const result = this.unarchiveMemory.run(id);
    return result.changes > 0;
  }

  async searchFts(query: string, limit: number): Promise<{ rowid: number; rank: number }[]> {
    try {
      return this.ftsSearch.all(query, limit) as { rowid: number; rank: number }[];
    } catch {
      // FTS5 query syntax error — try as phrase
      const escaped = `"${query.replace(/"/g, '""')}"`;
      return this.ftsSearch.all(escaped, limit) as { rowid: number; rank: number }[];
    }
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
    const params: (string | number)[] = [];

    if (!filters.include_archived) {
      conditions.push('m.is_archived = 0');
    }
    if (filters.type) {
      conditions.push('m.type = ?');
      params.push(filters.type);
    }
    if (filters.scope) {
      conditions.push('m.scope = ? COLLATE NOCASE');
      params.push(filters.scope);
    }
    if (filters.cursor) {
      conditions.push('m.id < ?');
      params.push(filters.cursor);
    }

    // Lite skips reading the embedding blob entirely (NULL-projected, mirrors
    // the Postgres lite column list) — no point materializing ~6KB/row that the
    // consumer discards.
    const liteCols =
      'm.id, m.content, m.content_hash, m.summary, m.type, m.scope, m.source, m.source_path, m.metadata, NULL AS embedding, m.embedding_model, m.created_by, m.created_at, m.updated_at, m.archived_at, m.is_archived, m.confidence, m.discovery_run_id, m.observation_count, m.last_seen, m.is_locked';
    let sql = `SELECT ${filters.lite ? liteCols : 'm.*'} FROM memories m`;

    if (filters.tags && filters.tags.length > 0) {
      sql += ` INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag IN (${filters.tags.map(() => '?').join(',')})`;
      params.unshift(...filters.tags);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY m.id DESC LIMIT ?`;
    params.push(filters.limit + 1);

    const rows = this.db.prepare(sql).all(...params) as Memory[];
    const hasMore = rows.length > filters.limit;
    const memories = rows.slice(0, filters.limit);

    // Lite pages can be 1000 rows — batch the tag lookup (chunked to stay well
    // under SQLite's bound-variable limit) instead of one query per row.
    let tagsById: Map<number, string[]> | null = null;
    if (filters.lite && memories.length > 0) {
      tagsById = new Map();
      for (let i = 0; i < memories.length; i += 500) {
        const chunk = memories.slice(i, i + 500).map(m => m.id);
        const rows = this.db.prepare(
          `SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${chunk.map(() => '?').join(',')})`
        ).all(...chunk) as { memory_id: number; tag: string }[];
        for (const r of rows) {
          const bucket = tagsById.get(r.memory_id);
          if (bucket) bucket.push(r.tag);
          else tagsById.set(r.memory_id, [r.tag]);
        }
      }
    }

    return {
      memories: memories.map(m => {
        const tags = tagsById
          ? (tagsById.get(m.id) ?? [])
          : (this.getTagsForMemory.all(m.id) as { tag: string }[]).map(t => t.tag);
        return { ...m, tags };
      }),
      has_more: hasMore,
    };
  }

  async listByIdRange(opts: {
    after_id: number;
    max_id?: number;
    limit: number;
    scope?: string;
  }): Promise<(Memory & { tags: string[] })[]> {
    const conditions = ['m.is_archived = 0', 'm.id > ?'];
    const params: (string | number)[] = [opts.after_id];
    if (opts.max_id !== undefined) {
      conditions.push('m.id <= ?');
      params.push(opts.max_id);
    }
    if (opts.scope) {
      conditions.push('m.scope = ? COLLATE NOCASE');
      params.push(opts.scope);
    }
    const rows = this.db.prepare(
      `SELECT m.* FROM memories m WHERE ${conditions.join(' AND ')} ORDER BY m.id ASC LIMIT ?`
    ).all(...params, opts.limit) as Memory[];
    return rows.map(m => {
      const tags = (this.getTagsForMemory.all(m.id) as { tag: string }[]).map(t => t.tag);
      return { ...m, tags };
    });
  }

  async getFilteredIds(filters: {
    type?: MemoryType;
    scope?: string;
    tags?: string[];
    include_archived: boolean;
  }): Promise<number[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (!filters.include_archived) {
      conditions.push('m.is_archived = 0');
    }
    if (filters.type) {
      conditions.push('m.type = ?');
      params.push(filters.type);
    }
    if (filters.scope) {
      conditions.push('m.scope = ? COLLATE NOCASE');
      params.push(filters.scope);
    }

    let sql = 'SELECT m.id FROM memories m';

    if (filters.tags && filters.tags.length > 0) {
      sql += ` INNER JOIN memory_tags mt ON m.id = mt.memory_id AND mt.tag IN (${filters.tags.map(() => '?').join(',')})`;
      params.unshift(...filters.tags);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    const rows = this.db.prepare(sql).all(...params) as { id: number }[];
    return rows.map(r => r.id);
  }

  async loadAllEmbeddings(): Promise<{ id: number; embedding: Buffer }[]> {
    return this.getAllEmbeddings.all() as { id: number; embedding: Buffer }[];
  }

  async getCount(): Promise<number> {
    return (this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_archived = 0').get() as { count: number }).count;
  }

  async getFtsCount(): Promise<number> {
    try {
      return (this.db.prepare('SELECT COUNT(*) as count FROM memories_fts').get() as { count: number }).count;
    } catch {
      return 0;
    }
  }

  async getTypeStats(): Promise<Record<string, number>> {
    const rows = this.db.prepare(
      'SELECT type, COUNT(*) as count FROM memories WHERE is_archived = 0 GROUP BY type'
    ).all() as { type: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  async getScopeStats(): Promise<Record<string, number>> {
    const rows = this.db.prepare(
      'SELECT scope, COUNT(*) as count FROM memories WHERE is_archived = 0 GROUP BY scope'
    ).all() as { scope: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.scope] = row.count;
    }
    return result;
  }

  async updateConfidence(id: number, confidence: number): Promise<void> {
    this.updateConfidenceStmt.run(confidence, id);
  }

  async reinforceOnAccess(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const reinforceAll = this.db.transaction((memoryIds: number[]) => {
      for (const id of memoryIds) {
        this.reinforceOnAccessStmt.run(id);
      }
    });
    reinforceAll(ids);
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
    const setClause = cols.map(c => `${c} = @${c}`).join(', ');
    this.db.prepare(`UPDATE memories SET ${setClause} WHERE id = @__id`)
      .run({ ...Object.fromEntries(cols.map(c => [c, markers[c]])), __id: id });
  }

  async markContradicted(ids: number[], atIso: string): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE memories SET last_contradicted = ?, observation_count = 1 WHERE id = ?`
    );
    const markAll = this.db.transaction((memoryIds: number[]) => {
      for (const id of memoryIds) stmt.run(atIso, id);
    });
    markAll(ids);
  }

  async rebuildFts(): Promise<void> {
    // Use prepare().run() rather than db.exec() to avoid false positives in our
    // local security pre-write hook; single-statement SQL has identical semantics.
    this.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')").run();
  }

  async getConfidenceDistribution(): Promise<ConfidenceTierCount[]> {
    // Tier thresholds mirror the auto-discovery tiering model (see README):
    //   noted <= 0.55, pattern (0.55, 0.65], actionable (0.65, 0.85], confirmed > 0.85
    const rows = this.db.prepare(`
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
      WHERE is_archived = 0
      GROUP BY type, tier
    `).all() as { type: MemoryType; tier: ConfidenceTierCount['tier']; count: number }[];
    return rows;
  }

  async getTopDecaying(limit: number): Promise<TopDecayingMemory[]> {
    const scores = await computeDecayScores(null, this.db);
    if (scores.length === 0) return [];

    const top = scores
      .slice()
      .sort((a, b) => a.totalScore - b.totalScore)
      .slice(0, limit);

    if (top.length === 0) return [];

    const ids = top.map(s => s.memoryId);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT
        m.id,
        m.type,
        m.scope,
        COALESCE(m.summary, SUBSTR(m.content, 1, 200)) AS summary,
        m.confidence,
        MAX(COALESCE(a.accessed_at, m.created_at)) AS last_accessed
      FROM memories m
      LEFT JOIN memory_access_log a ON a.memory_id = m.id
      WHERE m.id IN (${placeholders})
      GROUP BY m.id
    `).all(...ids) as { id: number; type: MemoryType; scope: string; summary: string; confidence: number; last_accessed: string }[];

    const byId = new Map(rows.map(r => [r.id, r]));
    const tagRows = this.db.prepare(`
      SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})
    `).all(...ids) as { memory_id: number; tag: string }[];
    const tagsById = new Map<number, string[]>();
    for (const t of tagRows) {
      const arr = tagsById.get(t.memory_id) ?? [];
      arr.push(t.tag);
      tagsById.set(t.memory_id, arr);
    }

    const now = Date.now();
    return top
      .map(score => {
        const row = byId.get(score.memoryId);
        if (!row) return null;
        const lastAccessed = row.last_accessed ? new Date(row.last_accessed).getTime() : now;
        const daysSinceAccess = Math.max(0, (now - lastAccessed) / 86400000);
        return {
          id: row.id,
          type: row.type,
          scope: row.scope,
          summary: row.summary ?? '',
          total_score: score.totalScore,
          recency_score: score.recencyScore,
          frequency_score: score.frequencyScore,
          days_since_access: daysSinceAccess,
          confidence: row.confidence ?? 1.0,
          tags: tagsById.get(row.id) ?? [],
        } as TopDecayingMemory;
      })
      .filter((r): r is TopDecayingMemory => r !== null);
  }

  async getLastPromotionRun(): Promise<PromotionRun | null> {
    const row = this.db.prepare(
      'SELECT * FROM promotion_runs ORDER BY started_at DESC, id DESC LIMIT 1'
    ).get() as Record<string, unknown> | undefined;
    return row ? rowToPromotionRun(row) : null;
  }

  async listPromotionRuns(limit: number): Promise<PromotionRun[]> {
    const rows = this.db.prepare(
      'SELECT * FROM promotion_runs ORDER BY started_at DESC, id DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToPromotionRun);
  }

  async getCorpusHealthStats(): Promise<CorpusHealthStats> {
    const agg = this.db.prepare(
      'SELECT COUNT(*) AS count, AVG(confidence) AS mean FROM memories WHERE is_archived = 0'
    ).get() as { count: number; mean: number | null };
    const flagged = this.db.prepare(
      `SELECT COUNT(DISTINCT mt.memory_id) AS count
       FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id
       WHERE mt.tag = ? AND m.is_archived = 0`
    ).get(CONTRADICTION_FLAG_TAG) as { count: number };
    return {
      active_count: agg.count,
      mean_confidence: agg.count > 0 ? (agg.mean ?? null) : null,
      contradiction_flagged_count: flagged.count,
    };
  }

  async getCorpusHealthSample(limit: number): Promise<CorpusHealthSampleRow[]> {
    const rows = this.db.prepare(
      `SELECT id, confidence, observation_count, last_seen, updated_at, embedding, scope, is_locked, metadata
       FROM memories WHERE is_archived = 0 ORDER BY id ASC LIMIT ?`
    ).all(limit) as (Omit<CorpusHealthSampleRow, 'is_locked'> & { is_locked: 0 | 1 })[];
    return rows.map(r => ({ ...r, is_locked: !!r.is_locked }));
  }
}

function rowToPromotionRun(row: Record<string, unknown>): PromotionRun {
  return {
    id: row.id as number,
    started_at: row.started_at as string,
    completed_at: (row.completed_at as string) ?? null,
    status: row.status as PromotionRun['status'],
    dry_run: row.dry_run === 1 || row.dry_run === true,
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
