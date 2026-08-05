/**
 * T8 — pending-dreams review tab (viz) backing-endpoint round-trip.
 *
 * The review tab is pure client JS (viz/app.js + viz/index.html) over the
 * EXISTING dream review surface — no new endpoint. This test exercises the
 * exact request sequence the tab issues against a scratch in-process server:
 *
 *   GET  /api/dreams/pending            (list)
 *   GET  /api/dreams/:id/diff           (open diff — rationale, members, deltas)
 *   POST /api/dreams/:id/resolve        (accept / reject / partial via entry_indices)
 *
 * It specifically covers a MULTI-entry dream and a PARTIAL accept of one index
 * (the tab's "accept checked" path), asserting the unselected entry stays
 * pending. Member reads via the diff endpoint are NOT reinforcement points, so
 * the round-trip must not bump observation_count / last_seen on the members.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { adminHeaders, createTestDatabase } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';

describe('T8 — review tab resolve round-trip', () => {
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

  async function mk(content: string, confidence: number): Promise<number> {
    return (await queries.store({
      content, type: 'discovery', scope: 'project:x', source: null, source_path: null,
      metadata: '{}', embedding: null, embedding_model: 'test', created_by: null,
      tags: [], confidence,
    })).id;
  }

  /** A completed dream carrying two deterministic-safe exact_dup entries. */
  async function seedTwoEntryDream() {
    const keepA = await mk('npm test runs the suite', 0.8);
    const dupA = await mk('NPM  test runs the suite', 0.6);
    const keepB = await mk('build with tsc', 0.9);
    const dupB = await mk('BUILD  with tsc', 0.5);
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-t8' });
    await store.setDreamDiff(dream.id, {
      entries: [
        {
          change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [keepA, dupA],
          rationale: 'Identical normalized content (A).',
          after: { keep_id: keepA, archive_ids: [dupA] },
        },
        {
          change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [keepB, dupB],
          rationale: 'Identical normalized content (B).',
          after: { keep_id: keepB, archive_ids: [dupB] },
        },
      ],
    });
    await store.updateDream(dream.id, { status: 'completed', acceptance_status: 'pending', changes_queued: 2 });
    return { dreamId: dream.id, keepA, dupA, keepB, dupB };
  }

  it('lists pending → opens diff with members/rationale/deltas (no reinforcement) → partial-accepts one entry', async () => {
    const { dreamId, dupA, dupB, keepA } = await seedTwoEntryDream();

    // Snapshot member usage columns before the diff read — the diff must NOT
    // reinforce (no observation_count / last_seen bump).
    const before = db.prepare(`SELECT id, observation_count, last_seen FROM memories WHERE id IN (?,?)`).all(keepA, dupA) as
      Array<{ id: number; observation_count: number; last_seen: string | null }>;

    // 1) list
    const list = await app.inject({ method: 'GET', url: '/api/dreams/pending?limit=50' });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].id).toBe(dreamId);
    expect(listBody.data[0].pending_entries).toBe(2);
    expect(listBody.data[0].entries_total).toBe(2);

    // 2) open diff
    const diff = await app.inject({ method: 'GET', url: `/api/dreams/${dreamId}/diff` });
    expect(diff.statusCode).toBe(200);
    const diffBody = diff.json();
    expect(diffBody.data.entries).toHaveLength(2);
    const e0 = diffBody.data.entries[0];
    expect(e0.rationale).toMatch(/Identical/);
    expect(e0.members).toHaveLength(2);
    expect(typeof e0.confidence_delta).toBe('number'); // 0.8 - 0.6 = 0.2
    expect(e0.confidence_delta).toBeCloseTo(0.2, 5);
    expect(e0.members.find((m: { id: number }) => m.id === dupA).excerpt).toBeTruthy();

    // The diff read did not reinforce the members.
    const after = db.prepare(`SELECT id, observation_count, last_seen FROM memories WHERE id IN (?,?)`).all(keepA, dupA) as
      Array<{ id: number; observation_count: number; last_seen: string | null }>;
    for (const b of before) {
      const a = after.find(x => x.id === b.id)!;
      expect(a.observation_count).toBe(b.observation_count);
      expect(a.last_seen).toBe(b.last_seen);
    }

    // 3) partial accept — only entry index 0 (the tab's "accept checked" path).
    const partial = await app.inject({
      method: 'POST', url: `/api/dreams/${dreamId}/resolve`, headers: adminHeaders(),
      payload: { action: 'accept', entry_indices: [0] },
    });
    expect(partial.statusCode).toBe(200);

    // dupA archived; dupB untouched; the dream is now partial with 1 still pending.
    expect((db.prepare(`SELECT is_archived FROM memories WHERE id = ?`).get(dupA) as { is_archived: number }).is_archived).toBe(1);
    expect((db.prepare(`SELECT is_archived FROM memories WHERE id = ?`).get(dupB) as { is_archived: number }).is_archived).toBe(0);

    const relist = await app.inject({ method: 'GET', url: '/api/dreams/pending?limit=50' });
    expect(relist.json().data[0].pending_entries).toBe(1);
  });

  it('reject leaves the memory store untouched', async () => {
    const { dreamId, dupA, dupB } = await seedTwoEntryDream();
    const res = await app.inject({
      method: 'POST', url: `/api/dreams/${dreamId}/resolve`, headers: adminHeaders(), payload: { action: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    expect((db.prepare(`SELECT is_archived FROM memories WHERE id = ?`).get(dupA) as { is_archived: number }).is_archived).toBe(0);
    expect((db.prepare(`SELECT is_archived FROM memories WHERE id = ?`).get(dupB) as { is_archived: number }).is_archived).toBe(0);
  });
});
