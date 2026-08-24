/**
 * The ONE case-sensitivity regime (Phase 1): case variants are equated by the
 * ALIAS TABLE, not by SQL folding. This suite pins what each layer does today so
 * the divergence is visible and any accidental change is loud.
 *
 * Known, deliberate exception still in place: the memory SQL folds case
 * (COLLATE NOCASE / LOWER(...)) at three sites per backend. Removing the fold is
 * gated on `active_rows_adrift` reaching 0 on live — until then it keeps rows on
 * un-tabled case variants reachable. It is why the migration driver carries its
 * own client-side exact-case filter.
 */
import { describe, it, expect } from 'vitest';
import { SCOPE_CASE_REGIME, buildScopeResolution } from '../../src/scopes/resolver.js';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';

describe('scope case-sensitivity regime', () => {
  it('declares the alias-mediated regime', () => {
    expect(SCOPE_CASE_REGIME).toBe('alias-mediated');
  });

  it('the resolver is EXACT: a case variant is only equated when the table says so', () => {
    const empty = buildScopeResolution({});
    expect(empty.forward.get('client:Acme-Foods')).toBeUndefined();

    const tabled = buildScopeResolution({ 'client:Acme-Foods': 'client:acme-foods' });
    expect(tabled.forward.get('client:Acme-Foods')).toBe('client:acme-foods');
    // Still exact in the other direction — the canonical is not an alias.
    expect(tabled.forward.get('client:acme-foods')).toBeUndefined();
    // And a case variant NOT in the table stays distinct.
    expect(tabled.forward.get('client:ACME-FOODS')).toBeUndefined();
  });

  it('the memory SQL still FOLDS case — pinned as the known exception', async () => {
    const { db, queries } = createTestDatabase();
    await queries.store(createTestMemory({ scope: 'client:acme-foods', content: 'lower' }));
    await queries.store(createTestMemory({ scope: 'client:Acme-Foods', content: 'mixed' }));

    const { memories } = await queries.list({ scope: 'client:acme-foods', limit: 10, include_archived: false });
    // Both rows come back: the list query is case-insensitive on both backends.
    // If this ever returns 1, the SQL fold was removed — update the regime doc,
    // and confirm active_rows_adrift was 0 on live before the flip landed.
    expect(memories).toHaveLength(2);

    db.close();
  });

  it('slug folding belongs to DETECTION only, never to resolution', async () => {
    const { slugifyScope } = await import('../../src/scopes/drift.js');
    // The detector folds aggressively so it can SPOT variants...
    expect(slugifyScope('client:Acme_Foods')).toBe('client:acme-foods');
    expect(slugifyScope('client:acme-foods')).toBe('client:acme-foods');
    // ...but that never makes them equal to the resolver, which is what writes.
    expect(buildScopeResolution({}).forward.get('client:Acme_Foods')).toBeUndefined();
  });
});
