/**
 * Task 2.4 fix round 1, Finding 1 — src/server.ts wired `services.
 * requestShutdown` to the exit-LESS `shutdown()` variant (documented as
 * "minus process.exit — main() wraps it"), so the composed process survived
 * a `POST /api/admin/shutdown` (Fastify+DBs closed, but open Winston/
 * onnxruntime handles kept the event loop alive) — exactly the state
 * `kopeng uninstall` hit deleting the app dir out from under a still-running
 * process (Finding 2). `composeServer` now takes an injectable `exit` so this
 * is provable without actually killing the test worker: real DB/Fastify
 * construction (a genuine composed server, not a hand-rebuilt approximation —
 * matching this repo's server-wiring convention), fake `exit` only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;
let server: typeof import('../../src/server.js');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-shutdown-exit-'));
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'memory.db');
  process.env.HOST = '127.0.0.1';
  // composeServer never listens, but PORT=0 keeps any regression off 3200.
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
  server = await import('../../src/server.js'); // must NOT boot: entry guard
}, 30_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('services.requestShutdown drives a real process exit', () => {
  it('calls the injected exit(0) only AFTER the graceful-shutdown routine completes', async () => {
    const exitCalls: number[] = [];
    const composed = await server.composeServer({ exit: (code) => { exitCalls.push(code); } });

    expect(composed.ctx.services.requestShutdown).toBeInstanceOf(Function);
    // Before the fix this closure called `shutdown()` and returned — nothing
    // ever reached `exit`. Confirm the app is genuinely alive first, so a
    // later 404/500 can't be mistaken for "already torn down".
    const before = await composed.app.inject({ method: 'GET', url: '/api/health' });
    expect(before.statusCode).toBe(200);

    composed.ctx.services.requestShutdown!();

    // requestShutdown fires the async shutdown+exit fire-and-forget; poll
    // rather than assume a fixed number of microtask ticks (app.close() and
    // the DB close are both genuinely async).
    const deadline = Date.now() + 5_000;
    while (exitCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(exitCalls).toEqual([0]);
  });
});
