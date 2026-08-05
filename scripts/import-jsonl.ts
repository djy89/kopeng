/**
 * Backfill historical Claude Code JSONL transcripts into the observations DB.
 *
 * Walks ~/.claude/projects/<encoded-cwd>/ recursively for .jsonl files
 * (top-level session files + subagent files under <session-id>/subagents/),
 * pairs tool_use with tool_result by id, and POSTs to /api/observations/batch.
 *
 * Idempotent: session-level skip (already imported OR live-captured) + deterministic
 * idempotency keys at the event level catch any escaped dupes.
 *
 * Usage:
 *   npx tsx scripts/import-jsonl.ts [--dry-run] [--since YYYY-MM-DD]
 *                                   [--project <basename>] [--max-files N] [--reimport]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const API_KEY = process.env.KOPENG_API_KEY || process.env.OBSERVATION_API_KEY || '';
const MEMORY_DB_PATH = process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'memory.db');
const OBSERVATIONS_DB = process.env.OBSERVATIONS_DB_PATH || path.join(path.dirname(MEMORY_DB_PATH), 'observations.db');

const BATCH_SIZE = 100;
const THROTTLE_MS = 120; // ~8 req/s — well under 600/min rate limit
const HTTP_TIMEOUT_MS = 10000;

// Obvious noise project paths — generated outputs, image dumps, etc.
const PROJECT_DENYLIST = [
  /stable-diffusion-webui/i,
  /txt2img-images/i,
  /ComfyUI-output/i,
];

// ── Types ──

interface JsonlEvent {
  type?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
      text?: string;
    }>;
  };
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  gitBranch?: string;
}

interface PendingToolUse {
  toolUseId: string;
  toolName: string;
  input: unknown;
  timestamp: string;
}

interface Observation {
  idempotency_key: string;
  session_id: string;
  project_scope: string;
  tool_name: string;
  event_type: 'tool_complete' | 'tool_failed';
  input_summary: string | null;
  output_summary: string | null;
  metadata: Record<string, unknown>;
}

interface CliArgs {
  dryRun: boolean;
  since: Date | null;
  cutoff: Date | null;        // skip files newer than this — defaults to live hook activation
  noCutoff: boolean;          // bypass cutoff (will dupe live-captured sessions)
  projectFilter: string | null;
  maxFiles: number | null;
  reimport: boolean;
}

// ── Error classification (ported from scripts/hooks/kopeng-observe.js) ──

const NEGATIVE_PATTERNS = [
  /0 errors/i,
  /no errors found/i,
  /all checks passed/i,
  /build succeeded/i,
  /successfully compiled/i,
  /passed.*\d+.*tests/i,
  /0 failed/i,
];

function classifyError(toolName: string, rawOutput: string): { isError: boolean; category?: string; signature?: string } {
  if (!rawOutput) return { isError: false };
  const output = rawOutput.slice(0, 8000);

  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(output)) return { isError: false };
  }

  if (['Edit', 'Write', 'edit_file', 'write_file'].includes(toolName)) {
    if (/old_string.*not unique|is not unique in the file/i.test(output)) {
      return { isError: true, category: 'edit_conflict', signature: 'edit_not_unique' };
    }
    if (/old_string.*not found|does not contain/i.test(output)) {
      return { isError: true, category: 'edit_conflict', signature: 'edit_not_found' };
    }
    return { isError: false };
  }

  const BASH_TOOLS = new Set(['Bash', 'bash', 'shell', 'terminal']);
  if (!BASH_TOOLS.has(toolName)) return { isError: false };

  const tsMatch = output.match(/error (TS\d{4,5}):/);
  if (tsMatch) return { isError: true, category: 'typescript', signature: tsMatch[1].toLowerCase() };
  if (/Type ['"].+['"] is not assignable to type/i.test(output)) {
    return { isError: true, category: 'typescript', signature: 'ts_type_not_assignable' };
  }

  if (/vitest|jest|mocha|pytest|cargo test|go test|npm test/i.test(output)) {
    const failMatch = output.match(/(\d+) failed/);
    if (failMatch) return { isError: true, category: 'test_failure', signature: `test_${failMatch[1]}_failed` };
    if (/FAIL\s|Tests:.*failed|AssertionError|expect\(received\)/i.test(output)) {
      return { isError: true, category: 'test_failure', signature: 'test_assertion_failed' };
    }
  }

  if (/tsc|esbuild|webpack|vite|rollup|turbopack|next build|npm run build/i.test(output)) {
    if (/Build failed|Compilation failed|build error/i.test(output)) {
      const toolMatch = output.match(/(tsc|esbuild|webpack|vite|rollup|turbopack|next)/i);
      return { isError: true, category: 'build', signature: `build_${(toolMatch?.[1] || 'unknown').toLowerCase()}` };
    }
  }

  const modMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/i);
  if (modMatch) {
    const modName = modMatch[1].replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
    return { isError: true, category: 'import', signature: `module_not_found_${modName}` };
  }
  if (/ERR_MODULE_NOT_FOUND|Module not found/i.test(output)) {
    return { isError: true, category: 'import', signature: 'module_not_found' };
  }

  const runtimeMatch = output.match(/(?:^|\n)\s*(TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError):\s*(.{1,80})/m);
  if (runtimeMatch) {
    const errClass = runtimeMatch[1].toLowerCase();
    const msgSnippet = runtimeMatch[2].replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
    return { isError: true, category: 'runtime', signature: `${errClass}_${msgSnippet}` };
  }
  if (/Error:.*\n\s+at\s/m.test(output)) {
    const errMsg = output.match(/Error:\s*(.{1,60})/)?.[1] || 'unknown';
    const sig = errMsg.replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
    return { isError: true, category: 'runtime', signature: `error_${sig}` };
  }

  if (/eslint|biome|prettier|tslint|stylelint/i.test(output) && /\d+\s+(?:error|problem)/i.test(output)) {
    const linterMatch = output.match(/(eslint|biome|prettier|tslint|stylelint)/i);
    return { isError: true, category: 'lint', signature: `lint_${(linterMatch?.[1] || 'unknown').toLowerCase()}` };
  }

  if (/command not found|not recognized as/i.test(output)) {
    const cmdMatch = output.match(/(\S+):\s*command not found/i) || output.match(/'(\S+)' is not recognized/i);
    return { isError: true, category: 'command', signature: `cmd_not_found_${(cmdMatch?.[1] || 'unknown').toLowerCase().slice(0, 30)}` };
  }
  if (/ENOENT|No such file or directory/i.test(output)) {
    return { isError: true, category: 'command', signature: 'enoent' };
  }
  if (/Permission denied|EACCES/i.test(output)) {
    return { isError: true, category: 'permission', signature: 'permission_denied' };
  }
  if (/CONFLICT|merge conflict/i.test(output)) {
    return { isError: true, category: 'git', signature: 'merge_conflict' };
  }
  const fatalMatch = output.match(/fatal:\s*(.{1,60})/i);
  if (fatalMatch) {
    const sig = fatalMatch[1].replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
    return { isError: true, category: 'git', signature: `git_fatal_${sig}` };
  }
  if (/exit(?:ed with)? code [1-9]\d*/i.test(output)) {
    return { isError: true, category: 'general', signature: 'nonzero_exit' };
  }

  return { isError: false };
}

// ── Helpers ──

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let dryRun = false;
  let since: Date | null = null;
  let cutoff: Date | null = null;
  let noCutoff = false;
  let projectFilter: string | null = null;
  let maxFiles: number | null = null;
  let reimport = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--reimport') reimport = true;
    else if (args[i] === '--no-cutoff') noCutoff = true;
    else if (args[i] === '--since' && args[i + 1]) {
      since = new Date(args[++i]);
      if (isNaN(since.getTime())) throw new Error(`Invalid --since date: ${args[i]}`);
    }
    else if (args[i] === '--cutoff' && args[i + 1]) {
      cutoff = new Date(args[++i]);
      if (isNaN(cutoff.getTime())) throw new Error(`Invalid --cutoff date: ${args[i]}`);
    }
    else if (args[i] === '--project' && args[i + 1]) projectFilter = args[++i];
    else if (args[i] === '--max-files' && args[i + 1]) maxFiles = parseInt(args[++i], 10);
  }
  return { dryRun, since, cutoff, noCutoff, projectFilter, maxFiles, reimport };
}

function isProjectDenied(projectDir: string): boolean {
  return PROJECT_DENYLIST.some(p => p.test(projectDir));
}

/**
 * Strip Claude Code subagent worktree suffix from a cwd, so subagent activity
 * attributes to the parent project. Worktree path shape:
 *   <project_root>/.claude/worktrees/agent-XXXXXXX
 */
function normalizeCwd(cwd: string): string {
  const m = cwd.match(/^(.+?)[\\/]\.claude[\\/]worktrees[\\/]agent-[^\\/]+/i);
  return m ? m[1] : cwd;
}

function deriveProjectScope(cwd: string | undefined, fallbackDir: string): string {
  if (cwd) return `project:${path.basename(normalizeCwd(cwd))}`;
  // Fallback: decode the encoded directory name (Claude Code encodes path
  // separators as `-`; the encoding is lossy — multiple `-` collapse — so trust
  // cwd from the JSONL when present). A drive-letter prefix means a Windows-origin
  // path; otherwise POSIX. Use the matching basename so this resolves on either host.
  const drive = fallbackDir.match(/^([A-Za-z])--/);
  if (drive) {
    const decoded = fallbackDir.replace(/^[A-Za-z]--/, `${drive[1]}:\\`).replace(/-/g, '\\');
    return `project:${path.win32.basename(decoded)}`;
  }
  const decoded = fallbackDir.replace(/-/g, '/');
  return `project:${path.posix.basename(decoded)}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text || '');
        if (c && typeof c === 'object' && 'content' in c) return extractTextContent((c as { content: unknown }).content);
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function deterministicIdempotencyKey(sessionId: string, toolUseId: string): string {
  return createHash('sha256').update(`jsonl-import:${sessionId}:${toolUseId}`).digest('hex').slice(0, 32);
}

// ── DB access (read-only existence checks; importer writes via API) ──

interface DbState {
  importedFiles: Set<string>;       // by source_file path — handles subagents (share session_id with parent)
  liveHookFirstSeen: Date | null;   // earliest live observation — auto-cutoff
  liveObservationCount: number;
}

function loadDbState(dbPath: string): DbState {
  if (!fs.existsSync(dbPath)) {
    console.warn(`Observations DB not found at ${dbPath} — assuming empty.`);
    return { importedFiles: new Set(), liveHookFirstSeen: null, liveObservationCount: 0 };
  }
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    // Ensure the imported_sessions table exists. Idempotent — lets the importer
    // run without requiring a server restart after the schema change.
    // PK is source_file (not session_id) because subagent JSONLs share their
    // parent's session_id but live at different file paths.
    db.prepare(`CREATE TABLE IF NOT EXISTS imported_sessions (
      source_file TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      observation_count INTEGER NOT NULL DEFAULT 0,
      project_scope TEXT
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_imported_sessions_project
      ON imported_sessions(project_scope)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_imported_sessions_session
      ON imported_sessions(session_id)`).run();

    const imported = db.prepare<[], { source_file: string }>(
      'SELECT source_file FROM imported_sessions'
    ).all();
    // The live hook uses PID+TERM hashes for session_id; JSONL uses UUIDs.
    // They never overlap, so session-level dedup against live observations
    // doesn't work. Instead, we use the live hook's first-seen timestamp as
    // a cutoff: JSONL files older than this are safe to import.
    const liveStat = db.prepare<[], { earliest: string | null; total: number }>(
      `SELECT MIN(created_at) AS earliest, COUNT(*) AS total
       FROM observations
       WHERE session_id NOT IN (SELECT session_id FROM imported_sessions)`
    ).get();

    // Dedup key is the source file path. The same session_id can appear in both
    // the parent JSONL and one or more subagent JSONLs under <session>/subagents/.
    // We want to import all of them, so we dedup at the file level, not the
    // session level. session_id stays as the parent UUID in observations so the
    // discovery pipeline groups parent+subagent activity together.
    const importedFiles = new Set<string>(imported.map(r => r.source_file));
    return {
      importedFiles,
      liveHookFirstSeen: liveStat?.earliest ? new Date(liveStat.earliest) : null,
      liveObservationCount: liveStat?.total ?? 0,
    };
  } finally {
    db.close();
  }
}

function recordImportedSession(dbPath: string, sessionId: string, count: number, sourceFile: string, projectScope: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO imported_sessions
       (source_file, session_id, imported_at, observation_count, project_scope)
       VALUES (?, ?, datetime('now'), ?, ?)`
    ).run(sourceFile, sessionId, count, projectScope);
  } finally {
    db.close();
  }
}

// ── JSONL parsing ──

interface ParsedSession {
  sessionId: string;
  projectScope: string;
  observations: Observation[];
  orphans: number; // tool_use without matching tool_result (interrupted)
  isSidechain: boolean;
}

async function parseJsonlFile(filePath: string, encodedDirName: string): Promise<ParsedSession | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const pendingToolUses = new Map<string, PendingToolUse>();
  const observations: Observation[] = [];
  let sessionId: string | null = null;
  let projectScope: string | null = null;
  let gitBranch: string | null = null;
  let cwd: string | null = null;
  let isSidechain = false;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: JsonlEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.sessionId && !sessionId) sessionId = event.sessionId;
    if (event.cwd && !cwd) cwd = event.cwd;
    if (event.gitBranch && !gitBranch) gitBranch = event.gitBranch;
    if (event.isSidechain) isSidechain = true;
    if (!projectScope && (cwd || encodedDirName)) {
      projectScope = deriveProjectScope(cwd ?? undefined, encodedDirName);
    }

    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && block.name) {
        pendingToolUses.set(block.id, {
          toolUseId: block.id,
          toolName: block.name,
          input: block.input,
          timestamp: event.timestamp || new Date().toISOString(),
        });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const pending = pendingToolUses.get(block.tool_use_id);
        if (!pending || !sessionId || !projectScope) continue;
        pendingToolUses.delete(block.tool_use_id);

        const inputStr = typeof pending.input === 'string' ? pending.input : JSON.stringify(pending.input ?? '');
        const outputStr = extractTextContent(block.content);
        const isErrorFlag = block.is_error === true;
        const classification = classifyError(pending.toolName, outputStr);
        const isError = isErrorFlag || classification.isError;

        const metadata: Record<string, unknown> = {
          cwd: cwd || null,
          git_branch: gitBranch || null,
          timestamp: pending.timestamp,
          source: 'jsonl_import',
        };
        if (isSidechain) metadata.is_sidechain = true;
        if (classification.isError) {
          metadata.error_category = classification.category;
          metadata.error_signature = classification.signature;
        }

        observations.push({
          idempotency_key: deterministicIdempotencyKey(sessionId, pending.toolUseId),
          session_id: sessionId,
          project_scope: projectScope,
          tool_name: pending.toolName,
          event_type: isError ? 'tool_failed' : 'tool_complete',
          // Server-side scrubbing + truncation runs in the route preHandler;
          // we cap at 5000 here just to stay under the Zod schema max.
          input_summary: inputStr.slice(0, 5000),
          output_summary: outputStr.slice(0, 5000),
          metadata,
        });
      }
    }
  }

  if (!sessionId || !projectScope) return null;

  return {
    sessionId,
    projectScope,
    observations,
    orphans: pendingToolUses.size,
    isSidechain,
  };
}

// ── HTTP posting ──

async function postBatch(observations: Observation[]): Promise<{ ok: boolean; status: number; body?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      },
      body: JSON.stringify({ observations }),
      signal: controller.signal,
    });
    const body = response.ok ? undefined : await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Post a batch with automatic split-and-retry on 413 (request too large).
 * Returns the count actually posted and any final error.
 */
async function postBatchWithRetry(observations: Observation[]): Promise<{ ok: boolean; posted: number; error?: string }> {
  if (observations.length === 0) return { ok: true, posted: 0 };

  const result = await postBatch(observations);
  if (result.ok) return { ok: true, posted: observations.length };

  // Body too large → split in half and recurse. A single oversized observation
  // (output_summary at full 5KB) gets retried alone and surfaces the error.
  if (result.status === 413 && observations.length > 1) {
    const mid = Math.floor(observations.length / 2);
    const left = await postBatchWithRetry(observations.slice(0, mid));
    await sleep(THROTTLE_MS);
    const right = await postBatchWithRetry(observations.slice(mid));
    return {
      ok: left.ok && right.ok,
      posted: left.posted + right.posted,
      error: left.error ?? right.error,
    };
  }

  return { ok: false, posted: 0, error: `${result.status}: ${(result.body ?? '').slice(0, 200)}` };
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`KOPENG JSONL import`);
  console.log(`  source:        ${PROJECTS_DIR}`);
  console.log(`  api:           ${API_URL}`);
  console.log(`  observations:  ${OBSERVATIONS_DB}`);
  console.log(`  dry-run:       ${args.dryRun}`);
  console.log(`  since:         ${args.since?.toISOString() || 'all time'}`);
  console.log(`  project:       ${args.projectFilter || 'all'}`);
  console.log(`  max-files:     ${args.maxFiles ?? 'unlimited'}`);
  console.log(`  reimport:      ${args.reimport}\n`);

  if (!args.dryRun) {
    const healthy = await checkServerHealth();
    if (!healthy) {
      console.error(`Server unreachable at ${API_URL}. Start KOPENG first.`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`Projects dir not found: ${PROJECTS_DIR}`);
    process.exit(1);
  }

  // Load existing session sets + auto-detect live hook activation
  const dbState = loadDbState(OBSERVATIONS_DB);
  const effectiveCutoff = args.noCutoff ? null : (args.cutoff || dbState.liveHookFirstSeen);
  console.log(`Already imported: ${dbState.importedFiles.size} files`);
  console.log(`Live observations: ${dbState.liveObservationCount} (first seen: ${dbState.liveHookFirstSeen?.toISOString() || 'never'})`);
  if (effectiveCutoff) {
    console.log(`Cutoff:           ${effectiveCutoff.toISOString()} (files newer than this are skipped to avoid live-hook dupes)`);
  } else if (args.noCutoff) {
    console.log(`Cutoff:           DISABLED via --no-cutoff (will dupe sessions captured by both live hook and JSONL)`);
  }
  console.log();

  // Discover files
  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  type FileEntry = { path: string; encodedDir: string; mtime: Date; size: number };
  const allFiles: FileEntry[] = [];

  for (const dir of projectDirs) {
    if (isProjectDenied(dir)) continue;
    if (args.projectFilter && !dir.toLowerCase().includes(args.projectFilter.toLowerCase())) continue;

    const dirPath = path.join(PROJECTS_DIR, dir);
    walkJsonl(dirPath, dir, allFiles);
  }

  // Filter by date
  let filtered = allFiles;
  if (args.since) {
    filtered = filtered.filter(f => f.mtime >= args.since!);
  }
  if (effectiveCutoff) {
    filtered = filtered.filter(f => f.mtime < effectiveCutoff);
  }
  filtered.sort((a, b) => a.mtime.getTime() - b.mtime.getTime()); // oldest first
  if (args.maxFiles) filtered = filtered.slice(0, args.maxFiles);

  console.log(`Discovered ${allFiles.length} JSONL files (${filtered.length} after filters)`);
  const totalBytes = filtered.reduce((s, f) => s + f.size, 0);
  console.log(`Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB\n`);

  // Process
  let processedFiles = 0;
  let skippedSessions = 0;
  let totalObservations = 0;
  let totalOrphans = 0;
  let failedBatches = 0;
  const errors: string[] = [];
  const startTime = Date.now();

  for (const file of filtered) {
    processedFiles++;
    if (processedFiles % 50 === 0 || processedFiles === filtered.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [${processedFiles}/${filtered.length}] ${elapsed}s elapsed | ${totalObservations} obs | ${skippedSessions} skipped`);
    }

    let parsed: ParsedSession | null;
    try {
      parsed = await parseJsonlFile(file.path, file.encodedDir);
    } catch (err) {
      errors.push(`Parse failed: ${file.path}: ${err}`);
      continue;
    }
    if (!parsed) continue;

    const isImported = dbState.importedFiles.has(file.path);
    if (!args.reimport && isImported) {
      skippedSessions++;
      continue;
    }

    if (parsed.observations.length === 0) {
      // File had no tool calls — still mark as imported so we don't re-scan
      if (!args.dryRun) {
        recordImportedSession(OBSERVATIONS_DB, parsed.sessionId, 0, file.path, parsed.projectScope);
        dbState.importedFiles.add(file.path);
      }
      continue;
    }

    totalOrphans += parsed.orphans;

    if (args.dryRun) {
      totalObservations += parsed.observations.length;
      continue;
    }

    // Batch + post with adaptive retry on 413
    let sessionPosted = 0;
    let sessionFailed = false;
    for (let i = 0; i < parsed.observations.length; i += BATCH_SIZE) {
      const batch = parsed.observations.slice(i, i + BATCH_SIZE);
      const result = await postBatchWithRetry(batch);
      sessionPosted += result.posted;
      if (!result.ok) {
        failedBatches++;
        sessionFailed = true;
        errors.push(`Batch failed for ${parsed.sessionId} (${file.path.split(/[/\\]/).slice(-2).join('/')}): ${result.error}`);
        break;
      }
      await sleep(THROTTLE_MS);
    }

    // Only mark as imported if the whole file succeeded. Otherwise leave it
    // out of imported_sessions so a future re-run retries the missing pieces;
    // already-stored obs from successful batches will dedup via idempotency_key.
    if (!sessionFailed && sessionPosted > 0) {
      recordImportedSession(OBSERVATIONS_DB, parsed.sessionId, sessionPosted, file.path, parsed.projectScope);
      dbState.importedFiles.add(file.path);
    }
    totalObservations += sessionPosted;
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done in ${elapsed}s`);
  console.log(`  Files processed:    ${processedFiles}`);
  console.log(`  Sessions skipped:   ${skippedSessions} (already imported or live-captured)`);
  console.log(`  Observations ${args.dryRun ? 'parsed' : 'imported'}: ${totalObservations}`);
  console.log(`  Orphan tool calls:  ${totalOrphans} (tool_use without matching result — interrupted sessions)`);
  console.log(`  Failed batches:     ${failedBatches}`);
  if (errors.length > 0) {
    console.log(`\nFirst 5 errors:`);
    for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  if (args.dryRun) {
    console.log('Dry run complete. Re-run without --dry-run to import.');
  } else {
    console.log('Next step: run `npm run discover` to surface patterns from imported history.');
  }
}

function walkJsonl(dir: string, encodedDir: string, out: { path: string; encodedDir: string; mtime: Date; size: number }[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Subagent files live one level deeper under <session>/subagents/
      walkJsonl(full, encodedDir, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        out.push({ path: full, encodedDir, mtime: stat.mtime, size: stat.size });
      } catch {
        /* skip unreadable */
      }
    }
  }
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
