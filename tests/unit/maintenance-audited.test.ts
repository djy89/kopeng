import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { DreamQueries } from '../../src/database/dream-queries.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import type { ObservationQueries } from '../../src/database/observation-queries.js';
import type { IObservationStore, IVectorSearch } from '../../src/database/interfaces.js';
import { runDiscoveryMaintenance, type MaintenanceAuditDeps } from '../../src/discovery/maintenance.js';
import { rollbackMemory } from '../../src/dreaming/apply.js';
import { MAINTENANCE_CARRIER_REASON } from '../../src/types/types.js';
import { createTestDatabase, createTestObservationsDb, createTestMemory } from '../fixtures/test-helpers.js';

// applyEntry/auditedArchiveMemory only touch add/remove — a null stub keeps the test model-free.
const nullIndex = {
  async add() {}, async remove() {}, async search() { return []; },
} as unknown as IVectorSearch;

describe('Phase 2: discovery-maintenance archives are audited', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let obsStore: ObservationQueries;
  let audit: MaintenanceAuditDeps;

  beforeEach(() => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    const o = createTestObservationsDb();
    obsStore = o.obsQueries;
    // DreamQueries doubles as the operator-config store (same class implements both).
    audit = { dreamStore: store, vectorIndex: nullIndex, configStore: store };
  });

  async function seedDecayed(content: string): Promise<number> {
    const { id: memId } = await queries.store(createTestMemory({
      content, type: 'discovery', confidence: 0.5,
    }));
    // Age the clock far past any half-life so effective confidence < 0.2.
    db.prepare(`UPDATE memories SET last_seen = datetime('now', '-400 days'),
      updated_at = datetime('now', '-400 days'), observation_count = 1 WHERE id = ?`).run(memId);
    return memId;
  }

  it('with auto_accept_decay ON, the low-confidence sweep snapshots + audits each archive under a maintenance carrier dream', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const memId = await seedDecayed('discovery memory that has decayed into irrelevance');

    const result = await runDiscoveryMaintenance(obsStore, queries, audit);
    expect(result.memories_archived).toBe(1);
    expect(result.dream_id).toBeDefined();

    const auditRows = await store.listAuditForDream(result.dream_id!);
    expect(auditRows.some(a => a.change_class === 'decay' && a.action === 'archive')).toBe(true);
    expect((await store.listRevisions(memId)).length).toBeGreaterThan(0);

    expect((await queries.get(memId))?.is_archived).toBe(1);

    // and the archive is rollback-able:
    const rb = await rollbackMemory({ memoryStore: queries, dreamStore: store, vectorIndex: nullIndex }, memId);
    expect(rb).not.toBeNull();
    expect((await queries.get(memId))?.is_archived).toBe(0);
  });

  it('with auto_accept_decay OFF (the shipped default), the sweep WITHHOLDS — GATE 1 governs decay archival here too', async () => {
    const memId = await seedDecayed('decayed but the operator flag is off');

    const result = await runDiscoveryMaintenance(obsStore, queries, audit);
    expect(result.memories_archived).toBe(0);
    expect(result.memories_withheld).toBeGreaterThan(0);
    expect((await queries.get(memId))?.is_archived).toBe(0);
    // Withholding writes no carrier.
    expect(result.dream_id).toBeUndefined();
  });

  it('without audit deps, maintenance WITHHOLDS instead of bare-archiving', async () => {
    const memId = await seedDecayed('another decayed discovery memory');

    const result = await runDiscoveryMaintenance(obsStore, queries); // no audit arg
    expect(result.memories_archived).toBe(0);
    expect(result.memories_withheld).toBeGreaterThan(0);
    expect((await queries.get(memId))?.is_archived).toBe(0);
  });

  // §3 groups by normalizeContent (team-review #22 A4): case/whitespace variants
  // of one insight across scopes have DISTINCT content_hashes, so the normal
  // store() path produces this shape — no index-dropping fixture, and the test
  // certifies the path production-reachable (the old content_hash grouping was
  // structurally impossible under the global unique hash index).
  async function seedPromotionGroup(): Promise<{ ids: number[]; bestId: number }> {
    const variants: Array<[string, string, number]> = [
      ['project:alpha', 'Shared Cross-Project Insight', 0.85],
      ['project:beta', 'shared cross-project insight', 0.95], // highest confidence → survivor
      ['project:gamma', 'SHARED  cross-project   insight', 0.80],
    ];
    const ids: number[] = [];
    let bestId = 0;
    for (const [scope, content, confidence] of variants) {
      const { id } = await queries.store(createTestMemory({ content, type: 'discovery', scope, confidence }));
      ids.push(id);
      if (confidence === 0.95) bestId = id;
    }
    return { ids, bestId };
  }

  it('scope promotion re-scopes the best original to global (audited rescope) and archives the others as promote_global', async () => {
    await store.updateConfig('default', { config: JSON.stringify({ auto_promote_global: true }) });
    const { ids, bestId } = await seedPromotionGroup();

    const result = await runDiscoveryMaintenance(obsStore, queries, audit);
    expect(result.memories_promoted).toBe(1);
    expect(result.dream_id).toBeDefined();

    const auditRows = await store.listAuditForDream(result.dream_id!);
    expect(auditRows.filter(a => a.change_class === 'promote_global' && a.action === 'archive').length).toBe(2);
    expect(auditRows.filter(a => a.change_class === 'promote_global' && a.action === 'rescope').length).toBe(1);

    const best = await queries.get(bestId);
    expect(best?.scope).toBe('global');
    expect(best?.is_archived).toBe(0);
    expect(best?.tags).toContain('scope-promoted');
    const bestMeta = JSON.parse(best!.metadata || '{}');
    expect(bestMeta.promoted_from).toHaveLength(2);

    for (const id of ids.filter(i => i !== bestId)) {
      const orig = await queries.get(id);
      expect(orig?.is_archived).toBe(1);
      expect(JSON.parse(orig!.metadata || '{}').promoted_to).toBe(bestId);
    }

    // The rescope is reversible: rollback restores the survivor's original scope
    // (Phase 2 revisions snapshot + restore `scope`).
    const rb = await rollbackMemory({ memoryStore: queries, dreamStore: store, vectorIndex: nullIndex }, bestId);
    expect(rb).not.toBeNull();
    expect((await queries.get(bestId))?.scope).toBe('project:beta');

    // ...and so is each archived original.
    const rb2 = await rollbackMemory({ memoryStore: queries, dreamStore: store, vectorIndex: nullIndex }, ids.find(i => i !== bestId)!);
    expect(rb2).not.toBeNull();
  });

  it('with auto_promote_global OFF (the shipped default), §3 WITHHOLDS the whole group (GATE 1, r2)', async () => {
    const { ids } = await seedPromotionGroup();

    const result = await runDiscoveryMaintenance(obsStore, queries, audit);
    expect(result.memories_promoted).toBe(0);
    expect(result.memories_withheld).toBeGreaterThanOrEqual(3);
    expect(result.dream_id).toBeUndefined(); // withholding writes no carrier
    for (const id of ids) {
      const m = await queries.get(id);
      expect(m?.is_archived).toBe(0);
      expect(m?.scope).not.toBe('global');
    }
  });

  it('a group failure at rescope time COMPENSATES the already-archived originals (r2 NEW-2)', async () => {
    await store.updateConfig('default', { config: JSON.stringify({ auto_promote_global: true }) });
    const { ids, bestId } = await seedPromotionGroup();

    // Wrap the dream store so ONLY the rescope's audit append fails — archives
    // and compensation audits succeed, forcing the "rescope failed" branch.
    const failingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'appendAudit') {
          return async (entry: { action?: string | null } & Record<string, unknown>) => {
            if (entry.action === 'rescope') throw new Error('injected rescope-audit failure');
            return (target.appendAudit as (e: unknown) => Promise<unknown>).call(target, entry);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await runDiscoveryMaintenance(obsStore, queries, {
      ...audit, dreamStore: failingStore,
    });
    expect(result.memories_promoted).toBe(0);
    expect(result.memories_archived).toBe(0); // compensated members are not counted
    expect(result.memories_withheld).toBeGreaterThanOrEqual(3);

    // The whole group reverted: nothing archived, survivor keeps its scope.
    for (const id of ids) {
      const m = await queries.get(id);
      expect(m?.is_archived).toBe(0);
    }
    expect((await queries.get(bestId))?.scope).toBe('project:beta');

    // The compensation left a truthful trail: archive + compensate_unarchive pairs.
    const auditRows = await store.listAuditForDream(result.dream_id!);
    expect(auditRows.filter(a => a.action === 'compensate_unarchive').length).toBe(2);
  });

  it('an anchored group member declines the WHOLE promotion group up front (atomicity pre-scan)', async () => {
    await store.updateConfig('default', { config: JSON.stringify({ auto_promote_global: true }) });
    const { ids, bestId } = await seedPromotionGroup();
    // Anchor one non-best member.
    const anchoredId = ids.find(i => i !== bestId)!;
    db.prepare(`UPDATE memories SET confidence = 1.0 WHERE id = ?`).run(anchoredId);

    const result = await runDiscoveryMaintenance(obsStore, queries, audit);
    expect(result.memories_promoted).toBe(0);
    expect(result.memories_withheld).toBeGreaterThanOrEqual(3);
    // Nothing moved: no archive, no rescope, no global row.
    for (const id of ids) {
      const m = await queries.get(id);
      expect(m?.is_archived).toBe(0);
      expect(m?.scope).not.toBe('global');
    }
  });

  it('a survivor PINNED mid-run declines the group at the rescope re-check (CR-1)', async () => {
    await store.updateConfig('default', { config: JSON.stringify({ auto_promote_global: true }) });
    const { ids, bestId } = await seedPromotionGroup();

    // The pre-scan reads the stale list() rows, so the pin must land AFTER it —
    // only the fresh peek() re-check at rescope time can see it (r2: core PUTs
    // don't take the consolidation lock; an operator pin mid-run must win).
    const pinningStore = new Proxy(queries, {
      get(target, prop, receiver) {
        if (prop === 'peek') {
          return async (id: number) => {
            if (id === bestId) {
              db.prepare(`UPDATE memories SET metadata = '{"pinned":true}' WHERE id = ?`).run(bestId);
            }
            return target.peek(id);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await runDiscoveryMaintenance(obsStore, pinningStore, audit);
    expect(result.memories_promoted).toBe(0);
    expect(result.memories_withheld).toBeGreaterThanOrEqual(3);

    // The group reverted whole (compensated archives), and the pinned survivor
    // was never rescoped — its scope and metadata mutation would have been the
    // CR-1 pinned-mutation hole.
    for (const id of ids) {
      expect((await queries.get(id))?.is_archived).toBe(0);
    }
    expect((await queries.get(bestId))?.scope).toBe('project:beta');
  });

  it('the maintenance carrier is VISIBLE in dream-history but excluded from pending + last-completed', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    await seedDecayed('yet another decayed discovery memory');

    const result = await runDiscoveryMaintenance(obsStore, queries, audit);
    expect(result.dream_id).toBeDefined();

    // History (team-review #22 S3): real archives get an operator-facing record.
    const recent = await store.listRecentDreams(50);
    expect(recent.some(d => d.id === result.dream_id && d.reason === MAINTENANCE_CARRIER_REASON)).toBe(true);

    // Review queue (A6) and the scheduler gate (P3) still never see carriers.
    const pending = await store.listPendingDreams(50);
    expect(pending.every(d => d.reason !== MAINTENANCE_CARRIER_REASON)).toBe(true);
    expect(await store.getLastCompletedDream('default', null, 'whole_corpus')).toBeNull();
  });
});

/**
 * Phase 4 (Task 5): §2 pages the FULL discovery set (the old single list()
 * call silently capped the sweep at 500 rows) and the dormancy freeze reads
 * the ALIAS GROUP — a memory stranded on an alias variant shares its
 * siblings' activity signal instead of judging dormancy off its raw scope
 * alone.
 *
 * Dormancy truth table (dormant = group-newest observation >30d old ⇒ decay
 * FROZEN ⇒ the row survives; active or no-signal ⇒ decay applies ⇒ archived
 * when auto_accept_decay is armed):
 *
 *   raw scope obs | alias sibling obs | closures  | verdict      | outcome
 *   none          | (n/a)             | none      | no signal    | archived  (pre-Phase-4, byte-identical)
 *   stale (100d)  | (n/a)             | none      | dormant      | frozen    (pre-Phase-4, byte-identical)
 *   none          | stale (100d)      | threaded  | dormant      | frozen    (OLD code archived — the fixed defect)
 *   none          | active (2d)       | threaded  | active       | archived
 *   stale (100d)  | active (2d)       | threaded  | active       | archived  (OLD code froze — sibling activity unfreezes)
 */
describe('Phase 4: §2 full paging + alias-group dormancy', () => {
  let db: Database.Database;
  let queries: MemoryQueries;
  let store: DreamQueries;
  let audit: MaintenanceAuditDeps;

  beforeEach(() => {
    const t = createTestDatabase();
    db = t.db;
    queries = t.queries;
    store = new DreamQueries(db);
    audit = { dreamStore: store, vectorIndex: nullIndex, configStore: store };
  });

  const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();

  /**
   * Per-scope observation stats stub — the store-level contract the dormancy
   * freeze depends on (getObservationStats scopes `newest` when a scope is
   * given; null for a scope with no rows). Only the members maintenance
   * touches are implemented.
   */
  function stubObsStore(newestByScope: Record<string, string>): IObservationStore {
    return {
      getObservationStats: async (scope?: string) => ({
        total: 0,
        by_project: {},
        by_tool: {},
        oldest: null,
        newest: scope ? (newestByScope[scope] ?? null) : null,
      }),
      purgeOlderThan: async () => 0,
    } as unknown as IObservationStore;
  }

  /** The Variant-X pair: canonicalize folds the variant, expand yields the group. */
  const aliasClosures = {
    canonicalizeScope: async (s: string) => (s === 'client:Variant-X' ? 'client:variant-x' : s),
    expandScope: async (s: string) =>
      s === 'client:variant-x' ? ['client:variant-x', 'client:Variant-X'] : [s],
  };

  async function seedDecayedOn(scope: string, content: string): Promise<number> {
    const { id } = await queries.store(createTestMemory({
      content, type: 'discovery', scope, confidence: 0.5,
    }));
    db.prepare(`UPDATE memories SET last_seen = datetime('now', '-400 days'),
      updated_at = datetime('now', '-400 days'), observation_count = 1 WHERE id = ?`).run(id);
    return id;
  }

  it('§2 pages past the first 500 discovery rows — the sweep covers the whole corpus (CR-3)', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    for (let i = 0; i < 501; i++) {
      await queries.store(createTestMemory({
        content: `paging sweep decayed discovery row ${i}`, type: 'discovery', confidence: 0.5,
      }));
    }
    // One bulk age-out (the per-row helper would be 501 statements).
    db.prepare(`UPDATE memories SET last_seen = datetime('now', '-400 days'),
      updated_at = datetime('now', '-400 days'), observation_count = 1 WHERE type = 'discovery'`).run();

    const obs = stubObsStore({});
    const result = await runDiscoveryMaintenance(obs, queries, audit);
    // Old code listed { limit: 500 } once: exactly 500 archived, one silently missed.
    expect(result.memories_archived).toBe(501);
  });

  it('no closures + raw scope with NO observations ⇒ no dormancy signal ⇒ decay applies, row archives (pre-Phase-4 fallback, byte-identical)', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const id = await seedDecayedOn('client:Variant-X', 'fallback no-signal row');

    const result = await runDiscoveryMaintenance(stubObsStore({}), queries, audit);
    expect(result.memories_archived).toBe(1);
    expect((await queries.get(id))?.is_archived).toBe(1);
  });

  it('no closures + raw scope >30d-stale ⇒ dormant ⇒ frozen, row survives (pre-Phase-4 fallback, byte-identical)', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const id = await seedDecayedOn('client:Variant-X', 'fallback stale-raw row');

    const result = await runDiscoveryMaintenance(
      stubObsStore({ 'client:Variant-X': daysAgo(100) }), queries, audit);
    expect(result.memories_archived).toBe(0);
    expect((await queries.get(id))?.is_archived).toBe(0);
  });

  it('alias group: raw scope NO observations + sibling >30d-stale ⇒ group DORMANT ⇒ frozen (old code archived this row)', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const id = await seedDecayedOn('client:Variant-X', 'adrift row rescued by sibling history');

    const result = await runDiscoveryMaintenance(
      stubObsStore({ 'client:variant-x': daysAgo(100) }), queries,
      { ...audit, ...aliasClosures });
    expect(result.memories_archived).toBe(0);
    expect((await queries.get(id))?.is_archived).toBe(0);
  });

  it('alias group: raw scope NO observations + sibling ACTIVE (2d) ⇒ group active ⇒ decay applies, row archives', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const id = await seedDecayedOn('client:Variant-X', 'adrift row under an active group');

    const result = await runDiscoveryMaintenance(
      stubObsStore({ 'client:variant-x': daysAgo(2) }), queries,
      { ...audit, ...aliasClosures });
    expect(result.memories_archived).toBe(1);
    expect((await queries.get(id))?.is_archived).toBe(1);
  });

  it('alias group: raw scope >30d-stale + sibling ACTIVE ⇒ group active ⇒ row archives (old code froze — activity anywhere in the group unfreezes)', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const id = await seedDecayedOn('client:Variant-X', 'stale-raw row under an active group');

    const result = await runDiscoveryMaintenance(
      stubObsStore({ 'client:Variant-X': daysAgo(100), 'client:variant-x': daysAgo(2) }), queries,
      { ...audit, ...aliasClosures });
    expect(result.memories_archived).toBe(1);
    expect((await queries.get(id))?.is_archived).toBe(1);
  });

  it('alias-group dormancy is ONE verdict per group: variant and canonical rows freeze together (canonical cache key)', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    // Stats DISAGREE per raw scope (variant stale, canonical no rows) — only a
    // group-level verdict keyed on the canonical gives both rows one outcome.
    const variantId = await seedDecayedOn('client:Variant-X', 'group-verdict variant row');
    const canonicalId = await seedDecayedOn('client:variant-x', 'group-verdict canonical row');

    const result = await runDiscoveryMaintenance(
      stubObsStore({ 'client:Variant-X': daysAgo(100) }), queries,
      { ...audit, ...aliasClosures });
    // Old code: the canonical row read its own scope (no rows ⇒ no signal) and
    // archived while its variant sibling froze — a fragmented verdict.
    expect(result.memories_archived).toBe(0);
    expect((await queries.get(variantId))?.is_archived).toBe(0);
    expect((await queries.get(canonicalId))?.is_archived).toBe(0);
  });

  it('dormancy fail-open: a throwing expandScope yields not-dormant — decay applies rather than wedging the sweep', async () => {
    await store.updateConfig('default', { auto_accept_decay: true });
    const id = await seedDecayedOn('client:Variant-X', 'fail-open row');

    const result = await runDiscoveryMaintenance(
      stubObsStore({ 'client:variant-x': daysAgo(100) }), queries,
      {
        ...audit,
        canonicalizeScope: aliasClosures.canonicalizeScope,
        expandScope: async () => { throw new Error('injected expand failure'); },
      });
    expect(result.memories_archived).toBe(1);
    expect((await queries.get(id))?.is_archived).toBe(1);
  });
});
