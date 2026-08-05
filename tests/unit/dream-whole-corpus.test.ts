import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import {
  runDreamPass, WholeCorpusMemorySource, isWholeCorpusSource, isoWeekKey,
  RotatingWindowMemorySource, DEFAULT_WHOLE_CORPUS_SEGMENT,
  type DreamEngineDeps,
} from '../../src/dreaming/dream-engine.js';
import {
  DuplicateCandidateSelector, DeterministicDiffGenerator,
} from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import { CountingReasoner } from '../../src/dreaming/replay.js';
import type { DreamDiffEntry } from '../../src/types/types.js';

/**
 * T6 / R12 — whole-corpus dreaming mode. The rotating window can only co-window
 * memories within ~one segment of each other; whole-corpus mode reads the WHOLE
 * active corpus every pass (deterministic tier) while throttling the reasoner
 * tier to band pairs anchored in a persisted id-segment `[cursor, cursor+segment)`.
 */

const DIM = 8;
function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}
/** Unit vector with cosine exactly `w` against basis(i). */
function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}
function buf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

describe('T6 whole-corpus mode', () => {
  let db: Database.Database;
  let memories: MemoryQueries;
  let dreams: DreamQueries;
  const NOW = Date.parse('2026-06-15T03:00:00Z'); // ISO week 2026-W25

  async function seed(content: string, opts: { embedding?: Float32Array; confidence?: number; scope?: string } = {}): Promise<number> {
    const { id } = await memories.store({
      content, type: 'project', scope: opts.scope ?? 'global', source: 'test',
      source_path: null, metadata: '{}',
      embedding: opts.embedding ? buf(opts.embedding) : null,
      embedding_model: opts.embedding ? 'test' : '',
      created_by: null, tags: [], confidence: opts.confidence ?? 0.7,
    });
    return id;
  }

  function wholeSource(opts: { scope?: string } = {}): WholeCorpusMemorySource {
    return new WholeCorpusMemorySource(memories, dreams, opts);
  }

  function deps(overrides: Partial<DreamEngineDeps> = {}): DreamEngineDeps {
    return {
      dreamStore: dreams,
      configStore: dreams,
      source: wholeSource(),
      selector: new DuplicateCandidateSelector({ now: () => new Date(NOW) }),
      reasoner: new NoOpReasoner(),
      diffGen: new DeterministicDiffGenerator(),
      lock: new ConsolidationLockManager({ store: dreams, holder: 'dream-whole', now: () => NOW }),
      mode: 'whole_corpus',
      tz: 'UTC',
      now: () => NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDatabase().db;
    memories = new MemoryQueries(db);
    dreams = new DreamQueries(db);
  });

  describe('isoWeekKey', () => {
    it('produces a YYYY-Www key (UTC)', () => {
      expect(isoWeekKey(Date.parse('2026-06-15T03:00:00Z'))).toBe('2026-W25');
      expect(isoWeekKey(Date.parse('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    });
  });

  describe('WholeCorpusMemorySource', () => {
    it('is recognized as a whole-corpus source and fetches the WHOLE active corpus', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) ids.push(await seed(`wc seed ${i}`));
      await memories.archive(ids[2]); // archived rows excluded

      const src = wholeSource();
      expect(isWholeCorpusSource(src)).toBe(true);
      const fetched = (await src.fetch()).map(m => m.id);
      expect(fetched).toEqual([ids[0], ids[1], ids[3], ids[4]]);
    });

    it('pages past the page size to read everything', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 7; i++) ids.push(await seed(`page seed ${i}`));
      // pageSize 2 forces multiple pages through the listByIdRange loop.
      const small = new WholeCorpusMemorySource(memories, dreams, { pageSize: 2 });
      expect((await small.fetch()).map(m => m.id)).toEqual(ids);
    });
  });

  describe('far-apart duplicate (the R12 GATE-1 shape)', () => {
    it('surfaces a Δ≈2000-id exact-dup pair that rotation could never co-window', async () => {
      const dupA = await seed('Production DB host is 192.0.2.10 on the WireGuard net');
      // ~2000 filler memories so the partner sits a full rotation-segment-class away.
      for (let i = 0; i < 2000; i++) await seed(`filler ${i}`);
      const dupB = await seed('production db host is 192.0.2.10 on the wireguard net');

      expect(dupB - dupA).toBeGreaterThan(1900); // genuinely far apart

      const p = await runDreamPass(deps(), { trigger: 'manual' });
      expect(p.status).toBe('completed');
      expect(p.window_key.startsWith('2026-W25#whole#a')).toBe(true);

      const dream = await dreams.getDream(p.dream_id!);
      const entries: DreamDiffEntry[] = JSON.parse(dream!.output_diff!).entries;
      const planted = entries.find(e =>
        e.memory_ids.length === 2 && e.memory_ids.includes(dupA) && e.memory_ids.includes(dupB));
      expect(planted).toBeDefined();
      expect(planted!.change_class).toBe('exact_dup');
      expect(planted!.tier).toBe('deterministic-safe');
    }, 30_000);
  });

  describe('id-segment reasoner cursor', () => {
    /**
     * Seed a band backlog larger than one segment: N near-dup pairs (cosine ~0.90)
     * each anchored at its own id. With segment=2, only pairs whose anchor falls in
     * [cursor, cursor+2) are classified+queued this pass; the rest are dropped and
     * drained on later passes.
     */
    async function seedBandBacklog(pairCount: number): Promise<Array<[number, number]>> {
      const pairs: Array<[number, number]> = [];
      for (let p = 0; p < pairCount; p++) {
        const a = await seed(`band fact ${p} alpha`, { embedding: basis(p % DIM) });
        const b = await seed(`band fact ${p} beta totally different wording`, { embedding: blend(p % DIM, (p + 1) % DIM, 0.90) });
        pairs.push([a, b]);
      }
      return pairs;
    }

    async function setSegment(n: number): Promise<void> {
      await dreams.updateConfig('default', { config: JSON.stringify({ dream_whole_corpus_segment: n }) });
    }

    it('classifies only band pairs anchored in the current segment; calls ≤ segment band-pairs', async () => {
      await setSegment(2);
      const pairs = await seedBandBacklog(4); // anchors are the `a` ids: contiguous pairs

      const counter = new CountingReasoner(new NoOpReasoner());
      const p1 = await runDreamPass(deps({ reasoner: counter }), { trigger: 'manual' });
      expect(p1.status).toBe('completed');

      // First segment is [0, 2): only the pair whose anchor (min id) < 2 qualifies.
      // With contiguous ids, the first band pair anchors at id 1 → exactly 1 classify call.
      expect(counter.classifyCalls).toBeLessThanOrEqual(2);
      expect(counter.classifyCalls).toBeGreaterThanOrEqual(1);

      const dream = await dreams.getDream(p1.dream_id!);
      const entries: DreamDiffEntry[] = JSON.parse(dream!.output_diff!).entries;
      const merges = entries.filter(e => e.change_class === 'merge');
      // Only in-segment band pairs produced queued merge entries.
      expect(merges.length).toBe(counter.classifyCalls);
      for (const m of merges) expect(m.tier).toBe('reasoner-driven');

      // The far pairs were NOT queued this pass (segment bound holds).
      const queuedAnchors = new Set(merges.flatMap(m => m.memory_ids));
      const farPair = pairs[pairs.length - 1];
      expect(queuedAnchors.has(farPair[0])).toBe(false);
    });

    it('successive passes drain disjoint segments and the cursor advances only on completion', async () => {
      await setSegment(3);
      await seedBandBacklog(6);

      const cursorNow = () => wholeSource().currentCursor();
      expect(await cursorNow()).toBe(0);

      const c1 = new CountingReasoner(new NoOpReasoner());
      const p1 = await runDreamPass(deps({ reasoner: c1 }), { trigger: 'manual' });
      expect(p1.status).toBe('completed');
      const cursorAfter1 = await cursorNow();
      expect(cursorAfter1).toBe(3); // advanced by the segment width

      // Window key encodes the segment cursor so the same-week re-trigger walks on.
      expect(p1.window_key).toBe('2026-W25#whole#a0');

      const c2 = new CountingReasoner(new NoOpReasoner());
      const p2 = await runDreamPass(deps({ reasoner: c2 }), { trigger: 'manual' });
      expect(p2.status).toBe('completed');
      expect(p2.window_key).toBe('2026-W25#whole#a3');
      expect(await cursorNow()).toBe(6);

      // Disjoint: a pass classifies band pairs anchored in its own segment only.
      // (NoOp routes each in-segment band pair to a queued merge.)
      expect(c1.classifyCalls).toBeGreaterThan(0);
      expect(c2.classifyCalls).toBeGreaterThan(0);
    });

    it('a failed pass does NOT advance the cursor (retry re-covers the same segment)', async () => {
      await setSegment(3);
      await seedBandBacklog(4);
      const boom = { generate: () => { throw new Error('boom'); } };

      await expect(runDreamPass(deps({ diffGen: boom }), { trigger: 'manual' })).rejects.toThrow('boom');
      expect(await wholeSource().currentCursor()).toBe(0);
    });

    it('dry-run does NOT advance the cursor', async () => {
      await setSegment(3);
      await seedBandBacklog(4);
      const dry = await runDreamPass(deps(), { trigger: 'manual', dryRun: true });
      expect(dry.status).toBe('dry_run');
      expect(await wholeSource().currentCursor()).toBe(0);
    });

    it('default segment is 60 when unset', async () => {
      await seed('one');
      // currentCursor reads 0; reasonerGate snapshots the default segment.
      const src = wholeSource();
      const gate = await src.reasonerGate();
      // anchor 5 (< 0+60) passes; anchor 100 (>= 60) does not.
      expect(gate({ kind: 'pair', members: [{ id: 5 } as never, { id: 6 } as never] })).toBe(true);
      expect(gate({ kind: 'pair', members: [{ id: 100 } as never, { id: 101 } as never] })).toBe(false);
      expect(DEFAULT_WHOLE_CORPUS_SEGMENT).toBe(60);
    });
  });

  describe('deterministic-only sub-case makes 0 reasoner calls', () => {
    it('a whole-corpus pass over exact-dups only never calls the reasoner', async () => {
      await seed('Keep this one exactly', { confidence: 0.7 });
      await seed('keep this one exactly', { confidence: 0.7 }); // case variant → exact_dup
      await seed('Another unique fact');

      const counter = new CountingReasoner(new NoOpReasoner());
      const p = await runDreamPass(deps({ reasoner: counter }), { trigger: 'manual' });
      expect(p.status).toBe('completed');
      expect(counter.classifyCalls).toBe(0);
      expect(counter.llmCalls).toBe(0);

      const dream = await dreams.getDream(p.dream_id!);
      const entries: DreamDiffEntry[] = JSON.parse(dream!.output_diff!).entries;
      expect(entries.some(e => e.change_class === 'exact_dup')).toBe(true);
    });
  });

  describe('windowed mode is unaffected (no gating)', () => {
    it('a rotating-window pass classifies band pairs without an id-segment gate', async () => {
      // Two near-dup pairs; the rotating source has NO reasonerGate, so the
      // pipeline classifies every in-window band pair (pre-T6 behavior).
      await seed('rot fact 0 a', { embedding: basis(0) });
      await seed('rot fact 0 b different words', { embedding: blend(0, 1, 0.90) });

      const counter = new CountingReasoner(new NoOpReasoner());
      const p = await runDreamPass(deps({
        source: new RotatingWindowMemorySource(memories, dreams, { limit: 500 }),
        mode: 'windowed',
        reasoner: counter,
      }), { trigger: 'manual' });
      expect(p.status).toBe('completed');
      expect(p.window_key).toBe('2026-06-15#a0'); // day-based, not week#whole
      expect(counter.classifyCalls).toBe(1);
    });
  });
});
