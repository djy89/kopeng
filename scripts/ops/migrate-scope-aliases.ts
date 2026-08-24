/**
 * migrate-scope-aliases.ts — audited bulk re-scope driver (T46 scope-alias layer).
 *
 * Migrates every memory living under an alias scope to its canonical scope, for
 * each pair in the operator-curated alias table (`operator_config.config.scope_aliases`,
 * see src/services/scope-alias.ts). Same audited-write machinery as
 * migrate-project-scope.ts (its single-pair predecessor): PUT /api/memories/:id per
 * row, never SQL against the live DB. Dry-run by default; nothing is written without
 * --apply.
 *
 * Deliberate wrinkle: once write-time canonicalization is deployed (Task 2), a
 * `PUT {scope: alias}` would be re-canonicalized server-side anyway — but this driver
 * does not rely on that, because it may run against a pre-deploy copy of the server.
 * It always sends the resolved canonical explicitly. Separately, `listScopeMemories`
 * calls `GET /api/memories?scope=<alias>`, which does NOT alias-expand (verified
 * against src/api/routes.ts: the list route passes `input.scope` straight through to
 * `queries.list()`; only `/api/memories/recall` calls `scopeAliases.expand()`) — but
 * that column match IS case-insensitive on both backends (`COLLATE NOCASE` in
 * queries.ts, `LOWER(...)` in pg-queries.ts). For a case-only pair (`client:Some-Alias`
 * → `client:some-alias`) the raw list would include rows already sitting on the
 * canonical scope, inflating `found`, wasting a write on an already-correct row, and
 * making the post-apply residual check NOCASE-match its own already-migrated rows
 * (residual > 0 on a successful run). The driver therefore filters every
 * `listScopeMemories(alias)` result to an exact (case-sensitive) scope match — both
 * for the migration set and the residual check — before counting or acting on it.
 *
 * Usage:
 *   npx tsx scripts/ops/migrate-scope-aliases.ts                          # dry-run, table from GET /api/operator-config
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --apply                  # writes
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases.json      # table override (also the copy-test path)
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --only client:acme-foods --apply   # restrict to specific alias scope(s), repeatable
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --allow-rejects        # run despite rejected table entries
 *
 * Env: MEMORY_API_URL (default http://localhost:3200), MEMORY_API_KEY / KOPENG_API_KEY / ADMIN_API_KEY.
 * Respects the server's 100-req/min rate limit (retries on 429 with Retry-After).
 *
 * Scratch-server verification (2026-08-10, against an in-memory scratch DB — never
 * data/memory.db or the live server on port 3200):
 *   DATABASE_TYPE=sqlite DATABASE_PATH=<scratch>/t46-scratch.db PORT=3299 npx tsx src/server.ts &
 *   # seeded 3 memories via POST /api/memories, alias table not yet configured so scope
 *   # lands as-is: 2 under client:acme-foods-old, 1 under client:the-fixture-co (control)
 *   # aliases.json = {"client:acme-foods-old":"client:acme-foods","client:selfmap-test":
 *   #   "client:selfmap-test","client:empty-alias":"client:empty-canonical"}
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases.json
 *     → "3 alias pair(s) · dry-run"; "client:acme-foods-old → client:acme-foods: 2 found";
 *       "skipping self-map client:selfmap-test"; "client:empty-alias → …: 0 found"; exit 0
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases.json --only client:acme-foods-old
 *     → "1 alias pair(s)"; filters to the one named pair, skips the rest of the table
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases.json --apply
 *     → "2 migrated, 0 failed"; residual 0; exit 0 — verified via GET that both rows
 *       landed on client:acme-foods and the control row never moved
 *   # PATCH /api/operator-config {config:{scope_aliases:{...}}} then re-run with no --file
 *     → GET /api/operator-config path loads the table (config arrives as a JSON string
 *       server-side — parsed defensively) and produces the same report shape
 *   MEMORY_API_URL=http://localhost:1/nope npx tsx … --file aliases.json
 *     → "fetch failed", exit 1 (server unreachable)
 *
 * Case-only-alias + malformed-table re-verification (2026-08-10, fresh scratch DB,
 * port 3298 — fix for the exact-case regression found in final review):
 *   # seeded 2 rows under client:Case-Alias + 1 row already on client:case-alias
 *   # aliases-case.json = {"client:Case-Alias":"client:case-alias"}
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases-case.json
 *     → "client:Case-Alias → client:case-alias: 2 found" — excludes the already-canonical
 *       row (pre-fix this would have read "3 found")
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases-case.json --apply
 *     → "2 migrated, 0 failed"; residual 0; exit 0 (pre-fix: residual 1, exit 1, on a
 *       fully-successful migration) — GET confirms all 3 rows now read client:case-alias
 *   # aliases-bad.json = ["client:a","client:b"] (array, not an object)
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases-bad.json --apply
 *     → "malformed alias table (--file …): expected a JSON object … got an array", exit 1,
 *       zero requests sent (row count for client:case-alias unchanged at 3)
 *   # aliases-bad2.json = {"client:acme-foods-old": 123} (non-string canonical)
 *   npx tsx scripts/ops/migrate-scope-aliases.ts --file aliases-bad2.json --apply
 *     → "malformed alias table (--file …): "client:acme-foods-old" maps to a non-string
 *       value", exit 1
 * Full transcript in .superpowers/sdd/2026-08-10-t46-scope-alias-layer/task-5-report.md.
 */

import dotenv from 'dotenv';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildScopeResolution } from '../../src/scopes/resolver.js';

// Load this repo's .env so ADMIN_API_KEY is present when run from a bare shell,
// where it is not otherwise in the environment. Non-overriding: an already-exported
// value wins. Without this the script silently 401s against a key-configured server
// (sweep-3 PB-2 made memory writes admin-gated).
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';
// Memory writes are ADMIN_API_KEY-gated (sweep-3 PB-2); the others are legacy fallbacks.
const API_KEY = process.env.ADMIN_API_KEY || process.env.MEMORY_API_KEY || process.env.KOPENG_API_KEY || '';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MAX_RATE_RETRIES = 6;
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    if (attempt >= MAX_RATE_RETRIES) return res;
    const retryAfter = Number(res.headers.get('retry-after')) || 60;
    const waitMs = Math.min(retryAfter, 65) * 1000;
    await res.text().catch(() => undefined);
    console.log(`  … rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_RETRIES})`);
    await sleep(waitMs);
  }
}

interface LiteMemory { id: number; scope: string; type: string; content: string }

async function listScopeMemories(scope: string): Promise<LiteMemory[]> {
  const all: LiteMemory[] = [];
  let cursor: number | undefined;
  do {
    const params = new URLSearchParams({ scope, fields: 'lite', limit: '1000' });
    if (cursor !== undefined) params.set('cursor', String(cursor));
    const res = await fetchWithRetry(`${API_URL}/api/memories?${params}`, { headers: authHeaders() }, 'list');
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text().catch(() => '')}`);
    const body = await res.json() as { data: LiteMemory[]; meta: { has_more?: boolean; cursor?: number } };
    all.push(...body.data);
    cursor = body.meta.has_more ? body.meta.cursor : undefined;
  } while (cursor !== undefined);
  return all;
}

// The server's scope match is case-insensitive (COLLATE NOCASE / LOWER(...)); a
// case-only alias pair would otherwise sweep in rows already on the canonical scope.
// Every caller of listScopeMemories that migrates or counts residuals filters to an
// exact match first.
async function listExactScopeMemories(scope: string): Promise<LiteMemory[]> {
  return (await listScopeMemories(scope)).filter(m => m.scope === scope);
}

/**
 * The accepted alias pairs, per the SHARED resolver (src/scopes/resolver.ts) —
 * the same accepted map the server canonicalizes writes through. Exported so
 * tests/unit/scope-definition-composition.test.ts can assert this driver and the
 * write path agree entry-for-entry. Before Phase 1 this file checked only
 * string-ness, so it would happily migrate rows under a chained mapping the
 * server ignores, i.e. migrate them straight back into drift.
 */
export function acceptedPairs(raw: unknown): [string, string][] {
  return Object.entries(buildScopeResolution(raw).table);
}

/** Rejected entries, for the report the operator reads before --apply. */
export function rejectedEntries(raw: unknown): { alias: string; reason: string }[] {
  return buildScopeResolution(raw).rejected.map(r => ({ alias: r.alias, reason: r.reason }));
}

// Flags: --apply (default dry-run) · --file <json> (alias table override; else GET /api/operator-config)
//        --only <alias> (repeatable: restrict to specific alias scopes)
//        --allow-rejects (run despite rejected table entries)
async function loadAliasTable(): Promise<unknown> {
  const file = arg('--file');
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetchWithRetry(`${API_URL}/api/operator-config`, { headers: authHeaders() }, 'config');
  if (!res.ok) throw new Error(`operator-config read failed: ${res.status}`);
  const body = await res.json() as { data: { config?: Record<string, unknown> | string } };
  let blob = body.data?.config ?? {};
  if (typeof blob === 'string') blob = JSON.parse(blob);
  const table = (blob as Record<string, unknown>).scope_aliases;
  if (table === undefined) throw new Error('no scope_aliases table in operator config');
  return table;
}

async function main(): Promise<void> {
  const raw = await loadAliasTable();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`malformed alias table: expected a JSON object of alias -> canonical, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  const resolution = buildScopeResolution(raw);
  const rejects = resolution.rejected.map(r => ({ alias: r.alias, reason: r.reason }));
  const onlys = process.argv.flatMap((a, i) => a === '--only' ? [process.argv[i + 1]] : []);
  const pairs = Object.entries(resolution.table).filter(([a]) => onlys.length === 0 || onlys.includes(a));
  console.log(`migrate-scope-aliases: ${pairs.length} accepted pair(s) · ${APPLY ? 'APPLY' : 'dry-run'} · ${API_URL}\n`);

  if (rejects.length > 0) {
    console.error(`  ${rejects.length} entr(ies) REJECTED by the shared resolver — the server ignores these at write time:`);
    for (const r of rejects) console.error(`    ${r.alias}  (${r.reason})`);
    if (!process.argv.includes('--allow-rejects')) {
      console.error('\n  Refusing to run: fix the table (PATCH /api/operator-config) or pass --allow-rejects to migrate the accepted pairs anyway.');
      process.exit(1);
    }
    console.error('  --allow-rejects given: continuing with the accepted pairs only.\n');
  }

  let totalMigrated = 0, totalFailed = 0;
  const rows: { alias: string; canonical: string; found: number; migrated: number; failed: number; residual: number }[] = [];
  for (const [alias, canonical] of pairs) {
    const memories = await listExactScopeMemories(alias);
    let migrated = 0, failed = 0;
    for (const m of memories) {
      if (!APPLY) continue;
      const res = await fetchWithRetry(`${API_URL}/api/memories/${m.id}`,
        { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ scope: canonical }) }, `update ${m.id}`);
      res.ok ? migrated++ : (failed++, console.error(`  ! id=${m.id}: ${res.status}`));
    }
    const residual = APPLY ? (await listExactScopeMemories(alias)).length : 0;
    rows.push({ alias, canonical, found: memories.length, migrated, failed, residual });
    totalMigrated += migrated; totalFailed += failed;
    console.log(`  ${alias} → ${canonical}: ${memories.length} found${APPLY ? `, ${migrated} migrated, ${failed} failed, residual ${residual}` : ''}`);
  }
  console.log(`\n${APPLY ? 'Done' : 'Dry-run'}: ${APPLY ? `${totalMigrated} migrated, ${totalFailed} failed` : `${rows.reduce((s, r) => s + r.found, 0)} would migrate across ${rows.length} pairs`}`);
  if (APPLY && (totalFailed > 0 || rows.some(r => r.residual > 0))) process.exit(1);
}

// Guarded so tests/unit/scope-definition-composition.test.ts can import this
// module (for acceptedPairs) without the CLI driver firing on import — an
// unguarded main() would run process.exit(1) on a rejected/unreachable table
// and kill the vitest process. tsx sets process.argv[1] to the script path when
// run from the CLI, so the guard still holds there.
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch(err => {
    console.error(`migrate-scope-aliases failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
