/**
 * KOPENG recall hook (UserPromptSubmit) — Node port of memory-prompt-search.sh.
 * (No shebang: always spawned as `node <path>` by the hook config, and the
 * unit suite imports this file through vitest, whose transform rejects it.)
 *
 * WHY THIS EXISTS: on 2026-06-02 `jq` vanished from PATH and the bash hook silently
 * bailed with {} on every prompt — memory recall was OFF with zero signal while
 * writes kept working. This Node version has NO external CLI dependencies (no jq,
 * no curl): JSON via JSON.parse/stringify, HTTP via global fetch. Node is the same
 * runtime that already runs the KOPENG server and the observe hook, so there is
 * nothing external left to go missing.
 *
 * Reads a UserPromptSubmit payload on stdin; injects relevant memories plus
 * error/sequence hints as MODEL context (hookSpecificOutput.additionalContext),
 * and operator health alarms as systemMessage. Always exits 0 with valid JSON.
 *
 * Env: KOPENG_API_URL | MEMORY_API_URL (default http://localhost:3200)
 *
 * C1.3 (T16): Added POST /api/surface call in the same Promise.all as recall.
 * Recall keeps the 3s hard ceiling; /api/surface runs under its own tighter leash
 * (SURFACE_TIMEOUT_MS) so a stalled surface can't drag a fast recall to 3s.
 * Surfaces tools/skills/conventions with correct labels and binding wording.
 *
 * C1.4 (T13): Extended logSuggestion records with per-suggestion class/key/score/binding
 * fields from /api/surface for causal acceptance metric. Back-compatible — fields
 * are optional and only populated when the surface endpoint returns items.
 */

import { readFileSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
// T32: the canonical/critical detection machinery (SOT_RE/ABS_PATH_RE/sotNearPath)
// moved to the shared module so this hook (armer) and canonical-path-guard.mjs
// (fallback matcher) can never drift. This hook is also the trigger-term index
// WRITER: it refreshes ~/.kopeng/cache/canonical_triggers_{project}.json so the
// guard can deny a trigger-term WebSearch even when a mid-turn injected message
// never ran recall (the T32 blind spot).
import {
  SOT_RE, ABS_PATH_RE, sotNearPath,
  buildTriggerEntries, writeTriggerCache, triggerCachePath, TRIGGER_CACHE_TTL_MS,
} from './canonical-triggers.mjs';

// Re-export for the unit suite (turn-gate.test.ts imports sotNearPath from here).
export { sotNearPath };

const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const HINTS_DIR = process.env.KOPENG_HINTS_DIR || join(homedir(), '.kopeng', 'hints');
const ERROR_HINT_FILE = join(HINTS_DIR, 'last_error.json');
const SEQUENCE_HINT_FILE = join(HINTS_DIR, 'sequence_hint.json');
// T18: flush-failure alarm — written by kopeng-observe.js on any flush trouble,
// cleared by its next fully-drained flush. Read (NOT read-and-cleared) so a
// capture outage stays visible in-band until it is actually fixed — the
// silent-outage lesson. Not project-scoped: flushing is global.
const FLUSH_ERROR_HINT_FILE = join(HINTS_DIR, 'flush_error.json');
// Canonical-path gate (feedback #4506): armed when a TOP recall result carries
// source-of-truth phrasing + an absolute path. canonical-path-guard.mjs reads this
// to block WebSearch/WebFetch until the path is Read; the observe hook clears it on touch.
const CANONICAL_HINT_FILE = join(HINTS_DIR, 'canonical_path.json');
// T29 turn gate: a memory is "critical" (its surfacing must be demonstrably acted
// on before the turn ends) when it carries the `critical` tag OR reads as a canonical
// source-of-truth (SOT_RE) — AND it is path-anchored (has an absolute-path referent
// we can deterministically check was touched). The recall hook ARMS the per-session
// hint; kopeng-observe.js marks referents consulted on touch; turn-gate.mjs blocks the
// Stop until every armed critical was consulted. Path-anchored only (v1) keeps the
// "consulted" signal deterministic — same substring machinery as the canonical gate.
const CRITICAL_TAG = 'critical';
// C0 proactive-use logging: one JSONL line per prompt that surfaced anything.
// Read by `npm run metric:proactive` to compute proactive-use + suggestion→action
// rates against the observation log. Append-only, fail-silent — never blocks emit.
const METRICS_DIR = join(homedir(), '.kopeng', 'metrics');
const SUGGESTIONS_LOG = join(METRICS_DIR, 'suggestions.jsonl');
const HINT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 3000;
const SURFACE_TIMEOUT_MS = 2000; // /api/surface: its own tighter leash, under the 3s ceiling (invariant #1)
const MIN_PROMPT_LEN = 25;

// Output shape differs per agent, and the two payloads have DIFFERENT audiences:
//
//   context — the recalled memories/hints/surfacing. The MODEL must see this.
//             Claude Code takes model-visible context as
//             hookSpecificOutput.additionalContext (or plain stdout, for
//             UserPromptSubmit/SessionStart only).
//   warning — the T18 capture-outage alarm. The OPERATOR must see this, and it
//             is not prompt context, so it stays in systemMessage.
//
// systemMessage is rendered to the operator and NEVER reaches the model. Shipping
// recall in it (as this hook did until sweep-3 PB-1) puts every memory in the
// transcript and none in Claude's context — silently, since the payload still
// looks right on stdout. Codex ignores JSON entirely and injects raw stdout.
// Shape is pinned by tests/unit/hook-output-contract.test.ts.
const CODEX = process.argv.includes('--codex');
const HOOK_EVENT = 'UserPromptSubmit';

// Synchronous write to stdout fd — guaranteed flushed before exit (process.exit
// can truncate async process.stdout.write). Then exit 0.
function emit({ context = '', warning = '' } = {}) {
  try {
    if (CODEX) {
      // Codex has one channel: stdout. Both payloads go there, warning first.
      const text = [warning, context].filter(Boolean).join('\n\n');
      if (text) writeFileSync(1, text);
    } else {
      const out = {};
      if (context) out.hookSpecificOutput = { hookEventName: HOOK_EVENT, additionalContext: context };
      if (warning) out.systemMessage = warning;
      writeFileSync(1, JSON.stringify(out));
    }
  } catch { /* ignore */ }
  process.exit(0);
}

/**
 * T18: compose the flush-failure alarm line from the hint file's contents.
 * Pure (hint object + clock in, string out) so the alarm's SURFACING half is
 * unit-testable — the writing half lives in kopeng-observe.js (review finding:
 * only the writer side was tested). Returns '' for a missing/garbage hint.
 */
export function composeFlushWarning(hint, nowMs = Date.now()) {
  if (!hint || typeof hint !== 'object' || !hint.timestamp) return '';
  const ageMin = Math.max(0, Math.round((nowMs - new Date(hint.timestamp).getTime()) / 60000));
  if (!Number.isFinite(ageMin)) return '';
  const kb = Math.round((hint.pending_bytes || 0) / 1024);
  return `⚠ KOPENG observation flush is failing (${hint.reason || 'error'}${hint.status ? `, HTTP ${hint.status}` : ''}; ~${kb} KB pending; last attempt ${ageMin} min ago). Tool-use capture is buffering locally — check the KOPENG server / scripts/hooks/kopeng-observe.js.`;
}

/** Read the flush hint (NOT read-and-clear — the observe hook owns its lifecycle). */
function readFlushWarning() {
  try {
    return composeFlushWarning(JSON.parse(readFileSync(FLUSH_ERROR_HINT_FILE, 'utf-8')));
  } catch {
    return ''; // no hint — flushing healthy
  }
}

// Read-once semantics: parse a hint file then delete it. Returns object or null.
function readAndClearHint(path) {
  let raw;
  try { raw = readFileSync(path, 'utf-8'); } catch { return null; }
  try { unlinkSync(path); } catch { /* ignore */ }
  try { return JSON.parse(raw); } catch { return null; }
}

function hintFresh(timestamp, project, expectedProject) {
  if (!timestamp || project !== expectedProject) return false;
  const age = Date.now() - new Date(timestamp).getTime();
  return age >= 0 && age < HINT_MAX_AGE_MS;
}

/**
 * Feedback #4506: arm the canonical-path guard. If one of the most-relevant recall
 * results carries BOTH source-of-truth phrasing AND an absolute path, write the hint
 * so canonical-path-guard.mjs blocks WebSearch/WebFetch until that path is Read.
 * Scoped to the top 2 results (most relevant) to avoid arming on incidental mentions.
 * Session-scoped (2026-07-06): the hint carries the arming session's id and the guard
 * only gates THAT session — the hint file is global, and a fleet of parallel research
 * subagents got their WebSearch/WebFetch cross-blocked by an unrelated session's hint.
 * Fail-silent: never throws into the recall path.
 */
function armCanonicalPathHint(memories, prompt, projectScope, sessionId) {
  try {
    const paths = new Set();
    for (const m of (memories || []).slice(0, 2)) {
      const content = String(m?.content || '');
      if (!SOT_RE.test(content)) continue;
      const found = content.match(ABS_PATH_RE);
      if (!found) continue;
      for (const p of found) paths.add(p.replace(/[).,;:]+$/, '')); // strip trailing punctuation
    }
    if (paths.size === 0) return;
    mkdirSync(HINTS_DIR, { recursive: true });
    writeFileSync(CANONICAL_HINT_FILE, JSON.stringify({
      paths: [...paths],
      entity: prompt.slice(0, 80),
      timestamp: new Date().toISOString(),
      project: projectScope,
      session_id: sessionId || '',
    }));
  } catch { /* never block recall on the gate */ }
}

/**
 * T29: per-session critical-memory hint path. Session-scoped (not a single global
 * file like the canonical gate) so parallel sessions never clobber each other's
 * gate state — the parallel-subagent lesson, applied structurally. Must stay
 * byte-identical to the derivation in kopeng-observe.js and turn-gate.mjs.
 */
export function criticalHintFile(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '') || 'nosession';
  return join(HINTS_DIR, `critical_${safe}.json`);
}

/**
 * T29 (pure, exported for tests): pick out the path-anchored critical memories from
 * a recall result set. A memory qualifies when it is tagged `critical` (explicit operator
 * intent — a path anywhere in the content anchors it) OR reads as a canonical source-of-truth
 * whose SOT phrasing actually points at a path (SOT_RE within SOT_PROXIMITY of an absolute
 * path — an incidental "canonical" adjective far from any path does NOT qualify). Returns one
 * item per memory with all its distinct path referents (consulting ANY of them counts as
 * engaging the memory). No I/O.
 */
export function extractCriticalItems(memories) {
  const items = [];
  for (const m of memories || []) {
    const content = String(m?.content || '');
    const tags = Array.isArray(m?.tags) ? m.tags : [];
    const isCritical = tags.includes(CRITICAL_TAG) || sotNearPath(content);
    if (!isCritical) continue;
    const found = content.match(ABS_PATH_RE);
    if (!found) continue; // v1: path-anchored only — no deterministic touch signal otherwise
    const referents = [...new Set(found.map((p) => p.replace(/[).,;:]+$/, '')))];
    if (referents.length === 0) continue;
    items.push({
      id: m?.id ?? null,
      memory_type: String(m?.type || ''),
      referents,
      excerpt: content.slice(0, 100),
    });
  }
  return items;
}

/**
 * T29: arm the turn gate. Merge newly-surfaced critical memories into the per-session
 * hint, PRESERVING the consulted/nudged flags of items already tracked (a memory
 * consulted in an earlier turn stays satisfied; it is not re-gated just because it
 * surfaced again). Fail-silent — never blocks recall. Exported for the merge/top-2 tests.
 */
export function armCriticalMemoriesHint(memories, projectScope, sessionId) {
  try {
    // Relevance gate: only the top-2 recall results are eligible to arm the turn gate —
    // mirrors armCanonicalPathHint's top-2 slice ("avoid arming on incidental mentions"),
    // so a weakly-relevant tail result can never hard-block an off-topic turn.
    const fresh = extractCriticalItems((memories || []).slice(0, 2));
    if (fresh.length === 0) return;
    const file = criticalHintFile(sessionId);
    let existing = [];
    try {
      const prev = JSON.parse(readFileSync(file, 'utf-8'));
      if (prev && prev.session_id === sessionId && Array.isArray(prev.items)) existing = prev.items;
    } catch { /* no prior file — start fresh */ }

    const byId = new Map(existing.map((it) => [it.id, it]));
    for (const it of fresh) {
      const prior = byId.get(it.id);
      if (prior) {
        // Keep prior consulted/nudged; refresh referents (content may have changed).
        prior.referents = it.referents;
        prior.memory_type = it.memory_type;
        prior.excerpt = it.excerpt;
      } else {
        byId.set(it.id, { ...it, consulted: false, nudged: false, surfaced_at: new Date().toISOString() });
      }
    }

    mkdirSync(HINTS_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({
      session_id: sessionId,
      project: projectScope,
      updated_at: new Date().toISOString(),
      items: [...byId.values()],
    }));
  } catch { /* never block recall on the gate */ }
}

async function recall(body, signal) {
  try {
    const res = await fetch(`${API_URL}/api/memories/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
  }
}

/**
 * C1.3 (T16): Thin client for POST /api/surface.
 * Returns { tools: [], skills: [], conventions: [] } on any error (fail-silent).
 * Runs under its OWN tighter AbortSignal (SURFACE_TIMEOUT_MS, under the 3s ceiling) — if
 * /api/surface stalls it aborts to empty without dragging the fast recall calls up to 3s.
 */
async function fetchSurface(prompt, projectScope, signal) {
  const empty = { tools: [], skills: [], conventions: [] };
  try {
    const res = await fetch(`${API_URL}/api/surface`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, project_scope: projectScope }),
      signal,
    });
    if (!res.ok) return empty;
    const json = await res.json();
    const d = json?.data;
    if (!d || typeof d !== 'object') return empty;
    return {
      tools: Array.isArray(d.tools) ? d.tools : [],
      skills: Array.isArray(d.skills) ? d.skills : [],
      conventions: Array.isArray(d.conventions) ? d.conventions : [],
    };
  } catch {
    return empty;
  }
}

/**
 * T32: is the canonical trigger-term cache due for a refresh? Mirrors the
 * sequence cache's stale-while-revalidate: refetch once past 80% of TTL (or
 * missing/corrupt). Fail-open to TRUE — a broken cache is exactly when a
 * refresh is most needed.
 */
export function triggerCacheRefreshDue(projectScope, nowMs = Date.now()) {
  try {
    const parsed = JSON.parse(readFileSync(triggerCachePath(projectScope), 'utf-8'));
    const age = nowMs - new Date(parsed?.fetched_at || 0).getTime();
    return !(age >= 0 && age < TRIGGER_CACHE_TTL_MS * 0.8);
  } catch {
    return true;
  }
}

/**
 * T32: one lite list page for the trigger-index refresh. fields=lite skips the
 * embedding blob server-side (viz-proven cheap); metadata/tags/content are all
 * present. Bounded to one page — trigger-term canonicals are rare by convention
 * (1 on live today), and a >500-row scope simply contributes its first page.
 * Fail-silent to NULL (distinct from a genuinely empty scope's [] — the caller
 * must never overwrite a good cache with emptiness just because a fetch died).
 */
async function fetchMemoriesLite(scope, signal) {
  try {
    const res = await fetch(
      `${API_URL}/api/memories?scope=${encodeURIComponent(scope)}&fields=lite&limit=500`,
      { signal },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : null;
  } catch {
    return null;
  }
}

/**
 * C1.4 (T13): Extended suggestion record schema.
 * Back-compatible: new fields (surfaced_items) are OPTIONAL — old records without
 * them still parse correctly in metric-proactive-use.ts and metric-surfacing.ts.
 * surfaced_items carries per-suggestion class/key/score/binding from /api/surface.
 */
// C0: append a surfaced-suggestion record. session_id mirrors the observe hook's
// source (CLAUDE_SESSION_ID) so the metric script can join the two logs.
function logSuggestion(rec) {
  try {
    mkdirSync(METRICS_DIR, { recursive: true });
    appendFileSync(SUGGESTIONS_LOG, JSON.stringify(rec) + '\n');
  } catch { /* never block the hook on metrics */ }
}

async function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { emit({}); return; }

  const sessionId = String(input.session_id || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '');
  const prompt = String(input.user_prompt || input.prompt || '');
  const cwd = String(input.cwd || '');

  // T18: the capture-outage alarm is a GLOBAL health signal, not a
  // prompt-relevance signal — it surfaces even on prompts too short for
  // recall (review finding: the length gate used to swallow it).
  const flushWarning = readFlushWarning();
  if (!prompt || prompt.length < MIN_PROMPT_LEN) {
    emit({ warning: flushWarning });
    return;
  }

  const projectScope = `project:${basename(cwd)}`;

  // ── Error hint ──
  let errorContext = '', errorCategory = '', hasHint = false;
  const errHint = readAndClearHint(ERROR_HINT_FILE);
  if (errHint && hintFresh(errHint.timestamp, errHint.project, projectScope)) {
    errorCategory = errHint.category || '';
    errorContext = `error ${errorCategory} ${errHint.signature || ''} ${errHint.snippet || ''}`.trim();
    hasHint = true;
  }

  // ── Sequence hint ──
  let seqMessage = '';
  const seqHint = readAndClearHint(SEQUENCE_HINT_FILE);
  if (seqHint && hintFresh(seqHint.timestamp, seqHint.project, projectScope) && seqHint.current_tool_key) {
    const steps = Array.isArray(seqHint.next_steps) ? seqHint.next_steps : [];
    const formatted = steps.map(s => `  - ${s}`).join('\n');
    if (formatted) {
      seqMessage = `Workflow pattern: after ${seqHint.current_tool_key}, the usual next step(s) are:\n${formatted}`;
    }
  }

  // ── Build query + recall (memory + tool) + surface in parallel under one AbortSignal ──
  // C1.3: All three fetch calls share a single AbortSignal (the hard ceiling).
  // If /api/surface stalls, it is cancelled at 3s along with everything else —
  // the recall results that resolved earlier are preserved (Promise.all already
  // captured them). A stalled surface cannot push the total wall-clock past the ceiling.
  const query = hasHint ? `${errorContext} ${prompt}`.slice(0, 400) : prompt.slice(0, 200);
  const recallLimit = hasHint ? 5 : 3;

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // /api/surface gets its own tighter leash (invariant #1: "its own short timeout") so a
  // stalled surface can't drag a fast recall up to the 3s ceiling. It fails to empty on abort.
  const surfaceSignal = AbortSignal.timeout(SURFACE_TIMEOUT_MS);

  // T32: trigger-term index refresh rides the SAME parallel window under the
  // surface-tier 2s leash — zero added wall-clock (Promise.all) and it aborts to
  // null (skip write, retry next prompt) rather than dragging recall to 3s.
  // Refresh is due at most once per ~8 min (80% of TTL), so most prompts add
  // nothing at all.
  const refreshDue = triggerCacheRefreshDue(projectScope);
  const triggerSignal = AbortSignal.timeout(SURFACE_TIMEOUT_MS);
  const triggerFetch = refreshDue
    ? Promise.all([fetchMemoriesLite('global', triggerSignal), fetchMemoriesLite(projectScope, triggerSignal)])
    : Promise.resolve(null);

  const [memories, tools, surfaceResult, triggerRows] = await Promise.all([
    recall({ query, scopes: [projectScope, 'global'], threshold: 0.40, limit: recallLimit }, signal),
    recall({ query: prompt, scope: 'client:claude-tool', threshold: 0.45, limit: 3 }, signal),
    fetchSurface(prompt, projectScope, surfaceSignal),
    triggerFetch,
  ]);

  // T32: commit the refreshed trigger-term index for canonical-path-guard.mjs's
  // no-hint fallback. Only when BOTH scope pages fetched cleanly — a dead server
  // must never wipe a good cache with emptiness. An empty-but-clean result IS
  // written (fetched_at is the refresh watermark).
  if (triggerRows && triggerRows[0] !== null && triggerRows[1] !== null) {
    writeTriggerCache(projectScope, buildTriggerEntries([...triggerRows[0], ...triggerRows[1]]));
  }

  // Feedback #4506: arm the canonical-path guard from the surfaced memories before
  // anything else uses them. WebSearch/WebFetch stay blocked until the path is Read.
  armCanonicalPathHint(memories, prompt, projectScope, sessionId);

  // T29: arm the turn gate from the same surfaced memories — critical (tagged or
  // canonical) path-anchored memories must be consulted before the turn can end.
  armCriticalMemoriesHint(memories, projectScope, sessionId);

  // Dedup tool suggestions against surfaced memories (same content can exist in both scopes)
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const memoryContents = new Set(memories.map(m => norm(m.content)));
  const dedupedTools = tools.filter(t => !memoryContents.has(norm(t.content)));

  // C1.3: Dedup /api/surface items against recall memories and against each other.
  // Surface skills/tools/conventions are deduplicated using the same norm() helper.
  // Conventions are deduplicated against memories AND against tools/skills (advisory,
  // so they are lower priority and deduped last).
  const allNormed = new Set([...memoryContents, ...dedupedTools.map(t => norm(t.content))]);

  const surfaceSkills = (surfaceResult.skills || []).filter(s => !allNormed.has(norm(s.content)));
  surfaceSkills.forEach(s => allNormed.add(norm(s.content)));

  const surfaceTools = (surfaceResult.tools || []).filter(s => !allNormed.has(norm(s.content)));
  surfaceTools.forEach(s => allNormed.add(norm(s.content)));

  const surfaceConventions = (surfaceResult.conventions || []).filter(s => !allNormed.has(norm(s.content)));

  const hasSurfaceSkills = surfaceSkills.length > 0;
  const hasSurfaceTools = surfaceTools.length > 0;
  const hasSurfaceConventions = surfaceConventions.length > 0;
  const hasAnySurface = hasSurfaceSkills || hasSurfaceTools || hasSurfaceConventions;

  const hasRecall = memories.length > 0;
  const hasTools = dedupedTools.length > 0;
  if (!hasRecall && !hasHint && !seqMessage && !hasTools && !hasAnySurface && !flushWarning) { emit({}); return; }

  // ── Compose the model-visible context block ──
  // The flush alarm is deliberately NOT in here: it is an operator health signal,
  // not prompt context, and rides the systemMessage channel instead.
  const parts = [];
  if (hasHint) parts.push(`Known error pattern detected (${errorCategory}).`);
  if (seqMessage) parts.push(seqMessage);
  if (hasRecall) {
    const lines = memories.map(m => {
      const c = String(m.content || '');
      return `- [${m.type}] ${c.length > 350 ? c.slice(0, 350) + '...' : c}`;
    }).join('\n');
    if (lines) parts.push(`Relevant memories:\n${lines}`);
  }
  if (hasTools) {
    const lines = dedupedTools.map(t => `- ${String(t.content || '').split('\n')[0]}`).join('\n');
    if (lines) parts.push(`Tools that may help with this prompt:\n${lines}`);
  }

  // C1.3: Compose /api/surface blocks with correct labels and binding wording.
  // Skills + tools are HARD (act-or-explain per C0 binding rule).
  // Conventions are ADVISORY ("consider it" — softer, higher-volume class).
  if (hasSurfaceSkills) {
    const lines = surfaceSkills.map(s => {
      const first = String(s.content || '').split('\n')[0];
      return `- ${first}`;
    }).join('\n');
    if (lines) parts.push(`Skills that fit this task:\n${lines}`);
  }
  if (hasSurfaceTools) {
    const lines = surfaceTools.map(s => {
      const first = String(s.content || '').split('\n')[0];
      return `- ${first}`;
    }).join('\n');
    if (lines) parts.push(`Tools that may help:\n${lines}`);
  }
  if (hasSurfaceConventions) {
    const lines = surfaceConventions.map(s => {
      const first = String(s.content || '').split('\n')[0];
      return `- ${first}`;
    }).join('\n');
    if (lines) parts.push(`Project conventions (FYI):\n${lines}\n(These are advisory — consider them if relevant, no need to explain if not applicable.)`);
  }

  // No context to inject — but a pending alarm still has to reach the operator.
  if (parts.length === 0) { emit({ warning: flushWarning }); return; }

  // C0 proactive-use baseline: record what was surfaced (the "suggestion" side;
  // the "action" side lives in the observation log, joined by session_id).
  //
  // C1.4 (T13): Extended with per-suggestion items from /api/surface.
  // surfaced_items is OPTIONAL — old records without it still parse in both metric scripts.
  // Each item carries: class (tool|skill|convention), key, score, binding (hard|advisory).
  // ts is set once per logSuggestion call (prompt-level timestamp) — individual items
  // do not get separate timestamps; the prompt-level ts is the surfacing timestamp for
  // causal ordering in metric-surfacing.ts.
  const surfacedItems = [
    ...surfaceSkills.map(s => ({ class: s.class, key: s.key, score: s.score, binding: s.binding })),
    ...surfaceTools.map(s => ({ class: s.class, key: s.key, score: s.score, binding: s.binding })),
    ...surfaceConventions.map(s => ({ class: s.class, key: s.key, score: s.score, binding: s.binding })),
  ];

  logSuggestion({
    ts: new Date().toISOString(),
    session_id: sessionId,
    project: projectScope,
    prompt_len: prompt.length,
    surfaced: {
      memories: memories.length,
      tools: dedupedTools.map(t => String(t.content || '').split('\n')[0]).filter(Boolean),
      error_hint: hasHint,
      sequence_hint: Boolean(seqMessage),
    },
    // C1.4: Per-suggestion surface items (optional, back-compatible).
    // Absent in old records; present when /api/surface returned anything.
    ...(surfacedItems.length > 0 ? { surfaced_items: surfacedItems } : {}),
  });

  emit({ context: parts.join('\n\n'), warning: flushWarning });
}

// T18 review: main() runs only when invoked as a script (mirrors
// kopeng-observe.js) so the unit suite can import composeFlushWarning.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(() => { try { if (!CODEX) writeFileSync(1, '{}'); } catch { /* ignore */ } process.exit(0); });
