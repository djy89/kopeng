# KOPENG — Codex CLI Setup

Wire KOPENG into OpenAI's Codex CLI as a second client alongside Claude Code. The KOPENG server, REST API, and hook **scripts are shared** — Codex reuses the exact same `scripts/hooks/*` files as Claude Code, selected at the command layer. There is nothing to copy or fork.

Prereqs: KOPENG server running (`curl http://localhost:3200/api/health`), Node 20+ on PATH, Codex CLI installed. See [SETUP.md](../SETUP.md) for the server/service install.

> Replace `<REPO>` below with the absolute path to your clone, e.g. `C:/path/to/kopeng`. **Use forward slashes even on Windows.**

---

## 1. Register the MCP server (`~/.codex/config.toml`)

Gives Codex the `store_memory` / `search_memories` / etc. tools. Codex uses TOML, not JSON.

```toml
[mcp_servers.kopeng]
command = 'C:/Program Files/nodejs/node.exe'
args = ['<REPO>/dist/index.js']

[mcp_servers.kopeng.env]
MEMORY_API_URL = "http://localhost:3200"

# Optional: require approval before each memory tool call. Set to "auto" to
# silence the prompts once you trust the integration.
[mcp_servers.kopeng.tools.search_memories]
approval_mode = "approve"
[mcp_servers.kopeng.tools.store_memory]
approval_mode = "approve"
```

**Windows path rule:** absolute paths in `args` are required (same as Claude Code) — Codex on Windows does not reliably resolve relative paths for stdio MCP transport.

---

## 2. Configure hooks (`~/.codex/hooks.json`)

Codex auto-discovers `~/.codex/hooks.json` at the user layer (project layer: `<repo>/.codex/hooks.json`; both merge). This gives Codex the same automatic recall + observation capture Claude Code gets from `settings.json`.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/memory-session-start.mjs --codex" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/memory-prompt-search.mjs --codex" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/kopeng-observe.js tool_start" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/kopeng-observe.js tool_complete" }] }
    ]
  }
}
```

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `memory-session-start.mjs --codex` | git context + last-session breadcrumb + one project memory |
| `UserPromptSubmit` | `memory-prompt-search.mjs --codex` | per-prompt semantic recall (+ error/sequence hints) |
| `PreToolUse` | `kopeng-observe.js tool_start` | observation capture → auto-discovery |
| `PostToolUse` | `kopeng-observe.js tool_complete` | observation + error-pattern detection |

No hook-level `timeout` is set on purpose: the scripts self-abort their own fetches (3–4s), so a hung server can't stall a turn, and there's no risk of guessing Codex's timeout unit wrong.

### Why `--codex`

Claude Code reads a hook's JSON and takes model-visible context from `hookSpecificOutput.additionalContext`, which is what the recall scripts emit by default. **Codex ignores that JSON entirely** — it injects a hook's **plain-text stdout** as developer context. The `--codex` flag switches the recall scripts to emit raw text. Claude Code's path is untouched (no flag = JSON).

Note that `systemMessage` is user-facing in **both** agents — the model never sees it in either. It carries only the observation-flush health alarm; recall content rides `additionalContext` (Claude Code) or raw stdout (Codex).

The observe hook needs no flag: it's purely side-effecting (writes to a local buffer + POSTs to the server) and emits **empty stdout**, so it never blocks or denies a Codex tool call. It already reads `session_id`/`cwd` from the hook's stdin payload (which Codex provides) and reads tool output from Codex's `tool_response` field.

### Observation API key (REQUIRED when the server sets `OBSERVATION_API_KEY`)

The observe hook authenticates its flush POSTs with the `KOPENG_API_KEY` **process environment variable**. Claude Code sessions inherit it from the `env` block of `~/.claude/settings.json` — **Codex never reads that file**, and `hooks.json` has no env mechanism, so Codex hook processes only see the OS environment. If the server enforces a key and the OS env lacks it, **every Codex flush is rejected 401** and capture buffers locally forever (the recall hook surfaces the persistent `⚠ flush is failing` warning; data is safe — 401s stay in the retryable queue and drain the moment any correctly-keyed session's hooks run — but Codex itself never ingests).

Fix: put the key in the **user-scope OS environment** (then restart Codex — env is snapshotted at process start):

```powershell
# Windows — copy the key straight from Claude Code's settings:
$k = (Get-Content "$env:USERPROFILE\.claude\settings.json" -Raw | ConvertFrom-Json).env.KOPENG_API_KEY
setx KOPENG_API_KEY $k
```

(Unix: `export KOPENG_API_KEY=...` in the shell profile.) `KOPENG_API_URL` only needs the same treatment if the server isn't at the `http://localhost:3200` default.

---

## 3. Trust the hooks (one-time)

On the first Codex run after adding `hooks.json`, Codex shows a **trust prompt for each hook** and records a `trusted_hash` per hook in `config.toml` under `[hooks.state]`. Approve them. Hooks stay skipped until trusted — this is expected, not a failure.

---

## 4. Tell the agent the truth (`~/.codex/AGENTS.md`)

Codex reads `~/.codex/AGENTS.md` (its equivalent of `CLAUDE.md`). Make sure the KOPENG section reflects Codex's actual capabilities — do **not** copy Claude Code's "hooks handle everything" wording verbatim, because Codex lacks `SessionEnd`. Recommended framing:

> Recall hooks are wired (SessionStart + UserPromptSubmit). PreToolUse/PostToolUse capture observations into auto-discovery. Codex has **no SessionEnd**, so no breadcrumb is written from Codex. For explicit lookups, still call `search_memories` directly — the per-prompt hook is recall-on-intent, not a substitute for deliberate search.

---

## 5. Verify

Simulate exactly what Codex pipes to each hook on stdin (run from the repo root):

```bash
# Recall (UserPromptSubmit) — expect PLAIN TEXT memories, no JSON braces
echo '{"hook_event_name":"UserPromptSubmit","prompt":"what did we decide about X","cwd":"<REPO>"}' | node scripts/hooks/memory-prompt-search.mjs --codex

# Session start — expect a plain "=== SESSION CONTEXT ===" block
echo '{"cwd":"<REPO>"}' | node scripts/hooks/memory-session-start.mjs --codex

# Observation (PreToolUse) — expect EMPTY stdout (must never block a tool call)
echo '{"session_id":"s1","cwd":"<REPO>","tool_name":"Bash","tool_input":{"command":"npm run build"}}' | node scripts/hooks/kopeng-observe.js tool_start
```

Then start `codex`, approve the trust prompts, and confirm recall appears in context on your next prompt.

---

## Known limitations (Codex vs Claude Code)

| Gap | Effect | Why |
|-----|--------|-----|
| **No `SessionEnd` event** | Codex never writes the last-session breadcrumb that `SessionStart` reads. SessionStart still shows git context + a project memory; the breadcrumb line appears only if a Claude session wrote it. | Codex's `Stop` event is per-turn, not once at session close. |
| **`apply_patch` edit-conflict not classified** | Codex file edits use `apply_patch` (not Claude's `Edit`/`Write`). Patch failures are still recorded as observations but won't be tagged `error_category: edit_conflict`. | The classifier keys edit-conflict on Claude's exact "old_string not unique" messages. Bash/TS/test/build/runtime/git errors classify fine. |
| **`approval_mode = "approve"`** | Every `search_memories`/`store_memory` call prompts. | Set to `auto` in `config.toml` (§1) once trusted. |

The tool field names map almost 1:1 — Codex uses `tool_name` + `tool_input` like Claude, and `tool_response` for output (the observe hook reads all variants). Tool-name **values** differ: Codex shell is `Bash`, edits are `apply_patch`, MCP calls are `mcp__server__tool`.
