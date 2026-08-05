/**
 * Classify-pair eval set for the D2.1 reasoner prompt evals (plan §2.1
 * "prototype first") and the D2.2 NLI-vs-LLM comparison.
 *
 * Sources:
 *  - the D0.7 gold corpus's reasoner-band cases (paraphrase dup, contradiction,
 *    preference change, sub-band distractor);
 *  - the R13 class (GATE 1 finding): a reconstruction of the band-pair shape
 *    that caused the original incident — auto-discovery hot-file template text
 *    about two DIFFERENT files at high cosine. The classifier must call this
 *    'unrelated', never 'duplicate'. Synthetic variants probe the same failure
 *    mode both ways (different referent → unrelated; same referent, updated
 *    stats → duplicate). Per R12, planted/synthetic data is the validation
 *    method — organic candidates surfaced by rotation are near-zero.
 *
 *  All memory content below is INVENTED (synthetic referents, demo paths) —
 *  see CONTRIBUTING "fixture content is invented, never copied".
 *
 * Scoring contract: `expected` is the gold answer; `acceptable` also counts
 * as a pass (review-queue-equivalent outcomes); `forbidden` is a hard fail —
 * the misclassification that would corrupt memory if D2.2 acted on it.
 */
import type { CandidateMemory, PairRelation } from '../../../src/dreaming/reasoner/reasoner.js';

export interface EvalPair {
  id: string;
  /** Gold answer. */
  expected: PairRelation;
  /** Alternate verdicts that still count as a pass (same downstream handling). */
  acceptable?: PairRelation[];
  /** Verdicts that are hard failures (would corrupt memory downstream). */
  forbidden: PairRelation[];
  a: CandidateMemory;
  b: CandidateMemory;
  note: string;
}

let nextId = 9000;
function mem(
  content: string,
  opts: Partial<Pick<CandidateMemory, 'scope' | 'created_at' | 'updated_at' | 'last_seen' | 'tags'>> = {},
): CandidateMemory {
  return {
    id: nextId++,
    content,
    content_hash: null,
    summary: null,
    tags: opts.tags ?? [],
    scope: opts.scope ?? 'project:kopeng',
    confidence: 0.7,
    is_locked: false,
    created_at: opts.created_at ?? '2026-05-20T12:00:00Z',
    updated_at: opts.updated_at ?? opts.created_at ?? '2026-05-20T12:00:00Z',
    embedding: null,
    metadata: null,
    last_seen: opts.last_seen ?? null,
    observation_count: 1,
  };
}

const HOTFILE_TAGS = ['auto-discovered', 'hot_file'];

export const EVAL_PAIRS: EvalPair[] = [
  {
    id: 'dup-paraphrase',
    expected: 'duplicate',
    forbidden: ['unrelated', 'contested'],
    a: mem('The embedding model is all-MiniLM-L6-v2 and produces 384-dimensional vectors.'),
    b: mem('Embeddings come from all-MiniLM-L6-v2, which outputs 384-dim vectors.'),
    note: 'Gold corpus 6/7 — same fact, different wording (cosine 0.98 tier).',
  },
  {
    id: 'dup-reworded-command',
    expected: 'duplicate',
    forbidden: ['unrelated', 'contested'],
    a: mem('Deploy with `npm run deploy` from the repo root.'),
    b: mem('Run `npm run deploy` at the repository root to deploy.'),
    note: 'Second wording-variant duplicate.',
  },
  {
    id: 'contradiction-deploy-day',
    expected: 'contested',
    forbidden: ['duplicate', 'unrelated'],
    a: mem('Deploys to the staging cluster happen on Fridays after 5pm.'),
    b: mem('Never deploy to the staging cluster on a Friday.'),
    note: 'Gold corpus 8/9 — direct contradiction, no temporal distinguisher.',
  },
  {
    id: 'preference-change-indentation',
    expected: 'preference_change',
    forbidden: ['duplicate', 'unrelated'],
    a: mem('Operator prefers tabs for indentation in this repo.'),
    b: mem('Operator prefers 2-space indentation in this repo (changed from tabs).',
      { created_at: '2026-06-05T09:00:00Z' }),
    note: 'Gold corpus 10/11 — explicit "changed from" supersession marker.',
  },
  {
    id: 'conditional-db-backend',
    expected: 'conditional',
    acceptable: ['unrelated'],
    forbidden: ['duplicate', 'contested'],
    a: mem('Use PostgreSQL as the database backend in production deployments.'),
    b: mem('Use SQLite as the database backend for local development and tests.'),
    note: 'Both true under different conditions (env split) — the extractCondition class. "unrelated" is a miss but harmless (no-op).',
  },
  {
    id: 'preference-change-pnpm-bun',
    expected: 'preference_change',
    acceptable: ['contested'],
    forbidden: ['duplicate', 'unrelated'],
    a: mem('Use pnpm for installs in this repo.'),
    b: mem('Use bun for installs in this repo (changed from pnpm).',
      { created_at: '2026-06-05T09:00:00Z' }),
    note: 'The D2.2 verify case (plan §2.2): must produce supersession (or contested) — NEVER a silent reinforce, so "duplicate" is the corrupting verdict.',
  },
  {
    id: 'conditional-node-version',
    expected: 'conditional',
    acceptable: ['unrelated'],
    forbidden: ['duplicate', 'contested'],
    a: mem('Use Node 18 for the legacy billing service.'),
    b: mem('Use Node 22 for all newly created services.'),
    note: 'Second conditional (service split) — exercises extractCondition beyond the env-split phrasing.',
  },
  {
    id: 'distractor-redis',
    expected: 'unrelated',
    forbidden: ['duplicate'],
    a: mem('Redis stores ephemeral context key-value pairs.'),
    b: mem('Redis is optional and gated by REDIS_ENABLED in .env.'),
    note: 'Gold corpus 20/21 — shared vocabulary, different facts (cosine 0.70 sub-band).',
  },
  {
    id: 'r13-live-hotfile-pair',
    expected: 'unrelated',
    forbidden: ['duplicate'],
    a: mem(
      'The file C:\\Users\\dev\\Desktop\\Apps\\acme-platform\\docs\\notes\\TICKETS.md is a frequent edit target in this project, modified 12 times across 1 session(s).',
      { scope: 'project:acme-backend', tags: HOTFILE_TAGS },
    ),
    b: mem(
      'The file C:\\Users\\dev\\Desktop\\Apps\\acme-platform\\docs\\notes\\SESSIONS.md is a frequent edit target in this project, modified 5 times across 1 session(s).',
      { scope: 'project:acme-backend', tags: HOTFILE_TAGS },
    ),
    note: 'R13: reconstruction of the incident band-pair shape — identical template, two DIFFERENT files at high cosine. "duplicate" here is the incident class.',
  },
  {
    id: 'r13-synthetic-hotfile-different-files',
    expected: 'unrelated',
    forbidden: ['duplicate'],
    a: mem(
      'The file C:\\Users\\dev\\Desktop\\Apps\\demo\\src\\api\\routes.ts is a frequent edit target in this project, modified 9 times across 2 session(s).',
      { tags: HOTFILE_TAGS },
    ),
    b: mem(
      'The file C:\\Users\\dev\\Desktop\\Apps\\demo\\src\\api\\handlers.ts is a frequent edit target in this project, modified 9 times across 2 session(s).',
      { tags: HOTFILE_TAGS },
    ),
    note: 'R13 synthetic: identical template AND identical counts, different files — referent is the only distinguisher.',
  },
  {
    id: 'r13-control-same-file-updated-count',
    expected: 'duplicate',
    acceptable: ['preference_change'],
    forbidden: ['unrelated', 'contested'],
    a: mem(
      'The file C:\\Users\\dev\\Desktop\\Apps\\demo\\src\\api\\routes.ts is a frequent edit target in this project, modified 9 times across 2 session(s).',
      { tags: HOTFILE_TAGS },
    ),
    b: mem(
      'The file C:\\Users\\dev\\Desktop\\Apps\\demo\\src\\api\\routes.ts is a frequent edit target in this project, modified 14 times across 4 session(s).',
      { created_at: '2026-06-08T12:00:00Z', tags: HOTFILE_TAGS },
    ),
    note: 'R13 control (discrimination, not blanket "templates are unrelated"): SAME file, updated stats — a true duplicate/update.',
  },
  {
    id: 'r13-command-template-different-commands',
    expected: 'unrelated',
    forbidden: ['duplicate'],
    a: mem('The command `npm test` is frequently used in this project (15 times across 3 sessions). Consider automating this workflow.',
      { tags: ['auto-discovered', 'repeated_command'] }),
    b: mem('The command `npm run build` is frequently used in this project (12 times across 3 sessions). Consider automating this workflow.',
      { tags: ['auto-discovered', 'repeated_command'] }),
    note: 'R13 variant on the repeated-command template: different commands → unrelated.',
  },
];
