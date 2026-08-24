/**
 * Phase 3 scope minting — the CACHING, FAIL-OPEN WRAPPER over the registry
 * store + the pure minting decision (mirrors ScopeAliasService's lazy-load +
 * TTL + invalidate() shape). The service owns caching, logging and the
 * fail-open policy; the semantics live in src/scopes/minting.ts (decideMint)
 * and the persistence in IScopeRegistryStore — it owns neither.
 *
 * resolveWrite NEVER throws: any store/config failure degrades to the raw
 * scope unchanged with one warn — a registry outage must never block a write.
 */
import { decideMint, buildMintContext, type MintContext, type ScopeRegistryRow, type ScopeRegistryStatus, type RegisterRequest } from '../scopes/minting.js';
import { isScopeForm } from '../scopes/resolver.js';
import type { IScopeRegistryStore, IOperatorConfigStore } from '../database/interfaces.js';
import logger from '../utils/logger.js';

export interface WriteResolution {
  scope: string;
  rerouted?: { raw: string; stored_as: string; reason: 'malformed' };
  minted?: boolean;
  quarantined?: boolean;
}

/** The one alias-service shape the composition needs (structural, so tests stub it). */
export interface AliasCanonicalizer {
  canonicalize(scope: string): Promise<string>;
}

/**
 * THE alias-first write resolution (round-2 fix A3). The load-bearing order —
 * alias table canonicalizes FIRST (spec §5 rule 1 / §9), THEN the registry's
 * minting decision runs over the canonical form — used to be hand-rolled at
 * four sites (routes' resolveWriteScope, the redrive route's resolveTo, the
 * discovery scheduler's resolveScope closure in server.ts, and the done-when
 * suite's mirror), and the one site that composed it registry-only was the
 * final-review Critical: a tabled alias variant quarantined instead of pooling,
 * and a tabled non-fold alias minted a slug row on a ruled-away scope. Every
 * consumer now calls THIS function; compose the two services by hand nowhere.
 *
 * Absent services degrade one at a time: no alias service ⇒ raw goes straight
 * to the registry; no registry ⇒ the aliased scope passes through unminted.
 */
export async function resolveWriteThroughAliases(
  aliases: AliasCanonicalizer | undefined,
  registry: ScopeRegistryService | undefined,
  raw: string,
  origin: string | null = null,
): Promise<WriteResolution> {
  const aliased = aliases ? await aliases.canonicalize(raw) : raw;
  if (!registry) return { scope: aliased };
  return registry.resolveWrite(aliased, origin);
}

export class ScopeRegistryService {
  private readonly registry: IScopeRegistryStore;
  private readonly configStore?: IOperatorConfigStore;
  private readonly envPrimaryScope?: string;
  private readonly canonicalize?: (scope: string) => Promise<string>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private rows: ScopeRegistryRow[] = [];
  private ctx: MintContext = buildMintContext([], null);
  private primary: string | null = null;
  private loadedAt = -Infinity;
  private loading: Promise<void> | null = null;

  constructor(deps: {
    registry: IScopeRegistryStore;
    configStore?: IOperatorConfigStore;   // primary_scope column
    envPrimaryScope?: string;             // config.scopes.primaryScope
    /**
     * T46 alias canonicalization for the PRIMARY scope (round-2 fix CO1): the
     * primary is canonicalized where it is LOADED, so decideMint's Rule-2
     * reroute, the routes' scopeless branch, and buildMintContext all see ONE
     * canonical value — the fix-round-1 routes-only special-case fragmented
     * the same primary across the two triage paths. Absent ⇒ identity.
     */
    canonicalize?: (scope: string) => Promise<string>;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.registry = deps.registry;
    this.configStore = deps.configStore;
    this.envPrimaryScope = deps.envPrimaryScope;
    this.canonicalize = deps.canonicalize;
    this.ttlMs = deps.ttlMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  /** Drop the cache; next call reloads (called after every register). */
  invalidate(): void {
    this.loadedAt = -Infinity;
  }

  /**
   * Registry-aware write resolution. NEVER throws; any store/config failure
   * degrades to `{ scope: raw }` with one warn.
   *
   * Lost mint/quarantine race (round-2 fix CO2/A10): register is
   * ON-CONFLICT-DO-NOTHING, so a FALSE return means a concurrent claimant won
   * the scope between this call's snapshot and its write. The cached snapshot
   * is then stale by construction — reload and re-run decideMint ONCE so the
   * winner's row drives the decision (typically `resolve`/`pass`, or the next
   * quarantine suffix). Bounded at one retry; still racing after that fails
   * open to the raw scope with a warn, same posture as every other failure.
   */
  async resolveWrite(raw: string, origin?: string | null): Promise<WriteResolution> {
    try {
      for (let attempt = 0; ; attempt++) {
        await this.ensureLoaded();
        const decision = decideMint(raw, origin ?? null, this.ctx);
        switch (decision.kind) {
          case 'pass':
          case 'resolve':
            return { scope: decision.scope };
          case 'reroute':
            return {
              scope: decision.scope,
              rerouted: { raw: decision.raw, stored_as: decision.scope, reason: decision.reason },
            };
          case 'mint':
          case 'quarantine': {
            const inserted = await this.registry.register(decision.register);
            this.invalidate();
            if (inserted) {
              return decision.kind === 'mint'
                ? { scope: decision.scope, minted: true }
                : { scope: decision.scope, quarantined: true };
            }
            if (attempt >= 1) {
              logger.warn(`scope-registry: resolveWrite for "${raw}" lost the register race twice, passing through raw`);
              return { scope: raw };
            }
            continue; // snapshot invalidated above — the reload sees the winner
          }
        }
      }
    } catch (err) {
      logger.warn(`scope-registry: resolveWrite failed for "${raw}", passing through raw: ${err instanceof Error ? err.message : String(err)}`);
      return { scope: raw };
    }
  }

  /** primary_scope column ?? env ?? null; invalid values ignored with one warn. */
  async getPrimaryScope(): Promise<string | null> {
    try {
      await this.ensureLoaded();
    } catch {
      // Registry down — load() resolved primary before the listAll throw, and
      // primary needs no registry; resolveWrite already warned.
    }
    return this.primary;
  }

  /** The cached registry rows, for the ops endpoint (Task 10). */
  async snapshotRows(): Promise<ScopeRegistryRow[]> {
    await this.ensureLoaded();
    return this.rows;
  }

  // --- Ruling delegates (Task 11) ---
  // The ruling endpoint's registry writes go through the service so every
  // write invalidates the snapshot cache (routes hold only the service, never
  // the raw store). Unlike resolveWrite these THROW on store failure — an
  // admin ruling must surface its error, not fail open.

  async updateStatus(scope: string, status: ScopeRegistryStatus, ruledAt?: string): Promise<void> {
    await this.registry.updateStatus(scope, status, ruledAt);
    this.invalidate();
  }

  /** Re-keys a row; the store throws on a PK conflict (caller maps to 409). */
  async rename(oldScope: string, newScope: string, newSlug: string | null): Promise<void> {
    await this.registry.rename(oldScope, newScope, newSlug);
    this.invalidate();
  }

  /** Idempotent (ON CONFLICT DO NOTHING); invalidates only on a real insert. */
  async register(req: RegisterRequest): Promise<boolean> {
    const inserted = await this.registry.register(req);
    if (inserted) this.invalidate();
    return inserted;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.now() - this.loadedAt < this.ttlMs) return;
    if (!this.loading) {
      this.loading = this.load().finally(() => { this.loading = null; });
    }
    await this.loading;
  }

  private async load(): Promise<void> {
    // Primary first — it never throws, so a registry outage still leaves
    // getPrimaryScope() serving a validated value.
    this.primary = await this.resolvePrimary();
    this.rows = await this.registry.listAll();
    this.ctx = buildMintContext(this.rows, this.primary);
    this.loadedAt = this.now();
  }

  /**
   * Never throws: a config-read failure warns and falls back to env.
   *
   * Round-2 fix CO1: the accepted candidate is alias-canonicalized HERE — the
   * one place the primary is loaded — so every consumer of `primaryScope`
   * (decideMint Rule 2, the scopeless routes branch, buildMintContext) sees
   * the same canonical value. A canonicalize failure degrades to the raw
   * candidate (fail-open, same posture as the rest of this service).
   */
  private async resolvePrimary(): Promise<string | null> {
    let column: string | null = null;
    if (this.configStore) {
      try {
        column = (await this.configStore.getConfig())?.primary_scope ?? null;
      } catch (err) {
        logger.warn(`scope-registry: primary_scope config read failed, falling back to env: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const candidate of [column, this.envPrimaryScope ?? null]) {
      if (candidate === null) continue;
      if (!isScopeForm(candidate)) {
        logger.warn(`scope-registry: ignoring invalid primary scope "${candidate}" (not a scope form)`);
        continue;
      }
      if (!this.canonicalize) return candidate;
      try {
        return await this.canonicalize(candidate);
      } catch (err) {
        logger.warn(`scope-registry: primary_scope canonicalization failed, using raw value: ${err instanceof Error ? err.message : String(err)}`);
        return candidate;
      }
    }
    return null;
  }
}
