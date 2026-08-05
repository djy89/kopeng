import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { runPromotion } from '../../src/promotion/promotion-engine.js';
import { rollbackMemory } from '../../src/dreaming/apply.js';

/**
 * GATE 1 regression: a non-dry promotion run must not archive anything unless
 * the per-class opt-in flag is passed (the nightly chain derives it from
 * operator_config.auto_accept_decay). Found the hard way: an early scheduled
 * run archived dozens of >0.99 duplicates with no snapshot/audit/gate.
 * GATE 1 RETIRED duplicate archival outright — the dream apply
 * path owns dup collapse; promotion only detects and reports candidates.
 */
describe('promotion archival gating', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;
  let index: EmbeddingIndex;
  let idA: number;
  let idB: number;
  let idStale: number;

  beforeEach(async () => {
    ({ db, queries } = createTestDatabase());
    dreamStore = new DreamQueries(db);
    // Two distinct-content memories with identical embeddings → cosine 1.0,
    // i.e. an `archive_duplicate` consolidation candidate (>0.99).
    const embedding = Buffer.from(new Float32Array([0.6, 0.8, 0, 0]).buffer);
    idA = (await queries.store({ ...createTestMemory({ content: 'duplicate fact, phrasing one' }), embedding })).id;
    idB = (await queries.store({ ...createTestMemory({ content: 'duplicate fact, phrasing two' }), embedding })).id;
    // A stale low-usage memory: 120 days untouched, no access log → effective
    // confidence well below the 0.2 archive threshold. Uses `project` (not
    // `reference`): post-T30 references carry a structural decay floor (0.4) and
    // never decay-archive, so this fixture exercises the gating with an unfloored
    // decay-eligible type (project, 45d half-life → ~0.11 at 120d).
    idStale = (await queries.store({ ...createTestMemory({ content: 'old scrap', type: 'project' }) })).id;
    db.prepare(`UPDATE memories SET created_at = datetime('now', '-120 days'), updated_at = datetime('now', '-120 days'), last_seen = NULL, confidence = 0.7 WHERE id = ?`).run(idStale);
    index = new EmbeddingIndex();
    await index.loadFromDatabase(
      (await queries.loadAllEmbeddings()).map(r => ({ id: r.id, embedding: r.embedding }))
    );
  });

  afterEach(() => {
    db.close();
  });

  async function archivedFlags(): Promise<Record<number, boolean>> {
    const rows = db.prepare('SELECT id, is_archived FROM memories WHERE id IN (?, ?, ?)').all(idA, idB, idStale) as { id: number; is_archived: number }[];
    return Object.fromEntries(rows.map(r => [r.id, r.is_archived === 1]));
  }

  it('non-dry run with the flag off detects candidates but archives nothing', async () => {
    const result = await runPromotion(queries, index, null, db, { dryRun: false });
    expect(result.consolidation.duplicates).toBeGreaterThanOrEqual(1);
    expect(result.decayScores.belowThreshold).toBeGreaterThanOrEqual(1);
    expect(await archivedFlags()).toEqual({ [idA]: false, [idB]: false, [idStale]: false });
  });

  it('withheld decay candidates are not reported as archived (only counted)', async () => {
    const result = await runPromotion(queries, index, null, db, { dryRun: false });
    expect(result.archive.archived).toEqual([]);
    expect(result.archive.withheld).toBeGreaterThanOrEqual(1);
  });

  it('archiveDecayed: true archives ONLY the decay class — duplicates stay (step 3 retired)', async () => {
    const result = await runPromotion(queries, index, null, db, { dryRun: false, archiveDecayed: true, dreamStore });
    expect(result.consolidation.duplicates).toBeGreaterThanOrEqual(1); // detected, reported
    expect(result.archive.archived).toContain(idStale);
    expect(await archivedFlags()).toEqual({ [idA]: false, [idB]: false, [idStale]: true });
  });

  it('dryRun overrides archiveDecayed — nothing archived', async () => {
    await runPromotion(queries, index, null, db, { dryRun: true, archiveDecayed: true, dreamStore });
    expect(await archivedFlags()).toEqual({ [idA]: false, [idB]: false, [idStale]: false });
  });

  it('archiveDecayed without a dream store withholds (R14: no unaudited archive)', async () => {
    const result = await runPromotion(queries, index, null, db, { dryRun: false, archiveDecayed: true });
    expect(result.archive.archived).toEqual([]);
    expect(result.archive.withheld).toBeGreaterThanOrEqual(1);
    expect(await archivedFlags()).toEqual({ [idA]: false, [idB]: false, [idStale]: false });
  });

  it('gated run records memories_archived 0 in the run row', async () => {
    const result = await runPromotion(queries, index, null, db, { dryRun: false });
    expect(result.run_id).not.toBeNull();
    const row = db.prepare('SELECT memories_archived FROM promotion_runs WHERE id = ?').get(result.run_id) as { memories_archived: number };
    expect(row.memories_archived).toBe(0);
  });

  /**
   * R14 (GATE 1 fix): a promotion decay archive is now AUDITED via the dream
   * apply path — snapshot + dream_audit_log row — and reversible via the same
   * rollback used by dream-driven archives. This proves the full round-trip.
   */
  describe('R14: audited decay archive round-trip', () => {
    it('produces a memory_revisions snapshot + a dream_audit_log row, and rolls back', async () => {
      const content = (await queries.get(idStale))!.content;
      const result = await runPromotion(queries, index, null, db, { dryRun: false, archiveDecayed: true, dreamStore });
      expect(result.archive.archived).toContain(idStale);
      const dreamId = result.archive.dream_id;
      expect(dreamId).toBeGreaterThan(0);

      // Snapshot exists for the archived memory.
      const revisions = await dreamStore.listRevisions(idStale);
      expect(revisions.length).toBeGreaterThanOrEqual(1);
      expect(revisions[0].created_by_dream_id).toBe(dreamId);

      // An audit row records the decay archive.
      const audit = await dreamStore.listAuditForDream(dreamId!);
      const decayRow = audit.find(a => a.memory_id === idStale && a.change_class === 'decay');
      expect(decayRow).toBeTruthy();
      expect(decayRow!.action).toBe('archive');
      expect(decayRow!.applied_automatically).toBe(true);

      // The live row is archived.
      expect((await queries.get(idStale))!.is_archived).toBe(1);

      // Rollback restores content + unarchives via the existing apply path.
      const rb = await rollbackMemory(
        { memoryStore: queries, dreamStore, vectorIndex: index },
        idStale,
      );
      expect(rb).not.toBeNull();
      const restored = await queries.get(idStale);
      expect(restored!.is_archived).toBe(0);
      expect(restored!.content).toBe(content);
    });

    it('respects Hard Anchor — a locked low-strength memory is never decay-archived', async () => {
      // Lock idStale (Hard Anchor) — even though its strength is < 0.2 it must
      // never be decay-archived.
      db.prepare('UPDATE memories SET is_locked = 1 WHERE id = ?').run(idStale);
      const result = await runPromotion(queries, index, null, db, { dryRun: false, archiveDecayed: true, dreamStore });
      expect(result.archive.archived).not.toContain(idStale);
      expect((await queries.get(idStale))!.is_archived).toBe(0);
    });
  });
});
