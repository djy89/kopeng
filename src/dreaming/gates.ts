/**
 * Hard hallucination gates (D1.2, plan §1.2).
 *
 * Before the dream layer treats an observation-derived pattern as safe to
 * consolidate deterministically, its combined evidence must show real-world
 * diversity: a single-session burst hammering one input is not knowledge.
 *
 * Scope: the gates judge EVIDENCE (the `evidence_snapshot` auto-discovery
 * writes into memory metadata — see `src/discovery/heuristics.ts`). Memories
 * with no evidence snapshot (operator-written notes, references) pass
 * trivially — they are not observation-derived, so burst hallucination does
 * not apply; exact-content duplicates also bypass the gates entirely because
 * collapsing byte-identical text needs no evidence judgment.
 *
 * A gate failure does not DROP a candidate — the diff generator demotes it
 * from `deterministic-safe` to `reasoner-driven` so it queues for review.
 */
import type { CandidateMemory } from './reasoner/reasoner.js';
import type { EvidenceEntry } from '../types/types.js';

export const MIN_DISTINCT_SESSIONS = 3;
export const MIN_DISTINCT_INPUTS = 2;
export const MIN_TEMPORAL_SPAN_HOURS = 24;

export interface GateResult {
  pass: boolean;
  /** Human-readable reasons for failure; empty when passing. */
  reasons: string[];
  /** Total evidence entries examined (0 = no evidence → trivial pass). */
  evidence_count: number;
}

/** Pull evidence_snapshot entries out of a memory's metadata JSON, if any. */
export function extractEvidence(memory: CandidateMemory): EvidenceEntry[] {
  if (!memory.metadata) return [];
  try {
    const parsed = JSON.parse(memory.metadata);
    const snapshot = parsed?.evidence_snapshot;
    if (!Array.isArray(snapshot)) return [];
    return snapshot.filter(
      (e): e is EvidenceEntry => e && typeof e === 'object' && typeof e.session_id === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Evaluate the hallucination gates over a candidate group's combined evidence.
 * ≥3 distinct sessions, ≥2 distinct inputs, ≥24h temporal span.
 */
export function evidenceGate(members: CandidateMemory[]): GateResult {
  const evidence = members.flatMap(extractEvidence);
  if (evidence.length === 0) {
    return { pass: true, reasons: [], evidence_count: 0 };
  }

  const reasons: string[] = [];

  const sessions = new Set(evidence.map(e => e.session_id));
  if (sessions.size < MIN_DISTINCT_SESSIONS) {
    reasons.push(`only ${sessions.size} distinct session(s) — need >= ${MIN_DISTINCT_SESSIONS} (burst risk)`);
  }

  const inputs = new Set(evidence.map(e => e.input_hash).filter(Boolean));
  if (inputs.size < MIN_DISTINCT_INPUTS) {
    reasons.push(`only ${inputs.size} distinct input(s) — need >= ${MIN_DISTINCT_INPUTS} (low diversity)`);
  }

  const times = evidence
    .map(e => new Date(e.at).getTime())
    .filter(t => !Number.isNaN(t));
  const spanHours = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0;
  if (spanHours < MIN_TEMPORAL_SPAN_HOURS) {
    reasons.push(`temporal span ${spanHours.toFixed(1)}h — need >= ${MIN_TEMPORAL_SPAN_HOURS}h (burst risk)`);
  }

  return { pass: reasons.length === 0, reasons, evidence_count: evidence.length };
}

// ── Referent guard (R13, GATE 1) ───────────────────────────────────────────
//
// 0.95 cosine does NOT separate template text about *different* files. Two
// auto-discovery `synthesized` memories sharing a template shape ("Key
// reference files: …") but naming DIFFERENT files can sit at cosine 0.96+ while
// being semantically distinct — the collapse tier would still merge them.
// This guard extracts the referents each template memory is *about* (file/command
// list items in the content ∪ the discovery `evidence_snapshot` input hashes)
// and refuses a deterministic-safe collapse when two same-template memories carry
// disjoint referent sets. Same-template / same-referent (the same file's updated
// observation count) is unaffected and still collapses.

/**
 * Leading template line of an auto-discovery synthesized memory, e.g.
 * "Key reference files frequently accessed in kopeng:" or
 * "Infrastructure commands frequently run manually in kopeng:". We key the
 * template on the first line with the trailing colon, stripped of the project
 * name so two memories for the *same* template in the *same* project share a key.
 */
const TEMPLATE_HEAD_RE = /^(.*?)(?: (?:in|for) \S.*)?:\s*$/;
/** A referent list item the synthesizer emits, e.g. "  - src/foo.ts". */
const REFERENT_ITEM_RE = /^\s*-\s+(.+?)\s*$/;

/**
 * If `content` is a template-shaped synthesized discovery memory, return its
 * template key (the leading template phrase, project-stripped) plus the file/
 * command referents listed under it. Returns null for non-template content
 * (operator notes, references, prose) — those are never referent-guarded.
 */
export function extractTemplateReferents(
  content: string,
): { template: string; referents: Set<string> } | null {
  const lines = content.split('\n');
  if (lines.length < 2) return null;

  const headMatch = lines[0].match(TEMPLATE_HEAD_RE);
  if (!headMatch) return null;
  const template = headMatch[1].trim().toLowerCase();
  if (!template) return null;

  const referents = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const item = lines[i].match(REFERENT_ITEM_RE);
    if (item) referents.add(item[1].trim().toLowerCase());
  }
  if (referents.size === 0) return null;

  return { template, referents };
}

/** Discovery provenance referents — the `evidence_snapshot` input hashes. */
function evidenceInputHashes(memory: CandidateMemory): Set<string> {
  return new Set(
    extractEvidence(memory)
      .map(e => e.input_hash)
      .filter((h): h is string => typeof h === 'string' && h.length > 0),
  );
}

/** True when sets A and B share at least one element. */
function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Referent guard for a candidate group. Returns true when the group is
 * "same-template + DIFFERENT-referent": every member is a template-shaped
 * discovery memory sharing one template key, but at least one member-pair has
 * DISJOINT referents (neither the content list items NOR the evidence input
 * hashes overlap). Such a group must NEVER be deterministic-safe — the diff
 * generator demotes it to reasoner-driven.
 *
 * Returns false when the group is not uniformly template-shaped (mixed/prose —
 * the normal cosine path applies) or when every member-pair shares a referent
 * (same file's updated observation count — collapse stays valid).
 */
export function isDifferentReferent(members: CandidateMemory[]): boolean {
  if (members.length < 2) return false;

  // Every member must be template-shaped AND share the same template key.
  const parsed = members.map(m => ({
    tpl: extractTemplateReferents(m.content),
    inputs: evidenceInputHashes(m),
  }));
  if (parsed.some(p => p.tpl === null)) return false;
  const templates = new Set(parsed.map(p => p.tpl!.template));
  if (templates.size !== 1) return false; // different templates ⇒ not this guard's case

  // Combined referent set per member = content list items ∪ evidence input hashes.
  const referentSets = parsed.map(p => {
    const s = new Set(p.tpl!.referents);
    for (const h of p.inputs) s.add(h);
    return s;
  });

  // Different-referent if ANY member-pair has fully disjoint referents.
  for (let i = 0; i < referentSets.length; i++) {
    for (let j = i + 1; j < referentSets.length; j++) {
      if (!intersects(referentSets[i], referentSets[j])) return true;
    }
  }
  return false;
}
