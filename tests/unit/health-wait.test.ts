/**
 * T71 — `kopeng init` exited 1 on a healthy install.
 *
 * The embedding index is lazy-loaded AFTER the server starts accepting
 * requests, so `embedding: 'initializing'` is the EXPECTED state on a fresh
 * install. `waitForHealth` returned the instant the port answered — discarding
 * the `embeddingLoaded` flag it had already computed — init ran doctor
 * immediately, doctor read `initializing` as a FAIL, and init exited 1. On the
 * windows-latest smoke the canary passed 1.2 SECONDS later, proving the model
 * was fine and doctor had simply asked too early.
 */
import { describe, expect, it } from 'vitest';

import { describeHealthWait, waitForHealth, type HealthWaitResult } from '../../src/cli/init.js';

type Embedding = 'loaded' | 'initializing' | 'error';

/** A /api/health stub that walks a scripted sequence, repeating the last entry. */
function healthStub(sequence: Array<Embedding | 'down'>) {
  const calls = { count: 0 };
  const impl = (async () => {
    const state = sequence[Math.min(calls.count, sequence.length - 1)];
    calls.count += 1;
    if (state === 'down') throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify({ data: { status: 'ok', embedding: state } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = { port: 3299, timeoutMs: 300, pollIntervalMs: 5 } as const;

describe('waitForHealth', () => {
  it('returns as soon as the embedding index reports loaded', async () => {
    const { impl, calls } = healthStub(['loaded']);
    const result = await waitForHealth({ ...base, fetchImpl: impl });
    expect(result).toEqual({ ready: true, embeddingLoaded: true, embeddingFailed: false });
    expect(calls.count).toBe(1);
  });

  it('REGRESSION (T71): keeps polling through `initializing` instead of returning early', async () => {
    // Before the fix this returned { ready: true, embeddingLoaded: false } on
    // the very first probe, and init ran doctor against a still-loading model.
    const { impl, calls } = healthStub(['initializing', 'initializing', 'loaded']);
    const result = await waitForHealth({ ...base, fetchImpl: impl, embeddingTimeoutMs: 2000 });
    expect(result).toEqual({ ready: true, embeddingLoaded: true, embeddingFailed: false });
    expect(calls.count).toBe(3);
  });

  it('fails fast on the terminal `error` state rather than burning the budget', async () => {
    const { impl, calls } = healthStub(['error']);
    const started = Date.now();
    const result = await waitForHealth({ ...base, fetchImpl: impl, embeddingTimeoutMs: 60_000 });
    expect(result).toEqual({ ready: true, embeddingLoaded: false, embeddingFailed: true });
    expect(calls.count).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives up bounded, reporting the server up but the index unloaded', async () => {
    const { impl } = healthStub(['initializing']);
    const result = await waitForHealth({ ...base, fetchImpl: impl, embeddingTimeoutMs: 120 });
    // ready stays TRUE: the server answered. "Up but still loading" and "dead"
    // are different diagnoses and init prints different advice for each.
    expect(result).toEqual({ ready: true, embeddingLoaded: false, embeddingFailed: false });
  });

  it('reports not-ready when the server never answers at all', async () => {
    const { impl } = healthStub(['down']);
    const result = await waitForHealth({ ...base, timeoutMs: 60, fetchImpl: impl });
    expect(result).toEqual({ ready: false, embeddingLoaded: false, embeddingFailed: false });
  });

  it('uses the longer embedding budget only after the server has answered', async () => {
    // Server never answers: the SHORT reachability budget governs, so a dead
    // server is still reported fast rather than waiting out embeddingTimeoutMs.
    const { impl } = healthStub(['down']);
    const started = Date.now();
    await waitForHealth({ ...base, timeoutMs: 60, fetchImpl: impl, embeddingTimeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('describeHealthWait', () => {
  const r = (over: Partial<HealthWaitResult>): HealthWaitResult =>
    ({ ready: true, embeddingLoaded: false, embeddingFailed: false, ...over });

  it('is terse when everything is up', () => {
    expect(describeHealthWait(r({ embeddingLoaded: true }), 20_000, 'x')).toBe('Server is up.');
  });

  it('names the terminal embedder failure and its consequence', () => {
    const msg = describeHealthWait(r({ embeddingFailed: true }), 20_000, 'x');
    expect(msg).toMatch(/failed to load/);
    expect(msg).toMatch(/keyword-only/);
  });

  it('distinguishes a still-loading index from a server that never came up', () => {
    expect(describeHealthWait(r({}), 20_000, 'check with kopeng doctor.'))
      .toMatch(/still loading/);
    expect(describeHealthWait(r({ ready: false }), 20_000, 'check with kopeng doctor.'))
      .toMatch(/did not report ready within 20000ms/);
  });
});
