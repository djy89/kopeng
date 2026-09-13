# Hooks: observation, output contract, sequence triggers, gates

> Extracted verbatim from CLAUDE.md (2026-09-07).

### Observation Hook

`scripts/hooks/kopeng-observe.js` — standalone Node.js script for Claude Code hooks. Local-first: appends to JSONL buffer (`~/.kopeng/buffer/observations.jsonl`), batch-flushes to the server. Classifies errors in tool output and sends `event_type: 'tool_failed'` (with 4KB output cap vs 1KB normal).

**T18 flush model (2026-07-03, after the 06-12→07-03 silent flush outage):** the append target stays small; when a flush is due the buffer is atomically **renamed** into a `flush-<stamp>.jsonl` queue file (no lost-append race with concurrent sessions), and pending files drain oldest-first in chunks capped at BOTH ~1.5 MB **and 100 items** (the batch route's Zod cap — byte-only chunking is what wedged the June backlog: the first >100-item chunk 400s forever). Progress **commits after every accepted chunk** (the queue file is rewritten to its unsent tail; server idempotency-key dedup makes re-sends no-ops), and per-invocation work is budgeted (≤3 chunks / ~1.8 s) to fit the 3 s hook timeout — a backlog drains across invocations instead of one invocation attempting everything and dying with zero progress. A buffer past ~4 MB rotates to `overflow-*.jsonl` (never inline-parsed; recovered out-of-band via the transcripts importer / T20 runbook). A chunk the server refuses as **payload-invalid (400/413/422)** is **quarantined** to `poison-*.jsonl` and the drain continues — retrying a payload the server calls bad is pointless, and one poison chunk must never wedge the queue; auth failures (401/403) are deliberately NOT poison — a key misconfig is fixable and its data stays in the retryable queue that auto-drains the moment the key is corrected; 408/429/5xx/network failures likewise stay and retry. Every POST's timeout is clamped to the remaining invocation budget (no overshoot past the 3 s harness kill). Any flush trouble writes `~/.kopeng/hints/flush_error.json`, which `memory-prompt-search.mjs` surfaces as a `systemMessage` warning (the operator-facing channel — correct for a health alarm, unlike recall content, which must ride `additionalContext`; see the Hook Output Contract below) — **even on prompts below the recall length gate** (the alarm is a global health signal) — until the queue **including overflow/poison files** is clear; a silent FLUSH outage is structurally impossible *while the hooks themselves run* — every server-response failure class raises the operator alarm until the queue is clear (Phase 6 honest scope: a hook that never executes — uninstalled, missing node, harness kill before the hint write — and a rotation-rename failure (`maybeRotateForFlush` returns null with no hint) remain the residual silent classes, visible only via the viz "senses" light (T19); and a permanently-5xx-failing chunk head-of-line-blocks the queue, alarm firing every prompt, until the bytes-cap rotation parks it to overflow). Surfacing is unit-tested via the exported `composeFlushWarning` + child-process runs (`tests/unit/recall-hook-alarm.test.ts`). Unit suite: `tests/unit/observe-hook-flush.test.ts` (the hook exports its flush helpers; `main()` runs only when invoked directly).

Install in Claude Code `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "command": "node C:/path/to/kopeng/scripts/hooks/kopeng-observe.js tool_start" }],
    "PostToolUse": [{ "command": "node C:/path/to/kopeng/scripts/hooks/kopeng-observe.js tool_complete" }]
  }
}
```

Env vars: `KOPENG_API_URL`, `KOPENG_API_KEY`, `KOPENG_BUFFER_DIR`.

**Cross-agent (Codex CLI):** the same hook scripts serve Codex via `~/.codex/hooks.json`. The observe hook reads `session_id`/`cwd` and tool output from stdin (incl. Codex's `tool_response` field), not from `CLAUDE_*` env. The recall hooks (`memory-prompt-search.mjs`, `memory-session-start.mjs`) take a `--codex` flag that emits plain-text stdout instead of JSON, because Codex injects stdout as context and ignores JSON entirely. Preserve both behaviors when editing the hooks' output/field-reading logic. Full setup: `docs/codex-setup.md`.


### Hook Output Contract (sweep-3 PB-1)

**`systemMessage` is rendered to the OPERATOR and never reaches the model.** Model-visible context must ship as `hookSpecificOutput.additionalContext` (or as plain stdout — Claude Code adds stdout to context for `UserPromptSubmit`/`SessionStart` only). Both context hooks emitted *only* `systemMessage` until 2026-07-27, so every recalled memory landed in the transcript and none in Claude's context — a total failure of the core loop with **no symptom**, since the JSON on stdout still looked right and SETUP's own verification step checked for exactly that shape.

The two channels have different audiences and must not be merged:

| Payload | Channel | Audience |
|---|---|---|
| recalled memories, error/sequence hints, `/api/surface` tools+skills+conventions | `hookSpecificOutput.additionalContext` (`hookEventName` must match the event) | the model |
| T18 capture-outage alarm | `systemMessage` | the operator |
| everything, concatenated | raw stdout (`--codex`) | Codex, which has one channel |

`emit()` in each hook takes `{context, warning}` and routes them; the complete stdout shape of both hooks is pinned by `tests/unit/hook-output-contract.test.ts` (stub HTTP server + real child-process runs). **When adding a hook or changing an emit path, assert the shape in that suite** — this class of bug is invisible in manual testing.


### In-Session Sequence Triggers

The observation hook proactively surfaces workflow recommendations when the operator completes a tool that matches the "A" side of a known A→B sequence pattern.

**Cache layer** (`~/.kopeng/cache/sequences_{project}.json`): File-based cache of sequence discoveries per project. Populated via `GET /api/memories?type=discovery&tags=sequence&scope={project}`. TTL: 10 minutes with stale-while-revalidate at 80%. Cold start populates cache for next invocation (no match on first call).

**Sequence key normalization**: `getSequenceKey()` in the observation hook (ported from `src/discovery/heuristics.ts:475-513`). Canonicalizes tool invocations to matchable keys: `Read(file.ts)`, `Bash(npm)`, `Grep("pattern")`, etc.

**Hint file** (`~/.kopeng/hints/sequence_hint.json`): Written when a cache hit occurs. Contains `current_tool_key`, `next_steps[]`, `project`, `timestamp`. Read-once by the recall hook (`memory-prompt-search.sh`) — validated for project scope match and <5 min age, then surfaced as a workflow recommendation in the injected context block. Can coexist with error hints; both compose into the output.


### Canonical-Path Gate

Enforces a behavioral rule in hooks rather than relying on the model to honor it: when recall surfaces a canonical source-of-truth path for the entity the operator just asked about, that path must be `Read` *before* any web search — no WebSearch-the-name, no asking the operator to disambiguate what the memory already disambiguated. (Origin: a session where the surfaced `personal-design-system` path was web-searched and second-guessed instead of read.)

Three pieces, all **fail-open** (any parse/IO error allows the tool — the gate can fail to "search not blocked", never to "tools wedged"):

- **Arm** — `memory-prompt-search.mjs` writes `~/.kopeng/hints/canonical_path.json` (`{paths[], entity, project, timestamp}`) when one of the **top-2** recall results carries source-of-truth phrasing (`ALWAYS refers to` / `canonical` / `authoritative`, `SOT_RE`) AND an absolute path (`ABS_PATH_RE`). Top-2 only, so an incidental path mention doesn't arm it.
- **Block** — `scripts/hooks/canonical-path-guard.mjs`, a PreToolUse hook on `WebSearch|WebFetch` (wired in `~/.claude/settings.json`, global), returns `permissionDecision: deny` naming the path while the hint is fresh (<5 min). Only these two rare tools are matched, so it never touches the hot path.
- **Unlock (read-to-unlock)** — folded into `kopeng-observe.js` (already runs on every PreToolUse, so no new spawn): `clearCanonicalHintIfTouched()` deletes the hint the moment a `Read`/`Glob`/`Grep`/`Bash` input references the gated path (substring match on the unscrubbed input, so reading a file *inside* a hinted directory counts). Project-scoped; the hint also self-expires at 5 min.
- **Fallback (T32, mid-turn injection)** — the recall hook is `UserPromptSubmit`-only, so a message injected mid-turn never arms the hint. The guard therefore keeps a second trigger: `memory-prompt-search.mjs` maintains `~/.kopeng/cache/canonical_triggers_{project}.json` (sequence-cache pattern: 10-min TTL, SWR at 80%, refresh rides the recall `Promise.all` under the 2s surface leash) from memories carrying `metadata.trigger_terms` + SOT phrasing + an absolute path (shared machinery in `scripts/hooks/canonical-triggers.mjs`, now the single source of `SOT_RE`/`ABS_PATH_RE`/`sotNearPath`). With no hint armed, a WebSearch/WebFetch whose input word-boundary-matches a trigger term is denied off the cache alone (no network on the hot path): the guard SELF-ARMS the standard hint (`source:'trigger_fallback'`) so read-to-unlock + 5-min expiry govern the window unchanged, and `~/.kopeng/hints/canonical_fallback_state.json` bounds it to one deny-window per (session, memory) per 30 min so term-bearing-but-unrelated searches are never blocked forever. Entries whose SOT phrasing points at the path also arm the T29 per-session critical file on deny. Fail-open throughout.

Known tradeoff: while armed, an *unrelated* web search in the same project is also blocked for the window — escape is the intended action (touch the path) or expiry. Acceptable because "canonical phrasing + absolute path" in a top-2 result is rare.


### Turn Gate + Adherence (T29)

Attacks the field's one *measured* bottleneck — **adherence, not retrieval** (~65% ignore rate; forcing consultation took a practitioner's runs 7/20 → 20/20). KOPENG pushed memory per-prompt but never verified it was ACTED ON. A **Stop-hook turn gate** holds the turn open until every memory the recall hook flagged CRITICAL was demonstrably consulted. **Critical = tagged `critical` (path anywhere) OR canonical source-of-truth SOT phrasing within ~100 chars of a path** — v1 hard-blocks only path-anchored memories, so "consulted" is a deterministic touch signal. The proximity check (`sotNearPath`) + a top-2-recall-results relevance gate keep false-blocks near zero: an incidental "canonical" adjective far from any path, or a weakly-relevant tail result, no longer gates (id-420 fix, 2026-07-08). Design + rubric live in the maintainer notes (not shipped).

Three pieces mirror the canonical-path gate's arm→touch→check (all **fail-open** — any parse/IO error, missing hint, or wrong session exits 0 = allow the stop):

- **Arm** — `memory-prompt-search.mjs` writes `~/.kopeng/hints/critical_<session>.json` (`extractCriticalItems` over the top-2 recall results, exported/tested) with each critical memory's absolute-path referents. **Per-session file** (not one global file) so parallel sessions/subagents never clobber each other's gate state (pinned by `tests/unit/turn-gate.test.ts`, wrong-session isolation). Since T32, a canonical trigger-term fallback deny (see Canonical-Path Gate) also arms the per-session critical file for path-anchored canonical entries — mid-turn injected messages get turn-gate coverage through the guard even though recall never ran.
- **Touch** — `kopeng-observe.js` `markCriticalConsultedIfTouched()` (beside `clearCanonicalHintIfTouched`, no new spawn) flips an item `consulted:true` the moment a `Read`/`Glob`/`Grep`/`Bash` input references any referent (same substring machinery as the canonical unlock).
- **Check** — `scripts/hooks/turn-gate.mjs` (Stop hook, wired in `~/.claude/settings.json`): if any critical is still `!consulted && !nudged` → `{decision:'block', reason}` naming the ignored memories. **Loop-safe by a durable per-item `nudged` flag (block AT MOST ONCE per memory)** — the undocumented `stop_hook_active` is honored only as a backstop, never relied upon.

**Metric:** every Stop appends one adherence record per critical item to `~/.kopeng/metrics/adherence.jsonl`; `npm run metric:adherence` collapses to the final per-item outcome — `voluntary` (consulted, no block) / **`forced-inline`** (blocked → consulted; the gate's win) / `ignored` (nudged, still ignored) / `open`. This is a **near-ground-truth** signal (the memory's path referent was touched by a real tool call), the honest upgrade over C1's acceptance≠relevance metric. The `/api/memories/recall` response gained an additive `tags` field so the hook detects the `critical` tag without a round-trip (needs the rebuilt server deployed; canonical-SOT criticals arm content-only, no server dep).

**GATE T29 (operator):** run a few sessions, read `npm run metric:adherence`, confirm the block fires when a critical path is ignored and clears on touch, false-block rate ≈ 0, adherence trends up.


