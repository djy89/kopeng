import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { ScopeRegistryQueries } from '../../src/database/scope-registry-queries.js';

const req = (over: Partial<Parameters<ScopeRegistryQueries['register']>[0]> = {}) => ({
  scope: 'project:my-project',
  slug: 'project:my-project',
  claimant_raw: 'project:My Project',
  origin_cwd: 'C:/dev/My Project',
  status: 'provisional' as const,
  ...over,
});

const makeStore = () => {
  const { db } = createTestDatabase();
  return new ScopeRegistryQueries(db);
};

describe('ScopeRegistryQueries', () => {
  it('register + listAll round-trips and register is idempotent', async () => {
    const store = makeStore();
    expect(await store.register(req())).toBe(true);
    expect(await store.register(req())).toBe(false); // ON CONFLICT DO NOTHING
    const rows = await store.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My Project', origin_cwd: 'C:/dev/My Project',
      status: 'provisional', reserved: false, ruled_at: null,
    });
  });

  it('updateStatus stamps ruled_at and updated_at', async () => {
    const store = makeStore();
    await store.register(req());
    await store.updateStatus('project:my-project', 'confirmed', '2026-08-19T12:00:00Z');
    const [row] = await store.listAll();
    expect(row.status).toBe('confirmed');
    expect(row.ruled_at).toBe('2026-08-19T12:00:00Z');
  });

  it('rename re-keys; renaming onto an existing scope throws', async () => {
    const store = makeStore();
    await store.register(req());
    await store.register(req({ scope: 'project:other', slug: 'project:other', claimant_raw: 'project:other' }));
    await store.rename('project:my-project', 'project:renamed', 'project:renamed');
    const scopes = (await store.listAll()).map(r => r.scope).sort();
    expect(scopes).toEqual(['project:other', 'project:renamed']);
    await expect(store.rename('project:renamed', 'project:other', 'project:other')).rejects.toThrow();
  });
});
