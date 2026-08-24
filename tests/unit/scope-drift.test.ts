/**
 * T43 Phase A — scope-drift detector.
 *
 * The detector's job is to catch the ONE class T46 structurally cannot: a new
 * scope variant that is not in the alias table, because canonicalization is an
 * exact-string lookup. These tests pin that behaviour plus the evidence fields
 * that made the 2026-08-14 reconciliation cheap (type breakdown, active/archived
 * split), and the store fold that both backends share.
 */
import { describe, it, expect } from 'vitest';
import { buildScopeDrift, clusterScopes, slugifyScope, type ScopeAggregate } from '../../src/scopes/drift.js';
import { foldScopeAggregates } from '../../src/database/queries.js';
import { buildScopeResolution } from '../../src/scopes/resolver.js';

function agg(scope: string, over: Partial<ScopeAggregate> = {}): ScopeAggregate {
  return {
    scope, total: 0, active: 0, archived: 0, by_type: {}, first_write: null, last_write: null,
    ...over,
  };
}

describe('buildScopeDrift — the drift signal', () => {
  it('flags an un-aliased variant and counts its ACTIVE rows as adrift', () => {
    const report = buildScopeDrift([
      agg('client:acme-foods', { total: 40, active: 40, by_type: { project: 40 } }),
      agg('client:Acme-Foods', { total: 7, active: 7, by_type: { discovery: 7 } }),
    ], buildScopeResolution({})); // empty table — nothing covered

    expect(report.summary.clusters_uncovered).toBe(1);
    expect(report.summary.active_rows_adrift).toBe(7);
    const cluster = report.clusters[0];
    expect(cluster.kind).toBe('casing');
    expect(cluster.canonical).toBe('client:acme-foods');
    expect(cluster.covered).toBe(false);
  });

  it('reports zero drift once the alias table covers the variant', () => {
    const aggregates = [
      agg('client:acme-foods', { total: 40, active: 40 }),
      agg('client:Acme-Foods', { total: 7, active: 7 }),
    ];
    const report = buildScopeDrift(aggregates, buildScopeResolution({ 'client:Acme-Foods': 'client:acme-foods' }));

    expect(report.summary.active_rows_adrift).toBe(0);
    expect(report.summary.clusters_uncovered).toBe(0);
    // Still VISIBLE — a covered cluster is resolved, not deleted from the view.
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].covered).toBe(true);
  });

  it('catches a NEW variant appearing beside an already-aliased one', () => {
    // The exact scenario T46 cannot prevent: the table knows one spelling,
    // a third one shows up, and the exact-match canonicalizer passes it through.
    const report = buildScopeDrift([
      agg('client:acme-foods', { total: 40, active: 40 }),
      agg('client:Acme-Foods', { total: 7, active: 7 }),
      agg('client:ACME_Foods', { total: 3, active: 3 }), // brand new
    ], buildScopeResolution({ 'client:Acme-Foods': 'client:acme-foods' }));

    expect(report.summary.active_rows_adrift).toBe(3);
    expect(report.clusters[0].covered).toBe(false);
  });

  it('does NOT count archived rows stranded on an alias scope as drift', () => {
    // The migration residue: 178 such rows existed live after a "residual 0" run.
    // They must be visible per-variant but must not make a clean corpus read dirty.
    const report = buildScopeDrift([
      agg('client:acme-foods', { total: 40, active: 40 }),
      agg('client:Acme-Foods', { total: 12, active: 0, archived: 12 }),
    ], buildScopeResolution({})); // deliberately un-aliased, so only the active/archived rule can zero it

    expect(report.summary.active_rows_adrift).toBe(0);
    const variant = report.clusters[0].variants.find(v => v.scope === 'client:Acme-Foods');
    expect(variant?.archived).toBe(12);
    // Structurally uncovered, but it owes the operator no ruling — the split the
    // real corpus forced (14 uncovered vs 7 actually actionable, 2026-08-14).
    expect(report.summary.clusters_uncovered).toBe(1);
    expect(report.summary.clusters_actionable).toBe(0);
  });

  it('carries the type breakdown that settles cross-prefix rulings', () => {
    const report = buildScopeDrift([
      agg('client:acme', { total: 38, active: 38, by_type: { project: 16, reference: 12, feedback: 10 } }),
      agg('project:Acme', { total: 18, active: 18, by_type: { discovery: 17, reference: 1 } }),
    ], buildScopeResolution({}));

    const cluster = report.clusters[0];
    expect(cluster.kind).toBe('cross_prefix');
    // No canonical is proposed — choosing the prefix IS the operator's ruling.
    expect(cluster.canonical).toBeNull();
    const projectSide = cluster.variants.find(v => v.scope === 'project:Acme');
    expect(projectSide?.by_type.discovery).toBe(17);
    expect(cluster.variants.find(v => v.scope === 'client:acme')?.by_type.discovery).toBeUndefined();
  });

  it('treats a cross-prefix pair as ruled once the table routes one side away', () => {
    const aggregates = [
      agg('client:acme', { total: 38, active: 38 }),
      agg('project:Acme', { total: 18, active: 18 }),
    ];
    expect(buildScopeDrift(aggregates, buildScopeResolution({})).summary.clusters_uncovered).toBe(1);
    expect(
      buildScopeDrift(aggregates, buildScopeResolution({ 'project:Acme': 'client:acme' })).summary.clusters_uncovered,
    ).toBe(0);
  });

  it('includes a zero-row canonical so the correct spelling is visible', () => {
    const report = buildScopeDrift([
      agg('project:Fuel Dashboard', { total: 5, active: 5 }),
    ], buildScopeResolution({}));
    const canonical = report.clusters[0].variants.find(v => v.scope === 'project:fuel-dashboard');
    expect(canonical).toBeDefined();
    expect(canonical?.total).toBe(0);
  });

  it('separates ephemeral scopes from drift and never proposes aliasing them', () => {
    const report = buildScopeDrift([
      agg('project:wf_a1b2c3', { total: 4, active: 4 }),
      agg('project:agent-deadbeef12', { total: 2, active: 2 }),
      agg('project:0', { total: 1, active: 1 }),
      agg('client:acme-foods', { total: 10, active: 10 }),
    ], buildScopeResolution({}));

    expect(report.summary.ephemeral_scopes).toBe(3);
    expect(report.summary.ephemeral_rows).toBe(7);
    expect(report.summary.active_rows_adrift).toBe(0);
    expect(report.clusters.some(c => c.key.includes('wf'))).toBe(false);
  });

  it('sorts worst-first by live rows adrift', () => {
    const report = buildScopeDrift([
      agg('client:small', { total: 1, active: 1 }), agg('client:Small', { total: 2, active: 2 }),
      agg('client:big', { total: 1, active: 1 }), agg('client:BIG', { total: 90, active: 90 }),
    ], buildScopeResolution({}));
    expect(report.clusters[0].active_rows_adrift).toBe(90);
  });

  it('is fail-open on an empty corpus and an empty table', () => {
    const report = buildScopeDrift([], buildScopeResolution({}));
    expect(report.summary.active_rows_adrift).toBe(0);
    expect(report.clusters).toEqual([]);
  });
});

describe('foldScopeAggregates — the shared store fold', () => {
  it('folds (scope, type) group rows into one row per scope', () => {
    const rows = foldScopeAggregates([
      { scope: 'client:acme', type: 'project', n: 3, active: 2, first_write: '2026-01-02', last_write: '2026-03-01' },
      { scope: 'client:acme', type: 'reference', n: 2, active: 2, first_write: '2026-01-01', last_write: '2026-02-01' },
      { scope: 'global', type: 'feedback', n: 1, active: 1, first_write: '2026-05-01', last_write: '2026-05-01' },
    ]);

    const acme = rows.find(r => r.scope === 'client:acme')!;
    expect(acme.total).toBe(5);
    expect(acme.active).toBe(4);
    expect(acme.archived).toBe(1);
    expect(acme.by_type).toEqual({ project: 3, reference: 2 });
    // Widest span across the type groups.
    expect(acme.first_write).toBe('2026-01-01');
    expect(acme.last_write).toBe('2026-03-01');
  });

  it('coerces string counts (the pg driver returns COUNT/SUM as strings)', () => {
    const [row] = foldScopeAggregates([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { scope: 'client:acme', type: 'project', n: '7' as any, active: '5' as any, first_write: null, last_write: null },
    ]);
    expect(row.total).toBe(7);
    expect(row.active).toBe(5);
    expect(row.archived).toBe(2);
  });

  it('orders by total descending', () => {
    const rows = foldScopeAggregates([
      { scope: 'a', type: 'project', n: 1, active: 1, first_write: null, last_write: null },
      { scope: 'b', type: 'project', n: 9, active: 9, first_write: null, last_write: null },
    ]);
    expect(rows.map(r => r.scope)).toEqual(['b', 'a']);
  });
});

describe('clustering primitives still behave after the move to src/', () => {
  it('slugifyScope normalizes case and separators, preserving the prefix', () => {
    expect(slugifyScope('client:Acme-Foods')).toBe('client:acme-foods');
    expect(slugifyScope('project:_platform')).toBe('project:platform');
    expect(slugifyScope('global')).toBeNull();
  });

  it('clusterScopes still separates mechanical from cross-prefix', () => {
    const r = clusterScopes({ 'client:Acme': 1, 'client:acme': 2, 'project:acme': 3 });
    expect(r.crossPrefix).toHaveLength(1);
    expect(r.mechanical).toHaveLength(0);
  });
});

describe('buildScopeDrift — coverage comes from the ACCEPTED map (Phase 1)', () => {
  const agg = (scope: string, active: number) => ({
    scope, total: active, active, archived: 0,
    by_type: { discovery: active }, first_write: '2026-01-01', last_write: '2026-08-01',
  });

  it('does NOT count a chained mapping as coverage — the false-green regression', () => {
    // 'client:Acme-Foods' is both an alias key and a canonical value (of
    // 'client:third'), so its own mapping is REJECTED as chained and the write
    // path ignores it — rows keep landing on the variant. Pre-Phase-1 the
    // detector's lax reader accepted the entry anyway, read `aliased_to`
    // non-null → covered → 0 adrift: clean during the exact failure it
    // exists to detect.
    const resolution = buildScopeResolution({
      'client:Acme-Foods': 'client:acme-foods',
      'client:third': 'client:Acme-Foods',
    });
    const report = buildScopeDrift(
      [agg('client:acme-foods', 5), agg('client:Acme-Foods', 3)],
      resolution,
    );

    expect(report.summary.active_rows_adrift).toBe(3);
    expect(report.summary.clusters_actionable).toBe(1);
    expect(report.summary.alias_entries_rejected).toBe(1);
    const variant = report.clusters[0].variants.find(v => v.scope === 'client:Acme-Foods');
    // The chained mapping is ignored by the write path, so the ACCEPTED map
    // has no entry for the variant — it is NOT covered.
    expect(variant?.aliased_to).toBeNull();
    expect(report.clusters[0].covered).toBe(false);
  });

  it('counts an accepted mapping as coverage and reports the table version', () => {
    const resolution = buildScopeResolution({ 'client:Acme-Foods': 'client:acme-foods' });
    const report = buildScopeDrift(
      [agg('client:acme-foods', 5), agg('client:Acme-Foods', 3)],
      resolution,
    );
    expect(report.summary.active_rows_adrift).toBe(0);
    expect(report.summary.alias_entries_rejected).toBe(0);
    expect(report.summary.alias_table_version).toBe(resolution.version);
  });
});
