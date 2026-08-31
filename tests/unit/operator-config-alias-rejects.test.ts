/**
 * WS0 finding 4 — PATCH /api/operator-config must not accept scope_aliases
 * entries silently.
 *
 * `PATCH /api/operator-config` merges the `config` blob and returns 200 without
 * ever consulting the shared resolver. So an operator could PATCH a
 * `scope_aliases` entry that `buildScopeResolution` rejects at load time with
 * only a `logger.warn`: the exact-match write path keeps ignoring it, recall
 * never expands the scope, and the rows stay dark — while the operator has every
 * reason to believe the ruling took.
 *
 * The fix is REPORTING, not refusal. Refusing would be a breaking behaviour
 * change on a release branch, and `POST /api/admin/scopes/rule` is already the
 * validating path for alias entries. So the patch still persists exactly as
 * before; it now additionally carries `meta.alias_entries_rejected`.
 *
 * NOTE ON THE FILENAME: this suite is about the operator-config PATCH, not about
 * revisions. It carries the `revision-` prefix only because of the WS0 file
 * ownership split; rename it at merge if you like.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { adminHeaders, createTestDatabase } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import { SCOPE_ALIASES_CONFIG_KEY } from '../../src/services/scope-alias.js';

describe('PATCH /api/operator-config — rejected scope_aliases entries are reported, not swallowed', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let app: FastifyInstance;

  beforeEach(async () => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    const index = new EmbeddingIndex();
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

  function patchConfig(body: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: '/api/operator-config', headers: adminHeaders(), payload: body });
  }

  async function readBlob(): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'GET', url: '/api/operator-config' });
    expect(res.statusCode).toBe(200);
    return JSON.parse((res.json().data as { config: string }).config ?? '{}');
  }

  it('a chained entry — the Phase-1 watchdog failure class — is reported', async () => {
    // A chain (b is both an alias key and a canonical value) is exactly the shape
    // that made the drift detector read `active_rows_adrift: 0` during the
    // failure it exists to detect.
    const res = await patchConfig({
      config: {
        [SCOPE_ALIASES_CONFIG_KEY]: {
          'client:a': 'client:b',
          'client:b': 'client:c',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const rejected = res.json().meta?.alias_entries_rejected as { alias: string; reason: string }[];
    expect(rejected).toBeDefined();
    expect(rejected.map(r => r.reason)).toContain('chained');

    // Still STORED — reporting, not refusal. The response is the only new thing.
    const blob = await readBlob();
    expect(blob[SCOPE_ALIASES_CONFIG_KEY]).toEqual({ 'client:a': 'client:b', 'client:b': 'client:c' });
  });

  it('reports self-maps, malformed scopes and generic capture, each with its reason', async () => {
    const res = await patchConfig({
      config: {
        [SCOPE_ALIASES_CONFIG_KEY]: {
          'client:same': 'client:same',        // self_map
          'status:archived': 'client:acme',    // malformed_scope (not a scope at all)
          'project:web': 'client:acme',        // generic_capture
          'client:Acme-Foods': 'client:acme',  // ACCEPTED — must NOT be reported
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const rejected = res.json().meta.alias_entries_rejected as { alias: string; reason: string }[];
    const byAlias = Object.fromEntries(rejected.map(r => [r.alias, r.reason]));
    expect(byAlias['client:same']).toBe('self_map');
    expect(byAlias['status:archived']).toBe('malformed_scope');
    expect(byAlias['project:web']).toBe('generic_capture');
    expect(byAlias['client:Acme-Foods']).toBeUndefined();
  });

  it('a fully-acceptable alias table reports nothing (byte-identical to the old response)', async () => {
    const res = await patchConfig({
      config: { [SCOPE_ALIASES_CONFIG_KEY]: { 'client:Acme-Foods': 'client:acme-foods' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toBeUndefined();
  });

  it('a PATCH that does not touch scope_aliases never pays for the check', async () => {
    // The resolver only runs when the patch names the key — an unrelated blob
    // write (a viz cadence toggle, an engine cursor) is untouched, even if a bad
    // table is already sitting in the blob from an earlier PATCH.
    await patchConfig({ config: { [SCOPE_ALIASES_CONFIG_KEY]: { 'client:x': 'client:x' } } });
    const res = await patchConfig({ config: { dream_whole_corpus_cadence: 'monthly' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toBeUndefined();
  });

  it('the merged table is what gets validated, not just the patch fragment', async () => {
    // scope_aliases replaces whole (it is one blob key), so a later PATCH that
    // re-sends the FULL map and fixes the entry must clear the report.
    const bad = await patchConfig({
      config: { [SCOPE_ALIASES_CONFIG_KEY]: { 'client:a': 'client:b', 'client:b': 'client:c' } },
    });
    expect(bad.json().meta.alias_entries_rejected).toHaveLength(1);

    const fixed = await patchConfig({
      config: { [SCOPE_ALIASES_CONFIG_KEY]: { 'client:a': 'client:c', 'client:b': 'client:c' } },
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().meta).toBeUndefined();
  });
});
