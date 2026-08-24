/**
 * D1.3 — apply path + audit + rollback (plan §1.3 verify list, scratch SQLite):
 * auto_accept_* OFF means nothing applies; safe classes auto-apply gated by
 * their flag, audited, and reversible; deterministic-safe merges and all
 * reasoner-driven entries queue; resolve accept/reject/partial; rollback
 * restores prior content AND embedding; reject leaves the store untouched;
 * Hard-Anchor re-check at apply time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { adminHeaders, createTestDatabase } from '../fixtures/test-helpers.js';
import config from '../../src/config/config.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { EmbeddingIndex } from '../../src/embeddings/index.js';
import { ConsolidationLockManager } from '../../src/dreaming/lock.js';
import { runDreamPass, DbWindowMemorySource, type DreamEngineDeps } from '../../src/dreaming/dream-engine.js';
import { DuplicateCandidateSelector, DeterministicDiffGenerator, StaticMemorySource } from '../../src/dreaming/pipeline.js';
import { NoOpReasoner } from '../../src/dreaming/reasoner/noop-reasoner.js';
import {
  applyEntry, auditedArchiveMemory, resolveDream, rollbackMemory, computeAcceptance, isAutoApplicable,
  type ApplyDeps,
} from '../../src/dreaming/apply.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { DreamDiff, DreamDiffEntry, OperatorConfig } from '../../src/types/types.js';

const NOW = Date.parse('2026-06-15T03:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
const DIM = 8;

function basis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

/** Unit vector with cosine `w` against basis(i). */
function blend(i: number, j: number, w: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = w;
  v[j] = Math.sqrt(1 - w * w);
  return v;
}

function toBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(0));
}

describe('dream apply path (D1.3)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let index: EmbeddingIndex;

  beforeEach(async () => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    index = new EmbeddingIndex();
    await index.loadFromDatabase([]);
  });

  async function storeMem(opts: {
    content: string;
    scope?: string;
    confidence?: number;
    vec?: Float32Array;
    tags?: string[];
    lastSeen?: string;
    locked?: boolean;
    metadata?: string;
  }): Promise<number> {
    const { id } = await queries.store({
      content: opts.content,
      type: 'discovery',
      scope: opts.scope ?? 'project:x',
      source: 'auto-discovery',
      source_path: null,
      metadata: opts.metadata ?? '{}',
      embedding: opts.vec ? toBuffer(opts.vec) : null,
      embedding_model: 'test',
      created_by: null,
      tags: opts.tags ?? [],
      confidence: opts.confidence ?? 0.7,
    });
    if (opts.vec) await index.add(id, opts.vec);
    if (opts.lastSeen) {
      db.prepare(`UPDATE memories SET last_seen = ?, updated_at = ? WHERE id = ?`)
        .run(opts.lastSeen, opts.lastSeen, id);
    }
    if (opts.locked) db.prepare(`UPDATE memories SET is_locked = 1 WHERE id = ?`).run(id);
    return id;
  }

  function applyDeps(): ApplyDeps {
    return { memoryStore: queries, dreamStore: store, vectorIndex: index };
  }

  function engineDeps(overrides: Partial<DreamEngineDeps> = {}): DreamEngineDeps {
    return {
      dreamStore: store,
      configStore: store,
      source: new DbWindowMemorySource(queries, { limit: 100 }),
      selector: new DuplicateCandidateSelector({ now: () => new Date(NOW) }),
      reasoner: new NoOpReasoner(),
      diffGen: new DeterministicDiffGenerator(),
      lock: new ConsolidationLockManager({ store, holder: 'dream-engine' }),
      tz: 'UTC',
      now: () => NOW,
      apply: { memoryStore: queries, vectorIndex: index },
      ...overrides,
    };
  }

  function isArchived(id: number): boolean {
    return (db.prepare(`SELECT is_archived FROM memories WHERE id = ?`).get(id) as { is_archived: number }).is_archived === 1;
  }

  it('B5: rollback archives a dream-CREATED memory (no revision); a plain memory still returns null', async () => {
    const dream = await store.createDream({});
    // A memory the dream created (conditional branch encoding shape) — no revision to restore.
    const { id: encodedId } = await queries.store({
      content: 'when X → A; when Y → B',
      type: 'project',
      scope: 'project:x',
      source: 'dream-consolidation',
      source_path: null,
      metadata: JSON.stringify({ encoded_by_dream: dream.id, condition_sources: [1, 2] }),
      embedding: toBuffer(basis(0)),
      embedding_model: 'test',
      created_by: null,
      tags: ['dream-encoded', 'conditional'],
      confidence: 0.7,
    });
    await index.add(encodedId, basis(0));

    const rb = await rollbackMemory(applyDeps(), encodedId);
    expect(rb).not.toBeNull();
    expect(rb?.archived_creation).toBe(true);
    expect(isArchived(encodedId)).toBe(true);

    // Control: a plain (non-dream) memory with no revisions has nothing to undo.
    const plainId = await storeMem({ content: 'plain memory', vec: basis(1) });
    expect(await rollbackMemory(applyDeps(), plainId)).toBeNull();
  });

  function parseDiff(raw: string | null): DreamDiff {
    return raw ? JSON.parse(raw) : { entries: [] };
  }

  /** Exact-dup pair: same normalized content, different raw bytes (hash differs). */
  async function exactDupPair() {
    const keep = await storeMem({ content: 'npm test runs the suite', confidence: 0.8, vec: basis(0) });
    const dup = await storeMem({ content: 'NPM  test runs the suite', confidence: 0.6, vec: basis(0) });
    return { keep, dup };
  }

  // ── auto_accept_* OFF (the seeded default) ──

  it('auto_accept_* OFF: nothing applies — proposals queue, store untouched', async () => {
    const { keep, dup } = await exactDupPair();

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    expect(run.status).toBe('completed');
    expect(run.changes_proposed).toBe(1);

    const dream = (await store.getDream(run.dream_id!))!;
    expect(dream.acceptance_status).toBe('pending');
    expect(dream.changes_auto_applied).toBe(0);
    expect(dream.changes_queued).toBe(1);

    expect(isArchived(keep)).toBe(false);
    expect(isArchived(dup)).toBe(false);
    expect(await store.listRevisions(dup)).toHaveLength(0);
    expect(await store.listAuditForDream(dream.id)).toHaveLength(0);
    expect(parseDiff(dream.output_diff).entries[0].resolution).toBeUndefined();
  });

  // ── safe-class auto-apply (flags ON in the scratch DB only) ──

  it('auto_accept_exact_dup ON: collapse auto-applies — snapshot, archive, audit, index sync', async () => {
    await store.updateConfig('default', { auto_accept_exact_dup: true });
    const { keep, dup } = await exactDupPair();
    const sizeBefore = index.size;

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;

    expect(dream.acceptance_status).toBe('auto_applied');
    expect(dream.changes_auto_applied).toBe(1);
    expect(dream.changes_queued).toBe(0);

    // The keep target (higher confidence) survives; the dup is archived.
    expect(isArchived(keep)).toBe(false);
    expect(isArchived(dup)).toBe(true);
    expect(index.size).toBe(sizeBefore - 1);

    // Audited (invariant #11): one row, automatic, pointing at the snapshot.
    const audit = await store.listAuditForDream(dream.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].change_class).toBe('exact_dup');
    expect(audit[0].action).toBe('archive');
    expect(audit[0].applied_automatically).toBe(true);
    expect(audit[0].memory_id).toBe(dup);
    expect(audit[0].revision_id).not.toBeNull();

    // Snapshot-first (invariant #4): the revision preserves the pre-apply row.
    const revisions = await store.listRevisions(dup);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].content).toBe('NPM  test runs the suite');
    expect(revisions[0].created_by_dream_id).toBe(dream.id);

    // Per-entry resolution persisted into output_diff.
    expect(parseDiff(dream.output_diff).entries[0].resolution).toBe('auto_applied');
  });

  it('auto-applied archive is reversible: rollback unarchives and restores content + embedding', async () => {
    await store.updateConfig('default', { auto_accept_exact_dup: true });
    const vec = basis(0);
    const { dup } = await exactDupPair();
    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    expect(isArchived(dup)).toBe(true);

    const result = await rollbackMemory(applyDeps(), dup);
    expect(result).not.toBeNull();
    expect(result!.unarchived).toBe(true);
    expect(isArchived(dup)).toBe(false);

    const mem = (await queries.get(dup))!;
    expect(mem.content).toBe('NPM  test runs the suite');
    expect((mem.embedding as Buffer).equals(toBuffer(vec))).toBe(true);

    // The reversal is itself audited, under the dream that made the snapshot.
    const audit = await store.listAuditForDream(run.dream_id!);
    expect(audit.map(a => a.change_class)).toEqual(['exact_dup', 'rollback']);
    expect(audit[1].action).toBe('restore_revision');
  });

  it('auto_accept_decay gates decay archives; OFF queues, ON applies', async () => {
    // 165 days stale at conf 0.5 / 1 obs → effective ≈ 0.074 < 0.2 archive threshold.
    const decayed = await storeMem({ content: 'stale fact nobody recalls', confidence: 0.5, lastSeen: '2026-01-01T00:00:00Z' });

    const first = await runDreamPass(engineDeps(), { trigger: 'manual', windowKey: 'w-decay-off' });
    const dream1 = (await store.getDream(first.dream_id!))!;
    expect(parseDiff(dream1.output_diff).entries[0].change_class).toBe('decay');
    expect(dream1.acceptance_status).toBe('pending');
    expect(isArchived(decayed)).toBe(false);

    await store.updateConfig('default', { auto_accept_decay: true });
    const second = await runDreamPass(engineDeps(), { trigger: 'manual', windowKey: 'w-decay-on' });
    const dream2 = (await store.getDream(second.dream_id!))!;
    expect(dream2.acceptance_status).toBe('auto_applied');
    expect(isArchived(decayed)).toBe(true);

    const audit = await store.listAuditForDream(dream2.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].change_class).toBe('decay');
    expect(audit[0].applied_automatically).toBe(true);
  });

  it('mixed diff with one flag ON auto-applies only the covered class → acceptance partial', async () => {
    await store.updateConfig('default', { auto_accept_exact_dup: true }); // decay stays OFF
    const { dup } = await exactDupPair();
    const decayed = await storeMem({
      content: 'stale fact nobody recalls', scope: 'project:y',
      confidence: 0.5, lastSeen: '2026-01-01T00:00:00Z',
    });

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;

    expect(dream.changes_auto_applied).toBe(1);
    expect(dream.changes_queued).toBe(1);
    expect(dream.acceptance_status).toBe('partial');
    expect(isArchived(dup)).toBe(true);
    expect(isArchived(decayed)).toBe(false);
  });

  it('deterministic-safe merge (cosine ≥0.95) NEVER auto-applies, even with both flags ON', async () => {
    await store.updateConfig('default', { auto_accept_exact_dup: true, auto_accept_decay: true });
    const a = await storeMem({ content: 'use pnpm for installs', confidence: 0.8, vec: basis(0) });
    const b = await storeMem({ content: 'installs should use pnpm', confidence: 0.6, vec: blend(0, 1, 0.97) });

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;
    const entry = parseDiff(dream.output_diff).entries[0];

    expect(entry.change_class).toBe('merge');
    expect(entry.tier).toBe('deterministic-safe');
    expect(dream.acceptance_status).toBe('pending');
    expect(dream.changes_auto_applied).toBe(0);
    expect(isArchived(a)).toBe(false);
    expect(isArchived(b)).toBe(false);
  });

  // ── operator resolution (accept / reject / partial) ──

  it('a queued merge stays pending until resolved; accept applies it with a manual audit', async () => {
    const a = await storeMem({ content: 'use pnpm for installs', confidence: 0.8, vec: basis(0) });
    const b = await storeMem({ content: 'installs should use pnpm', confidence: 0.6, vec: blend(0, 1, 0.97) });

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    let dream = (await store.getDream(run.dream_id!))!;
    expect(dream.acceptance_status).toBe('pending');
    expect(isArchived(b)).toBe(false); // still pending — untouched

    const result = await resolveDream(applyDeps(), dream, 'accept', undefined, NOW_ISO);
    expect(result.applied).toBe(1);
    expect(result.acceptance_status).toBe('accepted');

    expect(isArchived(a)).toBe(false);
    expect(isArchived(b)).toBe(true);

    dream = (await store.getDream(run.dream_id!))!;
    expect(dream.acceptance_status).toBe('accepted');
    expect(dream.changes_queued).toBe(0);
    expect(parseDiff(dream.output_diff).entries[0].resolution).toBe('accepted');

    const audit = await store.listAuditForDream(dream.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].change_class).toBe('merge');
    expect(audit[0].applied_automatically).toBe(false);
  });

  it('reject leaves the store untouched', async () => {
    const { keep, dup } = await exactDupPair();
    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    const dream = (await store.getDream(run.dream_id!))!;

    const result = await resolveDream(applyDeps(), dream, 'reject', undefined, NOW_ISO);
    expect(result.rejected).toBe(1);
    expect(result.acceptance_status).toBe('rejected');

    expect(isArchived(keep)).toBe(false);
    expect(isArchived(dup)).toBe(false);
    expect(await store.listRevisions(dup)).toHaveLength(0);
    expect(await store.listAuditForDream(dream.id)).toHaveLength(0);

    const after = (await store.getDream(dream.id))!;
    expect(after.acceptance_status).toBe('rejected');
    expect(parseDiff(after.output_diff).entries[0].resolution).toBe('rejected');
  });

  it('partial resolution via entry_indices', async () => {
    const { dup } = await exactDupPair();
    const decayed = await storeMem({
      content: 'stale fact nobody recalls', scope: 'project:y',
      confidence: 0.5, lastSeen: '2026-01-01T00:00:00Z',
    });

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    let dream = (await store.getDream(run.dream_id!))!;
    const entries = parseDiff(dream.output_diff).entries;
    expect(entries).toHaveLength(2);
    const dupIndex = entries.findIndex(e => e.change_class === 'exact_dup');
    const decayIndex = entries.findIndex(e => e.change_class === 'decay');

    // Accept only the exact-dup entry → the dream is partially resolved.
    const result = await resolveDream(applyDeps(), dream, 'accept', [dupIndex], NOW_ISO);
    expect(result.applied).toBe(1);
    expect(result.acceptance_status).toBe('partial');
    expect(isArchived(dup)).toBe(true);
    expect(isArchived(decayed)).toBe(false);

    // Reject the rest → all resolved, mixed outcome stays 'partial'.
    dream = (await store.getDream(run.dream_id!))!;
    const final = await resolveDream(applyDeps(), dream, 'reject', [decayIndex], NOW_ISO);
    expect(final.acceptance_status).toBe('partial');
    expect(isArchived(decayed)).toBe(false);
  });

  it('a near-dup band entry has no machine action: accept skips it, reject resolves it', async () => {
    await storeMem({ content: 'always use tabs', confidence: 0.8, vec: basis(0) });
    await storeMem({ content: 'always use spaces', confidence: 0.6, vec: blend(0, 1, 0.90) });

    const run = await runDreamPass(engineDeps(), { trigger: 'manual' });
    let dream = (await store.getDream(run.dream_id!))!;
    const entry = parseDiff(dream.output_diff).entries[0];
    expect(entry.change_class).toBe('merge');
    expect(entry.tier).toBe('reasoner-driven');

    const accepted = await resolveDream(applyDeps(), dream, 'accept', undefined, NOW_ISO);
    expect(accepted.applied).toBe(0);
    expect(accepted.results[0].outcome).toBe('not_actionable');
    expect(accepted.acceptance_status).toBe('pending'); // untouched, still reviewable

    dream = (await store.getDream(run.dream_id!))!;
    const rejected = await resolveDream(applyDeps(), dream, 'reject', undefined, NOW_ISO);
    expect(rejected.acceptance_status).toBe('rejected');
  });

  // ── defense in depth ──

  it('Hard Anchor re-check: applyEntry refuses to archive a locked memory from a stale diff', async () => {
    const a = await storeMem({ content: 'anchored truth A', confidence: 0.9 });
    const b = await storeMem({ content: 'anchored truth B', confidence: 0.9, locked: true });
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-anchor' });
    const entry: DreamDiffEntry = {
      change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [a, b],
      rationale: 'stale diff targeting an anchored memory',
      after: { keep_id: a, archive_ids: [b] },
    };

    const result = await applyEntry(applyDeps(), dream.id, 0, entry, true);
    expect(result.outcome).toBe('anchored');
    expect(isArchived(b)).toBe(false);
    expect(await store.listRevisions(b)).toHaveLength(0);
    expect(await store.listAuditForDream(dream.id)).toHaveLength(0);
  });

  it('auditedArchiveMemory refuses an ancient sub-1.0 PINNED memory (CR-1)', async () => {
    // confidence 0.5, unlocked, pinned via metadata, last_seen 300 days before
    // NOW — decayed far past the 0.2 archive line, so only the pin protects it.
    const pinnedId = await storeMem({
      content: 'pinned but ancient',
      confidence: 0.5,
      metadata: '{"pinned":true}',
      lastSeen: '2025-08-19T00:00:00Z',
    });
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-pinned' });

    const result = await auditedArchiveMemory(applyDeps(), dream.id, pinnedId, 'decay');
    expect(result.outcome).toBe('refused_anchored');
    // and the row is still active:
    expect((await queries.peek(pinnedId))!.is_archived).toBe(0);
    expect(await store.listRevisions(pinnedId)).toHaveLength(0);
    expect(await store.listAuditForDream(dream.id)).toHaveLength(0);
  });

  it('promote_global is never applied — diff-only signal for the maintenance path', async () => {
    const a = await storeMem({ content: 'shared convention', scope: 'project:x' });
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-promote' });
    const entry: DreamDiffEntry = {
      change_class: 'promote_global', tier: 'deterministic-safe', memory_ids: [a],
      rationale: 'cross-scope dup', after: { promote_scope: 'global', source_ids: [a] },
    };
    const result = await applyEntry(applyDeps(), dream.id, 0, entry, true);
    expect(result.outcome).toBe('not_actionable');
    expect(isArchived(a)).toBe(false);
  });

  // ── rollback restores prior content AND embedding ──

  it('rollback restores a revision over a content+embedding change', async () => {
    const v1 = basis(2);
    const v2 = basis(3);
    const id = await storeMem({ content: 'original content', confidence: 0.7, vec: v1, tags: ['original-tag'] });

    await store.snapshotRevision(id, null);
    await queries.update(id, {
      content: 'rewritten content', type: 'discovery', scope: 'project:x',
      metadata: '{}', tags: ['new-tag'],
    });
    await queries.setEmbedding(id, toBuffer(v2), 'test');

    const before = (await queries.get(id))!;
    expect(before.content).toBe('rewritten content');
    expect((before.embedding as Buffer).equals(toBuffer(v2))).toBe(true);

    const result = await rollbackMemory(applyDeps(), id, 1);
    expect(result).not.toBeNull();
    expect(result!.restored_revision).toBe(1);

    const after = (await queries.get(id))!;
    expect(after.content).toBe('original content');
    expect((after.embedding as Buffer).equals(toBuffer(v1))).toBe(true);
    expect(after.tags).toEqual(['original-tag']);

    // The restore snapshotted the pre-rollback state — rollback is reversible too.
    const revisions = await store.listRevisions(id);
    expect(revisions.map(r => r.revision)).toEqual([2, 1]);
    expect(revisions[0].content).toBe('rewritten content');
  });

  it('rollback returns null when no revision exists', async () => {
    const id = await storeMem({ content: 'never snapshotted' });
    expect(await rollbackMemory(applyDeps(), id)).toBeNull();
  });

  // ── acceptance derivation ──

  it('computeAcceptance covers the resolution states', () => {
    const e = (resolution?: DreamDiffEntry['resolution']): DreamDiffEntry => ({
      change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [1], rationale: 'x', resolution,
    });
    expect(computeAcceptance([])).toBe('empty');
    expect(computeAcceptance([e(), e()])).toBe('pending');
    expect(computeAcceptance([e('auto_applied'), e()])).toBe('partial');
    expect(computeAcceptance([e('auto_applied'), e('auto_applied')])).toBe('auto_applied');
    expect(computeAcceptance([e('rejected'), e('rejected')])).toBe('rejected');
    expect(computeAcceptance([e('accepted'), e('rejected')])).toBe('partial');
    expect(computeAcceptance([e('accepted'), e('auto_applied')])).toBe('accepted');
  });

  // ── Phase 2 apply-time revalidation (stale-diff defense) ──

  describe('Phase 2 apply-time revalidation', () => {
    it('G3: a merge whose keep-target was archived in the interim is refused, archiving nothing', async () => {
      const { keep: a, dup: b } = await exactDupPair();
      const dream = await store.createDream({ operator_id: 'default', window_key: 'w-g3' });
      const entry: DreamDiffEntry = {
        change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [a, b],
        rationale: 'stale keep target',
        after: { keep_id: a, archive_ids: [b] },
      };
      await queries.archive(a); // the interim archive

      const result = await applyEntry(applyDeps(), dream.id, 0, entry, false);
      expect(result.outcome).toBe('not_actionable');
      expect(result.detail).toMatch(/stale diff: keep target/);
      expect(isArchived(b)).toBe(false); // B untouched
    });

    it("refuses when a member's content changed since the proposal (provenance hash mismatch)", async () => {
      const { keep: a, dup: b } = await exactDupPair();
      const aHash = (await queries.get(a))!.content_hash;
      const bHash = (await queries.get(b))!.content_hash;
      const dream = await store.createDream({ operator_id: 'default', window_key: 'w-hash' });
      const entry: DreamDiffEntry = {
        change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [a, b],
        rationale: 'hash revalidation',
        after: { keep_id: a, archive_ids: [b] },
        provenance: {
          alias_table_version: null,
          members: [
            { id: a, content_hash: aHash, scope: 'project:x', effective_scope: 'project:x' },
            { id: b, content_hash: bHash, scope: 'project:x', effective_scope: 'project:x' },
          ],
        },
      };

      await queries.update(b, { content: 'edited since the proposal', type: 'discovery', scope: 'project:x', metadata: '{}', tags: [] });

      const result = await applyEntry(applyDeps(), dream.id, 0, entry, false);
      expect(result.outcome).toBe('not_actionable');
      expect(result.detail).toMatch(/content changed/);
      expect(isArchived(b)).toBe(false);
    });

    it('prefers an already-canonical survivor on exact_dup (swaps keep and archive)', async () => {
      // A REAL exact_dup pair via the normal store path: case/whitespace
      // variants (different content_hash — the unique index makes an exact
      // hash match unreachable between two live rows; the swap is gated on
      // normalizeContent, the selector's own predicate, not the hash).
      const a = await storeMem({ content: 'npm test runs the suite', confidence: 0.8, scope: 'client:Acme-Foods' });
      const b = await storeMem({ content: 'NPM  test runs the suite', confidence: 0.6, scope: 'client:acme-foods' });
      const dream = await store.createDream({ operator_id: 'default', window_key: 'w-canon' });
      const entry: DreamDiffEntry = {
        change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [a, b],
        rationale: 'exact dup across an alias/canonical scope pair',
        after: { keep_id: a, archive_ids: [b] },
      };
      const depsWithCanonicalize: ApplyDeps = {
        ...applyDeps(),
        canonicalizeScope: async (s: string) => (s === 'client:Acme-Foods' ? 'client:acme-foods' : s),
      };

      const result = await applyEntry(depsWithCanonicalize, dream.id, 0, entry, false);
      expect(result.outcome).toBe('applied');
      expect(isArchived(b)).toBe(false); // canonical row survived
      expect(isArchived(a)).toBe(true);  // alias row archived
    });

    it('legacy entries (no provenance) still apply with only the keep-target check', async () => {
      const { keep, dup } = await exactDupPair();
      const dream = await store.createDream({ operator_id: 'default', window_key: 'w-legacy' });
      const entry: DreamDiffEntry = {
        change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [keep, dup],
        rationale: 'legacy diff, no provenance',
        after: { keep_id: keep, archive_ids: [dup] },
      };

      const result = await applyEntry(applyDeps(), dream.id, 0, entry, false);
      expect(result.outcome).toBe('applied');
      expect(isArchived(dup)).toBe(true);
      expect(isArchived(keep)).toBe(false);
    });
  });

  it('isAutoApplicable maps each class to its flag and never covers merges or promotes', () => {
    const cfg = (exact: boolean, decay: boolean): OperatorConfig => ({
      operator_id: 'default', timezone: null, quiet_hours_start: null, quiet_hours_end: null,
      idle_minutes: 15, dream_cadence: null, auto_accept_exact_dup: exact, auto_accept_decay: decay,
      reasoner_provider: null, primary_scope: null, config: '{}', created_at: NOW_ISO, updated_at: NOW_ISO,
    });
    const entry = (change_class: DreamDiffEntry['change_class'], tier: DreamDiffEntry['tier']): DreamDiffEntry =>
      ({ change_class, tier, memory_ids: [1], rationale: 'x' });

    expect(isAutoApplicable(entry('exact_dup', 'deterministic-safe'), cfg(true, false))).toBe(true);
    expect(isAutoApplicable(entry('exact_dup', 'deterministic-safe'), cfg(false, true))).toBe(false);
    expect(isAutoApplicable(entry('decay', 'deterministic-safe'), cfg(false, true))).toBe(true);
    expect(isAutoApplicable(entry('decay', 'deterministic-safe'), cfg(true, false))).toBe(false);
    expect(isAutoApplicable(entry('merge', 'deterministic-safe'), cfg(true, true))).toBe(false);
    expect(isAutoApplicable(entry('promote_global', 'deterministic-safe'), cfg(true, true))).toBe(false);
    expect(isAutoApplicable(entry('exact_dup', 'reasoner-driven'), cfg(true, true))).toBe(false);
    expect(isAutoApplicable(entry('exact_dup', 'deterministic-safe'), null)).toBe(false);
  });
});

// ── REST surface (Fastify inject against the scratch DB) ──

describe('dream review REST surface (D1.3)', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let index: EmbeddingIndex;
  let app: FastifyInstance;

  beforeEach(async () => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    index = new EmbeddingIndex();
    await index.loadFromDatabase([]);

    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error.name === 'ZodError') {
        reply.status(400).send({ error: 'Validation error', details: JSON.parse(error.message) });
        return;
      }
      reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    });
    registerRoutes(app, {
      stores: { queries, dreams: store, operatorConfig: store },
      services: { embeddingIndex: index },
      lifecycle: {
        initialize: async () => {}, close: async () => {},
        getStats: async () => ({ total_memories: 0, active_memories: 0, archived_memories: 0, db_size_bytes: 0, wal_size_bytes: 0 }),
        backup: async () => 'noop',
      },
    });
    await app.ready();
  });

  async function seedPendingDream(): Promise<{ dreamId: number; keep: number; dup: number }> {
    const mk = async (content: string, confidence: number) => (await queries.store({
      content, type: 'discovery', scope: 'project:x', source: null, source_path: null,
      metadata: '{}', embedding: null, embedding_model: 'test', created_by: null,
      tags: [], confidence,
    })).id;
    const keep = await mk('npm test runs the suite', 0.8);
    const dup = await mk('NPM  test runs the suite', 0.6);
    const dream = await store.createDream({ operator_id: 'default', window_key: 'w-rest' });
    await store.setDreamDiff(dream.id, {
      entries: [{
        change_class: 'exact_dup', tier: 'deterministic-safe', memory_ids: [keep, dup],
        rationale: 'Identical normalized content.',
        after: { keep_id: keep, archive_ids: [dup] },
      }],
    });
    await store.updateDream(dream.id, { status: 'completed', acceptance_status: 'pending', changes_queued: 1 });
    return { dreamId: dream.id, keep, dup };
  }

  it('GET /api/dreams/pending lists the queued dream with entry counts', async () => {
    const { dreamId } = await seedPendingDream();
    const res = await app.inject({ method: 'GET', url: '/api/dreams/pending' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(dreamId);
    expect(body.data[0].pending_entries).toBe(1);
    expect(body.data[0].entries_total).toBe(1);
  });

  it('GET /api/dreams/:id/diff renders members, rationale, and the confidence delta', async () => {
    const { dreamId, keep } = await seedPendingDream();
    const res = await app.inject({ method: 'GET', url: `/api/dreams/${dreamId}/diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.dream.id).toBe(dreamId);
    const entry = body.data.entries[0];
    expect(entry.change_class).toBe('exact_dup');
    expect(entry.resolution).toBe('pending');
    expect(entry.rationale).toMatch(/Identical/);
    expect(entry.members).toHaveLength(2);
    expect(entry.members.find((m: { id: number }) => m.id === keep).confidence).toBe(0.8);
    expect(entry.confidence_delta).toBeCloseTo(0.2, 5);
  });

  it('POST /api/dreams/:id/resolve accept applies under the lock; 423 when the lock is busy', async () => {
    const { dreamId, dup } = await seedPendingDream();

    // Lock held elsewhere → 423, nothing applied.
    const other = new ConsolidationLockManager({ store, holder: 'someone-else' });
    expect(await other.acquire()).toBe(true);
    const busy = await app.inject({
      method: 'POST', url: `/api/dreams/${dreamId}/resolve`, headers: adminHeaders(), payload: { action: 'accept' },
    });
    expect(busy.statusCode).toBe(423);
    await other.release();

    const res = await app.inject({
      method: 'POST', url: `/api/dreams/${dreamId}/resolve`, headers: adminHeaders(), payload: { action: 'accept' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.applied).toBe(1);
    const archived = (db.prepare(`SELECT is_archived FROM memories WHERE id = ?`).get(dup) as { is_archived: number }).is_archived;
    expect(archived).toBe(1);
  });

  it('POST /api/memories/:id/rollback restores the snapshot; 404 without revisions', async () => {
    const { dreamId, dup } = await seedPendingDream();
    await app.inject({ method: 'POST', url: `/api/dreams/${dreamId}/resolve`, headers: adminHeaders(), payload: { action: 'accept' } });

    const missing = await app.inject({ method: 'POST', url: '/api/memories/999999/rollback', headers: adminHeaders(), payload: {} });
    expect(missing.statusCode).toBe(404);

    const res = await app.inject({ method: 'POST', url: `/api/memories/${dup}/rollback`, headers: adminHeaders(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.unarchived).toBe(true);
    expect(res.json().data.memory.is_archived).toBe(0);
  });

  it('GET /api/memories/:id/revisions lists the snapshot history', async () => {
    const { dreamId, dup } = await seedPendingDream();
    await app.inject({ method: 'POST', url: `/api/dreams/${dreamId}/resolve`, headers: adminHeaders(), payload: { action: 'accept' } });

    const res = await app.inject({ method: 'GET', headers: adminHeaders(), url: `/api/memories/${dup}/revisions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].created_by_dream_id).toBe(dreamId);
  });

  it('GET/PATCH /api/operator-config round-trips; flags are seeded OFF; bad input → 400', async () => {
    const get1 = await app.inject({ method: 'GET', url: '/api/operator-config' });
    expect(get1.statusCode).toBe(200);
    expect(get1.json().data.auto_accept_exact_dup).toBe(false);
    expect(get1.json().data.auto_accept_decay).toBe(false);

    const patch = await app.inject({
      method: 'PATCH', url: '/api/operator-config', headers: adminHeaders(),
      payload: { timezone: 'America/Denver', quiet_hours_start: '01:00', idle_minutes: 30 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.timezone).toBe('America/Denver');
    expect(patch.json().data.quiet_hours_start).toBe('01:00');
    expect(patch.json().data.idle_minutes).toBe(30);
    // Untouched fields keep their seeded values.
    expect(patch.json().data.auto_accept_exact_dup).toBe(false);

    const bad = await app.inject({
      method: 'PATCH', url: '/api/operator-config', headers: adminHeaders(), payload: { quiet_hours_start: '25:99' },
    });
    expect(bad.statusCode).toBe(400);

    const empty = await app.inject({ method: 'PATCH', url: '/api/operator-config', headers: adminHeaders(), payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('T27: with ADMIN_API_KEY configured, mutating endpoints 401 without the key and pass with it', async () => {
    const prev = config.server.adminApiKey;
    config.server.adminApiKey = 'test-admin-key';
    try {
      const noKey = await app.inject({ method: 'PATCH', url: '/api/operator-config', payload: { idle_minutes: 45 } });
      expect(noKey.statusCode).toBe(401);
      const wrongKey = await app.inject({
        method: 'PATCH', url: '/api/operator-config', headers: { 'x-api-key': 'nope' }, payload: { idle_minutes: 45 },
      });
      expect(wrongKey.statusCode).toBe(401);
      const ok = await app.inject({
        method: 'PATCH', url: '/api/operator-config', headers: { 'x-api-key': 'test-admin-key' }, payload: { idle_minutes: 45 },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      config.server.adminApiKey = prev;
    }
  });

  // Team-review #22 S1: the revision surface is admin-gated (revisions serve
  // PRE-EDIT content, so a public read defeats redaction) and purgeable (the
  // deliberate excision path for a secret that landed in history).
  it('revision GET is admin-gated; DELETE purges one revision or the whole history', async () => {
    const prev = config.server.adminApiKey;
    config.server.adminApiKey = 'test-admin-key';
    try {
      const { dup } = await seedPendingDream();
      await store.snapshotRevision(dup);
      await store.snapshotRevision(dup);

      // Reads of revision history 401 without the key (unlike core reads).
      const noKey = await app.inject({ method: 'GET', url: `/api/memories/${dup}/revisions` });
      expect(noKey.statusCode).toBe(401);
      const withKey = await app.inject({ method: 'GET', headers: { 'x-api-key': 'test-admin-key' }, url: `/api/memories/${dup}/revisions` });
      expect(withKey.statusCode).toBe(200);
      expect(withKey.json().data).toHaveLength(2);

      // Purge one revision.
      const delNoKey = await app.inject({ method: 'DELETE', url: `/api/memories/${dup}/revisions/1` });
      expect(delNoKey.statusCode).toBe(401);
      const delOne = await app.inject({ method: 'DELETE', headers: { 'x-api-key': 'test-admin-key' }, url: `/api/memories/${dup}/revisions/1` });
      expect(delOne.statusCode).toBe(200);
      const delGone = await app.inject({ method: 'DELETE', headers: { 'x-api-key': 'test-admin-key' }, url: `/api/memories/${dup}/revisions/1` });
      expect(delGone.statusCode).toBe(404);

      // Purge the rest.
      const delAll = await app.inject({ method: 'DELETE', headers: { 'x-api-key': 'test-admin-key' }, url: `/api/memories/${dup}/revisions` });
      expect(delAll.statusCode).toBe(200);
      expect(delAll.json().data.deleted).toBe(1);
      expect((await store.listRevisions(dup))).toHaveLength(0);
    } finally {
      config.server.adminApiKey = prev;
    }
  });
});

// ── team-review #22 A1: the canonical-survivor swap must be PERSISTED even when
// the entry ends pending (anchored member refused after the swap ran). The old
// `autoApplied > 0` persistence gate discarded the in-place entry mutation, so
// the stored diff named the archived row as survivor — the "lying diff".
describe('swap persistence under anchored refusal (team-review #22 A1)', () => {
  it('stored diff names the TRUE survivor when a swap applied partially', async () => {
    const t = createTestDatabase();
    const q = t.queries;
    const dStore = new DreamQueries(t.db);
    const idx = new EmbeddingIndex();
    await idx.loadFromDatabase([]);
    await dStore.updateConfig('default', { auto_accept_exact_dup: true });

    const canonicalize = (s: string) => (s === 'client:Acme-Foods' ? 'client:acme-foods' : s);

    async function seed(content: string, scope: string, confidence: number): Promise<number> {
      const { id } = await q.store({
        content, type: 'discovery', scope, source: 'auto-discovery', source_path: null,
        metadata: '{}', embedding: toBuffer(basis(0)), embedding_model: 'test',
        created_by: null, tags: [], confidence,
      });
      await idx.add(id, basis(0));
      return id;
    }
    // Same normalized content, three rows: proposed keep on the ALIAS scope,
    // the canonical-scope twin (swap target), and a third member we anchor
    // AFTER selection sees it (stale-view trick below).
    const keep = await seed('shared fact', 'client:Acme-Foods', 0.9);
    const dup = await seed('Shared  Fact', 'client:acme-foods', 0.6);
    const anchored = await seed('SHARED FACT', 'client:Acme-Foods', 0.7);

    // The source presents the PRE-ANCHOR view (selection-time state); the DB
    // then anchors #3, so applyEntry's re-check refuses it mid-entry.
    const staleView = [keep, dup, anchored].map((id, i) => ({
      id,
      content: ['shared fact', 'Shared  Fact', 'SHARED FACT'][i],
      content_hash: null, summary: null, tags: [],
      scope: ['client:Acme-Foods', 'client:acme-foods', 'client:Acme-Foods'][i],
      confidence: [0.9, 0.6, 0.7][i],
      is_locked: false,
      created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
      embedding: basis(0), metadata: null, last_seen: NOW_ISO, observation_count: 1,
    }));
    t.db.prepare(`UPDATE memories SET confidence = 1.0 WHERE id = ?`).run(anchored);

    const run = await runDreamPass({
      dreamStore: dStore,
      configStore: dStore,
      source: new StaticMemorySource(staleView),
      selector: new DuplicateCandidateSelector({ now: () => new Date(NOW), canonicalize }),
      reasoner: new NoOpReasoner(),
      diffGen: new DeterministicDiffGenerator({ canonicalize }),
      lock: new ConsolidationLockManager({ store: dStore, holder: 'dream-engine-swap-test' }),
      tz: 'UTC',
      now: () => NOW,
      apply: { memoryStore: q, vectorIndex: idx, canonicalizeScope: async (s) => canonicalize(s) },
    }, { trigger: 'manual' });
    expect(run.status).toBe('completed');

    // The anchored member kept the entry pending, so nothing "auto-applied"...
    const dream = await dStore.getDream(run.dream_id!);
    expect(dream?.changes_auto_applied).toBe(0);

    // ...but the swap ran: the alias-scoped proposed keep was archived, the
    // canonical twin survived...
    expect((await q.get(keep))?.is_archived).toBe(1);
    expect((await q.get(dup))?.is_archived).toBe(0);
    expect((await q.get(anchored))?.is_archived).toBe(0);

    // ...and the STORED diff reflects that truthfully (the fix): keep_id is the
    // canonical survivor, archive_ids carry the original keep, and the
    // rationale carries the swap marker exactly once.
    const diff = JSON.parse(dream!.output_diff!) as DreamDiff;
    const entry = diff.entries.find(e => e.change_class === 'exact_dup')!;
    const after = entry.after as { keep_id: number; archive_ids: number[] };
    expect(after.keep_id).toBe(dup);
    expect(after.archive_ids).toContain(keep);
    expect(after.archive_ids).not.toContain(dup);
    expect(entry.rationale.split('[apply-time: canonical-survivor swap').length).toBe(2);
  });
});
