/**
 * Canonical trigger-term index — shared by the recall hook (builder/writer) and
 * canonical-path-guard.mjs (reader/matcher). T32.
 * (No shebang: imported as an ESM module by the hook scripts and the unit suite.)
 *
 * WHY THIS EXISTS: repeated real-world name-collision incidents. The recall hook is
 * UserPromptSubmit-only, so a message injected MID-TURN (assistant mid-tool-call)
 * never runs recall → ~/.kopeng/hints/canonical_path.json never arms → the
 * WebSearch/WebFetch guard has nothing to enforce, and a healthy 1.0
 * Hard-Anchor canonical memory is ignored anyway.
 *
 * FIX SHAPE: the recall hook (which runs often, on every normal prompt) keeps a
 * small per-project cache of "canonical trigger terms" — memories that carry
 * metadata.trigger_terms AND source-of-truth phrasing AND an absolute path
 * (e.g. trigger_terms: ["acme"]). The guard consults ONLY this cache on
 * its hot path (one small JSON read + substring match, no network) and can deny
 * a WebSearch/WebFetch whose input contains a trigger term even when NO hint was
 * pre-armed — closing the mid-turn injection channel regardless of hook-event
 * coverage. Cache pattern mirrors the sequence cache (~/.kopeng/cache/…,
 * TTL + stale-while-revalidate on the writer side).
 *
 * FAIL-OPEN: every reader here returns null/[] on any parse/IO error — the
 * guard can fail to "search not blocked", never to "tools wedged".
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Shared canonical/critical detection machinery ──
// Single source of truth for these regexes since T32: memory-prompt-search.mjs
// imports them from here (it used to own private copies) so the arming side and
// the trigger-index builder can never drift.
export const SOT_RE = /\b(?:ALWAYS\s+refers?\s+to|canonical|source[-\s]of[-\s]truth|authoritative)\b/i;
export const ABS_PATH_RE = /(?:[A-Za-z]:\\[^\s"'`)\]]+|\/(?:Users|home|mnt|opt|etc|var|srv)\/[^\s"'`)\]]+)/g;
// T29: for the SOT-heuristic criticality path, the source-of-truth phrase must
// POINT AT a path — i.e. sit within this many chars of an absolute path.
export const SOT_PROXIMITY = 100;

/**
 * T29 (pure): true iff a source-of-truth phrase (SOT_RE) sits within `window`
 * chars of an absolute path — i.e. the memory declares THAT path as canonical,
 * rather than mentioning an SOT word incidentally somewhere far from any path.
 * Compares the gap between every SOT-match span and every path span (0 when
 * they overlap). No I/O. (Moved here from memory-prompt-search.mjs by T32 —
 * the trigger-index builder needs the same predicate to flag entries that also
 * qualify as T29 criticals.)
 */
export function sotNearPath(content, window = SOT_PROXIMITY) {
  // Clamp scan length so the hook budgets are self-contained: the
  // O(paths × sot-hits) proximity loop stays bounded even if a non-REST write
  // path ever lands content past the 50KB StoreSchema cap. 64KB is well above
  // any real memory; a referent within the first 64KB is what matters.
  const text = String(content || '').slice(0, 64 * 1024);
  const sotHits = [...text.matchAll(new RegExp(SOT_RE.source, 'gi'))].map((m) => [m.index, m.index + m[0].length]);
  if (sotHits.length === 0) return false;
  for (const pm of text.matchAll(ABS_PATH_RE)) {
    const pStart = pm.index;
    const pEnd = pStart + pm[0].length;
    for (const [sStart, sEnd] of sotHits) {
      const gap = pStart >= sEnd ? pStart - sEnd : (sStart >= pEnd ? sStart - pEnd : 0);
      if (gap <= window) return true;
    }
  }
  return false;
}

// ── Cache layout ──

const CACHE_DIR = process.env.KOPENG_CACHE_DIR || join(homedir(), '.kopeng', 'cache');
// Writer-side refresh cadence — mirrors the sequence cache (10 min TTL,
// stale-while-revalidate at 80%: the recall hook refetches once the cache is
// >8 min old, so an active session keeps it hot at near-zero marginal cost).
export const TRIGGER_CACHE_TTL_MS = 10 * 60 * 1000;
// Reader-side trust window — the GUARD accepts a cache this old. Deliberately
// generous: mid-turn injection only happens in an ACTIVE session, whose earlier
// UserPromptSubmit prompts refreshed the cache minutes ago; the long tail just
// means a stale-but-recent index still guards after a lunch break. Past this,
// treat as absent (fail-open — the normal armed-hint path still works).
export const TRIGGER_CACHE_GUARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// One deny-WINDOW per (session, entry) per this period: after a fallback deny
// self-arms the 5-min hint and that window closes (touched OR expired), the
// same term does not re-deny until the cooldown lapses — an unrelated-but-term-
// containing search is never blocked forever (T32 hard constraint).
export const TRIGGER_FALLBACK_COOLDOWN_MS = 30 * 60 * 1000;
// Terms shorter than this never match (substring false-positive guard).
export const MIN_TRIGGER_TERM_LEN = 3;
// Bound the index: trigger-term canonicals are rare; a cap
// keeps the guard's hot-path read O(small) even if the convention proliferates.
export const MAX_TRIGGER_ENTRIES = 50;

/** Per-project cache file (same safe-name convention as the sequence cache). */
export function triggerCachePath(projectScope) {
  const safe = String(projectScope || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  return join(CACHE_DIR, `canonical_triggers_${safe}.json`);
}

/** Memory rows carry metadata as a JSON string (SQLite) or object (PG jsonb). */
export function parseMemoryMetadata(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

/**
 * Pure: one memory row → one trigger-index entry, or null when it doesn't
 * qualify. Qualifies = metadata.trigger_terms is a non-empty string array
 * (terms ≥ MIN_TRIGGER_TERM_LEN after trim) AND the content carries
 * source-of-truth phrasing (SOT_RE) AND at least one absolute path
 * (ABS_PATH_RE) — the same machinery that arms the canonical hint, so the
 * fallback can never gate on anything the armed path wouldn't.
 */
export function extractTriggerEntry(memory) {
  if (!memory || typeof memory !== 'object') return null;
  const meta = parseMemoryMetadata(memory.metadata);
  const rawTerms = Array.isArray(meta.trigger_terms) ? meta.trigger_terms : [];
  const terms = [...new Set(
    rawTerms
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= MIN_TRIGGER_TERM_LEN)
  )];
  if (terms.length === 0) return null;

  const content = String(memory.content || '');
  if (!SOT_RE.test(content)) return null;
  const found = content.match(ABS_PATH_RE);
  if (!found) return null;
  const paths = [...new Set(found.map((p) => p.replace(/[).,;:]+$/, '')))]; // strip trailing punctuation (same as armCanonicalPathHint)
  if (paths.length === 0) return null;

  return {
    id: memory.id ?? null,
    scope: String(memory.scope || ''),
    type: String(memory.type || 'reference'),
    terms,
    paths,
    excerpt: content.slice(0, 100),
    // T32 (c): entries whose SOT phrasing points AT a path also qualify as T29
    // criticals — the guard arms the per-session critical file for these so the
    // turn gate enforces consultation even when the deny is the only surfacing.
    critical: sotNearPath(content),
  };
}

/** Pure: memory rows → bounded, deduped-by-id entry list. */
export function buildTriggerEntries(memories, cap = MAX_TRIGGER_ENTRIES) {
  const entries = [];
  const seen = new Set();
  for (const m of Array.isArray(memories) ? memories : []) {
    const entry = extractTriggerEntry(m);
    if (!entry) continue;
    const key = entry.id ?? `x:${entry.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= cap) break;
  }
  return entries;
}

/**
 * Writer (recall hook). An EMPTY entries list is still written — fetched_at is
 * the refresh watermark, so "checked, nothing qualifies" doesn't refetch every
 * prompt. Fail-silent boolean.
 */
export function writeTriggerCache(projectScope, entries) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(
      triggerCachePath(projectScope),
      JSON.stringify({ fetched_at: new Date().toISOString(), project: projectScope, entries }),
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Reader. Returns { fetched_at, entries } or null (missing / corrupt / stale /
 * malformed ⇒ null — the guard fails open, the writer treats null as
 * refresh-due). Entries are shape-checked individually so one malformed entry
 * can't poison the rest.
 */
export function readTriggerCache(projectScope, maxAgeMs = TRIGGER_CACHE_GUARD_MAX_AGE_MS) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(triggerCachePath(projectScope), 'utf-8'));
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null;
  const age = Date.now() - new Date(parsed.fetched_at || 0).getTime();
  if (!(age >= 0 && age < maxAgeMs)) return null;
  const entries = parsed.entries.filter((e) =>
    e && typeof e === 'object' &&
    Array.isArray(e.terms) && e.terms.every((t) => typeof t === 'string') &&
    Array.isArray(e.paths) && e.paths.length > 0
  );
  return { fetched_at: parsed.fetched_at, entries };
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Pure: first entry whose trigger term appears (word-boundary, case-insensitive)
 * in `text`, honoring scope (global entries match everywhere; project entries
 * only in their own project). Returns { entry, term } or null. Word-boundary =
 * non-alphanumeric on both sides, so a term like "acme" matches `"query":"skin like Acme UI"`
 * but never "acmeco".
 */
export function matchTrigger(entries, text, projectScope) {
  const hay = String(text || '');
  if (!hay) return null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.scope !== 'global' && entry.scope !== projectScope) continue;
    for (const term of entry.terms) {
      if (typeof term !== 'string' || term.length < MIN_TRIGGER_TERM_LEN) continue;
      const re = new RegExp(`(?:^|[^a-z0-9_])${term.replace(RE_ESCAPE, '\\$&')}(?:[^a-z0-9_]|$)`, 'i');
      if (re.test(hay)) return { entry, term };
    }
  }
  return null;
}
