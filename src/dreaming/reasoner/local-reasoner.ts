/**
 * LocalOllamaReasoner (D2.1) — the first LLM dependency, classify-only.
 *
 * HTTP adapter to a local Ollama (or llama.cpp with the Ollama-compatible
 * chat API). Scope is deliberately narrow (invariant #3 — the reasoner
 * classifies, the deterministic engine owns every write):
 *
 *  - `classifyPair` is implemented: the locked prompt + grammar-constrained
 *    JSON from `prompts.ts` (evaluated by `scripts/eval-reasoner-prompt.ts`
 *    before this adapter was finalized), Zod re-validation, retry-once-then-
 *    fallback. The fallback verdict is the NoOp answer (`unrelated`,
 *    confidence 0) — downstream that is a no-op, so a dead/garbling provider
 *    degrades to Phase-1 behavior with the store untouched.
 *  - `extractCondition` / `synthesizeCluster` return null until D2.2 — their
 *    prompts get the same prototype-eval treatment before they ship.
 *
 * Bounds (R4b posture: everything here is adapter-side HONOR; the pipeline
 * independently enforces `ctx.timeoutMs`/pass budget via `Promise.race` and
 * never trusts this code):
 *  - per-call timeout: `min(settings.timeoutMs, ctx.timeoutMs)` via
 *    AbortController, chained to `ctx.signal`;
 *  - token budget: `num_predict = min(settings.maxTokens, ctx.tokenBudget)`,
 *    input capped by `MAX_CONTENT_CHARS` excerpts (invariant #9 — candidates
 *    arrive pre-chunked as selector groups; no call ever sees a raw dump);
 *  - `yieldToEventLoop()` before every model call so back-to-back
 *    classifications can't starve the event loop.
 *
 * Settings are resolved PER CALL through an injected async resolver —
 * `resolveLocalReasonerSettings` merges `operator_config` (DB, hot-editable
 * via set_operator_config) over env-derived defaults, so model/url/timeout
 * changes apply without a service restart. The enable flag itself
 * (`DREAM_REASONER_ENABLED`) is env-only: arming the LLM path is a deliberate
 * restart-gated operator action, mirroring DREAMING_ENABLED.
 */
import type {
  ConsolidationReasoner, CandidateMemory, ReasonerContext,
  PairVerdict, ConditionExtraction, ClusterSynthesis,
} from './reasoner.js';
import {
  CLASSIFY_PAIR_SYSTEM, buildClassifyPairPrompt, parsePairVerdict, PAIR_VERDICT_JSON_SCHEMA,
  EXTRACT_CONDITION_SYSTEM, buildExtractConditionPrompt, parseConditionExtraction, CONDITION_EXTRACTION_JSON_SCHEMA,
  isDeliberateNoCondition,
} from './prompts.js';
import logger from '../../utils/logger.js';

/** Resolved per-call settings for the local provider. */
export interface LocalReasonerSettings {
  /** Ollama base URL, e.g. http://localhost:11434 */
  url: string;
  model: string;
  /** Adapter-side per-call timeout (the pipeline enforces its own cap on top). */
  timeoutMs: number;
  /** Output-token cap (Ollama num_predict). */
  maxTokens: number;
  /**
   * Disable thinking on thinking-capable families (qwen3 etc.) for latency.
   * Omitted from the request when undefined — passing `think` to a model that
   * doesn't support it is an Ollama error.
   */
  think?: boolean;
}

/** Env-derived defaults (config.dreaming.reasoner) — the DB blob overrides these. */
export interface LocalReasonerDefaults {
  url: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

/** Key inside `operator_config.config` holding the reasoner knob overrides. */
export const REASONER_CONFIG_KEY = 'dream_reasoner';

/** Minimal slice of IOperatorConfigStore the resolver needs (avoids a hard interface dependency). */
interface ConfigReader {
  getConfig(operatorId?: string): Promise<{ reasoner_provider: string | null; config: string } | null>;
}

/**
 * Merge operator_config over env defaults. DB knobs live in the `config` JSON
 * blob under `dream_reasoner` ({url, model, timeout_ms, max_tokens, think});
 * a malformed blob falls back to defaults rather than failing the pass.
 */
export async function resolveLocalReasonerSettings(
  store: ConfigReader,
  defaults: LocalReasonerDefaults,
  operatorId = 'default',
): Promise<LocalReasonerSettings> {
  const settings: LocalReasonerSettings = { ...defaults };
  const cfg = await store.getConfig(operatorId).catch(() => null);
  if (!cfg) return settings;
  try {
    const blob = JSON.parse(cfg.config ?? '{}');
    const r = blob?.[REASONER_CONFIG_KEY];
    if (r && typeof r === 'object') {
      if (typeof r.url === 'string' && r.url) settings.url = r.url;
      if (typeof r.model === 'string' && r.model) settings.model = r.model;
      if (typeof r.timeout_ms === 'number' && r.timeout_ms > 0) settings.timeoutMs = r.timeout_ms;
      if (typeof r.max_tokens === 'number' && r.max_tokens > 0) settings.maxTokens = r.max_tokens;
      if (typeof r.think === 'boolean') settings.think = r.think;
    }
  } catch {
    // corrupt config blob: env defaults still give a working reasoner
  }
  return settings;
}

/** Thinking-capable families: default `think: false` for fast classification. */
export function defaultThink(model: string): boolean | undefined {
  return /^(qwen3|deepseek-r1|gpt-oss)/.test(model) ? false : undefined;
}

/** One macrotask yield — keeps back-to-back reasoner calls from starving the loop. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** The safe no-op verdict the adapter degrades to (identical downstream effect to NoOpReasoner). */
function fallbackVerdict(reason: string): PairVerdict {
  return { relation: 'unrelated', confidence: 0, rationale: `local reasoner fallback: ${reason}` };
}

export interface LocalOllamaReasonerOpts {
  /** Per-call settings resolver (operator_config over env defaults). */
  settings: () => Promise<LocalReasonerSettings>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * T21 liveness stamp — invoked on each successful classify so the ops
   * reasoner-status endpoint can report last-classify-at. Optional; a missing
   * stamp is just a null last-classify in the status.
   */
  onClassify?: () => void;
}

export class LocalOllamaReasoner implements ConsolidationReasoner {
  private readonly fetchFn: typeof fetch;
  private modelName = 'unresolved';

  constructor(private readonly opts: LocalOllamaReasonerOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** `ollama:<model>` once a call has resolved settings; provenance/logging only. */
  get name(): string {
    return `ollama:${this.modelName}`;
  }

  async classifyPair(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<PairVerdict> {
    let settings: LocalReasonerSettings;
    try {
      settings = await this.opts.settings();
    } catch (err) {
      return fallbackVerdict(`settings unresolvable (${err instanceof Error ? err.message : String(err)})`);
    }
    this.modelName = settings.model;

    // Retry once, then fall back — never throw provider trouble into the pass.
    let lastReason = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
      await yieldToEventLoop();
      if (ctx.signal?.aborted) return fallbackVerdict('aborted');
      try {
        const raw = await this.chat(settings, ctx, PAIR_VERDICT_JSON_SCHEMA, [
          { role: 'system', content: CLASSIFY_PAIR_SYSTEM },
          { role: 'user', content: buildClassifyPairPrompt(a, b) },
        ]);
        const verdict = parsePairVerdict(raw);
        if (verdict) {
          // T21: a parsed verdict means the provider answered a classify call —
          // stamp liveness so armed-but-dark is detectable at the ops surface.
          this.opts.onClassify?.();
          return verdict;
        }
        lastReason = `invalid verdict shape (attempt ${attempt + 1}): ${raw.slice(0, 120)}`;
        logger.warn(`LocalOllamaReasoner: ${lastReason}`);
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        logger.warn(`LocalOllamaReasoner: call failed (attempt ${attempt + 1}, pair ${a.id}/${b.id}): ${lastReason}`);
      }
    }
    return fallbackVerdict(lastReason);
  }

  /**
   * D2.2 — branch extraction for pairs already classified `conditional`.
   * Same bounds + retry posture as classifyPair; the safe fallback is null
   * ("not extractable"), which the router downgrades to a contested entry.
   * The parser also returns null when the model uses the empty-string escape
   * hatch or both conditions collapse to the same phrase.
   */
  async extractCondition(a: CandidateMemory, b: CandidateMemory, ctx: ReasonerContext): Promise<ConditionExtraction | null> {
    let settings: LocalReasonerSettings;
    try {
      settings = await this.opts.settings();
    } catch (err) {
      logger.warn(`LocalOllamaReasoner: extractCondition settings unresolvable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    this.modelName = settings.model;

    for (let attempt = 0; attempt < 2; attempt++) {
      await yieldToEventLoop();
      if (ctx.signal?.aborted) return null;
      try {
        const raw = await this.chat(settings, ctx, CONDITION_EXTRACTION_JSON_SCHEMA, [
          { role: 'system', content: EXTRACT_CONDITION_SYSTEM },
          { role: 'user', content: buildExtractConditionPrompt(a, b) },
        ]);
        const extraction = parseConditionExtraction(raw);
        if (extraction) return extraction;
        // An explicit escape-hatch answer is valid JSON with empty conditions —
        // no point retrying a deliberate "no distinguisher"; shape garbage retries.
        if (isDeliberateNoCondition(raw)) return null;
        logger.warn(`LocalOllamaReasoner: invalid extraction shape (attempt ${attempt + 1}): ${raw.slice(0, 120)}`);
      } catch (err) {
        logger.warn(`LocalOllamaReasoner: extractCondition failed (attempt ${attempt + 1}, pair ${a.id}/${b.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  }

  /** D2.2 — prompt gets its own prototype eval before shipping. */
  async synthesizeCluster(_members: CandidateMemory[], _ctx: ReasonerContext): Promise<ClusterSynthesis | null> {
    return null;
  }

  /** One bounded chat call. Throws on HTTP/network/timeout — callers own retry/fallback. */
  private async chat(
    settings: LocalReasonerSettings,
    ctx: ReasonerContext,
    format: object,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const capMs = Math.min(settings.timeoutMs, ctx.timeoutMs);
    const numPredict = ctx.tokenBudget !== undefined
      ? Math.min(settings.maxTokens, ctx.tokenBudget)
      : settings.maxTokens;
    const think = settings.think ?? defaultThink(settings.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`adapter timeout after ${capMs}ms`)), capMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    const onOuterAbort = (): void => controller.abort(ctx.signal?.reason ?? new Error('aborted by caller'));
    ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await this.fetchFn(`${settings.url.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: settings.model,
          stream: false,
          format,
          ...(think !== undefined ? { think } : {}),
          options: { temperature: 0, num_predict: numPredict },
          messages,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      const body = await res.json() as { message?: { content?: string } };
      return body.message?.content ?? '';
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
