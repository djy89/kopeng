import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { rollbackMemory } from '../../src/dreaming/apply.js';
import { crystallizeEligible, readAutoCrystallize } from '../../src/promotion/crystallize.js';
import {
  isCrystallizationCandidate,
  CRYSTALLIZE_TARGET,
  CRYSTALLIZE_MIN_CONFIDENCE,
} from '../../src/discovery/confidence.js';

const NOW = new Date('2026-07-10T00:00:00.000Z');
const cand = (over: Partial<Parameters<typeof isCrystallizationCandidate>[0]>) => ({
  confidence: 0.85,
  observation_count: 12,
  is_locked: 0,
  created_at: '2026-06-01T00:00:00.000Z', // ~39 days before NOW
  ...over,
});

describe('isCrystallizationCandidate (T30.3)', () => {
  it('accepts a durable, believed, unlocked memory', () => {
    expect(isCrystallizationCandidate(cand({}), NOW)).toBe(true);
  });
  it('rejects locked (deliberate anchor)', () => {
    expect(isCrystallizationCandidate(cand({ is_locked: 1 }), NOW)).toBe(false);
  });
  it('rejects already-sticky (>= target) — idempotent', () => {
    expect(isCrystallizationCandidate(cand({ confidence: CRYSTALLIZE_TARGET }), NOW)).toBe(false);
    expect(isCrystallizationCandidate(cand({ confidence: 1.0 }), NOW)).toBe(false);
  });
  it('rejects not-yet-believed (< min confidence)', () => {
    expect(isCrystallizationCandidate(cand({ confidence: CRYSTALLIZE_MIN_CONFIDENCE - 0.01 }), NOW)).toBe(false);
  });
  it('rejects too few reinforcements', () => {
    expect(isCrystallizationCandidate(cand({ observation_count: 9 }), NOW)).toBe(false);
    expect(isCrystallizationCandidate(cand({ observation_count: null }), NOW)).toBe(false);
  });
  it('rejects too young (single-session burst proxy)', () => {
    expect(isCrystallizationCandidate(cand({ created_at: '2026-07-06T00:00:00.000Z' }), NOW)).toBe(false); // 4d
  });
});

describe('readAutoCrystallize', () => {
  it('defaults OFF and reads the blob flag', () => {
    expect(readAutoCrystallize(null)).toBe(false);
    expect(readAutoCrystallize('{}')).toBe(false);
    expect(readAutoCrystallize('not json')).toBe(false);
    expect(readAutoCrystallize('{"auto_crystallize": true}')).toBe(true);
    expect(readAutoCrystallize('{"auto_crystallize": false}')).toBe(false);
  });
});

describe('crystallizeEligible (T30.3)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;
  let index: EmbeddingIndex;
  let idEligible: number;
  let idYoung: number;
  let idLowObs: number;
  let idLocked: number;

  /** Ages anchor on the pinned NOW, not the real clock — otherwise the seeded rows
   * drift out of the eligibility window as real time passes 2026-07-10. */
  const daysBeforeNow = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

  async function seed(overrides: { confidence: number; obs: number; days: number; locked?: boolean }): Promise<number> {
    const id = (await queries.store(createTestMemory({ content: `m-${Math.random()}` }))).id;
    const ts = daysBeforeNow(overrides.days);
    db.prepare(
      `UPDATE memories SET confidence = ?, observation_count = ?, is_locked = ?,
       created_at = ?, updated_at = ?, last_seen = ?
       WHERE id = ?`,
    ).run(overrides.confidence, overrides.obs, overrides.locked ? 1 : 0, ts, ts, daysBeforeNow(1), id);
    return id;
  }

  beforeEach(async () => {
    ({ db, queries } = createTestDatabase());
    dreamStore = new DreamQueries(db);
    index = new EmbeddingIndex();
    idEligible = await seed({ confidence: 0.85, obs: 12, days: 30 });
    idYoung = await seed({ confidence: 0.85, obs: 12, days: 3 }); // too young
    idLowObs = await seed({ confidence: 0.85, obs: 4, days: 30 }); // too few reinforcements
    idLocked = await seed({ confidence: 0.85, obs: 12, days: 30, locked: true }); // deliberate anchor
  });

  afterEach(() => db.close());

  const conf = async (id: number) => (await queries.get(id))!.confidence;

  it('promotes only the eligible memory to the target, snapshot-first + reversible', async () => {
    const res = await crystallizeEligible({ memoryStore: queries, dreamStore, now: NOW });
    expect(res.crystallized).toEqual([idEligible]);
    expect(res.candidates).toBe(1);
    expect(await conf(idEligible)).toBeCloseTo(CRYSTALLIZE_TARGET, 5);
    // ineligible rows untouched
    expect(await conf(idYoung)).toBeCloseTo(0.85, 5);
    expect(await conf(idLowObs)).toBeCloseTo(0.85, 5);
    expect(await conf(idLocked)).toBeCloseTo(0.85, 5);

    // snapshot-first: a revision captured the pre-crystallize confidence.
    const revisions = await dreamStore.listRevisions(idEligible);
    expect(revisions.length).toBeGreaterThanOrEqual(1);

    // reversible: rollback restores 0.85.
    const rb = await rollbackMemory({ memoryStore: queries, dreamStore, vectorIndex: index }, idEligible);
    expect(rb).not.toBeNull();
    expect(await conf(idEligible)).toBeCloseTo(0.85, 5);
  });

  it('is idempotent — a second pass crystallizes nothing', async () => {
    await crystallizeEligible({ memoryStore: queries, dreamStore, now: NOW });
    const again = await crystallizeEligible({ memoryStore: queries, dreamStore, now: NOW });
    expect(again.crystallized).toEqual([]);
    expect(again.candidates).toBe(0);
  });

  it('dry-run withholds — reports the candidate but mutates nothing', async () => {
    const res = await crystallizeEligible({ memoryStore: queries, dreamStore, now: NOW, dryRun: true });
    expect(res.candidates).toBe(1);
    expect(res.crystallized).toEqual([]);
    expect(res.withheld).toBe(1);
    expect(await conf(idEligible)).toBeCloseTo(0.85, 5);
  });

  it('without a dream store, withholds rather than mutating unaudited', async () => {
    const res = await crystallizeEligible({ memoryStore: queries, dreamStore: null, now: NOW });
    expect(res.crystallized).toEqual([]);
    expect(res.withheld).toBe(1);
    expect(await conf(idEligible)).toBeCloseTo(0.85, 5);
  });

  it('appends a crystallize audit row under a carrier dream (T43)', async () => {
    const result = await crystallizeEligible({ memoryStore: queries, dreamStore, now: NOW });
    expect(result.crystallized).toContain(idEligible);

    const row = db.prepare(
      `SELECT * FROM dream_audit_log WHERE memory_id = ? AND change_class = 'crystallize'`,
    ).get(idEligible) as { dream_id: number; after_ref: string; before_ref: string; applied_automatically: number; revision_id: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.after_ref).toBe('crystallized;confidence=0.97');
    expect(row!.before_ref).toBe('confidence=0.85'); // the suite seeds idEligible at 0.85
    expect(row!.applied_automatically).toBe(1);      // raw SQLite row: 0/1
    expect(row!.revision_id).not.toBeNull();

    const dream = db.prepare(`SELECT is_carrier, status FROM dreams WHERE id = ?`).get(row!.dream_id) as { is_carrier: number; status: string };
    expect(dream.is_carrier).toBe(1);
    expect(dream.status).toBe('completed'); // carrier.finalize ran
  });

  it('compensates (restores confidence) when the audit append fails (T43)', async () => {
    const failingStore = Object.create(dreamStore) as typeof dreamStore;
    failingStore.appendAudit = async () => { throw new Error('audit path down'); };

    const result = await crystallizeEligible({ memoryStore: queries, dreamStore: failingStore, now: NOW });
    expect(result.crystallized).toHaveLength(0);
    expect(await conf(idEligible)).toBe(0.85); // mutation compensated back to seeded value
  });

  it('opens no carrier dream when nothing is eligible (T43)', async () => {
    // Fresh empty stores — the suite-level fixtures all seed candidates.
    const fresh = createTestDatabase();
    const freshDreams = new DreamQueries(fresh.db);
    await crystallizeEligible({ memoryStore: fresh.queries, dreamStore: freshDreams, now: NOW });
    const n = fresh.db.prepare(`SELECT COUNT(*) AS n FROM dreams`).get() as { n: number };
    expect(n.n).toBe(0); // CarrierDream.open() is lazy — zero candidates, zero rows
    fresh.db.close();
  });
});

describe('crystallize audit class (T43)', () => {
  it('accepts crystallize as a dream_audit_log change_class', async () => {
    const { db } = createTestDatabase();
    const dreams = new DreamQueries(db);
    const dream = await dreams.createDream({
      mode: 'whole_corpus', trigger_source: 'scheduled',
      reason: 'test carrier', is_carrier: true,
    });
    const row = await dreams.appendAudit({
      dream_id: dream.id, memory_id: null,
      change_class: 'crystallize',
      after_ref: 'crystallized;confidence=0.97',
    });
    expect(row.change_class).toBe('crystallize');
    db.close();
  });
});
