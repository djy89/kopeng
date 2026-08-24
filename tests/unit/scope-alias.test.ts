import { describe, it, expect } from 'vitest';
import { buildAliasMaps, ScopeAliasService, SCOPE_ALIASES_CONFIG_KEY } from '../../src/services/scope-alias.js';
import type { IOperatorConfigStore } from '../../src/database/interfaces.js';

function stubStore(configBlob: unknown): IOperatorConfigStore {
  return {
    getConfig: async () => ({ config: configBlob }) as never,
    updateConfig: async () => { throw new Error('not used'); },
  } as unknown as IOperatorConfigStore;
}

describe('buildAliasMaps', () => {
  it('builds forward map and canonical groups from a valid table', () => {
    const { forward, groups } = buildAliasMaps({
      'client:Acme-Foods': 'client:acme-foods',
      'client:acmefoods': 'client:acme-foods',
      'project:Fuel-Dashboard': 'project:fuel-dashboard',
    });
    expect(forward.get('client:Acme-Foods')).toBe('client:acme-foods');
    expect(groups.get('client:acme-foods')).toEqual(
      expect.arrayContaining(['client:Acme-Foods', 'client:acmefoods'])
    );
    expect(groups.get('project:fuel-dashboard')).toEqual(['project:Fuel-Dashboard']);
  });

  it('skips invalid entries: non-string values, self-maps, alias-of-alias chains', () => {
    const { forward } = buildAliasMaps({
      'client:a': 'client:b',
      'client:b': 'client:c',       // chain: canonical 'client:b' is itself an alias key → skipped
      'client:same': 'client:same', // self-map → skipped
      'client:num': 42,             // non-string → skipped
    });
    expect(forward.get('client:a')).toBe('client:b');
    expect(forward.has('client:b')).toBe(false);
    expect(forward.has('client:same')).toBe(false);
    expect(forward.has('client:num')).toBe(false);
  });

  it('returns empty maps for garbage input', () => {
    for (const raw of [null, undefined, 'nope', 7, ['client:a']]) {
      const { forward, groups } = buildAliasMaps(raw);
      expect(forward.size).toBe(0);
      expect(groups.size).toBe(0);
    }
  });
});

describe('ScopeAliasService', () => {
  const TABLE = {
    [SCOPE_ALIASES_CONFIG_KEY]: {
      'client:Acme-Foods': 'client:acme-foods',
      'client:acmefoods': 'client:acme-foods',
    },
  };

  it('canonicalize maps aliases and passes unknown scopes through', async () => {
    const svc = new ScopeAliasService(stubStore(TABLE));
    expect(await svc.canonicalize('client:Acme-Foods')).toBe('client:acme-foods');
    expect(await svc.canonicalize('client:unrelated')).toBe('client:unrelated');
    expect(await svc.canonicalize('global')).toBe('global');
  });

  it('expand returns the closure of each requested scope over its alias group, deduped, order-preserving', async () => {
    const svc = new ScopeAliasService(stubStore(TABLE));
    // canonical requested → canonical + all its aliases
    expect(await svc.expand(['client:acme-foods', 'global'])).toEqual([
      'client:acme-foods', 'client:Acme-Foods', 'client:acmefoods', 'global',
    ]);
    // alias requested → same closure (canonical first)
    expect(await svc.expand(['client:acmefoods'])).toEqual([
      'client:acme-foods', 'client:Acme-Foods', 'client:acmefoods',
    ]);
    // no table entry → identity
    expect(await svc.expand(['project:other'])).toEqual(['project:other']);
  });

  it('fails open: store throw / null config / missing key ⇒ identity', async () => {
    const throwing = { getConfig: async () => { throw new Error('db down'); } } as unknown as IOperatorConfigStore;
    const svc = new ScopeAliasService(throwing);
    expect(await svc.canonicalize('client:Acme-Foods')).toBe('client:Acme-Foods');
    expect(await svc.expand(['client:Acme-Foods'])).toEqual(['client:Acme-Foods']);
    const empty = new ScopeAliasService(stubStore({}));
    expect(await empty.canonicalize('client:Acme-Foods')).toBe('client:Acme-Foods');
  });

  it('parses a string config blob (SQLite stores JSON text)', async () => {
    const svc = new ScopeAliasService(stubStore(JSON.stringify(TABLE)));
    expect(await svc.canonicalize('client:Acme-Foods')).toBe('client:acme-foods');
  });

  it('caches for ttlMs and reloads after invalidate()', async () => {
    let calls = 0;
    const store = {
      getConfig: async () => { calls++; return { config: TABLE } as never; },
    } as unknown as IOperatorConfigStore;
    let clock = 0;
    const svc = new ScopeAliasService(store, 60_000, () => clock);
    await svc.canonicalize('x'); await svc.canonicalize('y');
    expect(calls).toBe(1);
    clock = 61_000;
    await svc.canonicalize('x');
    expect(calls).toBe(2);
    svc.invalidate();
    await svc.canonicalize('x');
    expect(calls).toBe(3);
  });
});

describe('ScopeAliasService.snapshot (Phase 1 shared definition)', () => {
  it('exposes the accepted resolution, rejections included, behind the same cache', async () => {
    const svc = new ScopeAliasService(stubStore({
      [SCOPE_ALIASES_CONFIG_KEY]: {
        'client:Acme-Foods': 'client:acme-foods',
        'client:chain-head': 'client:mid',
        'client:mid': 'client:tail',
      },
    }));

    const snap = await svc.snapshot();
    expect(snap.table).toEqual({
      'client:Acme-Foods': 'client:acme-foods',
      'client:chain-head': 'client:mid',
    });
    expect(snap.rejected.map(r => [r.alias, r.reason])).toEqual([['client:mid', 'chained']]);
    expect(snap.version).toMatch(/^[0-9a-f]{12}$/);

    // The snapshot and canonicalize() cannot disagree — same accepted map.
    expect(await svc.canonicalize('client:mid')).toBe('client:mid');
    expect(await svc.canonicalize('client:chain-head')).toBe('client:mid');
  });

  it('fails open to the empty resolution when the store throws', async () => {
    const throwing = {
      getConfig: async () => { throw new Error('db down'); },
    } as unknown as IOperatorConfigStore;
    const snap = await new ScopeAliasService(throwing).snapshot();
    expect(snap.table).toEqual({});
    expect(snap.rejected).toEqual([]);
  });
});
