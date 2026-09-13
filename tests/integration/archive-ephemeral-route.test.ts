/**
 * T76 §5.4/§5.5 — POST /api/admin/scopes/archive-ephemeral (Task 7).
 *
 * The route is a THIN wrapper over runArchiveEphemeral (Task 6): admin-keyed,
 * lock-aware on apply, and mapping IneligibleScopeError -> 400 / a broken
 * strict resolution read -> 503 / a busy consolidation lock -> 423.
 *
 * Harness mirrors tests/unit/scope-ruling.test.ts (in-process Fastify +
 * registerRoutes over in-memory SQLite, dreamQueries doubling as the
 * operator-config store) — the archive route lives in the same
 * `if (operatorConfigStore) { if (scopeRegistry) { ... } }` block as the rule
 * endpoint, so both must be wired for the route to even register.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ScopeRegistryQueries } from '../../src/database/scope-registry-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import { ScopeRegistryService } from '../../src/services/scope-registry.js';
import { ScopeAliasService } from '../../src/services/scope-alias.js';
import { ConsolidationLockManager, uniqueHolder } from '../../src/dreaming/lock.js';
import { createTestMemory } from '../fixtures/test-helpers.js';
import config from '../../src/config/config.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

/** Ephemeral-SHAPED synthetic scope (date-stamped rule, matches project:20260901-demo
 *  in tests/unit/archive-ephemeral.test.ts). */
const EPHEMERAL = 'project:20260901-demo';
/** NOT ephemeral-shaped — a plain project scope. */
const ORDINARY = 'project:my-project';

let app: FastifyInstance;
let db: Database.Database;
let queries: MemoryQueries;
let dreamQueries: DreamQueries;
let registryStore: ScopeRegistryQueries;
let prevKey = '';

async function buildApp(): Promise<void> {
  db = new Database(':memory:');
  runMigrations(db);
  queries = new MemoryQueries(db);
  dreamQueries = new DreamQueries(db);
  registryStore = new ScopeRegistryQueries(db);

  const scopeRegistry = new ScopeRegistryService({
    registry: registryStore,
    configStore: dreamQueries,
  });
  const scopeAliases = new ScopeAliasService(dreamQueries);

  const lifecycle: IDatabaseLifecycle = {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;

  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });
  registerRoutes(app, {
    stores: { queries, operatorConfig: dreamQueries, dreams: dreamQueries },
    services: { embeddingIndex: new EmbeddingIndex(), scopeAliases, scopeRegistry },
    lifecycle,
  } as never);
  await app.ready();
}

async function archiveEphemeral(payload: Record<string, unknown>, headers?: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/admin/scopes/archive-ephemeral', payload, headers });
}

async function seed(scope: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await queries.store(createTestMemory({ content: `ephemeral row ${i} in ${scope} (${Math.random()})`, scope }));
  }
}

beforeEach(async () => {
  prevKey = config.server.adminApiKey;
  config.server.adminApiKey = ''; // open dev mode by default; individual tests arm it
  await buildApp();
});

afterEach(async () => {
  config.server.adminApiKey = prevKey;
  await app.close();
  db.close();
});

describe('POST /api/admin/scopes/archive-ephemeral (Task 7)', () => {
  it('401 without the admin key when ADMIN_API_KEY is set; reads stay public', async () => {
    config.server.adminApiKey = 'test-admin-key-123';

    const denied = await archiveEphemeral({ scope: EPHEMERAL });
    expect(denied.statusCode).toBe(401);

    // A read endpoint in the same admin surface stays open regardless.
    const read = await app.inject({ method: 'GET', url: '/api/operator-config' });
    expect(read.statusCode).not.toBe(401);

    const allowed = await archiveEphemeral({ scope: EPHEMERAL }, { 'x-api-key': 'test-admin-key-123' });
    expect(allowed.statusCode).not.toBe(401);
  });

  it('400 on a non-eligible scope, naming the failing clause', async () => {
    const res = await archiveEphemeral({ scope: ORDINARY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not ephemeral-shaped');
  });

  it('dry-run by default: 200, dry_run:true, nothing archived', async () => {
    await seed(EPHEMERAL, 3);
    expect(await queries.countActiveByScope(EPHEMERAL)).toBe(3);

    const res = await archiveEphemeral({ scope: EPHEMERAL });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.dry_run).toBe(true);
    expect(body.archived).toBe(3);
    expect(body.dream_id).toBeUndefined();

    // Nothing actually archived.
    expect(await queries.countActiveByScope(EPHEMERAL)).toBe(3);
  });

  it('apply archives + returns dream_id; GET /api/ops/dream-history shows the carrier labeled is_carrier', async () => {
    await seed(EPHEMERAL, 3);

    const res = await archiveEphemeral({ scope: EPHEMERAL, apply: true });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.dry_run).toBe(false);
    expect(body.archived).toBe(3);
    expect(typeof body.dream_id).toBe('number');

    expect(await queries.countActiveByScope(EPHEMERAL)).toBe(0);

    const history = await app.inject({ method: 'GET', url: '/api/ops/dream-history' });
    expect(history.statusCode).toBe(200);
    const dreams = history.json().data.dreams as Array<{ id: number; is_carrier: boolean }>;
    const carrier = dreams.find((d) => d.id === body.dream_id);
    expect(carrier).toBeDefined();
    expect(carrier!.is_carrier).toBe(true);
  });

  it('423 while the consolidation lock is held elsewhere', async () => {
    await seed(EPHEMERAL, 3);

    const outsideLock = new ConsolidationLockManager({ store: dreamQueries, holder: uniqueHolder('test-holder') });
    const acquired = await outsideLock.acquire();
    expect(acquired).toBe(true);

    try {
      const res = await archiveEphemeral({ scope: EPHEMERAL, apply: true });
      expect(res.statusCode).toBe(423);
    } finally {
      await outsideLock.release();
    }
  });

  it('503 when the operator-config read is broken (fail-closed)', async () => {
    const spy = vi.spyOn(dreamQueries, 'getConfig').mockRejectedValue(new Error('operator-config store unavailable'));
    try {
      const res = await archiveEphemeral({ scope: EPHEMERAL });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain('Refusing to archive');
    } finally {
      spy.mockRestore();
    }
  });

  it('200 with stopped:resolution_read_failed when the read breaks AFTER archives landed (the 503 must not hide real archives)', async () => {
    // 150 rows ⇒ the loop needs a second chunk; the config read is broken only
    // once the first chunk's 100 archives are on disk, which is the shape the
    // pre-loop 503 above cannot represent.
    await seed(EPHEMERAL, 150);
    const realGetConfig = dreamQueries.getConfig.bind(dreamQueries);
    let broken = false;
    const archiveSpy = vi.spyOn(queries, 'archive');
    const configSpy = vi.spyOn(dreamQueries, 'getConfig').mockImplementation(async () => {
      if (broken) throw new Error('operator-config store unavailable');
      return realGetConfig();
    });
    // Trip the breaker the moment the first chunk is fully archived.
    archiveSpy.mockImplementation(async (id: number) => {
      const ok = await MemoryQueries.prototype.archive.call(queries, id);
      if (archiveSpy.mock.calls.length >= 100) broken = true;
      return ok;
    });

    try {
      const res = await archiveEphemeral({ scope: EPHEMERAL, apply: true });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.stopped).toBe('resolution_read_failed');
      expect(data.archived).toBe(100);
      expect(data.dream_id).toBeGreaterThan(0);   // the rollback handle survives
      expect(await queries.countActiveByScope(EPHEMERAL)).toBe(50);
    } finally {
      archiveSpy.mockRestore();
      configSpy.mockRestore();
    }
  });
});
