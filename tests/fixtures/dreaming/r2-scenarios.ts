/**
 * R2 fire/collapse scenarios for the D0.7 replay harness — these encode the
 * CORRECTED semantics from the 2026-06-09 Fable 5 review (R2), not the
 * pre-review "any dream collapses the day" meaning:
 *
 *   - a FAILED dream never collapses its window; later passes retry it,
 *     bounded by MAX_WINDOW_RETRIES;
 *   - windows are keyed per (operator, scope, mode) — scope A's dream must
 *     not starve scope B;
 *   - a manual trigger with an explicit window_key opens a fresh window even
 *     after the daily window collapsed.
 *
 * Each scenario runs against a single fresh store; all passes share the same
 * injected clock, so default-window passes land in the same local-day window.
 */
import { MAX_WINDOW_RETRIES } from '../../../src/dreaming/dream-engine.js';
import type { ReplayScenario, ScenarioPass } from '../../../src/dreaming/replay.js';

export const R2_SCENARIOS: ReplayScenario[] = [
  {
    name: 'failed-window-retry',
    description: 'A failed dream does not collapse the window: the next pass retries and completes; only the completed dream collapses.',
    passes: [
      { label: 'pass 1 (injected failure)', fail: true, expect: 'failed' },
      { label: 'pass 2 (retry of the same window)', expect: 'completed' },
      { label: 'pass 3 (after completion)', expect: 'collapsed' },
    ],
    expect_rows: 2, // one failed + one completed
  },
  {
    name: 'retry-budget-exhausted',
    description: `After 1 + MAX_WINDOW_RETRIES (${1 + MAX_WINDOW_RETRIES}) failed attempts the window collapses with no further rows — even for a pass that would succeed.`,
    passes: [
      ...Array.from({ length: 1 + MAX_WINDOW_RETRIES }, (_, i): ScenarioPass => ({
        label: `attempt ${i + 1} (injected failure)`,
        fail: true,
        expect: 'failed',
      })),
      { label: 'post-budget pass (would succeed)', expect: 'collapsed' },
    ],
    expect_rows: 1 + MAX_WINDOW_RETRIES, // only the failed rows
  },
  {
    name: 'per-scope-windows',
    description: 'Windows are per (operator, scope, mode): a completed dream in scope alpha must not collapse the same window for scope beta.',
    passes: [
      { label: 'scope alpha', scope: 'project:alpha', expect: 'completed' },
      { label: 'scope beta, same window', scope: 'project:beta', expect: 'completed' },
      { label: 'scope alpha again', scope: 'project:alpha', expect: 'collapsed' },
      { label: 'scope beta again', scope: 'project:beta', expect: 'collapsed' },
    ],
    expect_rows: 2, // one completed dream per scope
  },
  {
    name: 'manual-window-key-override',
    description: 'After the daily window collapses, a manual trigger with an explicit window_key runs a fresh pass.',
    passes: [
      { label: 'nightly pass', expect: 'completed' },
      { label: 'manual pass, same daily window', expect: 'collapsed' },
      { label: 'manual pass, explicit window_key', windowKey: 'replay-manual-1', expect: 'completed' },
    ],
    expect_rows: 2, // daily window + override window
  },
];
