import { describe, it, expect } from 'vitest';
import {
  type AnchorRow,
  parseTs,
  demoteTarget,
  isD1Candidate,
  isD3Candidate,
  buildReport,
  D1_TARGET,
  D3_TARGET,
} from '../../scripts/lib/anchor-triage.js';

const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const DAY = 86_400_000;

function row(over: Partial<AnchorRow>): AnchorRow {
  return {
    id: 1,
    scope: 'project:foo',
    type: 'project',
    source: null,
    confidence: 1.0,
    last_seen: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    is_locked: 0,
    ...over,
  };
}

describe('parseTs — handles both API ISO and SQLite tz-less formats', () => {
  it('parses ISO-8601 with Z (REST API shape)', () => {
    expect(parseTs('2026-07-10T09:00:18.754Z')).toBe(Date.parse('2026-07-10T09:00:18.754Z'));
  });

  it('parses SQLite YYYY-MM-DD HH:MM:SS as UTC (not local)', () => {
    // Must equal the same instant as the explicit-Z ISO form — proves we do NOT
    // let V8 misread the tz-less string as local time.
    expect(parseTs('2026-07-10 09:00:18')).toBe(Date.parse('2026-07-10T09:00:18Z'));
  });
});

describe('D1 — legacy claude-tool catalog rows', () => {
  it('flags a claude-tool row above 0.55', () => {
    expect(isD1Candidate(row({ scope: 'client:claude-tool', confidence: 1.0 }))).toBe(true);
    expect(demoteTarget(row({ scope: 'client:claude-tool', confidence: 1.0 }), NOW, 30)).toBe(D1_TARGET);
  });

  it('leaves an already-0.55 catalog row alone (correct end state)', () => {
    expect(isD1Candidate(row({ scope: 'client:claude-tool', confidence: 0.55 }))).toBe(false);
  });
});

describe('D3 — aged project/reference anchors', () => {
  it('flags an aged project anchor (>= aged-days old, conf 1.0)', () => {
    const r = row({ type: 'project', confidence: 1.0, last_seen: '2026-05-01T00:00:00.000Z' });
    expect(isD3Candidate(r, NOW, 30)).toBe(true);
    expect(demoteTarget(r, NOW, 30)).toBe(D3_TARGET);
  });

  it('does NOT flag a recently-seen anchor', () => {
    const recent = new Date(NOW - 5 * DAY).toISOString();
    expect(isD3Candidate(row({ type: 'reference', confidence: 1.0, last_seen: recent }), NOW, 30)).toBe(false);
  });

  it('does NOT flag confidence below the anchor threshold', () => {
    expect(isD3Candidate(row({ type: 'project', confidence: 0.9, last_seen: '2026-01-01T00:00:00.000Z' }), NOW, 30)).toBe(false);
  });

  it('respects is_locked (deliberate anchor kept)', () => {
    const r = row({ type: 'project', confidence: 1.0, is_locked: 1, last_seen: '2026-01-01T00:00:00.000Z' });
    expect(isD3Candidate(r, NOW, 30)).toBe(false);
    expect(demoteTarget(r, NOW, 30)).toBeNull();
  });

  it('leaves user/feedback untouched (D3 excludes them)', () => {
    expect(demoteTarget(row({ type: 'user', confidence: 1.0, last_seen: '2026-01-01T00:00:00.000Z' }), NOW, 30)).toBeNull();
    expect(demoteTarget(row({ type: 'feedback', confidence: 1.0, last_seen: '2026-01-01T00:00:00.000Z' }), NOW, 30)).toBeNull();
  });

  it('uses updated_at/created_at when last_seen is null', () => {
    const r = row({ type: 'reference', confidence: 1.0, last_seen: null, updated_at: '2026-01-01T00:00:00.000Z' });
    expect(isD3Candidate(r, NOW, 30)).toBe(true);
  });
});

describe('D1 precedence over D3', () => {
  it('a claude-tool project anchor demotes to 0.55, counted once', () => {
    // Contrived: claude-tool scope + project type + aged + 1.0 — matches both,
    // but D1 wins so it becomes 0.55 (never double-counted as a 0.9 D3).
    const r = row({ scope: 'client:claude-tool', type: 'project', confidence: 1.0, last_seen: '2026-01-01T00:00:00.000Z' });
    expect(demoteTarget(r, NOW, 30)).toBe(D1_TARGET);
    const rep = buildReport([r], NOW, 30, 'test');
    expect(rep.d1_candidates).toBe(1);
    expect(rep.d3_candidates).toBe(0);
  });
});

describe('buildReport', () => {
  it('counts candidates and segments without double-counting', () => {
    const rows = [
      row({ id: 1, scope: 'client:claude-tool', type: 'reference', confidence: 1.0 }), // D1
      row({ id: 2, type: 'project', confidence: 1.0, last_seen: '2026-01-01T00:00:00.000Z' }), // D3
      row({ id: 3, type: 'user', confidence: 1.0, last_seen: '2026-01-01T00:00:00.000Z' }), // untouched
      row({ id: 4, type: 'project', confidence: 0.6, last_seen: '2026-01-01T00:00:00.000Z' }), // not anchor
    ];
    const rep = buildReport(rows, NOW, 30, 'test');
    expect(rep.active_memory_count).toBe(4);
    expect(rep.d1_candidates).toBe(1);
    expect(rep.d3_candidates).toBe(1);
  });
});
