#!/usr/bin/env node
/**
 * Canonical-path guard (PreToolUse on WebSearch|WebFetch) — enforces KOPENG feedback #4506.
 *
 * WHY THIS EXISTS: 2026-06-20. The recall hook surfaced the canonical path for an
 * entity (a design-system name → a `C:\Users\...` path with "ALWAYS refers to"
 * phrasing) and I web-searched + asked the operator to disambiguate instead of just
 * reading it. The surfaced path is a source of truth to OPEN, not a guess to litigate.
 *
 * MECHANISM: the recall hook (memory-prompt-search.mjs) writes
 * ~/.kopeng/hints/canonical_path.json when a top recall result carries source-of-truth
 * phrasing + an absolute path for the asked-about entity. THIS hook denies WebSearch /
 * WebFetch while that hint is fresh, telling the model to Read the path first. The hint
 * is cleared by the observe hook the moment the model Reads/Globs/Greps/Bash-touches the
 * path (read-to-unlock), and self-expires after HINT_MAX_AGE_MS.
 *
 * T32 FALLBACK (repeated real-world name-collision incidents): the recall hook is
 * UserPromptSubmit-only, so a message injected MID-TURN never runs recall and the
 * hint never arms — the armed-hint path above stays dark exactly when the operator
 * steers mid-flight. Fallback: when NO hint gates this call, consult the cached
 * trigger-term index the recall hook maintains (~/.kopeng/cache/
 * canonical_triggers_{project}.json — memories carrying metadata.trigger_terms +
 * SOT phrasing + an absolute path, e.g. #3892 trigger_terms:["acme"]). If the
 * tool input contains a trigger term, SELF-ARM the standard hint (so the existing
 * observe-hook read-to-unlock and 5-min self-expiry govern the window — a fallback
 * denial is escapable exactly like an armed one) and deny naming the path. A
 * per-(session, memory) cooldown allows AT MOST ONE deny-window per
 * TRIGGER_FALLBACK_COOLDOWN_MS: once a window closes (touched or expired), later
 * term-bearing searches pass — a term-containing-but-unrelated search is never
 * blocked forever. Hot path stays ~0: one small JSON cache read + substring
 * match, NO network.
 *
 * FAIL-OPEN: any parse/IO error allows the tool. A guard bug must never wedge the
 * toolchain — the worst case is "web search not blocked", never "tools broken".
 * Only WebSearch|WebFetch are matched (rare tools), so this never touches the hot path.
 *
 * SESSION-SCOPED (2026-07-06): the hint file is global (~/.kopeng), but the gate must
 * only apply to the session whose prompt armed it — a fleet of parallel research
 * subagents got their web verification cross-blocked by an unrelated session's hint.
 * A definite session mismatch allows; a missing id on either side keeps the old
 * conservative block so a partially-deployed or legacy hint still gates.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  readTriggerCache, matchTrigger, TRIGGER_FALLBACK_COOLDOWN_MS,
} from './canonical-triggers.mjs';
// RULING-C (WS7.6): project:<basename(cwd)> is now project:<owner>-<repo>
// derived from the git remote, marker-overridable — see project-scope.mjs.
import { deriveProjectScope } from './project-scope.mjs';

const HINTS_DIR = process.env.KOPENG_HINTS_DIR || join(homedir(), '.kopeng', 'hints');
const HINT_FILE = join(HINTS_DIR, 'canonical_path.json');
const HINT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — matches the other hint files
// T32: durable record of fallback deny-windows (survives the hint's deletion on
// touch/expiry) so one (session, memory) pair opens at most one window per cooldown.
const FALLBACK_STATE_FILE = join(HINTS_DIR, 'canonical_fallback_state.json');

function allow() { process.exit(0); }

function readFreshHint() {
  let raw;
  try { raw = readFileSync(HINT_FILE, 'utf-8'); } catch { return null; } // ENOENT = no active gate
  let h;
  try { h = JSON.parse(raw); } catch { return null; }
  const age = Date.now() - new Date(h.timestamp).getTime();
  if (!(age >= 0 && age < HINT_MAX_AGE_MS)) { try { unlinkSync(HINT_FILE); } catch { /* ignore */ } return null; }
  return h;
}

function deny(reason) {
  try {
    writeFileSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch { /* ignore */ }
  process.exit(0);
}

/** T32: { "<session>|<memoryId>": <iso denied_at> } — pruned on write. */
function readFallbackState() {
  try {
    const parsed = JSON.parse(readFileSync(FALLBACK_STATE_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeFallbackState(state) {
  try {
    if (!existsSync(HINTS_DIR)) mkdirSync(HINTS_DIR, { recursive: true, mode: 0o700 });
    // Prune closed-out windows so the file stays a handful of keys forever.
    const cutoff = Date.now() - TRIGGER_FALLBACK_COOLDOWN_MS * 2;
    const pruned = {};
    for (const [k, v] of Object.entries(state)) {
      if (new Date(v).getTime() > cutoff) pruned[k] = v;
    }
    writeFileSync(FALLBACK_STATE_FILE, JSON.stringify(pruned), { mode: 0o600 });
  } catch { /* fail-open — worst case a duplicate deny-window much later */ }
}

/**
 * T32 (c): the fallback deny is the ONLY surfacing an injected mid-turn message
 * gets, so entries that also qualify as T29 criticals (SOT phrasing pointing AT
 * the path) additionally arm the per-session turn-gate file — consultation is
 * then enforced at Stop even if the model shrugs off the deny. Same merge
 * semantics as armCriticalMemoriesHint (preserve prior consulted/nudged flags);
 * file-path derivation byte-identical to the other three hooks. Fail-silent.
 */
function armCriticalFromFallback(entry, projectScope, sessionId) {
  try {
    const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '') || 'nosession';
    const file = join(HINTS_DIR, `critical_${safe}.json`);
    let existing = [];
    try {
      const prev = JSON.parse(readFileSync(file, 'utf-8'));
      if (prev && prev.session_id === sessionId && Array.isArray(prev.items)) existing = prev.items;
    } catch { /* no prior file — start fresh */ }

    const byId = new Map(existing.map((it) => [it.id, it]));
    if (!byId.has(entry.id)) {
      byId.set(entry.id, {
        id: entry.id,
        memory_type: entry.type || 'reference',
        referents: entry.paths,
        excerpt: entry.excerpt,
        consulted: false,
        nudged: false,
        surfaced_at: new Date().toISOString(),
      });
    }

    if (!existsSync(HINTS_DIR)) mkdirSync(HINTS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({
      session_id: sessionId,
      project: projectScope,
      updated_at: new Date().toISOString(),
      items: [...byId.values()],
    }));
  } catch { /* never block the deny on the turn gate */ }
}

/**
 * T32 fallback: no hint gates this call — check the trigger-term index. On a
 * match (outside its cooldown) self-arm the standard hint and deny. Everything
 * is inside one try/catch: any surprise ⇒ allow.
 */
function fallbackCheck(input, sessionId) {
  try {
    const cwd = String(input.cwd || process.env.CLAUDE_CWD || '');
    if (!cwd) return null; // no project identity — cache is per-project, fail open
    const projectScope = deriveProjectScope(cwd).scope;

    const cache = readTriggerCache(projectScope);
    if (!cache || cache.entries.length === 0) return null;

    // Match against the raw tool input (WebSearch {query}, WebFetch {url, prompt}
    // — stringify covers all shapes; word-boundary matching keeps a short term
    // from firing on a longer word that merely contains it (e.g. "acme" vs "pacme")).
    const text = typeof input.tool_input === 'string' ? input.tool_input : JSON.stringify(input.tool_input || {});
    const match = matchTrigger(cache.entries, text, projectScope);
    if (!match) return null;

    // One deny-window per (session, memory) per cooldown: once served (window
    // touched-closed or expired), term-bearing searches pass until it lapses.
    const state = readFallbackState();
    const key = `${sessionId || 'nosession'}|${match.entry.id}`;
    const last = new Date(state[key] || 0).getTime();
    const sinceLast = Date.now() - last;
    if (sinceLast >= 0 && sinceLast < TRIGGER_FALLBACK_COOLDOWN_MS) return null;

    state[key] = new Date().toISOString();
    writeFallbackState(state);

    // Self-arm the standard hint: from here the EXISTING machinery owns the
    // window — observe-hook read-to-unlock clears it on touch, it self-expires
    // at 5 min, and repeat searches inside the window hit the armed-hint deny.
    // (Known tradeoff, same as recall arming: this is the one global hint file,
    // so a concurrent session's armed window would be overwritten — rare, and
    // the session_id scoping keeps the gate itself from cross-blocking.)
    try {
      if (!existsSync(HINTS_DIR)) mkdirSync(HINTS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(HINT_FILE, JSON.stringify({
        paths: match.entry.paths,
        entity: match.term,
        timestamp: new Date().toISOString(),
        project: projectScope,
        session_id: sessionId || '',
        source: 'trigger_fallback',
      }), { mode: 0o600 });
    } catch { /* deny still stands for THIS call; without the hint there is just no window */ }

    // T32 (c): critical entries also arm the T29 turn gate.
    if (match.entry.critical) armCriticalFromFallback(match.entry, projectScope, sessionId);

    return match;
  } catch {
    return null; // fail-open
  }
}

function composeFallbackReason(match) {
  const list = match.entry.paths.map((p) => `  - ${p}`).join('\n');
  return (
    `BLOCKED by the canonical-path guard (KOPENG #4506 / T32 trigger-term fallback).\n\n` +
    `Your query/input mentions "${match.term}" — a canonical entity whose source-of-truth ` +
    `path is already on record:\n${list}\n\n` +
    `No recall pass armed this gate (this request likely arrived mid-turn), but the stored ` +
    `memory still OUTRANKS web search and your own/training knowledge. READ that path first — ` +
    `do not WebSearch the name and do not ask the operator to disambiguate; the memory already did.\n\n` +
    `This block clears the moment you Read/Glob/Grep that path (or after 5 minutes).`
  );
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { allow(); return; }

  const tool = String(input.tool_name || input.tool || '');
  if (tool !== 'WebSearch' && tool !== 'WebFetch') { allow(); return; }

  const sessionId = String(input.session_id || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '');

  const hint = readFreshHint();
  const hintApplies = Boolean(
    hint &&
    !(hint.session_id && sessionId && hint.session_id !== sessionId) &&
    Array.isArray(hint.paths) && hint.paths.length > 0
  );

  if (!hintApplies) {
    // T32: no armed hint for this session — the mid-turn injection blind spot.
    // Consult the trigger-term index; a match self-arms the hint and denies.
    const match = fallbackCheck(input, sessionId);
    if (match) { deny(composeFallbackReason(match)); return; }
    allow();
    return;
  }

  const list = hint.paths.map((p) => `  - ${p}`).join('\n');
  // T32: a fallback-armed window says so — "surfaced in recall" would be a lie
  // when the whole point is that no recall pass ran.
  const armedVia = hint.source === 'trigger_fallback'
    ? `A canonical source-of-truth path is on record for "${hint.entity}" (T32 trigger-term fallback — no recall pass needed):`
    : `A canonical source-of-truth path was just surfaced in recall for "${hint.entity}":`;
  deny(
    `BLOCKED by the canonical-path guard (KOPENG feedback #4506).\n\n` +
    `${armedVia}\n${list}\n\n` +
    `That path OUTRANKS web search and your own/training knowledge. READ it first — do not ` +
    `WebSearch the name and do not ask the operator to disambiguate; the surfaced memory already did.\n\n` +
    `This block clears automatically the moment you Read/Glob/Grep that path (or after 5 minutes). ` +
    `If you have genuinely already engaged with the path and still need the web, re-run after touching it.`
  );
}

main();
