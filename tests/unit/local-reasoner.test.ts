/**
 * D2.1 local reasoner adapter tests — zero-LLM (fetch is injected everywhere).
 *
 * Covers the §2.1 verify list at the unit level:
 *  - locked output contract parsing (prompts.ts);
 *  - settings resolution (operator_config blob over env defaults);
 *  - retry-once-then-fallback on invalid shape / HTTP error / network error;
 *  - per-call timeout honor + ctx.signal chaining;
 *  - token budget → num_predict, think handling, R13 prompt content;
 *  - R4b: a DISHONEST adapter (hanging fetch that ignores the abort signal)
 *    still cannot push `runPipeline` past its pass budget.
 */
import { describe, it, expect } from 'vitest';
import {
  LocalOllamaReasoner, resolveLocalReasonerSettings, defaultThink, yieldToEventLoop,
  REASONER_CONFIG_KEY, type LocalReasonerDefaults,
} from '../../src/dreaming/reasoner/local-reasoner.js';
import { parsePairVerdict, buildClassifyPairPrompt, CLASSIFY_PAIR_SYSTEM, MAX_CONTENT_CHARS } from '../../src/dreaming/reasoner/prompts.js';
import { runPipeline, DreamPassDeadlineError, StaticMemorySource, EmptyDiffGenerator, type CandidateSelector } from '../../src/dreaming/pipeline.js';
import type { CandidateMemory, ReasonerContext } from '../../src/dreaming/reasoner/reasoner.js';

function mem(id: number, content: string): CandidateMemory {
  return {
    id, content, content_hash: null, summary: null, tags: [], scope: 'project:test',
    confidence: 0.7, is_locked: false,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  };
}

const A = mem(1, 'Operator prefers tabs for indentation.');
const B = mem(2, 'Operator prefers 2-space indentation (changed from tabs).');

const DEFAULTS: LocalReasonerDefaults = {
  url: 'http://localhost:11434', model: 'qwen3:8b', timeoutMs: 5000, maxTokens: 300,
};

const CTX: ReasonerContext = { timeoutMs: 5000 };

function ollamaResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ message: { role: 'assistant', content } }), { status });
}

const VALID = JSON.stringify({ relation: 'preference_change', confidence: 0.9, rationale: 'B explicitly supersedes A.' });

/** fetch stub recording calls; pops queued responses (function entries may throw). */
function fetchStub(queue: Array<Response | (() => Response)>): { fn: typeof fetch; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const next = queue.shift();
    if (!next) throw new Error('fetch stub: queue empty');
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { fn, calls };
}

function reasonerWith(queue: Array<Response | (() => Response)>, defaults = DEFAULTS) {
  const stub = fetchStub(queue);
  const reasoner = new LocalOllamaReasoner({
    settings: async () => ({ ...defaults }),
    fetchFn: stub.fn,
  });
  return { reasoner, stub };
}

describe('prompts: locked output contract', () => {
  it('parses a valid verdict', () => {
    expect(parsePairVerdict(VALID)).toEqual({
      relation: 'preference_change', confidence: 0.9, rationale: 'B explicitly supersedes A.',
    });
  });

  it('rejects unknown relations, out-of-range confidence, missing fields, non-JSON', () => {
    expect(parsePairVerdict(JSON.stringify({ relation: 'merge', confidence: 0.5, rationale: 'x' }))).toBeNull();
    expect(parsePairVerdict(JSON.stringify({ relation: 'duplicate', confidence: 1.5, rationale: 'x' }))).toBeNull();
    expect(parsePairVerdict(JSON.stringify({ relation: 'duplicate', confidence: 0.5 }))).toBeNull();
    expect(parsePairVerdict('not json at all')).toBeNull();
  });

  it('prompt carries the R13 template/referent guard and excerpts long content', () => {
    expect(CLASSIFY_PAIR_SYSTEM).toMatch(/template-shaped/);
    expect(CLASSIFY_PAIR_SYSTEM).toMatch(/DIFFERS between the two memories/);
    const long = mem(3, 'x'.repeat(MAX_CONTENT_CHARS + 500));
    const prompt = buildClassifyPairPrompt(long, B);
    expect(prompt).toContain('[...truncated');
    expect(prompt.length).toBeLessThan(MAX_CONTENT_CHARS + 1000);
  });
});

describe('resolveLocalReasonerSettings', () => {
  it('returns env defaults when the row is missing or the blob has no reasoner key', async () => {
    const none = { getConfig: async () => null };
    expect(await resolveLocalReasonerSettings(none, DEFAULTS)).toEqual({ ...DEFAULTS });
    const empty = { getConfig: async () => ({ reasoner_provider: null, config: '{}' }) };
    expect(await resolveLocalReasonerSettings(empty, DEFAULTS)).toEqual({ ...DEFAULTS });
  });

  it('operator_config blob overrides defaults (partial override, bad values ignored)', async () => {
    const store = {
      getConfig: async () => ({
        reasoner_provider: 'ollama',
        config: JSON.stringify({
          [REASONER_CONFIG_KEY]: { model: 'qwen3:4b', timeout_ms: 9000, max_tokens: -5, think: true },
        }),
      }),
    };
    const s = await resolveLocalReasonerSettings(store, DEFAULTS);
    expect(s.model).toBe('qwen3:4b');
    expect(s.timeoutMs).toBe(9000);
    expect(s.maxTokens).toBe(300); // -5 rejected
    expect(s.think).toBe(true);
    expect(s.url).toBe(DEFAULTS.url);
  });

  it('corrupt blob / failing store degrade to defaults', async () => {
    const corrupt = { getConfig: async () => ({ reasoner_provider: null, config: '{nope' }) };
    expect(await resolveLocalReasonerSettings(corrupt, DEFAULTS)).toEqual({ ...DEFAULTS });
    const throwing = { getConfig: async (): Promise<never> => { throw new Error('db down'); } };
    expect(await resolveLocalReasonerSettings(throwing, DEFAULTS)).toEqual({ ...DEFAULTS });
  });
});

describe('LocalOllamaReasoner.classifyPair', () => {
  it('returns the parsed verdict and exposes ollama:<model> as name', async () => {
    const { reasoner, stub } = reasonerWith([ollamaResponse(VALID)]);
    const v = await reasoner.classifyPair(A, B, CTX);
    expect(v.relation).toBe('preference_change');
    expect(reasoner.name).toBe('ollama:qwen3:8b');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('http://localhost:11434/api/chat');
  });

  it('request carries the locked contract: format schema, temperature 0, think:false for qwen3, both prompts', async () => {
    const { reasoner, stub } = reasonerWith([ollamaResponse(VALID)]);
    await reasoner.classifyPair(A, B, { ...CTX, tokenBudget: 120 });
    const body = stub.calls[0].body;
    expect(body.model).toBe('qwen3:8b');
    expect(body.stream).toBe(false);
    expect(body.format.properties.relation.enum).toContain('contested');
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ temperature: 0, num_predict: 120 }); // min(300, 120)
    expect(body.messages[0]).toEqual({ role: 'system', content: CLASSIFY_PAIR_SYSTEM });
    expect(body.messages[1].content).toContain(A.content);
    expect(body.messages[1].content).toContain(B.content);
  });

  it('omits think for non-thinking families', async () => {
    const { reasoner, stub } = reasonerWith([ollamaResponse(VALID)], { ...DEFAULTS, model: 'llama3.1:8b' });
    await reasoner.classifyPair(A, B, CTX);
    expect('think' in stub.calls[0].body).toBe(false);
    expect(defaultThink('qwen3:8b')).toBe(false);
    expect(defaultThink('llama3.1:8b')).toBeUndefined();
  });

  it('retries once on an invalid verdict shape, then succeeds', async () => {
    const { reasoner, stub } = reasonerWith([ollamaResponse('{"relation":"merge"}'), ollamaResponse(VALID)]);
    const v = await reasoner.classifyPair(A, B, CTX);
    expect(v.relation).toBe('preference_change');
    expect(stub.calls).toHaveLength(2);
  });

  it('falls back to the safe no-op verdict after two invalid responses', async () => {
    const { reasoner, stub } = reasonerWith([ollamaResponse('garbage'), ollamaResponse('still garbage')]);
    const v = await reasoner.classifyPair(A, B, CTX);
    expect(v).toMatchObject({ relation: 'unrelated', confidence: 0 });
    expect(v.rationale).toMatch(/fallback/);
    expect(stub.calls).toHaveLength(2);
  });

  it('provider down (network error / HTTP 500) degrades gracefully, never throws', async () => {
    const boom = () => { throw new TypeError('fetch failed: ECONNREFUSED'); };
    const { reasoner: down } = reasonerWith([boom as any, boom as any]);
    const v1 = await down.classifyPair(A, B, CTX);
    expect(v1).toMatchObject({ relation: 'unrelated', confidence: 0 });

    const { reasoner: erroring } = reasonerWith([ollamaResponse('x', 500), ollamaResponse('x', 500)]);
    const v2 = await erroring.classifyPair(A, B, CTX);
    expect(v2).toMatchObject({ relation: 'unrelated', confidence: 0 });
    expect(v2.rationale).toMatch(/500/);
  });

  it('unresolvable settings fall back without calling the provider', async () => {
    const stub = fetchStub([]);
    const reasoner = new LocalOllamaReasoner({
      settings: async () => { throw new Error('config store down'); },
      fetchFn: stub.fn,
    });
    const v = await reasoner.classifyPair(A, B, CTX);
    expect(v).toMatchObject({ relation: 'unrelated', confidence: 0 });
    expect(stub.calls).toHaveLength(0);
  });

  it('honors min(settings.timeoutMs, ctx.timeoutMs) via AbortController for an honest fetch', async () => {
    let aborts = 0;
    const hangingHonest = (async (_url: any, init?: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborts++; reject(init.signal.reason); });
      })
    ) as typeof fetch;
    const reasoner = new LocalOllamaReasoner({
      settings: async () => ({ ...DEFAULTS, timeoutMs: 40 }),
      fetchFn: hangingHonest,
    });
    const start = Date.now();
    const v = await reasoner.classifyPair(A, B, { timeoutMs: 5000 });
    expect(v).toMatchObject({ relation: 'unrelated', confidence: 0 });
    expect(aborts).toBe(2); // both attempts timed out at the 40ms adapter cap
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('a pre-aborted ctx.signal short-circuits without a provider call', async () => {
    const { reasoner, stub } = reasonerWith([ollamaResponse(VALID)]);
    const controller = new AbortController();
    controller.abort();
    const v = await reasoner.classifyPair(A, B, { timeoutMs: 5000, signal: controller.signal });
    expect(v).toMatchObject({ relation: 'unrelated', confidence: 0 });
    expect(stub.calls).toHaveLength(0);
  });

  it('extractCondition / synthesizeCluster are null until D2.2', async () => {
    const { reasoner } = reasonerWith([]);
    expect(await reasoner.extractCondition(A, B, CTX)).toBeNull();
    expect(await reasoner.synthesizeCluster([A, B], CTX)).toBeNull();
  });

  it('yieldToEventLoop resolves (macrotask hop)', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});

describe('R4b: pipeline enforcement against a dishonest adapter', () => {
  it('a hanging fetch that IGNORES the abort signal cannot push runPipeline past its budget', async () => {
    const dishonest = (async () => new Promise<Response>(() => { /* never resolves, ignores signal */ })) as typeof fetch;
    const reasoner = new LocalOllamaReasoner({
      settings: async () => ({ ...DEFAULTS, timeoutMs: 60_000 }), // adapter cap useless on purpose
      fetchFn: dishonest,
    });
    const bandSelector: CandidateSelector = {
      select: ms => [{ kind: 'pair', members: ms.slice(0, 2), signal: 'near_duplicate', similarity: 0.9 }],
    };
    await expect(runPipeline(
      new StaticMemorySource([A, B]),
      bandSelector,
      reasoner,
      new EmptyDiffGenerator(),
      { timeoutMs: 60_000 },
      { passBudgetMs: 150 },
    )).rejects.toThrow(DreamPassDeadlineError);
  });
});
