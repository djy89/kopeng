import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';
import type { Memory, MemoryType } from '../../src/types/types.js';
import { createTestDatabase, createTestMemory, adminHeaders } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';

type SlotMemory = Memory & { tags: string[]; slot_key: string };

function createLifecycleStub(db: Database.Database): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => {
      const total = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
      const active = (db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_archived = 0').get() as { count: number }).count;
      return {
        total_memories: total,
        active_memories: active,
        archived_memories: total - active,
        db_size_bytes: 0,
        wal_size_bytes: 0,
      };
    },
    backup: async () => '/tmp/test-backup.db',
  };
}

async function createApp(db: Database.Database, queries: MemoryQueries): Promise<FastifyInstance> {
  const embeddingIndex = new EmbeddingIndex();
  await embeddingIndex.loadFromDatabase([]);

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error.name === 'ZodError') {
      reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
      return;
    }
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
  });

  registerRoutes(app, {
    stores: { queries },
    services: { embeddingIndex },
    lifecycle: createLifecycleStub(db),
  });
  await app.ready();
  return app;
}

function slotPayload(slot_key: string, content: string) {
  return {
    slot_key,
    content,
    type: 'reference' as MemoryType,
    scope: 'global',
    tags: ['slot-test'],
  };
}

describe('Slots API', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let app: FastifyInstance;

  beforeEach(async () => {
    const testDb = createTestDatabase();
    db = testDb.db;
    queries = testDb.queries;
    app = await createApp(db, queries);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('creates a slot with pinned metadata and slot_key', async () => {
    const res = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Acme Foods'),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload) as { data: SlotMemory };
    expect(body.data.slot_key).toBe('active-client');

    const stored = await queries.get(body.data.id);
    const metadata = JSON.parse(stored!.metadata) as { pinned: boolean; slot_key: string };
    expect(metadata.pinned).toBe(true);
    expect(metadata.slot_key).toBe('active-client');
    expect(stored!.source).toBe('slot');
  });

  it('retrieves a slot by slot_key', async () => {
    await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('current-project', 'KOPENG slots'),
    });

    const res = await app.inject({ method: 'GET', url: '/api/slots/current-project' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { data: SlotMemory };
    expect(body.data.slot_key).toBe('current-project');
    expect(body.data.content).toBe('KOPENG slots');
  });

  it('lists only non-archived slots ordered by slot_key', async () => {
    await queries.store(createTestMemory({ content: 'ordinary memory' }));
    await app.inject({ method: 'POST', headers: adminHeaders(), url: '/api/slots', payload: slotPayload('beta-slot', 'Beta') });
    await app.inject({ method: 'POST', headers: adminHeaders(), url: '/api/slots', payload: slotPayload('alpha-slot', 'Alpha') });
    await app.inject({ method: 'POST', headers: adminHeaders(), url: '/api/slots', payload: slotPayload('gamma-slot', 'Gamma') });
    await app.inject({ method: 'DELETE', headers: adminHeaders(), url: '/api/slots/gamma-slot' });

    const res = await app.inject({ method: 'GET', url: '/api/slots' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { data: SlotMemory[] };
    expect(body.data.map(slot => slot.slot_key)).toEqual(['alpha-slot', 'beta-slot']);
  });

  it('updates slot content and preserves pinned metadata', async () => {
    await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Before'),
    });

    const res = await app.inject({
      method: 'PUT', headers: adminHeaders(), url: '/api/slots/active-client',
      payload: { content: 'After' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { data: SlotMemory };
    const metadata = JSON.parse(body.data.metadata) as { pinned: boolean; slot_key: string };
    expect(body.data.content).toBe('After');
    expect(metadata.pinned).toBe(true);
    expect(metadata.slot_key).toBe('active-client');
  });

  it('deletes a slot by archiving it', async () => {
    const createRes = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Acme Foods'),
    });
    const id = (JSON.parse(createRes.payload) as { data: SlotMemory }).data.id;

    const deleteRes = await app.inject({ method: 'DELETE', headers: adminHeaders(), url: '/api/slots/active-client' });
    expect(deleteRes.statusCode).toBe(204);

    const listRes = await app.inject({ method: 'GET', url: '/api/slots' });
    const listBody = JSON.parse(listRes.payload) as { data: SlotMemory[] };
    expect(listBody.data).toHaveLength(0);

    const stored = await queries.get(id);
    expect(stored!.is_archived).toBe(1);
  });

  it('rejects duplicate slot_key', async () => {
    await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Acme Foods'),
    });

    const res = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Other client'),
    });

    expect(res.statusCode).toBe(409);
  });

  it('rejects invalid slot_key format', async () => {
    const res = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('My Slot', 'Acme Foods'),
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects archiving a pinned slot without force', async () => {
    const createRes = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Acme Foods'),
    });
    const id = (JSON.parse(createRes.payload) as { data: SlotMemory }).data.id;

    const res = await app.inject({ method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/archive` });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({
      error: 'Cannot archive a pinned slot. Use DELETE /api/slots/:slot_key or pass ?force=true',
    });
  });

  it('archives a pinned slot when force=true', async () => {
    const createRes = await app.inject({
      method: 'POST', headers: adminHeaders(), url: '/api/slots',
      payload: slotPayload('active-client', 'Acme Foods'),
    });
    const id = (JSON.parse(createRes.payload) as { data: SlotMemory }).data.id;

    const res = await app.inject({ method: 'POST', headers: adminHeaders(), url: `/api/memories/${id}/archive?force=true` });

    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.payload) as { data: { archived: boolean } }).data.archived).toBe(true);
    expect((await queries.get(id))!.is_archived).toBe(1);
  });
});
