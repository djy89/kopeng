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
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

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

async function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { emit({}); return; }

  const cwd = String(input.cwd || '');
  if (!cwd) { emit({}); return; }
  const project = basename(cwd);

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
      const results = await searchOne(dynamicQuery, `project:${project}`);
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
