import { describe, it, expect } from 'vitest';
import { runDiscovery } from '../../src/discovery/discovery-engine.js';
import { createTestDatabase, createTestObservationsDb, createTestObservation } from '../fixtures/test-helpers.js';
import { config } from '../../src/config/config.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';

/** A zero-vector stub that always reports isReady = false — runDiscovery falls
 * back to always-create with no embed/dedup call, which is all this test needs. */
const notReadyIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

describe('runDiscovery — per-scope run counters (P10)', () => {
  it('does not let one scope in a pass inherit an earlier scope\'s created/reinforced counts', async () => {
    const { obsQueries } = createTestObservationsDb();
    const { queries } = createTestDatabase();

    // Scope A (project:alpha) — seeded FIRST so its observations get the lower
    // ids. A repeated-tool pattern: same tool+input, 3 distinct sessions —
    // fires the repeated_tool detector and creates a memory.
    for (let i = 0; i < 3; i++) {
      await obsQueries.storeObservation(createTestObservation({
        project_scope: 'project:alpha',
        session_id: `alpha-session-${i}`,
        tool_name: 'Bash',
        input_summary: 'npm test',
      }));
    }

    // Scope B (project:beta) — seeded SECOND (higher ids), a single
    // observation. No detector fires on n=1, so this scope must find zero
    // patterns and create/reinforce nothing of its own.
    await obsQueries.storeObservation(createTestObservation({
      project_scope: 'project:beta',
      session_id: 'beta-session-0',
      tool_name: 'Bash',
      input_summary: 'echo hello',
    }));

    await runDiscovery(obsQueries, queries, notReadyIndex, { config: config.discovery });

    const betaRuns = await obsQueries.listDiscoveryRuns('project:beta', 5);
    expect(betaRuns).toHaveLength(1);
    const betaRun = betaRuns[0];

    // The bug: byProject is iterated in insertion order (id order — alpha
    // first, beta second), and the old code wrote CYCLE-RUNNING totals to
    // each scope's run row. Beta, processed second, would inherit alpha's
    // created count even though beta itself found zero patterns.
    expect(betaRun.patterns_found).toBe(0);
    expect(betaRun.memories_created).toBe(0);
    expect(betaRun.memories_reinforced).toBe(0);

    // Sanity: alpha's own run row still reports its own (non-zero) counts —
    // this proves the fix didn't just zero everything out.
    const alphaRuns = await obsQueries.listDiscoveryRuns('project:alpha', 5);
    expect(alphaRuns).toHaveLength(1);
    const alphaRun = alphaRuns[0];
    expect(alphaRun.patterns_found).toBeGreaterThan(0);
    expect(alphaRun.memories_created).toBeGreaterThan(0);
  });
});
