#!/usr/bin/env node
/**
 * KOPENG session-start hook (SessionStart) — Node port of memory-session-start.sh.
 *
 * No jq/curl dependencies (JSON + global fetch). git is still used for repo context
 * via child_process, but its absence only drops git context — it never disables the
 * hook silently the way the missing `jq` did on 2026-06-02.
 *
 * Owns: git context + last-session breadcrumb + one project-scoped memory
 * (rerank-gated). Broader recall is handled by the UserPromptSubmit hook.
 * Always exits 0 with valid JSON.
 *
 * Env: KOPENG_API_URL | MEMORY_API_URL (default http://localhost:3200)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
// RULING-C (WS7.6): project:<basename(cwd)> is now project:<owner>-<repo>
// derived from the git remote, marker-overridable — see project-scope.mjs.
import { deriveProjectScope } from './project-scope.mjs';

const API_URL = process.env.KOPENG_API_URL || process.env.MEMORY_API_URL || 'http://localhost:3200';
const RERANK_FLOOR = 0.3;
const MAX_OUTPUT_CHARS = 4096;
const REQUEST_TIMEOUT_MS = 4000;

// Session context is for the MODEL, so it ships as hookSpecificOutput.additionalContext
// — Claude Code renders `systemMessage` to the operator only and never shows it to
// Claude, so emitting the context block there (as this hook did until sweep-3 PB-1)
// meant the session breadcrumb reached the transcript and never reached the model.
// Codex ignores JSON and injects raw stdout. Shape pinned by
// tests/unit/hook-output-contract.test.ts.
const CODEX = process.argv.includes('--codex');
const HOOK_EVENT = 'SessionStart';

function emit({ context = '' } = {}) {
  try {
    if (CODEX) {
      if (context) writeFileSync(1, context);
    } else {
      const out = context
        ? { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: context } }
        : {};
      writeFileSync(1, JSON.stringify(out));
    }
  } catch { /* ignore */ }
  process.exit(0);
}

// Run a git command in cwd; return trimmed stdout or '' on any failure (git
// missing, not a repo, etc.). git absence degrades gracefully — never throws.
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    }).trim();
  } catch {
    return '';
  }
}

async function searchOne(query, scope) {
  try {
    const res = await fetch(`${API_URL}/api/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, scope, limit: 1, rerank: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
  }
}

const stripHash = (line) => line.replace(/^[a-f0-9]+ /, '');

// Windows compares paths case-insensitively. `path.relative` already folds
// case on win32, so only this equality check needs the fold spelled out.
function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// True when `child` is nested under `parent`. Both sides are resolved first,
// so a `..` segment inside the knob cannot traverse out of KOPENG_HOME.
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Review finding 3: the knob is an exec primitive. This hook spawns
// `knob.node knob.script ensure` DETACHED with stdio discarded at every
// session start, out of a file no other tooling inspects — so a malicious
// postinstall in any npm package in ANY project can leave a durable,
// low-visibility launcher behind by rewriting ~/.kopeng/ensure.json. It is
// not a privilege crossing (whatever wrote that file already runs as the
// operator), but it is cheap to deny: the knob `kopeng init` writes always
// names THIS node binary and a script under KOPENG_HOME (see init.ts's
// `cliEntry`, <home>/app/node_modules/kopeng/dist/cli/index.js), so anything
// else is not our knob and we simply do not fire it.
//
// Fail-open to today's no-op on any mismatch or surprise — a session start
// must never be blocked by this check. Known trade-off: a node upgrade that
// moves the binary (nvm, a reinstall elsewhere) silently disarms ensure until
// `kopeng init` rewrites the knob; the alternative is honoring an arbitrary
// executable path forever, which is the thing being fixed.
function knobIsTrusted(knob, kopengHome) {
  try {
    return samePath(knob.node, process.execPath) && isInside(resolve(kopengHome), resolve(knob.script));
  } catch {
    return false;
  }
}

// Task 2.3.4: `kopeng ensure` self-heal — fires a fire-and-forget probe/spawn
// so a packaged server that died (or was never started) comes back up before
// the NEXT prompt, without this hook ever waiting on it. The knob
// (~/.kopeng/ensure.json, written by `kopeng init` — Task 2.2) is entirely
// optional: absent or malformed = today's behavior, byte-identical. Runs
// before any network call so it never competes with the recall budget.
function maybeFireEnsure() {
  try {
    const kopengHome = process.env.KOPENG_HOME || join(homedir(), '.kopeng');
    const knob = JSON.parse(readFileSync(join(kopengHome, 'ensure.json'), 'utf-8'));
    if (!knob?.enabled || typeof knob.node !== 'string' || typeof knob.script !== 'string') return;
    if (!knobIsTrusted(knob, kopengHome)) return;
    const child = spawn(knob.node, [knob.script, 'ensure'], { detached: true, stdio: 'ignore' });
    // A stale knob (node path no longer exists, permissions changed, etc.) makes
    // spawn fail ASYNCHRONOUSLY — the ENOENT arrives as an 'error' event on a
    // later tick, after this function's sync try/catch has already returned.
    // With no listener, Node treats an unhandled 'error' event as fatal and
    // crashes the WHOLE hook (exit 1, stack trace) if anything downstream
    // yields to the event loop before the process exits (e.g. the recall
    // search's fetch — confirmed empirically: reproduces on a git-repo cwd,
    // not on the fully-synchronous non-git fast path, since process.exit()
    // there wins the race before the pending error ever fires). Silently
    // discarding this fire-and-forget failure is exactly right.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no knob, unreadable, or malformed JSON — nothing to fire */
  }
}

async function main() {
  maybeFireEnsure();

  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { emit({}); return; }

  const cwd = String(input.cwd || '');
  if (!cwd) { emit({}); return; }
  // RULING-C (WS7.6): `projectScope` — not `project` — is what the search call
  // below actually uses, passed verbatim, so a `.kopeng.json` `project` override
  // naming `client:*` (not just `project:*`) reaches the search scope exactly as
  // declared instead of being re-wrapped into a malformed `project:client:acme`.
  // `project` itself is ONLY a filename/display name: strip whichever prefix is
  // present, then fold every other filesystem-unsafe character — same fold as
  // the sibling caches (kopeng-observe.js's sequence cache, canonical-triggers.mjs)
  // — so an oversized or `/`-bearing override can never produce an invalid or
  // colliding path (a colon, uncaught, breaks the breadcrumb write on Windows).
  const projectScope = deriveProjectScope(cwd).scope;
  const project = projectScope.replace(/^(?:project|client):/, '').replace(/[^a-zA-Z0-9_-]/g, '_');

  // ── Git context ──
  const isGit = git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
  let branch = '', recentCommits = '', modifiedFiles = '', lastCommitMsg = '', lastCommitAge = '';
  if (isGit) {
    branch = git(cwd, ['branch', '--show-current']);
    recentCommits = git(cwd, ['log', '--oneline', '-5', '--no-decorate']);
    modifiedFiles = git(cwd, ['status', '--short']);
    lastCommitMsg = stripHash(recentCommits.split('\n')[0] || '');
    lastCommitAge = git(cwd, ['log', '-1', '--format=%cr']);
  }

  // ── Last-session breadcrumb (git repos only) ──
  let lastTimestamp = '', lastSummary = '';
  if (isGit) {
    const sessionFile = join(homedir(), '.claude', 'session-data', `${project}.last-session.json`);
    try {
      const data = JSON.parse(readFileSync(sessionFile, 'utf-8'));
      lastTimestamp = data.timestamp || '';
      lastSummary = data.summary || '';
    } catch { /* no breadcrumb */ }
  }

  // ── One project-scoped memory (git repos only) ──
  let projectMem = '';
  if (isGit) {
    let dynamicQuery = branch || '';
    if (recentCommits) {
      dynamicQuery += ' ' + recentCommits.split('\n').map(stripHash).join(' ');
    }
    if (modifiedFiles) {
      dynamicQuery += ' ' + modifiedFiles.split('\n').map(l => l.trim().split(/\s+/).pop()).join(' ');
    }
    dynamicQuery = dynamicQuery.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (dynamicQuery) {
      const results = await searchOne(dynamicQuery, projectScope);
      const hit = results.find(r => typeof r.rerank_score === 'number' && r.rerank_score > RERANK_FLOOR && r.memory);
      if (hit) projectMem = `- [${hit.memory.type}] ${hit.memory.content}`;
    }
  }

  // ── Format ──
  const NL = '\n';
  let output = '';
  if (isGit) {
    output += `=== SESSION CONTEXT ===${NL}`;
    output += `Branch: ${branch || 'detached'} | Last commit: "${lastCommitMsg}" (${lastCommitAge})${NL}`;
    if (modifiedFiles) {
      const modCount = modifiedFiles.split('\n').filter(Boolean).length;
      output += `Working tree: ${modCount} modified file(s)${NL}`;
    }
  }
  if (lastSummary) output += `${NL}[LAST SESSION - ${lastTimestamp}]${NL}${lastSummary}${NL}`;
  if (projectMem) output += `${NL}[PROJECT - ${project}]${NL}${projectMem}${NL}`;

  if (!isGit && !lastSummary && !projectMem) { emit({}); return; }

  output += `======================${NL}`;
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + `${NL}...[truncated]${NL}======================`;
  }

  emit({ context: output });
}

main().catch(() => { try { if (!CODEX) writeFileSync(1, '{}'); } catch { /* ignore */ } process.exit(0); });
