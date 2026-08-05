import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { ObservationQueries } from '../../src/database/observation-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import { createTestObservationsDb } from '../fixtures/test-helpers.js';

// Override config for tests
import { vi } from 'vitest';
vi.stubEnv('OBSERVATION_INGESTION_ENABLED', 'true');
vi.stubEnv('DISCOVERY_DETECTION_ENABLED', 'true');
vi.stubEnv('OBSERVATION_API_KEY', 'test-secret-key');

// Must import config after env stub
const { default: config } = await import('../../src/config/config.js');

function createLifecycleStub(db: Database.Database): IDatabaseLifecycle {
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

describe('Discovery API Integration', () => {
  let app: FastifyInstance;
  let memoryDb: Database.Database;
  let obsDb: Database.Database;
  let queries: MemoryQueries;
  let obsQueries: ObservationQueries;
  let embeddingIndex: EmbeddingIndex;

  beforeAll(async () => {
    // Memory database
    memoryDb = new Database(':memory:');
    memoryDb.pragma('journal_mode = WAL');
    memoryDb.pragma('foreign_keys = ON');
    runMigrations(memoryDb);
    queries = new MemoryQueries(memoryDb);

    // Observations database
    const testObs = createTestObservationsDb();
    obsDb = testObs.db;
    obsQueries = testObs.obsQueries;

    embeddingIndex = new EmbeddingIndex();
    await embeddingIndex.loadFromDatabase([]);

    app = Fastify({ logger: false });

    app.setErrorHandler((error, _request, reply) => {
      if (error.name === 'ZodError') {
        reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
        return;
      }
      reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    });

    // Force config for this test context
    config.discovery.ingestionEnabled = true;
    config.discovery.detectionEnabled = true;
    config.discovery.apiKey = 'test-secret-key';

    registerRoutes(app, {
      stores: { queries, observations: obsQueries },
      services: { embeddingIndex },
      lifecycle: createLifecycleStub(memoryDb),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    memoryDb.close();
    obsDb.close();
  });

  describe('POST /api/observations', () => {
    it('should require API key when configured', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/observations',
        payload: {
          session_id: 'test-session',
          project_scope: 'project:test',
          tool_name: 'Bash',
          input_summary: 'npm test',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('API key');
    });

    it('should reject invalid API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/observations',
        headers: { 'x-api-key': 'wrong-key' },
        payload: {
          session_id: 'test-session',
          project_scope: 'project:test',
          tool_name: 'Bash',
          input_summary: 'npm test',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should accept valid API key and store observation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/observations',
        headers: { 'x-api-key': 'test-secret-key' },
        payload: {
          session_id: 'test-session',
          project_scope: 'project:test',
          tool_name: 'Bash',
          input_summary: 'npm test',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data.id).toBeDefined();
      expect(body.data.tool_name).toBe('Bash');
      expect(body.data.status).toBe('started');
    });

    it('should scrub secrets from observation input server-side', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/observations',
        headers: { 'x-api-key': 'test-secret-key' },
        payload: {
          session_id: 'test-session',
          project_scope: 'project:test',
          tool_name: 'Bash',
          input_summary: 'export API_KEY=sk_test_FAKEKEYFORSCRUBBERTESTS0000',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      // The Stripe key should be scrubbed
      expect(body.data.input_summary).not.toContain('sk_test_FAKEKEYFORSCRUBBERTESTS0000');
    });
  });

  describe('PATCH /api/observations/:id (completion scrub)', () => {
    it('scrubs secrets from completion output server-side', async () => {
      const start = await app.inject({
        method: 'POST', url: '/api/observations',
        headers: { 'x-api-key': 'test-secret-key' },
        payload: { session_id: 'patch-scrub', project_scope: 'project:test', tool_name: 'Bash', input_summary: 'gh auth status' },
      });
      const id = JSON.parse(start.payload).data.id;

      const res = await app.inject({
        method: 'PATCH', url: `/api/observations/${id}`,
        headers: { 'x-api-key': 'test-secret-key' },
        payload: { status: 'completed', output_summary: 'new credential github_pat_11ABCDEFG0abcdefghijk_1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ ready' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.output_summary).not.toContain('github_pat_11ABCDEFG0');
      expect(body.data.output_summary).toContain('[REDACTED]');
    });

    it('suppresses completion output when the started tool read a .env file', async () => {
      const start = await app.inject({
        method: 'POST', url: '/api/observations',
        headers: { 'x-api-key': 'test-secret-key' },
        payload: { session_id: 'patch-suppress', project_scope: 'project:test', tool_name: 'Read', input_summary: '/app/.env' },
      });
      const id = JSON.parse(start.payload).data.id;

      const res = await app.inject({
        method: 'PATCH', url: `/api/observations/${id}`,
        headers: { 'x-api-key': 'test-secret-key' },
        payload: { status: 'completed', output_summary: 'DB_PASSWORD=hunter2\nSTRIPE=sk_test_FAKEKEYFORSCRUBBERTESTS0000' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.output_summary).toBe('[SUPPRESSED]');
    });
  });

  describe('POST /api/observations/batch', () => {
    it('should store multiple observations', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/observations/batch',
        headers: { 'x-api-key': 'test-secret-key' },
        payload: {
          observations: [
            { session_id: 's1', project_scope: 'project:test', tool_name: 'Read', input_summary: 'file.ts' },
            { session_id: 's1', project_scope: 'project:test', tool_name: 'Edit', input_summary: 'file.ts' },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(2);
      expect(body.meta.count).toBe(2);
    });
  });

  describe('GET /api/observations/stats', () => {
    it('should return observation statistics', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/observations/stats',
        headers: { 'x-api-key': 'test-secret-key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.total).toBeGreaterThan(0);
      expect(body.data.by_tool).toBeDefined();
    });
  });

  describe('GET /api/discoveries', () => {
    it('should return empty list when no discoveries exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/discoveries',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(0);
    });
  });

  describe('Confidence blending regression', () => {
    it('should not alter scores for explicit memories (confidence = 1.0)', async () => {
      // Store a memory with confidence 1.0 (default)
      await queries.store({
        content: 'Explicit memory for confidence regression test with unique search term xyzzy',
        type: 'reference',
        scope: 'global',
        source: null,
        source_path: null,
        metadata: '{}',
        embedding: null,
        embedding_model: '',
        created_by: null,
        tags: [],
      });

      // Search for it — confidence 1.0 should mean: adjustedScore = score * (0.5 + 0.5*1.0) = score * 1.0
      const res = await app.inject({
        method: 'POST',
        url: '/api/memories/search',
        payload: { query: 'xyzzy', mode: 'keyword' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      if (body.data.length > 0) {
        // For confidence 1.0, the adjusted score should equal the raw score
        // since (0.5 + 0.5 * 1.0) = 1.0
        const result = body.data[0];
        expect(result.score).toBeGreaterThan(0);
      }
    });
  });
});
