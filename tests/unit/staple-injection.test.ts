/**
 * Staple injection on POST /api/memories/recall — FIRST automated coverage of
 * the path (S10; CLAUDE.md's "honest gap: no automated test covers the
 * staple-injection path" is closed here).
 *
 * The documented contract (recall handler, src/api/routes.ts):
 *  - memories tagged `staple` whose `metadata.trigger_terms` match a
 *    WHOLE-WORD token in the query are force-injected at score 0.99;
 *  - injection is corpus-WIDE by design — the staple prefetch takes no scope
 *    filter, so a staple stored under a scope the request never asked for is
 *    still injected (pinned by seeding it under `client:somewhere-else` while
 *    requesting `project:staple-probe`);
 *  - staples bypass the semantic threshold (the stubbed vector search never
 *    returns the staple, so only the injection path can produce it);
 *  - the result cap grows by the staple count (limit + staples), so injected
 *    staples never evict semantic results.
 *
 * These are CHARACTERIZATION tests: they pin behavior that already exists.
 * Bite-proof: each headline assertion was deliberately broken once (score
 * 0.5, count = limit) and observed red before being restored.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { IDatabaseLifecycle, IVectorSearch, VectorSearchResult } from '../../src/database/interfaces.js';

// Same rationale as scope-list-sanitization.test.ts: recall short-circuits to
// [] when the embedder isn't ready; mocking readiness + a zero vector keeps
// the handler running without loading a model.
vi.mock('../../src/embeddings/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/embeddings/embedder.js')>();
  return {
    ...actual,
    isEmbedderReady: () => true,
    embed: async () => new Float32Array(384),
  };
});

const REQUEST_SCOPE = 'project:staple-probe';
const STAPLE_SCOPE = 'client:somewhere-else'; // NOT the request scope — pins corpus-WIDE injection
const LIMIT = 3;

const lifecycleStub: IDatabaseLifecycle = {
  initialize: async () => {},
  close: async () => {},
  getStats: async () => ({}) as never,
  backup: async () => '',
} as unknown as IDatabaseLifecycle;

let app: FastifyInstance;
let db: Database.Database;
let queries: MemoryQueries;
let stapleId = 0;
let semanticIds: number[] = [];

// Stub vector search: always "finds" the three unrelated project-scoped rows
// (well above the 0.40 default threshold), never the staple — the semantic
// path is dead for the staple by construction, so its presence in a response
// can only come from the injection path.
const vectorStub: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async (_query: Float32Array, candidateIds?: number[]): Promise<VectorSearchResult[]> => {
    const allowed = candidateIds ? semanticIds.filter(id => candidateIds.includes(id)) : semanticIds;
    return allowed.map((id, i) => ({ id, score: 0.9 - i * 0.02 }));
  },
  get isReady() { return true; },
  get size() { return semanticIds.length; },
};

async function seedMemory(content: string, scope: string, tags: string[] = [], metadata = '{}', confidence?: number): Promise<number> {
  const memory = await queries.store({
    content, type: 'reference', scope,
    source: null, source_path: null, metadata, embedding: null,
    embedding_model: '', created_by: null, tags,
    ...(confidence !== undefined ? { confidence } : {}),
  });
  return memory.id;
}

async function recall(query: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/memories/recall',
    payload: { query, scope: REQUEST_SCOPE, limit: LIMIT },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as { id: number; score: number; scope: string; tags: string[] }[];
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  queries = new MemoryQueries(db);

  app = Fastify({ logger: false });
  registerRoutes(app, {
    stores: { queries },
    services: { embeddingIndex: vectorStub },
    lifecycle: lifecycleStub,
  } as never);
  await app.ready();

  // The staple: identity-level fact, Hard-Anchor confidence, wrong scope.
  // Its content shares no token with the recall prompts, so FTS can't rescue
  // it either — injection is the only path in.
  stapleId = await seedMemory(
    'Operator fact: the warehouse project codename resolves to a fixed rack layout.',
    STAPLE_SCOPE,
    ['staple'],
    JSON.stringify({ trigger_terms: ['zanzibar'] }),
    1.0,
  );

  // Three unrelated rows in the REQUEST scope — they fill the semantic limit
  // via the stub, and they keep the single-scope branch from falling back to
  // global (the scope must be non-empty).
  semanticIds = [
    await seedMemory('flembar rig calibration notes alpha', REQUEST_SCOPE),
    await seedMemory('flembar rig calibration notes bravo', REQUEST_SCOPE),
    await seedMemory('flembar rig calibration notes charlie', REQUEST_SCOPE),
  ];
});

afterAll(async () => {
  await app.close();
  db.close();
});

// Long prompt: dilutes any semantic signal (moot with the stub, but mirrors
// the documented failure mode the staple path exists for) and buries the
// trigger term mid-sentence.
const DILUTED_PROMPT =
  'I have been reorganizing the quarterly planning documents and reviewing the deployment ' +
  'checklist for the upcoming milestone, and somewhere in the middle of all that the zanzibar ' +
  'question came up again, so before I continue with the retrospective notes and the budget ' +
  'spreadsheet cleanup I want to double-check what we decided about it.';

describe('staple injection (POST /api/memories/recall)', () => {
  it('whole-word trigger term injects the staple at score 0.99 despite wrong scope and dead semantic path', async () => {
    const data = await recall(DILUTED_PROMPT);
    const staple = data.find(m => m.id === stapleId);
    expect(staple).toBeDefined();
    expect(staple!.score).toBe(0.99);
    // The response row itself proves scope bypass: the request asked for
    // project:staple-probe, the injected row lives elsewhere.
    expect(staple!.scope).toBe(STAPLE_SCOPE);
  });

  it('the cap grows by the staple count — semantic results are NOT evicted', async () => {
    const data = await recall(DILUTED_PROMPT);
    expect(data).toHaveLength(LIMIT + 1); // limit + 1 injected staple
    for (const id of semanticIds) {
      expect(data.map(m => m.id)).toContain(id);
    }
  });

  it('a substring hit (zanzibarian) does NOT inject — matching is whole-word', async () => {
    const data = await recall(
      'the zanzibarian shipping manifest needs a second pass before the flembar rig review',
    );
    expect(data.map(m => m.id)).not.toContain(stapleId);
  });

  it('no trigger term in the prompt → no injection', async () => {
    const data = await recall('routine flembar rig calibration follow-up for the project');
    expect(data.map(m => m.id)).not.toContain(stapleId);
  });
});
