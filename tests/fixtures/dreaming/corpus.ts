/**
 * Synthetic memory corpus + gold set for the D0.7 replay harness.
 *
 * Hand-written on purpose — readable fixtures over clever generation. Each gold
 * case names the memory ids that belong together, its class, and the earliest
 * phase whose detector should find it:
 *   phase 0   — normalized-content selector (whitespace/case variants)
 *   phase 1.2 — cosine ≥0.95 semantic dups, the 0.85–0.95 reasoner-driven band,
 *               and durability-aware decay
 *   phase 2   — reasoner classification (what a banded pair MEANS)
 *
 * Embeddings are hand-crafted unit vectors (26-dim), NOT model output — the
 * harness stays zero-model. `blend(i, j, w)` builds a vector whose cosine with
 * `basis(i)` is exactly `w`, so every pairwise similarity below is by design:
 * paraphrase pair at 0.98 (collapse tier), contradiction at 0.90 and preference
 * change at 0.88 (reasoner band), Redis distractors at 0.70 (sub-band — shared
 * vocabulary must NOT be flagged), and the Phase-5 threshold-straddling pairs
 * at 0.96/0.94 (either side of the 0.95 collapse threshold) and 0.86/0.84
 * (either side of the 0.85 band floor).
 *
 * Hard-Anchor decoys (ids 12–15): anchored memories (`confidence = 1.0` or
 * `is_locked`) each have a journal-tier twin with IDENTICAL normalized content.
 * If the anchor bypass ever regresses, these pairs surface as candidate groups
 * and the harness flags anchor violations.
 *
 * Replay clock: score-sensitive fixtures (the decay case) assume `now` around
 * 2026-06-15 — both the unit test and the CLI pin their clocks there.
 */
import type { CandidateMemory } from '../../../src/dreaming/reasoner/reasoner.js';
import type { GoldCase } from '../../../src/dreaming/replay.js';
import { SYNTHETIC_ALIAS_SCOPE_RAW, SYNTHETIC_ALIAS_SCOPE_CANONICAL } from '../../../src/dreaming/replay.js';

const DIM = 26;

function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

/** Unit vector with cosine exactly `w` against basis(i), orthogonal remainder on j. */
function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}

function mem(
  id: number,
  content: string,
  embedding: Float32Array | null,
  opts: Partial<Pick<CandidateMemory, 'scope' | 'confidence' | 'is_locked' | 'updated_at' | 'last_seen' | 'observation_count' | 'metadata'>> = {},
): CandidateMemory {
  return {
    id,
    content,
    content_hash: `hash-${id}`,
    summary: null,
    tags: [],
    scope: opts.scope ?? 'project:kopeng',
    confidence: opts.confidence ?? 0.7,
    is_locked: opts.is_locked ?? false,
    created_at: '2026-05-20T12:00:00Z',
    updated_at: opts.updated_at ?? '2026-05-20T12:00:00Z',
    embedding,
    metadata: opts.metadata ?? null,
    last_seen: opts.last_seen ?? null,
    observation_count: opts.observation_count ?? 1,
  };
}

export const SYNTHETIC_CORPUS: CandidateMemory[] = [
  // ── duplicates: exact after normalization (phase 0) ──
  mem(1, 'Use `npm run dev` to start the REST server in watch mode.', basis(0)),
  mem(2, 'use `npm run dev`  to start the REST server   in watch mode.', basis(0)),

  mem(3, 'Vitest test timeout is 30 seconds because model loading can be slow.', basis(1)),
  mem(4, 'Vitest test timeout is 30 seconds because model loading can be slow. ', basis(1)),
  mem(5, 'VITEST TEST TIMEOUT IS 30 SECONDS BECAUSE MODEL LOADING CAN BE SLOW.', basis(1)),

  // ── duplicate: same fact, different wording (phase 1.2, cosine 0.98 ≥ 0.95) ──
  mem(6, 'The embedding model is all-MiniLM-L6-v2 and produces 384-dimensional vectors.', basis(2)),
  mem(7, 'Embeddings come from all-MiniLM-L6-v2, which outputs 384-dim vectors.', blend(2, 3, 0.98)),

  // ── contradiction: detected by the 0.85–0.95 band at 1.2 (reasoner-driven);
  //    what it MEANS (contested vs supersede) is phase-2 classification ──
  mem(8, 'Deploys to the staging cluster happen on Fridays after 5pm.', basis(4)),
  mem(9, 'Never deploy to the staging cluster on a Friday.', blend(4, 5, 0.90)),

  // ── preference change: banded at 1.2 (cosine 0.88); supersession is phase 2 ──
  mem(10, 'Operator prefers tabs for indentation in this repo.', basis(6)),
  mem(11, 'Operator prefers 2-space indentation in this repo (changed from tabs).',
    blend(6, 7, 0.88), { updated_at: '2026-06-05T09:00:00Z' }),

  // ── Hard-Anchor decoys: identical content, one side anchored ──
  mem(12, 'The memory service runs as a Windows service under NSSM on the build server.', basis(8), { confidence: 1.0 }),
  mem(13, 'The memory service runs as a Windows service under NSSM on the build server.', basis(8)),

  mem(14, 'Database backups run nightly at 02:00 operator-local time.', basis(9), { is_locked: true }),
  mem(15, 'Database backups run nightly at 02:00 operator-local time.', basis(9)),

  // ── cross-scope same-content pair (R6: promote-to-global signal, never a collapse) ──
  mem(16, 'Local Node MCP servers must use absolute paths in args on Windows.', basis(10)),
  mem(17, 'Local Node MCP servers must use absolute paths in args on Windows.', basis(10), { scope: 'global' }),

  // ── distractors: unique facts sharing vocabulary — must never be flagged.
  //    20 vs 21 sits at cosine 0.70: related topic, below the 0.85 band. ──
  mem(20, 'Redis stores ephemeral context key-value pairs.', basis(11)),
  mem(21, 'Redis is optional and gated by REDIS_ENABLED in .env.', blend(11, 12, 0.70)),
  mem(22, 'Neo4j stores the entity graph extracted from memory content.', basis(12)),
  mem(23, 'MinIO stores artifacts via the S3-compatible API.', basis(13)),
  mem(24, 'Rate limiting uses @fastify/rate-limit on every REST route.', basis(14)),
  mem(25, 'Keyword search uses FTS5 on SQLite and tsvector on Postgres.', basis(15)),

  // ── decayed memory (phase 1.2): last seen ~5 months before the replay clock,
  //    low confidence → effective strength ≈ 0.07 < 0.2 archive threshold ──
  mem(30, 'Workaround for the legacy importer crash: rerun with --skip-validation.', basis(16),
    { confidence: 0.45, last_seen: '2026-01-05T12:00:00Z', updated_at: '2026-01-05T12:00:00Z' }),

  // ── threshold-straddling pairs (Phase 5): one pair just ABOVE and one just
  //    BELOW each selector boundary, so a drifted predicate flips a gate rather
  //    than passing silently. Margins (0.01) dwarf float32 rounding (~1e-7).
  //    NOTE: the band pairs here (42-43, 44-45) feed EXPECTED_CLASSIFY_CALLS_B
  //    in scripts/replay-dream.ts — adding or removing a band pair anywhere in
  //    this corpus must update that pin alongside its derivation comment. ──
  // 0.96 ≥ COSINE_DUPLICATE_THRESHOLD (0.95): collapse tier, deterministic-safe.
  mem(40, 'The recall hook runs under a hard 3-second budget per prompt.', basis(18)),
  mem(41, 'Each prompt gives the recall hook at most 3 seconds to respond.', blend(18, 19, 0.96)),
  // 0.94 < 0.95 but ≥ NEAR_DUP_BAND_MIN (0.85): band tier, reasoner-driven, never collapsed.
  mem(42, 'The observation buffer flushes in chunks capped at 100 items.', basis(20)),
  mem(43, 'Observation flush chunks are limited to 100 entries per batch.', blend(20, 21, 0.94)),
  // 0.86 ≥ 0.85: still band tier — the floor holds from above.
  mem(44, 'The viz server proxies SSE by URL prefix detection.', basis(22)),
  mem(45, 'SSE requests are recognized by the viz proxy via their URL prefix.', blend(22, 23, 0.86)),
  // 0.84 < 0.85: below the band — related vocabulary, must NOT be flagged at all.
  mem(46, 'Winston writes structured logs for every subsystem.', basis(24)),
  mem(47, 'Log levels are configured per transport in the Winston setup.', blend(24, 25, 0.84)),
];

export const GOLD_CASES: GoldCase[] = [
  {
    id: 'dup-exact-pair',
    gold_class: 'duplicate',
    member_ids: [1, 2],
    detectable_phase: 0,
    note: 'Whitespace variants of the same sentence — normalized-content selector must group them.',
  },
  {
    id: 'dup-exact-cluster',
    gold_class: 'duplicate',
    member_ids: [3, 4, 5],
    detectable_phase: 0,
    note: 'Three case/whitespace variants — must group as one cluster, not pairs.',
  },
  {
    id: 'dup-paraphrase',
    gold_class: 'duplicate',
    member_ids: [6, 7],
    detectable_phase: 1.2,
    note: 'Same fact, different wording (cosine 0.98) — deterministic collapse tier at 1.2.',
  },
  {
    id: 'contradiction-deploy-day',
    gold_class: 'contradiction',
    member_ids: [8, 9],
    detectable_phase: 1.2,
    note: 'Conflicting deploy guidance at cosine 0.90 — DETECTED by the 0.85–0.95 band at 1.2, tagged reasoner-driven, never auto-collapsed. Classification (contested/supersede) is phase 2.',
  },
  {
    id: 'preference-change-indentation',
    gold_class: 'preference_change',
    member_ids: [10, 11],
    detectable_phase: 1.2,
    note: 'Temporal supersession at cosine 0.88 — banded at 1.2 (reasoner-driven); 11 is newer and explicitly replaces 10, which phase 2 resolves.',
  },
  {
    id: 'cross-scope-dup',
    gold_class: 'cross_scope_duplicate',
    member_ids: [16, 17],
    detectable_phase: 0,
    note: 'Identical content in project:kopeng and global. R6: the outcome is a promote-to-global signal, never a collapse — D1.2 detects it as its own signal class.',
  },
  {
    id: 'decay-stale-workaround',
    gold_class: 'decay',
    member_ids: [30],
    detectable_phase: 1.2,
    note: 'Confidence 0.45, unseen for ~5 months → effective strength below the 0.2 archive threshold (D1.1 durability-aware decay). Archive proposal, deterministic-safe.',
  },
  {
    id: 'straddle-collapse-above',
    gold_class: 'duplicate',
    member_ids: [40, 41],
    detectable_phase: 1.2,
    note: 'Cosine 0.96, just above COSINE_DUPLICATE_THRESHOLD (0.95) — must land in the collapse tier (merge, deterministic-safe). A raised threshold flips this gate.',
  },
  {
    id: 'straddle-band-below-collapse',
    gold_class: 'duplicate',
    member_ids: [42, 43],
    detectable_phase: 1.2,
    note: 'Cosine 0.94, just below 0.95 but in the 0.85–0.95 band — must be reasoner-driven, never collapsed. A lowered collapse threshold flips this gate.',
  },
  {
    id: 'straddle-band-above-floor',
    gold_class: 'duplicate',
    member_ids: [44, 45],
    detectable_phase: 1.2,
    note: 'Cosine 0.86, just above NEAR_DUP_BAND_MIN (0.85) — band tier, reasoner-driven. A raised band floor makes this pair vanish and flips the gate.',
  },
  // NOTE deliberately absent: ids 46/47 (cosine 0.84, below the band) are NOT a
  // gold case — they must produce no group and no diff entry. The zero-FP gate
  // plus "every diff entry matches a gold case" is what fails if the band floor
  // ever drops below 0.84.
];

/**
 * Alias-scope fixture set (Phase 5): normalize-equal content (a case variant —
 * byte-identical content cannot coexist on live rows, the `content_hash` unique
 * index forbids it) stored under two casing variants of one client scope.
 * Grouping is closure-sensitive BY DESIGN:
 *   - no `canonicalize` wired  → the pair reads cross-scope → `promote_global`
 *     signal (R6: promote, never collapse);
 *   - alias closure wired      → both sides canonicalize to the canonical scope
 *     → same-scope `exact_dup`, deterministic-safe, and Phase-2 provenance
 *     stamps raw vs effective scope per member.
 * The replay CLI runs BOTH configurations and asserts each outcome, so a broken
 * or silently-dropped closure fails the harness instead of degrading grouping.
 * The scope pair is the shared SYNTHETIC_ALIAS_SCOPE_* definition (one source,
 * also used by the reversibility scenario); the table below goes through the
 * real `buildScopeResolution` validator in the CLI, never a hand-rolled parser.
 */
export const ALIAS_CORPUS: CandidateMemory[] = [
  mem(50, 'Invoices for the acme account are filed under the shared drive.', basis(0), { scope: SYNTHETIC_ALIAS_SCOPE_CANONICAL }),
  mem(51, 'INVOICES for the acme account are filed under the shared drive.', basis(0), { scope: SYNTHETIC_ALIAS_SCOPE_RAW }),
];

/** Gold set when NO canonicalize closure is wired: raw scopes differ → cross-scope signal. */
export const ALIAS_GOLD_RAW: GoldCase[] = [
  {
    id: 'alias-pair-raw',
    gold_class: 'cross_scope_duplicate',
    member_ids: [50, 51],
    detectable_phase: 0,
    note: 'Normalize-equal content (case variant) on client:acme-foods vs client:Acme-Foods with no alias closure — cross-scope on raw strings, promote_global signal.',
  },
];

/** Gold set when the alias closure IS wired: both scopes fold to one canonical → same-scope dup. */
export const ALIAS_GOLD_CANONICAL: GoldCase[] = [
  {
    id: 'alias-pair-canonical',
    gold_class: 'duplicate',
    member_ids: [50, 51],
    detectable_phase: 0,
    note: 'Same pair under an alias closure mapping client:Acme-Foods → client:acme-foods — same-scope exact_dup, deterministic-safe.',
  },
];

/**
 * The raw alias table for the canonical alias pass. The replay CLI resolves it
 * through the REAL `buildScopeResolution` (src/scopes/resolver.ts) — closure
 * and version both come from the resolution, so a fixture entry the production
 * validator would reject cannot silently certify grouping behavior the write
 * path ignores (the Phase-1 four-parsers failure mode).
 */
export const ALIAS_TABLE: Record<string, string> = {
  [SYNTHETIC_ALIAS_SCOPE_RAW]: SYNTHETIC_ALIAS_SCOPE_CANONICAL,
};

/**
 * The anchored half of each decoy pair must never appear in a candidate group or
 * diff; the journal twin is then a singleton, so no group forms at all.
 */
export const ANCHOR_DECOYS = [
  { anchored_id: 12, journal_twin_id: 13, why: 'confidence = 1.0' },
  { anchored_id: 14, journal_twin_id: 15, why: 'is_locked' },
] as const;
