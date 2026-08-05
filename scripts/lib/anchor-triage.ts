/**
 * Anchor-triage core (F3 / T22 + T22b) — the SINGLE SOURCE OF TRUTH for the
 * D1/D3 segmentation + demote predicates, shared by both drivers so report and
 * apply can never drift:
 *
 *   - scripts/triage-anchors.ts       — SQLite offline copy (better-sqlite3)
 *   - scripts/triage-anchors-live.ts  — live corpus over the REST API (Postgres
 *                                        or SQLite; backend-agnostic)
 *
 * Locked decisions (2026-07-03):
 *   D1: legacy `client:claude-tool` catalog rows (conf > 0.55) → 0.55
 *   D3: aged `project`/`reference` anchors (conf >= 1.0)       → 0.9
 *       `user`/`feedback` are UNTOUCHED; `is_locked` deliberate anchors kept.
 *
 * D1 takes precedence over D3 (a claude-tool row is demoted once, to 0.55).
 */

// ── Locked decision targets ──
export const CLAUDE_TOOL_SCOPE = 'client:claude-tool';
export const D1_TARGET = 0.55; // legacy catalog rows
export const D3_TARGET = 0.9; // aged project/reference anchors
export const ANCHOR = 1.0; // Hard Anchor threshold
export const DEFAULT_AGED_DAYS = 30;

/** The minimal row shape both drivers project their records into. */
export interface AnchorRow {
  id: number;
  scope: string;
  type: string;
  source: string | null;
  confidence: number;
  last_seen: string | null;
  updated_at: string;
  created_at: string;
  is_locked: number; // 0 | 1
}

/** Confidence band label for the segmentation report. */
export function confBand(c: number): string {
  if (c >= ANCHOR) return 'anchor(>=1.0)';
  if (c >= 0.85) return 'high[0.85,1.0)';
  if (c > D1_TARGET) return 'mid(0.55,0.85)';
  if (c === D1_TARGET) return 'catalog(0.55)';
  return 'low(<0.55)';
}

/** Effective recency for aging: last_seen, else updated_at, else created_at. */
export function effectiveSeen(r: AnchorRow): string {
  return r.last_seen ?? r.updated_at ?? r.created_at;
}

/**
 * Parse a KOPENG timestamp to epoch-ms. Handles BOTH formats the two drivers
 * see: ISO-8601 with timezone from the REST API (`2026-07-10T09:00:18.754Z`)
 * and SQLite's tz-less `YYYY-MM-DD HH:MM:SS` (UTC — forced with a trailing Z so
 * V8 doesn't misread it as local time). NaN → treat as very old (Infinity).
 */
export function parseTs(s: string): number {
  // ISO-8601 already carries a timezone → parse directly.
  if (s.includes('T')) return Date.parse(s);
  // SQLite 'YYYY-MM-DD HH:MM:SS' is UTC without a tz marker → append Z.
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

export function ageDays(r: AnchorRow, nowMs: number): number {
  const t = parseTs(effectiveSeen(r));
  if (Number.isNaN(t)) return Infinity; // unparseable → treat as very old
  return (nowMs - t) / 86_400_000;
}

export function ageBand(days: number): string {
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 7) return '<7d';
  if (days < 30) return '7-30d';
  if (days < 90) return '30-90d';
  return '>90d';
}

// ── D1 / D3 candidate predicates ──

export function isD1Candidate(r: AnchorRow): boolean {
  // Legacy catalog rows: claude-tool scope sitting above the 0.55 catalog tier
  // (the old 1.0 anchors). Already-0.55 rows are the correct end state.
  return r.scope === CLAUDE_TOOL_SCOPE && r.confidence > D1_TARGET;
}

export function isD3Candidate(r: AnchorRow, nowMs: number, agedDays: number): boolean {
  // Aged project/reference anchors — accidental 1.0 (legacy default). user /
  // feedback stay at 1.0 (D3); deliberate is_locked anchors are respected.
  if (r.type !== 'project' && r.type !== 'reference') return false;
  if (r.is_locked === 1) return false;
  if (r.confidence < ANCHOR) return false;
  return ageDays(r, nowMs) >= agedDays;
}

/**
 * The demote target for a row, or null if it's not a candidate. Encapsulates
 * D1-over-D3 precedence so report counts and apply mutations agree by
 * construction.
 */
export function demoteTarget(r: AnchorRow, nowMs: number, agedDays: number): number | null {
  if (isD1Candidate(r)) return D1_TARGET;
  if (isD3Candidate(r, nowMs, agedDays)) return D3_TARGET;
  return null;
}

export interface SegmentReport {
  source: string; // db path or API url
  generated_at: string;
  aged_days: number;
  active_memory_count: number;
  by_segment: Array<{
    scope: string;
    type: string;
    source: string;
    confidence_band: string;
    age_band: string;
    count: number;
  }>;
  d1_candidates: number;
  d3_candidates: number;
}

export function buildReport(
  rows: AnchorRow[],
  nowMs: number,
  agedDays: number,
  sourceLabel: string,
): SegmentReport {
  const seg = new Map<string, SegmentReport['by_segment'][number]>();
  let d1 = 0;
  let d3 = 0;
  for (const r of rows) {
    const source = r.source ?? '(null)';
    const band = confBand(r.confidence);
    const aband = ageBand(ageDays(r, nowMs));
    const key = `${r.scope} ${r.type} ${source} ${band} ${aband}`;
    const cur = seg.get(key);
    if (cur) cur.count++;
    else seg.set(key, { scope: r.scope, type: r.type, source, confidence_band: band, age_band: aband, count: 1 });
    // Precedence identical to demoteTarget so a claude-tool row is counted once.
    const t = demoteTarget(r, nowMs, agedDays);
    if (t === D1_TARGET) d1++;
    else if (t === D3_TARGET) d3++;
  }
  const by_segment = [...seg.values()].sort(
    (a, b) => b.count - a.count || a.scope.localeCompare(b.scope) || a.type.localeCompare(b.type),
  );
  return {
    source: sourceLabel,
    generated_at: new Date(nowMs).toISOString(),
    aged_days: agedDays,
    active_memory_count: rows.length,
    by_segment,
    d1_candidates: d1,
    d3_candidates: d3,
  };
}

export function printReport(rep: SegmentReport): void {
  console.log(`\nAnchor triage — segmentation (dry-run, writes nothing)`);
  console.log(`  source:             ${rep.source}`);
  console.log(`  active memories:    ${rep.active_memory_count}`);
  console.log(`  aged threshold:     ${rep.aged_days}d (D3)`);
  console.log('');
  console.log(`  ${'scope'.padEnd(24)} ${'type'.padEnd(10)} ${'source'.padEnd(16)} ${'conf-band'.padEnd(16)} ${'age'.padEnd(7)} count`);
  console.log(`  ${'-'.repeat(24)} ${'-'.repeat(10)} ${'-'.repeat(16)} ${'-'.repeat(16)} ${'-'.repeat(7)} -----`);
  for (const s of rep.by_segment) {
    console.log(
      `  ${s.scope.slice(0, 24).padEnd(24)} ${s.type.slice(0, 10).padEnd(10)} ` +
        `${s.source.slice(0, 16).padEnd(16)} ${s.confidence_band.padEnd(16)} ${s.age_band.padEnd(7)} ${s.count}`,
    );
  }
  console.log('');
  console.log(`  D1 candidates (client:claude-tool > 0.55 → 0.55): ${rep.d1_candidates}`);
  console.log(`  D3 candidates (aged project/reference >= 1.0 → 0.9): ${rep.d3_candidates}`);
  console.log('');
}
