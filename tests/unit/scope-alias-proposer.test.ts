import { describe, it, expect } from 'vitest';
import { slugifyScope, clusterScopes } from '../../scripts/ops/propose-scope-aliases.js';

describe('slugifyScope', () => {
  it('lowercases and collapses non-alphanumerics to single hyphens, preserving the prefix', () => {
    expect(slugifyScope('client:Acme-Foods')).toBe('client:acme-foods');
    expect(slugifyScope('project:Fuel Dashboard 2.0')).toBe('project:fuel-dashboard-2-0');
    expect(slugifyScope('project:_platform')).toBe('project:platform');
  });
  it('returns null for non client:/project: scopes and empty slugs', () => {
    expect(slugifyScope('global')).toBeNull();
    expect(slugifyScope('project:!!!')).toBeNull();
  });
});

describe('clusterScopes', () => {
  it('groups same-prefix same-slug variants; canonical = the slug form itself', () => {
    const r = clusterScopes({
      'client:Acme-Foods': 10, 'client:acmefoods': 2, 'client:acme-foods': 40,
      'project:solo': 5,
    });
    const acme = r.mechanical.find(m => m.canonical === 'client:acme-foods')!;
    // the variant equal to the canonical slug is NOT listed as an alias of itself
    expect(acme.variants.map(v => v.scope).sort()).toEqual(['client:Acme-Foods']);
    // 'client:acmefoods' slugs to 'client:acmefoods' (no separator) — different slug, NOT auto-clustered
    expect(r.passthrough.map(p => p.scope)).toContain('project:solo');
  });

  it('flags cross-prefix slug collisions instead of proposing them', () => {
    const r = clusterScopes({ 'client:zeta': 3, 'project:Zeta': 2 });
    expect(r.crossPrefix).toHaveLength(1);
    expect(r.mechanical).toHaveLength(0);
  });

  it('classifies ephemeral shapes with reasons', () => {
    const r = clusterScopes({
      'project:wf_ab12cd34-e5f-1': 4,
      'project:agent-a34b721ba2a431efe': 2,
      'project:20260528-group-a': 4,
      'project:7': 1,
    });
    expect(r.ephemeral.map(e => e.scope)).toHaveLength(4);
    expect(r.ephemeral.every(e => e.reason.length > 0)).toBe(true);
  });
});
