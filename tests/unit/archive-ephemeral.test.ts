/**
 * T76 §5.4 — the archive-ephemeral core (`runArchiveEphemeral`).
 *
 * Covers the §10 refusal matrix (fail-CLOSED eligibility), the dry-run/apply
 * split, the maintenance-§2 withhold posture, the audited archive shape, the
 * L-4 cap + drain, the F-7 mid-call stop, and F-9 partial results.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import { MemoryQueries } from '../../src/database/queries.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import type { IDreamStore, IMemoryStore, IVectorSearch, VectorSearchResult } from '../../src/database/interfaces.js';
import { ARCHIVE_EPHEMERAL_CARRIER_REASON } from '../../src/types/types.js';
import {
  runArchiveEphemeral,
  IneligibleScopeError,
  ARCHIVE_CAP,
  ARCHIVE_CHUNK,
  type ArchiveEphemeralDeps,
} from '../../src/scopes/archive-ephemeral.js';

/** Ephemeral-SHAPED synthetic scope (date-stamped rule). */
const EPHEMERAL = 'project:20260901-demo';

class StubVectorIndex implements IVectorSearch {
  removed: number[] = [];
  async loadFromDatabase(): Promise<void> {}
  async add(): Promise<void> {}
  async remove(id: number): Promise<void> { this.removed.push(id); }
  async search(): Promise<VectorSearchResult[]> { return []; }
  get isReady(): boolean { return true; }
  get size(): number { return 0; }
}

/** A one-shot resolution reader: the same {table, version} on every call. */
function resolution(version: string, table: Record<string, string> = {}) {
  return async () => ({ table, version });
}

/** Scripted resolution reader — one entry per expected call, last entry sticks. */
function scriptedResolution(script: { version: string; table?: Record<string, string> }[]) {
  let i = 0;
  const calls: string[] = [];
  const read = async () => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    calls.push(step.version);
    return { table: step.table ?? {}, version: step.version };
  };
  return { read, calls: () => calls };
}

const notRuled = async () => false;

/** Monotonic so two seed() calls in one test never collide on the content hash
 *  (store dedups by hash GLOBALLY) — ids therefore ascend in seeding order. */
let seedCounter = 0;

async function seed(
  queries: MemoryQueries,
  count: number,
  opts: { scope?: string; lockEvery?: number } = {},
): Promise<number[]> {
  const scope = opts.scope ?? EPHEMERAL;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const { id } = await queries.store(createTestMemory({
      content: `ephemeral row ${seedCounter++} in ${scope}`,
      scope,
    }));
    if (opts.lockEvery && i % opts.lockEvery === 0) await queries.updateLocked(id, true);
    ids.push(id);
  }
  return ids;
}

/** Wraps a real dream store so appendAudit throws for the matching memory ids. */
function auditFailsWhen(store: IDreamStore, matches: (memoryId: number | null | undefined) => boolean): IDreamStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'appendAudit') {
        return async (entry: Parameters<IDreamStore['appendAudit']>[0]) => {
          if (matches(entry.memory_id)) throw new Error('audit append boom');
          return target.appendAudit(entry);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as IDreamStore;
}

/** Wraps a real memory store so `list` throws from the Nth call onward. */
function listFailsFromCall(store: IMemoryStore, failFrom: number): IMemoryStore {
  let calls = 0;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'list') {
        return async (args: Parameters<IMemoryStore['list']>[0]) => {
          calls++;
          if (calls >= failFrom) throw new Error('store read boom');
          return target.list(args);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as IMemoryStore;
}

/** Wraps a real dream store so the carrier's finalize (its diff write) throws. */
function finalizeFails(store: IDreamStore): IDreamStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'setDreamDiff') return async () => { throw new Error('diff write boom'); };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as IDreamStore;
}

describe('runArchiveEphemeral', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let dreamStore: DreamQueries;
  let vectorIndex: StubVectorIndex;
  let deps: ArchiveEphemeralDeps;

  beforeEach(() => {
    ({ db, queries } = createTestDatabase());
    dreamStore = new DreamQueries(db);
    vectorIndex = new StubVectorIndex();
    deps = {
      memoryStore: queries,
      dreamStore,
      vectorIndex,
      readResolution: resolution('v1'),
      isRuledDistinct: notRuled,
    };
  });

  afterEach(() => { db.close(); });

  const activeCount = () => queries.countActiveByScope(EPHEMERAL);
  const dreamRows = () => db.prepare('SELECT * FROM dreams').all() as Record<string, unknown>[];

  // ── §10 refusal matrix — eligibility runs BEFORE the dry-run/apply branch ──

  it('refuses a non-ephemeral-shaped scope (IneligibleScopeError)', async () => {
    await seed(queries, 2, { scope: 'project:kopeng' });
    await expect(runArchiveEphemeral(deps, { scope: 'project:kopeng', apply: false }))
      .rejects.toThrow(IneligibleScopeError);
    await expect(runArchiveEphemeral(deps, { scope: 'project:kopeng', apply: false }))
      .rejects.toThrow(/not ephemeral-shaped/);
    expect(await queries.countActiveByScope('project:kopeng')).toBe(2);
  });

  it('refuses an alias-mapped scope', async () => {
    await seed(queries, 2);
    const aliased: ArchiveEphemeralDeps = {
      ...deps,
      readResolution: resolution('v1', { [EPHEMERAL]: 'project:real' }),
    };
    // Refused even with apply:true — eligibility precedes the branch.
    await expect(runArchiveEphemeral(aliased, { scope: EPHEMERAL, apply: true }))
      .rejects.toThrow(/alias-mapped to "project:real"/);
    expect(await activeCount()).toBe(2);
  });

  it('refuses a ruled-distinct scope', async () => {
    await seed(queries, 2);
    const ruled: ArchiveEphemeralDeps = { ...deps, isRuledDistinct: async () => true };
    await expect(runArchiveEphemeral(ruled, { scope: EPHEMERAL, apply: true }))
      .rejects.toThrow(/ruled distinct/);
    expect(await activeCount()).toBe(2);
  });

  it('a resolution read failure PROPAGATES (fail-closed) — nothing archived', async () => {
    await seed(queries, 3);
    const broken: ArchiveEphemeralDeps = {
      ...deps,
      readResolution: async () => { throw new Error('operator_config unreadable'); },
    };
    await expect(runArchiveEphemeral(broken, { scope: EPHEMERAL, apply: true }))
      .rejects.toThrow(/operator_config unreadable/);
    expect(await activeCount()).toBe(3);
    expect(dreamRows()).toHaveLength(0);
  });

  it('a ruled-distinct read failure PROPAGATES — nothing archived', async () => {
    await seed(queries, 3);
    const broken: ArchiveEphemeralDeps = {
      ...deps,
      isRuledDistinct: async () => { throw new Error('registry unreadable'); },
    };
    await expect(runArchiveEphemeral(broken, { scope: EPHEMERAL, apply: true }))
      .rejects.toThrow(/registry unreadable/);
    expect(await activeCount()).toBe(3);
    expect(dreamRows()).toHaveLength(0);
  });

  // ── dry-run / withhold ──

  it('dry-run (default) archives nothing, counts would-archive + refused_anchored, opens no carrier', async () => {
    await seed(queries, 7, { lockEvery: 3 }); // rows 0,3,6 locked ⇒ 3 anchored, 4 archivable

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: false });

    expect(res.dry_run).toBe(true);
    expect(res.archived).toBe(4);
    expect(res.refused_anchored).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.alias_table_version).toBe('v1');
    expect(res.dream_id).toBeUndefined();
    expect(res.failed).toEqual([]);
    expect(await activeCount()).toBe(7);
    expect(dreamRows()).toHaveLength(0);
    expect(vectorIndex.removed).toEqual([]);
  });

  it('no dream store ⇒ WITHHOLDS: archives nothing even with apply:true, reports withheld + withheld_rows', async () => {
    await seed(queries, 5);
    const noStore: ArchiveEphemeralDeps = { ...deps, dreamStore: null };

    const res = await runArchiveEphemeral(noStore, { scope: EPHEMERAL, apply: true });

    expect(res.withheld).toBe('no_dream_store');
    expect(res.withheld_rows).toBe(5);
    expect(res.dry_run).toBe(true);
    expect(res.archived).toBe(0);
    expect(res.dream_id).toBeUndefined();
    expect(await activeCount()).toBe(5);
  });

  // ── the audited archive shape ──

  it('apply archives each row via the audited path: memory archived, revision snapshotted, audit row change_class=archive_ephemeral, vector index dropped, carrier dream is_carrier + trigger_source manual', async () => {
    const ids = await seed(queries, 3);

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });

    expect(res.dry_run).toBe(false);
    expect(res.archived).toBe(3);
    expect(res.refused_anchored).toBe(0);
    expect(res.failed).toEqual([]);
    expect(res.dream_id).toBeDefined();
    expect(await activeCount()).toBe(0);

    for (const id of ids) {
      const mem = await queries.peek(id);
      expect(mem?.is_archived).toBeTruthy();
      const revisions = await dreamStore.listRevisions(id);
      expect(revisions).toHaveLength(1);
    }
    expect(vectorIndex.removed.sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));

    const audit = await dreamStore.listAuditForDream(res.dream_id!);
    expect(audit).toHaveLength(3);
    expect(audit.every(a => a.change_class === 'archive_ephemeral')).toBe(true);
    expect(audit.every(a => a.action === 'archive')).toBe(true);
    expect(audit.map(a => a.memory_id).sort((a, b) => a! - b!)).toEqual([...ids].sort((a, b) => a - b));
    expect(audit.every(a => a.revision_id !== null)).toBe(true);

    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.is_carrier).toBe(true);
    expect(dream?.trigger_source).toBe('manual');
    expect(dream?.reason).toBe(ARCHIVE_EPHEMERAL_CARRIER_REASON);
    expect(dream?.status).toBe('completed');
    expect(dream?.changes_auto_applied).toBe(3);
    expect(dream?.memories_examined).toBe(3);
  });

  it('anchored rows are skipped and counted refused_anchored (is_locked seed)', async () => {
    // Mixed corpus spanning more than one chunk: 250 rows, every 5th locked.
    const ids = await seed(queries, 250, { lockEvery: 5 });
    const lockedIds = ids.filter((_, i) => i % 5 === 0);

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });

    expect(res.archived).toBe(200);
    expect(res.refused_anchored).toBe(50);
    expect(res.truncated).toBe(false);
    expect(res.stopped).toBeUndefined();
    expect(res.failed).toEqual([]);
    // Anchored rows survive — they never leave the active list.
    expect(await activeCount()).toBe(50);
    for (const id of lockedIds) {
      expect((await queries.peek(id))?.is_archived).toBeFalsy();
    }
    // Each anchored row is counted ONCE per call.
    const audit = await dreamStore.listAuditForDream(res.dream_id!);
    expect(audit).toHaveLength(200);
  });

  it('a case-variant twin scope is NOT archived and lands in no counter (list is COLLATE NOCASE; eligibility is exact-string)', async () => {
    const twin = 'project:20260901-Demo';
    const mine = await seed(queries, 3);
    const theirs = await seed(queries, 4, { scope: twin });

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });

    // Only the exact-spelling rows are touched — the twin may itself be ruled
    // distinct or alias-mapped, and its eligibility was never checked here.
    expect(res.archived).toBe(3);
    expect(res.refused_anchored).toBe(0);
    expect(res.failed_total).toBe(0);
    for (const id of theirs) {
      expect((await queries.peek(id))?.is_archived).toBeFalsy();
    }
    for (const id of mine) {
      expect((await queries.peek(id))?.is_archived).toBeTruthy();
    }
    expect(await queries.countActiveByScope(twin)).toBe(4);
    expect(vectorIndex.removed.sort((a, b) => a - b)).toEqual([...mine].sort((a, b) => a - b));
    const audit = await dreamStore.listAuditForDream(res.dream_id!);
    expect(audit).toHaveLength(3);
  });

  it('anchored rows at the HEAD of the id order do not starve the archivable rows below them', async () => {
    // The starvation shape that rules out re-reading page 1: the newest
    // ARCHIVE_CHUNK ids are all anchored, so a page-1-only loop would never
    // reach the older archivable rows and would report archived: 0.
    const older = await seed(queries, 50);                        // lower ids
    const newer = await seed(queries, ARCHIVE_CHUNK, { lockEvery: 1 }); // higher ids, all locked

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });

    expect(res.archived).toBe(50);
    expect(res.refused_anchored).toBe(ARCHIVE_CHUNK);
    expect(res.truncated).toBe(false);
    for (const id of older) expect((await queries.peek(id))?.is_archived).toBeTruthy();
    for (const id of newer) expect((await queries.peek(id))?.is_archived).toBeFalsy();
  });

  it('caps at ARCHIVE_CAP with truncated:true when more rows remain', async () => {
    await seed(queries, ARCHIVE_CAP + 2);

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });

    expect(res.archived).toBe(ARCHIVE_CAP);
    expect(res.truncated).toBe(true);
    expect(await activeCount()).toBe(2);
  });

  it('F-7: a changed alias_table_version between chunks STOPS with partial counts + stopped flag; earlier archives stay archived', async () => {
    await seed(queries, ARCHIVE_CHUNK * 2 + 10);
    const scripted = scriptedResolution([
      { version: 'v1' },  // eligibility
      { version: 'v1' },  // chunk 1 — proceeds
      { version: 'v2' },  // chunk 2 — a ruling landed mid-call
    ]);

    const res = await runArchiveEphemeral({ ...deps, readResolution: scripted.read }, { scope: EPHEMERAL, apply: true });

    expect(res.stopped).toBe('alias_table_changed');
    expect(res.archived).toBe(ARCHIVE_CHUNK);
    expect(res.alias_table_version).toBe('v1');
    expect(res.truncated).toBe(false);
    expect(await activeCount()).toBe(ARCHIVE_CHUNK + 10);
    expect(scripted.calls()).toEqual(['v1', 'v1', 'v2']);
  });

  it('F-7: an eligibility flip between chunks STOPS with stopped=eligibility_changed', async () => {
    await seed(queries, ARCHIVE_CHUNK * 2);
    let calls = 0;
    const flips = async () => { calls++; return calls > 2; }; // eligibility + chunk 1 pass, chunk 2 ruled distinct

    const res = await runArchiveEphemeral({ ...deps, isRuledDistinct: flips }, { scope: EPHEMERAL, apply: true });

    expect(res.stopped).toBe('eligibility_changed');
    expect(res.archived).toBe(ARCHIVE_CHUNK);
    expect(await activeCount()).toBe(ARCHIVE_CHUNK);
  });

  it('F-7: a resolution read that FAILS mid-call stops with partial results (never throws away completed archives)', async () => {
    await seed(queries, ARCHIVE_CHUNK + 50);
    let calls = 0;
    const failsOnChunkTwo = async () => {
      calls++;
      if (calls > 2) throw new Error('operator_config vanished mid-call'); // pre-loop + chunk 1 succeed
      return { table: {} as Record<string, string>, version: 'v1' };
    };

    const res = await runArchiveEphemeral({ ...deps, readResolution: failsOnChunkTwo }, { scope: EPHEMERAL, apply: true });

    // Returned, not thrown: the 100 archives are real and the operator needs to
    // be told about them — and needs the dream_id to roll them back.
    expect(res.stopped).toBe('resolution_read_failed');
    expect(res.archived).toBe(ARCHIVE_CHUNK);
    expect(res.dream_id).toBeDefined();
    expect(await activeCount()).toBe(50);
    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.status).toBe('completed');   // carrier finalized despite the stop
    expect(dream?.changes_auto_applied).toBe(ARCHIVE_CHUNK);
    expect(await dreamStore.listAuditForDream(res.dream_id!)).toHaveLength(ARCHIVE_CHUNK);
  });

  it('F-7: a ruled-distinct read that FAILS mid-call also stops with partial results', async () => {
    await seed(queries, ARCHIVE_CHUNK + 50);
    let calls = 0;
    const failsOnChunkTwo = async () => {
      calls++;
      if (calls > 2) throw new Error('registry unavailable mid-call');
      return false;
    };

    const res = await runArchiveEphemeral({ ...deps, isRuledDistinct: failsOnChunkTwo }, { scope: EPHEMERAL, apply: true });

    expect(res.stopped).toBe('resolution_read_failed');
    expect(res.archived).toBe(ARCHIVE_CHUNK);
    expect(res.dream_id).toBeDefined();
    expect(await activeCount()).toBe(50);
  });

  it('a page fetch that FAILS mid-call stops with partial results, same posture as the F-7 re-check', async () => {
    await seed(queries, ARCHIVE_CHUNK + 50);

    const res = await runArchiveEphemeral(
      // Call 1 (chunk 1) succeeds; call 2 throws.
      { ...deps, memoryStore: listFailsFromCall(queries, 2) },
      { scope: EPHEMERAL, apply: true },
    );

    // Returned, not thrown: chunk 1's archives are real, audited, and need
    // their rollback handles reported.
    expect(res.stopped).toBe('store_read_failed');
    expect(res.archived).toBe(ARCHIVE_CHUNK);
    expect(res.archived_ids).toHaveLength(ARCHIVE_CHUNK);
    expect(res.dream_id).toBeDefined();
    expect(await activeCount()).toBe(50);
    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.status).toBe('completed');
    expect(dream?.changes_auto_applied).toBe(ARCHIVE_CHUNK);
    expect(await dreamStore.listAuditForDream(res.dream_id!)).toHaveLength(ARCHIVE_CHUNK);
  });

  it('a page fetch that fails on the FIRST call still returns cleanly with nothing archived', async () => {
    await seed(queries, 5);

    const res = await runArchiveEphemeral(
      { ...deps, memoryStore: listFailsFromCall(queries, 1) },
      { scope: EPHEMERAL, apply: true },
    );

    expect(res.stopped).toBe('store_read_failed');
    expect(res.archived).toBe(0);
    expect(res.archived_ids).toEqual([]);
    expect(await activeCount()).toBe(5);
  });

  // The carrier's dream_id identifies the pass; rollback is per-memory, and the
  // rows are archived by the time the operator reads the response — so the id
  // list IS the undo enumeration.
  it('reports archived_ids (the rollback enumeration) and stamps the carrier with the scope', async () => {
    const ids = await seed(queries, 4, { lockEvery: 4 }); // row 0 locked ⇒ 3 archived

    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });

    expect(res.archived).toBe(3);
    expect(res.refused_anchored).toBe(1);
    // Exactly the archived rows — not the anchored one.
    expect([...res.archived_ids].sort((a, b) => a - b)).toEqual(ids.slice(1).sort((a, b) => a - b));
    for (const id of res.archived_ids) {
      expect((await queries.peek(id))?.is_archived).toBeTruthy();
    }
    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.scope).toBe(EPHEMERAL);
  });

  it('dry-run reports no archived_ids (nothing was archived to roll back)', async () => {
    await seed(queries, 3);
    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: false });
    expect(res.archived).toBe(3);
    expect(res.archived_ids).toEqual([]);
  });

  it('a carrier finalize failure is REPORTED on the result, not just logged; the archives stand', async () => {
    const ids = await seed(queries, 3);

    const res = await runArchiveEphemeral(
      { ...deps, dreamStore: finalizeFails(dreamStore) },
      { scope: EPHEMERAL, apply: true },
    );

    expect(res.finalization_failed).toBe(true);
    // The archives themselves landed and are individually audited — only the
    // carrier's own summary row is unwritten.
    expect(res.archived).toBe(3);
    expect(res.archived_ids).toHaveLength(3);
    expect(res.dream_id).toBeDefined();
    expect(await activeCount()).toBe(0);
    for (const id of ids) expect((await queries.peek(id))?.is_archived).toBeTruthy();
    expect(await dreamStore.listAuditForDream(res.dream_id!)).toHaveLength(3);
    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.status).not.toBe('completed');   // exactly what the flag warns about
  });

  it('a clean run does NOT set finalization_failed', async () => {
    await seed(queries, 2);
    const res = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });
    expect(res.finalization_failed).toBeUndefined();
  });

  it('idempotent re-run: a second call over a part-archived scope skips archived rows and drains the remainder (the DESIGNED L-4 drain)', async () => {
    await seed(queries, ARCHIVE_CAP + 2);

    const first = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });
    expect(first.archived).toBe(ARCHIVE_CAP);
    expect(first.truncated).toBe(true);

    const second = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });
    expect(second.archived).toBe(2);
    expect(second.truncated).toBe(false);
    expect(second.dream_id).not.toBe(first.dream_id);
    expect(await activeCount()).toBe(0);

    const third = await runArchiveEphemeral(deps, { scope: EPHEMERAL, apply: true });
    expect(third.archived).toBe(0);
    expect(third.dream_id).toBeUndefined(); // nothing to do ⇒ no carrier row written
  });

  it('partial failure: an audit append failure on one row is compensated by auditedArchiveMemory (row unarchived), reported in failed[], and the loop CONTINUES; carrier still finalized', async () => {
    const ids = await seed(queries, 5);
    const doomed = ids[2];

    const res = await runArchiveEphemeral(
      { ...deps, dreamStore: auditFailsWhen(dreamStore, id => id === doomed) },
      { scope: EPHEMERAL, apply: true },
    );

    expect(res.archived).toBe(4);
    expect(res.failed).toHaveLength(1);
    expect(res.failed_total).toBe(1);   // equals failed.length below the detail cap
    expect(res.failed[0].memory_id).toBe(doomed);
    expect(res.failed[0].error).toMatch(/audit append boom/);
    // Compensated: the row is back to active.
    expect((await queries.peek(doomed))?.is_archived).toBeFalsy();
    expect(await activeCount()).toBe(1);
    // The carrier is still finalized truthfully — and `memories_examined`
    // counts rows ATTEMPTED, so the failed row is in it. Without the failure
    // being recorded the dream row would read as though only 4 rows were ever
    // looked at, hiding the one that went wrong.
    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.status).toBe('completed');
    expect(dream?.changes_auto_applied).toBe(4);
    expect(dream?.memories_examined).toBe(5);
  });

  it('an all-failing scope reports failed_total past the 20-entry detail cap, and failures consume the row budget', async () => {
    await seed(queries, ARCHIVE_CAP + 2);

    const res = await runArchiveEphemeral(
      { ...deps, dreamStore: auditFailsWhen(dreamStore, () => true) },
      { scope: EPHEMERAL, apply: true },
    );

    expect(res.archived).toBe(0);
    expect(res.failed).toHaveLength(20);          // detail cap
    expect(res.failed_total).toBe(ARCHIVE_CAP);   // the honest count — and the budget stopped the walk
    expect(res.truncated).toBe(true);
    // Every row compensated back to active (invariant #11).
    expect(await activeCount()).toBe(ARCHIVE_CAP + 2);
    // Every attempt is on the carrier even though none applied.
    const dream = await dreamStore.getDream(res.dream_id!);
    expect(dream?.memories_examined).toBe(ARCHIVE_CAP);
    expect(dream?.changes_auto_applied).toBe(0);
  });
});
