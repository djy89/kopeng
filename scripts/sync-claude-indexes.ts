/**
 * Idempotent sync: ~/.claude/{TOOLS_INDEX,SKILLS_INDEX,PROJECT_INDEX}.md → KOPENG REST API
 *
 * Usage:
 *   npx tsx scripts/sync-claude-indexes.ts [--dry-run] [--prune]
 *
 * Requires the REST server to be running on MEMORY_API_URL (default http://localhost:3200).
 * Optional KOPENG_API_KEY env var for auth.
 *
 * Idempotency strategy:
 *   1. Content-hash dedup — the store already deduplicates identical content; a second run
 *      with unchanged entries gets 200 (deduplicated) from POST /api/memories and creates nothing.
 *   2. External-key reconcile — each entry carries metadata.external_key (e.g. "tool:KOPENG").
 *      Before storing, we search for an existing memory with that key in the target scope.
 *      If found AND content changed → PUT /api/memories/:id (update, not a new row).
 *      If found AND content unchanged → skip (already handled by content-hash, but we short-circuit).
 *      If not found → POST /api/memories (create).
 *
 * --dry-run: prints what would happen without making any API calls that write data.
 * --prune:   archives memories whose external_key no longer appears in any index file.
 *
 * CATALOG-TIER CONFIDENCE: 0.55
 *   Rationale: sits just above the "noted" auto-discovery floor (≤0.55) so catalog entries
 *   surface in their own scope queries but lose to real project/global memories (which start
 *   at 0.6+ and climb via reinforcement). They will NEVER be auto-archived by the decay path
 *   (they are type:'reference', not type:'discovery'), and they are not hard-anchored (not 1.0),
 *   so operators can update/archive them normally.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
// Load this repo's .env so ADMIN_API_KEY is present when run from a scheduled
// task or a bare shell, where it is not otherwise in the environment. Non-
// overriding: a value already exported wins. Without this the script silently
// 401s against a key-configured server (sweep-3 PB-2 made memory writes gated).
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IndexKind = 'tool' | 'skill' | 'convention';

export interface IndexEntry {
  /** Human-readable name */
  name: string;
  /** One-line description / hook */
  description: string;
  /** Stable external key, e.g. "tool:KOPENG" or "skill:handoff" */
  external_key: string;
  /** Memory scope */
  scope: string;
  /** Source index filename (no directory, e.g. "TOOLS_INDEX.md") */
  source_file: string;
  /** Entry kind for tag generation */
  kind: IndexKind;
}

// ---------------------------------------------------------------------------
// Pure parser — exported so unit tests can import it with no network/FS side effects
// ---------------------------------------------------------------------------

/**
 * Parse a Markdown table from raw text.
 * Returns an array of row arrays (cells), skipping the header separator row.
 */
export function parseMarkdownTableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Skip separator rows (cells contain only dashes/colons/spaces)
    const cells = trimmed
      .split('|')
      .slice(1, -1) // drop leading/trailing empty strings from outer pipes
      .map(c => c.trim());
    if (cells.length === 0) continue;
    if (cells.every(c => /^[-:\s]*$/.test(c))) continue; // separator
    rows.push(cells);
  }
  return rows;
}

/**
 * Slugify a name to a stable lowercase key component.
 * Preserves alphanumerics, replaces others with hyphens, collapses runs.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse TOOLS_INDEX.md into IndexEntry[].
 *
 * Format: one or more `## Section` headings, each followed by a Markdown table.
 * First column = tool name; second column = description/purpose.
 * Skip rows where the first cell looks like a header or placeholder ("Tool", "*Coming soon*", etc.).
 */
export function parseToolsIndex(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const rows = parseMarkdownTableRows(markdown);
  for (const row of rows) {
    if (row.length < 2) continue;
    const rawName = row[0];
    const name = stripMarkdownLinks(rawName).replace(/~~/g, '').trim();
    const description = stripMarkdownLinks(row[1]);
    if (!name || isHeaderCell(name)) continue;
    if (!description || description === '*Coming soon*') continue;
    // Skip deprecated/retired tools — struck-through name (~~Tool~~) or a
    // "DEPRECATED" marker in the description — so a superseded entry stops
    // being surfaced as a live suggestion while staying in the doc as history.
    if (rawName.includes('~~') || /^DEPRECATED\b/i.test(description)) continue;
    const key = `tool:${slugify(name)}`;
    entries.push({
      name,
      description,
      external_key: key,
      scope: 'client:claude-tool',
      source_file: 'TOOLS_INDEX.md',
      kind: 'tool',
    });
  }
  return entries;
}

/**
 * Parse SKILLS_INDEX.md into IndexEntry[].
 *
 * The "Available Skills" table has columns: Skill | Command | Purpose | Status
 * We use col 0 (skill name) and col 2 (purpose) as the one-line description.
 * The stable key is derived from the command slug (col 1) or skill name if no command.
 */
export function parseSkillsIndex(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const rows = parseMarkdownTableRows(markdown);
  for (const row of rows) {
    if (row.length < 2) continue;
    const name = stripMarkdownLinks(row[0]).replace(/\*\*/g, '').replace(/⭐/g, '').trim();
    const command = row.length > 1 ? stripMarkdownLinks(row[1]).trim() : '';
    const purpose = row.length > 2 ? stripMarkdownLinks(row[2]).trim() : '';
    const description = purpose || command || name;
    if (!name || isHeaderCell(name)) continue;

    // Derive slug from command (e.g. "/handoff" → "handoff") or fall back to name
    const cmdSlug = command.startsWith('/') ? command.slice(1).trim() : '';
    const slug = cmdSlug || slugify(name);
    const key = `skill:${slug}`;

    entries.push({
      name,
      description,
      external_key: key,
      scope: 'client:claude-skill',
      source_file: 'SKILLS_INDEX.md',
      kind: 'skill',
    });
  }
  return entries;
}

/**
 * Parse PROJECT_INDEX.md into IndexEntry[].
 *
 * Each project row becomes a memory in `project:<slug>` scope (per-project convention).
 * The project name is col 0; status (col 1) + location (col 2) form the description.
 * There is no global-convention scope used from PROJECT_INDEX in the current data model —
 * all PROJECT_INDEX rows are project-specific.
 */
export function parseProjectIndex(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const rows = parseMarkdownTableRows(markdown);
  for (const row of rows) {
    if (row.length < 2) continue;
    const rawName = stripMarkdownLinks(row[0]).replace(/\*\*/g, '').trim();
    const name = rawName.replace(/[🛠️🏢🏠📊🔧⭐]/gu, '').trim();
    if (!name || isHeaderCell(name)) continue;

    const status = row.length > 1 ? stripMarkdownLinks(row[1]).trim() : '';
    const location = row.length > 2 ? stripMarkdownLinks(row[2]).trim() : '';
    const description = [status, location].filter(Boolean).join(' — ');
    if (!description) continue;

    const slug = slugify(name);
    if (!slug) continue;
    const key = `convention:${slug}`;

    entries.push({
      name,
      description,
      external_key: key,
      scope: `project:${slug}`,
      source_file: 'PROJECT_INDEX.md',
      kind: 'convention',
    });
  }
  return entries;
}

/**
 * Build the memory content string for an entry.
 * Format: "<Name>: <description>" — simple, searchable, stable.
 */
export function buildContent(entry: IndexEntry): string {
  return `${entry.name}: ${entry.description}`;
}

// ---------------------------------------------------------------------------
// Internal parser helpers (not exported — no external callers)
// ---------------------------------------------------------------------------

function stripMarkdownLinks(text: string): string {
  // [text](url) → text
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

function isHeaderCell(cell: string): boolean {
  const lower = cell.toLowerCase();
  return (
    lower === 'tool' ||
    lower === 'skill' ||
    lower === 'project' ||
    lower === 'service' ||
    lower === 'purpose' ||
    lower === 'status' ||
    lower === 'command'
  );
}

// ---------------------------------------------------------------------------
// API client helpers
// ---------------------------------------------------------------------------

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';
// Memory writes are ADMIN_API_KEY-gated (sweep-3 PB-2). The KOPENG_API_KEY
// fallback is the observation key — kept so an existing single-key setup still
// works when only that one is configured, but ADMIN_API_KEY wins.
const API_KEY = process.env.ADMIN_API_KEY || process.env.KOPENG_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');

// Catalog-tier confidence — see module header for rationale.
const CATALOG_CONFIDENCE = 0.55;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

/** Sleep helper for rate-limit backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch wrapper that respects the server's 100-req/min rate limit. On HTTP 429 it
 * reads Retry-After (seconds; default 60, capped at 65) and retries the same
 * request, up to MAX_RATE_RETRIES times. Other statuses pass through unchanged for
 * the caller to handle.
 */
const MAX_RATE_RETRIES = 4;
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    if (attempt >= MAX_RATE_RETRIES) return res; // give up; caller surfaces the 429
    const retryAfter = Number(res.headers.get('retry-after')) || 60;
    const waitMs = Math.min(retryAfter, 65) * 1000;
    await res.text().catch(() => undefined); // drain body so the socket frees before we wait
    console.log(
      `  … rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_RETRIES})`,
    );
    await sleep(waitMs);
  }
}

interface ExistingMemory {
  id: number;
  content: string;
}

/**
 * Prefetch ALL existing claude-index memories across every scope in one paginated
 * pass, keyed by metadata.external_key. Replaces a per-entry lookup that (a) blew
 * the 100-req/min rate limit (~2 requests × N entries) and (b) silently 400'd
 * because it requested limit=200 > maxLimit (100), so the external-key reconcile
 * never matched. Now the whole sync costs ~1-2 GETs + one write per new/changed
 * entry. Cursor-paginated; limit clamped to maxLimit (100).
 */
async function prefetchExisting(): Promise<Map<string, ExistingMemory>> {
  const byKey = new Map<string, ExistingMemory>();
  let cursor: number | undefined;
  do {
    const params = new URLSearchParams({ tags: 'claude-index', limit: '100' });
    if (cursor !== undefined) params.set('cursor', String(cursor));
    const res = await fetchWithRetry(
      `${API_URL}/api/memories?${params}`,
      { headers: authHeaders() },
      'prefetch',
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET /api/memories (prefetch) failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as {
      data: Array<{ id: number; content: string; metadata: string }>;
      meta: { cursor?: number; has_more: boolean };
    };
    for (const mem of body.data) {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(mem.metadata);
      } catch {
        // ignore malformed metadata
      }
      const key = meta.external_key;
      if (typeof key === 'string') byKey.set(key, { id: mem.id, content: mem.content });
    }
    cursor = body.meta.has_more ? body.meta.cursor : undefined;
  } while (cursor !== undefined);
  return byKey;
}

interface UpsertResult {
  action: 'created' | 'updated' | 'skipped';
  id?: number;
}

async function upsertEntry(
  entry: IndexEntry,
  existing: Map<string, ExistingMemory>,
): Promise<UpsertResult> {
  const content = buildContent(entry);
  const tags = ['claude-index', entry.kind, `source:${entry.source_file}`];
  const metadata = {
    external_key: entry.external_key,
    name: entry.name,
    source_index: entry.source_file,
  };

  // Reconcile by external key against the prefetched map.
  const hit = existing.get(entry.external_key);

  if (hit) {
    if (hit.content === content) {
      return { action: 'skipped', id: hit.id }; // unchanged — true no-op
    }
    // Content changed — update in place (same row, preserves the decay clock).
    const res = await fetchWithRetry(
      `${API_URL}/api/memories/${hit.id}`,
      { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content, tags, metadata }) },
      `PUT ${entry.external_key}`,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PUT /api/memories/${hit.id} failed: ${res.status} ${text}`);
    }
    return { action: 'updated', id: hit.id };
  }

  // No existing memory — create.
  const body = {
    content,
    type: 'reference',
    scope: entry.scope,
    source: 'claude-index-sync',
    tags,
    metadata,
    confidence: CATALOG_CONFIDENCE,
    created_by: 'sync-claude-indexes',
  };
  const res = await fetchWithRetry(
    `${API_URL}/api/memories`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) },
    `POST ${entry.external_key}`,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/memories failed: ${res.status} ${text}`);
  }
  const result = (await res.json()) as { data: { id: number }; meta: { deduplicated: boolean } };
  // If deduplicated (same content_hash) the server returned 200 and the existing row.
  if (result.meta.deduplicated) return { action: 'skipped', id: result.data.id };
  return { action: 'created', id: result.data.id };
}

// ---------------------------------------------------------------------------
// Prune: archive memories whose external_key is no longer in the live index set
// ---------------------------------------------------------------------------

async function pruneOrphans(liveKeys: Set<string>): Promise<number> {
  let archived = 0;
  let cursor: number | undefined;
  do {
    const params = new URLSearchParams({ tags: 'claude-index', limit: '100' });
    if (cursor !== undefined) params.set('cursor', String(cursor));
    const res = await fetchWithRetry(
      `${API_URL}/api/memories?${params}`,
      { headers: authHeaders() },
      'prune-scan',
    );
    if (!res.ok) break;
    const body = (await res.json()) as {
      data: Array<{ id: number; metadata: string }>;
      meta: { cursor?: number; has_more: boolean };
    };
    for (const mem of body.data) {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(mem.metadata);
      } catch {
        // ignore
      }
      const key = meta.external_key as string | undefined;
      if (key && !liveKeys.has(key)) {
        if (DRY_RUN) {
          console.log(`  [dry-run] PRUNE id=${mem.id} key=${key}`);
        } else {
          // Archive the orphan via the real archive route (snapshot-safe, drops it from
          // the vector index). Catalog memories are never pinned slots, so no ?force needed.
          const ares = await fetchWithRetry(
            `${API_URL}/api/memories/${mem.id}/archive`,
            // Fastify rejects an empty body when Content-Type is application/json
            // (authHeaders sets it) — send an empty JSON object.
            { method: 'POST', headers: authHeaders(), body: '{}' },
            `archive ${key}`,
          );
          if (!ares.ok) {
            const text = await ares.text();
            console.error(`  ! prune failed id=${mem.id} key=${key}: ${ares.status} ${text}`);
            continue;
          }
          console.log(`  - archived id=${mem.id} key=${key}`);
        }
        archived++;
      }
    }
    cursor = body.meta.has_more ? body.meta.cursor : undefined;
  } while (cursor !== undefined);
  return archived;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function sync(): Promise<void> {
  console.log('sync-claude-indexes: ~/.claude index files → KOPENG');
  console.log(`  API URL:  ${API_URL}`);
  console.log(`  Dry run:  ${DRY_RUN}`);
  console.log(`  Prune:    ${PRUNE}`);
  console.log('');

  // Health check
  try {
    const health = await fetch(`${API_URL}/api/health`);
    if (!health.ok) throw new Error(`status ${health.status}`);
    const hd = (await health.json()) as { data: { status: string } };
    console.log(`  Server:   ${hd.data.status}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot reach KOPENG server at ${API_URL}: ${msg}`);
    console.error('Start the server first: npm start');
    process.exit(1);
  }

  const claudeDir = path.join(os.homedir(), '.claude');

  // Parse all three index files
  const indexFiles: Array<{
    file: string;
    parser: (markdown: string) => IndexEntry[];
    label: string;
  }> = [
    { file: 'TOOLS_INDEX.md', parser: parseToolsIndex, label: 'tools' },
    { file: 'SKILLS_INDEX.md', parser: parseSkillsIndex, label: 'skills' },
    { file: 'PROJECT_INDEX.md', parser: parseProjectIndex, label: 'projects' },
  ];

  const allEntries: IndexEntry[] = [];

  for (const { file, parser, label } of indexFiles) {
    const filePath = path.join(claudeDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`  [skip] ${file} not found at ${filePath}`);
      continue;
    }
    const markdown = fs.readFileSync(filePath, 'utf-8');
    const entries = parser(markdown);
    console.log(`  ${file}: ${entries.length} ${label} entries parsed`);
    allEntries.push(...entries);
  }

  console.log(`\n  Total entries: ${allEntries.length}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No writes. Would process:');
    for (const e of allEntries) {
      const content = buildContent(e);
      console.log(`  [${e.kind}] ${e.external_key} → ${e.scope} | ${content.slice(0, 80)}`);
    }
    if (PRUNE) {
      console.log('\n[DRY RUN] Prune: checking for orphans (read-only scan)...');
      const liveKeys = new Set(allEntries.map(e => e.external_key));
      await pruneOrphans(liveKeys);
    }
    return;
  }

  // Live run: prefetch existing index memories once (keyed by external_key), then upsert.
  const existing = await prefetchExisting();
  console.log(`  Prefetched ${existing.size} existing index memories for reconcile.\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of allEntries) {
    try {
      const result = await upsertEntry(entry, existing);
      if (result.action === 'created') {
        created++;
        console.log(`  + created  ${entry.external_key} (id=${result.id})`);
      } else if (result.action === 'updated') {
        updated++;
        console.log(`  ~ updated  ${entry.external_key} (id=${result.id})`);
      } else {
        skipped++;
        // silent on skip to keep second-run output clean
      }
    } catch (err: unknown) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ! error    ${entry.external_key}: ${msg}`);
    }
  }

  console.log(
    `\nSync complete: ${created} created / ${updated} updated / ${skipped} skipped / ${errors} errors`,
  );

  if (PRUNE) {
    console.log('\nPrune: scanning for orphaned index memories...');
    const liveKeys = new Set(allEntries.map(e => e.external_key));
    const orphanCount = await pruneOrphans(liveKeys);
    console.log(`Prune: ${orphanCount} orphan(s) ${DRY_RUN ? 'identified (dry-run)' : 'archived'}`);
  }
}

// Only execute when run directly (not when imported by tests or other modules).
// Compare the entry-point path to this file's path — works with tsx direct execution.
// Normalise separators and case for Windows-safe comparison.
function isDirectRun(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return (
    entry.endsWith('/sync-claude-indexes.ts') ||
    entry.endsWith('/sync-claude-indexes.js') ||
    // tsx may pass the full path as argv[1]
    entry.includes('sync-claude-indexes')
  );
}

if (isDirectRun()) {
  sync().catch(err => {
    console.error('sync-claude-indexes failed:', err);
    process.exit(1);
  });
}
