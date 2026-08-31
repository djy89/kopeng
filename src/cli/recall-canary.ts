/**
 * npm run canary — first-run proof that store → embed → SEMANTIC recall works
 * end to end through the REAL recall hook (Phase 8 release posture, spec S4).
 *
 * Stages, in order (any failure ⇒ process.exitCode = 1 + one plain-language
 * paragraph on stderr):
 *   1. health   — GET /api/health: is the server reachable at all?
 *   2. embedder — poll /api/health until `embedding: 'loaded'` (the model
 *                 lazy-loads after listen; first run downloads it — default
 *                 wait 60s)
 *   3. sweep    — archive any leftover `canary`-tagged rows in scope `global`
 *                 from a previous crashed run (the canary must never accrete)
 *   4. store    — POST a canary memory carrying a fresh random hex token
 *   5. recall   — spawn the REAL hook (scripts/hooks/memory-prompt-search.mjs)
 *                 with CANARY_PROMPT on stdin, KOPENG_API_URL pointed at the
 *                 server, and assert the token comes back inside
 *                 hookSpecificOutput.additionalContext. Stages 4+5 retry with
 *                 a fresh token (≤ MAX_STORE_ATTEMPTS) ONLY when a direct REST
 *                 probe proves the vector path alive but this token's
 *                 similarity landed just under the hook's 0.40 threshold —
 *                 dead-vector and hook-side faults never retry
 *   6. archive  — ALWAYS archive the stored row, pass or fail (run after the
 *                 stages regardless of outcome — the "finally" sweep)
 *
 * CX-1 — why the prompt must share ZERO content-words with the content:
 * POST /api/memories/recall is hybrid-lite (semantic + FTS, RRF-merged), so a
 * prompt sharing any FTS-matchable word with the stored content could be
 * rescued by the keyword path while the vector path is silently dead — the
 * exact failure this canary exists to catch. assertNoTokenOverlap enforces the
 * disjointness at module load; the run token is hex, so it can never collide
 * with prompt words either.
 *
 * On a stage-5 failure the canary hits POST /api/memories/recall directly to
 * split the diagnosis: REST returns the token ⇒ the semantic path is fine and
 * the fault is hook-side (node on PATH, settings.json paths); REST comes back
 * empty ⇒ the embedder/index itself is at fault.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

// Load this repo's .env so ADMIN_API_KEY is present when run from a bare
// shell. Non-overriding: a value already exported wins. Without this the
// script silently 401s against a key-configured server (same header as
// sync-claude-indexes.ts, sweep-3 PB-2).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

// ---------------------------------------------------------------------------
// Fixed strings (CX-1)
// ---------------------------------------------------------------------------

export const CANARY_CONTENT_BASE =
  'KOPENG first-run canary: this memory verifies that storing and recalling memories works end to end on this install. token:';
// Measured with the real embedder (all-MiniLM-L6-v2, 2026-08-21): this prompt
// scores cosine ~0.42–0.47 against CANARY_CONTENT_BASE + random hex token
// (median ~0.44 over 30 tokens) — above the hook's 0.40 recall threshold with
// margin. The task brief's original prompt ("does saving and finding a
// remembered note function properly right now for me here") measured 0.3383 —
// deterministically BELOW threshold — so it was replaced per the escalation
// rule, keeping zero content-word overlap. Word choice also avoids sharing
// English STEMS with the content (recal*/stor*/work*/verif*/memori*), because
// the Postgres FTS path stems (`to_tsvector('english')`) while SQLite FTS5
// does not — a stem collision could FTS-rescue a dead vector path on PG only.
export const CANARY_PROMPT =
  'a quick probe which proves remembering saved notes still functions fully on my fresh setup';

/**
 * Throw if the two strings share a content-word. Lowercase, split on
 * /[^a-z0-9]+/, drop words shorter than 4 chars, assert empty intersection.
 *
 * The 4-char floor mirrors the recall FTS tokenizer (extractFtsTokens in
 * src/api/routes.ts only emits \b[a-z][a-z]{3,}\b — 4+ letter words), which is
 * the exact surface a shared word could ride to an FTS rescue. Shorter shared
 * tokens ('and' appears in both fixed strings) can never match in FTS, so they
 * cannot mask a dead vector path.
 */
export function assertNoTokenOverlap(a: string, b: string): void {
  const words = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4));
  const wordsA = words(a);
  const shared = [...words(b)].filter(w => wordsA.has(w));
  if (shared.length > 0) {
    throw new Error(
      `canary prompt and content share content-word(s): ${shared.join(', ')} — ` +
      'FTS could rescue a dead vector path, defeating the semantic-recall proof (CX-1)'
    );
  }
}

// Enforced at module load: importing this file with overlapping fixed strings
// is itself an error — no run can start with a compromised canary.
assertNoTokenOverlap(CANARY_CONTENT_BASE, CANARY_PROMPT);

// ---------------------------------------------------------------------------
// Types + knobs
// ---------------------------------------------------------------------------

export interface CanaryResult {
  ok: boolean;
  stage: string;
  diagnosis?: string;
}

export interface CanaryOptions {
  /** REST server base URL (default http://localhost:3200 at the CLI). */
  apiUrl: string;
  /** ADMIN_API_KEY value; '' for an open dev-mode server. */
  adminKey: string;
  /** Path to the recall hook (default scripts/hooks/memory-prompt-search.mjs). */
  hookPath?: string;
  /** How long stage 2 waits for the embedder (default 60s). */
  embedderWaitMs?: number;
}

const DEFAULT_API_URL = 'http://localhost:3200';
const DEFAULT_HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'hooks', 'memory-prompt-search.mjs');
const DEFAULT_EMBEDDER_WAIT_MS = 60_000;
const HTTP_TIMEOUT_MS = 5_000;
const EMBEDDER_POLL_MS = 1_000;
const HOOK_TIMEOUT_MS = 15_000;

/**
 * The random token shifts the content embedding a little each run, so the
 * measured ~0.44 median cosine occasionally lands just under the hook's 0.40
 * threshold on token luck alone. When the low-threshold REST probe proves the
 * vector path is ALIVE but this run's similarity fell below the hook
 * threshold, the canary retries with a fresh token (bounded) instead of
 * telling a healthy first-run install it is broken. Dead-vector and hook-side
 * faults are deterministic and never retried. Exported for the residue-bound
 * test (archived rows per run ≤ attempts).
 */
export const MAX_STORE_ATTEMPTS = 3;
/** Probe floor for the diagnosis split — well under any real similarity. */
const PROBE_THRESHOLD = 0.05;
/** The hook's own recall threshold (memory-prompt-search.mjs sends 0.40). */
const HOOK_RECALL_THRESHOLD = 0.40;

// ---------------------------------------------------------------------------
// HTTP helpers (fetch-based, no external deps — Node 20 global fetch)
// ---------------------------------------------------------------------------

interface HttpResult {
  ok: boolean;
  status: number;
  json: unknown;
  error?: string;
}

async function http(
  url: string,
  init: { method?: string; body?: unknown; adminKey?: string } = {}
): Promise<HttpResult> {
  try {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.adminKey) headers['x-api-key'] = init.adminKey;
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON body — leave null */ }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function dataOf(result: HttpResult): Record<string, unknown> {
  const j = result.json as { data?: unknown } | null;
  return (j && typeof j === 'object' && j.data && typeof j.data === 'object')
    ? j.data as Record<string, unknown>
    : {};
}

function rowsOf(result: HttpResult): Array<Record<string, unknown>> {
  const j = result.json as { data?: unknown } | null;
  return Array.isArray(j?.data) ? j.data as Array<Record<string, unknown>> : [];
}

// ---------------------------------------------------------------------------
// Hook spawn
// ---------------------------------------------------------------------------

interface HookRun {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnError?: string;
}

function runHook(hookPath: string, apiUrl: string): Promise<HookRun> {
  return new Promise((resolvePromise) => {
    // process.execPath is the node binary already running this script — the
    // canary itself must not fail on a PATH quirk; the hook-side diagnosis
    // covers the settings.json/node-on-PATH case for the real hook install.
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, KOPENG_API_URL: apiUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (run: HookRun) => {
      if (!settled) { settled = true; clearTimeout(timer); resolvePromise(run); }
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ stdout, stderr, code: null, spawnError: `hook timed out after ${HOOK_TIMEOUT_MS}ms` });
    }, HOOK_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => finish({ stdout, stderr, code: null, spawnError: err.message }));
    child.on('close', (code) => finish({ stdout, stderr, code }));
    // A hook that dies before reading stdin (bad hookPath, instant crash)
    // raises EPIPE here — swallow it so the run reports the hook-side
    // diagnosis instead of crashing the canary itself.
    child.stdin.on('error', () => { /* close/exit handlers carry the outcome */ });
    try {
      child.stdin.write(JSON.stringify({ user_prompt: CANARY_PROMPT, cwd: process.cwd() }));
      child.stdin.end();
    } catch { /* same EPIPE race, synchronous flavor */ }
  });
}

// ---------------------------------------------------------------------------
// The canary
// ---------------------------------------------------------------------------

async function archiveCanaryRow(apiUrl: string, adminKey: string, id: number): Promise<HttpResult> {
  return http(`${apiUrl}/api/memories/${id}/archive`, { method: 'POST', body: {}, adminKey });
}

async function runStages(
  opts: Required<CanaryOptions>,
  state: { storedId: number | null; leftoverIds: number[]; token: string }
): Promise<CanaryResult> {
  const { apiUrl, adminKey, hookPath, embedderWaitMs } = opts;

  // ── Stage 1: health ──
  let health = await http(`${apiUrl}/api/health`);
  if (!health.ok) {
    return {
      ok: false,
      stage: 'health',
      diagnosis:
        `The KOPENG server is not running or not reachable at ${apiUrl} ` +
        `(${health.error ?? `HTTP ${health.status}`}). Start it with npm start (or the ` +
        'NSSM service on a production install), then re-run npm run canary.',
    };
  }

  // ── Stage 2: embedder-ready poll ──
  const deadline = Date.now() + embedderWaitMs;
  while (String(dataOf(health).embedding) !== 'loaded') {
    if (Date.now() >= deadline) {
      return {
        ok: false,
        stage: 'embedder',
        diagnosis:
          `The KOPENG server at ${apiUrl} is up, but its embedding model did not finish ` +
          `loading within ${Math.round(embedderWaitMs / 1000)}s (GET /api/health kept reporting ` +
          `embedding: '${String(dataOf(health).embedding)}'). A first run downloads the model into ` +
          'models/ and can be slow — wait a bit and re-run npm run canary, or check the server logs.',
      };
    }
    await new Promise(r => setTimeout(r, EMBEDDER_POLL_MS));
    health = await http(`${apiUrl}/api/health`);
    if (!health.ok) {
      return {
        ok: false,
        stage: 'embedder',
        diagnosis:
          `The KOPENG server at ${apiUrl} stopped responding while waiting for the embedding ` +
          `model to load (${health.error ?? `HTTP ${health.status}`}). Check the server logs, then re-run npm run canary.`,
      };
    }
  }

  // ── Stage 3: sweep leftover canary rows (a crashed prior run must not accrete) ──
  const leftovers = await http(`${apiUrl}/api/memories?tags=canary&scope=global&fields=lite&limit=1000`);
  if (!leftovers.ok) {
    return {
      ok: false,
      stage: 'sweep',
      diagnosis:
        `Could not list leftover canary memories (GET /api/memories → ` +
        `${leftovers.error ?? `HTTP ${leftovers.status}`}). Check the server logs, then re-run npm run canary.`,
    };
  }
  for (const row of rowsOf(leftovers)) {
    const id = Number(row.id);
    if (!Number.isInteger(id)) continue;
    // Only rows THIS canary wrote (team-review fix): an operator's own memory
    // that legitimately carries a `canary` tag (a note about canary releases,
    // say) must never be swept — the canary's rows are identified by their
    // fixed content prefix, not the tag alone.
    if (!String(row.content ?? '').startsWith(CANARY_CONTENT_BASE)) continue;
    const archived = await archiveCanaryRow(apiUrl, adminKey, id);
    if (!archived.ok) {
      return {
        ok: false,
        stage: 'sweep',
        diagnosis:
          `Could not archive leftover canary memory ${id} (HTTP ${archived.status}` +
          `${archived.error ? `, ${archived.error}` : ''}).` +
          (archived.status === 401
            ? ' The server requires an admin key — make sure ADMIN_API_KEY in this repo\'s .env matches the server\'s.'
            : ' Check the server logs.') +
          ' Then re-run npm run canary.',
      };
    }
  }

  // ── Stages 4+5: store a tokened canary row, recall it through the REAL hook ──
  // Bounded token-luck retry: see MAX_STORE_ATTEMPTS above. Only the
  // "vector path alive but this token's similarity fell under the hook
  // threshold" outcome retries; every deterministic fault returns immediately.
  let lastScore: number | null = null;
  for (let attempt = 1; attempt <= MAX_STORE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // Archive the previous attempt's row before storing a fresh one so
      // retries never leave more than one active canary row at a time. A
      // failed archive keeps the id in leftoverIds (team-review fix) so the
      // finally-sweep in runCanary retries it — the residue bound must not
      // depend on the NEXT run's sweep.
      if (state.storedId !== null) {
        const archived = await archiveCanaryRow(apiUrl, adminKey, state.storedId).catch(() => null);
        if (!archived || !archived.ok) state.leftoverIds.push(state.storedId);
        state.storedId = null;
      }
      state.token = randomBytes(4).toString('hex');
    }

    // Stage 4: store.
    const content = CANARY_CONTENT_BASE + state.token;
    const stored = await http(`${apiUrl}/api/memories`, {
      method: 'POST',
      adminKey,
      body: { content, type: 'reference', scope: 'global', tags: ['canary'] },
    });
    if (!stored.ok) {
      return {
        ok: false,
        stage: 'store',
        diagnosis:
          `Could not store the canary memory (POST /api/memories → HTTP ${stored.status}` +
          `${stored.error ? `, ${stored.error}` : ''}).` +
          (stored.status === 401
            ? ' The server requires an admin key — make sure ADMIN_API_KEY in this repo\'s .env matches the server\'s.'
            : ' Check the server logs.') +
          ' Then re-run npm run canary.',
      };
    }
    const storedId = Number(dataOf(stored).id);
    if (!Number.isInteger(storedId)) {
      return {
        ok: false,
        stage: 'store',
        diagnosis: 'POST /api/memories succeeded but returned no memory id — the server response shape is unexpected. Check the server version/logs.',
      };
    }
    state.storedId = storedId;

    // Stage 5: recall through the real hook.
    const hookRun = await runHook(hookPath, apiUrl);
    let context = '';
    try {
      const parsed = JSON.parse(hookRun.stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      context = String(parsed?.hookSpecificOutput?.additionalContext ?? '');
    } catch { /* empty or non-JSON stdout — treated as no recall below */ }

    if (context.includes(state.token)) {
      return { ok: true, stage: 'done' };
    }

    // Split the diagnosis with one low-threshold direct recall: the canary
    // row can only be found SEMANTICALLY (zero content-word overlap ⇒ no FTS
    // hit), so its presence and score tell the whole story.
    const direct = await http(`${apiUrl}/api/memories/recall`, {
      method: 'POST',
      body: { query: CANARY_PROMPT, scopes: ['global'], threshold: PROBE_THRESHOLD, limit: 5 },
    });
    const hit = rowsOf(direct).find(m => String(m.content ?? '').includes(state.token));
    const hookDetail =
      `(hook exit: ${hookRun.spawnError ?? hookRun.code}; stdout: ${hookRun.stdout.slice(0, 200) || '<empty>'}` +
      `${hookRun.stderr ? `; stderr: ${hookRun.stderr.slice(0, 200)}` : ''})`;

    if (hit && Number(hit.score) >= HOOK_RECALL_THRESHOLD) {
      return {
        ok: false,
        stage: 'recall',
        diagnosis:
          'The canary memory was stored and DIRECT semantic recall over REST finds it, but the ' +
          'recall hook did not surface it — hook-side fault: check node on PATH and settings.json paths. ' +
          hookDetail,
      };
    }
    if (!hit) {
      return {
        ok: false,
        stage: 'recall',
        diagnosis:
          'The canary memory was stored but semantic recall cannot find it — semantic recall fault: ' +
          'embedder/index — check /api/health. The canary prompt deliberately shares no content-words ' +
          'with the stored memory, so keyword (FTS) search cannot mask a dead vector path. ' +
          hookDetail,
      };
    }
    // Vector path alive, similarity just under the hook threshold — token
    // luck, not a broken install. Retry with a fresh token.
    lastScore = Number(hit.score);
  }

  return {
    ok: false,
    stage: 'recall',
    diagnosis:
      `Semantic recall is alive but scored below the hook's ${HOOK_RECALL_THRESHOLD} threshold on ` +
      `${MAX_STORE_ATTEMPTS} attempts (last score ${lastScore?.toFixed(3) ?? 'unknown'}). This is unusual — ` +
      're-run npm run canary; if it persists, the embedding model on this install may not match ' +
      'the one the canary was calibrated against (check EMBEDDING_MODEL and /api/health).',
  };
}

/**
 * Run the full canary. The stored canary row is ALWAYS archived afterwards —
 * pass, fail, or throw — so repeated runs never accrete rows (residue bound:
 * zero active canary rows, at most MAX_STORE_ATTEMPTS archived per run — the
 * token-luck retry loop archives each attempt's row before storing the next).
 */
export async function runCanary(opts: CanaryOptions): Promise<CanaryResult> {
  const resolved: Required<CanaryOptions> = {
    apiUrl: opts.apiUrl || DEFAULT_API_URL,
    adminKey: opts.adminKey,
    hookPath: opts.hookPath ?? DEFAULT_HOOK_PATH,
    embedderWaitMs: opts.embedderWaitMs ?? DEFAULT_EMBEDDER_WAIT_MS,
  };
  const state = {
    storedId: null as number | null,
    leftoverIds: [] as number[],
    token: randomBytes(4).toString('hex'),
  };

  let result: CanaryResult;
  try {
    result = await runStages(resolved, state);
  } catch (err) {
    result = {
      ok: false,
      stage: 'unexpected',
      diagnosis: `The canary hit an unexpected error: ${err instanceof Error ? err.message : String(err)}. Re-run npm run canary; if it persists, check the server logs.`,
    };
  }

  // "finally" archive — the cleanup runs on every path that stored a row,
  // including rows a mid-run retry failed to archive (leftoverIds).
  const toArchive = [...state.leftoverIds];
  if (state.storedId !== null) toArchive.push(state.storedId);
  const failedIds: number[] = [];
  let lastArchive: HttpResult | null = null;
  for (const id of toArchive) {
    const archived = await archiveCanaryRow(resolved.apiUrl, resolved.adminKey, id).catch(() => null);
    if (!archived || !archived.ok) {
      failedIds.push(id);
      lastArchive = archived;
    }
  }
  if (failedIds.length > 0 && result.ok) {
    result = {
      ok: false,
      stage: 'archive',
      diagnosis:
        `The canary itself passed, but cleanup failed: could not archive canary ` +
        `memor${failedIds.length > 1 ? 'ies' : 'y'} ${failedIds.join(', ')} ` +
        `(HTTP ${lastArchive?.status ?? 0}${lastArchive?.error ? `, ${lastArchive.error}` : ''}). ` +
        'The row(s) are tagged `canary` in scope global; the next run\'s sweep will retry them.',
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI (isMain pattern — importing this module never runs the canary)
// ---------------------------------------------------------------------------

function isDirectRun(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return entry.includes('recall-canary');
}

if (isDirectRun()) {
  const apiUrl = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || DEFAULT_API_URL;
  runCanary({ apiUrl, adminKey: process.env.ADMIN_API_KEY || '' })
    .then((result) => {
      if (result.ok) {
        console.log(
          `Canary passed: a memory was stored on ${apiUrl}, embedded, and recalled SEMANTICALLY ` +
          'through the real recall hook (the prompt shared no words with the content, so only the ' +
          'vector path could have found it). The canary row was archived — your install works end to end.'
        );
      } else {
        console.error(`Canary FAILED at stage '${result.stage}'.\n\n${result.diagnosis ?? ''}`);
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(`Canary FAILED unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
