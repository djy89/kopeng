/**
 * THE ANTI-DRIFT TEST (Phase 1).
 *
 * The codebase's dominant bug-generating mechanism is: each subsystem ships a
 * locally-correct copy of a shared concept, the copies drift, and every harness
 * formalizes its own copy so regressions read green. Scope was one instance with
 * four copies. This suite feeds ONE malformed table to every consumer and
 * asserts they reach the SAME verdict about every entry.
 *
 * If a future change gives any consumer its own parser again, this fails.
 *
 * Scope note: this suite locks the CONSUMERS to the resolver — it says nothing
 * about whether the resolver itself is right. Every consumer here ultimately
 * calls buildScopeResolution, so a bug inside the resolver reproduces
 * identically across all of them and this suite stays green. Resolver
 * correctness is scope-resolver.test.ts's job.
 */
import { describe, it, expect } from 'vitest';
import { buildScopeResolution } from '../../src/scopes/resolver.js';
import { ScopeAliasService, SCOPE_ALIASES_CONFIG_KEY } from '../../src/services/scope-alias.js';
import { buildScopeDrift } from '../../src/scopes/drift.js';
import type { IOperatorConfigStore } from '../../src/database/interfaces.js';

/** Every rejection class at once, plus one entry that must survive. */
const MALFORMED_TABLE = {
  'client:Acme-Foods': 'client:acme-foods', // the only accepted entry
  'client:chain-head': 'client:mid',
  'client:mid': 'client:tail',              // chained (also a canonical value)
  'client:self': 'client:self',             // self-map
  'client:num': 42,                         // non-string
  'client:blank': '',                       // empty
  'project:web': 'client:acme-foods',       // generic-key capture (P13)
  'status:archived': 'client:acme-foods',   // not a scope form
  'client:Bad-Num': 42, // non-slug-form rejected alias — the cluster loop below must traverse a rejected entry
};

// 'client:chain-head' → 'client:mid' is itself accepted; only the entry KEYED
// by a canonical value ('client:mid') is the chain violation.
const EXPECTED_ACCEPTED = ['client:Acme-Foods', 'client:chain-head'];

function stubStore(blob: unknown): IOperatorConfigStore {
  return {
    getConfig: async () => ({ config: JSON.stringify({ [SCOPE_ALIASES_CONFIG_KEY]: blob }) }),
    updateConfig: async () => { throw new Error('not used'); },
  } as unknown as IOperatorConfigStore;
}

describe('one definition of the alias table, across every consumer', () => {
  const resolution = buildScopeResolution(MALFORMED_TABLE);

  it('the resolver accepts exactly the well-formed entries', () => {
    expect(Object.keys(resolution.table).sort()).toEqual([...EXPECTED_ACCEPTED].sort());
    expect(resolution.rejected).toHaveLength(7);
  });

  it('the write path canonicalizes exactly the accepted aliases', async () => {
    const svc = new ScopeAliasService(stubStore(MALFORMED_TABLE));
    for (const alias of EXPECTED_ACCEPTED) {
      expect(await svc.canonicalize(alias)).toBe(resolution.table[alias]);
    }
    for (const { alias } of resolution.rejected) {
      // A rejected mapping is a no-op at write time: the scope lands verbatim.
      expect(await svc.canonicalize(alias)).toBe(alias);
    }
  });

  it('the drift detector calls a variant covered iff the write path moves it', async () => {
    const svc = new ScopeAliasService(stubStore(MALFORMED_TABLE));
    const scopes = [...EXPECTED_ACCEPTED, ...resolution.rejected.map(r => r.alias)];
    const aggregates = scopes
      .filter(s => /^(project|client):.+$/.test(s))
      .map(scope => ({
        scope, total: 1, active: 1, archived: 0,
        by_type: { discovery: 1 }, first_write: '2026-01-01', last_write: '2026-08-01',
      }));

    const report = buildScopeDrift(aggregates, await svc.snapshot());

    for (const cluster of report.clusters) {
      for (const variant of cluster.variants) {
        const movesAtWriteTime = (await svc.canonicalize(variant.scope)) !== variant.scope;
        expect(variant.aliased_to !== null).toBe(movesAtWriteTime);
      }
    }
    expect(report.summary.alias_entries_rejected).toBe(resolution.rejected.length);
  });

  it('the migration driver accepts exactly what the write path accepts', async () => {
    const { acceptedPairs } = await import('../../scripts/ops/migrate-scope-aliases.js');
    const svc = new ScopeAliasService(stubStore(MALFORMED_TABLE));
    const pairs = acceptedPairs(MALFORMED_TABLE);

    expect(pairs.map(([a]) => a).sort()).toEqual([...EXPECTED_ACCEPTED].sort());
    for (const [alias, canonical] of pairs) {
      expect(await svc.canonicalize(alias)).toBe(canonical);
    }
  });
});
