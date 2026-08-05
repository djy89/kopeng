/**
 * T26 — server-side merge for the operator_config `config` JSON blob.
 *
 * The PATCH /api/operator-config handler MERGES the provided `config` keys into
 * the stored blob instead of replacing it, so a viz/MCP write to one key can no
 * longer clobber an engine cursor write (dream_window_cursor /
 * dream_whole_corpus_cursor) that lives in the same blob. Merge rule (shallow,
 * top-level keys): an explicit `null` DELETES the key, any other value SETS it,
 * absent keys are left untouched. Top-level columns keep replace semantics.
 *
 * This exercises the exact request shapes the viz + MCP set_operator_config
 * clients issue against a scratch in-process server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { adminHeaders, createTestDatabase } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';

describe('T26 — operator-config server-side merge', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let index: EmbeddingIndex;
  let app: FastifyInstance;

  beforeEach(async () => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    index = new EmbeddingIndex();
    await index.loadFromDatabase([]);

    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error.name === 'ZodError') {
        reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
        return;
      }
      reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    });
    registerRoutes(app, {
      stores: { queries, dreams: store, operatorConfig: store },
      services: { embeddingIndex: index },
      lifecycle: {
        initialize: async () => {}, close: async () => {},
        getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
        backup: async () => 'noop',
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function patchConfig(body: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: '/api/operator-config', headers: adminHeaders(), payload: body });
  }

  async function readBlob(): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'GET', url: '/api/operator-config' });
    expect(res.statusCode).toBe(200);
    const cfg = res.json().data as { config: string };
    return JSON.parse(cfg.config ?? '{}');
  }

  it('two concurrent PATCHes to DIFFERENT config keys both persist (no clobber)', async () => {
    // Fire both writes concurrently; each sends only its own disjoint key.
    const [a, b] = await Promise.all([
      patchConfig({ config: { keyA: 'alpha' } }),
      patchConfig({ config: { keyB: 'beta' } }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const blob = await readBlob();
    expect(blob.keyA).toBe('alpha');
    expect(blob.keyB).toBe('beta');
  });

  it('null-to-delete removes a key; any other value sets it', async () => {
    await patchConfig({ config: { toKeep: 1, toDrop: 2 } });
    let blob = await readBlob();
    expect(blob.toKeep).toBe(1);
    expect(blob.toDrop).toBe(2);

    // Explicit null deletes only `toDrop`; `toKeep` is untouched, a new key sets.
    await patchConfig({ config: { toDrop: null, added: 'x' } });
    blob = await readBlob();
    expect('toDrop' in blob).toBe(false);
    expect(blob.toKeep).toBe(1);
    expect(blob.added).toBe('x');
  });

  it('a cursor key (dream_window_cursor) survives an unrelated config write', async () => {
    // Simulate an engine cursor write landing in the blob first.
    await patchConfig({ config: { dream_window_cursor: { '*': 1234 }, dream_whole_corpus_cursor: { '*': 99 } } });

    // An unrelated viz write flips only the whole-corpus cadence.
    await patchConfig({ config: { dream_whole_corpus_cadence: 'monthly' } });

    const blob = await readBlob();
    expect(blob.dream_window_cursor).toEqual({ '*': 1234 });
    expect(blob.dream_whole_corpus_cursor).toEqual({ '*': 99 });
    expect(blob.dream_whole_corpus_cadence).toBe('monthly');
  });

  it('a concurrent top-level column write does not drop a concurrent cursor write', async () => {
    await patchConfig({ config: { dream_window_cursor: { '*': 500 } } });

    // A blob write and a top-level-column write, concurrent.
    const [a, b] = await Promise.all([
      patchConfig({ config: { dream_whole_corpus_cadence: 'monthly' } }),
      patchConfig({ auto_accept_exact_dup: true }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/operator-config' });
    const cfg = res.json().data as { config: string; auto_accept_exact_dup: boolean };
    expect(cfg.auto_accept_exact_dup).toBe(true);
    const blob = JSON.parse(cfg.config);
    expect(blob.dream_window_cursor).toEqual({ '*': 500 });
    expect(blob.dream_whole_corpus_cadence).toBe('monthly');
  });

  it('set_operator_config round-trips a partial config patch (MCP path)', async () => {
    // set_operator_config sends exactly this shape — a partial patch, no
    // client-side read-merge-write.
    const res = await patchConfig({ config: { dream_reasoner: { model: 'qwen3:8b', timeout_ms: 4000 } } });
    expect(res.statusCode).toBe(200);
    const returned = JSON.parse((res.json().data as { config: string }).config);
    expect(returned.dream_reasoner).toEqual({ model: 'qwen3:8b', timeout_ms: 4000 });

    // Round-trip through a fresh GET.
    const blob = await readBlob();
    expect(blob.dream_reasoner).toEqual({ model: 'qwen3:8b', timeout_ms: 4000 });
  });

  it('top-level columns keep replace semantics; empty patch is rejected', async () => {
    const ok = await patchConfig({ idle_minutes: 42 });
    expect(ok.statusCode).toBe(200);
    expect((ok.json().data as { idle_minutes: number }).idle_minutes).toBe(42);

    const empty = await patchConfig({});
    expect(empty.statusCode).toBe(400);
  });
});
