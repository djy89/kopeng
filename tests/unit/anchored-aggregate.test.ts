/**
 * Item 11 (UX synthesis theme J): the triage line at rest needs `anchored`
 * per scope — how many of a scope's ACTIVE rows the Hard Anchor protects, i.e.
 * how many an archive would refuse. Until now that number existed only AFTER
 * running an archive dry-run, so "is this junk?" could not be answered from
 * the row itself.
 *
 * The load-bearing test here is the COMPOSITION one: `isAnchored` (the ONE
 * contract, src/dreaming/scoring.ts) is a three-spelling predicate — is_locked,
 * confidence >= 1.0, metadata.pinned — and counting it in SQL would be a
 * fourth and fifth spelling, one per backend. So the SQL lives beside the TS
 * predicate as `ANCHORED_SQL_PREDICATE` (the ARCHIVED_SQL_PREDICATE precedent)
 * and this suite pins SQL ≡ TS over a corpus that exercises every spelling,
 * including the ones that break naive SQL: malformed metadata, `pinned: false`,
 * and a pinned-looking substring inside ordinary content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { isAnchored, ANCHORED_SQL_PREDICATE } from '../../src/dreaming/scoring.js';
import { foldScopeAggregates } from '../../src/database/queries.js';

let db: Database.Database;
let queries: MemoryQueries;

/** Every row the anchor contract has an opinion about, plus the traps. */
const ROWS: {
  label: string; scope: string; is_locked?: 0 | 1; confidence?: number;
  metadata?: string; archived?: boolean; anchored: boolean;
}[] = [
  { label: 'locked — THE anchor', scope: 'project:a', is_locked: 1, anchored: true },
  { label: 'confidence 1.0 — deprecated spelling, still honored', scope: 'project:a', confidence: 1.0, anchored: true },
  { label: 'metadata.pinned — deprecated spelling, still honored', scope: 'project:a', metadata: '{"pinned":true}', anchored: true },
  { label: 'pinned with whitespace (hand-written JSON)', scope: 'project:a', metadata: '{ "pinned" : true }', anchored: true },
  { label: 'plain row', scope: 'project:a', confidence: 0.7, anchored: false },
  { label: 'pinned:false is NOT anchored', scope: 'project:b', metadata: '{"pinned":false}', anchored: false },
  // The two cases the first draft got wrong, one per backend. json_extract
  // maps JSON `true` and the integer 1 to the same SQL 1; `->>` unquotes, so
  // the JSON string "true" reads as the text 'true'. isAnchored accepts
  // NEITHER — it requires `=== true`.
  { label: 'pinned:1 (JSON number) is NOT anchored', scope: 'project:b', metadata: '{"pinned":1}', anchored: false },
  { label: 'pinned:"true" (JSON string) is NOT anchored', scope: 'project:b', metadata: '{"pinned":"true"}', anchored: false },
  { label: 'empty metadata — the schema DEFAULT, must be false not NULL', scope: 'project:b', metadata: '{}', anchored: false },
  { label: 'confidence just below the line', scope: 'project:b', confidence: 0.99, anchored: false },
  { label: 'malformed metadata must not throw or anchor', scope: 'project:b', metadata: 'not json at all', anchored: false },
  { label: 'the word pinned inside other metadata', scope: 'project:b', metadata: '{"note":"we pinned this once"}', anchored: false },
  { label: 'archived anchored row — excluded from the ACTIVE count', scope: 'project:b', is_locked: 1, archived: true, anchored: true },
];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  queries = new MemoryQueries(db);
  const ins = db.prepare(`
    INSERT INTO memories (content, content_hash, type, scope, source, metadata, confidence, is_locked, is_archived)
    VALUES (?, ?, 'discovery', ?, 'test', ?, ?, ?, ?)
  `);
  ROWS.forEach((r, i) => {
    ins.run(`row ${i}: ${r.label}`, `hash-${i}`, r.scope, r.metadata ?? '{}',
      r.confidence ?? 0.5, r.is_locked ?? 0, r.archived ? 1 : 0);
  });
});
afterEach(() => db.close());

describe('ANCHORED_SQL_PREDICATE ≡ isAnchored (item 11)', () => {
  it('the SQLite predicate selects exactly the rows isAnchored() accepts', () => {
    const all = db.prepare('SELECT id, is_locked, confidence, metadata FROM memories').all() as
      { id: number; is_locked: number; confidence: number; metadata: string }[];
    const expected = all.filter(r => isAnchored(r)).map(r => r.id).sort((a, b) => a - b);
    const actual = (db.prepare(
      `SELECT id FROM memories WHERE ${ANCHORED_SQL_PREDICATE.sqlite}`
    ).all() as { id: number }[]).map(r => r.id).sort((a, b) => a - b);
    expect(actual).toEqual(expected);
    // Guard against a vacuous pass: the corpus must contain both kinds.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(all.length);
  });

  it('malformed metadata does not throw — the whole aggregate query would fail with it', () => {
    expect(() => db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE ${ANCHORED_SQL_PREDICATE.sqlite}`
    ).get()).not.toThrow();
  });

  it('is two-valued: negating it returns every non-anchored row, not zero rows', () => {
    // The predicate is exported for reuse, so a caller may legitimately write
    // `WHERE NOT (...)`. Without the COALESCE that reads NULL for the schema
    // DEFAULT '{}' and returns nothing — the failure mode is silence.
    const total = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const anchored = (db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE ${ANCHORED_SQL_PREDICATE.sqlite}`
    ).get() as { n: number }).n;
    const notAnchored = (db.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE NOT ${ANCHORED_SQL_PREDICATE.sqlite}`
    ).get() as { n: number }).n;
    expect(anchored + notAnchored).toBe(total);
    expect(notAnchored).toBeGreaterThan(0);
  });
});

describe('getScopeAggregates carries `anchored` (item 11)', () => {
  it('counts ACTIVE anchored rows per scope — the number an archive would refuse', async () => {
    const aggs = await queries.getScopeAggregates();
    const a = aggs.find(x => x.scope === 'project:a')!;
    const b = aggs.find(x => x.scope === 'project:b')!;
    // project:a — four anchored spellings + one plain row, none archived.
    expect(a.anchored).toBe(4);
    expect(a.active).toBe(5);
    // project:b — the only anchored row is ARCHIVED, so the active count is 0
    // even though the scope holds an anchored row.
    expect(b.anchored).toBe(0);
    expect(b.active).toBe(7);
    expect(b.archived).toBe(1);
  });

  it('foldScopeAggregates sums anchored across the (scope, type, source) groups', () => {
    const folded = foldScopeAggregates([
      { scope: 'project:x', type: 'discovery', source: 'auto-discovery', n: 5, active: 5, anchored: 2, first_write: null, last_write: null },
      { scope: 'project:x', type: 'project', source: 'mcp', n: 3, active: 2, anchored: 1, first_write: null, last_write: null },
    ]);
    expect(folded[0].anchored).toBe(3);
    expect(folded[0].active).toBe(7);
  });

  it('a group row with no anchored field folds to 0, never NaN', () => {
    const folded = foldScopeAggregates([
      { scope: 'project:y', type: 'discovery', source: null, n: 2, active: 2, first_write: null, last_write: null },
    ] as never);
    expect(folded[0].anchored).toBe(0);
  });
});
