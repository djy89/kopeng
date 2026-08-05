/**
 * C0 proactive-use metric (Chief of Staff, Phase 0 baseline).
 *
 * Joins two append-only logs to answer "are surfaced skills/tools actually used?":
 *   1. The suggestion log  ~/.kopeng/metrics/suggestions.jsonl  (the "suggestion" side,
 *      written by the recall hook memory-prompt-search.mjs on every prompt that surfaces
 *      anything) — keyed by session_id.
 *   2. The observation log (the "action" side) via the public REST endpoint
 *      GET /api/observations/sessions, which returns tool_names[] per session.
 *
 * Computes, over a recent window:
 *   - proactive-use rate    : sessions that invoked a bindable tool (Skill/Agent/MCP)
 *                             / sessions observed.
 *   - suggestion→action rate: of sessions where the hook surfaced a tool, the fraction
 *                             that also invoked a bindable tool (session-level co-occurrence).
 *
 * LIMITATION (honest, by design for the baseline): co-occurrence is session-level, not
 * causal — /api/observations/sessions gives an unordered tool_names[] per session, so we
 * can't prove the invocation followed the suggestion. CoS Phase 2 (learned surfacing)
 * upgrades this to ordered, outcome-tagged correlation. This number is the floor to beat.
 *
 * Usage:  npm run metric:proactive [-- --days N] [--json]
 * Env:    KOPENG_API_URL (default http://localhost:3200)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const SUGGESTIONS_LOG = join(homedir(), '.kopeng', 'metrics', 'suggestions.jsonl');

// Bindable = the tool classes the C0 rule is meant to drive proactively.
// Skill is the operator's sharpest pain; Agent (Task) and MCP tools round out the fleet.
function isBindableTool(name: string): boolean {
  return name === 'Skill' || name === 'Task' || name === 'Agent' || name.startsWith('mcp__');
}

interface SuggestionRecord {
  ts: string;
  session_id: string;
  project: string;
  prompt_len: number;
  surfaced: { memories: number; tools: string[]; error_hint: boolean; sequence_hint: boolean };
}

interface SessionRow {
  session_id: string;
  observation_count: number;
  started_at: string;
  ended_at: string;
  project_scopes: string[];
  tool_names: string[];
}

function parseArgs(argv: string[]): { days: number | null; json: boolean } {
  let days: number | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]) || null;
    else if (argv[i] === '--json') json = true;
  }
  return { days, json };
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

async function fetchSessions(): Promise<SessionRow[]> {
  const res = await fetch(`${API_URL}/api/observations/sessions?limit=200`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /api/observations/sessions → ${res.status}`);
  const json = await res.json() as { data?: SessionRow[] };
  return Array.isArray(json.data) ? json.data : [];
}

async function main() {
  const { days, json } = parseArgs(process.argv.slice(2));
  const cutoffMs = days !== null ? Date.now() - days * 86_400_000 : null;

  const suggestions = readSuggestions(cutoffMs);
  let sessions: SessionRow[];
  try {
    sessions = await fetchSessions();
  } catch (err) {
    console.error(`[metric:proactive] could not reach observation API at ${API_URL}: ${(err as Error).message}`);
    console.error('  Is the KOPENG server running? Falling back to suggestion-log-only stats.');
    sessions = [];
  }

  if (cutoffMs !== null) {
    sessions = sessions.filter(s => new Date(s.ended_at || s.started_at).getTime() >= cutoffMs);
  }

  // Index sessions by id; a session "acted" if it invoked any bindable tool.
  const actedSessions = new Set<string>();
  for (const s of sessions) {
    if ((s.tool_names || []).some(isBindableTool)) actedSessions.add(s.session_id);
  }

  // Sessions where the hook surfaced at least one tool suggestion.
  const surfacedSessions = new Set<string>();
  for (const r of suggestions) {
    if (r.surfaced?.tools?.length && r.session_id) surfacedSessions.add(r.session_id);
  }

  const observedCount = sessions.length;
  const proactiveCount = actedSessions.size;
  const proactiveRate = observedCount ? proactiveCount / observedCount : null;

  // suggestion→action: of surfaced sessions that we can also see in the observation
  // log, how many invoked a bindable tool.
  const observedIds = new Set(sessions.map(s => s.session_id));
  const surfacedAndObserved = [...surfacedSessions].filter(id => observedIds.has(id));
  const surfacedAndActed = surfacedAndObserved.filter(id => actedSessions.has(id));
  const suggestionToAction = surfacedAndObserved.length
    ? surfacedAndActed.length / surfacedAndObserved.length
    : null;

  const totalSurfacedTools = suggestions.reduce((n, r) => n + (r.surfaced?.tools?.length || 0), 0);

  const report = {
    window_days: days,
    suggestion_log: {
      records: suggestions.length,
      prompts_with_tool_suggestion: surfacedSessions.size === 0 ? 0 : suggestions.filter(r => r.surfaced?.tools?.length).length,
      total_tool_suggestions: totalSurfacedTools,
      sessions_with_suggestion: surfacedSessions.size,
    },
    observation_log: {
      sessions_observed: observedCount,
      sessions_with_bindable_tool: proactiveCount,
    },
    rates: {
      proactive_use_rate: proactiveRate,
      suggestion_to_action_rate: suggestionToAction,
      suggestion_to_action_basis: surfacedAndObserved.length,
    },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pct = (v: number | null) => (v === null ? 'n/a (no basis)' : `${(v * 100).toFixed(1)}%`);
  console.log('\n  KOPENG · C0 proactive-use baseline');
  console.log(`  window: ${days === null ? 'all time' : `last ${days}d`}   api: ${API_URL}\n`);
  console.log('  Suggestion side (recall hook):');
  console.log(`    suggestion-log records ............ ${report.suggestion_log.records}`);
  console.log(`    prompts surfacing a tool .......... ${report.suggestion_log.prompts_with_tool_suggestion}`);
  console.log(`    total tool suggestions ............ ${report.suggestion_log.total_tool_suggestions}`);
  console.log(`    distinct sessions w/ suggestion ... ${report.suggestion_log.sessions_with_suggestion}\n`);
  console.log('  Action side (observation log):');
  console.log(`    sessions observed ................. ${report.observation_log.sessions_observed}`);
  console.log(`    sessions invoking a bindable tool . ${report.observation_log.sessions_with_bindable_tool}\n`);
  console.log('  Rates:');
  console.log(`    proactive-use rate ................ ${pct(proactiveRate)}   (bindable-tool sessions / observed)`);
  console.log(`    suggestion→action rate ............ ${pct(suggestionToAction)}   (basis: ${surfacedAndObserved.length} surfaced+observed sessions)`);
  console.log('\n  Note: co-occurrence is session-level (baseline). CoS Phase 2 upgrades to causal.\n');
}

main().catch(err => {
  console.error('[metric:proactive] fatal:', err);
  process.exit(1);
});
