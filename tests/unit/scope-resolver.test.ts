import { describe, it, expect } from 'vitest';
import {
  buildScopeResolution,
  isScopeForm,
  EMPTY_RESOLUTION,
} from '../../src/scopes/resolver.js';

describe('isScopeForm', () => {
  it('accepts the three legal scope forms and rejects everything else', () => {
    expect(isScopeForm('global')).toBe(true);
    expect(isScopeForm('project:kopeng')).toBe(true);
    expect(isScopeForm('client:acme-foods')).toBe(true);
    // P6 finding: `status:archived` rode along in three markers as a dead scope.
    expect(isScopeForm('status:archived')).toBe(false);
    expect(isScopeForm('project:')).toBe(false);
    expect(isScopeForm('kopeng')).toBe(false);
    expect(isScopeForm('')).toBe(false);
  });
});

describe('buildScopeResolution — accepted entries', () => {
  it('builds forward map and canonical groups from a valid table', () => {
    const r = buildScopeResolution({
      'client:Acme-Foods': 'client:acme-foods',
      'client:acmefoods': 'client:acme-foods',
      'project:Fuel-Dashboard': 'project:fuel-dashboard',
    });
    expect(r.forward.get('client:Acme-Foods')).toBe('client:acme-foods');
    expect(r.groups.get('client:acme-foods')).toEqual(
      expect.arrayContaining(['client:Acme-Foods', 'client:acmefoods']),
    );
    expect(r.groups.get('project:fuel-dashboard')).toEqual(['project:Fuel-Dashboard']);
    expect(r.rejected).toEqual([]);
    // `table` is the accepted map as a plain object — what non-Map consumers read.
    expect(r.table).toEqual({
      'client:Acme-Foods': 'client:acme-foods',
      'client:acmefoods': 'client:acme-foods',
      'project:Fuel-Dashboard': 'project:fuel-dashboard',
    });
  });
});

describe('buildScopeResolution — rejection reasons', () => {
  it('rejects each malformed class with a named reason and keeps the rest', () => {
    const r = buildScopeResolution({
      'client:good': 'client:canonical',
      'client:num': 42,
      'client:blank': '',
      'client:same': 'client:same',
      'client:chain-head': 'client:canonical-b',
      'client:canonical-b': 'client:canonical-c',
      'project:web': 'client:canonical',
      'status:archived': 'client:canonical',
    });

    expect(r.forward.get('client:good')).toBe('client:canonical');
    const byAlias = new Map(r.rejected.map(x => [x.alias, x.reason]));
    expect(byAlias.get('client:num')).toBe('non_string');
    expect(byAlias.get('client:blank')).toBe('empty');
    expect(byAlias.get('client:same')).toBe('self_map');
    // `client:canonical-b` is BOTH an alias key and a canonical value → chain.
    expect(byAlias.get('client:canonical-b')).toBe('chained');
    // P13: an auto-minted generic key routed into a DIFFERENT namespace. The
    // canonicalizer has no directory context, so this asserts "every folder
    // named web, forever, for any client, belongs to that client".
    expect(byAlias.get('project:web')).toBe('generic_capture');
    expect(byAlias.get('status:archived')).toBe('malformed_scope');
    // Rejected entries are ABSENT from the accepted view — the whole point.
    for (const alias of byAlias.keys()) {
      expect(r.forward.has(alias)).toBe(false);
      expect(r.table[alias]).toBeUndefined();
    }
  });

  it('rejects a chained mapping without dropping the head of the chain', () => {
    const r = buildScopeResolution({
      'client:a': 'client:b',
      'client:b': 'client:c',
    });
    expect(r.forward.get('client:a')).toBe('client:b');
    expect(r.forward.has('client:b')).toBe(false);
    expect(r.rejected.map(x => x.alias)).toEqual(['client:b']);
  });

  it('rejects generic-key CAPTURE but allows a pure fold of the same name', () => {
    // Capture: an auto-minted generic key routed into a different namespace.
    for (const table of [
      { 'project:web': 'client:acme-foods' },     // the literal P13 shape
      { 'project:src': 'project:kopeng' },        // every project has a src
      { 'project:_platform': 'client:acme-foods' }, // slug-folds to `platform`
      { 'project:backup': 'global' },             // generic → global is capture too
    ]) {
      const r = buildScopeResolution(table);
      expect(r.rejected[0]?.reason).toBe('generic_capture');
      expect(r.forward.size).toBe(0);
    }
  });

  it('allows the harmless cases the capture rule deliberately permits', () => {
    // Pure casing fold of the SAME generic name — captures nothing.
    expect(buildScopeResolution({ 'project:Web': 'project:web' }).forward.size).toBe(1);
    expect(buildScopeResolution({ 'project:Backup': 'project:backup' }).forward.size).toBe(1);
    // A `client:` key is operator-authored and deliberate, never auto-minted.
    expect(buildScopeResolution({ 'client:web': 'client:acme-foods' }).forward.size).toBe(1);
    // A non-generic project key may point anywhere.
    expect(buildScopeResolution({ 'project:kopeng': 'client:acme-foods' }).forward.size).toBe(1);
    // A generic name on the RIGHT alone is not capture.
    expect(buildScopeResolution({ 'project:Some-Real-Thing': 'project:data' }).forward.size).toBe(1);
  });
});

describe('buildScopeResolution — versioning', () => {
  it('is stable across key order and changes when the accepted table changes', () => {
    const a = buildScopeResolution({ 'client:x': 'client:y', 'client:z': 'client:y' });
    const b = buildScopeResolution({ 'client:z': 'client:y', 'client:x': 'client:y' });
    expect(a.version).toBe(b.version);

    const c = buildScopeResolution({ 'client:x': 'client:y' });
    expect(c.version).not.toBe(a.version);
  });

  it('ignores rejected entries when computing the version', () => {
    const clean = buildScopeResolution({ 'client:x': 'client:y' });
    const withJunk = buildScopeResolution({ 'client:x': 'client:y', 'client:same': 'client:same' });
    expect(withJunk.version).toBe(clean.version);
  });
});

describe('buildScopeResolution — fail-open', () => {
  it('returns an empty resolution for garbage input rather than throwing', () => {
    for (const raw of [null, undefined, 'nope', 7, ['client:a'], true]) {
      const r = buildScopeResolution(raw);
      expect(r.forward.size).toBe(0);
      expect(r.groups.size).toBe(0);
      expect(r.table).toEqual({});
      expect(r.version).toBe(EMPTY_RESOLUTION.version);
    }
  });
});
