/**
 * R13 (GATE 1) referent guard — 0.95 cosine does NOT separate template text
 * about *different* files. The selector's cosine-≥0.95 collapse tier would
 * treat two same-template synthesized discovery memories naming different files
 * (observed in the wild at cosine 0.96+) as a deterministic-safe `merge`. This
 * guard forces such same-template / different-referent pairs reasoner-driven,
 * while same-template / same-referent (the same file's updated observation
 * count) still collapses.
 */
import { describe, it, expect } from 'vitest';
import {
  DuplicateCandidateSelector, DeterministicDiffGenerator,
} from '../../src/dreaming/pipeline.js';
import { extractTemplateReferents, isDifferentReferent } from '../../src/dreaming/gates.js';
import type { CandidateMemory } from '../../src/dreaming/reasoner/reasoner.js';

const NOW = new Date('2026-06-15T03:00:00Z');
const DIM = 8;

/** Unit vector blended on axes i,j so cosine(basis(i), blend) === w. */
function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}
function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

function mem(overrides: Partial<CandidateMemory> & { id: number; content: string }): CandidateMemory {
  return {
    content_hash: null,
    summary: null,
    tags: ['auto-discovered', 'workflow', 'key-files'],
    scope: 'project:kopeng',
    confidence: 0.7,
    is_locked: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    embedding: null,
    metadata: null,
    last_seen: null,
    observation_count: 1,
    ...overrides,
  };
}

/** The "Key reference files: …" synthesizer template, naming the given files. */
function keyFiles(files: string[]): string {
  const list = files.map(f => `  - ${f}`).join('\n');
  return `Key reference files frequently accessed in kopeng:\n${list}\n\nThese files are consistently accessed across sessions, suggesting they are architectural touchpoints or orientation files.`;
}

/** Discovery evidence_snapshot with the given input hashes (diverse, passes gates). */
function evidenceMeta(inputHashes: string[]): string {
  const snapshot = inputHashes.flatMap((h, i) => [
    { tool: 'Read', input_hash: h, session_id: `s${i}a`, at: '2026-06-01T10:00:00Z' },
    { tool: 'Read', input_hash: h, session_id: `s${i}b`, at: '2026-06-03T10:00:00Z' },
    { tool: 'Read', input_hash: h, session_id: `s${i}c`, at: '2026-06-05T10:00:00Z' },
  ]);
  return JSON.stringify({ evidence_snapshot: snapshot });
}

const selector = new DuplicateCandidateSelector({ now: () => NOW });
const diffGen = new DeterministicDiffGenerator();

function generate(memories: CandidateMemory[]) {
  const groups = selector.select(memories);
  return { groups, diff: diffGen.generate(groups.map(group => ({ group, verdict: null }))) };
}

describe('extractTemplateReferents', () => {
  it('parses the synthesizer "Key reference files" template into key + referents', () => {
    const parsed = extractTemplateReferents(keyFiles(['src/a.ts', 'src/b.ts']));
    expect(parsed).not.toBeNull();
    expect(parsed!.template).toContain('key reference files');
    expect([...parsed!.referents].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('parses the "Infrastructure commands" template (different project-stripped head)', () => {
    const c = `Infrastructure commands frequently run manually in kopeng:\n  - docker ps\n  - systemctl status\n\nThese are manual operations.`;
    const parsed = extractTemplateReferents(c);
    expect(parsed).not.toBeNull();
    expect([...parsed!.referents].sort()).toEqual(['docker ps', 'systemctl status']);
  });

  it('returns null for non-template prose / operator notes', () => {
    expect(extractTemplateReferents('Just a plain operator note about the deploy.')).toBeNull();
    expect(extractTemplateReferents('Header without a list:\nstill prose, no bullets')).toBeNull();
  });
});

describe('isDifferentReferent (R13 guard)', () => {
  it('fires for same-template memories naming disjoint files', () => {
    expect(isDifferentReferent([
      mem({ id: 9101, content: keyFiles(['src/server.ts', 'src/index.ts']) }),
      mem({ id: 9102, content: keyFiles(['viz/app.js', 'viz/index.html']) }),
    ])).toBe(true);
  });

  it('does NOT fire when the same file appears in both (overlapping referents)', () => {
    expect(isDifferentReferent([
      mem({ id: 1, content: keyFiles(['src/server.ts', 'src/index.ts']) }),
      mem({ id: 2, content: keyFiles(['src/server.ts', 'src/index.ts', 'src/new.ts']) }),
    ])).toBe(false);
  });

  it('uses evidence input hashes as referents too — disjoint hashes ⇒ fires', () => {
    expect(isDifferentReferent([
      mem({ id: 1, content: keyFiles(['x']), metadata: evidenceMeta(['ha', 'hb']) }),
      mem({ id: 2, content: keyFiles(['y']), metadata: evidenceMeta(['hc', 'hd']) }),
    ])).toBe(true);
  });

  it('shared evidence input hash rescues otherwise-disjoint content lists', () => {
    expect(isDifferentReferent([
      mem({ id: 1, content: keyFiles(['x']), metadata: evidenceMeta(['shared']) }),
      mem({ id: 2, content: keyFiles(['y']), metadata: evidenceMeta(['shared']) }),
    ])).toBe(false);
  });

  it('does not fire for non-template content (normal cosine path applies)', () => {
    expect(isDifferentReferent([
      mem({ id: 1, content: 'plain fact one' }),
      mem({ id: 2, content: 'plain fact two' }),
    ])).toBe(false);
  });

  it('does not fire when templates differ (different guard case)', () => {
    const infra = `Infrastructure commands frequently run manually in kopeng:\n  - docker ps\n\nManual ops.`;
    expect(isDifferentReferent([
      mem({ id: 1, content: keyFiles(['src/a.ts']) }),
      mem({ id: 2, content: infra }),
    ])).toBe(false);
  });
});

describe('R13 live-pair shape never collapses deterministically', () => {
  it('same-template / DIFFERENT-referent at cosine 0.97 routes reasoner-driven (not deterministic-safe)', () => {
    const { groups, diff } = generate([
      mem({
        id: 9101,
        content: keyFiles(['src/server.ts', 'src/index.ts']),
        embedding: basis(0),
        metadata: evidenceMeta(['ha', 'hb']),
      }),
      mem({
        id: 9102,
        content: keyFiles(['viz/app.js', 'viz/index.html']),
        embedding: blend(0, 1, 0.97), // > 0.95 → collapse tier would fire
        metadata: evidenceMeta(['hc', 'hd']),
      }),
    ]);
    // The selector still flags it as a semantic_duplicate (cosine ≥ 0.95) …
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('semantic_duplicate');
    // … but the diff must NOT collapse it deterministically.
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].change_class).toBe('merge');
    expect(diff.entries[0].tier).toBe('reasoner-driven');
    expect(diff.entries[0].rationale).toContain('different-referent');
  });

  it('control: same-template / SAME-referent (count text differs, file overlaps) still merges', () => {
    // Same file referent in both; the surrounding prose differs (e.g. updated
    // access count) so the content is NOT byte-identical → stays semantic_duplicate
    // rather than collapsing to exact_duplicate.
    const a = `Key reference files frequently accessed in kopeng:\n  - src/server.ts\n  - src/index.ts\n\nAccessed 12 times across sessions.`;
    const b = `Key reference files frequently accessed in kopeng:\n  - src/server.ts\n  - src/index.ts\n\nAccessed 19 times across sessions.`;
    const { groups, diff } = generate([
      mem({ id: 100, content: a, embedding: basis(0), metadata: evidenceMeta(['shared-1', 'shared-2']) }),
      mem({ id: 101, content: b, embedding: blend(0, 1, 0.97), metadata: evidenceMeta(['shared-1', 'shared-2']) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].signal).toBe('semantic_duplicate');
    expect(diff.entries[0].change_class).toBe('merge');
    expect(diff.entries[0].tier).toBe('deterministic-safe');
  });
});
