/**
 * Reasoner liveness (T21) — the ops-surface answer to "armed but dark".
 *
 * DREAM_REASONER_ENABLED can be true while the Ollama provider is down, and
 * before this the only symptom was the whole dream pipeline silently degrading
 * to NoOp/Phase-1 behavior. This module turns that into a visible, read-only
 * status: armed flag, provider reachability (fail-soft probe), resolved model,
 * and the last time a classify call actually landed.
 *
 * Everything here is fail-soft: a provider that is down, slow, or garbling
 * yields `reachable: false` (never a throw). The status endpoint that consumes
 * it is public and must never wedge on a dead Ollama.
 */

/** In-process activity stamp — the reasoner marks each successful classify. */
export class ReasonerActivity {
  private lastClassifyAtIso: string | null = null;

  /** Record that a classify call just succeeded (ISO-8601 UTC). */
  stampClassify(atIso: string = new Date().toISOString()): void {
    this.lastClassifyAtIso = atIso;
  }

  /** Last successful classify timestamp, or null if the reasoner never ran. */
  get lastClassifyAt(): string | null {
    return this.lastClassifyAtIso;
  }
}

/** Shape returned by the reasoner-status ops endpoint. */
export interface ReasonerLivenessStatus {
  /** DREAM_REASONER_ENABLED — the env flag arming the LLM path. */
  armed: boolean;
  /** 'ollama' when armed, 'none' (NoOp) otherwise — display truth. */
  provider: 'ollama' | 'none';
  /**
   * Provider probe result. Boolean when we probed (armed), null when we didn't
   * (disarmed — nothing to reach, so reachability is not applicable).
   */
  reachable: boolean | null;
  /** Resolved model (operator_config over env default), or null when disarmed. */
  model: string | null;
  /** Resolved base URL, or null when disarmed. */
  url: string | null;
  /** Last successful classify (ISO-8601 UTC), or null. */
  last_classify_at: string | null;
  /** Probe error detail when reachable is false (short, for the ops foot line). */
  error?: string;
}

/** Minimal settings slice the probe needs (url + model). */
export interface ProbeSettings {
  url: string;
  model: string;
}

export interface ProbeResult {
  reachable: boolean;
  /** Whether the resolved model appears in the provider's model list. */
  modelPresent: boolean;
  error?: string;
}

/**
 * Fail-soft reachability probe against an Ollama-compatible provider. GETs
 * `${url}/api/tags` (the model list) under a short timeout. Returns
 * `reachable: false` with a short error on any HTTP/network/timeout failure —
 * never throws.
 */
export async function probeReasoner(
  settings: ProbeSettings,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  try {
    const res = await fetchFn(`${settings.url.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false, modelPresent: false, error: `HTTP ${res.status}` };
    }
    let modelPresent = false;
    try {
      const body = await res.json() as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? []).map(m => m.name ?? m.model ?? '');
      // Exact tag match; a TAGLESS request (`qwen3`) also matches any tag of that
      // family (`qwen3:8b`). A tagged request (`qwen3:8b`) must match exactly —
      // so an installed `qwen3:4b` does NOT read as the requested `qwen3:8b`.
      const wantsTagless = !settings.model.includes(':');
      modelPresent = names.some(n =>
        n === settings.model || (wantsTagless && n.split(':')[0] === settings.model));
    } catch {
      // Reachable but unparseable body — still reachable, model presence unknown.
      modelPresent = false;
    }
    return { reachable: true, modelPresent };
  } catch (err) {
    return { reachable: false, modelPresent: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface BuildReasonerStatusOpts {
  /** DREAM_REASONER_ENABLED. */
  armed: boolean;
  /** Per-call settings resolver (operator_config over env defaults). */
  settings: () => Promise<ProbeSettings>;
  /** In-process activity stamp (shared with the live reasoner). */
  activity: ReasonerActivity;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Probe timeout override (tests). */
  probeTimeoutMs?: number;
}

/**
 * Compose the read-only reasoner status. Resolves settings, probes the provider
 * when armed, and folds in the in-process last-classify stamp. Fail-soft
 * throughout — a settings-resolution error degrades to nulls, a dead provider
 * to `reachable: false`.
 */
export async function buildReasonerStatus(opts: BuildReasonerStatusOpts): Promise<ReasonerLivenessStatus> {
  const lastClassifyAt = opts.activity.lastClassifyAt;
  if (!opts.armed) {
    return {
      armed: false,
      provider: 'none',
      reachable: null,
      model: null,
      url: null,
      last_classify_at: lastClassifyAt,
    };
  }

  let settings: ProbeSettings;
  try {
    settings = await opts.settings();
  } catch (err) {
    return {
      armed: true,
      provider: 'ollama',
      reachable: false,
      model: null,
      url: null,
      last_classify_at: lastClassifyAt,
      error: `settings unresolvable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const probe = await probeReasoner(settings, opts.fetchFn, opts.probeTimeoutMs);
  return {
    armed: true,
    provider: 'ollama',
    reachable: probe.reachable,
    model: settings.model,
    url: settings.url,
    last_classify_at: lastClassifyAt,
    ...(probe.reachable
      ? (probe.modelPresent ? {} : { error: `model '${settings.model}' not found on provider` })
      : { error: probe.error ?? 'provider unreachable' }),
  };
}
