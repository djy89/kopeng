import type pg from 'pg';
import type Database from 'better-sqlite3';
import logger from '../utils/logger.js';

export interface DecayScore {
  memoryId: number;
  recencyScore: number;    // 0-1 (1 = recently accessed)
  frequencyScore: number;  // 0-1 (1 = frequently accessed)
  typeWeight: number;      // 0.5-1.0
  qualityScore: number;    // 0-1
  totalScore: number;      // weighted combination
}

const TYPE_WEIGHTS: Record<string, number> = {
  feedback: 1.0,
  user: 0.9,
  project: 0.7,
  reference: 0.5,
  discovery: 0.4,
};

const DECAY_HALF_LIFE_DAYS = 30; // Score halves every 30 days without access

export async function computeDecayScores(
  pool: pg.Pool | null,
  sqliteDb: Database.Database | null
): Promise<DecayScore[]> {
  if (pool) {
    return computeDecayScoresPg(pool);
  } else if (sqliteDb) {
    return computeDecayScoresSqlite(sqliteDb);
  }
  throw new Error('No database connection available');
}

async function computeDecayScoresPg(pool: pg.Pool): Promise<DecayScore[]> {
  const result = await pool.query(`
    SELECT
      m.id,
      m.type,
      m.content,
      m.metadata,
      m.confidence,
      m.is_locked,
      m.last_seen,
      m.created_at,
      m.updated_at,
      COUNT(a.id) as access_count,
      MAX(a.accessed_at) as last_accessed
    FROM memories m
    LEFT JOIN memory_access_log a ON m.id = a.memory_id
    WHERE m.is_archived = false
    GROUP BY m.id
  `);

  logger.info(`Computing decay scores for ${result.rows.length} memories (postgres)`);

  return result.rows.map((row: { id: number; type: string; content: string; metadata: string | Record<string, unknown>; confidence?: number; is_locked?: boolean; last_seen: string | null; created_at: string; updated_at: string; access_count: string; last_accessed: string | null }) => {
    const pinned = isPinned(row.metadata);
    return scoreMemory(
      row.id,
      row.type,
      row.content?.length || 0,
      row.access_count ? parseInt(row.access_count, 10) : 0,
      latestOf(row.last_accessed, row.last_seen, row.created_at),
      pinned || row.is_locked === true,
      (row.confidence as number) ?? 1.0
    );
  });
}

function computeDecayScoresSqlite(db: Database.Database): DecayScore[] {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.type,
      m.metadata,
      m.confidence,
      m.is_locked,
      m.last_seen,
      m.created_at,
      LENGTH(m.content) as content_length,
      COUNT(a.id) as access_count,
      MAX(COALESCE(a.accessed_at, m.created_at)) as last_accessed
    FROM memories m
    LEFT JOIN memory_access_log a ON m.id = a.memory_id
    WHERE m.is_archived = 0
    GROUP BY m.id
  `).all() as { id: number; type: string; metadata: string; confidence: number; is_locked: number; last_seen: string | null; created_at: string; content_length: number; access_count: number; last_accessed: string }[];

  logger.info(`Computing decay scores for ${rows.length} memories (sqlite)`);

  return rows.map(row => {
    const pinned = isPinned(row.metadata);
    return scoreMemory(
      row.id,
      row.type,
      row.content_length,
      row.access_count,
      latestOf(row.last_accessed, row.last_seen, row.created_at),
      pinned || row.is_locked === 1,
      row.confidence ?? 1.0
    );
  });
}

/** Most recent of the given timestamps (nulls skipped). The recency anchor
 *  includes last_seen so reinforcement-on-access also resets this clock (D1.1). */
function latestOf(...timestamps: (string | Date | null | undefined)[]): Date {
  let best = 0;
  for (const t of timestamps) {
    if (!t) continue;
    const ms = (t instanceof Date ? t : new Date(t)).getTime();
    if (!Number.isNaN(ms) && ms > best) best = ms;
  }
  return new Date(best);
}

/**
 * Check if a memory is pinned (permanent). Pinned memories never decay.
 * Set via metadata: { "pinned": true }
 */
function isPinned(metadata: string | Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    return parsed.pinned === true;
  } catch {
    return false;
  }
}

function scoreMemory(
  id: number,
  type: string,
  contentLength: number,
  accessCount: number,
  lastAccessed: Date,
  pinned: boolean = false,
  confidence: number = 1.0
): DecayScore {
  // Hard Anchor (invariant #8): pinned, locked, or operator-confirmed
  // (confidence >= 1.0) memories never decay or get auto-archived
  if (pinned || confidence >= 1.0) {
    return { memoryId: id, recencyScore: 1, frequencyScore: 1, typeWeight: 1, qualityScore: 1, totalScore: 1 };
  }

  // Immature auto-discovered memories (confidence < 0.6) are exempt from standard decay —
  // only the confidence decay in computeEffectiveConfidence applies until they mature
  if (type === 'discovery' && confidence < 0.6) {
    return { memoryId: id, recencyScore: 1, frequencyScore: 1, typeWeight: 0.4, qualityScore: 1, totalScore: 1 };
  }

  const now = Date.now();
  const daysSinceAccess = (now - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay based on half-life
  const recencyScore = Math.pow(0.5, daysSinceAccess / DECAY_HALF_LIFE_DAYS);

  // Frequency: logarithmic scale, capped at 1
  const frequencyScore = Math.min(1, Math.log(1 + accessCount) / Math.log(50));

  // Type weight
  const typeWeight = TYPE_WEIGHTS[type] ?? 0.5;

  // Quality: content length heuristic
  const qualityScore = contentLength < 20 ? 0.2
    : contentLength < 100 ? 0.5
    : contentLength < 500 ? 0.8
    : 1.0;

  // Usage-gated combination (D1.1 retune): type and quality MODULATE the usage
  // signal instead of adding a constant floor. The old additive form
  // (typeWeight*0.2 + quality*0.15) floored every memory above the 0.1 archive
  // threshold — a dry-run over a real corpus caught nothing at all. Now a
  // fully-stale memory scores → 0 and the threshold has teeth.
  const usage = recencyScore * 0.7 + frequencyScore * 0.3;
  const modifier = (0.5 + 0.5 * typeWeight) * (0.7 + 0.3 * qualityScore);
  const totalScore = usage * modifier;

  return { memoryId: id, recencyScore, frequencyScore, typeWeight, qualityScore, totalScore };
}
