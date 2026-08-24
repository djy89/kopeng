/**
 * KOPENG observation hook for Claude Code.
 * (No shebang: always spawned as `node <path>` by the hook config, and the
 * unit suite imports this file through vitest, whose transform rejects it.)
 *
 * Captures tool-use events and sends them to the KOPENG REST API for
 * pattern detection. Local-first: appends to a JSONL buffer immediately,
 * then batch-flushes to the server asynchronously.
 *
 * Install as a Claude Code hook in settings.json:
 *   {
 *     "hooks": {
 *       "PreToolUse": [{ "command": "node C:/path/to/kopeng/scripts/hooks/kopeng-observe.js tool_start" }],
 *       "PostToolUse": [{ "command": "node C:/path/to/kopeng/scripts/hooks/kopeng-observe.js tool_complete" }]
 *     }
 *   }
 *
 * Environment:
 *   KOPENG_API_URL    — KOPENG REST API base URL (default: http://localhost:3200)
 *   KOPENG_API_KEY    — X-API-Key for observation endpoints
 *   KOPENG_BUFFER_DIR — Directory for local JSONL buffer (default: ~/.kopeng/buffer)
 */

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync, statSync, readdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ── Configuration ──

const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const API_KEY = process.env.KOPENG_API_KEY || process.env.OBSERVATION_API_KEY || '';
const BUFFER_DIR = process.env.KOPENG_BUFFER_DIR || join(homedir(), '.kopeng', 'buffer');
const BUFFER_FILE = join(BUFFER_DIR, 'observations.jsonl');

const FLUSH_THRESHOLD = 20;       // Batch flush after N buffered items
const FLUSH_AGE_MS = 5000;        // Flush if oldest entry is 5s+ old
const MAX_INPUT_SIZE = 5000;       // Characters
const MAX_OUTPUT_SIZE = 1024;      // Characters (tiered: 1KB for Read/Write output)
const MAX_ERROR_OUTPUT_SIZE = 4096; // Characters — larger cap for errors (stack traces need room)
const STDIN_MAX_BYTES = 1024 * 1024; // 1MB stdin cap
const FLUSH_TIMEOUT_MS = 1200;     // HTTP timeout per batch POST (the whole hook runs under a 3s harness timeout)
// T10: keep each batch POST body comfortably under the server's explicit
// per-route bodyLimit (2MB on /api/observations/batch) so a full buffer is
// never rejected with FST_ERR_CTP_BODY_TOO_LARGE (413). We chunk the flush by
// this byte budget; a single observation larger than the budget is sent alone
// (its summaries are already capped at MAX_INPUT_SIZE/MAX_ERROR_OUTPUT_SIZE, so
// it can't exceed the server cap on its own).
const FLUSH_MAX_BODY_BYTES = 1.5 * 1024 * 1024;
// T18: the server's ObservationBatchSchema ALSO caps a batch at 100 items — a
// byte-only chunk of small observations packs ~1000 items and 400s, which is
// what wedged the flush from 06-20 to 07-03 (the first chunk failed, progress
// was all-or-nothing, the buffer grew forever). Both limits hold per chunk.
const FLUSH_MAX_ITEMS = 100;
// T18: bounded work per invocation. The hook is killed at 3s by the harness,
// so a backlog must drain ACROSS invocations with progress committed per chunk
// — never one invocation attempting everything and dying with zero progress.
const FLUSH_MAX_CHUNKS_PER_INVOCATION = 3;
const FLUSH_BUDGET_MS = 1800;
// T18: never inline-parse a buffer past this size — rotate it to an overflow
// file for out-of-band recovery instead. Keeps every invocation O(small) no
// matter how long the server was down (a multi-week outage once grew a buffer to >100MB).
const INLINE_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
// T18: cap the pending flush-file queue; beyond this the oldest pending files
// rotate to overflow-*.jsonl so the inline drain queue stays bounded.
const PENDING_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
const FLUSH_FILE_PREFIX = 'flush-';
const OVERFLOW_FILE_PREFIX = 'overflow-';
// T18: entries the server refuses as invalid (4xx) park here instead of
// blocking the queue — retrying a payload the server calls bad is pointless
// by definition, and one poison chunk must never wedge everything behind it.
const POISON_FILE_PREFIX = 'poison-';
// A 5xx normally means "server having a bad moment" — retryable, and the June
// outage proved we must NOT discard data on it. But a payload the server can
// never store (e.g. a NUL byte from UTF-16LE tool output, which Postgres rejects
// with `invalid byte sequence for encoding "UTF8": 0x00`) also surfaces as a 500,
// and since the queue drains oldest-first, one such chunk head-of-line blocks
// EVERYTHING behind it forever. So: count consecutive failures per (file, offset)
// and, once the SAME chunk has 500'd this many times, treat it as poison. Purely
// transient 5xx never reach the threshold; a server that is down returns status 0
// and is excluded outright.
const FLUSH_MAX_STALL_ATTEMPTS = 3;
const FLUSH_STALL_STATE_FILE = join(BUFFER_DIR, '.flush-stall.json');
const HINTS_DIR = process.env.KOPENG_HINTS_DIR || join(homedir(), '.kopeng', 'hints');
const FLUSH_ERROR_HINT_FILE = join(HINTS_DIR, 'flush_error.json');
const HINT_FILE = join(HINTS_DIR, 'last_error.json');
const CACHE_DIR = join(homedir(), '.kopeng', 'cache');
const SEQUENCE_HINT_FILE = join(HINTS_DIR, 'sequence_hint.json');
// Canonical-path gate (feedback #4506): canonical-path-guard.mjs blocks WebSearch/WebFetch
// while this hint is armed by the recall hook. Reading/Globbing/Grepping/Bash-touching the
// hinted path is the "I engaged with the source of truth" signal that clears the gate.
const CANONICAL_HINT_FILE = join(HINTS_DIR, 'canonical_path.json');
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let _pendingRefresh = null;

// ── Secret scrubbing (client-side, sync) ──

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS = [
  // Keyword-based
  /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth|credential|private[_-]?key|access[_-]?key|secret[_-]?key)\s*[:=]\s*['"]?[^\s'"}{,]+/gi,
  /(?:Authorization)\s*[:=]\s*['"]?(?:Bearer|Basic|Token)\s+[^\s'"}{,]+/gi,
  /(?:Bearer|Basic)\s+[A-Za-z0-9_=.+/-]{8,}/gi,
  // Format-based
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[ps]_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{36,}/g,
  /gho_[A-Za-z0-9_]{36,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{24,}/g,
  /pk_(?:live|test)_[A-Za-z0-9]{24,}/g,
  /sk-[A-Za-z0-9_-]{40,}/g,
  /xox[bpsa]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /((?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp|amqps):\/\/[^:]+):([^@]+)@/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g,
];

const SUPPRESS_PATTERNS = [/\.env(\.|$)/i, /id_(rsa|ed25519|ecdsa|dsa)/i];

function scrub(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function shouldSuppressOutput(toolName, inputSummary) {
  if (!inputSummary) return false;
  if (toolName === 'Read' || toolName === 'read_file') {
    for (const p of SUPPRESS_PATTERNS) {
      if (p.test(inputSummary)) return true;
    }
  }
  return false;
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

// ── Error classification ──

/** Patterns that indicate the output is NOT an error despite containing "error"-like words. */
const NEGATIVE_PATTERNS = [
  /0 errors/i,
  /no errors found/i,
  /all checks passed/i,
  /build succeeded/i,
  /successfully compiled/i,
  /passed.*\d+.*tests/i,
  /0 failed/i,
];

/**
 * Classify tool output as an error and extract category + signature.
 * Returns { isError: false } or { isError: true, category: string, signature: string }.
 *
 * Only Bash output is checked for most categories. Edit/Write get edit_conflict only.
 * False positives are mitigated by negative patterns and multi-signal requirements.
 */
function classifyError(toolName, rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return { isError: false };

  const output = rawOutput.slice(0, 8000); // scan window

  // Check negative patterns first — if output looks successful, skip
  for (const neg of NEGATIVE_PATTERNS) {
    neg.lastIndex = 0;
    if (neg.test(output)) return { isError: false };
  }

  // Edit/Write conflict detection
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'edit_file' || toolName === 'write_file') {
    if (/old_string.*not unique|is not unique in the file/i.test(output)) {
      return { isError: true, category: 'edit_conflict', signature: 'edit_not_unique' };
    }
    if (/old_string.*not found|does not contain/i.test(output)) {
      return { isError: true, category: 'edit_conflict', signature: 'edit_not_found' };
    }
    return { isError: false };
  }

  // Only classify Bash-family tools for remaining categories
  const BASH_TOOLS = new Set(['Bash', 'bash', 'shell', 'terminal']);
  if (!BASH_TOOLS.has(toolName)) return { isError: false };

  // TypeScript errors (highest signal — TS error codes are unambiguous)
  const tsMatch = output.match(/error (TS\d{4,5}):/);
  if (tsMatch) {
    return { isError: true, category: 'typescript', signature: tsMatch[1].toLowerCase() };
  }
  if (/Type ['"].+['"] is not assignable to type/i.test(output)) {
    return { isError: true, category: 'typescript', signature: 'ts_type_not_assignable' };
  }

  // Test failures (require test-runner context)
  const hasTestRunner = /vitest|jest|mocha|pytest|cargo test|go test|npm test/i.test(output);
  if (hasTestRunner) {
    const failMatch = output.match(/(\d+) failed/);
    if (failMatch) {
      return { isError: true, category: 'test_failure', signature: `test_${failMatch[1]}_failed` };
    }
    if (/FAIL\s|Tests:.*failed|AssertionError|AssertionError|expect\(received\)/i.test(output)) {
      return { isError: true, category: 'test_failure', signature: 'test_assertion_failed' };
    }
  }

  // Build errors (require build tool context)
  const hasBuildTool = /tsc|esbuild|webpack|vite|rollup|turbopack|next build|npm run build/i.test(output);
  if (hasBuildTool) {
    if (/Build failed|Compilation failed|build error/i.test(output)) {
      const toolMatch = output.match(/(tsc|esbuild|webpack|vite|rollup|turbopack|next)/i);
      return { isError: true, category: 'build', signature: `build_${(toolMatch?.[1] || 'unknown').toLowerCase()}` };
    }
  }

  // Module/import errors
  if (/Cannot find module ['"]([^'"]+)['"]/i.test(output)) {
    const modMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/i);
    const modName = (modMatch?.[1] || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
    return { isError: true, category: 'import', signature: `module_not_found_${modName}` };
  }
  if (/ERR_MODULE_NOT_FOUND|Module not found/i.test(output)) {
    return { isError: true, category: 'import', signature: 'module_not_found' };
  }

  // Runtime errors (Error class at line start or after throw/Uncaught)
  const runtimeMatch = output.match(/(?:^|\n)\s*(TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError):\s*(.{1,80})/m);
  if (runtimeMatch) {
    const errClass = runtimeMatch[1].toLowerCase();
    const msgSnippet = runtimeMatch[2].replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
    return { isError: true, category: 'runtime', signature: `${errClass}_${msgSnippet}` };
  }
  // Generic Error with stack trace (must have "at" frames to avoid false positives)
  if (/Error:.*\n\s+at\s/m.test(output)) {
    const errMsg = output.match(/Error:\s*(.{1,60})/)?.[1] || 'unknown';
    const sig = errMsg.replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
    return { isError: true, category: 'runtime', signature: `error_${sig}` };
  }

  // Lint errors (require linter context)
  const hasLinter = /eslint|biome|prettier|tslint|stylelint/i.test(output);
  if (hasLinter && /\d+\s+(?:error|problem)/i.test(output)) {
    const linterMatch = output.match(/(eslint|biome|prettier|tslint|stylelint)/i);
    return { isError: true, category: 'lint', signature: `lint_${(linterMatch?.[1] || 'unknown').toLowerCase()}` };
  }

  // Command/shell errors
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

  // Git errors
  if (/CONFLICT|merge conflict/i.test(output)) {
    return { isError: true, category: 'git', signature: 'merge_conflict' };
  }
  if (/fatal:\s/i.test(output)) {
    const gitMsg = output.match(/fatal:\s*(.{1,60})/i)?.[1] || 'unknown';
    const sig = gitMsg.replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40);
    return { isError: true, category: 'git', signature: `git_fatal_${sig}` };
  }

  // Exit code indication (catch-all for non-zero exits)
  if (/exit(?:ed with)? code [1-9]\d*/i.test(output)) {
    return { isError: true, category: 'general', signature: 'nonzero_exit' };
  }

  return { isError: false };
}

/**
 * Write an error hint file for the recall hook to pick up.
 * Overwrites any previous hint — only the most recent error matters.
 */
function writeErrorHint(category, signature, projectScope, toolName, outputSnippet) {
  try {
    if (!existsSync(HINTS_DIR)) {
      mkdirSync(HINTS_DIR, { recursive: true, mode: 0o700 });
    }
    const hint = {
      category,
      signature,
      project: projectScope,
      tool_name: toolName,
      snippet: (outputSnippet || '').slice(0, 300),
      timestamp: new Date().toISOString(),
    };
    writeFileSync(HINT_FILE, JSON.stringify(hint), { mode: 0o600 });
  } catch {
    // Non-critical — don't block the hook
  }
}

/**
 * Feedback #4506 read-to-unlock: if this tool engages with a path the canonical-path
 * guard is gating on, clear the gate so WebSearch/WebFetch unblocks. Matches the hinted
 * path as a substring of the (unscrubbed) tool input — so Reading a file INSIDE a hinted
 * directory also counts as engaging with it. Project-scoped + fail-silent; ENOENT (the
 * common case, no active gate) returns immediately.
 */
function clearCanonicalHintIfTouched(rawInput, projectScope) {
  let h;
  try { h = JSON.parse(readFileSync(CANONICAL_HINT_FILE, 'utf-8')); } catch { return; }
  if (!h || h.project !== projectScope || !Array.isArray(h.paths)) return;
  const hay = String(rawInput || '').replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase();
  const touched = h.paths.some((p) => {
    const np = String(p || '').replace(/\\/g, '/').toLowerCase();
    return np.length > 3 && hay.includes(np);
  });
  if (touched) {
    try { unlinkSync(CANONICAL_HINT_FILE); } catch { /* ignore */ }
  }
}

/**
 * T29 turn gate: per-session critical-memory hint path. Must stay byte-identical to
 * the derivation in memory-prompt-search.mjs and turn-gate.mjs.
 */
function criticalHintFile(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '') || 'nosession';
  return join(HINTS_DIR, `critical_${safe}.json`);
}

/**
 * T29 (pure, exported for tests): does a tool input engage a critical memory's path
 * referent? Same normalization as the canonical read-to-unlock — backslashes → forward,
 * lowercased, substring match — so Reading a file INSIDE a hinted directory counts.
 */
function referentTouched(rawInput, referent) {
  const hay = String(rawInput || '').replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase();
  const needle = String(referent || '').toLowerCase().replace(/\\/g, '/');
  return needle.length > 3 && hay.includes(needle);
}

/**
 * T29 read-to-satisfy: if this tool engages any referent of a still-unconsulted
 * critical memory (this session, this project), mark that memory consulted so
 * turn-gate.mjs lets the turn end. Runs in the existing PreToolUse pass (no new
 * spawn). Session + project scoped; fail-silent; ENOENT (no armed gate) is a no-op.
 */
function markCriticalConsultedIfTouched(rawInput, projectScope, sessionId) {
  const file = criticalHintFile(sessionId);
  let h;
  try { h = JSON.parse(readFileSync(file, 'utf-8')); } catch { return; }
  if (!h || h.session_id !== sessionId || !Array.isArray(h.items)) return;
  let changed = false;
  for (const it of h.items) {
    if (it.consulted) continue;
    const referents = Array.isArray(it.referents) ? it.referents : [];
    if (referents.some((r) => referentTouched(rawInput, r))) {
      it.consulted = true;
      it.consulted_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) {
    try { writeFileSync(file, JSON.stringify(h)); } catch { /* ignore */ }
  }
}

// ── Sequence key normalization (port of src/discovery/heuristics.ts:475-513) ──

/**
 * Normalize a tool invocation to a canonical key for sequence matching.
 * Must stay in sync with the server-side getSequenceKey in heuristics.ts.
 */
function getSequenceKey(toolName, inputSummary) {
  if (['Read', 'read_file', 'Write', 'write_file', 'Edit', 'edit_file'].includes(toolName)) {
    const pathMatch = (inputSummary || '').match(/"file_path"\s*:\s*"([^"]+)"/i);
    if (pathMatch) {
      const base = pathMatch[1].replace(/\\\\/g, '\\').split(/[/\\]/).pop() || toolName;
      return `${toolName}(${base.toLowerCase()})`;
    }
    return toolName;
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const patternMatch = (inputSummary || '').match(/"pattern"\s*:\s*"([^"]{1,30})"/i);
    if (patternMatch) return `${toolName}("${patternMatch[1]}")`;
    return toolName;
  }
  if (['Bash', 'bash', 'shell', 'terminal'].includes(toolName)) {
    const cmdMatch = (inputSummary || '').match(/"command"\s*:\s*"([^"]+)"/i);
    if (cmdMatch) {
      let cmd = cmdMatch[1].trim();
      cmd = cmd.replace(/^cd\s+"[^"]+"\s*&&\s*/i, '');
      const firstWord = cmd.split(/\s+/)[0].replace(/.*[/\\]/, '');
      return `Bash(${firstWord.toLowerCase()})`;
    }
    return 'Bash';
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts[parts.length - 1];
  }
  return toolName;
}

// ── Sequence cache ──

function getSequenceCachePath(projectScope) {
  const safeProject = projectScope.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(CACHE_DIR, `sequences_${safeProject}.json`);
}

function getSequenceCache(projectScope) {
  const cachePath = getSequenceCachePath(projectScope);
  try {
    if (!existsSync(cachePath)) return null;
    const age = Date.now() - statSync(cachePath).mtimeMs;
    if (age > CACHE_TTL_MS) return null;
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function refreshSequenceCache(projectScope) {
  try {
    const url = `${API_URL}/api/memories?type=discovery&scope=${encodeURIComponent(projectScope)}&tags=sequence&limit=50`;
    const response = await fetch(url, {
      headers: API_KEY ? { 'X-API-Key': API_KEY } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return;
    const result = await response.json();
    if (!result?.data) return;

    const lookup = {};
    for (const mem of result.data) {
      const m = mem.content.match(/Workflow sequence detected:\s*(.+?)\s*→\s*(.+?)\./);
      if (!m) continue;
      const aKey = m[1].trim();
      const bKey = m[2].trim();
      if (!lookup[aKey]) lookup[aKey] = [];
      if (!lookup[aKey].includes(bKey)) lookup[aKey].push(bKey);
    }
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(
      getSequenceCachePath(projectScope),
      JSON.stringify({ lookup, fetched_at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch {
    // Non-critical — cache refresh must never crash the hook
  }
}

function writeSequenceHint(currentKey, nextSteps, projectScope) {
  try {
    if (!existsSync(HINTS_DIR)) {
      mkdirSync(HINTS_DIR, { recursive: true, mode: 0o700 });
    }
    const hint = {
      current_tool_key: currentKey,
      next_steps: nextSteps,
      project: projectScope,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(SEQUENCE_HINT_FILE, JSON.stringify(hint), { mode: 0o600 });
  } catch {
    // Non-critical — don't block the hook
  }
}

// ── Session / project detection ──

function getSessionId() {
  // Claude Code sets CLAUDE_SESSION_ID; fall back to a per-terminal hash
  return process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || createHash('sha256').update(`${process.ppid}-${process.env.TERM_SESSION_ID || ''}`).digest('hex').slice(0, 16);
}

// ── Buffer management ──

function ensureBufferDir() {
  if (!existsSync(BUFFER_DIR)) {
    mkdirSync(BUFFER_DIR, { recursive: true, mode: 0o700 });
  }
}

function appendToBuffer(entry) {
  ensureBufferDir();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(BUFFER_FILE, line, { mode: 0o600 });
}

/** Parse a JSONL file into entries; malformed lines are dropped. */
function readEntriesFrom(path) {
  let content;
  try { content = readFileSync(path, 'utf-8'); } catch { return []; }
  content = content.trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function readBuffer() {
  return readEntriesFrom(BUFFER_FILE);
}

/**
 * T18 flush model (replaces read-all → POST-all → clear-on-total-success,
 * which wedged permanently once the backlog outgrew what one 3s-limited hook
 * invocation could ship — the multi-week silent-outage failure mode): the append target stays
 * small; when a flush is due the buffer is atomically RENAMED to a
 * flush-<stamp>.jsonl file (concurrent hook processes keep appending to a
 * fresh buffer — no lost-append race), and pending flush files drain
 * oldest-first with progress committed after every accepted chunk. A process
 * killed mid-drain loses at most one chunk of WORK, never data — re-sending an
 * already-accepted chunk is a server-side no-op (idempotency keys).
 */

/** Strip buffer-local fields down to the server's observation shape. */
function toServerObservation(e) {
  return {
    idempotency_key: e.idempotency_key,
    session_id: e.session_id,
    project_scope: e.project_scope,
    tool_name: e.tool_name,
    event_type: e.event_type,
    input_summary: e.input_summary,
    output_summary: e.output_summary,
    metadata: e.metadata,
  };
}

/** Pending inline-drain queue, oldest first (stamps sort chronologically). */
function listPendingFlushFiles() {
  try {
    return readdirSync(BUFFER_DIR)
      .filter(f => f.startsWith(FLUSH_FILE_PREFIX) && f.endsWith('.jsonl'))
      .sort()
      .map(f => join(BUFFER_DIR, f));
  } catch {
    return [];
  }
}

/**
 * T18 failure visibility: any flush trouble writes this hint; the recall hook
 * surfaces it in the next prompt's systemMessage; the next fully-drained
 * invocation clears it. A silent multi-week FLUSH outage becomes structurally
 * impossible while the hooks themselves run — failure is in-band within a
 * prompt or two. (A hook that never executes — uninstall, missing node — stays
 * the residual silent class, and this writer is itself try/catch-swallowed.)
 */
function writeFlushErrorHint(info) {
  try {
    if (!existsSync(HINTS_DIR)) {
      mkdirSync(HINTS_DIR, { recursive: true, mode: 0o700 });
    }
    let pendingBytes = info.pending_bytes ?? 0;
    if (!info.pending_bytes) {
      try {
        for (const f of readdirSync(BUFFER_DIR)) {
          const isQueue = (f.startsWith(FLUSH_FILE_PREFIX) || f.startsWith(OVERFLOW_FILE_PREFIX) || f.startsWith(POISON_FILE_PREFIX)) && f.endsWith('.jsonl');
          if (!isQueue && join(BUFFER_DIR, f) !== BUFFER_FILE) continue;
          try { pendingBytes += statSync(join(BUFFER_DIR, f)).size; } catch { /* raced */ }
        }
      } catch { /* dir absent */ }
    }
    writeFileSync(FLUSH_ERROR_HINT_FILE, JSON.stringify({
      reason: info.reason || 'error',
      ...(info.status ? { status: info.status } : {}),
      pending_bytes: pendingBytes,
      timestamp: new Date().toISOString(),
    }), { mode: 0o600 });
  } catch {
    // Non-critical — don't block the hook
  }
}

function clearFlushErrorHint() {
  try { unlinkSync(FLUSH_ERROR_HINT_FILE); } catch { /* absent */ }
}

/**
 * Park server-refused (4xx) entries aside — visible via the hint, recoverable
 * out-of-band, never blocking the queue. Returns false if the park write
 * failed (caller must then keep the entries in the queue file instead).
 */
function quarantinePoisonChunk(entries) {
  try {
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '')}-${process.pid}`;
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(join(BUFFER_DIR, `${POISON_FILE_PREFIX}${stamp}.jsonl`), lines, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-chunk stall bookkeeping, keyed by "<queue file>#<first entry's
 * idempotency_key>" — content identity, NOT a byte/item offset. A byte offset
 * looked like a stable identity but isn't: commitRemainder rewrites a queue
 * file to its unsent TAIL after every partial success, so a later invocation
 * that re-reads the file starts counting from offset 0 again for whatever
 * chunk now happens to sit at the head — genuinely different data inheriting
 * a stale attempt count (and stale baseline) left by an unrelated earlier
 * chunk. idempotency_key is generated once per real captured event and never
 * repeats, so this key can't collide across a rewrite. Fail-soft: an
 * unreadable or unwritable state file simply means no chunk ever crosses the
 * stall threshold, which is the pre-existing (retry-forever) behavior.
 */
function readStallState() {
  try {
    const s = JSON.parse(readFileSync(FLUSH_STALL_STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeStallState(state) {
  try {
    // Drop keys for queue files that no longer exist so the file can't grow
    // without bound as the queue churns. Meta keys (leading underscore — e.g.
    // the cross-invocation success counter below) aren't tied to a queue file
    // and are always kept.
    const live = new Set(listPendingFlushFiles().map(f => basename(f)));
    const pruned = {};
    for (const [k, v] of Object.entries(state)) {
      if (k.startsWith('_') || live.has(k.split('#')[0])) pruned[k] = v;
    }
    writeFileSync(FLUSH_STALL_STATE_FILE, JSON.stringify(pruned), { mode: 0o600 });
  } catch {
    // Best-effort — see readStallState.
  }
}

/**
 * Bumps the persisted cross-invocation counter of successfully-posted chunks
 * — the ONLY evidence the stall-escalation check (below, in
 * drainPendingFlushes) has that the server is CURRENTLY storing data, the
 * signal that tells "this one chunk is unstorable" (other chunks keep
 * succeeding) apart from "the database is down" (nothing succeeds, ever).
 *
 * Also clears the JUST-SUCCEEDED chunk's own stall entry, if it had one from
 * earlier failed attempts on THIS invocation or a prior one: a stall record
 * must only ever describe a chunk that is CURRENTLY failing. Content-keying
 * (see readStallState) makes a stale entry harmless for content-identified
 * chunks — it can never be looked up again by different data. But the
 * fallback identity used for keyless entries (`?? consumed`, see the stallKey
 * comment above) IS an on-disk offset, which a stale entry CAN collide on
 * once commitRemainder rewrites the file and a different chunk lands at that
 * same offset. THIS delete-on-success is what keeps that fallback branch safe
 * too: both transitions that shift on-disk offsets — this success path and
 * poison-quarantine, above — clear their own key before returning, so no
 * stale offset-keyed entry survives to be inherited by whatever unrelated
 * chunk comes next.
 */
function recordFlushSuccess(stallKey) {
  const state = readStallState();
  state._success_count = (state._success_count ?? 0) + 1;
  if (stallKey && stallKey in state) delete state[stallKey];
  writeStallState(state);
}

/**
 * Rotate the live buffer out of the append path.
 * - Oversized buffer (server down a long stretch) → overflow-*.jsonl: never
 *   inline-parsed, recovered out-of-band (importer / runbook) — every hook
 *   invocation stays O(small) no matter how big the outage got.
 * - Flush-due buffer → flush-*.jsonl: the bounded inline drain queue.
 * Rename is atomic; a concurrent appender simply recreates the buffer.
 * Returns 'overflow' | 'rotated' | null.
 */
function maybeRotateForFlush(opts = {}) {
  const inlineMax = opts.inlineMaxBytes ?? INLINE_BUFFER_MAX_BYTES;
  let size = 0;
  try { size = statSync(BUFFER_FILE).size; } catch { return null; }
  if (size === 0) return null;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '')}-${process.pid}`;
  if (size > inlineMax) {
    try { renameSync(BUFFER_FILE, join(BUFFER_DIR, `${OVERFLOW_FILE_PREFIX}${stamp}.jsonl`)); } catch { return null; }
    writeFlushErrorHint({ reason: 'overflow-rotated', pending_bytes: size });
    return 'overflow';
  }
  if (!shouldFlush(readBuffer())) return null;
  try { renameSync(BUFFER_FILE, join(BUFFER_DIR, `${FLUSH_FILE_PREFIX}${stamp}.jsonl`)); } catch { return null; }
  return 'rotated';
}

function shouldFlush(entries) {
  if (entries.length >= FLUSH_THRESHOLD) return true;
  if (entries.length > 0) {
    const oldest = new Date(entries[0].started_at || entries[0]._buffered_at).getTime();
    if (Date.now() - oldest > FLUSH_AGE_MS) return true;
  }
  return false;
}

// ── HTTP flush ──

/**
 * Split observation payloads into chunks that satisfy BOTH server limits:
 * ≤ FLUSH_MAX_BODY_BYTES of serialized body (T10 — the route's 2MB bodyLimit)
 * AND ≤ FLUSH_MAX_ITEMS entries (T18 — the batch route 400s on >100 items
 * regardless of byte size; byte-only chunking is what kept the June backlog
 * wedged). A single observation that on its own exceeds the byte budget is
 * still emitted as its own chunk (its summaries are already capped, so it
 * can't exceed the server's outer bodyLimit) rather than being dropped or
 * wedging the buffer forever.
 */
function chunkObservations(observations, opts = {}) {
  const maxBytes = opts.maxBytes ?? FLUSH_MAX_BODY_BYTES;
  const maxItems = opts.maxItems ?? FLUSH_MAX_ITEMS;
  const chunks = [];
  let current = [];
  let currentBytes = 2; // account for the {"observations":[]} envelope braces
  for (const obs of observations) {
    // +1 for the comma separator between array elements.
    const size = Buffer.byteLength(JSON.stringify(obs), 'utf-8') + 1;
    if (current.length > 0 && (currentBytes + size > maxBytes || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(obs);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** One bounded batch POST. Returns { ok, status }; status 0 = network/timeout. */
async function postBatch(observations, timeoutMs = FLUSH_TIMEOUT_MS) {
  try {
    const response = await fetch(`${API_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      },
      body: JSON.stringify({ observations }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Rewrite a flush file to its unsent tail; delete it once fully consumed.
 * Write-to-temp + rename so a SIGKILL mid-write (the 3s hook timeout) can
 * never tear the queue file — the worst case everywhere is an idempotent
 * re-send, never a corrupted/lost tail.
 */
function commitRemainder(file, entries, consumed) {
  if (consumed <= 0) return; // nothing accepted — file content is unchanged, skip the rewrite
  // Pid-scoped, not .jsonl — invisible to listPendingFlushFiles AND immune to
  // another session's drainer interleaving on the same queue file (review
  // finding: a shared tmp name let cross-process write/rename interference
  // drop a never-sent tail in a narrow window).
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (consumed >= entries.length) {
      unlinkSync(file);
      try { unlinkSync(tmp); } catch { /* no orphan */ }
      return;
    }
    const rest = entries.slice(consumed).map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(tmp, rest, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Worst case an already-sent chunk is re-sent next invocation — the
    // server's idempotency-key dedup makes that a no-op.
  }
}

/**
 * Drain pending flush files oldest-first, committing progress after every
 * accepted chunk. Stops at the per-invocation chunk/time budget — whatever
 * remains waits for the next hook invocation, so an arbitrarily large backlog
 * drains across calls instead of wedging (the pre-T18 all-or-nothing clear
 * could never complete once the backlog outgrew one 3s-limited invocation).
 * Any failure writes the flush_error hint; a fully drained queue clears it.
 * Returns true only when nothing is left pending.
 */
async function drainPendingFlushes(opts = {}) {
  const maxChunks = opts.maxChunks ?? FLUSH_MAX_CHUNKS_PER_INVOCATION;
  const budgetMs = opts.budgetMs ?? FLUSH_BUDGET_MS;
  const pendingMax = opts.pendingMaxBytes ?? PENDING_TOTAL_MAX_BYTES;
  const started = Date.now();

  let files = listPendingFlushFiles();
  if (files.length === 0) return settleParked();

  // Bound the inline queue: past the cap, the oldest files rotate to
  // overflow-*.jsonl (out-of-band recovery) so per-invocation work stays small.
  let totalBytes = 0;
  const sizes = new Map();
  for (const f of files) {
    try { const s = statSync(f).size; sizes.set(f, s); totalBytes += s; } catch { /* raced */ }
  }
  while (totalBytes > pendingMax && files.length > 1) {
    const oldest = files.shift();
    totalBytes -= sizes.get(oldest) ?? 0;
    try {
      renameSync(oldest, join(BUFFER_DIR, basename(oldest).replace(FLUSH_FILE_PREFIX, OVERFLOW_FILE_PREFIX)));
      writeFlushErrorHint({ reason: 'overflow-rotated' });
    } catch {
      // Raced with another hook process — it owns the file now.
    }
  }

  let sentChunks = 0;
  for (const file of files) {
    if (sentChunks >= maxChunks || Date.now() - started > budgetMs) return false;
    const entries = readEntriesFrom(file);
    if (entries.length === 0) {
      try { unlinkSync(file); } catch { /* raced */ }
      continue;
    }
    const chunks = chunkObservations(entries.map(toServerObservation));
    let consumed = 0;
    for (const chunk of chunks) {
      // Clamp every POST to the REMAINING budget (review finding: a chunk
      // admitted at 1799ms could run a full FLUSH_TIMEOUT_MS to ~3.0s — the
      // harness kill deadline). Under 300ms left isn't worth starting a call.
      const remainingMs = budgetMs - (Date.now() - started);
      if (sentChunks >= maxChunks || remainingMs < 300) break;
      const res = await postBatch(chunk, Math.min(FLUSH_TIMEOUT_MS, remainingMs));
      // Content-keyed, not offset-keyed — see the readStallState doc comment.
      // Computed once here so both the failure branch and the success path
      // (recordFlushSuccess) agree on this POST's identity. Residual: the
      // `?? consumed` fallback only applies to entries with no
      // idempotency_key. This hook always generates one (see below), but
      // JSONL recovered out-of-band (importer, hand-repaired overflow files)
      // need not — two keyless chunks that both land at consumed === 0 would
      // share the same `file#0` key and inherit each other's attempts/
      // baseline (the bug commit 006c7d9 removed, narrowed to keyless
      // entries).
      const stallKey = `${basename(file)}#${chunk[0]?.idempotency_key ?? consumed}`;
      if (!res.ok) {
        // Statuses where the server deems the PAYLOAD invalid — retrying is
        // pointless and one poison chunk must not block the queue: park it and
        // keep draining. Auth failures (401/403) are deliberately NOT poison
        // (review finding): a key misconfig is fixable and must leave data in
        // the retryable queue that auto-drains the moment the key is corrected
        // — exactly how a fixable misconfig becomes data loss. 408/429/5xx/network: transient.
        let isPoison = res.status === 400 || res.status === 413 || res.status === 422;

        // A 5xx that keeps recurring on the SAME chunk MIGHT be a payload the
        // server can never store (e.g. a NUL byte from UTF-16LE tool output,
        // which Postgres rejects outright) rather than a transient blip — but
        // a database outage behind a live Fastify ALSO 500s every chunk, and
        // promoting on attempt count ALONE rolled the whole backlog into
        // poison during such an outage (P5b). The two are distinguishable IN
        // PRINCIPLE: an unstorable payload fails while OTHER chunks keep
        // succeeding; an outage fails everything. So escalation requires BOTH
        // the attempt threshold AND at least one other chunk having posted
        // successfully (recordFlushSuccess, below) since THIS stall key first
        // started failing.
        //
        // CURRENTLY UNREACHABLE IN PRODUCTION: the non-poison failure branch
        // just below does `commitRemainder(...); return false`, which exits
        // the WHOLE drain, not just this chunk. So once a chunk stalls at the
        // head of the oldest queue file, no chunk behind it is ever attempted,
        // the success counter can never advance past this key's frozen
        // baseline, and `attempts >= FLUSH_MAX_STALL_ATTEMPTS && successCount
        // > baseline` is unsatisfiable as written. (Queue files are named
        // flush-<stamp>.jsonl and drained via a plain `.sort()`, so a newer
        // file always sorts AFTER a stalled older one — it can't jump the
        // queue to supply that evidence either.)
        //
        // What actually happens to an unstorable chunk today: every drain
        // fails at it, the T18 alarm (flush_error hint) fires on every
        // prompt, and capture stays wedged until pending bytes exceed
        // PENDING_TOTAL_MAX_BYTES, at which point rotation moves that file to
        // overflow-*.jsonl for out-of-band recovery — no data loss, but a
        // wedge. status 0 (unreachable) and 408/429 are excluded from this
        // branch regardless: those are the genuinely-retryable classes.
        //
        // Kept, not deleted: if the drain is ever changed to skip past a
        // failing chunk instead of returning, this branch becomes correct
        // again — deleting it now would silently discard the NUL-byte
        // head-of-line protection that motivated it.
        if (!isPoison && res.status >= 500) {
          const state = readStallState();
          const successCount = state._success_count ?? 0;
          const prior = state[stallKey];
          // baseline = the success count as of this key's FIRST failure —
          // fixed once set, so later evidence must arrive AFTER the stall began.
          const baseline = prior ? prior.baseline : successCount;
          const attempts = (prior ? prior.attempts : 0) + 1;
          state[stallKey] = { attempts, baseline };
          writeStallState(state);
          if (attempts >= FLUSH_MAX_STALL_ATTEMPTS && successCount > baseline) isPoison = true;
        }

        if (isPoison && quarantinePoisonChunk(entries.slice(consumed, consumed + chunk.length))) {
          writeFlushErrorHint({ reason: 'poison-quarantined', status: res.status });
          sentChunks++;
          consumed += chunk.length;
          commitRemainder(file, entries, consumed);
          const state = readStallState();
          delete state[stallKey];
          writeStallState(state);
          continue;
        }
        writeFlushErrorHint({
          reason: res.status === 0 ? 'server-unreachable' : 'rejected',
          ...(res.status ? { status: res.status } : {}),
        });
        commitRemainder(file, entries, consumed);
        return false;
      }
      // Evidence the server IS storing data right now — also clears this
      // chunk's own stall entry, if any. See recordFlushSuccess.
      recordFlushSuccess(stallKey);
      sentChunks++;
      consumed += chunk.length;
      commitRemainder(file, entries, consumed);
    }
    if (consumed < entries.length) return false; // budget spent mid-file — resume next invocation
  }
  return settleParked();
}

/**
 * The drain epilogue, also run when the inline queue is already empty: parked
 * overflow/poison files are still pending data, so the alarm stays up (and its
 * timestamp/bytes stay FRESH — every invocation re-writes it, so a manually
 * deleted hint regenerates) until they are recovered (runbook). Only a fully
 * clear buffer dir clears the hint. Returns true = nothing pending anywhere.
 */
function settleParked() {
  let parkedCount = 0;
  try {
    parkedCount = readdirSync(BUFFER_DIR)
      .filter(f => (f.startsWith(OVERFLOW_FILE_PREFIX) || f.startsWith(POISON_FILE_PREFIX)) && f.endsWith('.jsonl')).length;
  } catch { /* dir absent */ }
  if (parkedCount > 0) {
    writeFlushErrorHint({ reason: 'overflow-pending' });
    return false;
  }
  clearFlushErrorHint();
  return true;
}

// ── Main ──

async function main() {
  const rawEventType = process.argv[2]; // 'tool_start' or 'tool_complete'
  if (!rawEventType || !['tool_start', 'tool_complete'].includes(rawEventType)) {
    process.exit(0);
  }

  // Read stdin (tool call JSON from Claude Code hook system)
  let stdinData = '';
  try {
    stdinData = readFileSync(0, 'utf-8').slice(0, STDIN_MAX_BYTES);
  } catch {
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(stdinData);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name || hookData.tool || '';
  // Prefer stdin-provided session/cwd: Codex provides both and sets no CLAUDE_*
  // env, so the env-based helpers would misattribute its observations. Claude
  // Code provides the same stdin fields, so this is parity, not a behavior change.
  const sessionId = hookData.session_id || getSessionId();
  const cwd = hookData.cwd || process.env.CLAUDE_CWD || process.cwd();
  const projectScope = `project:${basename(cwd)}`;

  // Build input/output summaries with scrubbing
  let inputSummary = null;
  let outputSummary = null;
  let eventType = rawEventType;
  let errorCategory = null;
  let errorSignature = null;

  if (rawEventType === 'tool_start') {
    const rawInput = typeof hookData.tool_input === 'string'
      ? hookData.tool_input
      : JSON.stringify(hookData.tool_input || hookData.input || '');
    inputSummary = truncate(scrub(rawInput), MAX_INPUT_SIZE);
    // Feedback #4506: engaging with a gated canonical path clears the WebSearch/WebFetch block.
    clearCanonicalHintIfTouched(rawInput, projectScope);
    // T29: engaging a critical memory's path referent marks it consulted for the turn gate.
    markCriticalConsultedIfTouched(rawInput, projectScope, sessionId);
  }

  if (rawEventType === 'tool_complete') {
    const rawInput = typeof hookData.tool_input === 'string'
      ? hookData.tool_input
      : JSON.stringify(hookData.tool_input || hookData.input || '');
    inputSummary = truncate(scrub(rawInput), MAX_INPUT_SIZE);

    // Read output across agents: Claude Code uses tool_output/tool_result, Codex
    // uses tool_response (string for Bash, object for MCP results).
    const rawOutput = typeof hookData.tool_output === 'string'
      ? hookData.tool_output
      : typeof hookData.tool_response === 'string'
        ? hookData.tool_response
        : typeof hookData.tool_result === 'string'
          ? hookData.tool_result
          : JSON.stringify(hookData.tool_output || hookData.tool_response || hookData.tool_result || hookData.output || '');

    // Classify errors before truncation (need full output for pattern matching)
    const classification = classifyError(toolName, rawOutput);

    if (classification.isError) {
      eventType = 'tool_failed';
      errorCategory = classification.category;
      errorSignature = classification.signature;
    }

    if (shouldSuppressOutput(toolName, inputSummary)) {
      outputSummary = '[SUPPRESSED]';
    } else {
      // Errors get a larger output cap (4KB) to preserve stack traces
      const outputCap = classification.isError
        ? MAX_ERROR_OUTPUT_SIZE
        : ['Read', 'Write', 'read_file', 'write_file'].includes(toolName)
          ? Math.min(MAX_OUTPUT_SIZE, 1024)
          : MAX_OUTPUT_SIZE;
      outputSummary = truncate(scrub(rawOutput), outputCap);
    }

    // Write hint file for proactive surfacing via recall hook
    if (classification.isError) {
      writeErrorHint(errorCategory, errorSignature, projectScope, toolName, scrub(rawOutput));
    }

    // Sequence trigger: check if this tool is the "A" of a known A→B workflow
    if (inputSummary) {
      const seqKey = getSequenceKey(toolName, inputSummary);
      const cache = getSequenceCache(projectScope);
      if (cache && cache.lookup) {
        const matches = cache.lookup[seqKey];
        if (matches && matches.length > 0) {
          writeSequenceHint(seqKey, matches, projectScope);
        }
        // Stale-while-revalidate: refresh if cache is >80% through TTL
        const cacheAge = Date.now() - new Date(cache.fetched_at).getTime();
        if (cacheAge > CACHE_TTL_MS * 0.8) {
          _pendingRefresh = refreshSequenceCache(projectScope);
        }
      } else {
        // Cold start: populate cache for next invocation, skip matching this time
        _pendingRefresh = refreshSequenceCache(projectScope);
      }
    }
  }

  // Build entry
  const entry = {
    idempotency_key: randomUUID(),
    session_id: sessionId,
    project_scope: projectScope,
    tool_name: toolName,
    event_type: eventType,
    input_summary: inputSummary,
    output_summary: outputSummary,
    metadata: {
      cwd,
      git_branch: process.env.CLAUDE_GIT_BRANCH || null,
      ...(errorCategory ? { error_category: errorCategory } : {}),
      ...(errorSignature ? { error_signature: errorSignature } : {}),
    },
    _buffered_at: new Date().toISOString(),
  };

  // 1. Append to local buffer (sync, sub-ms — never lost)
  appendToBuffer(entry);

  // 2. T18 flush: rotate the buffer out of the append path when a flush is
  // due (or oversized → overflow), then drain pending flush files under a
  // strict per-invocation budget with progress committed per chunk.
  maybeRotateForFlush();
  await drainPendingFlushes();

  // Await any pending cache refresh before exit (bounded by 2s timeout)
  if (_pendingRefresh) {
    try { await _pendingRefresh; } catch { /* already handled inside */ }
  }

  process.exit(0);
}

// T18: exported for the unit suite (tests/unit/observe-hook-flush.test.ts);
// the hook stays a standalone script — main() runs only when invoked directly.
export {
  classifyError,
  getSequenceKey,
  scrub,
  truncate,
  shouldFlush,
  chunkObservations,
  toServerObservation,
  maybeRotateForFlush,
  drainPendingFlushes,
  listPendingFlushFiles,
  readEntriesFrom,
  writeFlushErrorHint,
  clearFlushErrorHint,
  referentTouched,
  markCriticalConsultedIfTouched,
  criticalHintFile,
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(() => process.exit(0));
