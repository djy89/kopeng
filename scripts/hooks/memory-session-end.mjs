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
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

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
  const project = basename(cwd);

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
