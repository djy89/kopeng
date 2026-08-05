/**
 * migrate-project-scope.ts — bulk memory scope rename (Tier B of the KOPENG rename).
 *
 * Repointing every memory in one project scope to another, via the audited
 * PUT /api/memories/:id update route (never SQL against the live DB). Built for
 * a project-scope migration after a repo directory rename, but generic.
 * Dry-run by default; nothing is written without --apply.
 *
 * Usage:
 *   npx tsx scripts/ops/migrate-project-scope.ts --from project:old-name --to project:kopeng
 *   npx tsx scripts/ops/migrate-project-scope.ts --from project:old-name --to project:kopeng --apply
 *
 * Env: MEMORY_API_URL (default http://localhost:3200), MEMORY_API_KEY / KOPENG_API_KEY.
 * Respects the server's 100-req/min rate limit (retries on 429 with Retry-After).
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

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
const FROM = arg('--from');
const TO = arg('--to');
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

async function main(): Promise<void> {
  if (!FROM || !TO || FROM === TO) {
    console.error('Usage: migrate-project-scope.ts --from <scope> --to <scope> [--apply]');
    process.exit(2);
  }
  console.log(`migrate-project-scope: ${FROM} → ${TO}`);
  console.log(`  API URL: ${API_URL}`);
  console.log(`  Mode:    ${APPLY ? 'APPLY (writes)' : 'dry-run (read-only)'}\n`);

  const memories = await listScopeMemories(FROM);
  console.log(`  Found ${memories.length} memories in ${FROM}`);
  if (memories.length === 0) return;

  let migrated = 0;
  let failed = 0;
  for (const m of memories) {
    const excerpt = m.content.replace(/\s+/g, ' ').slice(0, 70);
    if (!APPLY) {
      console.log(`  [dry-run] id=${m.id} (${m.type}) "${excerpt}"`);
      continue;
    }
    const res = await fetchWithRetry(
      `${API_URL}/api/memories/${m.id}`,
      { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ scope: TO }) },
      `update ${m.id}`,
    );
    if (!res.ok) {
      failed++;
      console.error(`  ! failed id=${m.id}: ${res.status} ${await res.text().catch(() => '')}`);
      continue;
    }
    migrated++;
    if (migrated % 50 === 0) console.log(`  … ${migrated}/${memories.length}`);
  }

  if (APPLY) {
    console.log(`\nDone: ${migrated} migrated, ${failed} failed.`);
    const residual = await listScopeMemories(FROM);
    console.log(`Residual in ${FROM}: ${residual.length} (expect 0)`);
    if (failed > 0 || residual.length > 0) process.exit(1);
  } else {
    console.log(`\nDry-run only — ${memories.length} would migrate. Re-run with --apply.`);
  }
}

main().catch(err => {
  console.error(`migrate-project-scope failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
