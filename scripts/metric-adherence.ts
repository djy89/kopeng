/**
 * T29 adherence metric — the causal "was critical memory actually consulted?" measure.
 *
 * Replaces the acceptance≠relevance problem the C1 surfacing metric is stuck on: instead
 * of "a surfaced item co-occurred with a later tool call", this measures whether a memory
 * the SYSTEM deemed critical was DEMONSTRABLY acted on before the turn ended — with a
 * near-ground-truth signal (the memory's path referent was touched by a real tool call).
 *
 * SOURCE: ~/.kopeng/metrics/adherence.jsonl — turn-gate.mjs appends one record per
 * critical item per Stop. `consulted` and `nudged` are MONOTONIC (never un-set), so the
 * LAST record per (session_id, memory_id) is the final outcome. We collapse to that.
 *
 * OUTCOMES per critical item:
 *   - voluntary        consulted && !nudged  — consulted without the gate ever blocking
 *   - forced-inline     consulted &&  nudged  — blocked, THEN consulted (the 7/20→20/20 win)
 *   - ignored           !consulted && nudged  — nudged once, still ignored (turn ended anyway)
 *   - open              !consulted && !nudged  — surfaced, not yet resolved (live/short session)
 *
 * adherence rate = consulted / (surfaced resolvable) — voluntary + forced over the total
 * that reached a terminal state. The forced-inline count is the headline: memories that
 * would have been ignored (~65% baseline) but weren't, because the gate held the turn.
 *
 * Usage:  npm run metric:adherence [-- --days N | --since ISO] [--json]
 *   --days N     relative window: only records from the last N days.
 *   --since ISO  absolute cutoff: only records at/after this ISO 8601 instant. Use to
 *                anchor the window past a known-bad pre-fix data point (e.g. the id-420
 *                false-block on 2026-07-08T07:55Z, fixed same day) so it stops skewing
 *                the rate. --since wins if both are given.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ADHERENCE_LOG = join(process.env.KOPENG_METRICS_DIR || join(homedir(), '.kopeng', 'metrics'), 'adherence.jsonl');

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdherenceRecord {
  ts: string;
  session_id: string;
  project: string;
  memory_id: number | null;
  memory_type: string;
  referents: string[];
  consulted: boolean;
  nudged: boolean;
  blocked_this_turn: boolean;
}

export type Outcome = 'voluntary' | 'forced-inline' | 'ignored' | 'open';

export interface AdherenceReport {
  window_days: number | null;
  records: number;
  critical_items: number;        // distinct (session, memory) pairs that reached us
  consulted: number;
  adherence_rate: number | null; // consulted / resolvable (excludes still-open)
  outcomes: Record<Outcome, number>;
  by_type: Record<string, { surfaced: number; consulted: number; forced: number; ignored: number }>;
  by_project: Record<string, { surfaced: number; consulted: number }>;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Collapse append-only records to the final state per (session_id, memory_id). */
export function collapseAdherence(records: AdherenceRecord[]): AdherenceRecord[] {
  const latest = new Map<string, AdherenceRecord>();
  for (const r of records) {
    const key = `${r.session_id}::${r.memory_id}`;
    const prev = latest.get(key);
    if (!prev || new Date(r.ts).getTime() >= new Date(prev.ts).getTime()) latest.set(key, r);
  }
  return [...latest.values()];
}

export function classifyOutcome(r: AdherenceRecord): Outcome {
  if (r.consulted && !r.nudged) return 'voluntary';
  if (r.consulted && r.nudged) return 'forced-inline';
  if (!r.consulted && r.nudged) return 'ignored';
  return 'open';
}

export function computeAdherenceReport(
  records: AdherenceRecord[],
  windowDays: number | null,
): AdherenceReport {
  const collapsed = collapseAdherence(records);
  const outcomes: Record<Outcome, number> = { voluntary: 0, 'forced-inline': 0, ignored: 0, open: 0 };
  const byType: AdherenceReport['by_type'] = {};
  const byProject: AdherenceReport['by_project'] = {};
  let consulted = 0;

  for (const r of collapsed) {
    const outcome = classifyOutcome(r);
    outcomes[outcome]++;
    if (r.consulted) consulted++;

    const t = r.memory_type || 'unknown';
    byType[t] ??= { surfaced: 0, consulted: 0, forced: 0, ignored: 0 };
    byType[t].surfaced++;
    if (r.consulted) byType[t].consulted++;
    if (outcome === 'forced-inline') byType[t].forced++;
    if (outcome === 'ignored') byType[t].ignored++;

    const p = r.project || 'unknown';
    byProject[p] ??= { surfaced: 0, consulted: 0 };
    byProject[p].surfaced++;
    if (r.consulted) byProject[p].consulted++;
  }

  // Adherence rate over items that reached a terminal state (exclude still-open).
  const resolvable = collapsed.length - outcomes.open;
  const adherenceRate = resolvable > 0 ? consulted / resolvable : null;

  return {
    window_days: windowDays,
    records: records.length,
    critical_items: collapsed.length,
    consulted,
    adherence_rate: adherenceRate,
    outcomes,
    by_type: byType,
    by_project: byProject,
  };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { days: number | null; since: string | null; json: boolean } {
  let days: number | null = null;
  let since: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]) || null;
    else if (argv[i] === '--since') since = argv[++i] ?? null;
    else if (argv[i] === '--json') json = true;
  }
  return { days, since, json };
}

function readRecords(cutoffMs: number | null): AdherenceRecord[] {
  let raw: string;
  try { raw = readFileSync(ADHERENCE_LOG, 'utf-8'); } catch { return []; }
  const out: AdherenceRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as AdherenceRecord;
      if (cutoffMs !== null && new Date(rec.ts).getTime() < cutoffMs) continue;
      out.push(rec);
    } catch { /* skip malformed */ }
  }
  return out;
}

function main(): void {
  const { days, since, json } = parseArgs(process.argv.slice(2));

  let cutoffMs: number | null;
  let windowLabel: string;
  if (since !== null) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) {
      console.error(`  Invalid --since timestamp: "${since}" (expected ISO 8601, e.g. 2026-07-08T08:00:00Z)`);
      process.exit(1);
    }
    cutoffMs = t;                    // --since wins over --days (absolute anchor)
    windowLabel = `since ${since}`;
  } else if (days !== null) {
    cutoffMs = Date.now() - days * 86_400_000;
    windowLabel = `last ${days}d`;
  } else {
    cutoffMs = null;
    windowLabel = 'all time';
  }

  const records = readRecords(cutoffMs);
  const report = computeAdherenceReport(records, days);

  if (json) {
    console.log(JSON.stringify({ ...report, window_since: since }, null, 2));
    return;
  }

  const pct = (v: number | null) => (v === null ? 'n/a (no basis)' : `${(v * 100).toFixed(1)}%`);
  console.log('\n  KOPENG · T29 turn-gate adherence metric');
  console.log(`  window: ${windowLabel}   log: ${ADHERENCE_LOG}\n`);
  if (report.critical_items === 0) {
    console.log('  No critical memories surfaced yet — nothing to measure.');
    console.log('  (A memory becomes critical when tagged `critical` or written as a canonical');
    console.log('   source-of-truth AND it carries an absolute path.)\n');
    return;
  }
  console.log(`  critical items surfaced (distinct session×memory) .. ${report.critical_items}`);
  console.log(`  consulted .......................................... ${report.consulted}`);
  console.log(`  adherence rate (of resolved) ....................... ${pct(report.adherence_rate)}\n`);
  console.log('  Outcomes:');
  console.log(`    voluntary     (consulted, no block) ...... ${report.outcomes.voluntary}`);
  console.log(`    forced-inline (blocked → consulted) ...... ${report.outcomes['forced-inline']}   ← the gate's win`);
  console.log(`    ignored       (nudged, still ignored) .... ${report.outcomes.ignored}`);
  console.log(`    open          (unresolved / live) ........ ${report.outcomes.open}\n`);
  console.log('  By memory type:');
  console.log('    type          surfaced  consulted  forced  ignored');
  console.log('    ────────────────────────────────────────────────────');
  for (const [t, c] of Object.entries(report.by_type).sort((a, b) => b[1].surfaced - a[1].surfaced)) {
    console.log(`    ${t.padEnd(12)} ${String(c.surfaced).padStart(8)} ${String(c.consulted).padStart(10)} ${String(c.forced).padStart(7)} ${String(c.ignored).padStart(8)}`);
  }
  console.log('');
  console.log('  Note: adherence here is a near-ground-truth signal (the memory\'s path referent');
  console.log('        was touched by a real tool call), not co-occurrence. forced-inline counts');
  console.log('        memories that would have been ignored but were consulted because the gate held.\n');
}

const isMain = process.argv[1]?.endsWith('metric-adherence.ts');
if (isMain) main();
