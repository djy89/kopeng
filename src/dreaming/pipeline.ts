/**
 * Dream pipeline (D0.3 scaffold, D1.2 real detection):
 * MemorySource → CandidateSelector → Reasoner → DiffGenerator.
 *
 * The windowed selector is the only selector now; a whole-corpus selector drops in
 * later as a different `CandidateSelector`, not a new system. D1.2 ships real
 * candidate detection (`DuplicateCandidateSelector`: exact + cosine ≥0.95 collapse
 * tier, 0.85–0.95 reasoner-driven band, R6 cross-scope signals, decay) and a real
 * diff (`DeterministicDiffGenerator`). Generation only — nothing here applies a
 * diff; the apply path is D1.3.
 */
import type {
  ConsolidationReasoner, CandidateMemory, ReasonerContext, PairVerdict, ConditionExtraction,
} from './reasoner/reasoner.js';
import type { DreamDiff, DreamDiffEntry } from '../types/types.js';
import { memoryStrength } from './scoring.js';
import { shouldArchive } from '../discovery/confidence.js';
import { evidenceGate, isDifferentReferent } from './gates.js';
import {
  routeClassifiedPair, isConsumableVerdict, pickKeepTarget, readContradictionFlag, referentGuard,
  numericDivergenceGuard,
  retirementNarrationGuard,
} from './contradiction.js';

// pickKeepTarget moved to contradiction.ts in D2.2 (the router needs it and
// importing it back from here would be a runtime cycle); re-exported for
// existing consumers.
export { pickKeepTarget };

/** Supplies the memories in scope for one dream window. */
export interface MemorySource {
  fetch(): Promise<CandidateMemory[]>;
}

/**
 * Why the selector flagged a group (D1.2). Drives the diff generator's
 * change-class/tier mapping; absent on the Phase-0 scaffold selector.
 */
export type CandidateSignal =
  | 'exact_duplicate'      // identical normalized content, same scope → deterministic collapse
  | 'semantic_duplicate'   // cosine >= 0.95, same scope → deterministic collapse
  | 'near_duplicate'       // 0.85 <= cosine < 0.95 → reasoner-driven, NEVER collapsed here
  | 'cross_scope_duplicate'// identical content across scopes → promote-to-global signal (R6)
  | 'decayed'              // effective confidence below archive threshold → archive proposal
  | 'flagged_contradiction'; // D2.2: ingestion-flagged pair → reasoner-driven, queued (contested fallback)

/** A group of memories the selector flagged as worth examining together. */
export interface CandidateGroup {
  kind: 'pair' | 'cluster' | 'single';
  members: CandidateMemory[];
  signal?: CandidateSignal;
  /** Minimum pairwise cosine across members, where embeddings exist. */
  similarity?: number;
}

/** Picks candidate groups out of the window's memories. */
export interface CandidateSelector {
  select(memories: CandidateMemory[]): CandidateGroup[];
}

/** A candidate group plus the reasoner's verdict (null for non-pair groups in the scaffold). */
export interface ClassifiedCandidate {
  group: CandidateGroup;
  verdict: PairVerdict | null;
  /** D2.2: branch extraction, present only when the verdict is a consumable
   *  `conditional` (extraction is async, so it happens in runPipeline, not the
   *  sync diff generator). Null = extraction attempted but declined/failed. */
  condition?: ConditionExtraction | null;
}

/** Turns classified candidates into a reviewable diff. */
export interface DiffGenerator {
  generate(classified: ClassifiedCandidate[]): DreamDiff;
}

export interface PipelineResult {
  memoriesExamined: number;
  candidates: CandidateGroup[];
  diff: DreamDiff;
}

/**
 * Hard-Anchor predicate (amended invariant #8): operator-confirmed truths
 * (`confidence >= 1.0` or `is_locked`) are bypassed; journal-tier (`<1.0`) is in-scope.
 */
export function isAnchored(m: Pick<CandidateMemory, 'is_locked' | 'confidence'>): boolean {
  return m.is_locked || m.confidence >= 1.0;
}

/** Normalize content for cheap near-dup grouping (whitespace + case folded). */
function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parse `metadata.condition_sources` — the provenance a D2.2 branch encoding
 *  carries back to its source memories. */
function conditionSources(m: Pick<CandidateMemory, 'metadata'>): number[] {
  if (!m.metadata) return [];
  try {
    const src = JSON.parse(m.metadata)?.condition_sources;
    return Array.isArray(src) ? src.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

/** True when one memory is the condition-encoding of the other (provenance link). */
function isConditionLinked(a: CandidateMemory, b: CandidateMemory, cache: Map<number, number[]>): boolean {
  return (cache.get(a.id) ?? []).includes(b.id) || (cache.get(b.id) ?? []).includes(a.id);
}

/** Minimal fields needed to classify a duplicate pair outside the pipeline. */
export type DupPairMemory = Pick<CandidateMemory, 'id' | 'scope' | 'confidence' | 'is_locked' | 'metadata'>;

/**
 * Bucket a cosine-≥0.95 pair by what the collapse tier could do with it. The ops
 * corpus-health metric (routes.ts) classifies its duplicate-pair scan through this
 * so the metric can never drift from the selector: `actionable` is the only bucket
 * dreaming proposes on; the rest are by-design exempt (Hard Anchor, R6 cross-scope
 * promote-not-collapse, condition-encoding provenance). Precedence mirrors the
 * selector: anchored members are filtered before any grouping, scope buckets come
 * before the in-scope provenance check.
 */
export type DupPairClass = 'anchored' | 'cross_scope' | 'condition_linked' | 'actionable';

export function classifyDupPair(a: DupPairMemory, b: DupPairMemory): DupPairClass {
  if (isAnchored(a) || isAnchored(b)) return 'anchored';
  if (a.scope !== b.scope) return 'cross_scope';
  if (conditionSources(a).includes(b.id) || conditionSources(b).includes(a.id)) return 'condition_linked';
  return 'actionable';
}

/**
 * Windowed candidate selector (scaffold). Groups non-anchored memories by normalized
 * content — a deterministic near-dup signal that survives the `content_hash` UNIQUE
 * constraint (which already blocks byte-identical dups). Phase 1.2 replaces this with
 * cosine ≥0.95 detection; the interface stays the same.
 */
export class WindowedCandidateSelector implements CandidateSelector {
  select(memories: CandidateMemory[]): CandidateGroup[] {
    const byNorm = new Map<string, CandidateMemory[]>();
    for (const m of memories) {
      if (isAnchored(m)) continue;
      const key = normalizeContent(m.content);
      const bucket = byNorm.get(key);
      if (bucket) bucket.push(m);
      else byNorm.set(key, [m]);
    }
    const groups: CandidateGroup[] = [];
    for (const members of byNorm.values()) {
      if (members.length >= 2) {
        groups.push({ kind: members.length === 2 ? 'pair' : 'cluster', members });
      }
    }
    return groups;
  }
}

/** Emits an empty diff — the Phase-0 baseline, kept for the replay harness. */
export class EmptyDiffGenerator implements DiffGenerator {
  generate(_classified: ClassifiedCandidate[]): DreamDiff {
    return { entries: [] };
  }
}

// ── D1.2: real candidate detection ──

/** Deterministic collapse tier — exact content or cosine at/above this. */
export const COSINE_DUPLICATE_THRESHOLD = 0.95;
/** Lower edge of the reasoner-driven near-dup band (could be a contradiction). */
export const NEAR_DUP_BAND_MIN = 0.85;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Union-find over memory indices — groups transitive duplicate edges. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/**
 * D1.2 selector. Detection tiers over non-anchored memories:
 *
 * 1. Same-scope collapse groups — union-find over edges where two memories have
 *    identical normalized content OR cosine ≥ 0.95. Signal `exact_duplicate`
 *    when every member shares normalized content, else `semantic_duplicate`.
 * 2. Near-dup band — same-scope pairs with 0.85 ≤ cosine < 0.95, not already in
 *    a collapse group. Pairs only (no transitivity — the band is reasoner
 *    territory; it may hide a contradiction or a conditional).
 * 3. Cross-scope duplicates (R6) — identical normalized content spanning ≥2
 *    scopes. A distinct signal for the promote-to-global path, NEVER a collapse.
 *    Conservative on purpose: semantic (non-identical) cross-scope similarity is
 *    not flagged in D1.2.
 * 4. Decay — memories in no other group whose effective confidence (D1.1
 *    durability-aware strength) is below the archive threshold → archive proposal.
 *
 * Memories without embeddings still participate in exact/cross-scope/decay tiers;
 * cosine tiers skip them.
 */
export class DuplicateCandidateSelector implements CandidateSelector {
  constructor(private readonly opts: { now?: () => Date } = {}) {}

  select(memories: CandidateMemory[]): CandidateGroup[] {
    const eligible = memories.filter(m => !isAnchored(m));
    const groups: CandidateGroup[] = [];
    const grouped = new Set<number>(); // memory ids already in a flagged/collapse/band group
    const condSources = new Map(eligible.map(m => [m.id, conditionSources(m)]));

    // ── 0. Ingestion-flagged contradiction pairs (D2.2) ──
    // The strongest signal: an ingestion-time verdict already said "not a
    // duplicate". Claimed first so the pair can't be re-banded or collapsed.
    // An anchored or absent partner produces no group (Hard Anchor wins).
    const byId = new Map(eligible.map(m => [m.id, m]));
    for (const m of eligible) {
      if (grouped.has(m.id)) continue;
      const flag = readContradictionFlag(m.metadata);
      if (!flag) continue;
      const partner = byId.get(flag.with);
      if (!partner || partner.id === m.id || grouped.has(partner.id)) continue;
      const cos = m.embedding && partner.embedding
        ? cosineSimilarity(m.embedding, partner.embedding)
        : undefined;
      groups.push({ kind: 'pair', members: [partner, m], signal: 'flagged_contradiction', similarity: cos });
      grouped.add(m.id);
      grouped.add(partner.id);
    }

    // ── 1. Same-scope collapse groups (exact ∪ cosine ≥ 0.95) ──
    const byScope = new Map<string, CandidateMemory[]>();
    for (const m of eligible) {
      if (grouped.has(m.id)) continue; // flagged pairs are spoken for
      const bucket = byScope.get(m.scope);
      if (bucket) bucket.push(m);
      else byScope.set(m.scope, [m]);
    }

    const bandPairs: Array<{ a: CandidateMemory; b: CandidateMemory; cos: number }> = [];

    for (const scoped of byScope.values()) {
      if (scoped.length < 2) continue;
      const uf = new UnionFind(scoped.length);
      const cosCache = new Map<string, number>();

      for (let i = 0; i < scoped.length; i++) {
        for (let j = i + 1; j < scoped.length; j++) {
          const a = scoped[i], b = scoped[j];
          // A condition-encoded memory is similar to its sources BY CONSTRUCTION
          // (its content contains theirs) — provenance links are never dup edges.
          if (isConditionLinked(a, b, condSources)) continue;
          const exact = normalizeContent(a.content) === normalizeContent(b.content);
          let cos: number | null = null;
          if (a.embedding && b.embedding) {
            cos = cosineSimilarity(a.embedding, b.embedding);
            cosCache.set(`${i}-${j}`, cos);
          }
          if (exact || (cos !== null && cos >= COSINE_DUPLICATE_THRESHOLD)) {
            uf.union(i, j);
          } else if (cos !== null && cos >= NEAR_DUP_BAND_MIN) {
            // Band guards (D2.2): a superseded (deprecated) memory's successor
            // relationship is already recorded, and a pair that both carry
            // last_contradicted already went through conditional resolution —
            // neither is re-litigated.
            if (a.deprecated_at || b.deprecated_at) continue;
            if (a.last_contradicted && b.last_contradicted) continue;
            bandPairs.push({ a, b, cos });
          }
        }
      }

      const components = new Map<number, number[]>();
      for (let i = 0; i < scoped.length; i++) {
        const root = uf.find(i);
        const comp = components.get(root);
        if (comp) comp.push(i);
        else components.set(root, [i]);
      }

      for (const indices of components.values()) {
        if (indices.length < 2) continue;
        const members = indices.map(i => scoped[i]);
        const norms = new Set(members.map(m => normalizeContent(m.content)));
        let minCos: number | undefined;
        for (let x = 0; x < indices.length; x++) {
          for (let y = x + 1; y < indices.length; y++) {
            const key = `${Math.min(indices[x], indices[y])}-${Math.max(indices[x], indices[y])}`;
            const cos = cosCache.get(key);
            if (cos !== undefined) minCos = minCos === undefined ? cos : Math.min(minCos, cos);
          }
        }
        groups.push({
          kind: members.length === 2 ? 'pair' : 'cluster',
          members,
          signal: norms.size === 1 ? 'exact_duplicate' : 'semantic_duplicate',
          similarity: norms.size === 1 ? 1 : minCos,
        });
        for (const m of members) grouped.add(m.id);
      }
    }

    // ── 2. Near-dup band pairs (reasoner-driven; skip anything already collapsed) ──
    for (const { a, b, cos } of bandPairs) {
      if (grouped.has(a.id) || grouped.has(b.id)) continue;
      groups.push({ kind: 'pair', members: [a, b], signal: 'near_duplicate', similarity: cos });
      grouped.add(a.id);
      grouped.add(b.id);
    }

    // ── 3. Cross-scope same-content duplicates (R6 promote signal) ──
    const byNorm = new Map<string, CandidateMemory[]>();
    for (const m of eligible) {
      const key = normalizeContent(m.content);
      const bucket = byNorm.get(key);
      if (bucket) bucket.push(m);
      else byNorm.set(key, [m]);
    }
    for (const members of byNorm.values()) {
      if (members.length < 2) continue;
      if (new Set(members.map(m => m.scope)).size < 2) continue;
      groups.push({
        kind: members.length === 2 ? 'pair' : 'cluster',
        members,
        signal: 'cross_scope_duplicate',
        similarity: 1,
      });
      for (const m of members) grouped.add(m.id);
    }

    // ── 4. Decay (only memories no other tier claimed) ──
    const now = this.opts.now ? this.opts.now() : new Date();
    for (const m of eligible) {
      if (grouped.has(m.id)) continue;
      const strength = memoryStrength(
        {
          confidence: m.confidence,
          observation_count: m.observation_count ?? 1,
          last_seen: m.last_seen ?? null,
          updated_at: m.updated_at,
          type: m.type,
          tags: m.tags,
        },
        now,
      );
      if (shouldArchive(strength)) {
        groups.push({ kind: 'single', members: [m], signal: 'decayed', similarity: strength });
      }
    }

    return groups;
  }
}

/**
 * D1.2 diff generator — turns signal-tagged candidate groups into a reviewable
 * DreamDiff. Mapping (plan §1.2 tiering + R6):
 *
 * - exact_duplicate      → `exact_dup`, deterministic-safe. Identical content needs
 *                          no evidence judgment — gates bypassed.
 * - semantic_duplicate   → `merge`, deterministic-safe IF the evidence gates pass;
 *                          a gate failure DEMOTES to reasoner-driven (queued, not dropped).
 * - near_duplicate       → `merge`, reasoner-driven. Always. The 0.85–0.95 band may
 *                          hide a contradiction/conditional — Phase 2 classifies it.
 * - cross_scope_duplicate→ `promote_global`, deterministic-safe. A signal for the
 *                          cross-scope promotion path (maintenance.ts), never a collapse.
 * - decayed              → `decay`, deterministic-safe archive proposal.
 *
 * Groups without a signal (Phase-0 scaffold selector) produce no entries.
 * `after` carries the machine-actionable proposal for D1.3's apply path.
 */
export class DeterministicDiffGenerator implements DiffGenerator {
  generate(classified: ClassifiedCandidate[]): DreamDiff {
    const entries: DreamDiffEntry[] = [];

    for (const { group, verdict, condition } of classified) {
      const ids = group.members.map(m => m.id);
      const cos = group.similarity !== undefined ? group.similarity.toFixed(3) : 'n/a';

      switch (group.signal) {
        case 'exact_duplicate': {
          const keep = pickKeepTarget(group.members);
          entries.push({
            change_class: 'exact_dup',
            tier: 'deterministic-safe',
            memory_ids: ids,
            rationale: `Identical normalized content (${ids.length} copies in ${group.members[0].scope}). Keep #${keep.id} (highest confidence/most recent), archive the rest.`,
            after: { keep_id: keep.id, archive_ids: ids.filter(id => id !== keep.id) },
          });
          break;
        }
        case 'semantic_duplicate': {
          const keep = pickKeepTarget(group.members);
          // R13 (GATE 1): 0.95 cosine does not separate template text about
          // DIFFERENT referents. A same-template / different-referent group is
          // semantically distinct — never a deterministic collapse; force it
          // down the reasoner/review path regardless of the evidence gates.
          const differentReferent = isDifferentReferent(group.members);
          const gate = evidenceGate(group.members);
          if (!differentReferent && gate.pass) {
            entries.push({
              change_class: 'merge',
              tier: 'deterministic-safe',
              memory_ids: ids,
              rationale: `Semantic duplicates (cosine ${cos} >= ${COSINE_DUPLICATE_THRESHOLD}) in ${group.members[0].scope}. Keep #${keep.id}, archive the rest.`,
              after: { keep_id: keep.id, archive_ids: ids.filter(id => id !== keep.id) },
            });
          } else if (isConsumableVerdict(verdict ?? null)) {
            // D2.2: a gate-demoted ("flagged") semantic pair was classified —
            // route by verdict; a confident `unrelated` suppresses the entry
            // (a high-cosine template pair is not a merge candidate at all).
            const routed = routeClassifiedPair(group, verdict ?? null, condition ?? null);
            if (routed) entries.push(routed);
          } else {
            entries.push({
              change_class: 'merge',
              tier: 'reasoner-driven',
              memory_ids: ids,
              rationale: differentReferent
                ? `Same-template / different-referent discovery memories (cosine ${cos}) — the template shape collides but the referents are disjoint (R13). Not a deterministic collapse; queued for reasoner review.`
                : `Semantic duplicates (cosine ${cos}) but evidence gates failed: ${gate.reasons.join('; ')}. Demoted to reasoner review.`,
              after: { keep_id: keep.id, archive_ids: ids.filter(id => id !== keep.id) },
            });
          }
          break;
        }
        case 'near_duplicate':
        case 'flagged_contradiction': {
          // D2.2: the verdict consumer. Unconsumable verdicts fall back to the
          // Phase-1 entry (band → queued merge; flagged → contested) inside the
          // router; a confident `unrelated` produces no entry.
          const routed = routeClassifiedPair(group, verdict ?? null, condition ?? null);
          if (routed) entries.push(routed);
          break;
        }
        case 'cross_scope_duplicate': {
          const scopes = [...new Set(group.members.map(m => m.scope))];
          entries.push({
            change_class: 'promote_global',
            tier: 'deterministic-safe',
            memory_ids: ids,
            rationale: `Identical content in ${scopes.length} scopes (${scopes.join(', ')}) — promote-to-global signal (R6), never a cross-scope collapse.`,
            after: { promote_scope: 'global', source_ids: ids },
          });
          break;
        }
        case 'decayed': {
          entries.push({
            change_class: 'decay',
            tier: 'deterministic-safe',
            memory_ids: ids,
            rationale: `Effective confidence ${cos} below the 0.2 archive threshold (durability-aware decay, D1.1) — propose archive.`,
            after: { archive_ids: ids },
          });
          break;
        }
        default:
          break; // signal-less scaffold groups: nothing to propose
      }
    }

    return { entries };
  }
}

/**
 * R4b: the pipeline enforces its own deadline — adapter honor of `ctx.timeoutMs`
 * is a convention, not a guarantee. Thrown when the total pass budget is spent
 * or a single reasoner call exceeds its cap; the dream engine's catch marks the
 * dream `failed`.
 */
export class DreamPassDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DreamPassDeadlineError';
  }
}

/** R4b execution bounds, enforced by `runPipeline` itself. */
export interface PipelineLimits {
  /** Total pass budget in ms. Undefined = unbounded (scaffold/test callers). */
  passBudgetMs?: number;
  /** Injectable epoch-ms clock for deterministic tests. */
  now?: () => number;
  /**
   * T6 (whole-corpus): the id-segment reasoner gate. When set, a candidate group
   * that WOULD be classified by the reasoner (band / flagged / gate-demoted
   * semantic / signal-less pair) is only classified — and only kept in the diff —
   * when this predicate returns true (the pair is anchored in the current
   * id-segment). Pairs the gate rejects are dropped entirely (no reasoner call,
   * no Phase-1 fallback entry), so one whole-corpus pass emits at most a
   * segment's worth of reasoner-driven review entries. Deterministic-tier groups
   * (exact_dup / semantic gate-passing merge / cross_scope / decay) are NEVER
   * gated — they run over the whole corpus every pass. Absent (windowed mode,
   * tests) = no gating, exactly the pre-T6 behavior.
   */
  reasonerGate?: (group: CandidateGroup) => boolean;
}

/** Race a reasoner call against a wall-clock cap; reject on timeout. */
function raceDeadline<T>(promise: Promise<T>, capMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DreamPassDeadlineError(`${label} exceeded ${capMs}ms`));
    }, capMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Run the pipeline end-to-end. Pair groups are classified by the reasoner;
 * cluster/non-pair groups pass through unclassified in the scaffold.
 *
 * R4b: each reasoner call is raced against min(ctx.timeoutMs, remaining budget),
 * and the loop aborts once the total budget is spent — a never-resolving adapter
 * cannot push a pass past its deadline.
 */
export async function runPipeline(
  source: MemorySource,
  selector: CandidateSelector,
  reasoner: ConsolidationReasoner,
  diffGen: DiffGenerator,
  ctx: ReasonerContext,
  limits: PipelineLimits = {},
): Promise<PipelineResult> {
  const now = limits.now ?? Date.now;
  const deadlineAt = limits.passBudgetMs !== undefined ? now() + limits.passBudgetMs : null;

  const memories = await source.fetch();
  const candidates = selector.select(memories);

  /**
   * T6 id-segment reasoner gate: is this group a reasoner-tier pair? (Same
   * predicate as `needsReasoner` below.) Used to decide gating WITHOUT consuming
   * the gate on deterministic groups.
   */
  const isReasonerPair = (group: CandidateGroup): boolean =>
    group.kind === 'pair' && group.members.length === 2 && (
      group.signal === undefined
      || group.signal === 'near_duplicate'
      || group.signal === 'flagged_contradiction'
      || (group.signal === 'semantic_duplicate' && !evidenceGate(group.members).pass)
    );

  /** R4b: race one reasoner call against min(ctx.timeoutMs, remaining budget). */
  const bounded = async <T>(call: () => Promise<T>, label: string): Promise<T> => {
    const remainingMs = deadlineAt === null ? null : deadlineAt - now();
    if (remainingMs !== null && remainingMs <= 0) {
      throw new DreamPassDeadlineError(`Pass budget (${limits.passBudgetMs}ms) spent before ${label}`);
    }
    const capMs = remainingMs === null ? ctx.timeoutMs : Math.min(ctx.timeoutMs, remainingMs);
    return raceDeadline(call(), capMs, `Reasoner call (${label})`);
  };

  // LLM-last: deterministic signals (exact/cross-scope/decay and gate-passing
  // semantic dups) are already decided. Classification covers the 0.85–0.95
  // band, ingestion-flagged pairs, gate-DEMOTED semantic pairs ("flagged" by
  // weak evidence), and legacy signal-less pairs (plan §2.2: route near-dups +
  // flagged pairs through classifyPair before any reinforcement decision).
  const classified: ClassifiedCandidate[] = [];
  for (const group of candidates) {
    const needsReasoner = isReasonerPair(group);
    if (!needsReasoner) {
      classified.push({ group, verdict: null });
      continue;
    }
    // T6: a reasoner-tier pair OUTSIDE the current id-segment is dropped whole —
    // no classify call, and (crucially) no Phase-1 fallback entry — so the
    // reasoner-driven review queue per pass is bounded by the segment. It is
    // re-examined on a later pass once the cursor advances to cover its anchor.
    if (limits.reasonerGate && !limits.reasonerGate(group)) {
      continue;
    }
    const [a, b] = group.members;

    // T31 referent guard: same-template discovery pairs with disjoint referents
    // (or numeric-only re-observations) get a deterministic `unrelated` verdict —
    // zero reasoner calls. The router turns `unrelated` into no entry, and a
    // flagged pair's stale flag is consumed after the pass exactly like a
    // reasoner `unrelated` (the existing retire path). Injection-shaped pairs
    // are excluded inside the guard (R15 precedence) and continue to
    // classifyPair + the router's contested containment.
    const guarded = referentGuard(a, b);
    if (guarded) {
      classified.push({ group, verdict: guarded.verdict });
      continue;
    }

    // T33 numeric-divergence guard: identical-except-numbers pairs get a
    // deterministic `preference_change` — zero reasoner calls (the model reads
    // them as duplicates, drill finding 1). The router applies the standard
    // supersession rules: newer supersedes, a timestamp tie downgrades to
    // contested; either way the entry is reasoner-driven and queues.
    const numeric = numericDivergenceGuard(a, b);
    if (numeric) {
      classified.push({ group, verdict: numeric.verdict });
      continue;
    }

    // T34 retirement-narration guard: a newer member narrating its own
    // supersession ("the old X path is retired") reads as duplicate to the
    // model (drill finding 2). Deterministic `preference_change`; the router's
    // supersession rules and the reasoner-driven queue apply as with T33.
    const retirement = retirementNarrationGuard(a, b);
    if (retirement) {
      classified.push({ group, verdict: retirement.verdict });
      continue;
    }

    const verdict = await bounded(() => reasoner.classifyPair(a, b, ctx), `pair ${a.id}/${b.id}`);

    // D2.2: a consumable `conditional` verdict needs its branch extraction here
    // (the diff generator is sync). A null extraction downgrades to contested.
    let condition: ConditionExtraction | null = null;
    if (isConsumableVerdict(verdict) && verdict.relation === 'conditional') {
      condition = await bounded(() => reasoner.extractCondition(a, b, ctx), `extract ${a.id}/${b.id}`);
    }
    classified.push({ group, verdict, condition });
  }

  const diff = diffGen.generate(classified);
  return { memoriesExamined: memories.length, candidates, diff };
}

/** Trivial in-memory MemorySource — handy for the harness and tests. */
export class StaticMemorySource implements MemorySource {
  constructor(private memories: CandidateMemory[]) {}
  async fetch(): Promise<CandidateMemory[]> {
    return this.memories;
  }
}
