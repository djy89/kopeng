/**
 * Unit tests for the C1.4 causal surfacing metric.
 *
 * Pure unit tests — NO network, NO server, NO filesystem reads.
 * All I/O-free: we import the exported pure functions (computeAcceptance,
 * toolMatchesSurfacedItem) and feed them inline fixtures.
 *
 * Hard gate for T13:
 *   - A fixture where the invocation PRECEDES the suggestion timestamp is NOT counted accepted.
 *   - Per-class acceptance computes correctly over a window.
 *   - Empty logs → graceful n/a (no basis).
 */

import { describe, it, expect } from 'vitest';
import {
  computeAcceptance,
  toolMatchesSurfacedItem,
  type SuggestionRecord,
  type ObservationRow,
  type SurfacedItem,
} from '../../scripts/metric-surfacing.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const SESSION_A = 'session-aaaa';
const SESSION_B = 'session-bbbb';
const SESSION_C = 'session-cccc';

/** Surfacing timestamp for all fixtures */
const T_SURFACE = '2026-06-20T10:00:00.000Z';
/** Before surfacing (should NOT count as accepted) */
const T_BEFORE  = '2026-06-20T09:59:00.000Z';
/** After surfacing (SHOULD count as accepted) */
const T_AFTER   = '2026-06-20T10:01:00.000Z';

function makeSuggestion(
  sessionId: string,
  items: SurfacedItem[],
  ts = T_SURFACE,
): SuggestionRecord {
  return {
    ts,
    session_id: sessionId,
    project: 'project:kopeng',
    prompt_len: 50,
    surfaced: { memories: 0, tools: [], error_hint: false, sequence_hint: false },
    surfaced_items: items,
  };
}

function makeObs(
  id: number,
  sessionId: string,
  toolName: string,
  startedAt: string,
): ObservationRow {
  return {
    id,
    session_id: sessionId,
    tool_name: toolName,
    started_at: startedAt,
  };
}

// ── toolMatchesSurfacedItem ────────────────────────────────────────────────

describe('toolMatchesSurfacedItem', () => {
  it('matches Skill tool to a skill surfaced item', () => {
    const item: SurfacedItem = { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' };
    expect(toolMatchesSurfacedItem('Skill', item)).toBe(true);
  });

  it('matches Task tool to a skill surfaced item', () => {
    const item: SurfacedItem = { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' };
    expect(toolMatchesSurfacedItem('Task', item)).toBe(true);
  });

  it('matches Agent tool to a skill surfaced item', () => {
    const item: SurfacedItem = { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' };
    expect(toolMatchesSurfacedItem('Agent', item)).toBe(true);
  });

  it('does NOT match a non-skill tool (e.g. Read) to a skill surfaced item', () => {
    const item: SurfacedItem = { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' };
    expect(toolMatchesSurfacedItem('Read', item)).toBe(false);
  });

  it('matches mcp__ tool by server segment to a tool surfaced item', () => {
    const item: SurfacedItem = { class: 'tool', key: 'tool:memory', score: 0.8, binding: 'hard' };
    expect(toolMatchesSurfacedItem('mcp__memory__store_memory', item)).toBe(true);
  });

  it('does NOT match mcp__other__ to a tool surfaced item with different server', () => {
    const item: SurfacedItem = { class: 'tool', key: 'tool:memory', score: 0.8, binding: 'hard' };
    expect(toolMatchesSurfacedItem('mcp__asana__create_task', item)).toBe(false);
  });

  it('does NOT match any tool to a convention surfaced item', () => {
    const item: SurfacedItem = { class: 'convention', key: 'convention:kopeng', score: 0.7, binding: 'advisory' };
    expect(toolMatchesSurfacedItem('Skill', item)).toBe(false);
    expect(toolMatchesSurfacedItem('mcp__memory__get_memory', item)).toBe(false);
    expect(toolMatchesSurfacedItem('Read', item)).toBe(false);
  });

  it('does NOT match a non-mcp tool to a tool surfaced item', () => {
    const item: SurfacedItem = { class: 'tool', key: 'tool:memory', score: 0.8, binding: 'hard' };
    expect(toolMatchesSurfacedItem('Read', item)).toBe(false);
    expect(toolMatchesSurfacedItem('Bash', item)).toBe(false);
  });
});

// ── computeAcceptance — empty inputs ──────────────────────────────────────

describe('computeAcceptance — empty inputs', () => {
  it('returns all-null rates and zero counts when suggestion log is empty', () => {
    const result = computeAcceptance([], new Map());
    expect(result.basis).toBe(0);
    expect(result.overall_surfaced).toBe(0);
    expect(result.overall_accepted).toBe(0);
    expect(result.overall_rate).toBeNull();
    expect(result.per_class.tool.rate).toBeNull();
    expect(result.per_class.skill.rate).toBeNull();
    expect(result.per_class.convention.rate).toBeNull();
  });

  it('returns n/a when suggestions exist but no observation sessions match', () => {
    const suggestions: SuggestionRecord[] = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ]),
    ];
    // No observations for SESSION_A
    const result = computeAcceptance(suggestions, new Map());
    expect(result.basis).toBe(0);
    expect(result.overall_rate).toBeNull();
  });

  it('ignores suggestion records without surfaced_items (old C0 records)', () => {
    // Old records have no surfaced_items — should be silently skipped
    const oldRecord: SuggestionRecord = {
      ts: T_SURFACE,
      session_id: SESSION_A,
      project: 'project:kopeng',
      prompt_len: 50,
      surfaced: { memories: 2, tools: ['some-tool'], error_hint: false, sequence_hint: false },
      // no surfaced_items
    };
    const result = computeAcceptance([oldRecord], new Map());
    expect(result.basis).toBe(0);
    expect(result.overall_rate).toBeNull();
  });

  it('ignores suggestion records with empty surfaced_items array', () => {
    const suggestions = [makeSuggestion(SESSION_A, [])];
    const obsMap = new Map([[SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]]]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.basis).toBe(0);
    expect(result.overall_rate).toBeNull();
  });
});

// ── THE HARD GATE: causal ordering ────────────────────────────────────────

describe('computeAcceptance — causal ordering (THE HARD GATE)', () => {
  /**
   * CAUSAL ORDERING PROOF:
   * A Skill invocation that PRECEDES the suggestion timestamp must NOT be counted
   * as accepted.  This is the fix vs C0's unordered co-occurrence.
   */
  it('does NOT count a Skill invocation that precedes the surfacing timestamp', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ], T_SURFACE),
    ];
    // The Skill invocation is BEFORE the surfacing timestamp
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_BEFORE)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.basis).toBe(1);
    expect(result.per_class.skill.surfaced).toBe(1);
    expect(result.per_class.skill.accepted).toBe(0); // ← must be 0 (causal ordering)
    expect(result.per_class.skill.rate).toBe(0);
    expect(result.overall_accepted).toBe(0);
    expect(result.overall_rate).toBe(0);
  });

  it('DOES count a Skill invocation that follows the surfacing timestamp', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ], T_SURFACE),
    ];
    // The Skill invocation is AFTER the surfacing timestamp
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.basis).toBe(1);
    expect(result.per_class.skill.accepted).toBe(1); // ← must be 1
    expect(result.per_class.skill.rate).toBe(1);
    expect(result.overall_accepted).toBe(1);
  });

  it('handles mixed: one before (not counted) and one after (counted) in same session', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ], T_SURFACE),
    ];
    // Two observations: one before, one after
    const obsMap = new Map([
      [SESSION_A, [
        makeObs(1, SESSION_A, 'Skill', T_BEFORE), // before — not counted
        makeObs(2, SESSION_A, 'Skill', T_AFTER),  // after — counted
      ]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.skill.accepted).toBe(1);
  });

  it('does NOT accept when invocation timestamp equals surfacing timestamp (strict after)', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ], T_SURFACE),
    ];
    // Invocation at exactly the same time — NOT after (strict >)
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_SURFACE)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.skill.accepted).toBe(0);
  });
});

// ── Per-class acceptance ───────────────────────────────────────────────────

describe('computeAcceptance — per-class acceptance', () => {
  it('counts skill acceptance correctly when Skill tool is invoked after surfacing', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ]),
    ];
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.skill.surfaced).toBe(1);
    expect(result.per_class.skill.accepted).toBe(1);
    expect(result.per_class.skill.rate).toBe(1);
    expect(result.per_class.tool.surfaced).toBe(0);
    expect(result.per_class.convention.surfaced).toBe(0);
  });

  it('counts tool acceptance correctly when matching mcp__ tool is invoked after surfacing', () => {
    const suggestions = [
      makeSuggestion(SESSION_B, [
        { class: 'tool', key: 'tool:memory', score: 0.85, binding: 'hard' },
      ]),
    ];
    const obsMap = new Map([
      [SESSION_B, [makeObs(2, SESSION_B, 'mcp__memory__store_memory', T_AFTER)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.tool.surfaced).toBe(1);
    expect(result.per_class.tool.accepted).toBe(1);
    expect(result.per_class.tool.rate).toBe(1);
  });

  it('convention items are surfaced-counted but never accepted', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'convention', key: 'convention:kopeng', score: 0.7, binding: 'advisory' },
      ]),
    ];
    // Even if Skill is invoked after — convention acceptance is 0
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.convention.surfaced).toBe(1);
    expect(result.per_class.convention.accepted).toBe(0);
    expect(result.per_class.convention.rate).toBe(0);
    // overall_surfaced counts conventions but they don't count toward accepted
    expect(result.overall_surfaced).toBe(1);
    expect(result.overall_accepted).toBe(0);
  });

  it('computes per-class acceptance independently over multiple sessions', () => {
    const suggestions = [
      // Session A: skill surfaced, Skill invoked after → accepted
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ]),
      // Session B: skill surfaced, only invoked BEFORE → NOT accepted
      makeSuggestion(SESSION_B, [
        { class: 'skill', key: 'skill:reflect', score: 0.8, binding: 'hard' },
      ]),
      // Session C: tool surfaced, matching tool invoked after → accepted
      makeSuggestion(SESSION_C, [
        { class: 'tool', key: 'tool:memory', score: 0.85, binding: 'hard' },
      ]),
    ];
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
      [SESSION_B, [makeObs(2, SESSION_B, 'Skill', T_BEFORE)]],  // precedes — not counted
      [SESSION_C, [makeObs(3, SESSION_C, 'mcp__memory__get_memory', T_AFTER)]],
    ]);

    const result = computeAcceptance(suggestions, obsMap);

    expect(result.basis).toBe(3); // 3 sessions had obs
    expect(result.per_class.skill.surfaced).toBe(2);
    expect(result.per_class.skill.accepted).toBe(1); // only SESSION_A
    expect(result.per_class.skill.rate).toBeCloseTo(0.5);
    expect(result.per_class.tool.surfaced).toBe(1);
    expect(result.per_class.tool.accepted).toBe(1);
    expect(result.per_class.tool.rate).toBe(1);
    expect(result.overall_surfaced).toBe(3);
    expect(result.overall_accepted).toBe(2);
    expect(result.overall_rate).toBeCloseTo(2 / 3);
  });

  it('handles multiple surfaced items in one session correctly', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
        { class: 'tool', key: 'tool:memory', score: 0.8, binding: 'hard' },
        { class: 'convention', key: 'convention:kopeng', score: 0.7, binding: 'advisory' },
      ]),
    ];
    const obsMap = new Map([
      [SESSION_A, [
        makeObs(1, SESSION_A, 'Skill', T_AFTER),                    // skill accepted
        makeObs(2, SESSION_A, 'mcp__memory__store_memory', T_AFTER), // tool accepted
      ]],
    ]);

    const result = computeAcceptance(suggestions, obsMap);

    expect(result.per_class.skill.accepted).toBe(1);
    expect(result.per_class.tool.accepted).toBe(1);
    expect(result.per_class.convention.accepted).toBe(0); // never
    expect(result.overall_accepted).toBe(2);
    expect(result.overall_surfaced).toBe(3);
  });

  it('rate is null for a class that has zero surfaced items', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ]),
    ];
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
    ]);
    const result = computeAcceptance(suggestions, obsMap);
    // tool and convention have 0 surfaced items → rate must be null
    expect(result.per_class.tool.rate).toBeNull();
    expect(result.per_class.convention.rate).toBeNull();
  });
});

// ── Back-compat: old C0 records without surfaced_items ────────────────────

describe('computeAcceptance — back-compat with old C0 records', () => {
  it('silently skips old records that have no surfaced_items field', () => {
    const oldRecord: SuggestionRecord = {
      ts: T_SURFACE,
      session_id: SESSION_A,
      project: 'project:kopeng',
      prompt_len: 60,
      surfaced: { memories: 3, tools: ['some-tool'], error_hint: false, sequence_hint: false },
      // no surfaced_items (C0 record)
    };
    const newRecord = makeSuggestion(SESSION_B, [
      { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
    ]);
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
      [SESSION_B, [makeObs(2, SESSION_B, 'Skill', T_AFTER)]],
    ]);

    const result = computeAcceptance([oldRecord, newRecord], obsMap);

    // Only SESSION_B contributes (has surfaced_items)
    expect(result.basis).toBe(1);
    expect(result.per_class.skill.surfaced).toBe(1);
    expect(result.per_class.skill.accepted).toBe(1);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('computeAcceptance — edge cases', () => {
  it('handles invalid surfacing timestamp gracefully (skips the record)', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ], 'not-a-date'),
    ];
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', T_AFTER)]],
    ]);
    // Invalid ts → NaN → record skipped; basis counts it but accepted is 0
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.skill.accepted).toBe(0);
  });

  it('handles invalid observation timestamp gracefully (obs not counted)', () => {
    const suggestions = [
      makeSuggestion(SESSION_A, [
        { class: 'skill', key: 'skill:handoff', score: 0.9, binding: 'hard' },
      ]),
    ];
    const obsMap = new Map([
      [SESSION_A, [makeObs(1, SESSION_A, 'Skill', 'bad-date')]],
    ]);
    // NaN timestamp → not after surfacing → not accepted
    const result = computeAcceptance(suggestions, obsMap);
    expect(result.per_class.skill.accepted).toBe(0);
  });

  it('basis is 0 when no suggestions have surfaced_items', () => {
    const suggestions: SuggestionRecord[] = [
      {
        ts: T_SURFACE, session_id: SESSION_A, project: 'project:kopeng', prompt_len: 50,
        surfaced: { memories: 0, tools: [], error_hint: false, sequence_hint: false },
      },
    ];
    const result = computeAcceptance(suggestions, new Map());
    expect(result.basis).toBe(0);
    expect(result.overall_rate).toBeNull();
  });
});
