/**
 * T29 turn gate + adherence metric.
 *
 * Covers the three-piece arm→touch→check gate the same way the canonical-path gate is
 * covered: pure functions in-process, plus the real turn-gate.mjs script driven as a
 * child process (Stop-hook JSON on stdin → decision on stdout) against isolated
 * KOPENG_HINTS_DIR / KOPENG_METRICS_DIR so nothing touches the operator's live state.
 *
 * The loop-safety property (block AT MOST ONCE per critical memory via the durable
 * `nudged` flag, independent of the undocumented stop_hook_active) is asserted both at
 * the pure-decision level (decideGate) and end-to-end (re-running the script allows).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = resolve(HERE, '../../scripts/hooks/turn-gate.mjs');

// Isolate all hook state to a temp dir BEFORE importing modules that capture the dir
// at load time (the observe hook reads KOPENG_HINTS_DIR into a const on import).
const tmp = mkdtempSync(join(tmpdir(), 'kopeng-t29-'));
const HINTS_DIR = join(tmp, 'hints');
const METRICS_DIR = join(tmp, 'metrics');
process.env.KOPENG_HINTS_DIR = HINTS_DIR;
process.env.KOPENG_METRICS_DIR = METRICS_DIR;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recallHook: any, observeHook: any, gate: any, metric: any;

beforeAll(async () => {
  mkdirSync(HINTS_DIR, { recursive: true });
  mkdirSync(METRICS_DIR, { recursive: true });
  recallHook = await import('../../scripts/hooks/memory-prompt-search.mjs');
  observeHook = await import('../../scripts/hooks/kopeng-observe.js');
  gate = await import('../../scripts/hooks/turn-gate.mjs');
  metric = await import('../../scripts/metric-adherence.ts');
});

// ── extractCriticalItems (recall-hook pure) ──────────────────────────────────

describe('extractCriticalItems', () => {
  it('picks a tagged-critical memory that carries an absolute path', () => {
    const items = recallHook.extractCriticalItems([
      { id: 1, type: 'feedback', tags: ['critical'], content: 'Deploy config lives at C:\\Users\\d\\app\\deploy.md — read it first.' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(1);
    expect(items[0].referents).toEqual(['C:\\Users\\d\\app\\deploy.md']);
  });

  it('picks a canonical source-of-truth memory (no tag) with a path', () => {
    const items = recallHook.extractCriticalItems([
      { id: 2, type: 'reference', tags: [], content: 'This ALWAYS refers to /Users/d/canon/spec.md as the authoritative source.' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].referents).toEqual(['/Users/d/canon/spec.md']);
  });

  it('excludes a critical memory with NO absolute path (v1 is path-anchored only)', () => {
    const items = recallHook.extractCriticalItems([
      { id: 3, type: 'feedback', tags: ['critical'], content: 'Always prefer pnpm over npm for this project.' },
    ]);
    expect(items).toHaveLength(0);
  });

  it('excludes a non-critical memory even if it has a path', () => {
    const items = recallHook.extractCriticalItems([
      { id: 4, type: 'project', tags: ['note'], content: 'We touched C:\\Users\\d\\app\\util.ts last week.' },
    ]);
    expect(items).toHaveLength(0);
  });

  it('dedups repeated referents within one memory', () => {
    const items = recallHook.extractCriticalItems([
      { id: 5, type: 'feedback', tags: ['critical'], content: 'See /Users/d/x.md and again /Users/d/x.md.' },
    ]);
    expect(items[0].referents).toEqual(['/Users/d/x.md']);
  });

  it('EXCLUDES an incidental SOT adjective far (>100 chars) from a path (id-420 regression)', () => {
    // Real false-block shape: "canonical" describes the artifacts the tool produces, NOT this
    // memory, and sits well past SOT_PROXIMITY before an unrelated tool-location path. Must not
    // hard-block. Fixture keeps a comfortable margin (>100) so a copy edit can't silently flip it.
    const content =
      '**Release Notes Compiler — reporting tool for tracked project milestones.** ' +
      'Multi-component tool that mines changelog entries and outputs two synchronized artifacts: ' +
      'scoped index memories (canonical, machine-retrievable) AND human-readable summary docs, a mirror ' +
      'for skim, share, and offline use across the whole release lifecycle from draft through publish. ' +
      'Tool location: C:\\Users\\d\\tools\\release-notes-compiler\\';
    // Guard the guard: assert the SOT→path gap the test relies on is genuinely > SOT_PROXIMITY,
    // so this regression can never quietly pass because the fixture drifted under the window.
    const canonicalEnd = content.indexOf('canonical') + 'canonical'.length;
    const pathStart = content.indexOf('C:\\Users');
    expect(pathStart - canonicalEnd).toBeGreaterThan(100);
    const items = recallHook.extractCriticalItems([
      { id: 420, type: 'reference', tags: [], content },
    ]);
    expect(items).toHaveLength(0);
  });

  it('INCLUDES the same memory once the SOT phrase is adjacent to the path (proximity boundary)', () => {
    const items = recallHook.extractCriticalItems([
      { id: 6, type: 'reference', tags: [], content: 'The canonical spec is C:\\Users\\d\\canon\\spec.md — read it.' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].referents).toEqual(['C:\\Users\\d\\canon\\spec.md']);
  });
});

describe('sotNearPath', () => {
  it('is true when a SOT phrase is adjacent to a path', () => {
    expect(recallHook.sotNearPath('This ALWAYS refers to /Users/d/canon/spec.md as authoritative.')).toBe(true);
  });
  it('is false when the only SOT word is far (>100 chars) from any path', () => {
    const far = 'memories are canonical here' + ' filler'.repeat(20) + ' and later C:\\Users\\d\\x.md';
    expect(recallHook.sotNearPath(far)).toBe(false);
  });
  it('is false with no SOT phrase at all', () => {
    expect(recallHook.sotNearPath('Just a note about C:\\Users\\d\\util.ts, nothing special.')).toBe(false);
  });
  it('clamps very long content and still finds an in-window pair inside the first 64KB', () => {
    const near = 'canonical spec: C:\\Users\\d\\a.md ' + 'x'.repeat(200 * 1024);
    expect(recallHook.sotNearPath(near)).toBe(true);
  });
});

// ── armCriticalMemoriesHint: top-2 relevance gate + flag-preserving merge ─────
// The PR's second half (the .slice(0,2) gate) — exercised end-to-end against an
// isolated KOPENG_HINTS_DIR so nothing touches operator state.

describe('armCriticalMemoriesHint (top-2 slice + merge)', () => {
  const crit = (id: number, path: string) => ({ id, type: 'feedback', tags: ['critical'], content: `Deploy config at ${path} — read it first.` });
  const readHint = (session: string) => {
    const safe = session.replace(/[^A-Za-z0-9_-]/g, '') || 'nosession';
    return JSON.parse(readFileSync(join(HINTS_DIR, `critical_${safe}.json`), 'utf-8'));
  };

  it('arms ONLY the top-2 recall results (a rank-3 critical never arms)', () => {
    const S = 'sess-arm-top2';
    recallHook.armCriticalMemoriesHint(
      [crit(1, 'C:\\a\\1.md'), crit(2, 'C:\\a\\2.md'), crit(3, 'C:\\a\\3.md')],
      'project:kopeng', S,
    );
    expect(readHint(S).items.map((i: any) => i.id).sort()).toEqual([1, 2]);
  });

  it('preserves consulted/nudged of a prior critical that drops out of top-2', () => {
    const S = 'sess-arm-merge';
    // Turn 1: crit 1 and 2 arm.
    recallHook.armCriticalMemoriesHint([crit(1, 'C:\\a\\1.md'), crit(2, 'C:\\a\\2.md')], 'project:kopeng', S);
    // Simulate crit 1 having been blocked-then-consulted.
    const safe = S.replace(/[^A-Za-z0-9_-]/g, '');
    const file = join(HINTS_DIR, `critical_${safe}.json`);
    const h1 = JSON.parse(readFileSync(file, 'utf-8'));
    const one = h1.items.find((i: any) => i.id === 1);
    one.consulted = true; one.nudged = true;
    writeFileSync(file, JSON.stringify(h1));
    // Turn 2: crit 1 is now rank-3 (sliced out); two new criticals lead.
    recallHook.armCriticalMemoriesHint(
      [crit(4, 'C:\\a\\4.md'), crit(5, 'C:\\a\\5.md'), crit(1, 'C:\\a\\1.md')],
      'project:kopeng', S,
    );
    const h2 = readHint(S);
    const carried = h2.items.find((i: any) => i.id === 1);
    expect(carried).toBeTruthy();
    expect(carried.consulted).toBe(true);  // not lost, not reset
    expect(carried.nudged).toBe(true);
    expect(h2.items.map((i: any) => i.id).sort()).toEqual([1, 2, 4, 5]); // 4,5 added; 1,2 kept
  });
});

// ── referentTouched (observe-hook pure) ──────────────────────────────────────

describe('referentTouched', () => {
  it('matches a windows path with backslash/case normalization', () => {
    expect(observeHook.referentTouched('{"file_path":"C:\\\\Users\\\\D\\\\App\\\\Deploy.md"}', 'C:\\Users\\d\\app\\deploy.md')).toBe(true);
  });
  it('matches reading a file INSIDE a hinted directory', () => {
    expect(observeHook.referentTouched('C:/Users/d/canon/spec/section.md', 'C:/Users/d/canon/spec')).toBe(true);
  });
  it('does not match an unrelated input', () => {
    expect(observeHook.referentTouched('/Users/d/other/thing.md', '/Users/d/canon/spec.md')).toBe(false);
  });
  it('rejects a too-short referent (guards against trivial matches)', () => {
    expect(observeHook.referentTouched('anything at all', 'ab')).toBe(false);
  });
});

// ── markCriticalConsultedIfTouched (observe-hook IO) ─────────────────────────

describe('markCriticalConsultedIfTouched', () => {
  const SESSION = 'sess-observe-1';
  const file = () => join(HINTS_DIR, 'critical_sess-observe-1.json');

  beforeEach(() => {
    writeFileSync(file(), JSON.stringify({
      session_id: SESSION,
      project: 'project:kopeng',
      updated_at: new Date().toISOString(),
      items: [
        { id: 10, memory_type: 'feedback', referents: ['/Users/d/canon/a.md'], consulted: false, nudged: false },
        { id: 11, memory_type: 'reference', referents: ['/Users/d/canon/b.md'], consulted: false, nudged: false },
      ],
    }));
  });

  it('flips the matching item consulted and leaves others alone', () => {
    observeHook.markCriticalConsultedIfTouched('/Users/d/canon/a.md', 'project:kopeng', SESSION);
    const h = JSON.parse(readFileSync(file(), 'utf-8'));
    expect(h.items.find((i: any) => i.id === 10).consulted).toBe(true);
    expect(h.items.find((i: any) => i.id === 11).consulted).toBe(false);
  });

  it('is a no-op for a wrong-session hint (parallel-session isolation)', () => {
    observeHook.markCriticalConsultedIfTouched('/Users/d/canon/a.md', 'project:kopeng', 'some-other-session');
    const h = JSON.parse(readFileSync(file(), 'utf-8'));
    expect(h.items.find((i: any) => i.id === 10).consulted).toBe(false);
  });
});

// ── decideGate (turn-gate pure loop-safety) ──────────────────────────────────

describe('decideGate', () => {
  it('blocks when a critical is unconsulted and un-nudged', () => {
    const d = gate.decideGate([{ id: 1, consulted: false, nudged: false }], false);
    expect(d.block).toBe(true);
    expect(d.blockable.map((x: any) => x.id)).toEqual([1]);
  });
  it('allows when every critical is consulted', () => {
    expect(gate.decideGate([{ id: 1, consulted: true, nudged: false }], false).block).toBe(false);
  });
  it('does NOT re-block an already-nudged critical (durable loop guard)', () => {
    expect(gate.decideGate([{ id: 1, consulted: false, nudged: true }], false).block).toBe(false);
  });
  it('honors stop_hook_active as a backstop (never blocks on a continuation turn)', () => {
    expect(gate.decideGate([{ id: 1, consulted: false, nudged: false }], true).block).toBe(false);
  });
});

// ── turn-gate.mjs end-to-end (real Stop-hook contract) ───────────────────────

function runGate(stdinObj: unknown): string {
  return execFileSync(process.execPath, [GATE_SCRIPT], {
    input: JSON.stringify(stdinObj),
    env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_METRICS_DIR: METRICS_DIR },
    encoding: 'utf8',
  });
}

function armGate(session: string, items: unknown[]) {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, '') || 'nosession';
  writeFileSync(join(HINTS_DIR, `critical_${safe}.json`), JSON.stringify({
    session_id: session,
    project: 'project:kopeng',
    updated_at: new Date().toISOString(),
    items,
  }));
}

describe('turn-gate.mjs (end-to-end)', () => {
  it('allows (empty stdout) when no gate is armed for the session', () => {
    const out = runGate({ session_id: 'no-gate-session', hook_event_name: 'Stop' });
    expect(out.trim()).toBe('');
  });

  it('BLOCKS on an unconsulted critical, then nudges it so a re-run ALLOWS (one nudge max)', () => {
    const S = 'sess-e2e-block';
    armGate(S, [{ id: 20, memory_type: 'feedback', referents: ['/Users/d/canon/x.md'], excerpt: 'read x', consulted: false, nudged: false }]);

    const first = runGate({ session_id: S, hook_event_name: 'Stop' });
    const decision = JSON.parse(first);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('/Users/d/canon/x.md');

    // The item is now nudged in the hint file.
    const h = JSON.parse(readFileSync(join(HINTS_DIR, `critical_${S}.json`), 'utf-8'));
    expect(h.items[0].nudged).toBe(true);

    // Re-run with the same (still-unconsulted) state → no second block.
    const second = runGate({ session_id: S, hook_event_name: 'Stop' });
    expect(second.trim()).toBe('');
  });

  it('allows immediately when the critical was consulted', () => {
    const S = 'sess-e2e-consulted';
    armGate(S, [{ id: 21, memory_type: 'feedback', referents: ['/Users/d/canon/y.md'], consulted: true, nudged: false }]);
    expect(runGate({ session_id: S, hook_event_name: 'Stop' }).trim()).toBe('');
  });

  it('allows when stop_hook_active is true even with an unconsulted critical (backstop)', () => {
    const S = 'sess-e2e-active';
    armGate(S, [{ id: 22, memory_type: 'feedback', referents: ['/Users/d/canon/z.md'], consulted: false, nudged: false }]);
    expect(runGate({ session_id: S, hook_event_name: 'Stop', stop_hook_active: true }).trim()).toBe('');
  });

  it('fail-open: garbage stdin allows the stop', () => {
    const out = execFileSync(process.execPath, [GATE_SCRIPT], {
      input: 'not json at all',
      env: { ...process.env, KOPENG_HINTS_DIR: HINTS_DIR, KOPENG_METRICS_DIR: METRICS_DIR },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });

  it('writes adherence records to the metrics log', () => {
    const S = 'sess-e2e-metric';
    armGate(S, [{ id: 23, memory_type: 'feedback', referents: ['/Users/d/canon/m.md'], consulted: true, nudged: false }]);
    runGate({ session_id: S, hook_event_name: 'Stop' });
    const log = readFileSync(join(METRICS_DIR, 'adherence.jsonl'), 'utf-8');
    expect(log).toContain('sess-e2e-metric');
    expect(log).toContain('"memory_id":23');
  });
});

// ── metric collapse + report (pure) ──────────────────────────────────────────

describe('adherence metric', () => {
  it('collapses to the last record per (session, memory)', () => {
    const rows = [
      { ts: '2026-07-07T10:00:00Z', session_id: 's1', memory_id: 1, consulted: false, nudged: true },
      { ts: '2026-07-07T10:05:00Z', session_id: 's1', memory_id: 1, consulted: true, nudged: true },
    ] as any[];
    const collapsed = metric.collapseAdherence(rows);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].consulted).toBe(true);
  });

  it('classifies outcomes and counts the forced-inline win', () => {
    const rows = [
      { ts: 't', session_id: 's', memory_id: 1, memory_type: 'feedback', referents: [], consulted: true, nudged: false, blocked_this_turn: false },   // voluntary
      { ts: 't', session_id: 's', memory_id: 2, memory_type: 'feedback', referents: [], consulted: true, nudged: true, blocked_this_turn: false },     // forced-inline
      { ts: 't', session_id: 's', memory_id: 3, memory_type: 'reference', referents: [], consulted: false, nudged: true, blocked_this_turn: false },   // ignored
      { ts: 't', session_id: 's', memory_id: 4, memory_type: 'reference', referents: [], consulted: false, nudged: false, blocked_this_turn: false },  // open
    ] as any[];
    const report = metric.computeAdherenceReport(rows, null);
    expect(report.critical_items).toBe(4);
    expect(report.outcomes.voluntary).toBe(1);
    expect(report.outcomes['forced-inline']).toBe(1);
    expect(report.outcomes.ignored).toBe(1);
    expect(report.outcomes.open).toBe(1);
    // adherence rate = consulted(2) / resolvable(3, open excluded)
    expect(report.adherence_rate).toBeCloseTo(2 / 3, 5);
  });
});
