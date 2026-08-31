#!/usr/bin/env node
/**
 * KOPENG session-end hook (SessionEnd) — Node port of memory-session-end.sh.
 *
 * Writes a one-line breadcrumb to ~/.claude/session-data/<project>.last-session.json
 * that the next session's SessionStart hook surfaces as "[LAST SESSION]". No jq —
 * JSON via JSON.stringify, git via child_process. Part of the 2026-06-02 move off
 * the bash+jq hook chain that silently disabled recall when jq left PATH.
 *
 * Reads a SessionEnd payload (cwd) on stdin. Always exits 0 with {}.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
// RULING-C (WS7.6): project:<basename(cwd)> is now project:<owner>-<repo>
// derived from the git remote, marker-overridable — see project-scope.mjs.
import { deriveProjectScope } from './project-scope.mjs';

function emit(obj) {
  try { writeFileSync(1, JSON.stringify(obj)); } catch { /* ignore */ }
  process.exit(0);
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    }).trim();
  } catch {
    return '';
  }
}

const stripHash = (line) => line.replace(/^[a-f0-9]+ /, '');

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { emit({}); return; }

  const cwd = String(input.cwd || '');
  if (!cwd) { emit({}); return; }
  // RULING-C (WS7.6): MUST derive `project` the SAME way as memory-session-start.mjs
  // — a mismatch here orphans the breadcrumb permanently (it writes under a name
  // the reader never looks for again). `project` is a filename only, never a scope:
  // strip whichever prefix is present (`project:`/`client:` — a marker override can
  // name either), then fold every other filesystem-unsafe character — same fold as
  // the sibling caches (kopeng-observe.js's sequence cache, canonical-triggers.mjs)
  // — so an oversized or `/`-bearing override can never produce an invalid or
  // colliding path (a colon, uncaught, breaks this write on Windows).
  const projectScope = deriveProjectScope(cwd).scope;
  const project = projectScope.replace(/^(?:project|client):/, '').replace(/[^a-zA-Z0-9_-]/g, '_');

  const sessionDir = join(homedir(), '.claude', 'session-data');
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* ignore */ }

  let branch = '', commitLines = [];
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true') {
    branch = git(cwd, ['branch', '--show-current']);
    const commits = git(cwd, ['log', '--oneline', '-3', '--no-decorate']);
    commitLines = commits ? commits.split('\n').filter(l => l.length > 0) : [];
  }

  const subjects = commitLines.map(stripHash).join('; ');
  const summary = branch
    ? `Working on branch ${branch}. Recent: ${subjects}`
    : `Recent: ${subjects}`;

  const breadcrumb = {
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    project,
    branch,
    recent_commits: commitLines,
    summary,
  };

  try {
    writeFileSync(join(sessionDir, `${project}.last-session.json`), JSON.stringify(breadcrumb, null, 2));
  } catch { /* ignore */ }

  emit({});
}

main();
