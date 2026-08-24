/**
 * Server-construction wiring suite (Phase 4, Task 2).
 *
 * Two prior phases each shipped a Critical where a component honored its
 * alias/registry closure but server.ts threaded the wrong one or none
 * (Phase-2 "NEW-1": apply-path canonicalize wired on the resolve path only;
 * Phase-3 "C1": the discovery scheduler's resolveScope skipped the alias
 * table). This suite is the permanent net for that failure class: every probe
 * drives a REAL request or engine run through the composed server and asserts
 * a value that DIFFERS when the closure is unthreaded — never "closure is
 * defined".
 *
 * One composed server, one disposable temp-dir SQLite corpus, probes run
 * sequentially in declaration order (probe 4 consumes probe 3's dream; probe 5
 * reseeds its own pair because probe 4's auto-apply archived one member).
 * Arming auto_accept_exact_dup here (probe 3) touches ONLY this throwaway DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryType, DreamDiff, DreamDiffEntry } from '../../src/types/types.js';

// This suite is SERIAL and must not share a worker with other DB suites:
// getDatabase() is a process-global singleton keyed off env-derived config.
// (Vitest's default per-file isolation gives this file its own worker + module
// graph, so the env-before-dynamic-import pattern below is safe.)
let tmpDir: string;
let server: typeof import('../../src/server.js');
let composed: Awaited<ReturnType<typeof server.composeServer>>;

// Hand-crafted unit vectors, replay-harness style: same axis ⇒ cosine 1.0,
// different axes ⇒ cosine 0 — the suite never loads an embedding model.
function unitVec(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

function vecBuf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Direct store write — deliberately BYPASSES route canonicalization, so a
 * row can be seeded genuinely adrift on an alias-variant scope (the
 * pre-migration state the dream/ops probes need). */
async function seedMemory(opts: {
  content: string;
  scope: string;
  type?: MemoryType;
  confidence?: number;
  embedding?: Float32Array;
}): Promise<number> {
  const result = await composed.ctx.stores.queries.store({
    content: opts.content,
    type: opts.type ?? 'project',
    scope: opts.scope,
    source: null,
    source_path: null,
    metadata: '{}',
    embedding: opts.embedding ? vecBuf(opts.embedding) : null,
    embedding_model: 'wiring-fixture',
    created_by: null,
    tags: [],
    confidence: opts.confidence,
  });
  expect(result.deduplicated).toBe(false);
  return result.id;
}

async function patchOperatorConfig(payload: Record<string, unknown>): Promise<void> {
  const res = await composed.app.inject({ method: 'PATCH', url: '/api/operator-config', payload });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-wiring-'));
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_PATH = path.join(tmpDir, 'memory.db');
  process.env.HOST = '127.0.0.1';
  // composeServer never listens, but if a regression re-introduces an
  // import-time boot, PORT=0 keeps it off the live server's 3200.
  process.env.PORT = '0';
  // Dreaming + discovery + ingestion ON so every closure consumer is constructed.
  process.env.DREAMING_ENABLED = 'true';
  process.env.OBSERVATION_INGESTION_ENABLED = 'true';
  process.env.DISCOVERY_DETECTION_ENABLED = 'true';
  // Pin every other optional-service flag OFF and both API keys open: dotenv
  // fills only UNSET vars, so without these a repo .env could arm the reasoner,
  // Neo4j/Redis/MinIO, or an admin key inside the composed app.
  process.env.DREAM_REASONER_ENABLED = 'false';
  process.env.NEO4J_ENABLED = 'false';
  process.env.REDIS_ENABLED = 'false';
  process.env.MINIO_ENABLED = 'false';
  process.env.ADMIN_API_KEY = '';
  process.env.OBSERVATION_API_KEY = '';
  process.env.PRIMARY_SCOPE = '';
  // Probe 2's pooled-evidence math (2 + 2 observations across two alias
  // variants) is calibrated against the 3-occurrence bar.
  process.env.DISCOVERY_MIN_OCCURRENCES = '3';
  // Probe 6b's dormancy signal is a 100d-old observation history; the default
  // 7d retention would let §1's purge delete it before §2 ever reads it.
  process.env.OBSERVATION_RETENTION_DAYS = '365';
  server = await import('../../src/server.js'); // must NOT boot: entry guard
  composed = await server.composeServer();

  // The operator alias table, stored through the real route so the service
  // cache is invalidated the way production does it. Synthetic scopes only.
  await patchOperatorConfig({
    config: { scope_aliases: { 'client:Variant-X': 'client:variant-x' } },
  });
}, 60_000);

afterAll(async () => {
  await composed?.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('composeServer', () => {
  it('composes without listening and serves /api/health via inject', async () => {
    const res = await composed.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    // The inert contract: composeServer builds everything but never listens.
    expect(composed.app.server.listening).toBe(false);
  });

  it('exposes the full AppContext (stores + services wired)', () => {
    expect(composed.ctx.stores.queries).toBeDefined();
    expect(composed.ctx.services.embeddingIndex).toBeDefined();
    // Dreaming enabled ⇒ alias service + registry constructed:
    expect(composed.ctx.services.scopeAliases).toBeDefined();
    expect(composed.ctx.services.scopeRegistry).toBeDefined();
  });
});

describe('alias-closure wiring probes (sequential — one shared corpus)', () => {
  // Probe 3 seeds these; probe 4 asserts the auto-apply outcome on them.
  let adriftId = 0;
  let canonicalId = 0;
  let exactDupEntry: DreamDiffEntry | undefined;

  it('probe 1 — write path: POST /api/memories canonicalizes an aliased scope', async () => {
    const res = await composed.app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'probe one content', scope: 'client:Variant-X', type: 'reference' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: number; scope: string } };
    // Unthreaded canonicalizeScope ⇒ the raw variant survives on the row.
    expect(body.data.scope).toBe('client:variant-x');
    const row = await composed.ctx.stores.queries.peek(body.data.id);
    expect(row?.scope).toBe('client:variant-x');
  });

  it('probe 2 — discovery run: alias-variant evidence pools toward the occurrence bar (the C1 shape)', async () => {
    // 2 + 2 observations of the same tool+input, split across the two raw
    // variants. Only the RESOLVED grouping (alias-first resolveScope, round-2
    // A3) pools them past minOccurrences=3 — unthreaded, each raw group holds
    // 2 < 3 and NO discovery memory is created. No metadata.cwd: origin stays
    // null, so the registered canonical passes (decideMint Rule 4) without
    // quarantine mechanics entering this probe.
    const res = await composed.app.inject({
      method: 'POST',
      url: '/api/observations/batch',
      payload: {
        observations: [
          { session_id: 'wiring-a-1', project_scope: 'client:Variant-X' },
          { session_id: 'wiring-a-2', project_scope: 'client:Variant-X' },
          { session_id: 'wiring-b-1', project_scope: 'client:variant-x' },
          { session_id: 'wiring-b-2', project_scope: 'client:variant-x' },
        ].map(o => ({ ...o, tool_name: 'Grep', input_summary: 'wiring-shared-config-check' })),
      },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { meta: { count: number } }).meta.count).toBe(4);

    // A REAL engine run through the scheduler's public path (the same
    // executeDiscovery → runGuarded chain the ticks use).
    const result = await composed.ctx.services.discoveryScheduler!.triggerNow();
    expect(result.memories_created).toBe(1);

    const list = await composed.app.inject({ method: 'GET', url: '/api/memories?type=discovery&limit=50' });
    expect(list.statusCode).toBe(200);
    const discoveries = (list.json() as { data: Array<{ scope: string }> }).data;
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0].scope).toBe('client:variant-x');
  });

  it('probe 3 — dream selector grouping: an adrift/canonical pair collapses as same-scope exact_dup with canonical provenance', async () => {
    // Armed BEFORE the trigger so probe 4 exercises the one UNATTENDED apply
    // path (the NEW-1 shape). This DB is disposable — never live config.
    await patchOperatorConfig({ auto_accept_exact_dup: true });

    // Byte-distinct (store()'s global content-hash dedup) but normalize-equal
    // (the selector's exact_dup predicate); same unit vector ⇒ cosine 1.0.
    // The ADRIFT row gets the higher confidence so pickKeepTarget proposes IT
    // as survivor — only the apply-path canonical-survivor swap (probe 4) can
    // move the keep to the canonical row.
    adriftId = await seedMemory({
      content: 'Alias pair fact one', scope: 'client:Variant-X',
      confidence: 0.9, embedding: unitVec(0),
    });
    canonicalId = await seedMemory({
      content: 'alias pair fact one', scope: 'client:variant-x',
      confidence: 0.6, embedding: unitVec(0),
    });

    const res = await composed.app.inject({
      method: 'POST',
      url: '/api/dreams/trigger',
      payload: { window_key: 'wiring-probe-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { status: string; dream_id: number } };
    expect(body.data.status).toBe('completed');

    const dream = await composed.ctx.stores.dreams!.getDream(body.data.dream_id);
    const diff = JSON.parse(dream!.output_diff!) as DreamDiff;
    // Unthreaded selector closure ⇒ the pair reads cross-scope ⇒ a
    // promote_global signal, never an exact_dup entry ⇒ this find fails.
    exactDupEntry = diff.entries.find(e =>
      e.change_class === 'exact_dup' &&
      e.memory_ids.includes(adriftId) &&
      e.memory_ids.includes(canonicalId));
    expect(exactDupEntry).toBeDefined();

    const members = exactDupEntry!.provenance!.members;
    const adrift = members.find(m => m.id === adriftId)!;
    const canonical = members.find(m => m.id === canonicalId)!;
    // Raw scope stays lineage; effective_scope is the diff generator's own
    // canonicalization (unthreaded ⇒ effective === raw for the adrift row).
    expect(adrift.scope).toBe('client:Variant-X');
    expect(adrift.effective_scope).toBe('client:variant-x');
    expect(canonical.effective_scope).toBe('client:variant-x');
    expect(typeof exactDupEntry!.provenance!.alias_table_version).toBe('string');
  });

  it('probe 4 — apply engine path (the NEW-1 shape): auto-apply keeps the canonical row and archives the variant', async () => {
    // pickKeepTarget proposed the higher-confidence ADRIFT row; the engine's
    // apply closure (DreamEngineDeps.apply.canonicalizeScope, wired in
    // server.ts) must swap survivor to the already-canonical row. Unthreaded ⇒
    // no swap ⇒ keep_id === adriftId and the canonical row is archived.
    expect(exactDupEntry!.resolution).toBe('auto_applied');
    expect((exactDupEntry!.after as { keep_id: number }).keep_id).toBe(canonicalId);

    const adrift = await composed.ctx.stores.queries.peek(adriftId);
    const canonical = await composed.ctx.stores.queries.peek(canonicalId);
    expect(adrift).toBeDefined();
    expect(canonical).toBeDefined();
    expect(!!adrift!.is_archived).toBe(true);
    expect(!!canonical!.is_archived).toBe(false);
  });

  it('probe 5 — corpus-health: an alias-variant pair classifies actionable, not cross_scope', async () => {
    // Fresh pair (probe 4 archived one member of probe 3's) on its OWN axis so
    // no cross-pair cosine reaches the duplicate threshold.
    await seedMemory({
      content: 'Alias pair fact two', scope: 'client:Variant-X',
      confidence: 0.6, embedding: unitVec(1),
    });
    await seedMemory({
      content: 'alias pair fact two', scope: 'client:variant-x',
      confidence: 0.6, embedding: unitVec(1),
    });

    const res = await composed.app.inject({ method: 'GET', url: '/api/ops/corpus-health' });
    expect(res.statusCode).toBe(200);
    const pairs = (res.json() as {
      data: { duplicate_pairs: { total: number; actionable: number; cross_scope: number } };
    }).data.duplicate_pairs;
    // Unthreaded ops closure ⇒ the same pair buckets cross_scope and
    // `actionable` reads 0 — the watchdog blind exactly when it matters.
    expect(pairs.actionable).toBe(1);
    expect(pairs.cross_scope).toBe(0);
  });

  it('probe 6 — maintenance §3: the 3-distinct-scope bar counts CANONICALIZED scopes', async () => {
    // Variant group: THREE raw scopes that canonicalize to TWO — qualifies for
    // §3 iff the closure is unthreaded (raw count 3 ≥ bar; canonical 2 < bar).
    // Contents are byte-distinct case variants (store()'s hash dedup) that
    // normalize-equal (§3's grouping predicate). Confidence 0.85 clears the
    // ≥0.8 average bar, so scope-counting is the ONLY discriminator.
    await seedMemory({ content: 'Wiring bar fact alpha', scope: 'client:Variant-X', type: 'discovery', confidence: 0.85 });
    await seedMemory({ content: 'wiring bar fact alpha', scope: 'client:variant-x', type: 'discovery', confidence: 0.85 });
    await seedMemory({ content: 'WIRING BAR FACT ALPHA', scope: 'client:wiring-extra', type: 'discovery', confidence: 0.85 });
    // Control group: three GENUINELY distinct scopes — proves the §3 grouping
    // machinery sees these seeds at all (it is withheld, not promoted, because
    // auto_promote_global stays OFF — the GATE-1 default this suite never arms).
    await seedMemory({ content: 'Wiring bar fact beta', scope: 'client:wiring-ctrl-a', type: 'discovery', confidence: 0.85 });
    await seedMemory({ content: 'wiring bar fact beta', scope: 'client:wiring-ctrl-b', type: 'discovery', confidence: 0.85 });
    await seedMemory({ content: 'WIRING BAR FACT BETA', scope: 'client:wiring-ctrl-c', type: 'discovery', confidence: 0.85 });

    const res = await composed.app.inject({ method: 'POST', url: '/api/admin/discovery/maintain' });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as {
      data: { memories_promoted: number; memories_withheld: number };
    }).data;
    expect(data.memories_promoted).toBe(0);
    // Control group only (3). Unthreaded canonicalizeScope ⇒ the variant group
    // also qualifies and is withheld too ⇒ 6.
    expect(data.memories_withheld).toBe(3);
  });

  it('probe 8 — registry primary: a scopeless write lands on the CANONICALIZED primary scope (CO1)', async () => {
    await patchOperatorConfig({ primary_scope: 'client:Variant-X' });

    const res = await composed.app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { content: 'probe eight content', type: 'reference' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      data: { scope: string };
      meta: { scope_defaulted?: { stored_as: string; primary_scope_set: boolean } };
    };
    // Unthreaded ScopeRegistryService.canonicalize ⇒ raw 'client:Variant-X';
    // no primary resolution at all ⇒ 'project:_unrouted'. Both must fail.
    expect(body.data.scope).toBe('client:variant-x');
    expect(body.meta.scope_defaulted).toMatchObject({
      stored_as: 'client:variant-x',
      primary_scope_set: true,
    });
  });

  it('probe 6b — maintenance §2 dormancy reads the ALIAS GROUP: stale history under the canonical freezes a decayed row adrift on the variant', async () => {
    // Declared after every count-pinning probe (the suite's mutation-safe
    // slot; only the read-only probe 7 follows): its seeds and config arming must
    // not disturb the counts probes 5/6 pinned. A FRESH alias pair is used —
    // probe 2 wrote observations on both Variant-X scopes at "now", which
    // would read that group ACTIVE and defeat the freeze this probe proves.
    // `scope_aliases` is ONE config-blob key (T46 whole-map replace): the
    // PATCH resends the full map, existing entry included.
    await patchOperatorConfig({
      config: {
        scope_aliases: {
          'client:Variant-X': 'client:variant-x',
          'client:Wiring-Dorm': 'client:wiring-dorm',
        },
      },
    });

    // >30d-stale observation history under the CANONICAL scope only; the raw
    // variant has none. Ingested through the real route, then aged via the
    // process-singleton observations DB (created_at is server-stamped).
    // OBSERVATION_RETENTION_DAYS is pinned high in beforeAll so §1's purge
    // cannot delete this history before §2 reads it.
    const obsRes = await composed.app.inject({
      method: 'POST',
      url: '/api/observations/batch',
      payload: {
        observations: [{
          session_id: 'wiring-dorm-1', project_scope: 'client:wiring-dorm',
          tool_name: 'Read', input_summary: 'wiring-dorm-history',
        }],
      },
    });
    expect(obsRes.statusCode).toBe(201);
    // Dynamic import (suite invariant): a static src import would load config.ts
    // before beforeAll sets the env and un-tmpdir the whole suite.
    const { getObservationsDatabase } = await import('../../src/database/observations-db.js');
    getObservationsDatabase(process.env.DATABASE_PATH!).prepare(
      `UPDATE observations SET created_at = datetime('now', '-100 days'),
         started_at = datetime('now', '-100 days') WHERE session_id = 'wiring-dorm-1'`,
    ).run();

    // A decayed discovery row ADRIFT on the variant (direct seed bypasses
    // write-path canonicalization), aged past every half-life.
    const dormId = await seedMemory({
      content: 'wiring dorm decayed fact', scope: 'client:Wiring-Dorm',
      type: 'discovery', confidence: 0.5,
    });
    const { getDatabase } = await import('../../src/database/database.js');
    getDatabase().prepare(
      `UPDATE memories SET last_seen = datetime('now', '-400 days'),
         updated_at = datetime('now', '-400 days'), observation_count = 1 WHERE id = ?`,
    ).run(dormId);

    // Arm the GATE-1 decay flag — this disposable DB only. Armed, an
    // UNTHREADED expandScope reads only the raw scope (no observations ⇒ no
    // dormancy signal ⇒ decay applies) and ARCHIVES the row; the threaded
    // group reads the canonical's 100d-stale history ⇒ DORMANT ⇒ frozen.
    await patchOperatorConfig({ auto_accept_decay: true });

    const res = await composed.app.inject({ method: 'POST', url: '/api/admin/discovery/maintain' });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as {
      data: { memories_archived: number; memories_withheld: number };
    }).data;
    expect(data.memories_archived).toBe(0);
    // §3's control group (probe 6) re-detects and withholds exactly 3 again —
    // 6b's seeds are additive-neutral there (a group of one, canonical bar
    // still 2 for the variant group). A frozen §2 row is SKIPPED, not
    // withheld: dormancy removes it from the at-risk set entirely.
    expect(data.memories_withheld).toBe(3);

    const row = await composed.ctx.stores.queries.peek(dormId);
    expect(!!row?.is_archived).toBe(false);
  });

  it('probe 7 — /api/surface: an alias-variant project_scope surfaces the canonical-scope procedural skill', async () => {
    // Declared after 6b — additive-safe: one skill-tagged seed (no embedding,
    // so probe 5's cosine-pair counts could not have seen it anyway) plus a
    // read-only surface call; nothing runs after this probe.
    //
    // The alias must be differently-NAMED, not a case variant: the SQLite
    // scope filter is COLLATE NOCASE, so 'client:Variant-X' would reach rows
    // on 'client:variant-x' even with the closures unthreaded and the probe
    // would not discriminate. `scope_aliases` is ONE config-blob key (T46
    // whole-map replace) — resend the full map, existing entries included.
    await patchOperatorConfig({
      config: {
        scope_aliases: {
          'client:Variant-X': 'client:variant-x',
          'client:Wiring-Dorm': 'client:wiring-dorm',
          'client:variant-x-legacy': 'client:variant-x',
        },
      },
    });

    // A skill-tagged discovery memory on the CANONICAL scope, seeded directly.
    // No embedding: the composed app never loads the embedder, so surface()
    // falls back to a zero query vector and the FTS leg is the only scorer —
    // the request prompt shares this content's distinctive tokens.
    const stored = await composed.ctx.stores.queries.store({
      content: 'Grep(wiring-probe) → Read(wiring-manifest): recurring surfacing manifest workflow',
      type: 'discovery',
      scope: 'client:variant-x',
      source: null,
      source_path: null,
      metadata: JSON.stringify({
        external_key: 'skill:grep(wiring-probe)>read(wiring-manifest)',
        name: 'Grep(wiring-probe) → Read(wiring-manifest)',
      }),
      embedding: null,
      embedding_model: 'wiring-fixture',
      created_by: null,
      tags: ['auto-discovered', 'sequence', 'skill'],
      confidence: 0.6,
    });
    expect(stored.deduplicated).toBe(false);

    // Unthreaded surface closures ⇒ the procedural lane searches only the raw
    // 'client:variant-x-legacy' (which holds no rows under any collation) ⇒
    // the skill is absent. Threaded ⇒ canonicalize resolves the alias and
    // expand pulls the 'client:variant-x' group ⇒ the skill surfaces.
    const res = await composed.app.inject({
      method: 'POST',
      url: '/api/surface',
      payload: {
        prompt: 'recurring surfacing manifest workflow probe',
        project_scope: 'client:variant-x-legacy',
      },
    });
    expect(res.statusCode).toBe(200);
    const skills = (res.json() as {
      data: { skills: Array<{ key: string; binding: string }> };
    }).data.skills;
    const skill = skills.find(s => s.key === 'skill:grep(wiring-probe)>read(wiring-manifest)');
    expect(skill).toBeDefined();
    expect(skill!.binding).toBe('advisory');
  });
});
