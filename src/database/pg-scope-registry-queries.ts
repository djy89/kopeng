import type pg from 'pg';
import type { IScopeRegistryStore } from './interfaces.js';
import type { ScopeRegistryRow, RegisterRequest, ScopeRegistryStatus } from '../scopes/minting.js';

/** Postgres implementation of the Phase 3 scope registry store. */
export class PgScopeRegistryQueries implements IScopeRegistryStore {
  constructor(private pool: pg.Pool) {}

  async listAll(): Promise<ScopeRegistryRow[]> {
    const r = await this.pool.query(`SELECT * FROM scope_registry`);
    return r.rows.map(rowToRegistryRow);
  }

  async register(req: RegisterRequest): Promise<boolean> {
    // RETURNING scope: a conflict-skipped insert returns no row, so
    // rowCount > 0 ⟺ a row was actually inserted.
    const r = await this.pool.query(
      `INSERT INTO scope_registry (scope, slug, claimant_raw, origin_cwd, status, reserved)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope) DO NOTHING
       RETURNING scope`,
      [req.scope, req.slug, req.claimant_raw, req.origin_cwd, req.status, req.reserved ?? false]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async updateStatus(scope: string, status: ScopeRegistryStatus, ruledAt?: string): Promise<void> {
    await this.pool.query(
      `UPDATE scope_registry SET status = $1, ruled_at = COALESCE($2, ruled_at), updated_at = NOW()
       WHERE scope = $3`,
      [status, ruledAt ?? null, scope]
    );
  }

  async rename(oldScope: string, newScope: string, newSlug: string | null): Promise<void> {
    // PK conflict throws — the caller surfaces it as a 409-class refusal.
    await this.pool.query(
      `UPDATE scope_registry SET scope = $1, slug = $2, updated_at = NOW() WHERE scope = $3`,
      [newScope, newSlug, oldScope]
    );
  }
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : (v as string);
}

function rowToRegistryRow(row: Record<string, unknown>): ScopeRegistryRow {
  return {
    scope: row.scope as string,
    slug: (row.slug as string | null) ?? null,
    claimant_raw: row.claimant_raw as string,
    origin_cwd: (row.origin_cwd as string | null) ?? null,
    status: row.status as ScopeRegistryStatus,
    reserved: !!row.reserved,
    first_seen: toIso(row.first_seen),
    updated_at: toIso(row.updated_at),
    ruled_at: toIsoOrNull(row.ruled_at),
  };
}
