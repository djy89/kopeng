/**
 * Static surfacing module (C1.2 / T12).
 *
 * Maps a natural-language prompt → capped, precision-filtered, class-labelled
 * candidate tools / skills / conventions drawn from the operator's index
 * memories (`client:claude-tool`, `client:claude-skill`,
 * `client:claude-convention`, and optionally a `project:<name>` scope for
 * per-project conventions).
 *
 * Runs IN-PROCESS against the stores — never self-HTTP.
 * No reranking (latency budget); precision enforced by score floor + per-class caps.
 */

import type { IMemoryStore, IVectorSearch } from '../database/interfaces.js';
import { CLAUDE_INDEX_TAG, SKILL_TAG } from '../types/types.js';
import { isScopeForm, isGlobalScope } from '../scopes/resolver.js';
import { embed, isEmbedderReady } from '../embeddings/embedder.js';
import logger from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type SurfaceClass = 'tool' | 'skill' | 'convention';
export type Binding = 'hard' | 'advisory';

/** One surfaced suggestion. */
export interface SurfaceItem {
  class: SurfaceClass;
  /** Stable external key from metadata (e.g. `tool:kopeng`, `skill:handoff`). */
  key: string;
  /** Human-readable name. */
  title: string;
  /** Full memory content (the importer sets "Name: description"). */
  content: string;
  /** Final relevance score (semantic cosine or RRF blend). */
  score: number;
  /**
   * Binding strength.
   * `hard` — act-or-explain (tools + skills).
   * `advisory` — consider it (conventions).
   */
  binding: Binding;
}

export interface SurfaceResult {
  tools: SurfaceItem[];
  skills: SurfaceItem[];
  conventions: SurfaceItem[];
}

export interface SurfaceCaps {
  tools?: number;
  skills?: number;
  conventions?: number;
}

export interface SurfaceDeps {
  queries: IMemoryStore;
  embeddingIndex: IVectorSearch;
  /**
   * T46 alias-table canonicalization (Phase 4 T8). Absent ⇒ identity — the
   * project lanes search the raw request scopes, byte-identical to pre-T8.
   */
  canonicalizeScope?: (s: string) => Promise<string>;
  /** Alias-group expansion (canonical + every alias of it). Absent ⇒ raw only. */
  expandScope?: (s: string) => Promise<string[]>;
}

export interface SurfaceRequest {
  prompt: string;
  /** Optional `project:<name>` scope to also pull per-project conventions. */
  projectScope?: string;
  /**
   * Declared anchor scopes (P4 `.kopeng.json` markers), additive to
   * projectScope — each feeds the procedural-skill and per-project
   * convention lanes after canonicalization + alias expansion.
   */
  anchorScopes?: string[];
  caps?: SurfaceCaps;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CAPS: Required<SurfaceCaps> = {
  tools: 3,
  skills: 2,
  conventions: 2,
};

/** Per-class RRF score floors — drop weak candidates before applying caps. */
const SCORE_FLOOR = 0.015; // RRF scores are small; this drops non-hits cleanly

/** How many candidates to pull per scope before applying floor + cap. */
const FETCH_PER_SCOPE = 10;

/** RRF fusion constant (mirrors recall path). */
const K = 60;

/** Hard cap on the resolved project-lane scope set (mirrors the P4 anchor bound). */
const PROJECT_LANE_MAX_SCOPES = 16;

// ── Core search helpers ────────────────────────────────────────────────────

/**
 * Parse metadata JSON blob from a memory row.
 * Safe — never throws.
 */
function parseMeta(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Extract a stable external key and a title from a memory.
 * The importer stores `external_key` in metadata and `name` in metadata.
 * Falls back to parsing the content ("Name: …") or using the memory id.
 */
function extractKeyAndTitle(
  id: number,
  content: string,
  metadata: string,
): { key: string; title: string } {
  const meta = parseMeta(metadata);

  // Stable per-memory fallback — never time-based (a per-call key breaks the T13
  // acceptance metric, which joins on `key`). Catalog memories always carry
  // external_key; this only guards a malformed row.
  const key =
    typeof meta.external_key === 'string' ? meta.external_key : `mem:${id}`;

  const title =
    typeof meta.name === 'string' && meta.name.length > 0
      ? meta.name
      : (() => {
          // Try to parse "Name: description" content format
          const colonIdx = content.indexOf(':');
          return colonIdx > 0 ? content.slice(0, colonIdx).trim() : content.slice(0, 64).trim();
        })();

  return { key, title };
}

/**
 * Run a lightweight semantic + FTS hybrid for a single scope.
 * Returns candidates sorted by RRF score descending, score-floored.
 */
async function searchScope(
  deps: SurfaceDeps,
  queryVec: Float32Array,
  ftsQuery: string | null,
  scope: string,
  scoreFloor: number,
  indexTag: string = CLAUDE_INDEX_TAG,
): Promise<Array<{ id: number; score: number }>> {
  const { queries, embeddingIndex } = deps;

  // Pre-filter by scope AND an index tag. The catalog lanes use CLAUDE_INDEX_TAG
  // (the curated ~/.claude catalog). The procedural-skill lane uses SKILL_TAG —
  // auto-discovered workflow memories, NOT hand-curated; they carry a derived
  // external_key and surface as ADVISORY (see the materialise call below). Without
  // this pre-filter, project:<name> pulls in the whole project corpus, and
  // client:claude-tool mixes in legacy ad-hoc tool memories (which lack external_key).
  const candidateIds = await queries.getFilteredIds({
    scope,
    tags: [indexTag],
    include_archived: false,
  });

  if (candidateIds.length === 0) return [];

  const candidateSet = new Set(candidateIds);

  // Parallel: semantic + FTS
  const [vectorResults, ftsRows] = await Promise.all([
    embeddingIndex.isReady
      ? embeddingIndex.search(queryVec, candidateIds, FETCH_PER_SCOPE * 3)
      : Promise.resolve([] as Array<{ id: number; score: number }>),
    ftsQuery
      ? queries
          .searchFts(ftsQuery, FETCH_PER_SCOPE * 3)
          .then(rows => rows.filter(r => candidateSet.has(r.rowid)))
          .catch(() => [] as Array<{ rowid: number; rank: number }>)
      : Promise.resolve([] as Array<{ rowid: number; rank: number }>),
  ]);

  // RRF merge
  const rrfScores = new Map<number, number>();
  vectorResults.forEach((r, i) => {
    rrfScores.set(r.id, (rrfScores.get(r.id) ?? 0) + 1 / (K + i + 1));
  });
  (ftsRows as Array<{ rowid: number; rank: number }>).forEach((r, i) => {
    rrfScores.set(r.rowid, (rrfScores.get(r.rowid) ?? 0) + 1 / (K + i + 1));
  });

  // Sort + floor
  return [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score >= scoreFloor)
    .map(([id, score]) => ({ id, score }));
}

/**
 * Build a FTS OR query from the prompt.
 * Returns null when no useful tokens survive (short prompt / all stopwords).
 */
function promptToFtsQuery(prompt: string): string | null {
  const STOPWORDS = new Set([
    'about', 'also', 'back', 'been', 'both', 'come', 'does', 'done',
    'each', 'else', 'even', 'find', 'from', 'give', 'good', 'have',
    'help', 'here', 'high', 'into', 'just', 'keep', 'kind', 'know',
    'like', 'look', 'make', 'many', 'more', 'most', 'move', 'much',
    'need', 'next', 'only', 'open', 'over', 'part', 'play', 'plus',
    'same', 'seem', 'show', 'side', 'some', 'such', 'take', 'than',
    'that', 'them', 'then', 'there', 'they', 'this', 'time', 'turn',
    'under', 'upon', 'used', 'very', 'want', 'ways', 'well', 'what',
    'when', 'where', 'which', 'while', 'will', 'with', 'work', 'would',
    'your',
  ]);

  const tokens = [
    ...new Set(
      (prompt.toLowerCase().match(/\b[a-z][a-z]{3,}\b/g) ?? []).filter(
        t => !STOPWORDS.has(t),
      ),
    ),
  ];

  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 8)
    .map(t => `"${t}"`)
    .join(' OR ');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Rank and cap surfacing candidates for the given prompt.
 *
 * Fan-out per-scope (parallel), apply per-class score floor + caps, dedup
 * across scopes, return class-labelled arrays with binding strength.
 *
 * Safe to call when the embedder is not ready — falls back to FTS-only, still
 * returns valid (possibly empty) results. Never throws.
 */
export async function surface(
  deps: SurfaceDeps,
  req: SurfaceRequest,
): Promise<SurfaceResult> {
  const empty: SurfaceResult = { tools: [], skills: [], conventions: [] };

  try {
    if (!req.prompt || req.prompt.trim().length === 0) return empty;

    const caps: Required<SurfaceCaps> = {
      tools: req.caps?.tools ?? DEFAULT_CAPS.tools,
      skills: req.caps?.skills ?? DEFAULT_CAPS.skills,
      conventions: req.caps?.conventions ?? DEFAULT_CAPS.conventions,
    };

    // Embed once; reuse across all scope searches
    let queryVec: Float32Array;
    if (isEmbedderReady()) {
      queryVec = await embed(req.prompt);
    } else {
      // Fall back to zero vector — FTS will still run
      queryVec = new Float32Array(384);
    }

    const ftsQuery = promptToFtsQuery(req.prompt);

    // Phase 4 (T8): resolve the project-lane scope set — projectScope plus the
    // declared anchor scopes, each canonicalized through the alias table and
    // expanded to its alias group so rows on either side of a scope migration
    // stay reachable. Invalid and global entries are silently skipped (never a
    // 400), and every step fails open per-scope to the raw string so a broken
    // alias table can't blank the lanes. Catalog scopes are untouched.
    const rawScopes = [req.projectScope, ...(req.anchorScopes ?? [])]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .filter(s => isScopeForm(s) && !isGlobalScope(s));
    const resolvedScopes: string[] = [];
    const seenScopes = new Set<string>();
    for (const raw of rawScopes) {
      try {
        const canonical = deps.canonicalizeScope ? await deps.canonicalizeScope(raw) : raw;
        const group = deps.expandScope ? await deps.expandScope(canonical) : [raw];
        for (const s of group) {
          if (!seenScopes.has(s)) { seenScopes.add(s); resolvedScopes.push(s); }
        }
      } catch {
        if (!seenScopes.has(raw)) { seenScopes.add(raw); resolvedScopes.push(raw); }
      }
      if (resolvedScopes.length >= PROJECT_LANE_MAX_SCOPES) break;
    }
    const projectLaneScopes = resolvedScopes.slice(0, PROJECT_LANE_MAX_SCOPES);

    // Convention scopes: always client:claude-convention; add the resolved
    // project-lane scopes for per-project conventions.
    const conventionScopes: string[] = ['client:claude-convention', ...projectLaneScopes];

    // Procedural-skill scopes: auto-discovered workflow ("skill") memories are
    // ALWAYS project-scoped (discovery writes scope:project:<name>), tagged
    // SKILL_TAG — distinct from the client:claude-skill catalog lane. No global
    // producer exists, so we don't search 'global' (avoids surfacing arbitrary
    // global memories that merely share the tag). Empty resolved set ⇒ the
    // lane is skipped (the pre-T8 "no projectScope" rule, generalized).
    const proceduralSkillScopes = projectLaneScopes;

    // Fan out all scope searches in parallel
    const [
      toolCandidates,
      catalogSkillCandidates,
      proceduralSkillSets,
      conventionCandidateSets,
    ] = await Promise.all([
      searchScope(deps, queryVec, ftsQuery, 'client:claude-tool', SCORE_FLOOR),
      searchScope(deps, queryVec, ftsQuery, 'client:claude-skill', SCORE_FLOOR),
      Promise.all(
        proceduralSkillScopes.map(scope =>
          searchScope(deps, queryVec, ftsQuery, scope, SCORE_FLOOR, SKILL_TAG),
        ),
      ),
      Promise.all(
        conventionScopes.map(scope =>
          searchScope(deps, queryVec, ftsQuery, scope, SCORE_FLOOR),
        ),
      ),
    ]);

    // Procedural skill ids surface as ADVISORY (auto-derived, unconfirmed) even
    // though they share the 'skill' class with the curated catalog (which is hard).
    const proceduralSkillIds = new Set<number>(
      proceduralSkillSets.flat().map(c => c.id),
    );

    // Merge catalog + procedural skills into one class (dedup by id, keep max score).
    const skillById = new Map<number, number>();
    for (const { id, score } of catalogSkillCandidates) {
      if (!skillById.has(id) || skillById.get(id)! < score) skillById.set(id, score);
    }
    for (const candidates of proceduralSkillSets) {
      for (const { id, score } of candidates) {
        if (!skillById.has(id) || skillById.get(id)! < score) skillById.set(id, score);
      }
    }
    const skillCandidates = [...skillById.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({ id, score }));

    // Merge convention candidates from all convention scopes (dedup by id)
    const conventionById = new Map<number, number>();
    for (const candidates of conventionCandidateSets) {
      for (const { id, score } of candidates) {
        if (!conventionById.has(id) || conventionById.get(id)! < score) {
          conventionById.set(id, score);
        }
      }
    }
    const conventionCandidates = [...conventionById.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({ id, score }));

    // Global dedup: a memory id should only appear in ONE class
    const seenIds = new Set<number>();

    /**
     * Materialise the top-N candidates for a class. `bindingFor`, when given,
     * overrides the default binding per id (used to mark procedural skills
     * advisory while catalog skills in the same class stay hard).
     */
    async function materialise(
      candidates: Array<{ id: number; score: number }>,
      cls: SurfaceClass,
      binding: Binding,
      cap: number,
      bindingFor?: (id: number) => Binding | undefined,
    ): Promise<SurfaceItem[]> {
      const items: SurfaceItem[] = [];
      for (const { id, score } of candidates) {
        if (items.length >= cap) break;
        if (seenIds.has(id)) continue;

        const mem = await deps.queries.get(id);
        if (!mem) continue;

        const { key, title } = extractKeyAndTitle(mem.id, mem.content, mem.metadata);

        seenIds.add(id);
        items.push({ class: cls, key, title, content: mem.content, score, binding: bindingFor?.(id) ?? binding });
      }
      return items;
    }

    // Materialise per class SEQUENTIALLY — tools first (highest priority for
    // dedup). R-4 (team round): under Promise.all the three loops interleaved,
    // and the check-then-act on `seenIds` (the add lands only after an awaited
    // queries.get) let a row reachable by two classes — e.g. a project-lane
    // row tagged both `claude-index` and `skill` — surface in both. The
    // per-scope searches above stay parallel; only this phase is serialized.
    const tools = await materialise(toolCandidates, 'tool', 'hard', caps.tools);
    const skills = await materialise(skillCandidates, 'skill', 'hard', caps.skills,
      id => (proceduralSkillIds.has(id) ? 'advisory' : undefined));
    const conventions = await materialise(conventionCandidates, 'convention', 'advisory', caps.conventions);

    return { tools, skills, conventions };
  } catch (err) {
    logger.warn('[surface] surfacing error — returning empty:', err);
    return empty;
  }
}
