/**
 * One definition of "archived".
 *
 * `memories` carries BOTH `is_archived` and `archived_at`. Every query in this
 * codebase filters on `is_archived`; `archived_at` is a companion timestamp that
 * the two store methods keep in step (`archive` sets both, `unarchive` clears
 * both). They nonetheless DISAGREE on 58 live rows — active rows carrying a
 * stale stamp from an older path — so `archived_at IS NULL` silently returns
 * the wrong set. That trap has been hit twice here, once propagated to a
 * subagent as established fact.
 *
 * Read archived state through this helper (or the SQL predicate below) rather
 * than touching either column directly. `npm run reconcile:archived` reports the
 * divergent rows and emits the reviewed SQL to clear the stale stamps.
 */
import type { Memory } from '../types/types.js';

/**
 * The column that DEFINES archived state, for hand-written SQL. SQLite stores
 * 0/1 and Postgres a boolean, so compare against `0`/`false` rather than
 * relying on either dialect's truthiness.
 */
export const ARCHIVED_SQL_PREDICATE = 'is_archived';

/**
 * True when the memory is archived. Accepts SQLite's 0/1 and Postgres's boolean
 * through the same field, which is how both stores hand the row back.
 */
export function isArchived(m: Pick<Memory, 'is_archived'>): boolean {
  return Boolean(m.is_archived);
}
