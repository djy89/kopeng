/**
 * Task 2.4.1 — POST /api/admin/shutdown. Additive REST surface `kopeng
 * uninstall`/`kopeng update` call to stop the live server before touching
 * autostart/app files. Admin-gated exactly like the other /api/admin routes
 * (core-crud-auth.test.ts pattern); degrades to a named 501 refusal when the
 * server wasn't composed with a `services.requestShutdown` closure, mirroring
 * how other optional services degrade rather than 404ing or crashing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import config from '../../src/config/config.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

const KEY = 'test-admin-key';

let prevKey = '';

function buildLifecycle(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({}) as never,
    backup: async () => '',
  } as unknown as IDatabaseLifecycle;
}

function buildApp(requestShutdown?: () => void): { app: FastifyInstance; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  const queries = new MemoryQueries(db);
  const embeddingIndex = new EmbeddingIndex();

  const app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries },
    services: { embeddingIndex, requestShutdown },
    lifecycle: buildLifecycle(),
  } as never);
  return { app, db };
}

beforeEach(() => {
  prevKey = config.server.adminApiKey;
  config.server.adminApiKey = KEY;
});

afterEach(() => {
  config.server.adminApiKey = prevKey;
});

describe('POST /api/admin/shutdown — wired', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let fired: number;

  beforeAll(async () => {
    const built = buildApp(() => { fired++; });
    app = built.app;
    db = built.db;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  beforeEach(() => { fired = 0; });

  it('rejects a missing key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/shutdown' });
    expect(res.statusCode).toBe(401);
    expect(fired).toBe(0);
  });

  it('rejects a wrong key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/shutdown', headers: { 'x-api-key': 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(fired).toBe(0);
  });

  it('accepts the correct key, replies 202, and fires the injected shutdown closure', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/shutdown', headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { shutting_down: true } });
    // The route schedules the closure via setImmediate AFTER replying — give
    // the event loop one more turn before asserting it fired.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fired).toBe(1);
  });

  it('is open when no admin key is configured (dev mode posture)', async () => {
    config.server.adminApiKey = '';
    const res = await app.inject({ method: 'POST', url: '/api/admin/shutdown' });
    expect(res.statusCode).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fired).toBe(1);
  });
});

describe('POST /api/admin/shutdown — not wired (degrade path)', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    const built = buildApp(undefined);
    app = built.app;
    db = built.db;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('is registered (not 404) and still requires the admin key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/shutdown' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses with a named-gap response when authenticated but no requestShutdown service is wired', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/shutdown', headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('shutdown');
  });
});
