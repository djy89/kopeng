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
import { buildScopeDrift, clusterScopes, ephemeralReason, slugifyScope, DistinctRulings, type ScopeAggregate } from '../../src/scopes/drift.js';
import { foldScopeAggregates } from '../../src/database/queries.js';
import { buildScopeResolution, EMPTY_RESOLUTION } from '../../src/scopes/resolver.js';

function agg(scope: string, over: Partial<ScopeAggregate> = {}): ScopeAggregate {
  return {
    scope, total: 0, active: 0, archived: 0, by_type: {}, by_source: {}, by_source_active: {}, anchored: 0, first_write: null, last_write: null,
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

  it('T77: files a trailing-date scope as ephemeral instead of proposing an alias', () => {
    const report = buildScopeDrift([
      agg('project:Vendor Packs - 2026-08-21', { total: 3, active: 3 }),
    ], buildScopeResolution({}));

    expect(report.summary.ephemeral_scopes).toBe(1);
    expect(report.summary.ephemeral_rows).toBe(3);
    expect(report.summary.active_rows_adrift).toBe(0);
    expect(report.clusters).toHaveLength(0);
    // The reason is OUTPUT — rendered by the ops endpoint and the future panel.
    expect(report.ephemeral[0].reason).toBe('date-stamped sprint/dir scope');
  });

  it('T77: files a +-suffixed bare number as ephemeral, not as a casing cluster against its slug ghost', () => {
    // A dir literally named `NNN+` slugs to its bare number, producing a
    // mechanical cluster against a zero-row canonical — an alias nobody
    // should ever approve.
    const clustered = clusterScopes({ 'project:300+': 1 });
    expect(clustered.ephemeral).toHaveLength(1);
    expect(clustered.ephemeral[0].scope).toBe('project:300+');
    expect(clustered.ephemeral[0].reason).toBe('bare-number scope');
    expect(clustered.mechanical).toHaveLength(0);
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

  it('GATE L-A: an ephemeral entry carries the SAME evidence a cluster variant does', () => {
    // The rows with the DESTRUCTIVE action had the least evidence: the payload
    // was {scope, count, reason, aliased_to, ruled_distinct} and nothing else,
    // while a variant whose action is merely an alias carried the full
    // aggregate. The operator archiving a scope could not see what was in it.
    const report = buildScopeDrift([
      agg('project:wf_a1b2c3', {
        total: 6, active: 4, archived: 2,
        by_type: { discovery: 5, project: 1 },
        by_source: { 'auto-discovery': 5, manual: 1 },
        first_write: '2026-08-01T00:00:00Z',
        last_write: '2026-08-20T00:00:00Z',
      }),
    ], buildScopeResolution({}));

    expect(report.ephemeral).toHaveLength(1);
    const e = report.ephemeral[0];
    // The evidence half — identical shape to ScopeVariantEvidence.
    expect(e).toMatchObject({
      scope: 'project:wf_a1b2c3',
      total: 6, active: 4, archived: 2,
      by_type: { discovery: 5, project: 1 },
      by_source: { 'auto-discovery': 5, manual: 1 },
      first_write: '2026-08-01T00:00:00Z',
      last_write: '2026-08-20T00:00:00Z',
    });
    // The pre-existing half, unchanged — `count` is kept for back-compat and
    // still equals `total`, and the release evidence still rides along.
    expect(e).toMatchObject({ count: 6, reason: 'workflow-run scope', aliased_to: null, ruled_distinct: false });
    expect(e.count).toBe(e.total);
    // ephemeral_rows math is unchanged by the widened payload.
    expect(report.summary.ephemeral_rows).toBe(6);
    expect(report.summary.ephemeral_scopes).toBe(1);
  });

  it('GATE L-A: the widened ephemeral payload still carries release evidence and leaves the aliased/ruled cases alone', () => {
    // The three-way regression guard: aliasing and ruling still land on the
    // ephemeral entry after it started spreading a full aggregate, and the
    // evidence fields ride along on every one of them.
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'project:20260901-demo', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift([
      agg('project:20260901-demo', { total: 2, active: 2, by_type: { discovery: 2 } }),
      agg('project:20260902-x', { total: 1, active: 1, by_type: { project: 1 } }),
      agg('project:20260903-y', { total: 5, active: 3, archived: 2 }),
    ], buildScopeResolution({ 'project:20260902-x': 'project:real' }), distinct);

    const byScope = Object.fromEntries(report.ephemeral.map(e => [e.scope, e]));
    expect(byScope['project:20260901-demo']).toMatchObject({ ruled_distinct: true, active: 2, by_type: { discovery: 2 } });
    expect(byScope['project:20260902-x']).toMatchObject({ aliased_to: 'project:real', active: 1, by_type: { project: 1 } });
    expect(byScope['project:20260903-y']).toMatchObject({ aliased_to: null, ruled_distinct: false, active: 3, archived: 2 });
    expect(report.summary.ephemeral_rows).toBe(8);
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

describe('foldScopeAggregates by_source (T76 §5.1)', () => {
  it('folds (scope, type, source) rows into per-scope by_source without disturbing by_type', () => {
    const rows = [
      { scope: 'project:web', type: 'discovery', source: 'auto-discovery', n: 9, active: 9, first_write: '2026-08-01', last_write: '2026-08-10' },
      { scope: 'project:web', type: 'discovery', source: null,             n: 1, active: 1, first_write: '2026-08-02', last_write: '2026-08-03' },
      { scope: 'project:web', type: 'reference', source: 'auto-discovery', n: 2, active: 1, first_write: '2026-07-01', last_write: '2026-08-12' },
    ];
    const [agg] = foldScopeAggregates(rows);
    expect(agg.total).toBe(12);
    expect(agg.by_type).toEqual({ discovery: 10, reference: 2 });
    expect(agg.by_source).toEqual({ 'auto-discovery': 11, unknown: 1 });
    expect(agg.first_write).toBe('2026-07-01');
    expect(agg.last_write).toBe('2026-08-12');
  });

  // `source` is a free-text stored column, so its values are attacker-shaped
  // input to the tally's KEYS. On a plain-object accumulator the `__proto__`
  // assignment hits the prototype setter instead of creating an own property,
  // and that group's rows disappear from by_source while total still counts
  // them — a silently wrong ops number. Null-prototype accumulators keep it a
  // normal key.
  it('tallies a "__proto__" source value instead of losing it to the prototype', () => {
    const rows = [
      { scope: 'project:web', type: 'discovery', source: '__proto__',      n: 3, active: 3, first_write: '2026-08-01', last_write: '2026-08-10' },
      { scope: 'project:web', type: 'discovery', source: 'auto-discovery', n: 4, active: 4, first_write: '2026-08-01', last_write: '2026-08-10' },
    ];
    const [agg] = foldScopeAggregates(rows);
    expect(agg.total).toBe(7);
    expect(Object.prototype.hasOwnProperty.call(agg.by_source, '__proto__')).toBe(true);
    expect(agg.by_source['__proto__']).toBe(3);
    expect(agg.by_source['auto-discovery']).toBe(4);
    // The counts still reconcile against total — the bug's visible symptom.
    expect(Object.values(agg.by_source).reduce((n, v) => n + v, 0)).toBe(7);
    // And the row is still an ordinary object for JSON/deep-equality purposes.
    expect(JSON.parse(JSON.stringify(agg)).by_source['__proto__']).toBe(3);
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

describe('ephemeralReason — T77: the date-SUFFIX house convention', () => {
  // Dated one-off artifact dirs commonly carry the date as a SUFFIX
  // (`Vendor Packs - 2026-08-21/`), but the original rules anchored dates at
  // the START only. These pin the widened boundary from BOTH sides. All
  // referents synthetic (fixture hygiene — this file exports publicly).
  // Blast radius is deliberate: this predicate also feeds decideMint (see the
  // T77 consumer cases in scope-minting-decision.test.ts), buildHoldPredicate
  // (R-B hold — hold-predicate.test.ts), and the maintenance purge exemption.

  it.each([
    'project:Site Reviews - 2026-08-18', // spaced full-date suffix
    'project:vendor-packs-2026-08-21',   // hyphenated full-date suffix
    'project:layout-refresh_2026-08',    // year-month suffix
    'project:retro-20260818',            // 8-digit suffix
  ])('trailing date ⇒ ephemeral: %s', (scope) => {
    expect(ephemeralReason(scope)).toBe('date-stamped sprint/dir scope');
  });

  it.each([
    'project:Site Reviews (2026-08-18)', // paren separators — real dirs use these
    'project:site-reviews.2026-08-18',   // dot separator
  ])('separator-robust via the slug fold (detection only, never resolution): %s', (scope) => {
    expect(ephemeralReason(scope)).toBe('date-stamped sprint/dir scope');
  });

  it.each([
    ['project:300+', 'bare-number scope'],   // a dir literally named `300+`
    ['project:42', 'bare-number scope'],     // the (T77-modified) bare-number rule
    ['project:Sprint 12', 'sprint-numbered scope'],
    ['project:sprint-3', 'sprint-numbered scope'],
    ['project:sprint-1234', 'sprint-numbered scope'], // 4-digit bound (year-shaped, still a sprint counter)
  ])('numeric/sprint dir ⇒ ephemeral with the EXACT rendered reason: %s → %s', (scope, reason) => {
    expect(ephemeralReason(scope)).toBe(reason);
  });

  it.each([
    'project:2026-08-18-site-reviews', // start-anchored — the pre-T77 rules, unchanged
    'project:20260818',
  ])('pre-T77 start-anchored shapes still match: %s', (scope) => {
    expect(ephemeralReason(scope)).not.toBeNull();
  });

  it.each([
    'project:budget-2027',      // a trailing bare YEAR is a real project name, not a date
    'project:northwind-gmb',    // ordinary hyphenated project name
    'project:top-200-list',     // digits mid-name
    'project:sprinter-van',     // 'sprint' inside a word
    'project:sprint-12345',     // 5+ digits reads as an id, not a sprint counter
    'project:atlas-2',          // trailing single digit, no sprint word
    'project:v20260818',        // no separator before the digits
    // Calendar validation (team review H1 — digit-COUNT matching also captured
    // ticket/invoice/order ids, and a false positive here is not cosmetic: the
    // scope stops minting, holds observations indefinitely under R-B, and its
    // rows exempt from retention purge forever):
    'project:ticket-12345678',  // id-shaped 8 digits (month 34 is not a month)
    'project:invoice-1234-56',  // NNNN-NN that is no year-month (month 56)
    'project:report-2026-13',   // month 13
    'project:q3-2026-08-99',    // day 99
    'project:build-40230518',   // year 4023
    // Trailing-text asymmetry, INTENDED (team review): the suffix rules anchor
    // at end-of-string — a date mid-name is not claimed (fewer false
    // positives) — while the start-anchored rules allow a remainder because
    // date-FIRST is unambiguous.
    'project:vendor-packs-2026-08-21-v2',
    'project:Site Reviews - 2026-08-18 final',
  ])('must NOT match: %s', (scope) => {
    expect(ephemeralReason(scope)).toBeNull();
  });

  it.each([
    'client:300+',
    'client:Sprint 12',
    'client:foo-20260818',
    'client:site-reviews - 2026-08-18',
  ])('client: scopes are operator-authored entities, never ephemeral: %s', (scope) => {
    expect(ephemeralReason(scope)).toBeNull();
  });
});

describe('buildScopeDrift — coverage comes from the ACCEPTED map (Phase 1)', () => {
  const agg = (scope: string, active: number) => ({
    scope, total: active, active, archived: 0,
    by_type: { discovery: active }, by_source: {}, by_source_active: {}, anchored: 0, first_write: '2026-01-01', last_write: '2026-08-01',
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

describe('T76 ruled-distinct drift coverage', () => {
  const agg = (scope: string, active: number): ScopeAggregate =>
    ({ scope, total: active, active, archived: 0, by_type: {}, by_source: {}, by_source_active: {}, anchored: 0, first_write: null, last_write: null });

  it('a cluster whose uncovered variants are all ruled-distinct leaves the actionable counts but stays visible + labeled', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'client:Acme-Foods', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift([agg('client:acme-foods', 3), agg('client:Acme-Foods', 2)], EMPTY_RESOLUTION, distinct);
    const cluster = report.clusters.find(c => c.key === 'client:acme-foods')!;
    expect(cluster.ruled_distinct).toBe(true);
    expect(cluster.active_rows_adrift).toBe(0);
    expect(report.summary.clusters_ruled_distinct).toBe(1);
    expect(report.summary.clusters_uncovered).toBe(0);
    expect(report.summary.clusters_actionable).toBe(0);
    expect(report.summary.active_rows_adrift).toBe(0);
  });

  it('fail-open: EMPTY rulings mean the same cluster reads uncovered/actionable (over-report, the safe side)', () => {
    const report = buildScopeDrift([agg('client:acme-foods', 3), agg('client:Acme-Foods', 2)]);
    expect(report.summary.clusters_ruled_distinct).toBe(0);
    expect(report.summary.clusters_actionable).toBe(1);
    expect(report.summary.active_rows_adrift).toBe(2);
  });

  // The cross_prefix ruling arithmetic deliberately does NOT reuse alias
  // coverage's "last one standing" shortcut. An alias MOVES rows, so one
  // survivor means nothing is adrift; a mark_distinct ruling moves nothing, so
  // an untouched member keeps its rows on an un-ruled spelling however many of
  // its siblings were ruled. Over-reporting is the safe direction.
  it('a partially-ruled 3-member cross-prefix cluster still reports the untouched survivor', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'client:Foo', ruled_distinct_at: '2026-09-01T00:00:00Z' },
      { scope: 'project:foo', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift(
      [agg('client:Foo', 4), agg('project:foo', 9), agg('client:foo', 6)],
      EMPTY_RESOLUTION, distinct);
    const cluster = report.clusters.find(c => c.kind === 'cross_prefix')!;
    expect(cluster.ruled_distinct).toBe(false);
    expect(cluster.active_rows_adrift).toBe(6);   // client:foo only — the ruled pair is excluded
    expect(report.summary.clusters_ruled_distinct).toBe(0);
    expect(report.summary.clusters_actionable).toBe(1);
    expect(report.summary.active_rows_adrift).toBe(6);
  });

  it('a 2-member cross-prefix cluster with ONE ruled member reports the other', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'project:acme', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift(
      [agg('client:acme', 5), agg('project:acme', 11)],
      EMPTY_RESOLUTION, distinct);
    const cluster = report.clusters.find(c => c.kind === 'cross_prefix')!;
    expect(cluster.ruled_distinct).toBe(false);
    expect(cluster.active_rows_adrift).toBe(5);
    expect(report.summary.clusters_actionable).toBe(1);
  });

  it('a FULLY ruled cross-prefix cluster leaves the actionable counts, still labeled', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'client:acme', ruled_distinct_at: '2026-09-01T00:00:00Z' },
      { scope: 'project:acme', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift(
      [agg('client:acme', 5), agg('project:acme', 11)],
      EMPTY_RESOLUTION, distinct);
    const cluster = report.clusters.find(c => c.kind === 'cross_prefix')!;
    expect(cluster.ruled_distinct).toBe(true);
    expect(cluster.active_rows_adrift).toBe(0);
    expect(report.summary.clusters_ruled_distinct).toBe(1);
    expect(report.summary.clusters_uncovered).toBe(0);
    expect(report.summary.clusters_actionable).toBe(0);
  });

  // Per-variant, not just the cluster aggregate: the panel's bulk "alias the
  // variants" button needs to know WHICH member was ruled, or it would alias
  // away the one scope the operator just ruled separate.
  it('every variant carries its OWN ruled_distinct flag', () => {
    const distinct = DistinctRulings.fromRegistryRows([
      { scope: 'client:Acme-Foods', ruled_distinct_at: '2026-09-01T00:00:00Z' },
    ]);
    const report = buildScopeDrift(
      [agg('client:acme-foods', 3), agg('client:Acme-Foods', 2), agg('client:ACME-FOODS', 4)],
      EMPTY_RESOLUTION, distinct);
    const cluster = report.clusters.find(c => c.key === 'client:acme-foods')!;
    const byScope = Object.fromEntries(cluster.variants.map(v => [v.scope, v]));
    expect(byScope['client:Acme-Foods'].ruled_distinct).toBe(true);
    expect(byScope['client:ACME-FOODS'].ruled_distinct).toBe(false);
    expect(byScope['client:acme-foods'].ruled_distinct).toBe(false);
    // The cluster aggregate stays false while an un-ruled variant remains.
    expect(cluster.ruled_distinct).toBe(false);
    expect(cluster.active_rows_adrift).toBe(4);
  });

  it('ephemeral entries carry aliased_to + ruled_distinct evidence for the panel', () => {
    const distinct = DistinctRulings.fromRegistryRows([{ scope: 'project:20260901-demo', ruled_distinct_at: '2026-09-01T00:00:00Z' }]);
    const coverage = { table: { 'project:20260902-x': 'project:real' }, rejected: [], version: 'v1' };
    const report = buildScopeDrift(
      [agg('project:20260901-demo', 1), agg('project:20260902-x', 1), agg('project:20260903-y', 1)],
      coverage, distinct);
    const byScope = Object.fromEntries(report.ephemeral.map(e => [e.scope, e]));
    expect(byScope['project:20260901-demo'].ruled_distinct).toBe(true);
    expect(byScope['project:20260902-x'].aliased_to).toBe('project:real');
    expect(byScope['project:20260903-y']).toMatchObject({ aliased_to: null, ruled_distinct: false });
  });
});
