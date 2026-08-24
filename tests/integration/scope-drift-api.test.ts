/**
 * GET /api/ops/scope-drift, in-process (app.inject, no external server).
 *
 * Covers the full path the unit tests cannot: the real SQLite
 * getScopeAggregates() query, the alias-table read out of operator_config, and
 * the route's fail-open behaviour when no operator-config store is wired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle, IOperatorConfigStore } from '../../src/database/interfaces.js';
import { createTestMemory } from '../fixtures/test-helpers.js';

function lifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
    backup: async () => '/tmp/test-backup.db',
  };
}

/** Minimal operator-config store returning a fixed `config` blob string. */
function configStoreStub(blob: string): IOperatorConfigStore {
  const row = {
    operator_id: 'default', timezone: null, quiet_hours_start: null, quiet_hours_end: null,
    idle_minutes: 30, dream_cadence: null, auto_accept_exact_dup: false, auto_accept_decay: false,
    reasoner_provider: null, config: blob,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
  return {
    getConfig: async () => row,
    updateConfig: async () => row,
  } as unknown as IOperatorConfigStore;
}

async function buildApp(
  configBlob: string | null,
  opts: { withAliasService?: boolean } = {},
): Promise<{ app: FastifyInstance; db: Database.Database }> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  const { runMigrations } = await import('../../src/database/migrations.js');
  runMigrations(db);
  const queries = new MemoryQueries(db);

  // Two spellings of one entity + an unrelated scope + an ephemeral scope.
  await queries.store(createTestMemory({ scope: 'client:acme-foods', type: 'project', content: 'canonical one' }));
  await queries.store(createTestMemory({ scope: 'client:acme-foods', type: 'reference', content: 'canonical two' }));
  await queries.store(createTestMemory({ scope: 'client:Acme-Foods', type: 'discovery', content: 'drifted one' }));
  await queries.store(createTestMemory({ scope: 'project:solo', type: 'project', content: 'unrelated' }));
  await queries.store(createTestMemory({ scope: 'project:wf_ab12cd', type: 'discovery', content: 'ephemeral' }));

  const embeddingIndex = new EmbeddingIndex();
  await embeddingIndex.loadFromDatabase([]);

  const operatorConfig = configBlob === null ? undefined : configStoreStub(configBlob);
  const { ScopeAliasService } = await import('../../src/services/scope-alias.js');
  const scopeAliases = (opts.withAliasService && operatorConfig)
    ? new ScopeAliasService(operatorConfig)
    : undefined;

  const app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries, ...(operatorConfig ? { operatorConfig } : {}) },
    services: { embeddingIndex, ...(scopeAliases ? { scopeAliases } : {}) },
    lifecycle: lifecycleStub(),
  });
  await app.ready();
  return { app, db };
}

describe('GET /api/ops/scope-drift', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  afterAll(async () => {
    await app?.close();
    db?.close();
  });

  it('reports the un-aliased variant as drift when the table is empty', async () => {
    ({ app, db } = await buildApp('{}'));
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-drift' });
    expect(res.statusCode).toBe(200);
    const { data, meta } = res.json();

    expect(meta.alias_table_entries).toBe(0);
    expect(data.summary.active_rows_adrift).toBe(1);
    expect(data.summary.clusters_uncovered).toBe(1);

    const cluster = data.clusters[0];
    expect(cluster.canonical).toBe('client:acme-foods');
    // The real SQL fold produced the evidence fields.
    const canonical = cluster.variants.find((v: { scope: string }) => v.scope === 'client:acme-foods');
    expect(canonical.active).toBe(2);
    expect(canonical.by_type).toEqual({ project: 1, reference: 1 });
    expect(canonical.first_write).toBeTruthy();

    // Ephemeral scopes are reported separately, never as an alias proposal.
    expect(data.ephemeral.map((e: { scope: string }) => e.scope)).toContain('project:wf_ab12cd');

    await app.close(); db.close();
  });

  it('drops to zero drift once the alias table covers the variant', async () => {
    ({ app, db } = await buildApp(JSON.stringify({ scope_aliases: { 'client:Acme-Foods': 'client:acme-foods' } })));
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-drift' });
    const { data, meta } = res.json();

    expect(meta.alias_table_entries).toBe(1);
    expect(data.summary.active_rows_adrift).toBe(0);
    expect(data.summary.clusters_uncovered).toBe(0);
    // Still visible, marked resolved, with the mapping shown.
    const variant = data.clusters[0].variants.find((v: { scope: string }) => v.scope === 'client:Acme-Foods');
    expect(variant.aliased_to).toBe('client:acme-foods');

    await app.close(); db.close();
  });

  it('fails open to an empty table on a corrupt config blob', async () => {
    ({ app, db } = await buildApp('not json at all'));
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-drift' });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.alias_table_entries).toBe(0);

    await app.close(); db.close();
  });

  it('serves the endpoint with no operator-config store wired', async () => {
    ({ app, db } = await buildApp(null));
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-drift' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.summary.active_rows_adrift).toBe(1);
  });

  it('does not report a chained mapping as coverage (Phase 1 false-green regression)', async () => {
    // Chain direction: 'client:Acme-Foods' (the seeded variant) is itself used
    // as a canonical value below ('client:third' -> 'client:Acme-Foods'), so
    // ITS OWN entry ('client:Acme-Foods' -> 'client:acme-foods') is the one the
    // resolver rejects as chained — the write path ignores it, and only the
    // pre-Phase-1 lax reader would have accepted it as coverage.
    ({ app, db } = await buildApp(JSON.stringify({
      scope_aliases: {
        'client:Acme-Foods': 'client:acme-foods',
        'client:third': 'client:Acme-Foods',
      },
    })));
    const res = await app.inject({ method: 'GET', url: '/api/ops/scope-drift' });
    const { data, meta } = res.json();

    // Only the non-chained entry is accepted. Rejected-count and version live
    // in data.summary only (meta deliberately does not duplicate them).
    expect(meta.alias_table_entries).toBe(1);
    expect(meta.alias_entries_rejected).toBeUndefined();
    expect(data.summary.alias_entries_rejected).toBe(1);
    expect(data.summary.alias_table_version).toMatch(/^[0-9a-f]{12}$/);
    // The canonical now sits under a rejected mapping, so the cluster is NOT covered.
    expect(data.summary.clusters_uncovered).toBeGreaterThan(0);

    await app.close(); db.close();
  });

  it('reports the same coverage whether or not the alias service is wired', async () => {
    const blob = JSON.stringify({ scope_aliases: { 'client:Acme-Foods': 'client:acme-foods' } });

    ({ app, db } = await buildApp(blob));
    const withoutService = (await app.inject({ method: 'GET', url: '/api/ops/scope-drift' })).json();
    await app.close(); db.close();

    ({ app, db } = await buildApp(blob, { withAliasService: true }));
    const withService = (await app.inject({ method: 'GET', url: '/api/ops/scope-drift' })).json();

    expect(withService.data.summary).toEqual(withoutService.data.summary);
    expect(withService.data.summary.alias_table_version).toBe(withoutService.data.summary.alias_table_version);

    await app.close(); db.close();
  });
});
