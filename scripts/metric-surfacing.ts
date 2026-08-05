/**
 * C1.4 causal surfacing precision/acceptance metric (Chief of Staff).
 *
 * Causal upgrade over C0's unordered co-occurrence (metric-proactive-use.ts).
 *
 * JOIN:
 *   1. Suggestion log  ~/.kopeng/metrics/suggestions.jsonl  — records written by
 *      the recall hook on every prompt that surfaces anything, NOW enriched with
 *      per-suggestion `surfaced_items[]` (class/key/score/binding) from /api/surface.
 *   2. Per-session observations via GET /api/observations/by-session — ordered by
 *      id ASC (insertion order = chronological), each row carrying tool_name and
 *      started_at timestamp.
 *
 * CAUSAL RULE: a surfaced suggestion is "accepted" only when its matching
 * tool/skill is invoked AFTER the suggestion's surfacing timestamp (rec.ts)
 * within the same session.  An invocation that preceded the suggestion is NOT
 * counted (the ordering fix vs C0's unordered window).
 *
 * REPORTS:
 *   - Per-class acceptance (tool / skill / convention) + overall precision-proxy
 *   - Basis count (surfaced suggestions with a matching observation lookup)
 *   - Honest-limitation note: acceptance ≠ relevance (no label; a tool was
 *     needed but NOT surfaced doesn't count against precision).
 *
 * SERVER-DOWN GRACEFUL DEGRADE: when the observation API is unreachable, we
 * report suggestion-log-only stats (surfaced counts per class, no acceptance
 * rate) — same degraded behaviour as metric-proactive-use.ts.
 *
 * Usage:  npm run metric:surfacing [-- --days N] [--json] [--limit N]
 * Env:    KOPENG_API_URL (default http://localhost:3200)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const SUGGESTIONS_LOG = join(homedir(), '.kopeng', 'metrics', 'suggestions.jsonl');

// ── Types ──────────────────────────────────────────────────────────────────

/** One surfaced item from /api/surface, logged per suggestion record (C1.4). */
export interface SurfacedItem {
  class: 'tool' | 'skill' | 'convention';
  key: string;
  score: number;
  binding: 'hard' | 'advisory';
}

/** C0 + C1.4 suggestion record. surfaced_items is optional (back-compatible). */
export interface SuggestionRecord {
  ts: string;
  session_id: string;
  project: string;
  prompt_len: number;
  surfaced: {
    memories: number;
    tools: string[];
    error_hint: boolean;
    sequence_hint: boolean;
  };
  /** C1.4: present only when /api/surface returned items. */
  surfaced_items?: SurfacedItem[];
}

/** One observation row from GET /api/observations/by-session. */
export interface ObservationRow {
  id: number;
  session_id: string;
  tool_name: string;
  started_at: string;
  completed_at?: string | null;
  status?: string;
  input_summary?: string;
  output_summary?: string;
  project_scope?: string;
  event_type?: string;
  metadata?: string;
}

export type SurfaceClass = 'tool' | 'skill' | 'convention';

/** Per-class acceptance counters. */
export interface ClassAcceptance {
  surfaced: number;   // # suggestions surfaced in this class
  accepted: number;   // # accepted (invoked after suggestion timestamp, causal)
  rate: number | null;
}

export interface SurfacingReport {
  window_days: number | null;
  basis: number;               // sessions with surfaced_items that we could look up
  overall_accepted: number;
  overall_surfaced: number;
  overall_rate: number | null;
  per_class: Record<SurfaceClass, ClassAcceptance>;
  /** tool-class items structurally unmeasurable via mcp__ tool-name matching
   *  (CLI scripts, scheduled automations, plugin-namespaced MCP servers) —
   *  counted separately so they can't drag down the 'tool' precision number
   *  by construction. See NON_INVOKABLE_TOOL_KEYS. */
  tool_unmeasurable_surfaced: number;
  suggestion_log: {
    records: number;
    with_surfaced_items: number;
  };
  server_available: boolean;
}

/**
 * TOOLS_INDEX.md rows that describe something NOT invokable as an `mcp__*`
 * tool call: reusable CLI scripts/patterns, scheduled Task Scheduler
 * automations, or MCP servers namespaced by a plugin wrapper
 * (`mcp__plugin_<plugin>_<server>__*`) whose real server segment can't be
 * reliably recovered from the TOOLS_INDEX display name alone.
 *
 * Without this set, these keys are permanently unmatchable and silently
 * count as "surfaced but never accepted" — dragging the 'tool' class rate
 * down for reasons that have nothing to do with surfacing precision.
 * external_key suffixes, i.e. `tool:<suffix>` (post-slugify, see
 * scripts/sync-claude-indexes.ts `slugify()`).
 *
 * T35: the keys are OPERATOR data (they name the operator's personal
 * tools/automations), so they live in an untracked local file rather than
 * tracked source — `~/.kopeng/non-invokable-tools.json`, an object map of
 * `{ "<key-suffix>": "<why it cannot be invoked>" }` (the rationale is for
 * humans; only the keys are read). `KOPENG_NON_INVOKABLE_TOOLS` overrides the
 * path. Fail-soft: missing file → the empty shipped default; malformed file →
 * one warning + the default (the metric still runs).
 */
export const DEFAULT_NON_INVOKABLE_TOOL_KEYS: readonly string[] = [];

export function loadNonInvokableToolKeys(filePath?: string): Set<string> {
  const p = filePath
    ?? process.env.KOPENG_NON_INVOKABLE_TOOLS
    ?? join(homedir(), '.kopeng', 'non-invokable-tools.json');
  const keys = new Set(DEFAULT_NON_INVOKABLE_TOOL_KEYS);
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed)) keys.add(key);
    } else {
      console.warn(`  [warn] ${p}: expected an object map of key → rationale — ignoring it`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`  [warn] could not read ${p}: ${(err as Error).message} — continuing without local overrides`);
    }
  }
  return keys;
}

export const NON_INVOKABLE_TOOL_KEYS = loadNonInvokableToolKeys();

// ── Pure join / scoring function (exported for unit tests) ─────────────────

/**
 * Compute causal acceptance from suggestion records and per-session observations.
 *
 * Pure function — no I/O, no side effects.  Tested in metric-surfacing.test.ts.
 *
 * CAUSAL RULE: suggestion s (ts=T) for key K is ACCEPTED if there exists an
 * observation in the same session with tool_name matching K AND
 * started_at > T (strictly after the surfacing timestamp).
 *
 * Key matching: the observation tool_name is the raw Claude Code tool name
 * (e.g. "Skill", "mcp__memory__store_memory").  The surfaced item key is the
 * external key stored in KOPENG (e.g. "skill:handoff", "tool:kopeng").
 *
 * Match rule: a tool observation matches a surfaced item when:
 *   - class=skill  → tool_name === 'Skill' OR tool_name === 'Task' OR tool_name === 'Agent'
 *                    (the operator invokes skills via the Skill tool or Task/Agent)
 *   - class=tool   → tool_name.startsWith('mcp__') OR the key suffix matches
 *                    (e.g. key="tool:kopeng" → tool_name="mcp__memory__*")
 *   - class=convention → not directly measurable (conventions are FYI, no direct invocation)
 *                        so convention acceptance is NEVER counted (always 0 accepted).
 *
 * This is intentionally conservative: false negatives (the operator used a skill
 * but under a different tool name) keep the metric honest rather than inflated.
 */
export function computeAcceptance(
  suggestions: SuggestionRecord[],
  observationsBySession: Map<string, ObservationRow[]>,
): Omit<SurfacingReport, 'window_days' | 'suggestion_log' | 'server_available'> {
  const perClass: Record<SurfaceClass, ClassAcceptance> = {
    tool: { surfaced: 0, accepted: 0, rate: null },
    skill: { surfaced: 0, accepted: 0, rate: null },
    convention: { surfaced: 0, accepted: 0, rate: null },
  };

  let basis = 0;
  let overallSurfaced = 0;
  let overallAccepted = 0;
  let toolUnmeasurableSurfaced = 0;

  for (const rec of suggestions) {
    const items = rec.surfaced_items;
    if (!items || items.length === 0) continue;

    const sessionObs = observationsBySession.get(rec.session_id);
    if (!sessionObs) continue; // session not in observation log — skip (no basis)

    basis++;

    const surfacingTs = new Date(rec.ts).getTime();
    if (isNaN(surfacingTs)) continue;

    for (const item of items) {
      const cls = item.class as SurfaceClass;
      if (!perClass[cls]) continue;

      // Tool-class items that structurally can never be invoked via an
      // `mcp__*` tool call (CLI scripts, scheduled automations, unresolved
      // plugin-namespaced servers, or a legacy log row missing its real
      // external_key) — route out before touching perClass.tool so they
      // can't manufacture a false "surfaced but not accepted" miss.
      if (cls === 'tool') {
        const keySuffix = item.key.replace(/^tool:/, '');
        if (NON_INVOKABLE_TOOL_KEYS.has(keySuffix) || item.key.startsWith('unknown:')) {
          toolUnmeasurableSurfaced++;
          continue;
        }
      }

      perClass[cls].surfaced++;
      overallSurfaced++;

      // Conventions: not measurable via tool invocation.
      if (cls === 'convention') continue;

      // Find a matching observation AFTER the surfacing timestamp.
      const accepted = sessionObs.some(obs => {
        const obsTs = new Date(obs.started_at).getTime();
        if (isNaN(obsTs) || obsTs <= surfacingTs) return false; // must be AFTER
        return toolMatchesSurfacedItem(obs.tool_name, item);
      });

      if (accepted) {
        perClass[cls].accepted++;
        overallAccepted++;
      }
    }
  }

  // Compute per-class rates (null = no basis for that class).
  for (const cls of ['tool', 'skill', 'convention'] as SurfaceClass[]) {
    const c = perClass[cls];
    c.rate = c.surfaced > 0 ? c.accepted / c.surfaced : null;
  }

  const overallRate = overallSurfaced > 0 ? overallAccepted / overallSurfaced : null;

  return {
    basis,
    overall_accepted: overallAccepted,
    overall_surfaced: overallSurfaced,
    overall_rate: overallRate,
    per_class: perClass,
    tool_unmeasurable_surfaced: toolUnmeasurableSurfaced,
  };
}

/**
 * Check whether an observation's tool_name matches a surfaced item.
 * Exported for unit testing.
 */
export function toolMatchesSurfacedItem(toolName: string, item: SurfacedItem): boolean {
  if (item.class === 'skill') {
    // Skills are invoked via Skill, Task, or Agent tool calls.
    return toolName === 'Skill' || toolName === 'Task' || toolName === 'Agent';
  }
  if (item.class === 'tool') {
    // Tools are MCP tools — the key is "tool:<mcp-server-name>" (e.g. "tool:kopeng").
    // Match tool_name against mcp__ prefix, or by key suffix → mcp server name.
    if (toolName.startsWith('mcp__')) {
      // Extract server name from key (e.g. "tool:kopeng" → "kopeng")
      const keySuffix = item.key.replace(/^tool:/, '');
      // mcp__<server>__<method> — match server segment
      const serverSegment = toolName.split('__')[1] ?? '';
      if (keySuffix && serverSegment && serverSegment === keySuffix) return true;
      // Also match any mcp__ tool if the key is generic (tool:mcp or no suffix)
      if (!keySuffix || keySuffix === 'mcp') return true;
    }
    // Bounded historical reconciliation: KOPENG's own MCP tool was registered
    // under the client config key "memory" (never renamed for legacy-install
    // reasons) until 2026-07-22, when it was renamed to "kopeng" — matching
    // Codex's config, which already used "kopeng". Every suggestion surfaced
    // before that date logged the tool as "tool:kopeng", but the matching
    // observation's tool_name is permanently "mcp__memory__*" (immutable
    // historical record). This is NOT a general alias mechanism — it's a
    // one-time reconciliation of a rename that already happened, scoped to
    // exactly this tool's own identity.
    const keySuffix = item.key.replace(/^tool:/, '');
    if (keySuffix === 'kopeng' && toolName.startsWith('mcp__memory__')) {
      return true;
    }
    return false;
  }
  // convention: never matched
  return false;
}

// ── I/O helpers ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { days: number | null; json: boolean; limit: number } {
  let days: number | null = null;
  let json = false;
  let limit = 200;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]) || null;
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--limit') limit = Number(argv[++i]) || 200;
  }
  return { days, json, limit };
}

function readSuggestions(cutoffMs: number | null): SuggestionRecord[] {
  let raw: string;
  try { raw = readFileSync(SUGGESTIONS_LOG, 'utf-8'); } catch { return []; }
  const out: SuggestionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SuggestionRecord;
      if (cutoffMs !== null && new Date(rec.ts).getTime() < cutoffMs) continue;
      out.push(rec);
    } catch { /* skip malformed */ }
  }
  return out;
}

async function fetchObservationsBySession(
  sessionIds: string[],
  apiUrl: string,
): Promise<Map<string, ObservationRow[]>> {
  const map = new Map<string, ObservationRow[]>();
  // Fetch in parallel (bounded by session count; sessions with no obs are skipped).
  await Promise.allSettled(
    sessionIds.map(async id => {
      try {
        const res = await fetch(
          `${apiUrl}/api/observations/by-session?session_id=${encodeURIComponent(id)}&limit=5000`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) return;
        const json = await res.json() as { data?: ObservationRow[] };
        if (Array.isArray(json.data) && json.data.length > 0) {
          map.set(id, json.data);
        }
      } catch { /* skip — server down or no obs for this session */ }
    }),
  );
  return map;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { days, json, limit } = parseArgs(process.argv.slice(2));
  const cutoffMs = days !== null ? Date.now() - days * 86_400_000 : null;

  const suggestions = readSuggestions(cutoffMs);

  // Collect unique session ids that have surfaced_items (C1.4 records).
  const c14Sessions = new Set<string>();
  for (const r of suggestions) {
    if (r.surfaced_items && r.surfaced_items.length > 0 && r.session_id) {
      c14Sessions.add(r.session_id);
    }
  }

  // Fetch observations per session; gracefully degrade if server is down.
  let observationsBySession = new Map<string, ObservationRow[]>();
  let serverAvailable = false;

  const sessionIds = [...c14Sessions].slice(0, limit);
  if (sessionIds.length > 0) {
    try {
      observationsBySession = await fetchObservationsBySession(sessionIds, API_URL);
      serverAvailable = true;
    } catch (err) {
      console.error(`[metric:surfacing] could not reach observation API at ${API_URL}: ${(err as Error).message}`);
      console.error('  Is the KOPENG server running? Falling back to suggestion-log-only stats.');
    }
  }

  // Even if server is down, we still try (partial results are fine — each
  // fetchObservationsBySession per-session fetch handles its own errors).
  // Re-check actual availability from whether we got any data.
  if (observationsBySession.size > 0) serverAvailable = true;

  const computed = computeAcceptance(suggestions, observationsBySession);

  const report: SurfacingReport = {
    window_days: days,
    ...computed,
    suggestion_log: {
      records: suggestions.length,
      with_surfaced_items: suggestions.filter(r => r.surfaced_items && r.surfaced_items.length > 0).length,
    },
    server_available: serverAvailable,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pct = (v: number | null) => (v === null ? 'n/a (no basis)' : `${(v * 100).toFixed(1)}%`);
  console.log('\n  KOPENG · C1.4 causal surfacing precision metric');
  console.log(`  window: ${days === null ? 'all time' : `last ${days}d`}   api: ${API_URL}`);
  console.log(`  server: ${serverAvailable ? 'reachable' : 'unreachable (log-only mode)'}\n`);
  console.log('  Suggestion log:');
  console.log(`    records .......................... ${report.suggestion_log.records}`);
  console.log(`    records with surface items (C1.4) ${report.suggestion_log.with_surfaced_items}\n`);
  console.log('  Causal acceptance (tool/skill invoked AFTER surfacing timestamp):');
  console.log(`    per-class basis (sessions matched) ${report.basis}`);
  console.log('');
  console.log('    class        surfaced   accepted   rate');
  console.log('    ─────────────────────────────────────────');
  for (const cls of ['skill', 'tool', 'convention'] as SurfaceClass[]) {
    const c = report.per_class[cls];
    const note = cls === 'convention' ? ' (advisory, not directly measurable)' : '';
    console.log(`    ${cls.padEnd(12)} ${String(c.surfaced).padStart(8)}   ${String(c.accepted).padStart(8)}   ${pct(c.rate)}${note}`);
  }
  console.log('');
  console.log(`    overall      ${String(report.overall_surfaced).padStart(8)}   ${String(report.overall_accepted).padStart(8)}   ${pct(report.overall_rate)}`);
  if (report.tool_unmeasurable_surfaced > 0) {
    console.log(`    (excluded from 'tool' above: ${report.tool_unmeasurable_surfaced} surfaced instances of CLI scripts, scheduled automations, plugin-namespaced servers, or legacy no-external_key rows — structurally unmatchable via mcp__ tool-name, see NON_INVOKABLE_TOOL_KEYS)`);
  }
  console.log('');
  console.log('  Note: acceptance = tool/skill invoked after surfacing (causal, NOT just co-occurrence).');
  console.log('        Acceptance ≠ relevance — a surfaced item not invoked may still have been useful.');
  console.log('        Convention acceptance is not measured (advisory class, no direct invocation signal).');
  console.log('        C0 baseline (unordered co-occurrence): npm run metric:proactive\n');
}

// T35: exported loader is unit-tested (tests/unit/non-invokable-tools-loader.test.ts);
// the script stays a standalone CLI — main() runs only when invoked directly.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('[metric:surfacing] fatal:', err);
    process.exit(1);
  });
}
