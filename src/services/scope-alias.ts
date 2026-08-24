/**
 * T46 scope-alias layer — the CACHING WRAPPER over the shared definition.
 *
 * The table is operator-curated and lives in the operator_config `config` blob
 * under `scope_aliases` ({ alias: canonical }), edited via the admin-gated
 * PATCH /api/operator-config (T26 server-side merge) — never in a tracked file.
 *
 * Phase 1: validation MOVED to src/scopes/resolver.ts. This class owns caching,
 * logging and the fail-open policy; it owns no semantics. Every other consumer
 * reads the same accepted map via `snapshot()` (or the resolver directly), so
 * "what the table means" has exactly one implementation.
 */
import { buildScopeResolution, EMPTY_RESOLUTION, type ScopeResolution } from '../scopes/resolver.js';
import type { IOperatorConfigStore } from '../database/interfaces.js';
import logger from '../utils/logger.js';

export const SCOPE_ALIASES_CONFIG_KEY = 'scope_aliases';

/**
 * Back-compat shim: the pre-Phase-1 shape ({ forward, groups }) over the shared
 * resolver. Prefer `buildScopeResolution` in new code — it also carries the
 * version and the rejection list.
 */
export function buildAliasMaps(raw: unknown): {
  forward: Map<string, string>;
  groups: Map<string, string[]>;
} {
  const { forward, groups, rejected } = buildScopeResolution(raw);
  for (const r of rejected) {
    logger.warn(`scope-alias: skipping ${r.reason} mapping "${r.alias}"`);
  }
  return { forward, groups };
}

export class ScopeAliasService {
  private resolution: ScopeResolution = EMPTY_RESOLUTION;
  private loadedAt = -Infinity;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly store: IOperatorConfigStore,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop the cache; next call reloads (wired into the operator-config PATCH). */
  invalidate(): void {
    this.loadedAt = -Infinity;
  }

  /**
   * The accepted resolution — the SAME object the drift detector and the
   * migration driver read, so a coverage claim and a write decision cannot
   * disagree about a malformed entry.
   */
  async snapshot(): Promise<ScopeResolution> {
    await this.ensureLoaded();
    return this.resolution;
  }

  /** Map an incoming scope to its canonical form (identity when unmapped). */
  async canonicalize(scope: string): Promise<string> {
    await this.ensureLoaded();
    return this.resolution.forward.get(scope) ?? scope;
  }

  /**
   * Expand requested scopes to the closure over their alias groups so
   * un-migrated rows stay reachable during the transition: each scope yields
   * its canonical followed by every alias of that canonical (the scope itself
   * always included). Deduped, request order preserved.
   */
  async expand(scopes: string[]): Promise<string[]> {
    await this.ensureLoaded();
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (s: string) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
    for (const scope of scopes) {
      const canonical = this.resolution.forward.get(scope) ?? scope;
      const aliases = this.resolution.groups.get(canonical);
      if (aliases) {
        push(canonical);
        for (const a of aliases) push(a);
      }
      push(scope);
    }
    return out;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.now() - this.loadedAt < this.ttlMs) return;
    if (!this.loading) {
      this.loading = this.load().finally(() => { this.loading = null; });
    }
    await this.loading;
  }

  private async load(): Promise<void> {
    try {
      const cfg = await this.store.getConfig();
      let blob: unknown = cfg?.config ?? null;
      if (typeof blob === 'string') {
        try { blob = JSON.parse(blob); } catch { blob = null; }
      }
      const raw = (typeof blob === 'object' && blob !== null)
        ? (blob as Record<string, unknown>)[SCOPE_ALIASES_CONFIG_KEY]
        : undefined;
      const next = buildScopeResolution(raw);
      for (const r of next.rejected) {
        logger.warn(`scope-alias: skipping ${r.reason} mapping "${r.alias}"`);
      }
      this.resolution = next;
    } catch (err) {
      // Fail-open: keep whatever resolution we had (possibly empty) — never
      // block a write or a recall on a config read.
      logger.warn(`scope-alias: table load failed, keeping previous maps: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.loadedAt = this.now();
  }
}
