/**
 * "Same scope" and "is global" are decisions, so they live in one place.
 * Pre-Phase-1 they were open-coded at five sites. Exact-string comparison is the
 * alias-mediated regime (SCOPE_CASE_REGIME): two scopes are the same iff their
 * strings match — canonicalization happens at WRITE time, so by the time rows
 * are compared they are already canonical.
 */
import { describe, it, expect } from 'vitest';
import { sameScope, isGlobalScope, GLOBAL_SCOPE } from '../../src/scopes/resolver.js';

describe('sameScope', () => {
  it('is exact-string, per the alias-mediated regime', () => {
    expect(sameScope('client:acme-foods', 'client:acme-foods')).toBe(true);
    expect(sameScope('client:acme-foods', 'client:Acme-Foods')).toBe(false);
    expect(sameScope('project:a', 'project:b')).toBe(false);
    expect(sameScope('global', 'global')).toBe(true);
  });
});

describe('isGlobalScope', () => {
  it('recognizes only the global scope', () => {
    expect(isGlobalScope(GLOBAL_SCOPE)).toBe(true);
    expect(isGlobalScope('global')).toBe(true);
    expect(isGlobalScope('project:global')).toBe(false);
    expect(isGlobalScope('Global')).toBe(false);
  });
});

describe('the dream selector uses the shared comparison', () => {
  it('classifyDupPair still buckets different scopes as cross_scope', async () => {
    const { classifyDupPair } = await import('../../src/dreaming/pipeline.js');
    const mem = (id: number, scope: string) => ({
      id, scope, confidence: 0.7, is_locked: false, metadata: null,
    });
    expect(classifyDupPair(mem(1, 'project:a'), mem(2, 'project:b'))).toBe('cross_scope');
    expect(classifyDupPair(mem(1, 'project:a'), mem(2, 'project:a'))).toBe('actionable');
    // Case variants are DIFFERENT scopes — the alias table equates them at write
    // time, so a surviving pair like this is drift, not a duplicate to collapse.
    expect(classifyDupPair(mem(1, 'project:a'), mem(2, 'project:A'))).toBe('cross_scope');
  });
});
