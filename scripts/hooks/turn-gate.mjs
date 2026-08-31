/**
 * KOPENG turn gate (Stop hook) — T29, roadmap item 2.
 * (No shebang: always spawned as `node <path>` by the hook config, and the unit
 * suite imports this file through vitest, whose transform rejects it.)
 *
 * WHY THIS EXISTS: the field's one measured bottleneck is ADHERENCE, not retrieval —
 * across controlled runs agents ignored a relevant stored note ~65% of the time and
 * re-derived the answer; forcing notes to be consulted took adherence 7/20 → 20/20.
 * KOPENG pushes memory per-prompt but never verified it was ACTED ON. This gate holds
 * the turn open until every memory the recall hook flagged CRITICAL (tagged `critical`
 * or canonical source-of-truth, AND path-anchored) was demonstrably consulted.
 *
 * MECHANISM (mirrors the canonical-path gate's arm→touch→check, which the operator
 * already vetted):
 *   1. ARM   — memory-prompt-search.mjs writes ~/.kopeng/hints/critical_<session>.json
 *              with each critical memory's path referents (consulted:false, nudged:false).
 *   2. TOUCH — kopeng-observe.js flips an item consulted:true the moment a
 *              Read/Glob/Grep/Bash input references any of its referents.
 *   3. CHECK — THIS hook, at Stop: if any critical is still unconsulted AND not yet
 *              nudged, it BLOCKS the stop with a reason naming the ignored memories.
 *
 * LOOP SAFETY: a per-item `nudged` flag (durable state we own) guarantees AT MOST ONE
 * block per critical memory — after the nudge the item never re-blocks, so the model
 * either consults it or the turn ends (logged as ignored-after-nudge). The undocumented
 * `stop_hook_active` field is honored as an additional backstop but is NOT relied upon.
 *
 * METRIC: every Stop appends one adherence record per critical item to
 * ~/.kopeng/metrics/adherence.jsonl (consulted/nudged/blocked). `npm run metric:adherence`
 * collapses to the final per-item outcome — the causal adherence metric that replaces
 * the acceptance≠relevance surfacing metric.
 *
 * FAIL-OPEN: any parse/IO error, missing hint, or wrong session exits 0 with empty
 * stdout (= allow the stop). A gate bug must never wedge the ability to end a turn.
 */

import { readFileSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from './entrypoint.mjs';

const HINTS_DIR = process.env.KOPENG_HINTS_DIR || join(homedir(), '.kopeng', 'hints');
const METRICS_DIR = process.env.KOPENG_METRICS_DIR || join(homedir(), '.kopeng', 'metrics');
const ADHERENCE_LOG = join(METRICS_DIR, 'adherence.jsonl');
// Safety sweep: a per-session hint older than this is treated as an abandoned session
// and dropped rather than gating a coincidental later turn. Generous so a single long
// turn never expires mid-flight; per-session naming already prevents cross-session bleed.
const STALE_MS = 12 * 60 * 60 * 1000; // 12h

/** Per-session critical-memory hint path. Byte-identical to the derivation in
 *  memory-prompt-search.mjs and kopeng-observe.js — keep the three in sync. */
export function criticalHintFile(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '') || 'nosession';
  return join(HINTS_DIR, `critical_${safe}.json`);
}

/**
 * Pure gate decision (exported for tests). Blocks when at least one critical memory is
 * unconsulted AND not yet nudged. `stopHookActive` short-circuits to no-block — a hard
 * backstop against loops on a continuation turn.
 * Returns { block, blockable } where blockable is the list of items to nudge.
 */
export function decideGate(items, stopHookActive) {
  const list = Array.isArray(items) ? items : [];
  if (stopHookActive) return { block: false, blockable: [] };
  const blockable = list.filter((it) => it && !it.consulted && !it.nudged);
  return { block: blockable.length > 0, blockable };
}

/** Compose the block reason shown to the model. Names each ignored critical + its paths. */
export function composeBlockReason(blockable) {
  const lines = blockable.map((it) => {
    const refs = (Array.isArray(it.referents) ? it.referents : []).join('  •  ');
    const ex = String(it.excerpt || '').replace(/\s+/g, ' ').trim();
    return `  - [${it.memory_type || 'memory'}] ${ex ? `"${ex}…" ` : ''}→ ${refs}`;
  }).join('\n');
  return (
    `⛔ Turn held open by the KOPENG turn gate (T29 · adherence).\n\n` +
    `You surfaced ${blockable.length} critical memor${blockable.length === 1 ? 'y' : 'ies'} ` +
    `this session that you have not yet acted on:\n${lines}\n\n` +
    `These are flagged CRITICAL (canonical source-of-truth or operator-tagged). Before ending ` +
    `the turn, engage the referenced path(s) — Read/Grep/Glob them — so your work actually ` +
    `reflects what the memory says, then finish.\n\n` +
    `This gate clears the moment you touch the path(s) and will NOT block you again for these ` +
    `memories. If a memory is genuinely irrelevant to this task, note that briefly and continue — ` +
    `you will not be re-blocked.`
  );
}

/** Append one adherence record per critical item (fail-silent). */
function logAdherence(records) {
  try {
    mkdirSync(METRICS_DIR, { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join('\n');
    if (lines) appendFileSync(ADHERENCE_LOG, lines + '\n');
  } catch { /* never block the stop on metrics */ }
}

function allow() { process.exit(0); }

function block(reason) {
  try {
    writeFileSync(1, JSON.stringify({ decision: 'block', reason }));
  } catch { /* ignore */ }
  process.exit(0);
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { allow(); return; }

  const sessionId = String(input.session_id || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '');
  const stopHookActive = Boolean(input.stop_hook_active);
  const file = criticalHintFile(sessionId);

  let hint;
  try { hint = JSON.parse(readFileSync(file, 'utf-8')); } catch { allow(); return; } // no armed gate
  if (!hint || hint.session_id !== sessionId || !Array.isArray(hint.items) || hint.items.length === 0) { allow(); return; }

  // Safety sweep: drop an abandoned (stale) session's hint instead of gating on it.
  const age = Date.now() - new Date(hint.updated_at || 0).getTime();
  if (!(age >= 0 && age < STALE_MS)) { try { unlinkSync(file); } catch { /* ignore */ } allow(); return; }

  const { block: shouldBlock, blockable } = decideGate(hint.items, stopHookActive);
  const nudgedIds = new Set(blockable.map((it) => it.id));

  if (shouldBlock) {
    for (const it of hint.items) if (nudgedIds.has(it.id)) it.nudged = true;
    hint.updated_at = new Date().toISOString();
    try { writeFileSync(file, JSON.stringify(hint)); } catch { /* ignore — worst case we re-block once */ }
  }

  // Log the full per-item state this Stop (metric collapses to last-per-item).
  const ts = new Date().toISOString();
  logAdherence(hint.items.map((it) => ({
    ts,
    session_id: sessionId,
    project: hint.project || '',
    memory_id: it.id,
    memory_type: it.memory_type || '',
    referents: Array.isArray(it.referents) ? it.referents : [],
    consulted: Boolean(it.consulted),
    nudged: Boolean(it.nudged),
    blocked_this_turn: nudgedIds.has(it.id),
  })));

  if (shouldBlock) { block(composeBlockReason(blockable)); return; }
  allow();
}

// Symlink-safe (T72) — see scripts/hooks/entrypoint.mjs.
const isMain = isEntrypoint(import.meta.url);
if (isMain) main();
