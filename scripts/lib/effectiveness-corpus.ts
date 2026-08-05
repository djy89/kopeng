/**
 * Synthetic corpus + gold query set for the dream-effectiveness harness
 * (`npm run dream:effectiveness`).
 *
 * Hand-crafted, zero-model: embeddings are unit vectors in a small basis so every
 * cosine is exact by construction (no ONNX model is loaded). The corpus is shaped
 * so a real dream pass has genuine work to do AND retrieval quality is measurable:
 *
 *   - TOPIC anchors: one canonical memory per topic, on its basis vector. Each
 *     gold query targets a topic and should retrieve its anchor (+ any near twins).
 *   - EXACT DUPS: whitespace/case variants of an anchor — same normalized content,
 *     same embedding. Dreaming's `exact_dup` tier collapses these (archives the
 *     redundant copies, keeps one). Retrieval must HOLD: the surviving twin still
 *     answers the query, so removing the noise copies should not hurt P@k/NDCG.
 *   - DECAYED: low-confidence memories unseen for ~5 months → effective strength
 *     below the 0.2 archive threshold. Dreaming's `decay` tier archives them.
 *     These are NOT relevant to any gold query, so archiving them is pure cleanup.
 *   - DISTRACTORS: unique off-topic facts that must never be flagged as dups.
 *
 * The dataset is deliberately tiny and readable. It proves the SHAPE of the claim
 * ("dreaming shrinks the corpus and drops dup-pairs while retrieval holds"), not a
 * production-scale number — see the honesty notes in the harness.
 */

const DIM = 24;

export function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

/** Unit vector with cosine exactly `w` against basis(i); orthogonal remainder on j. */
export function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}

export interface SeedMemory {
  /** Stable handle used by gold queries to name relevant rows (DB ids are assigned at store time). */
  key: string;
  content: string;
  scope: string;
  confidence: number;
  embedding: Float32Array;
  last_seen?: string;
  updated_at?: string;
  /** Documentation only — which planted role this row plays. */
  role: 'anchor' | 'exact_dup' | 'paraphrase' | 'decayed' | 'distractor';
}

export interface GoldQuery {
  id: string;
  /** Hand-crafted query embedding (zero-model). */
  embedding: Float32Array;
  /** Keys (not ids) of the memories that should be retrieved. Resolved to ids at runtime. */
  relevant_keys: string[];
  note: string;
}

/** Pinned clock the decay fixtures are written against. */
export const EFFECTIVENESS_CLOCK = Date.parse('2026-06-15T08:00:00Z');

function mem(
  key: string,
  content: string,
  embedding: Float32Array,
  role: SeedMemory['role'],
  opts: Partial<Pick<SeedMemory, 'scope' | 'confidence' | 'last_seen' | 'updated_at'>> = {},
): SeedMemory {
  return {
    key,
    content,
    embedding,
    role,
    scope: opts.scope ?? 'project:demo',
    confidence: opts.confidence ?? 0.7,
    last_seen: opts.last_seen,
    updated_at: opts.updated_at,
  };
}

/**
 * The corpus. Topics 0–5 are answerable; each has an anchor and (for some) exact
 * dup copies that dreaming will collapse. Topics 6–9 are unique distractors.
 */
export const EFFECTIVENESS_CORPUS: SeedMemory[] = [
  // Topic 0 — deploy command. Anchor + 2 exact dups (case/whitespace variants).
  mem('deploy', 'Deploy the service with `npm run deploy` from the repo root.', basis(0), 'anchor'),
  mem('deploy-dup1', 'Deploy the service with `npm run deploy`  from the repo root.', basis(0), 'exact_dup'),
  mem('deploy-dup2', 'DEPLOY THE SERVICE WITH `NPM RUN DEPLOY` FROM THE REPO ROOT.', basis(0), 'exact_dup'),

  // Topic 1 — test timeout. Anchor + 1 exact dup.
  mem('timeout', 'The test suite timeout is 30 seconds to allow for model loading.', basis(1), 'anchor'),
  mem('timeout-dup1', 'The test suite timeout is 30 seconds to allow for model loading. ', basis(1), 'exact_dup'),

  // Topic 2 — embedding model. Anchor + a paraphrase at cosine 0.98 (semantic dup).
  mem('embed', 'Embeddings use all-MiniLM-L6-v2, a 384-dimensional model.', basis(2), 'anchor'),
  mem('embed-para', 'The embedding model is all-MiniLM-L6-v2 with 384 dimensions.', blend(2, 3, 0.98), 'paraphrase'),

  // Topic 3 — API port (unique anchor, no dup).
  mem('port', 'The REST API listens on port 3200.', basis(4), 'anchor'),

  // Topic 4 — backup schedule (unique anchor, no dup).
  mem('backup', 'Database backups run nightly at 02:00 operator-local time.', basis(5), 'anchor'),

  // Topic 5 — VPN host (unique anchor, no dup).
  mem('vpn', 'The production host is 192.0.2.10 on the WireGuard network.', basis(6), 'anchor'),

  // Distractors — unique facts, must never be flagged as duplicates of each other.
  mem('redis', 'Redis stores ephemeral context key-value pairs.', basis(7), 'distractor'),
  mem('neo4j', 'Neo4j stores the entity graph extracted from memory content.', basis(8), 'distractor'),
  mem('minio', 'MinIO stores artifacts via the S3-compatible API.', basis(9), 'distractor'),
  mem('ratelimit', 'Rate limiting uses @fastify/rate-limit on every REST route.', basis(10), 'distractor'),

  // Decayed — confidence 0.45, unseen ~5 months → effective strength < 0.2.
  // Off-topic for every gold query, so dreaming archiving them is pure cleanup.
  mem('stale1', 'Workaround for the legacy importer crash: rerun with --skip-validation.', basis(20),
    'decayed', { confidence: 0.45, last_seen: '2026-01-05T12:00:00Z', updated_at: '2026-01-05T12:00:00Z' }),
  mem('stale2', 'Old build flag --legacy-bundler is no longer needed after the toolchain upgrade.', basis(21),
    'decayed', { confidence: 0.4, last_seen: '2026-01-02T12:00:00Z', updated_at: '2026-01-02T12:00:00Z' }),
];

/**
 * Gold queries. Relevance is FACT-LEVEL: the relevant memory is the canonical
 * statement of the fact (the anchor), NOT its redundant copies. This is the
 * honest definition for measuring dedup — before dreaming, the noise copies
 * crowd the canonical hit out of the top ranks (depressing precision/NDCG);
 * after dreaming archives them, the canonical memory should still rank top, so
 * rank quality (NDCG / MRR) HOLDS or IMPROVES while the noise disappears.
 * Counting the soon-to-be-archived copies as relevant would instead PENALISE
 * the very cleanup we want to reward — that is the wrong thing to measure.
 */
export const EFFECTIVENESS_GOLD: GoldQuery[] = [
  {
    id: 'q-deploy', embedding: basis(0), relevant_keys: ['deploy'],
    note: 'Deploy command — canonical anchor; its 2 exact-dup copies are noise dreaming removes.',
  },
  {
    id: 'q-timeout', embedding: basis(1), relevant_keys: ['timeout'],
    note: 'Test timeout — canonical anchor; its exact-dup copy is noise dreaming removes.',
  },
  {
    id: 'q-embed', embedding: basis(2), relevant_keys: ['embed'],
    note: 'Embedding model — canonical anchor; the 0.98-cosine paraphrase queues as a merge (not auto-applied).',
  },
  {
    id: 'q-port', embedding: basis(4), relevant_keys: ['port'],
    note: 'API port — single anchor, no duplicates.',
  },
  {
    id: 'q-backup', embedding: basis(5), relevant_keys: ['backup'],
    note: 'Backup schedule — single anchor.',
  },
  {
    id: 'q-vpn', embedding: basis(6), relevant_keys: ['vpn'],
    note: 'VPN host — single anchor.',
  },
];
