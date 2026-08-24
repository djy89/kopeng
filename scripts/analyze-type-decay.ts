/**
 * T30 Phase 0 — type-tuned decay corpus validation (READ-ONLY, no mutation).
 *
 * Models how the PROPOSED per-type decay half-lives (t30-type-tuned-decay-plan
 * §3.1) would reshape the LIVE corpus versus today's single global 60-day
 * curve — so the half-life table + floor values are tuned from real numbers
 * before any of it ships (T30.1+). Pure analysis: fetches the corpus over the
 * REST API, computes effective confidence with the exact production math
 * (`durabilityFactor` from confidence.ts), and reports per class. Writes nothing.
 *
 * Usage:
 *   npm run analyze:type-decay -- --url http://localhost:3200
 *   npm run analyze:type-decay -- --url http://localhost:3200 --out scratch/type-decay.json
 *   (--url defaults to $MEMORY_API_URL, else http://localhost:3200)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { durabilityFactor, DECAY_ARCHIVE_THRESHOLD } from '../src/discovery/confidence.js';
import { parseTs } from './lib/anchor-triage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PAGE_LIMIT = 1000;
const CURRENT_HL = 60; // today's global DECAY_HALF_LIFE_DAYS
const ARCHIVE = DECAY_ARCHIVE_THRESHOLD; // the shared archive line
const FLOOR = 0.4; // proposed reference/structural floor
const ANCHOR = 1.0;
const DAY = 86_400_000;

// Proposed per-type half-lives (days) — the knob this script exists to tune.
type DecayClass = 'error' | 'discovery' | 'project' | 'reference' | 'feedback' | 'user' | 'other';
const PROPOSED_HL: Record<DecayClass, number | null> = {
  error: 11,
  discovery: 25,
  project: 45,
  reference: 38,
  feedback: 90,
  user: null, // ~always anchors; excluded from decay modelling
  other: 60,
};

interface Row {
  type: string;
  tags: string[];
  confidence: number;
  last_seen: string | null;
  updated_at: string;
  observation_count: number | null;
  is_locked: number;
}

function parseArgs(): { url: string; outPath: string | null } {
  const argv = process.argv.slice(2);
  let url = process.env.MEMORY_API_URL || 'http://localhost:3200';
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) url = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) outPath = argv[++i];
  }
  return { url: url.replace(/\/$/, ''), outPath };
}

function isErrorTagged(tags: string[]): boolean {
  return tags.some((t) => /^error/.test(t) || t === 'recurring_error' || t === 'error-pattern');
}

function isStructuralTagged(tags: string[]): boolean {
  return tags.some((t) => t === 'structural' || t === 'canonical');
}

function classify(r: Row): DecayClass {
  if (r.type === 'discovery') return isErrorTagged(r.tags) ? 'error' : 'discovery';
  if (r.type === 'project' || r.type === 'reference' || r.type === 'feedback' || r.type === 'user') return r.type;
  return 'other';
}

/** Effective confidence under an arbitrary half-life — the production formula. */
function effAt(r: Row, ageDays: number, halfLife: number): number {
  if (r.confidence >= ANCHOR) return ANCHOR;
  if (ageDays <= 0) return r.confidence;
  const effDays = ageDays / durabilityFactor(r.observation_count ?? 1);
  return r.confidence * Math.pow(0.5, effDays / halfLife);
}

async function fetchAll(baseUrl: string): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: number | undefined;
  for (;;) {
    const u = new URL('/api/memories', baseUrl);
    u.searchParams.set('fields', 'lite');
    u.searchParams.set('include_archived', 'false');
    u.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor !== undefined) u.searchParams.set('cursor', String(cursor));
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`GET /api/memories failed (${res.status})`);
    const env = (await res.json()) as { data?: Record<string, unknown>[]; meta?: { has_more?: boolean; cursor?: number } };
    const data = env.data ?? [];
    for (const m of data) {
      rows.push({
        type: String(m.type),
        tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
        confidence: Number(m.confidence),
        last_seen: (m.last_seen as string | null) ?? null,
        updated_at: String(m.updated_at),
        observation_count: m.observation_count == null ? null : Number(m.observation_count),
        is_locked: Number(m.is_locked) === 1 ? 1 : 0,
      });
    }
    process.stdout.write(`\r  fetched ${rows.length}...`);
    if (!env.meta?.has_more || data.length === 0 || env.meta.cursor === undefined) break;
    cursor = env.meta.cursor;
  }
  process.stdout.write('\n');
  return rows;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

interface ClassStat {
  cls: DecayClass;
  proposed_hl: number | null;
  n_total: number;
  n_anchored: number; // conf >= 1.0
  n_locked: number;
  n_eligible: number; // decay-eligible: conf < 1.0 && !locked
  age_p50: number;
  age_p90: number;
  cur_mean_eff: number;
  cur_under_archive: number; // current 60d curve
  prop_mean_eff: number;
  prop_under_archive: number; // proposed per-type curve
  prop_under_floor: number; // eligible rows the 0.4 floor would rescue
}

function analyze(rows: Row[], nowMs: number): ClassStat[] {
  const byClass = new Map<DecayClass, Row[]>();
  for (const r of rows) {
    const c = classify(r);
    (byClass.get(c) ?? byClass.set(c, []).get(c)!).push(r);
  }
  const stats: ClassStat[] = [];
  for (const [cls, rs] of byClass) {
    const hl = PROPOSED_HL[cls];
    const anchored = rs.filter((r) => r.confidence >= ANCHOR).length;
    const locked = rs.filter((r) => r.is_locked === 1 && r.confidence < ANCHOR).length;
    const eligible = rs.filter((r) => r.confidence < ANCHOR && r.is_locked === 0);
    const ages = eligible.map((r) => Math.max(0, (nowMs - parseTs(r.last_seen ?? r.updated_at)) / DAY));
    const curEff = eligible.map((r, i) => effAt(r, ages[i], CURRENT_HL));
    const propEff = eligible.map((r, i) => effAt(r, ages[i], hl ?? CURRENT_HL));
    const isFloored = (r: Row) => r.type === 'reference' || isStructuralTagged(r.tags);
    stats.push({
      cls,
      proposed_hl: hl,
      n_total: rs.length,
      n_anchored: anchored,
      n_locked: locked,
      n_eligible: eligible.length,
      age_p50: Math.round(pct(ages, 50)),
      age_p90: Math.round(pct(ages, 90)),
      cur_mean_eff: curEff.length ? curEff.reduce((a, b) => a + b, 0) / curEff.length : 0,
      cur_under_archive: curEff.filter((e) => e < ARCHIVE).length,
      prop_mean_eff: propEff.length ? propEff.reduce((a, b) => a + b, 0) / propEff.length : 0,
      prop_under_archive: propEff.filter((e) => e < ARCHIVE).length,
      prop_under_floor: eligible.filter((r, i) => isFloored(r) && propEff[i] < FLOOR).length,
    });
  }
  return stats.sort((a, b) => b.n_eligible - a.n_eligible);
}

function print(stats: ClassStat[]): void {
  console.log(`\nType-tuned decay — corpus model (READ-ONLY; current global HL=${CURRENT_HL}d, floor=${FLOOR})\n`);
  console.log(
    `  ${'class'.padEnd(10)} ${'HL'.padEnd(5)} ${'total'.padEnd(6)} ${'anchor'.padEnd(7)} ${'elig'.padEnd(6)} ${'age50'.padEnd(6)} ${'age90'.padEnd(6)} ${'cur<0.2'.padEnd(8)} ${'new<0.2'.padEnd(8)} ${'curEff'.padEnd(7)} ${'newEff'.padEnd(7)} ${'floor+'.padEnd(6)}`,
  );
  console.log(`  ${'-'.repeat(96)}`);
  for (const s of stats) {
    console.log(
      `  ${s.cls.padEnd(10)} ${String(s.proposed_hl ?? '—').padEnd(5)} ${String(s.n_total).padEnd(6)} ${String(s.n_anchored).padEnd(7)} ` +
        `${String(s.n_eligible).padEnd(6)} ${String(s.age_p50).padEnd(6)} ${String(s.age_p90).padEnd(6)} ` +
        `${String(s.cur_under_archive).padEnd(8)} ${String(s.prop_under_archive).padEnd(8)} ` +
        `${s.cur_mean_eff.toFixed(3).padEnd(7)} ${s.prop_mean_eff.toFixed(3).padEnd(7)} ${String(s.prop_under_floor).padEnd(6)}`,
    );
  }
  const totElig = stats.reduce((a, s) => a + s.n_eligible, 0);
  const totCur = stats.reduce((a, s) => a + s.cur_under_archive, 0);
  const totProp = stats.reduce((a, s) => a + s.prop_under_archive, 0);
  const totFloor = stats.reduce((a, s) => a + s.prop_under_floor, 0);
  console.log(`\n  Legend: HL=proposed half-life(d); elig=decay-eligible (conf<1.0, unlocked);`);
  console.log(`          cur/new<0.2 = rows below the 0.2 archive line under current 60d vs proposed HL;`);
  console.log(`          curEff/newEff = mean effective confidence; floor+ = floored rows the 0.4 floor rescues.`);
  console.log(`\n  TOTALS: eligible=${totElig}  under-archive: current=${totCur} → proposed=${totProp}  (Δ=${totProp - totCur})  floor-rescued=${totFloor}\n`);
  console.log(`  ⚠ A large proposed>current under-archive delta = a first-ship archival wave (T30 risk §8);`);
  console.log(`    tune the half-lives (or stage the rollout) before T30.1 ships the table.\n`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const nowMs = Date.now();
  console.log(`\nT30 Phase-0 decay model — reading ${args.url} (no mutation)`);
  const rows = await fetchAll(args.url);
  const stats = analyze(rows, nowMs);
  print(stats);

  if (args.outPath) {
    const outPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date(nowMs).toISOString(), current_hl: CURRENT_HL, floor: FLOOR, proposed_hl: PROPOSED_HL, stats }, null, 2));
    console.log(`Report written to ${path.relative(projectRoot, outPath)}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
