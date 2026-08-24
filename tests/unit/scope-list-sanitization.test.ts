/**
 * Team-round F-A / R-3 — scope-list request inputs are FAIL-OPEN: sanitized,
 * never a whole-request 400.
 *
 * The spec (§4.4) promises "invalid entries skipped, fail-open — never a 400
 * for a bad anchor scope", but /api/surface's Zod bounds (min/max on each
 * entry, max 16 entries) rejected the ENTIRE request when one `.kopeng.json`
 * marker entry was oversized — and the hook is fail-silent, so one garbage
 * entry silently killed ALL surfacing for that project. Recall's `scopes[]`
 * had the opposite hole: no bound at all.
 *
 * Both now run through one exported sanitizer (`sanitizeScopeList`,
 * src/api/routes.ts): drop non-string/empty/oversized (>128 chars) entries,
 * cap at 16 — and the SANITIZED list is the requested list, so recall's
 * documented single-scope global fallback branches on what survived.
 *
 * R-3 semantic pins (decided deliberately, documented at the recall handler):
 *  - 1 valid + 1 garbage entry ⇒ single-scope behavior, incl. global fallback.
 *  - a non-empty list that sanitizes to EMPTY degrades to global-only — the
 *    caller asked for scoping, so recall never widens to the whole corpus
 *    (the no-cross-project-bleed doctrine; global is the only sanctioned
 *    fallback).
 *  - an explicitly empty `scopes: []` stays what it always was: no scope filter.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { registerRoutes, sanitizeScopeList } from '../../src/api/routes.js';
import type { IDatabaseLifecycle } from '../../src/database/interfaces.js';

// Same rationale as scope-canonicalization.test.ts: recall short-circuits to []
// when the embedder isn't ready; mocking readiness + a zero vector lets the FTS
// leg do the matching deterministically.
vi.mock('../../src/embeddings/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/embeddings/embedder.js')>();
  return {
    ...actual,
    isEmbedderReady: () => true,
    embed: async () => new Float32Array(384),
  };
});

const OVERSIZED = 'client:' + 'x'.repeat(140); // > 128 chars — must be skipped, never 400

const lifecycleStub: IDatabaseLifecycle = {
  initialize: async () => {},
  close: async () => {},
  getStats: async () => ({}) as never,
  backup: async () => '',
} as unknown as IDatabaseLifecycle;

let app: FastifyInstance;
let db: Database.Database;
let queries: MemoryQueries;

async function seedMemory(content: string, scope: string, tags: string[] = [], metadata = '{}'): Promise<number> {
  const memory = await queries.store({
    content, type: 'reference', scope,
    source: null, source_path: null, metadata, embedding: null,
    embedding_model: '', created_by: null, tags,
  });
  return memory.id;
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  queries = new MemoryQueries(db);

  app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries },
    services: { embeddingIndex: new EmbeddingIndex() },
    lifecycle: lifecycleStub,
  } as never);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
});

describe('sanitizeScopeList (the shared contract)', () => {
  it('keeps valid entries in order, drops empty and oversized ones', () => {
    expect(sanitizeScopeList(['client:a', '', OVERSIZED, 'client:b']))
      .toEqual(['client:a', 'client:b']);
  });

  it('drops non-string entries (defensive — Zod already enforces strings)', () => {
    expect(sanitizeScopeList(['client:a', 42 as unknown as string, null as unknown as string]))
      .toEqual(['client:a']);
  });

  it('caps at 16 — the first 16 VALID entries survive (filter before slice)', () => {
    const valid = Array.from({ length: 19 }, (_, i) => `client:s${i + 1}`);
    // Oversized entry sits at position 3 — it must not consume a slot.
    const raw = [valid[0], valid[1], OVERSIZED, ...valid.slice(2)];
    expect(sanitizeScopeList(raw)).toEqual(valid.slice(0, 16));
  });

  it('exactly 128 chars is still valid (boundary)', () => {
    const at128 = 'client:' + 'y'.repeat(121);
    expect(at128.length).toBe(128);
    expect(sanitizeScopeList([at128])).toEqual([at128]);
  });
});

describe('POST /api/surface — F-A: fail-open scopes[]', () => {
  it('one oversized entry no longer 400s — catalog lanes still served, the entry skipped', async () => {
    await seedMemory(
      'Zanzibar Probe: flingle diagnostics helper',
      'client:claude-tool',
      ['claude-index', 'tool'],
      JSON.stringify({ external_key: 'tool:zanzibar-probe', name: 'Zanzibar Probe' }),
    );

    const res = await app.inject({
      method: 'POST', url: '/api/surface',
      payload: { prompt: 'run the flingle diagnostics helper', scopes: [OVERSIZED] },
    });
    expect(res.statusCode).toBe(200);
    const tools = res.json().data.tools as { key: string }[];
    expect(tools.some(t => t.key === 'tool:zanzibar-probe')).toBe(true);
  });

  it('20 entries no longer 400 (the sanitizer caps at 16; slicing pinned above)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/surface',
      payload: {
        prompt: 'run the flingle diagnostics helper',
        scopes: Array.from({ length: 20 }, (_, i) => `client:anchor-${i}`),
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/memories/recall — R-3: sanitized scopes[], semantics pinned', () => {
  it('20 scopes still 200s and entries past the 16-cap are dropped', async () => {
    const kept = await seedMemory('blorptide sixteen marker', 'project:r3-s2');
    const dropped = await seedMemory('blorptide seventeen marker', 'project:r3-s17');

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: {
        query: 'blorptide',
        // r3-s2 is inside the first 16; r3-s17 is the 17th entry and must be sliced off.
        scopes: Array.from({ length: 20 }, (_, i) => `project:r3-s${i + 1}`),
      },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(dropped);
  });

  it('1 valid + 1 garbage entry behaves as a SINGLE-scope request — global fallback preserved', async () => {
    const globalRow = await seedMemory('gruvnak fallback marker', 'global');

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      // Pre-fix, both entries counted: the 2-scope union branch returned []
      // with no global retry. Post-fix the sanitized list IS the requested
      // list — one surviving scope keeps the documented single-scope fallback.
      payload: { query: 'gruvnak', scopes: [OVERSIZED, 'project:r3-has-nothing'] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(globalRow);
  });

  it('a non-empty list that sanitizes to EMPTY degrades to global-only, never the whole corpus', async () => {
    const projectRow = await seedMemory('vexworth project row', 'project:r3-private');
    const globalRow = await seedMemory('vexworth global row', 'global');

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: { query: 'vexworth', scopes: [OVERSIZED] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(globalRow);
    expect(ids).not.toContain(projectRow);
  });

  it('an explicitly empty scopes: [] stays unscoped (pre-fix behavior preserved)', async () => {
    const projectRow = await seedMemory('quindral unscoped marker', 'project:r3-open');

    const res = await app.inject({
      method: 'POST', url: '/api/memories/recall',
      payload: { query: 'quindral', scopes: [] },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: number }[]).map(m => m.id);
    expect(ids).toContain(projectRow);
  });
});
