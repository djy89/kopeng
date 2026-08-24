// Phase 3 Task 4: ScopeRegistryService — the caching, fail-open wrapper around
// the registry store + the pure minting decision.
import { describe, it, expect, vi } from 'vitest';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { ScopeRegistryQueries } from '../../src/database/scope-registry-queries.js';
import { ScopeRegistryService, resolveWriteThroughAliases } from '../../src/services/scope-registry.js';
import { UNROUTED_SCOPE, type ScopeRegistryRow } from '../../src/scopes/minting.js';

describe('ScopeRegistryService', () => {
  it('mints, persists, and the incumbent resolves home on the next call', async () => {
    const registry = new ScopeRegistryQueries(createTestDatabase().db);
    const svc = new ScopeRegistryService({ registry });
    const first = await svc.resolveWrite('project:My Project', 'C:/dev/My Project');
    expect(first).toMatchObject({ scope: 'project:my-project', minted: true });
    const again = await svc.resolveWrite('project:My Project', 'C:/dev/My Project');
    expect(again.scope).toBe('project:my-project');
    expect(again.minted).toBeUndefined();
    const second = await svc.resolveWrite('project:my-project', 'C:/dev/my-project');
    expect(second).toMatchObject({ scope: 'project:my-project--q2', quarantined: true });
  });

  it('malformed reroutes to env primary and reports it', async () => {
    const svc = new ScopeRegistryService({ registry: new ScopeRegistryQueries(createTestDatabase().db), envPrimaryScope: 'project:kopeng' });
    expect(await svc.resolveWrite('status:archived')).toEqual({
      scope: 'project:kopeng',
      rerouted: { raw: 'status:archived', stored_as: 'project:kopeng', reason: 'malformed' },
    });
  });

  it('no primary → _unrouted; invalid env primary is ignored', async () => {
    const svc = new ScopeRegistryService({ registry: new ScopeRegistryQueries(createTestDatabase().db), envPrimaryScope: 'not a scope' });
    expect(await svc.getPrimaryScope()).toBeNull();
    expect((await svc.resolveWrite('bogus')).scope).toBe(UNROUTED_SCOPE);
  });

  it('fail-open: a throwing store degrades to raw unchanged', async () => {
    const broken = {
      listAll: async () => { throw new Error('down'); },
      register: async () => { throw new Error('down'); },
      updateStatus: async () => {}, rename: async () => {},
    };
    const svc = new ScopeRegistryService({ registry: broken as never });
    expect(await svc.resolveWrite('project:Anything', 'C:/x')).toEqual({ scope: 'project:Anything' });
  });

  it('CO1: the primary scope is alias-canonicalized where it is LOADED, so every consumer sees one value', async () => {
    const svc = new ScopeRegistryService({
      registry: new ScopeRegistryQueries(createTestDatabase().db),
      envPrimaryScope: 'client:Acme-Foods', // an alias KEY
      canonicalize: async (s) => (s === 'client:Acme-Foods' ? 'client:acme-foods' : s),
    });
    // getPrimaryScope (the scopeless routes branch) sees the canonical…
    expect(await svc.getPrimaryScope()).toBe('client:acme-foods');
    // …and so does decideMint's Rule-2 malformed reroute — the two triage
    // paths can no longer fragment the same primary.
    expect(await svc.resolveWrite('status:archived')).toEqual({
      scope: 'client:acme-foods',
      rerouted: { raw: 'status:archived', stored_as: 'client:acme-foods', reason: 'malformed' },
    });
  });

  it('CO1 fail-open: a throwing canonicalize falls back to the raw primary with a warn, never null', async () => {
    const svc = new ScopeRegistryService({
      registry: new ScopeRegistryQueries(createTestDatabase().db),
      envPrimaryScope: 'project:kopeng',
      canonicalize: async () => { throw new Error('alias table down'); },
    });
    expect(await svc.getPrimaryScope()).toBe('project:kopeng');
  });

  describe('CO2/A10: a lost mint/quarantine race reloads and re-decides once', () => {
    /** The winner's row as a concurrent claimant would have registered it. */
    const winnerRow: ScopeRegistryRow = {
      scope: 'project:my-project',
      slug: 'project:my-project',
      claimant_raw: 'project:My Project',
      origin_cwd: 'C:/dev/elsewhere/My Project',
      status: 'provisional',
      reserved: false,
      first_seen: '2026-08-19T00:00:00.000Z',
      updated_at: '2026-08-19T00:00:00.000Z',
      ruled_at: null,
    };

    it('register=false → reload sees the winner → the claimant resolves to the winner’s scope', async () => {
      // First snapshot is empty (decideMint says mint); register loses the
      // race (false); the reloaded snapshot carries the winner's row, so the
      // re-decision resolves by claimant instead of minting again.
      const listAll = vi.fn()
        .mockResolvedValueOnce([] as ScopeRegistryRow[])
        .mockResolvedValue([winnerRow]);
      const register = vi.fn().mockResolvedValue(false);
      const store = { listAll, register, updateStatus: async () => {}, rename: async () => {} };
      const svc = new ScopeRegistryService({ registry: store as never });

      const r = await svc.resolveWrite('project:My Project', 'C:/dev/local/My Project');
      expect(r).toEqual({ scope: 'project:my-project' }); // resolve, not minted
      expect(register).toHaveBeenCalledTimes(1);
      expect(listAll).toHaveBeenCalledTimes(2); // initial load + post-race reload
    });

    it('still racing after one retry → fail-open to raw with no third attempt', async () => {
      // The snapshot never shows the winner (pathological), register keeps
      // returning false: exactly two register attempts, then raw passthrough.
      const listAll = vi.fn().mockResolvedValue([]);
      const register = vi.fn().mockResolvedValue(false);
      const store = { listAll, register, updateStatus: async () => {}, rename: async () => {} };
      const svc = new ScopeRegistryService({ registry: store as never });

      const r = await svc.resolveWrite('project:My Project', 'C:/dev/My Project');
      expect(r).toEqual({ scope: 'project:My Project' });
      expect(register).toHaveBeenCalledTimes(2);
    });

    it('register=true keeps the pre-fix shape: minted flag intact', async () => {
      const registry = new ScopeRegistryQueries(createTestDatabase().db);
      const svc = new ScopeRegistryService({ registry });
      expect(await svc.resolveWrite('project:My Project', 'C:/dev/My Project'))
        .toMatchObject({ scope: 'project:my-project', minted: true });
    });
  });

  describe('A3: resolveWriteThroughAliases is THE alias-first composition', () => {
    it('canonicalizes FIRST, then hands the CANONICAL form to the registry', async () => {
      const registry = new ScopeRegistryQueries(createTestDatabase().db);
      const svc = new ScopeRegistryService({ registry });
      const seen: string[] = [];
      const aliases = {
        canonicalize: async (s: string) => {
          seen.push(s);
          return s === 'client:Acme-Foods' ? 'client:acme-foods' : s;
        },
      };
      const r = await resolveWriteThroughAliases(aliases, svc, 'client:Acme-Foods', null);
      // The registry saw the canonical (it minted a row FOR the canonical,
      // whose slug equals itself — no quarantine, no variant row).
      expect(r).toMatchObject({ scope: 'client:acme-foods', minted: true });
      expect(seen).toEqual(['client:Acme-Foods']);
      const rows = await registry.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].scope).toBe('client:acme-foods');
      expect(rows[0].claimant_raw).toBe('client:acme-foods');
    });

    it('degrades one service at a time: no registry → aliased passthrough; no aliases → raw to registry', async () => {
      const aliases = { canonicalize: async (s: string) => (s === 'a:b' ? 'client:canon' : s) };
      expect(await resolveWriteThroughAliases(aliases, undefined, 'a:b', null))
        .toEqual({ scope: 'client:canon' });

      const registry = new ScopeRegistryQueries(createTestDatabase().db);
      const svc = new ScopeRegistryService({ registry });
      expect(await resolveWriteThroughAliases(undefined, svc, 'project:My Project', null))
        .toMatchObject({ scope: 'project:my-project', minted: true });
    });
  });
});
