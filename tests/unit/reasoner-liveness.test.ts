/**
 * T21 — reasoner liveness (ops surface). Proves the "armed but dark" alarm:
 * armed+reachable → green data, armed+down → reachable:false (fail-soft, never
 * throws), disarmed → neutral. Plus the in-process last-classify stamp and the
 * LocalOllamaReasoner onClassify wiring.
 */
import { describe, it, expect } from 'vitest';
import {
  ReasonerActivity, probeReasoner, buildReasonerStatus,
  type ProbeSettings,
} from '../../src/dreaming/reasoner/liveness.js';
import { LocalOllamaReasoner } from '../../src/dreaming/reasoner/local-reasoner.js';
import type { CandidateMemory, ReasonerContext } from '../../src/dreaming/reasoner/reasoner.js';

const SETTINGS: ProbeSettings = { url: 'http://localhost:11434', model: 'qwen3:8b' };

function tagsResponse(models: string[], status = 200): Response {
  return new Response(JSON.stringify({ models: models.map(name => ({ name })) }), { status });
}

describe('ReasonerActivity', () => {
  it('starts null and records the last classify stamp', () => {
    const a = new ReasonerActivity();
    expect(a.lastClassifyAt).toBeNull();
    a.stampClassify('2026-07-10T00:00:00.000Z');
    expect(a.lastClassifyAt).toBe('2026-07-10T00:00:00.000Z');
    a.stampClassify('2026-07-10T01:00:00.000Z');
    expect(a.lastClassifyAt).toBe('2026-07-10T01:00:00.000Z');
  });
});

describe('probeReasoner (fail-soft)', () => {
  it('reachable + modelPresent when /api/tags lists the model', async () => {
    const fetchFn = (async () => tagsResponse(['qwen3:8b', 'llama3.1:8b'])) as typeof fetch;
    const r = await probeReasoner(SETTINGS, fetchFn);
    expect(r).toEqual({ reachable: true, modelPresent: true });
  });

  it('reachable but modelPresent false when the model is absent', async () => {
    const fetchFn = (async () => tagsResponse(['llama3.1:8b'])) as typeof fetch;
    const r = await probeReasoner(SETTINGS, fetchFn);
    expect(r.reachable).toBe(true);
    expect(r.modelPresent).toBe(false);
  });

  it('matches on the base family (qwen3 request vs qwen3:8b listing)', async () => {
    const fetchFn = (async () => tagsResponse(['qwen3:8b'])) as typeof fetch;
    const r = await probeReasoner({ url: SETTINGS.url, model: 'qwen3' }, fetchFn);
    expect(r.modelPresent).toBe(true);
  });

  it('HTTP error → reachable false, never throws', async () => {
    const fetchFn = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const r = await probeReasoner(SETTINGS, fetchFn);
    expect(r).toMatchObject({ reachable: false, modelPresent: false, error: 'HTTP 503' });
  });

  it('network error → reachable false with the error message', async () => {
    const fetchFn = (async () => { throw new TypeError('fetch failed: ECONNREFUSED'); }) as typeof fetch;
    const r = await probeReasoner(SETTINGS, fetchFn);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('reachable but unparseable body → reachable true, modelPresent false', async () => {
    const fetchFn = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    const r = await probeReasoner(SETTINGS, fetchFn);
    expect(r).toEqual({ reachable: true, modelPresent: false });
  });
});

describe('buildReasonerStatus', () => {
  it('disarmed → neutral status, provider none, reachable null (no probe)', async () => {
    let probed = false;
    const fetchFn = (async () => { probed = true; return tagsResponse(['qwen3:8b']); }) as typeof fetch;
    const status = await buildReasonerStatus({
      armed: false,
      settings: async () => SETTINGS,
      activity: new ReasonerActivity(),
      fetchFn,
    });
    expect(status).toEqual({
      armed: false, provider: 'none', reachable: null, model: null, url: null, last_classify_at: null,
    });
    expect(probed).toBe(false);
  });

  it('armed + reachable + model present → green status with last-classify', async () => {
    const activity = new ReasonerActivity();
    activity.stampClassify('2026-07-10T00:00:00.000Z');
    const fetchFn = (async () => tagsResponse(['qwen3:8b'])) as typeof fetch;
    const status = await buildReasonerStatus({
      armed: true, settings: async () => SETTINGS, activity, fetchFn,
    });
    expect(status).toEqual({
      armed: true, provider: 'ollama', reachable: true, model: 'qwen3:8b',
      url: 'http://localhost:11434', last_classify_at: '2026-07-10T00:00:00.000Z',
    });
  });

  it('armed + reachable but model missing → surfaces a not-found error', async () => {
    const fetchFn = (async () => tagsResponse(['llama3.1:8b'])) as typeof fetch;
    const status = await buildReasonerStatus({
      armed: true, settings: async () => SETTINGS, activity: new ReasonerActivity(), fetchFn,
    });
    expect(status.reachable).toBe(true);
    expect(status.error).toMatch(/not found/);
  });

  it('armed + provider down → reachable false (the armed-but-dark alarm), fail-soft', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const status = await buildReasonerStatus({
      armed: true, settings: async () => SETTINGS, activity: new ReasonerActivity(), fetchFn,
    });
    expect(status.armed).toBe(true);
    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/ECONNREFUSED/);
  });

  it('armed but settings unresolvable → reachable false, nulls, never throws', async () => {
    const status = await buildReasonerStatus({
      armed: true,
      settings: async () => { throw new Error('config store down'); },
      activity: new ReasonerActivity(),
      fetchFn: (async () => tagsResponse([])) as typeof fetch,
    });
    expect(status).toMatchObject({ armed: true, provider: 'ollama', reachable: false, model: null, url: null });
    expect(status.error).toMatch(/settings unresolvable/);
  });
});

describe('LocalOllamaReasoner onClassify wiring', () => {
  function mem(id: number, content: string): CandidateMemory {
    return {
      id, content, content_hash: null, summary: null, tags: [], scope: 'project:test',
      confidence: 0.7, is_locked: false,
      created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    };
  }
  const CTX: ReasonerContext = { timeoutMs: 5000 };
  const VALID = JSON.stringify({ relation: 'unrelated', confidence: 0.9, rationale: 'clearly different topics.' });
  const chatResponse = (content: string, status = 200): Response =>
    new Response(JSON.stringify({ message: { role: 'assistant', content } }), { status });

  it('stamps liveness on a successful classify', async () => {
    const activity = new ReasonerActivity();
    const reasoner = new LocalOllamaReasoner({
      settings: async () => ({ url: 'http://localhost:11434', model: 'qwen3:8b', timeoutMs: 5000, maxTokens: 300 }),
      fetchFn: (async () => chatResponse(VALID)) as typeof fetch,
      onClassify: () => activity.stampClassify(),
    });
    expect(activity.lastClassifyAt).toBeNull();
    await reasoner.classifyPair(mem(1, 'a'), mem(2, 'b'), CTX);
    expect(activity.lastClassifyAt).not.toBeNull();
  });

  it('does NOT stamp when the provider is down (fallback verdict)', async () => {
    const activity = new ReasonerActivity();
    const reasoner = new LocalOllamaReasoner({
      settings: async () => ({ url: 'http://localhost:11434', model: 'qwen3:8b', timeoutMs: 5000, maxTokens: 300 }),
      fetchFn: (async () => { throw new Error('down'); }) as typeof fetch,
      onClassify: () => activity.stampClassify(),
    });
    const v = await reasoner.classifyPair(mem(1, 'a'), mem(2, 'b'), CTX);
    expect(v).toMatchObject({ relation: 'unrelated', confidence: 0 });
    expect(activity.lastClassifyAt).toBeNull();
  });
});
