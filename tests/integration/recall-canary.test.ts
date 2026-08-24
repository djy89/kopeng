/**
 * Recall-canary integration suite (Phase 8, Task 5 — spec S4, CX-1/CX-11).
 *
 * Pattern: composeServer() → app.listen({ port: 0, host: '127.0.0.1' }) → a
 * REAL ephemeral HTTP port. This is the ONE suite (alongside the env-gated PG
 * suite) allowed a live port — the canary's whole point is to drive the REAL
 * recall hook as a child process against a real server, which app.inject
 * cannot do.
 *
 * Uses the REAL embedder (initEmbedder()) — proving the semantic path is the
 * point; hand-crafted unit vectors would prove nothing about it. Model files
 * are cached in models/, but beforeAll gets 120s for a cold load.
 *
 * CX-1 case: with the composed embeddingIndex.search monkey-patched to []
 * (vector dead, FTS alive), the canary MUST fail at the recall stage — the
 * proof that FTS cannot rescue a dead vector path, because the fixed prompt
 * shares zero content-words with the fixed content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

// ── Env BEFORE any src/scripts import: config.ts reads env at import time,
// and the canary script's dotenv would otherwise fill unpinned vars from the
// repo .env. Everything below must be set before the dynamic imports in
// beforeAll (this suite gets its own worker + module graph, so the pattern is
// safe — same as server-wiring.test.ts).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-canary-'));
process.env.DATABASE_TYPE = 'sqlite';
process.env.DATABASE_PATH = path.join(tmpDir, 'memory.db');
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.DREAMING_ENABLED = 'false';
process.env.OBSERVATION_INGESTION_ENABLED = 'false';
process.env.DISCOVERY_DETECTION_ENABLED = 'false';
process.env.DREAM_REASONER_ENABLED = 'false';
process.env.NEO4J_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.MINIO_ENABLED = 'false';
process.env.ADMIN_API_KEY = '';
process.env.OBSERVATION_API_KEY = '';
process.env.PRIMARY_SCOPE = '';
// The spawned hook writes hints/caches/metrics under ~/.kopeng — redirect the
// child's home into the temp dir so a test run never touches (or read-and-
// clears) the operator's real hint files. The hook resolves homedir()/env at
// its own startup, so the spawn-time env is what matters. MODELS_CACHE_DIR is
// pinned to the repo's models/ BEFORE the home override so the cached
// embedding model is still found (config.ts defaults there anyway; explicit
// beats a repo .env surprise).
process.env.MODELS_CACHE_DIR = fileURLToPath(new URL('../../models', import.meta.url));
process.env.KOPENG_HINTS_DIR = path.join(tmpDir, 'hints');
process.env.USERPROFILE = tmpDir;
process.env.HOME = tmpDir;

let server: typeof import('../../src/server.js');
let composed: Awaited<ReturnType<typeof server.composeServer>>;
let canary: typeof import('../../scripts/ops/recall-canary.js');
let apiUrl: string;

beforeAll(async () => {
  server = await import('../../src/server.js'); // entry-guarded: composes nothing on import
  composed = await server.composeServer();
  const embedder = await import('../../src/embeddings/embedder.js');
  await embedder.initEmbedder(); // REAL model — the semantic path under test
  await composed.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = composed.app.server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${addr.port}`;
  canary = await import('../../scripts/ops/recall-canary.js');
}, 120_000);

afterAll(async () => {
  await composed?.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function listCanaryRows(includeArchived = false): Promise<Array<{ id: number }>> {
  const url = `${apiUrl}/api/memories?tags=canary&scope=global&fields=lite&limit=1000` +
    (includeArchived ? '&include_archived=true' : '');
  const res = await fetch(url);
  expect(res.ok).toBe(true);
  const json = await res.json() as { data: Array<{ id: number }> };
  return json.data;
}

describe('recall canary', () => {
  it('zero-overlap guard: shipped constants pass, overlapping strings throw', () => {
    expect(() => canary.assertNoTokenOverlap(canary.CANARY_CONTENT_BASE, canary.CANARY_PROMPT))
      .not.toThrow();
    expect(() => canary.assertNoTokenOverlap('remember the shared token value', 'recall that shared token value'))
      .toThrow(/shared/);
    // Sub-4-char words are FTS-invisible (extractFtsTokens emits 4+ letter
    // tokens only) and must not trip the guard — 'and' sits in both fixed strings.
    expect(() => canary.assertNoTokenOverlap('one and two', 'six and ten')).not.toThrow();
  });

  it('green path: store → embed → semantic recall through the real hook, then archives itself', async () => {
    const result = await canary.runCanary({ apiUrl, adminKey: '' });
    expect(result.diagnosis ?? '').toBe('');
    expect(result).toEqual({ ok: true, stage: 'done' });

    // Residue bound: zero ACTIVE canary rows survive a run; archived rows are
    // bounded by the token-luck retry cap (one per attempt; almost always 1).
    expect(await listCanaryRows(false)).toHaveLength(0);
    expect((await listCanaryRows(true)).length).toBeLessThanOrEqual(canary.MAX_STORE_ATTEMPTS);
  }, 60_000);

  it('server down: fails at the health stage with a "not running" diagnosis', async () => {
    // Port 9 (discard) on loopback — nothing listens there; connection refused.
    const result = await canary.runCanary({ apiUrl: 'http://127.0.0.1:9', adminKey: '' });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('health');
    expect(result.diagnosis).toMatch(/not running/);
  }, 30_000);

  it('CX-1: dead vector path (FTS alive) fails at the recall stage — FTS cannot rescue it', async () => {
    const index = composed.ctx.services.embeddingIndex;
    const originalSearch = index.search.bind(index);
    // Vector search returns nothing; FTS and everything else stay live. If the
    // prompt shared any content-word with the stored content, the hybrid-lite
    // RRF merge would still surface the canary via FTS and this test would
    // catch the broken zero-overlap contract.
    index.search = async () => [];
    try {
      const result = await canary.runCanary({ apiUrl, adminKey: '' });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('recall');
      expect(result.diagnosis).toMatch(/semantic recall fault/);
    } finally {
      index.search = originalSearch;
    }

    // The finally-archive ran even on the failure path: no active residue.
    expect(await listCanaryRows(false)).toHaveLength(0);
  }, 60_000);

  it('sweep protects operator rows: a canary-TAGGED memory with foreign content is never archived', async () => {
    // Team-review fix: the sweep must identify the canary's own rows by their
    // fixed content prefix, not the tag alone — an operator note that happens
    // to carry a `canary` tag must survive a canary run untouched.
    const stored = await fetch(`${apiUrl}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Operator note: the staging cluster uses canary releases for rollouts.',
        type: 'reference',
        scope: 'global',
        tags: ['canary'],
      }),
    });
    expect(stored.ok).toBe(true);
    const decoyId = ((await stored.json()) as { data: { id: number } }).data.id;

    try {
      const result = await canary.runCanary({ apiUrl, adminKey: '' });
      expect(result).toEqual({ ok: true, stage: 'done' });
      const active = await listCanaryRows(false);
      expect(active.map((r) => r.id)).toContain(decoyId); // decoy survived
      expect(active).toHaveLength(1); // ...and is the ONLY active canary-tagged row
    } finally {
      await fetch(`${apiUrl}/api/memories/${decoyId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
  }, 60_000);
});
