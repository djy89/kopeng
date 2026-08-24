/**
 * Executed-SQL tests against a REAL PostgreSQL (Phase 5).
 *
 * Why this exists: CI was SQLite-only while production and the revision
 * migrations are Postgres-backed. The Phase-2 round-2 review caught a PG-only
 * bug (temporal columns missing from the get/peek projections) that no SQLite
 * test could structurally catch, and `pg-dream-queries.test.ts` is a MOCKED
 * pg.Pool — its SQL strings are never executed. This suite runs the real
 * statements: migrations, projections, and the Phase-2 revision round-trip.
 *
 * Gated on KOPENG_PG_TEST_URL — skipped when unset. NOTE: the repo `.env`
 * counts, not just the shell env: this file's imports pull config.ts, whose
 * module body runs dotenv before line 1 of this file executes. A stray
 * KOPENG_PG_TEST_URL line in `.env` arms this suite for every `npm test`,
 * which is why the guards below are state checks, not just naming ones.
 * CI provides a pgvector service container and sets the var (plus
 * KOPENG_PG_REQUIRED=1, so a broken env wiring FAILS the PG job instead of
 * green-skipping it).
 *
 * Two-layer destructive-suite guard (this suite TRUNCATEs tables):
 *   1. The database NAME must contain a standalone "test" token (kopeng_test
 *      passes; kopeng_latest/contest do not) — same posture as
 *      dream:effectiveness refusing live DB names.
 *   2. The database must be EMPTY of memories before migrations run — a fresh
 *      CI service container is; a restored copy of a live corpus (which the
 *      repo's own copy-first doctrine tells the operator to create, sometimes
 *      under test-ish names) is not.
 */
import pg from 'pg';
import { runPgMigrations } from '../../src/database/pg-migrations.js';
import { PgQueries } from '../../src/database/pg-queries.js';
import { PgDreamQueries } from '../../src/database/pg-dream-queries.js';
import { PgScopeRegistryQueries } from '../../src/database/pg-scope-registry-queries.js';
import { PgObservationQueries } from '../../src/database/pg-observation-queries.js';

const PG_URL = process.env.KOPENG_PG_TEST_URL;

// The CI job sets KOPENG_PG_REQUIRED=1: there, a missing URL is a broken env
// wiring (a renamed var, a dropped service container) and must FAIL the job —
// a silent describe.skipIf would leave a permanently-green job running no SQL.
if (process.env.KOPENG_PG_REQUIRED === '1' && !PG_URL) {
  throw new Error(
    'KOPENG_PG_REQUIRED=1 but KOPENG_PG_TEST_URL is unset — the PG job env wiring is broken.',
  );
}

function dbNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

describe.skipIf(!PG_URL)('PG executed-SQL (real Postgres via KOPENG_PG_TEST_URL)', () => {
  let pool: pg.Pool;
  let queries: PgQueries;
  let dreams: PgDreamQueries;

  beforeAll(async () => {
    // Guard 1: standalone "test" token in the db name (anchored — 'kopeng_latest'
    // and 'contest' must NOT pass a bare substring check).
    const dbName = dbNameOf(PG_URL!);
    if (!/(^|[_-])tests?([_-]|$)/i.test(dbName)) {
      throw new Error(
        `KOPENG_PG_TEST_URL database is '${dbName}' — this suite TRUNCATEs tables, so the ` +
        `database name must carry a standalone 'test' token (e.g. kopeng_test). ` +
        `Never point it at a live corpus.`,
      );
    }
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    // Guard 2: the database must hold no FOREIGN memories before we migrate or
    // truncate. A name check alone cannot tell a fresh service container from a
    // restored copy of a live corpus that happens to carry a test-ish name.
    // Rows this suite itself stored (source = the suite's marker) are allowed,
    // so a second run against the same disposable container still works.
    // Unqualified on purpose: the guard must resolve through the SAME
    // search_path the TRUNCATE below uses — a schema-qualified probe could
    // inspect public.memories while the destructive statements hit another
    // schema's table.
    const existing = await pool.query(
      "SELECT to_regclass('memories') IS NOT NULL AS has_table",
    );
    if (existing.rows[0].has_table) {
      const foreign = await pool.query(
        "SELECT COUNT(*)::int AS n FROM memories WHERE source IS DISTINCT FROM 'pg-executed-sql-test'",
      );
      if (foreign.rows[0].n > 0) {
        throw new Error(
          `Database '${dbName}' already holds ${foreign.rows[0].n} memories this suite did not ` +
          `create — refusing to run a TRUNCATE-ing suite against it. Point KOPENG_PG_TEST_URL ` +
          `at an EMPTY test database.`,
        );
      }
    }
    await runPgMigrations(pool);
    queries = new PgQueries(pool);
    dreams = new PgDreamQueries(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // operator_config and consolidation_lock are deliberately NOT truncated:
    // the migrations seed operator_config's 'default' row, and truncating them
    // would diverge from migrated state. No test here touches either — a test
    // that starts to must reset them explicitly (and reseed the default row).
    await pool.query(
      'TRUNCATE memories, memory_tags, memory_access_log, memory_revisions, dreams, dream_audit_log RESTART IDENTITY CASCADE',
    );
  });

  async function storeOne(content: string, scope = 'project:pg-test'): Promise<number> {
    const { id } = await queries.store({
      content,
      type: 'reference',
      scope,
      source: 'pg-executed-sql-test',
      source_path: null,
      metadata: '{}',
      embedding: null,
      embedding_model: '',
      created_by: null,
      tags: ['pg-test'],
    });
    return id;
  }

  it('migrations + store/get round-trip execute real SQL', async () => {
    const id = await storeOne('A fully synthetic PG round-trip memory.');
    const row = await queries.get(id);
    expect(row).not.toBeNull();
    expect(row!.content).toBe('A fully synthetic PG round-trip memory.');
    expect(row!.tags).toContain('pg-test');
    expect(row!.is_archived).toBe(0);
  });

  it('get() and peek() project the temporal columns (Phase-2 round-2 PG-only regression)', async () => {
    // The bug: PG get/peek SELECTs omitted deprecated_at / valid_from /
    // last_contradicted, so the supersede idempotency predicate always saw NULL.
    // Set them via executed SQL and assert BOTH projections surface them.
    const id = await storeOne('Temporal-column projection probe.');
    await pool.query(
      `UPDATE memories SET deprecated_at = '2026-06-01T00:00:00Z', valid_from = '2026-05-01T00:00:00Z',
        last_contradicted = '2026-06-02T00:00:00Z' WHERE id = $1`,
      [id],
    );
    for (const read of [queries.get.bind(queries), queries.peek.bind(queries)]) {
      const row = await read(id);
      expect(row!.deprecated_at).toBeTruthy();
      expect(row!.valid_from).toBeTruthy();
      expect(row!.last_contradicted).toBeTruthy();
    }
  });

  it('peek() does not write the access log; get() does', async () => {
    const id = await storeOne('Access-log doctrine probe.');
    await queries.peek(id);
    const afterPeek = await pool.query('SELECT COUNT(*)::int AS n FROM memory_access_log WHERE memory_id = $1', [id]);
    expect(afterPeek.rows[0].n).toBe(0);
    await queries.get(id);
    const afterGet = await pool.query('SELECT COUNT(*)::int AS n FROM memory_access_log WHERE memory_id = $1', [id]);
    expect(afterGet.rows[0].n).toBeGreaterThan(0);
  });

  describe('Phase 8 Task 4: trimAccessLog retention (S7, CX-7)', () => {
    async function insertAccessAt(memoryId: number, interval: string): Promise<void> {
      await pool.query(
        `INSERT INTO memory_access_log (memory_id, accessed_at) VALUES ($1, now() + $2::interval)`,
        [memoryId, interval],
      );
    }

    async function logCount(): Promise<number> {
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM memory_access_log');
      return r.rows[0].n;
    }

    it('deletes only rows older than the window (make_interval cutoff)', async () => {
      const id = await storeOne('Retention trim probe.');
      await insertAccessAt(id, '-100 days');
      await insertAccessAt(id, '-89 days');
      await insertAccessAt(id, '0 seconds');
      expect(await logCount()).toBe(3);

      const deleted = await queries.trimAccessLog(90);
      expect(deleted).toBe(1);
      expect(await logCount()).toBe(2);
    });

    it('boundary: strict < — a row 5s inside the window survives, 5s outside is trimmed', async () => {
      // PG timestamps carry microsecond precision, so a row at exactly
      // now()-90d at INSERT time is already strictly older than the cutoff the
      // DELETE computes microseconds later — an "exact" equality case is not
      // constructible here (unlike SQLite's second-granular datetime()). Pin
      // both sides of the boundary deterministically instead.
      const id = await storeOne('Retention boundary probe.');
      await insertAccessAt(id, `-90 days +5 seconds`); // strictly inside → kept
      await insertAccessAt(id, `-90 days -5 seconds`); // strictly outside → trimmed
      const deleted = await queries.trimAccessLog(90);
      expect(deleted).toBe(1);
      expect(await logCount()).toBe(1);
    });

    it('days=0 keeps forever: returns 0 and executes no DELETE', async () => {
      const id = await storeOne('Retention keep-forever probe.');
      await insertAccessAt(id, '-100 days');
      await insertAccessAt(id, '-1000 days');
      // A DELETE with a zero-day cutoff would remove both old rows; their
      // survival proves the guard short-circuits before any SQL runs.
      expect(await queries.trimAccessLog(0)).toBe(0);
      expect(await logCount()).toBe(2);
    });
  });

  it('Phase-2 revision columns round-trip: snapshot captures scope/type/last_seen and restore brings them back', async () => {
    const id = await storeOne('Revision round-trip probe.');
    await dreams.reinforceMemory(id, '2026-01-01T00:00:00Z'); // give last_seen a known pre-snapshot value

    const snap = await dreams.snapshotRevision(id);
    expect(snap.revision).toBe(1);

    // The revision row itself must carry the Phase-2 (PG v10) columns.
    const rev = await pool.query(
      'SELECT scope, type, updated_at, last_seen FROM memory_revisions WHERE memory_id = $1 AND revision = $2',
      [id, snap.revision],
    );
    expect(rev.rows[0].scope).toBe('project:pg-test');
    expect(rev.rows[0].type).toBe('reference');
    expect(rev.rows[0].updated_at).toBeTruthy();
    expect(new Date(rev.rows[0].last_seen).toISOString()).toBe('2026-01-01T00:00:00.000Z');

    // Drift the live row, then restore.
    await queries.update(id, {
      content: 'Revision round-trip probe.',
      type: 'project',
      scope: 'client:pg-test-drifted',
      metadata: '{}',
      tags: ['pg-test'],
    });
    await dreams.reinforceMemory(id, '2026-07-01T00:00:00Z');

    const restored = await dreams.restoreRevision(id, snap.revision);
    expect(restored).toBe(true);

    const row = await queries.peek(id);
    expect(row!.scope).toBe('project:pg-test');
    expect(row!.type).toBe('reference');
    expect(new Date(row!.last_seen!).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a legacy (pre-v10, NULL-column) revision never clobbers live scope/type/last_seen on restore', async () => {
    const id = await storeOne('Legacy-revision COALESCE probe.');
    await dreams.reinforceMemory(id, '2026-03-01T00:00:00Z');
    const snap = await dreams.snapshotRevision(id);
    // Simulate a pre-Phase-2 snapshot: null out the v10 columns via executed SQL.
    await pool.query(
      'UPDATE memory_revisions SET scope = NULL, type = NULL, last_seen = NULL WHERE memory_id = $1 AND revision = $2',
      [id, snap.revision],
    );

    const restored = await dreams.restoreRevision(id, snap.revision);
    expect(restored).toBe(true);
    const row = await queries.peek(id);
    expect(row!.scope).toBe('project:pg-test'); // COALESCE kept the live value
    expect(row!.type).toBe('reference');
    expect(new Date(row!.last_seen!).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('dream_audit_log CHECK allows every permitted change class and rejects contested', async () => {
    const id = await storeOne('Audit CHECK probe.');
    const dream = await dreams.createDream({ trigger_source: 'manual', reason: 'pg executed-sql test' });
    // Every class the CHECK allows (SQLite v6/v7 ↔ PG v8/v9 parity) — the
    // apply path writes seven of these; 'reinforce' is allowed by the CHECK
    // but currently unwritten, covered here so a future writer has parity too.
    const allowed = ['exact_dup', 'decay', 'merge', 'supersede', 'reinforce', 'promote_global', 'rollback', 'conditional'] as const;
    for (const changeClass of allowed) {
      const entry = await dreams.appendAudit({
        dream_id: dream.id,
        memory_id: id,
        change_class: changeClass,
        action: 'archive',
      });
      expect(entry.change_class).toBe(changeClass);
    }
    const audit = await dreams.listAuditForDream(dream.id);
    expect(audit).toHaveLength(allowed.length);

    // The containment half: 'contested' is diff-only by design and the CHECK
    // must REJECT it — a dropped or widened constraint passes the allow-half
    // assertions above and only this one catches it. Pinned to the CHECK
    // violation SQLSTATE (23514): a generic throw (renamed column, dropped
    // default) must not satisfy the assertion.
    await expect(
      dreams.appendAudit({
        dream_id: dream.id,
        memory_id: id,
        change_class: 'contested' as never,
        action: 'archive',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ── Phase 3: scope registry + held runs + purge exemption (v11) ──────────
  // These tables sit outside the header's shared TRUNCATE (which predates
  // Phase 3 and covers only the memory/dream tables), so each block resets its
  // own state. All referents are synthetic.

  describe('Phase 3: scope_registry round-trip (PgScopeRegistryQueries)', () => {
    let registry: PgScopeRegistryQueries;

    beforeEach(async () => {
      registry = new PgScopeRegistryQueries(pool);
      await pool.query('TRUNCATE scope_registry');
    });

    it('register / conflict / updateStatus / rename execute real SQL', async () => {
      // register: RETURNING-based signal — true on a real insert...
      const first = await registry.register({
        scope: 'project:my-project',
        slug: 'project:my-project',
        claimant_raw: 'project:My Project',
        origin_cwd: 'C:/dev/My Project',
        status: 'provisional',
      });
      expect(first).toBe(true);

      // ...false on the ON CONFLICT DO NOTHING path (same scope, any payload).
      const conflict = await registry.register({
        scope: 'project:my-project',
        slug: 'project:my-project',
        claimant_raw: 'project:my-project',
        origin_cwd: 'C:/dev/other',
        status: 'quarantined',
      });
      expect(conflict).toBe(false);

      // The conflicting register changed NOTHING — first claimant wins.
      let [row] = await registry.listAll();
      expect(row).toMatchObject({
        scope: 'project:my-project',
        slug: 'project:my-project',
        claimant_raw: 'project:My Project',
        origin_cwd: 'C:/dev/My Project',
        status: 'provisional',
        reserved: false,
        ruled_at: null,
      });

      // updateStatus stamps status + ruled_at (COALESCE keeps it thereafter).
      await registry.updateStatus('project:my-project', 'confirmed', '2026-08-19T00:00:00.000Z');
      [row] = await registry.listAll();
      expect(row.status).toBe('confirmed');
      expect(row.ruled_at).toBe('2026-08-19T00:00:00.000Z');
      await registry.updateStatus('project:my-project', 'quarantined');
      [row] = await registry.listAll();
      expect(row.status).toBe('quarantined');
      expect(row.ruled_at).toBe('2026-08-19T00:00:00.000Z'); // preserved, not nulled

      // rename re-keys the PK and rewrites the slug.
      await registry.rename('project:my-project', 'project:second-project', 'project:second-project');
      const rows = await registry.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scope: 'project:second-project',
        slug: 'project:second-project',
        claimant_raw: 'project:My Project', // lineage survives the re-key
      });
    });

    it('rename onto an existing scope THROWS the PK unique violation (23505)', async () => {
      await registry.register({
        scope: 'project:alpha-scope', slug: 'project:alpha-scope',
        claimant_raw: 'project:alpha-scope', origin_cwd: null, status: 'provisional',
      });
      await registry.register({
        scope: 'project:beta-scope', slug: 'project:beta-scope',
        claimant_raw: 'project:beta-scope', origin_cwd: null, status: 'provisional',
      });
      // The store deliberately lets the PK conflict surface — the ruling
      // endpoint maps it to its deterministic 409. Pin the SQLSTATE.
      await expect(
        registry.rename('project:alpha-scope', 'project:beta-scope', 'project:beta-scope'),
      ).rejects.toMatchObject({ code: '23505' });
      // Nothing moved: both rows intact under their original keys.
      const scopes = (await registry.listAll()).map((r) => r.scope).sort();
      expect(scopes).toEqual(['project:alpha-scope', 'project:beta-scope']);
    });
  });

  describe('Phase 3: discovery_runs held status + watermarks + purge (PgObservationQueries)', () => {
    let obs: PgObservationQueries;

    beforeEach(async () => {
      obs = new PgObservationQueries(pool);
      await pool.query('TRUNCATE observations, discovery_runs RESTART IDENTITY');
    });

    it("v11 constraint swap took: INSERT status='held' succeeds, 'bogus' fails with 23514", async () => {
      // Direct SQL on purpose — this pins the CHECK constraint itself, not the
      // store's typed wrapper (which could never produce 'bogus').
      const held = await pool.query(
        `INSERT INTO discovery_runs (project_scope, observation_start_id, status)
         VALUES ('project:20260101-sprint', 1, 'held') RETURNING id, status`,
      );
      expect(held.rows[0].status).toBe('held');

      await expect(
        pool.query(
          `INSERT INTO discovery_runs (project_scope, observation_start_id, status)
           VALUES ('project:20260101-sprint', 1, 'bogus')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('global watermark advances over a held row; the per-scope watermark does not (pinned ids)', async () => {
      // Held run for an ephemeral scope, end id 7 (the ONLY run for it).
      const heldRun = await obs.createDiscoveryRun('project:20260101-sprint', 1);
      await obs.updateDiscoveryRun(heldRun.id, {
        status: 'held', observation_end_id: 7, observations_analyzed: 7,
        completed_at: new Date().toISOString(),
      });
      // Completed run for a real scope, end id 3.
      const doneRun = await obs.createDiscoveryRun('project:real-scope', 1);
      await obs.updateDiscoveryRun(doneRun.id, {
        status: 'completed', observation_end_id: 3, observations_analyzed: 3,
        completed_at: new Date().toISOString(),
      });

      // GLOBAL cursor: MAX over completed+held = 7 — the held batch was
      // consumed, so the global scan never re-fetches it (starvation fix).
      expect(await obs.getLastWatermark()).toBe(7);
      // PER-SCOPE cursor for the held scope: 0 — its observations are by
      // definition unprocessed, so a future re-drive starts from the beginning.
      expect(await obs.getLastWatermark('project:20260101-sprint')).toBe(0);
      // PER-SCOPE for the completed scope: its own completed end id.
      expect(await obs.getLastWatermark('project:real-scope')).toBe(3);
    });

    it('getActiveRun ignores a held row on real PG (held is terminal, never "in progress")', async () => {
      const heldRun = await obs.createDiscoveryRun('project:20260101-sprint', 1);
      await obs.updateDiscoveryRun(heldRun.id, {
        status: 'held', observation_end_id: 2, observations_analyzed: 2,
        completed_at: new Date().toISOString(),
      });
      expect(await obs.getActiveRun()).toBeNull();
      expect(await obs.getActiveRun('project:20260101-sprint')).toBeNull();

      // Positive control: a genuinely running row IS active — proves the
      // null above came from the predicate, not from an empty table.
      const running = await obs.createDiscoveryRun('project:real-scope', 3);
      expect((await obs.getActiveRun())?.id).toBe(running.id);
      expect((await obs.getActiveRun('project:real-scope'))?.id).toBe(running.id);
      expect(await obs.getActiveRun('project:20260101-sprint')).toBeNull();
    });

    it('purgeOlderThan honors exemptScopes against real rows (pinned survivor set)', async () => {
      // Six observations, ids 1..6 in insertion order:
      //   1,2,3 → exempt (held/ephemeral) scope       — will be AGED
      //   4,5   → purgeable scope                     — will be AGED
      //   6     → purgeable scope                     — stays FRESH
      const rows: [string, string][] = [
        ['project:20260101-sprint', 'exempt old 1'],
        ['project:20260101-sprint', 'exempt old 2'],
        ['project:20260101-sprint', 'exempt old 3'],
        ['project:real-scope', 'purgeable old 1'],
        ['project:real-scope', 'purgeable old 2'],
        ['project:real-scope', 'fresh survivor'],
      ];
      for (const [scope, input] of rows) {
        await obs.storeObservation({
          session_id: 'purge-probe', project_scope: scope,
          tool_name: 'Bash', input_summary: input,
        });
      }
      // Age ids 1-5 past the cutoff via executed SQL (created_at is
      // server-stamped on insert, so the probe must move it explicitly).
      await pool.query(
        "UPDATE observations SET created_at = NOW() - INTERVAL '30 days' WHERE id <= 5",
      );

      // batchSize 1 forces the windowed-delete loop to iterate — every pass
      // re-binds the exemption param ($3), so a param-shift bug can't hide
      // behind a single-batch run.
      const deleted = await obs.purgeOlderThan(7, 1, ['project:20260101-sprint']);
      expect(deleted).toBe(2); // ONLY the aged purgeable rows

      const survivors = await pool.query('SELECT id FROM observations ORDER BY id');
      // BIGINT ids arrive as strings from the pg driver — normalize the probe.
      expect(survivors.rows.map((r: { id: number | string }) => Number(r.id))).toEqual([1, 2, 3, 6]);
    });

    it('getObservationStats scopes oldest/newest to the requested project_scope (Phase 4 dormancy contract)', async () => {
      await obs.storeObservation({
        session_id: 'stats-probe', project_scope: 'project:stats-a',
        tool_name: 'Bash', input_summary: 'aged',
      });
      await obs.storeObservation({
        session_id: 'stats-probe', project_scope: 'project:stats-b',
        tool_name: 'Bash', input_summary: 'fresh',
      });
      await pool.query(
        "UPDATE observations SET created_at = NOW() - INTERVAL '100 days' WHERE project_scope = 'project:stats-a'",
      );

      // Scoped newest is A's own aged stamp — a global MAX would leak B's fresh one.
      const a = await obs.getObservationStats('project:stats-a');
      expect(a.newest).not.toBeNull();
      expect(Date.now() - new Date(a.newest!).getTime()).toBeGreaterThan(90 * 86400000);

      // A scope with no rows reads null, not the corpus-wide range.
      const empty = await obs.getObservationStats('project:stats-none');
      expect(empty.oldest).toBeNull();
      expect(empty.newest).toBeNull();
    });

    it('getHeldRunSummary reports PENDING vs total on real PG; a fully re-driven scope drops out (round-2 CO6)', async () => {
      // Scope A: held rows end 40 (4 obs) + end 42 (3 obs); a completed
      // re-drive covered through 41 → pending 3, total 7.
      const heldA1 = await obs.createDiscoveryRun('project:tmp-a', 0);
      await obs.updateDiscoveryRun(heldA1.id, {
        status: 'held', observations_analyzed: 4, observation_end_id: 40,
        completed_at: new Date().toISOString(),
      });
      const heldA2 = await obs.createDiscoveryRun('project:tmp-a', 40);
      await obs.updateDiscoveryRun(heldA2.id, {
        status: 'held', observations_analyzed: 3, observation_end_id: 42,
        completed_at: new Date().toISOString(),
      });
      const redriveA = await obs.createDiscoveryRun('project:tmp-a', 0);
      await obs.updateDiscoveryRun(redriveA.id, {
        status: 'completed', observations_analyzed: 4, observation_end_id: 41,
        completed_at: new Date().toISOString(),
      });

      // Scope B: fully re-driven (completed watermark = its held end id) —
      // 0 pending, DROPS OUT of the summary entirely.
      const heldB = await obs.createDiscoveryRun('project:tmp-b', 0);
      await obs.updateDiscoveryRun(heldB.id, {
        status: 'held', observations_analyzed: 2, observation_end_id: 10,
        completed_at: new Date().toISOString(),
      });
      const redriveB = await obs.createDiscoveryRun('project:tmp-b', 0);
      await obs.updateDiscoveryRun(redriveB.id, {
        status: 'completed', observations_analyzed: 2, observation_end_id: 10,
        completed_at: new Date().toISOString(),
      });

      // Numbers are real bigint SUMs from PG — the Number() casts in the store
      // are part of what this pins.
      expect(await obs.getHeldRunSummary()).toEqual([
        { scope: 'project:tmp-a', observations_pending: 3, observations_total: 7, last_end_id: 42 },
      ]);
    });
  });
});
