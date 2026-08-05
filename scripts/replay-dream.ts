/**
 * Replay harness CLI — `npm run dream:replay`.
 *
 * Runs TWO full zero-LLM dream passes over the synthetic gold-set corpus in
 * in-memory SQLite databases, then the R2 fire/collapse scenarios:
 *
 *   Pass A — Phase-0 baseline (normalized-content selector, empty diff): the
 *            original D0.7 regression net, unchanged.
 *   Pass B — Phase-1.2 configuration (DuplicateCandidateSelector +
 *            DeterministicDiffGenerator): real detection tiers + real diff,
 *            gated on the §1.2 verify list.
 *
 * Exits non-zero if any gate fails. The clock is pinned (2026-06-15) so the
 * decay fixture scores deterministically.
 *
 * Note: the injected-failure scenarios intentionally produce "Dream N failed"
 * error logs below; those are the scenarios working, not the harness breaking.
 */
import Database from 'better-sqlite3';
import { runMigrations } from '../src/database/migrations.js';
import { DreamQueries } from '../src/database/dream-queries.js';
import { MemoryQueries } from '../src/database/queries.js';
import {
  runReplay, runScenario, runRotationScenario, runWholeCorpusScenario, runReferentGuardScenario,
  type ScenarioResult,
} from '../src/dreaming/replay.js';
import { DuplicateCandidateSelector, DeterministicDiffGenerator } from '../src/dreaming/pipeline.js';
import type { DreamDiffEntry } from '../src/types/types.js';
import { SYNTHETIC_CORPUS, GOLD_CASES } from '../tests/fixtures/dreaming/corpus.js';
import { R2_SCENARIOS } from '../tests/fixtures/dreaming/r2-scenarios.js';

const NOW = Date.parse('2026-06-15T03:00:00Z'); // pinned — decay fixture is clock-sensitive

function freshStore(): DreamQueries {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return new DreamQueries(db);
}

function pct(n: number | null): string {
  return n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}

/** Diff entry whose memory_ids set-match the given ids, if any. */
function entryFor(entries: DreamDiffEntry[], ids: number[]): DreamDiffEntry | undefined {
  const want = new Set(ids);
  return entries.find(e => e.memory_ids.length === want.size && e.memory_ids.every(id => want.has(id)));
}

async function main(): Promise<void> {
  console.log('KOPENG dream replay harness — zero-LLM (clock pinned 2026-06-15)\n');
  console.log(`Corpus: ${SYNTHETIC_CORPUS.length} synthetic memories · Gold set: ${GOLD_CASES.length} cases\n`);

  // ── Pass A: Phase-0 baseline (defaults — normalized-content selector, empty diff) ──
  const storeA = freshStore();
  const passA = await runReplay({
    corpus: SYNTHETIC_CORPUS, gold: GOLD_CASES, dreamStore: storeA,
    windowKey: 'replay-phase0', now: () => NOW,
  });
  const dreamA = passA.run.dream_id !== null ? await storeA.getDream(passA.run.dream_id) : null;
  const dA = passA.metrics.detection;

  console.log('— Pass A: Phase-0 baseline —');
  console.log(`  status=${passA.run.status} examined=${passA.run.memories_examined} proposed=${passA.run.changes_proposed}`);
  console.log(`  groups ${dA.groups_total} (TP ${dA.true_positive_groups}, FP ${dA.false_positive_groups}) · phase-0 recall ${pct(dA.phase0_recall)} · LLM calls ${passA.metrics.reasoner.llm_calls}\n`);

  // ── Pass B: Phase-1.2 configuration (real detection + real diff) ──
  const storeB = freshStore();
  const passB = await runReplay({
    corpus: SYNTHETIC_CORPUS, gold: GOLD_CASES, dreamStore: storeB,
    selector: new DuplicateCandidateSelector({ now: () => new Date(NOW) }),
    diffGen: new DeterministicDiffGenerator(),
    windowKey: 'replay-phase12', now: () => NOW,
  });
  const dreamB = passB.run.dream_id !== null ? await storeB.getDream(passB.run.dream_id) : null;
  const dB = passB.metrics.detection;
  const entries = dreamB?.output_diff ? (JSON.parse(dreamB.output_diff).entries as DreamDiffEntry[]) : [];

  console.log('— Pass B: Phase-1.2 detection + diff —');
  console.log(`  status=${passB.run.status} examined=${passB.run.memories_examined} proposed=${passB.run.changes_proposed} acceptance=${dreamB?.acceptance_status}`);
  console.log(`  groups ${dB.groups_total} (TP ${dB.true_positive_groups}, FP ${dB.false_positive_groups})`);
  console.log(`  precision ${pct(dB.precision)} · recall ${pct(dB.recall)} (${dB.gold_detected}/${dB.gold_total}) · phase-1.2 recall ${pct(dB.phase12_recall)} · FP rate ${pct(dB.false_positive_rate)}`);
  for (const [cls, counts] of Object.entries(dB.by_class)) {
    console.log(`    ${cls}: ${counts.detected}/${counts.total} detected`);
  }
  console.log('  proposed changes by class:');
  for (const [cls, count] of Object.entries(passB.metrics.diff.by_change_class)) {
    console.log(`    ${cls}: ${count}`);
  }
  console.log(`  matched gold: ${passB.metrics.diff.matched_gold}/${passB.metrics.diff.entries_total}`);
  console.log(`  Hard-Anchor violations: ${passB.metrics.anchor_violations.length === 0 ? 'none' : JSON.stringify(passB.metrics.anchor_violations)}`);
  console.log(`  reasoner: ${passB.metrics.reasoner.name} · classify calls ${passB.metrics.reasoner.classify_calls} · LLM calls ${passB.metrics.reasoner.llm_calls}`);

  // ── R2 fire/collapse scenarios (expected error logs from injected failures) ──
  console.log('\n— R2 scenarios —');
  const scenarioResults: ScenarioResult[] = [];
  for (const scenario of R2_SCENARIOS) {
    const result = await runScenario(scenario, freshStore, { now: () => NOW });
    scenarioResults.push(result);
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    for (const failure of result.failures) console.log(`        ${failure}`);
  }

  // ── D1.4 rotation scenario (rotating-window source over one shared db) ──
  console.log('\n— D1.4 rotation scenario —');
  const rotDb = new Database(':memory:');
  rotDb.pragma('journal_mode = WAL');
  rotDb.pragma('foreign_keys = ON');
  runMigrations(rotDb);
  const rotStores = new DreamQueries(rotDb);
  const rotation = await runRotationScenario({
    memoryStore: new MemoryQueries(rotDb),
    dreamStore: rotStores,
    configStore: rotStores,
  });
  console.log(`  ${rotation.ok ? 'PASS' : 'FAIL'}  ${rotation.name}`);
  for (const failure of rotation.failures) console.log(`        ${failure}`);

  // ── T6 whole-corpus scenario (far-apart dup + id-segment reasoner drain) ──
  console.log('\n— T6 whole-corpus scenario —');
  const wcDb = new Database(':memory:');
  wcDb.pragma('journal_mode = WAL');
  wcDb.pragma('foreign_keys = ON');
  runMigrations(wcDb);
  const wcStores = new DreamQueries(wcDb);
  const wholeCorpus = await runWholeCorpusScenario({
    memoryStore: new MemoryQueries(wcDb),
    dreamStore: wcStores,
    configStore: wcStores,
  });
  console.log(`  ${wholeCorpus.ok ? 'PASS' : 'FAIL'}  ${wholeCorpus.name}`);
  for (const failure of wholeCorpus.failures) console.log(`        ${failure}`);

  // ── T31 referent-guard scenario (template noise → 0 reasoner calls, 0 queue entries) ──
  console.log('\n— T31 referent-guard scenario —');
  const rgDb = new Database(':memory:');
  rgDb.pragma('journal_mode = WAL');
  rgDb.pragma('foreign_keys = ON');
  runMigrations(rgDb);
  const referentGuard = await runReferentGuardScenario({
    memoryStore: new MemoryQueries(rgDb),
    dreamStore: new DreamQueries(rgDb),
  });
  console.log(`  ${referentGuard.ok ? 'PASS' : 'FAIL'}  ${referentGuard.name}`);
  for (const failure of referentGuard.failures) console.log(`        ${failure}`);

  // ── Gates ──
  const exactPair = entryFor(entries, [1, 2]);
  const exactCluster = entryFor(entries, [3, 4, 5]);
  const paraphrase = entryFor(entries, [6, 7]);
  const contradiction = entryFor(entries, [8, 9]);
  const preference = entryFor(entries, [10, 11]);
  const crossScope = entryFor(entries, [16, 17]);
  const decay = entryFor(entries, [30]);

  const gates: Array<[string, boolean]> = [
    // Pass A — the Phase-0 baseline must keep behaving exactly as in D0.7
    ['A: pass completed, empty diff, acceptance=empty', passA.run.status === 'completed' && passA.metrics.diff.entries_total === 0 && dreamA?.acceptance_status === 'empty'],
    ['A: phase-0 recall = 1.0, zero FP, zero LLM calls', dA.phase0_recall === 1 && dA.false_positive_groups === 0 && passA.metrics.reasoner.llm_calls === 0],
    // Pass B — §1.2 verify list
    ['B: pass completed, diff queued as pending', passB.run.status === 'completed' && dreamB?.acceptance_status === 'pending' && dreamB?.changes_queued === entries.length && entries.length > 0],
    ['B: zero LLM calls', passB.metrics.reasoner.llm_calls === 0],
    ['B: no Hard-Anchor violations (locked memories untouched)', passB.metrics.anchor_violations.length === 0],
    ['B: phase-1.2 recall = 1.0', dB.phase12_recall === 1],
    ['B: zero false-positive groups (distractors silent)', dB.false_positive_groups === 0],
    ['B: every diff entry matches a gold case', passB.metrics.diff.matched_gold === passB.metrics.diff.entries_total && passB.metrics.diff.entries_total === GOLD_CASES.length],
    ['B: exact dups → exact_dup, deterministic-safe', exactPair?.change_class === 'exact_dup' && exactPair?.tier === 'deterministic-safe' && exactCluster?.change_class === 'exact_dup' && exactCluster?.tier === 'deterministic-safe'],
    ['B: paraphrase (cosine 0.98) → merge, deterministic-safe', paraphrase?.change_class === 'merge' && paraphrase?.tier === 'deterministic-safe'],
    ['B: 0.85–0.95 band → reasoner-driven, never collapsed', contradiction?.tier === 'reasoner-driven' && preference?.tier === 'reasoner-driven'],
    ['B: cross-scope dup → promote_global signal, not a collapse', crossScope?.change_class === 'promote_global'],
    ['B: decayed memory → decay archive proposal, deterministic-safe', decay?.change_class === 'decay' && decay?.tier === 'deterministic-safe'],
    ['all R2 scenarios pass', scenarioResults.every(r => r.ok)],
    ['D1.4 rotation scenario passes', rotation.ok],
    ['T6 whole-corpus scenario passes (far-apart dup + id-segment drain)', wholeCorpus.ok],
    ['T31 referent-guard scenario passes (template noise: 0 LLM calls, 0 queue entries)', referentGuard.ok],
  ];

  console.log('\n— Gates —');
  let failed = 0;
  for (const [name, ok] of gates) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }

  if (failed > 0) {
    console.log(`\n${failed} gate(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nAll gates passed.');
  }
}

main().catch(err => {
  console.error('Replay harness crashed:', err);
  process.exitCode = 1;
});
