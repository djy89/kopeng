/**
 * `is_archived` is the definition of archived; `archived_at` is a timestamp that
 * accompanies it. They disagree on 58 live rows, and a query written against
 * `archived_at IS NULL` returns the wrong set — a trap this project hit twice.
 * This suite pins the helper to what both backends' SQL actually does.
 */
import { describe, it, expect } from 'vitest';
import { isArchived, ARCHIVED_SQL_PREDICATE } from '../../src/utils/archived.js';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';

describe('isArchived', () => {
  it('reads is_archived, never archived_at', () => {
    expect(isArchived({ is_archived: 1 })).toBe(true);
    expect(isArchived({ is_archived: 0 })).toBe(false);
    // Postgres hands back a boolean through the same field.
    expect(isArchived({ is_archived: true as unknown as number })).toBe(true);
    expect(isArchived({ is_archived: false as unknown as number })).toBe(false);
  });

  it('agrees with the SQL predicate even on a row where the columns disagree', async () => {
    const { db, queries } = createTestDatabase();
    // store() returns { id, deduplicated } — not a bare id.
    const { id } = await queries.store(createTestMemory({ content: 'a divergent row' }));

    // Reproduce the live divergence: a stale archived_at on an ACTIVE row.
    db.prepare("UPDATE memories SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(id);

    const row = db.prepare('SELECT is_archived, archived_at FROM memories WHERE id = ?').get(id) as
      { is_archived: number; archived_at: string | null };
    expect(row.archived_at).not.toBeNull();
    expect(isArchived(row)).toBe(false);

    const activeIds = db.prepare(
      `SELECT id FROM memories WHERE ${ARCHIVED_SQL_PREDICATE} = 0`,
    ).all() as { id: number }[];
    expect(activeIds.map(r => r.id)).toContain(id);

    // The wrong-column query disagrees — which is the whole reason for the helper.
    const byWrongColumn = db.prepare(
      'SELECT id FROM memories WHERE archived_at IS NULL',
    ).all() as { id: number }[];
    expect(byWrongColumn.map(r => r.id)).not.toContain(id);

    db.close();
  });
});
