/**
 * THE DECAY-PREDICATE COMPOSITION SUITE (Phase 4, Task 6 — the phase's done-when).
 *
 * Same anti-drift pattern as scope-definition-composition.test.ts: one seeded
 * corpus, and every consumer of the archive line — the promotion archiver's
 * selector, the /api/ops/corpus-health panel, discovery-maintenance §2, and the
 * dream decay tier — must reach the SAME verdict about every row, because they
 * all select from ONE predicate pair (`isAnchored` + `isDecayedAtRisk`,
 * src/dreaming/scoring.ts). Honest scope of the net (team round F-B): the
 * set-equality groups lock the FOUR WIRED consumers above — they cannot catch
 * a fifth consumer this suite never calls. Consumers outside the suite are
 * covered by the grep-guard below (literal comparison shapes + the file-level
 * co-occurrence rule); a genuinely novel spelling in a new file (e.g. `0.20`,
 * `.2`, an inverted `>= 0.2`) remains a review concern, not a guard guarantee.
 *
 * The two SANCTIONED divergences are asserted positively, not ignored:
 *  - §2 passes the dormancy freeze as the predicate's explicit `dormant` input
 *    (ruling R4-B) — row `dormantAlias` is at risk for promotion/panel/dream
 *    but frozen for §2, and the divergence must trace to
 *    `isDecayedAtRisk(row, now, { dormant: true })`, not to a second formula.
 *  - The dream selector claims dup-group members FIRST (CR-3 precedence) — row
 *    `decayedTwin` is at risk everywhere but appears in the dream diff as an
 *    `exact_dup` member, never as a `decay` entry.
 *
 * Scope note (same as the scope suite): this locks the CONSUMERS to the
 * predicate — predicate correctness itself is scoring/confidence's own tests'
 * job. A bug inside `computeEffectiveConfidence` reproduces identically across
 * all four consumers and this suite stays green.
 *
 * Clock: the corpus is seeded RELATIVE to a captured `now` (offsets in days)
 * rather than the plan's absolute pinned date, because two consumers — the
 * panel route and the §2 sweep — read the real clock internally and cannot be
 * injected. Every margin is ≥ days wide, so the seconds between seeding and
 * assertion are noise; the suite is deterministic on any run date.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { registerRoutes } from '../../src/api/routes.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { isAnchored, isDecayedAtRisk, type StrengthInputs } from '../../src/dreaming/scoring.js';
import { selectDecayCandidates } from '../../src/promotion/auto-archive.js';
import { runDiscoveryMaintenance, type MaintenanceAuditDeps } from '../../src/discovery/maintenance.js';
import { runDreamPass } from '../../src/dreaming/dream-engine.js';
import {
  StaticMemorySource, DuplicateCandidateSelector, DeterministicDiffGenerator,
  type DiffGenerator, type ClassifiedCandidate,
} from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import type { CandidateMemory } from '../../src/dreaming/reasoner/reasoner.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import type {
  IObservationStore, IVectorSearch, IDatabaseLifecycle, IMemoryStore,
} from '../../src/database/interfaces.js';
import type { DreamDiff } from '../../src/types/types.js';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';

// ── Seed corpus (brief's 10 rows + row 9's fresh twin + the fix-round-1 asymmetry row) ──
//
// Expected verdicts, derived from the shared formula (durability 1 throughout —
// observation_count 1; decayed = conf · 0.5^(staleDays / halfLife)):
//
//  key          | type/tags              | conf | stale | half-life | effective  | verdict
//  locked       | project, is_locked=1   | 0.9  | 300d  | 45d       | 0.009      | anchored (lock) — raw at-risk, so the anchor gate is load-bearing
//  operator     | project                | 1.0  | 300d  | —         | 1.0        | anchored (>=1.0 short-circuit)
//  pinned       | project, pinned meta   | 0.5  | 300d  | 45d       | 0.005      | anchored (CR-1 pin) — raw at-risk
//  lockedLow    | discovery+error:runtime, is_locked=1 | 0.3 | 300d | 11d | frozen 0.3 (WS7.4 B2 — raw would be ~0, the fastest class) | anchored (lock)
//  confirmedFast| discovery+error:build  | 1.0  | 300d  | 11d       | 1.0 (>=1.0 short-circuit immune to the fast class too) | anchored (>=1.0)
//  liveScope    | discovery              | 0.6  | 300d  | 25d       | 0.6·2^-12 ≈ 0.00015 | AT RISK everywhere; §2 archives (scope active)
//  dormantAlias | discovery              | 0.6  | 300d  | 25d       | ≈ 0.00015  | AT RISK for promotion/panel/dream; §2 FROZEN (alias group dormant, R4-B)
//  structural   | reference + structural | 0.6  | 300d  | 38d       | floor 0.4  | never at risk (STRUCTURAL_FLOOR)
//  errorFast    | discovery + error:runtime | 0.5 | 30d | 11d       | 0.5·0.5^2.73 ≈ 0.076 | AT RISK — only because of the 11d error class (25d would read 0.218)
//  errorFast2   | discovery + error:build | 0.5 | 30d  | 11d       | ≈ 0.076    | AT RISK — the asymmetry row (fix round 1, below)
//  feedbackSlow | feedback               | 0.5  | 30d   | 90d       | 0.5·0.5^0.33 ≈ 0.397 | not at risk
//  decayedTwin  | discovery              | 0.5  | 300d  | 25d       | ≈ 0.00012  | AT RISK for promotion/panel/§2; dream: exact_dup member, NEVER decay (CR-3)
//  freshTwin    | discovery (same normalized content + scope as decayedTwin) | 0.8 | fresh | — | 0.8 | in no set; exists to form the exact-dup group
//  fresh        | project                | 0.8  | fresh | —         | 0.8        | in no set
// Fix round 1 (review finding): `errorFast2` breaks the count-swap symmetry the
// panel assertion is otherwise blind to. Under the historical drift shape — the
// panel re-growing the pre-Phase-5 default-60d FLOORLESS curve (sample rows
// losing type/tags) — the original 10-row corpus produced a perfect swap:
// errorFast EXITS the at-risk set (0.5·0.5^(30/60) ≈ 0.354 > 0.2) while
// structural ENTERS (floorless 0.6·0.5^(300/60) ≈ 0.019 < 0.2), so the panel's
// count (all it returns) still read 4 == 4. With TWO fast-class rows the drifted
// count is true−2+1: errorFast AND errorFast2 both exit (each ≈ 0.354 under 60d),
// structural still enters alone — drifted 4 ≠ true 5, and assertion 2 fails.
type RowKey =
  | 'locked' | 'operator' | 'pinned' | 'liveScope' | 'dormantAlias' | 'structural'
  | 'errorFast' | 'errorFast2' | 'feedbackSlow' | 'decayedTwin' | 'freshTwin' | 'fresh'
  | 'lockedLow' | 'confirmedFast';

const AT_RISK_ROWS: readonly RowKey[] = ['liveScope', 'dormantAlias', 'errorFast', 'errorFast2', 'decayedTwin'];
// WS7.4 B2: lockedLow/confirmedFast are seeded under the FASTEST decay class
// (error:*, 11d half-life) — the class under which their raw (unfrozen)
// effective confidence would clearly read at-risk — to re-pin the ANCHOR GATE
// (`!isAnchored(m)`, below) under a harder case than the existing locked/
// operator rows. Every consumer here excludes them via that gate BEFORE
// isDecayedAtRisk is ever called, same as the pre-existing anchored rows; the
// freeze itself (computeEffectiveConfidence's `locked` short-circuit, called
// directly on an anchored row with no prior gate) is pinned separately by
// tests/unit/anchor-contract.test.ts.
const ANCHORED_ROWS: readonly RowKey[] = ['locked', 'operator', 'pinned', 'lockedLow', 'confirmedFast'];

interface SeededCorpus {
  db: Database.Database;
  queries: MemoryQueries;
  now: Date;
  ids: Record<RowKey, number>;
}

async function seedCorpus(): Promise<SeededCorpus> {
  const { db, queries } = createTestDatabase();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const ids = {} as Record<RowKey, number>;

  const backdate = db.prepare(
    'UPDATE memories SET last_seen = ?, updated_at = ?, created_at = ?, observation_count = 1 WHERE id = ?');

  async function seed(
    key: RowKey,
    m: Parameters<typeof createTestMemory>[0],
    staleDays?: number,
  ): Promise<number> {
    const { id } = await queries.store(createTestMemory(m));
    ids[key] = id;
    if (staleDays !== undefined) {
      const ts = ago(staleDays);
      backdate.run(ts, ts, ts, id);
    }
    return id;
  }

  const lockedId = await seed('locked',
    { content: 'operator-locked note about the deploy ritual', type: 'project', scope: 'project:anchors', confidence: 0.9 }, 300);
  db.prepare('UPDATE memories SET is_locked = 1 WHERE id = ?').run(lockedId);
  await seed('operator',
    { content: 'operator-confirmed fact held at full confidence', type: 'project', scope: 'project:anchors', confidence: 1.0 }, 300);
  await seed('pinned',
    { content: 'pinned working note kept on purpose', type: 'project', scope: 'project:anchors', confidence: 0.5, metadata: '{"pinned":true}' }, 300);
  // WS7.4 B2: re-pins the shared !isAnchored gate under the fastest decay
  // class (error:runtime, 11d half-life) — a harder case than the 'locked'
  // row above, whose 45d half-life leaves more room for a gating mistake to
  // hide. Does NOT exercise the freeze itself (computeEffectiveConfidence's
  // `locked` short-circuit) — that is pinned directly, gate-free, by
  // tests/unit/anchor-contract.test.ts.
  const lockedLowId = await seed('lockedLow',
    { content: 'locked low-confidence note under the fastest decay class', type: 'discovery', scope: 'project:anchors', tags: ['error:runtime'], confidence: 0.3 }, 300);
  db.prepare('UPDATE memories SET is_locked = 1 WHERE id = ?').run(lockedLowId);
  await seed('confirmedFast',
    { content: 'operator-confirmed note also under the fastest decay class', type: 'discovery', scope: 'project:anchors', tags: ['error:build'], confidence: 1.0 }, 300);
  await seed('liveScope',
    { content: 'stale discovery sitting under an actively-observed scope', type: 'discovery', scope: 'project:live-scope', confidence: 0.6 }, 300);
  await seed('dormantAlias',
    { content: 'stale discovery stranded on an alias variant of a dormant client', type: 'discovery', scope: 'client:Variant-X', confidence: 0.6 }, 300);
  await seed('structural',
    { content: 'the API base path is /api and the port is 3200', type: 'reference', scope: 'global', tags: ['structural'], confidence: 0.6 }, 300);
  await seed('errorFast',
    { content: 'recurring runtime error when the watcher restarts', type: 'discovery', scope: 'project:quiet', tags: ['error:runtime'], confidence: 0.5 }, 30);
  await seed('errorFast2',
    { content: 'recurring build error when the bundler cache goes stale', type: 'discovery', scope: 'project:quiet', tags: ['error:build'], confidence: 0.5 }, 30);
  await seed('feedbackSlow',
    { content: 'operator prefers concise commit subjects', type: 'feedback', scope: 'global', confidence: 0.5 }, 30);
  // Same NORMALIZED content, same scope, different bytes (content_hash is
  // globally unique, so byte-identical twins cannot both be stored — the
  // selector's exact_dup tier groups on normalizeContent, not the hash).
  await seed('decayedTwin',
    { content: 'Duplicate  Insight: the build gate is strict tsc', type: 'discovery', scope: 'project:dup-scope', confidence: 0.5 }, 300);
  await seed('freshTwin',
    { content: 'duplicate insight: the build gate is strict tsc', type: 'discovery', scope: 'project:dup-scope', confidence: 0.8 });
  await seed('fresh',
    { content: 'fresh well-believed project note', type: 'project', scope: 'global', confidence: 0.8 });

  return { db, queries, now, ids };
}

function strengthInputs(m: {
  confidence: number; observation_count: number | null; last_seen: string | null;
  updated_at: string; type: string; tags: string[]; is_locked?: boolean | number | null;
}): StrengthInputs {
  return {
    confidence: m.confidence,
    observation_count: m.observation_count ?? 1,
    last_seen: m.last_seen ?? null,
    updated_at: m.updated_at,
    type: m.type,
    tags: m.tags,
    // WS7.4 B2: mirrors the shape every real consumer (selectDecayCandidates,
    // the pipeline decay tier, maintenance §2) actually passes — the four-
    // consumer set-equality above only means something if this helper's
    // derivation matches theirs.
    is_locked: m.is_locked,
  };
}

const sortedIds = (xs: number[]) => [...xs].sort((a, b) => a - b);

// applyEntry/auditedArchiveMemory only touch add/remove — the null stub keeps the suite model-free.
const nullIndex = {
  async add() {}, async remove() {}, async search() { return []; },
} as unknown as IVectorSearch;

function lifecycleStub(): IDatabaseLifecycle {
  return {
    initialize: async () => {},
    close: async () => {},
    getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
    backup: async () => '/tmp/test-backup.db',
  };
}

// ── Groups 1, 2, 4: promotion / panel / dream over ONE read-only corpus ─────

describe('Phase 4: one archive-line predicate across every consumer', () => {
  let c: SeededCorpus;
  /** Ids where `!isAnchored && isDecayedAtRisk(row, now)` — computed ONCE from the shared pair. */
  let expectedAtRiskIds: number[];
  /** What the promotion archiver's real selector picked. */
  let promotionIds: number[];

  beforeAll(async () => {
    c = await seedCorpus();
    const { memories } = await c.queries.list({ limit: 100, include_archived: false });
    expect(memories).toHaveLength(14);
    expectedAtRiskIds = sortedIds(memories
      .filter(m => !isAnchored(m) && isDecayedAtRisk(strengthInputs(m), c.now))
      .map(m => m.id));
    promotionIds = sortedIds((await selectDecayCandidates(c.queries, c.now)).map(x => x.id));
  });

  it('the seed behaves as designed: exactly liveScope/dormantAlias/errorFast/errorFast2/decayedTwin are unanchored + at risk', () => {
    // Guards the guard: if a seed drifts (e.g. errorFast loses its 11d class),
    // the agreement assertions below would agree on the WRONG set silently.
    expect(expectedAtRiskIds).toEqual(sortedIds(AT_RISK_ROWS.map(k => c.ids[k])));
  });

  it('assertion 1 — promotion selects exactly the !isAnchored && isDecayedAtRisk rows', () => {
    expect(promotionIds).toEqual(expectedAtRiskIds);
  });

  it('assertion 2 — the corpus-health panel counts exactly the promotion set', async () => {
    const idx = new EmbeddingIndex();
    await idx.loadFromDatabase([]);
    const app = Fastify({ logger: false });
    registerRoutes(app, {
      stores: { queries: c.queries as IMemoryStore },
      services: { embeddingIndex: idx },
      lifecycle: lifecycleStub(),
    });
    await app.ready();
    try {
      // sample=100 quantizes to 500 > 11 rows, so the panel covers the full corpus.
      const res = await app.inject({ method: 'GET', url: '/api/ops/corpus-health?sample=100' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.active_memory_count).toBe(14);
      expect(body.meta.sampled).toBe(false);
      expect(body.data.decayed_at_risk_count).toBe(promotionIds.length);
    } finally {
      await app.close();
    }
  });

  it('assertion 4 — dream precedence: the decayed exact-dup member routes to exact_dup, decay == promotion minus it', async () => {
    const dreamStore = new DreamQueries(c.db);
    const { memories } = await c.queries.list({ limit: 100, include_archived: false });
    const candidates: CandidateMemory[] = memories.map(m => ({
      id: m.id,
      content: m.content,
      content_hash: m.content_hash ?? null,
      summary: m.summary ?? null,
      tags: m.tags,
      scope: m.scope,
      confidence: m.confidence,
      is_locked: !!m.is_locked,
      type: m.type,
      created_at: m.created_at,
      updated_at: m.updated_at,
      embedding: null, // no vectors seeded — the exact_dup edge is normalized-content equality
      metadata: m.metadata,
      last_seen: m.last_seen ?? null,
      observation_count: m.observation_count ?? 1,
    }));

    let diff: DreamDiff | null = null;
    const realGen = new DeterministicDiffGenerator();
    const recordingGen: DiffGenerator = {
      generate: (classified: ClassifiedCandidate[]) => (diff = realGen.generate(classified)),
    };

    const run = await runDreamPass({
      dreamStore,
      source: new StaticMemorySource(candidates),
      selector: new DuplicateCandidateSelector({ now: () => c.now }),
      reasoner: new NoOpReasoner(),
      diffGen: recordingGen,
      lock: new ConsolidationLockManager({ store: dreamStore, holder: 'composition-suite' }),
      scope: null,
      tz: 'UTC',
      // No `apply` deps: generation-only — the pass writes a dreams row but
      // never mutates memory rows, so the corpus stays pristine for this group.
    }, { trigger: 'manual', reason: 'phase-4 composition suite', windowKey: 'phase4-composition' });

    expect(run.status).toBe('completed');
    expect(run.memories_examined).toBe(14);
    expect(diff).not.toBeNull();
    const entries = diff!.entries;

    // CR-3 precedence: the decayed twin is claimed by the exact_dup group...
    const exactDup = entries.filter(e => e.change_class === 'exact_dup');
    expect(exactDup).toHaveLength(1);
    expect(sortedIds(exactDup[0].memory_ids)).toEqual(sortedIds([c.ids.decayedTwin, c.ids.freshTwin]));

    // ...so the decay tier proposes exactly the promotion set MINUS that member.
    const decayIds = sortedIds(entries.filter(e => e.change_class === 'decay').flatMap(e => e.memory_ids));
    expect(decayIds).toEqual(promotionIds.filter(id => id !== c.ids.decayedTwin));

    // Hard Anchor: no dream entry of any class touches an anchored row.
    const anchoredIds = new Set(ANCHORED_ROWS.map(k => c.ids[k]));
    for (const e of entries) {
      for (const id of e.memory_ids) expect(anchoredIds.has(id)).toBe(false);
    }
  });
});

// ── Group 3: §2 vs promotion — divergence is dormancy only (R4-B) ───────────

describe('Phase 4: maintenance §2 == promotion restricted to discovery, modulo the dormancy freeze', () => {
  /** Per-scope observation stats stub (same contract as maintenance-audited.test.ts). */
  function stubObsStore(newestByScope: Record<string, string>): IObservationStore {
    return {
      getObservationStats: async (scope?: string) => ({
        total: 0,
        by_project: {},
        by_tool: {},
        oldest: null,
        newest: scope ? (newestByScope[scope] ?? null) : null,
      }),
      purgeOlderThan: async () => 0,
    } as unknown as IObservationStore;
  }

  it('§2 archives exactly the promotion discovery subset minus the dormant alias-group row', async () => {
    const c = await seedCorpus();
    const dreamStore = new DreamQueries(c.db);
    await dreamStore.updateConfig('default', { auto_accept_decay: true });

    // Promotion's verdicts, taken BEFORE §2 mutates the corpus.
    const promotionIds = (await selectDecayCandidates(c.queries, c.now)).map(x => x.id);
    const { memories } = await c.queries.list({ limit: 100, include_archived: false });
    const typeById = new Map(memories.map(m => [m.id, m.type]));
    const promotionDiscovery = sortedIds(promotionIds.filter(id => typeById.get(id) === 'discovery'));
    // §2's domain is `type: 'discovery'` BY DESIGN — a decayed non-discovery row
    // would be promotion-only. In this corpus every unanchored at-risk row is a
    // discovery row, so the subset equals the whole promotion set:
    expect(promotionDiscovery).toEqual(sortedIds(promotionIds));

    // The divergence input, asserted at the predicate itself (R4-B): the SAME
    // row §2 freezes is at-risk without the dormant flag and safe with it —
    // the freeze is the shared predicate's explicit input, not a second formula.
    const dormantRow = memories.find(m => m.id === c.ids.dormantAlias)!;
    expect(isDecayedAtRisk(strengthInputs(dormantRow), c.now)).toBe(true);
    expect(isDecayedAtRisk(strengthInputs(dormantRow), c.now, { dormant: true })).toBe(false);

    const ago = (days: number) => new Date(c.now.getTime() - days * 86_400_000).toISOString();
    const audit: MaintenanceAuditDeps = {
      dreamStore,
      vectorIndex: nullIndex,
      configStore: dreamStore,
      // The Variant-X alias group: canonicalize folds the variant, expand yields the group.
      canonicalizeScope: async (s: string) => (s === 'client:Variant-X' ? 'client:variant-x' : s),
      expandScope: async (s: string) =>
        s === 'client:variant-x' ? ['client:variant-x', 'client:Variant-X'] : [s],
    };
    const result = await runDiscoveryMaintenance(
      // live-scope has fresh observations (active → decay applies); the dormant
      // row's alias SIBLING is 100d stale (group dormant → frozen); every other
      // scope has no signal (→ decay applies).
      stubObsStore({ 'project:live-scope': ago(2), 'client:variant-x': ago(100) }),
      c.queries,
      audit,
    );

    // Archived == promotionDiscovery minus dormantAlias; the frozen row is the ONLY divergence.
    const expectedArchived = promotionDiscovery.filter(id => id !== c.ids.dormantAlias);
    expect(result.memories_archived).toBe(expectedArchived.length);
    const archivedNow: number[] = [];
    for (const key of Object.keys(c.ids) as RowKey[]) {
      const row = await c.queries.peek(c.ids[key]);
      if (row!.is_archived) archivedNow.push(row!.id);
    }
    expect(sortedIds(archivedNow)).toEqual(expectedArchived);
    // The frozen row survived ACTIVE (not withheld-by-flag, not archived).
    expect((await c.queries.peek(c.ids.dormantAlias))!.is_archived).toBe(0);
  });
});

// ── Grep-guard (CR-5): no second spelling of the archive line survives ──────

describe('CR-5 grep-guard: the archive line has ONE spelling', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  // The predicate pair's two homes (the constant lives in confidence.ts only
  // because a scoring.ts→confidence.ts import already exists and the reverse
  // would cycle — ONE definition either way).
  const ALLOWED = new Set(['src/discovery/confidence.ts', 'src/dreaming/scoring.ts']);

  /** Recursive .ts lister — engines allow Node >=20, so no fs.globSync (>=22 only). */
  function tsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFilesUnder(full));
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  /**
   * The guard targets CODE, not prose: legitimate explanatory comments (e.g.
   * promotion-engine.ts's "formula matched to the dream decay tier —
   * memoryStrength < 0.2") and doc headers may NAME the threshold; only a
   * comparison the runtime executes is a second spelling. Known limit: a `//`
   * inside a string literal (a URL) truncates the rest of that line — it can
   * never create a false offender, and hiding a real comparison behind a URL
   * on the same line is not a plausible drift shape.
   */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  }

  it('no second spelling of the archive line survives (CR-5)', () => {
    const files = [
      ...tsFilesUnder(path.join(repoRoot, 'src')),
      ...tsFilesUnder(path.join(repoRoot, 'scripts')),
    ];
    // Walker sanity: an empty (or truncated) scan would prove nothing.
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    let thresholdDefinitions = 0;
    for (const f of files) {
      const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(f, 'utf8'));

      // Counted across ALL files (allowlist included): the constant must be
      // defined exactly once, in confidence.ts.
      if (/\bconst\s+DECAY_ARCHIVE_THRESHOLD\s*=/.test(code)) thresholdDefinitions++;
      // Task 4 deleted shouldArchive entirely — any reappearance, anywhere, is drift.
      if (/\bshouldArchive\s*\(/.test(code)) offenders.push(`${rel}: shouldArchive() reappeared (Task 4 deleted it)`);

      if (ALLOWED.has(rel)) continue;
      if (/ARCHIVE_STRENGTH_THRESHOLD/.test(code)) offenders.push(`${rel}: legacy ARCHIVE_STRENGTH_THRESHOLD name`);
      if (/DECAY_ARCHIVE_THRESHOLD\s*=/.test(code)) offenders.push(`${rel}: second DECAY_ARCHIVE_THRESHOLD assignment`);
      // A strength/confidence identifier — or a call on one, e.g.
      // `memoryStrength(m, now) < 0.2` (one paren-nesting level supported) —
      // compared against a hardcoded 0.2: the drift shape Tasks 3–5 eliminated
      // (trailing \b rejects 0.25 etc.; `[cC]onf` covers effectiveConf too).
      if (/\w*([sS]trength|[cC]onf)\w*\s*(\([^()]*(?:\([^()]*\)[^()]*)*\))?\s*<=?\s*0\.2\b/.test(code)) {
        offenders.push(`${rel}: hand-rolled "< 0.2" comparison`);
      }
      // F-B (team round): file-level co-occurrence rule. The regex above needs
      // strength/conf in the COMPARED identifier, so splitting the call from
      // the comparison — `const risk = memoryStrength(m, now); … risk < 0.2` —
      // evaded it. Outside the predicate's own homes, calling one of the
      // predicate's inputs AND comparing anything against a literal 0.2 in the
      // same file has no legitimate co-occurrence: route the verdict through
      // isDecayedAtRisk instead. (Verified zero false positives on the current
      // tree: the only files that both call and compare are the allowlisted
      // predicate homes; every other caller's "0.2" lives in comments, which
      // stripComments removes.)
      if (
        /\b(memoryStrength|computeEffectiveConfidence)\s*\(/.test(code) &&
        /<=?\s*0\.2\b/.test(code)
      ) {
        offenders.push(`${rel}: calls memoryStrength/computeEffectiveConfidence AND compares against a literal 0.2 — use isDecayedAtRisk`);
      }
    }
    expect(offenders).toEqual([]);
    expect(thresholdDefinitions).toBe(1);
  });
});
