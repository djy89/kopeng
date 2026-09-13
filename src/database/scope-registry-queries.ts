import type Database from 'better-sqlite3';
import type { IScopeRegistryStore } from './interfaces.js';
import type { ScopeRegistryRow, RegisterRequest, ScopeRegistryStatus } from '../scopes/minting.js';

/** SQLite implementation of the Phase 3 scope registry store. */
export class ScopeRegistryQueries implements IScopeRegistryStore {
  constructor(private db: Database.Database) {}

  async listAll(): Promise<ScopeRegistryRow[]> {
    const rows = this.db.prepare(`SELECT * FROM scope_registry`).all() as Record<string, unknown>[];
    return rows.map(r => ({
      scope: r.scope as string,
      slug: (r.slug as string | null) ?? null,
      claimant_raw: r.claimant_raw as string,
      origin_cwd: (r.origin_cwd as string | null) ?? null,
      status: r.status as ScopeRegistryStatus,
      reserved: r.reserved === 1,
      first_seen: r.first_seen as string,
      updated_at: r.updated_at as string,
      ruled_at: (r.ruled_at as string | null) ?? null,
      ruled_distinct_at: (r.ruled_distinct_at as string | null) ?? null,
      deferred_at: (r.deferred_at as string | null) ?? null,
      deferred_note: (r.deferred_note as string | null) ?? null,
    }));
  }

  async register(req: RegisterRequest): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT INTO scope_registry (scope, slug, claimant_raw, origin_cwd, status, reserved)
      VALUES (@scope, @slug, @claimant_raw, @origin_cwd, @status, @reserved)
      ON CONFLICT (scope) DO NOTHING
    `).run({ ...req, reserved: req.reserved ? 1 : 0 });
    return result.changes > 0;
  }

  async updateStatus(scope: string, status: ScopeRegistryStatus, ruledAt?: string): Promise<void> {
    this.db.prepare(`
      UPDATE scope_registry SET status = ?, ruled_at = COALESCE(?, ruled_at), updated_at = datetime('now')
      WHERE scope = ?
    `).run(status, ruledAt ?? null, scope);
  }

  async rename(oldScope: string, newScope: string, newSlug: string | null): Promise<void> {
    // PK conflict throws — the caller surfaces it as a 409-class refusal.
    this.db.prepare(`
      UPDATE scope_registry SET scope = ?, slug = ?, updated_at = datetime('now') WHERE scope = ?
    `).run(newScope, newSlug, oldScope);
  }

  async markDistinct(scope: string, ruledAt: string): Promise<void> {
    // The deferral is cleared in the SAME statement (blocker 4): the ruling is
    // precisely the decision the deferral postponed, and a row reading both
    // "deferred" and "ruled distinct" is contradictory residue — the same
    // reasoning that makes merge_into clear ruled_distinct_at.
    this.db.prepare(`
      UPDATE scope_registry
      SET status = 'confirmed', ruled_distinct_at = ?, ruled_at = COALESCE(ruled_at, ?),
          deferred_at = NULL, deferred_note = NULL, updated_at = datetime('now')
      WHERE scope = ?
    `).run(ruledAt, ruledAt, scope);
  }

  async setDeferred(scope: string, deferredAt: string, note: string | null): Promise<void> {
    // status/ruled_at deliberately untouched — see IScopeRegistryStore.
    this.db.prepare(`
      UPDATE scope_registry SET deferred_at = ?, deferred_note = ?, updated_at = datetime('now')
      WHERE scope = ?
    `).run(deferredAt, note, scope);
  }

  async clearDeferred(scope: string): Promise<void> {
    this.db.prepare(`
      UPDATE scope_registry SET deferred_at = NULL, deferred_note = NULL, updated_at = datetime('now')
      WHERE scope = ?
    `).run(scope);
  }

  async clearDistinct(scope: string): Promise<void> {
    // `ruled_at` is deliberately kept: the row WAS ruled, twice — the merge is
    // the current answer, and the earlier ruling's timestamp is still history.
    this.db.prepare(`
      UPDATE scope_registry SET ruled_distinct_at = NULL, updated_at = datetime('now') WHERE scope = ?
    `).run(scope);
  }
}
