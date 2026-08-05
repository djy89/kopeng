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
 * Embeddings are hand-crafted unit vectors (18-dim), NOT model output — the
 * harness stays zero-model. `blend(i, j, w)` builds a vector whose cosine with
 * `basis(i)` is exactly `w`, so every pairwise similarity below is by design:
 * paraphrase pair at 0.98 (collapse tier), contradiction at 0.90 and preference
 * change at 0.88 (reasoner band), Redis distractors at 0.70 (sub-band — shared
 * vocabulary must NOT be flagged).
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

const DIM = 18;

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
];

/**
 * The anchored half of each decoy pair must never appear in a candidate group or
 * diff; the journal twin is then a singleton, so no group forms at all.
 */
export const ANCHOR_DECOYS = [
  { anchored_id: 12, journal_twin_id: 13, why: 'confidence = 1.0' },
  { anchored_id: 14, journal_twin_id: 15, why: 'is_locked' },
] as const;
