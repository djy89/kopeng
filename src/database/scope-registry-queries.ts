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
}
