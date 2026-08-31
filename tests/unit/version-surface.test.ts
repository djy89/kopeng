/**
 * WS7.1 (Task A): 1.x semver is THE version — package.json is the single
 * source, surfaced at runtime through `KOPENG_VERSION` (src/version.ts) and
 * through `GET /api/health`, so an operator or `doctor` can tell what build
 * is actually running without reading source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { KOPENG_VERSION } from '../../src/version.js';

function createLifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({
      total_memories: 0,
      active_memories: 0,
      archived_memories: 0,
      db_size_bytes: 0,
      wal_size_bytes: 0,
    }),
    backup: async () => '/tmp/test-backup.db',
  };
}

describe('KOPENG_VERSION (src/version.ts)', () => {
  it('matches semver and equals package.json, read independently', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as { version: string };
    expect(KOPENG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(KOPENG_VERSION).toBe(packageJson.version);
  });
});

describe('GET /api/health version field', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { queries } = createTestDatabase();
    const embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);

    app = Fastify({ logger: false });
    registerRoutes(app, {
      stores: { queries },
      services: { embeddingIndex },
      lifecycle: createLifecycleStub(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports data.version === KOPENG_VERSION, additive to the existing shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.version).toBe(KOPENG_VERSION);
    // Pre-existing fields stay byte-identical (REST contract invariant).
    expect(data.status).toBeDefined();
    expect(data.embedding).toBeDefined();
    expect(data.search).toBeDefined();
    expect(data.memories).toBeDefined();
    expect(data.uptime_seconds).toBeDefined();
  });
});
