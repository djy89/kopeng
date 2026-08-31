/**
 * `kopeng migrate-anchors` — WS7.4 B4: move legacy anchor spellings to
 * `is_locked`, runnable from a PACKAGED install.
 *
 * `is_locked` is now THE Hard Anchor. `confidence >= 1.0` and
 * `metadata.pinned === true` are DEPRECATED spellings — still honored this
 * release, but `/api/ops/corpus-health`'s `legacy_anchor_count` (and doctor's
 * warning on it) point here. This driver locks every active memory still
 * anchored ONLY by a deprecated spelling, via the audited
 * `PUT /api/memories/:id {is_locked: true}` — never SQL against the live DB.
 * Confidence is left untouched (a stored 1.0 stays 1.0, now redundant but
 * harmless — `is_locked` is the freeze that matters going forward).
 *
 * WHY THIS LIVES IN `src/cli/` AND NOT ONLY IN `scripts/ops/`: doctor
 * prescribes this migration whenever it sees `legacy_anchor_count > 0`, and
 * doctor runs on packaged installs. `scripts/ops/` is not in package.json's
 * `files`, and `tsx` is a devDependency — so `npm run migrate:anchors` is
 * impossible for every packaged user who trips that warning. This module
 * compiles into `dist/cli/migrate-anchors.js` (shipped by the `dist` entry in
 * `files`) and depends on nothing outside `dist` + `dotenv` (a runtime
 * dependency). `scripts/ops/migrate-anchors-to-lock.ts` is now a thin
 * from-source wrapper around this same driver — ONE implementation.
 *
 * Safety posture is unchanged from the script it replaces: dry-run by
 * default, `--apply` to write, every write audited through the REST API.
 *
 * Usage:
 *   kopeng migrate-anchors                       # dry-run (read-only)
 *   kopeng migrate-anchors --apply               # writes
 *   kopeng migrate-anchors --url http://host:3200
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { isPinnedMetadata } from '../dreaming/scoring.js';
import { ENV_FILE as PACKAGED_ENV_FILE } from './paths.js';
import { resolveEnvFile } from '../config/env-resolution.js';
import { isEntrypoint } from '../utils/entrypoint.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Two levels below the package root in both layouts (src/cli/, dist/cli/). */
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_API_URL = 'http://localhost:3200';
const MAX_RATE_RETRIES = 6;

export interface LiteMemory {
  id: number;
  scope: string;
  type: string;
  content: string;
  confidence: number;
  metadata: string | null;
  // The wire shape is the raw DB column (0/1 on SQLite, boolean on Postgres —
  // JSON carries either through as-is), matching `AnchorInputs.is_locked`.
  is_locked: boolean | number | null;
}

/**
 * WS7.4 B4: true when a row is anchored ONLY by a deprecated spelling
 * (confidence >= 1.0 or metadata.pinned === true) and is not already locked —
 * exactly the set `legacy_anchor_count` (corpus-health) reports and doctor
 * warns about. Pure — no I/O, no clock — so it's unit-testable with no
 * server (tests/unit/migrate-anchors-selection.test.ts). Reuses
 * `isPinnedMetadata`'s defensive parse (malformed JSON = not pinned) rather
 * than re-deriving it.
 */
export function isLegacyAnchor(m: Pick<LiteMemory, 'is_locked' | 'confidence' | 'metadata'>): boolean {
  if (m.is_locked) return false; // already THE anchor — nothing to migrate
  return m.confidence >= 1.0 || isPinnedMetadata(m.metadata);
}

/** The memory types `--type` accepts, mirroring the server's MemoryType union. */
export const MIGRATABLE_TYPES = ['user', 'feedback', 'project', 'reference', 'discovery'] as const;

/**
 * The selection predicate: `isLegacyAnchor`, optionally narrowed to a set of
 * memory types.
 *
 * Why the narrowing exists. Until 2026-07-10 the store default WAS 1.0
 * (`input.confidence ?? 1.0`, changed to 0.9 by T22/T23), so on a corpus with
 * history a `confidence >= 1.0` row carries no evidence that anyone CHOSE to
 * anchor it. Locking is the one step here that cannot be undone in bulk and is
 * self-concealing: the anchor-triage D3 pass skips `is_locked` rows by design,
 * so a row locked today is removed from the triage population permanently.
 * Narrowing by type lets an operator migrate the classes T22b designated as
 * genuine operator truths (`user`, `feedback` — which D3 deliberately leaves at
 * 1.0) while leaving `project`/`reference` on the still-honored deprecated
 * spelling until triage has had its say.
 *
 * MUST be used for the residual check too, not just candidate selection —
 * a filtered run measured against the unfiltered predicate would count the rows
 * it deliberately skipped as residual and report failure for doing its job.
 */
export function buildAnchorSelector(types?: readonly string[]) {
  const wanted = types && types.length > 0 ? new Set(types) : null;
  return (m: Pick<LiteMemory, 'is_locked' | 'confidence' | 'metadata' | 'type'>): boolean =>
    isLegacyAnchor(m) && (wanted === null || wanted.has(m.type));
}

export interface MigrateAnchorsOptions {
  /** Server base URL; falls back to env / .env / http://localhost:3200. */
  apiUrl?: string;
  /** Admin key; falls back to env / .env. */
  apiKey?: string;
  /** false (default) = read-only dry run. */
  apply?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Package/repo root used to resolve the `.env` file. */
  repoRoot?: string;
  /** Restrict migration to these memory types; empty/absent = every type. */
  types?: readonly string[];
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface MigrateAnchorsResult {
  ok: boolean;
  apply: boolean;
  apiUrl: string;
  /** Active memories scanned. */
  scanned: number;
  /** Rows matching `isLegacyAnchor` — what a dry run would write. */
  candidates: number;
  /** Rows actually locked (0 on a dry run). */
  migrated: number;
  failed: number;
  /** Post-run re-scan count; null on a dry run (nothing changed). */
  residual: number | null;
}

/**
 * Reads the resolved `.env` the same way `doctor` does (KOPENG_ENV_FILE >
 * from-source `<repoRoot>/.env` > packaged `~/.kopeng/.env`) so a packaged
 * install finds its real ADMIN_API_KEY. The original script hardcoded the
 * repo `.env`, which does not exist once the code lives in node_modules —
 * it would have silently 401'd against a key-configured server.
 * Non-overriding: an exported value always wins.
 */
function fileEnv(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string> {
  const envPath = resolveEnvFile({ env, projectRoot: repoRoot, packagedEnvFile: PACKAGED_ENV_FILE });
  try {
    return dotenv.parse(fs.readFileSync(envPath));
  } catch {
    return {}; // missing .env means shipped defaults
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runMigrateAnchors(options: MigrateAnchorsOptions = {}): Promise<MigrateAnchorsResult> {
  const env = options.env ?? process.env;
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const file = fileEnv(env, repoRoot);
  const value = (name: string): string | undefined => env[name] ?? file[name];

  const apiUrl = (
    options.apiUrl
    ?? value('MEMORY_API_URL')
    ?? value('KOPENG_API_URL')
    ?? DEFAULT_API_URL
  ).replace(/\/$/, '');
  // Memory writes are ADMIN_API_KEY-gated (sweep-3 PB-2); the others are legacy fallbacks.
  const apiKey = options.apiKey
    ?? value('ADMIN_API_KEY')
    ?? value('MEMORY_API_KEY')
    ?? value('KOPENG_API_KEY')
    ?? '';
  const apply = options.apply ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  const sleep = options.sleepImpl ?? defaultSleep;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  /** Respects the server's 100-req/min rate limit (retries on 429 with Retry-After). */
  async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, init);
      if (res.status !== 429) return res;
      if (attempt >= MAX_RATE_RETRIES) return res;
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      const waitMs = Math.min(retryAfter, 65) * 1000;
      await res.text().catch(() => undefined);
      log(`  … rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_RETRIES})`);
      await sleep(waitMs);
    }
  }

  async function listAllActiveMemories(): Promise<LiteMemory[]> {
    const all: LiteMemory[] = [];
    let cursor: number | undefined;
    do {
      const params = new URLSearchParams({ fields: 'lite', limit: '1000' });
      if (cursor !== undefined) params.set('cursor', String(cursor));
      const res = await fetchWithRetry(`${apiUrl}/api/memories?${params}`, { headers }, 'list');
      if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text().catch(() => '')}`);
      const body = await res.json() as { data: LiteMemory[]; meta: { has_more?: boolean; cursor?: number } };
      all.push(...body.data);
      cursor = body.meta.has_more ? body.meta.cursor : undefined;
    } while (cursor !== undefined);
    return all;
  }

  log(`migrate-anchors: ${apiUrl}`);
  log(`  Mode: ${apply ? 'APPLY (writes)' : 'dry-run (read-only)'}\n`);

  const selector = buildAnchorSelector(options.types);
  const typeNote = options.types && options.types.length > 0
    ? ` (types: ${[...options.types].join(', ')})`
    : '';
  const memories = await listAllActiveMemories();
  const candidates = memories.filter(selector);
  log(`  ${candidates.length} legacy-anchored out of ${memories.length} active memories${typeNote}\n`);
  if (candidates.length === 0) {
    log('Nothing to migrate.');
    return {
      ok: true, apply, apiUrl, scanned: memories.length, candidates: 0,
      migrated: 0, failed: 0, residual: apply ? 0 : null,
    };
  }

  let migrated = 0;
  let failed = 0;
  for (const m of candidates) {
    const excerpt = m.content.replace(/\s+/g, ' ').slice(0, 70);
    const reason = m.confidence >= 1.0 ? 'confidence>=1.0' : 'metadata.pinned';
    if (!apply) {
      log(`  [dry-run] id=${m.id} scope=${m.scope} (${reason}) "${excerpt}"`);
      continue;
    }
    const res = await fetchWithRetry(
      `${apiUrl}/api/memories/${m.id}`,
      { method: 'PUT', headers, body: JSON.stringify({ is_locked: true }) },
      `update ${m.id}`,
    );
    if (!res.ok) {
      failed++;
      errorLog(`  ! failed id=${m.id}: ${res.status} ${await res.text().catch(() => '')}`);
      continue;
    }
    migrated++;
    log(`  locked id=${m.id} scope=${m.scope} (${reason})`);
    if (migrated % 50 === 0) log(`  … ${migrated}/${candidates.length}`);
  }

  if (!apply) {
    log(`\nDry-run only — ${candidates.length} would lock. Re-run with --apply.`);
    return {
      ok: true, apply, apiUrl, scanned: memories.length,
      candidates: candidates.length, migrated: 0, failed: 0, residual: null,
    };
  }

  log(`\nDone: ${migrated} migrated, ${failed} failed.`);
  // Same selector as the candidate scan: a --type run must not count the rows it
  // deliberately skipped as residual and fail for doing exactly what was asked.
  const residual = (await listAllActiveMemories()).filter(selector).length;
  log(`Residual legacy-anchored${typeNote}: ${residual} (expect 0)`);
  return {
    ok: failed === 0 && residual === 0,
    apply, apiUrl, scanned: memories.length,
    candidates: candidates.length, migrated, failed, residual,
  };
}

/** `--url <value>` / `--api-url <value>`; undefined when absent. */
function flagValue(argv: string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    const i = argv.indexOf(flag);
    if (i >= 0 && typeof argv[i + 1] === 'string') return argv[i + 1];
  }
  return undefined;
}

export const MIGRATE_ANCHORS_USAGE =
  'Usage: kopeng migrate-anchors [--apply] [--url <api-url>] [--type <t>[,<t>]]\n'
  + '  Locks every active memory still anchored only by a deprecated spelling\n'
  + '  (confidence >= 1.0 / metadata.pinned). Dry-run unless --apply is passed.\n'
  + '  --type restricts the run to the given memory types (repeatable, or\n'
  + `  comma-separated). One of: ${MIGRATABLE_TYPES.join(', ')}.\n`
  + '  Narrowing matters on a corpus with history: before 2026-07-10 the store\n'
  + '  default WAS 1.0, so an old >=1.0 row is not evidence anyone chose to\n'
  + '  anchor it — and locking is one-way, since anchor triage skips locked rows.';

/**
 * Argument parsing + exit-code mapping, kept separate from `runMigrateAnchors`
 * so both the `kopeng` dispatcher and the from-source script share one CLI
 * contract. Returns the process exit code; never calls process.exit itself.
 */
export async function migrateAnchorsCli(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void } = { log: console.log, error: console.error },
): Promise<number> {
  const known = new Set(['--apply', '--url', '--api-url', '--type']);
  const types: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' || arg === '--api-url') { i++; continue; }
    if (arg === '--type') {
      const raw = argv[i + 1];
      if (!raw || raw.startsWith('--')) {
        io.error(`--type requires a value

${MIGRATE_ANCHORS_USAGE}`);
        return 2;
      }
      for (const t of raw.split(',').map(x => x.trim()).filter(Boolean)) {
        if (!(MIGRATABLE_TYPES as readonly string[]).includes(t)) {
          io.error(`Unknown memory type: ${t}

${MIGRATE_ANCHORS_USAGE}`);
          return 2;
        }
        if (!types.includes(t)) types.push(t);
      }
      i++;
      continue;
    }
    if (!known.has(arg)) {
      io.error(`Unknown argument: ${arg}\n\n${MIGRATE_ANCHORS_USAGE}`);
      return 2;
    }
  }

  try {
    const result = await runMigrateAnchors({
      apply: argv.includes('--apply'),
      apiUrl: flagValue(argv, '--url', '--api-url'),
      types,
      log: io.log,
      errorLog: io.error,
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    io.error(`migrate-anchors failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isDirectRun(): boolean {
  // Symlink-safe (T72). The obvious argv[1]-vs-import.meta.url comparison
  // reads false through a symlink and this module silently does nothing.
  return isEntrypoint(import.meta.url);
}

if (isDirectRun()) {
  migrateAnchorsCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`migrate-anchors failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
