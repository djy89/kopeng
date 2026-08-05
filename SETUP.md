# KOPENG — Claude Code Setup (Bootstrap)

Get KOPENG running on a fresh device and wired to Claude Code. For full architecture, REST API, and eval harness see [README.md](./README.md).

> **Platform note:** this walkthrough was written from a Windows production deployment, but KOPENG is plain Node — everything except the OS-specific sections (§3 NSSM, §6 firewall, §6b winnat) is identical on Linux/macOS. Linux users: install/build in §1 (use bash instead of PowerShell), then jump to [§3b systemd](#3b-linux-systemd-service); §6b does not apply to you.

---

## Prerequisites

- Node.js 20+
- A service manager — [NSSM](https://nssm.cc/) on Windows, systemd on Linux (built in)
- Claude Code installed
- A CLAUDE.md section teaching Claude to use KOPENG (see [§5 below](#5-teach-claude-how-to-use-kopeng))

---

## 1. Install & Build

```powershell
cd C:\path\to\kopeng
npm install
npm run build
```

---

## 2. Configure

Create `.env` in repo root:

```
PORT=3200
HOST=127.0.0.1
DATABASE_PATH=./data/memory.db
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
LOG_LEVEL=info
MEMORY_API_URL=http://localhost:3200

# Passive learning (the observation hooks in §4 are inert without these):
OBSERVATION_INGESTION_ENABLED=true     # accept + store tool-use observations
DISCOVERY_DETECTION_ENABLED=true       # turn stored observations into discovered memories
```

**Optional — observation write auth.** If other machines can reach the server, generate a shared secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The same value goes in two places under two names:
- Server side: `OBSERVATION_API_KEY=<value>` in this repo's `.env` — the server then requires `X-API-Key` on the observation write endpoints.
- Client side: `KOPENG_API_KEY=<value>` in the `env` block of `~/.claude/settings.json` (step 4b) — the hooks send it as `X-API-Key`.

> **Naming note:** everything here uses the `kopeng` names — `KOPENG_*` env vars, the `kopeng-observe.js` hook script, the `~/.kopeng/` client-side data directory.

If you skip this, observation writes are open — acceptable only when the server is loopback-only (the default `HOST=127.0.0.1`).

**Optional — admin endpoint auth.** Every **operator-mutating** endpoint honors a **separate** admin key: memory create/update/archive and batch, slots, Redis context, MinIO artifacts, graph writes, operator-config PATCH, dream trigger/resolve, memory rollback, and admin promote/reindex/backup/discover/discovery-maintain. The observation **ingestion** writes (`POST /api/observations`, `/batch`, completion PATCH) are protected by `OBSERVATION_API_KEY` above, not by the admin key — set **both** before widening the bind address.

- Server side: `ADMIN_API_KEY=<value>` in this repo's `.env`. When set, those endpoints require `X-API-Key: <value>`. Reads stay public — including the POST-shaped ones (`/api/memories/recall`, `/search`, `/surface`, `/traverse`) that the recall hooks call on every prompt. Unset = open (dev mode). Keep it distinct from `OBSERVATION_API_KEY` — that key is distributed to hook clients on other machines and must not carry admin power.
- Client side: the MCP server and the repo's ops scripts read `ADMIN_API_KEY` from this repo's `.env` (or the environment) and send it themselves, so the MCP write tools (`store_memory`, `update_memory`, `archive_memory`, `set_context`, `store_artifact`, `trigger_discovery`) need no per-client plumbing. The viz proxy injects it server-side, so the browser never holds it.

**Remote access.** `HOST=127.0.0.1` (default) binds loopback only. To reach the server from other machines — e.g. over a private VPN — set `HOST=0.0.0.0` and set **both** keys above first.

> Setting the keys is necessary but **not sufficient**. Every gate is optional and defaults to open, ops/read endpoints are public by design, and the scrubber is defense-in-depth rather than a boundary. Treat a non-loopback bind as requiring an outer boundary — a VPN or an authenticating reverse proxy. See [SECURITY.md](SECURITY.md) for the full threat model.

---

## 3. Install Windows Service (NSSM)

```powershell
nssm install kopeng "C:\Program Files\nodejs\node.exe" "C:\path\to\kopeng\dist\server.js"
nssm set kopeng AppDirectory "C:\path\to\kopeng"
nssm set kopeng AppEnvironmentExtra "PORT=3200" "NODE_ENV=production"
nssm set kopeng AppStdout "C:\path\to\kopeng\logs\service.log"
nssm set kopeng AppStderr "C:\path\to\kopeng\logs\error.log"
nssm set kopeng AppRotateFiles 1
nssm set kopeng AppRotateBytes 10485760
nssm start kopeng
```

Verify: `curl http://localhost:3200/api/health`

---

## 3b. Linux: systemd service

```ini
# /etc/systemd/system/kopeng.service
[Unit]
Description=KOPENG memory server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/kopeng
ExecStart=/usr/bin/node /opt/kopeng/dist/server.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Adjust `User`, `WorkingDirectory`, and the repo path. Set `WorkingDirectory` to the repo root: the app finds `.env` next to its install automatically (resolved from the built file's location), but relative path *values* inside `.env` (`./data/memory.db`, `./models`) resolve against the working directory. If you use nvm/fnm, replace `/usr/bin/node` with the absolute path from `which node` — systemd does not read your shell profile.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kopeng
systemctl status kopeng                 # up?
journalctl -u kopeng -f                 # live logs
curl http://localhost:3200/api/health   # ready?
```

No root / prefer user-level? `systemctl --user` with the same unit in `~/.config/systemd/user/` (add `loginctl enable-linger youruser` so it survives logout), or just `pm2 start dist/server.js --name kopeng`.

---

## 4. Wire to Claude Code

### 4a. Register MCP server in `~/.claude.json`

Add to `mcpServers`:

```json
"kopeng": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/path/to/kopeng/dist/index.js"],
  "env": {
    "MEMORY_API_URL": "http://localhost:3200"
  }
}
```

**Path rule:** absolute paths in `args` are required — Claude Code does not reliably resolve relative paths for stdio MCP transport (on any OS; Windows is just where it bites hardest). Linux/macOS example: `"args": ["/opt/kopeng/dist/index.js"]`.

### 4b. Add env vars to `~/.claude/settings.json`

The top-level `env` block in `settings.json` is read by Claude Code and propagated to MCP servers and hooks:

```json
"env": {
  "KOPENG_API_URL": "http://localhost:3200",
  "KOPENG_API_KEY": "<your-generated-key>"
}
```

### 4c. Configure hooks in `~/.claude/settings.json`

All KOPENG hooks are **Node scripts that live in this repo** (`scripts/hooks/`), referenced by **absolute path**. There is nothing to copy into `~/.claude/` and nothing that can drift out of sync.

Replace `<REPO>` below with the absolute path to your clone — e.g. `C:/path/to/kopeng` (Windows — **use forward slashes**) or `/opt/kopeng` (Linux/macOS). If your clone path contains a space, wrap the script argument in escaped quotes inside the JSON, e.g. `"command": "node \"<REPO>/scripts/hooks/kopeng-observe.js\" tool_start"`.

```json
"hooks": {
  "SessionStart": [{
    "matcher": "startup|resume",
    "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/memory-session-start.mjs", "timeout": 8 }]
  }],
  "UserPromptSubmit": [{
    "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/memory-prompt-search.mjs", "timeout": 5 }]
  }],
  "PreToolUse": [{
    "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/kopeng-observe.js tool_start", "timeout": 3 }]
  }],
  "PostToolUse": [{
    "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/kopeng-observe.js tool_complete", "timeout": 3 }]
  }],
  "SessionEnd": [{
    "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/memory-session-end.mjs", "timeout": 10 }]
  }]
}
```

What each hook does:

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `memory-session-start.mjs` | Injects git context + last-session breadcrumb + one project-scoped memory at session start |
| `UserPromptSubmit` | `memory-prompt-search.mjs` | Recalls relevant memories for each prompt (fast semantic recall) |
| `PreToolUse` / `PostToolUse` | `kopeng-observe.js` | Captures tool-use observations for the auto-discovery pipeline |
| `SessionEnd` | `memory-session-end.mjs` | Writes the breadcrumb that the next `SessionStart` reads |

**How context reaches Claude:** the two context hooks return `hookSpecificOutput.additionalContext`, which Claude Code injects into the model's context. They do *not* use `systemMessage` — that field is rendered to you and never reaches the model, so memory shipped in it would look correct on stdout while Claude saw nothing. If you write your own hooks against this repo, keep that distinction (`tests/unit/hook-output-contract.test.ts` pins it).

### 4c-extra. Optional enforcement hooks (advanced)

Two further hooks enforce behavioral guarantees KOPENG can surface but not otherwise compel. They are **optional** — the baseline above works without them — and are wired the same way (absolute paths, same `<REPO>` substitution):

- **`canonical-path-guard.mjs`** (PreToolUse on `WebSearch|WebFetch`): when recall has surfaced a canonical source-of-truth path for what you just asked about, this blocks a web search until you've read that path. Fail-open.
- **`turn-gate.mjs`** (Stop): holds the turn open until every memory recall flagged CRITICAL was demonstrably consulted. Fail-open; blocks at most once per memory.

```json
"PreToolUse": [{
  "matcher": "WebSearch|WebFetch",
  "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/canonical-path-guard.mjs", "timeout": 5 }]
}],
"Stop": [{
  "hooks": [{ "type": "command", "command": "node <REPO>/scripts/hooks/turn-gate.mjs", "timeout": 10 }]
}]
```

Merge these into the same `hooks` object as §4c — the `PreToolUse` array gains a second entry (one matcher-less for observations, one matched to `WebSearch|WebFetch`).

### 4d. No copy step — and why the hooks are Node, not bash

Nothing to copy: every hook runs straight from `scripts/hooks/` in the repo. Just point the absolute paths in `settings.json` at your clone.

**Requirement:** Node 18+ (for the built-in global `fetch`). The repo already targets Node 20+ (see [Prerequisites](#prerequisites)), so this is satisfied.

**Why Node and not bash:** the recall hooks were originally bash scripts that shelled out to `jq` and `curl`. On 2026-06-02 `jq` vanished from the PATH and every recall hook silently bailed at its first line — memory recall went **completely OFF with no error**, while writes kept working (so nothing looked broken). The Node rewrite removes all external CLI dependencies: JSON via `JSON.parse`/`JSON.stringify`, HTTP via global `fetch`, git via `child_process` (its absence only drops git context, never disables a hook). Node is the same runtime that already runs the server and the observe hook — there is nothing ambient left to go missing.

### 4e. Verify the hooks work

From the repo root, simulate what Claude Code pipes to each hook on stdin:

```bash
# Recall hook — expect {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
#   "additionalContext":"Relevant memories:..."}}   (or {} if the store is empty)
echo '{"user_prompt":"what have I been working on in this project","cwd":"<REPO>"}' | node scripts/hooks/memory-prompt-search.mjs

# Session-start hook — expect git context inside hookSpecificOutput.additionalContext
echo '{"cwd":"<REPO>"}' | node scripts/hooks/memory-session-start.mjs
```

If a recall hook prints `{}` when you expect results, the fault is almost always client-side, not the server. Confirm the API itself returns memories:

```bash
curl -s -X POST http://localhost:3200/api/memories/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"test","scopes":["global"],"limit":3}'
```

If that returns memories but the hook still prints `{}`, check that `node` is on the PATH Claude Code uses for hooks and that the `<REPO>` path in `settings.json` is correct.

---

## 4f. Second client: Codex CLI

KOPENG also wires into OpenAI's Codex CLI, reusing the same `scripts/hooks/*` files (selected via a `--codex` flag at the command layer). MCP registration uses `~/.codex/config.toml`; hooks use an auto-discovered `~/.codex/hooks.json`. Full walkthrough — MCP block, hooks.json, the `--codex` rationale, trust step, and limitations (no `SessionEnd`) — in [docs/codex-setup.md](./docs/codex-setup.md).

---

## 5. Teach Claude How to Use KOPENG

The hooks handle automatic recall/capture, but Claude uses the MCP tools *well* only if your global `~/.claude/CLAUDE.md` tells it how. Without this, KOPENG still works — Claude just won't scope, dedup, or tag memories consistently. Paste (and adapt) this section:

```markdown
## Memory System (KOPENG)

MCP memory tools (`mcp__kopeng__*`) backed by a local KOPENG server; hooks handle automatic recall.

- **Scopes:** `global` | `project:<basename-of-repo-root>` | `client:<name>` — scope tightly; default to the project scope.
- **Types:** `user` (who I am, preferences) | `feedback` (corrections — always include the why) | `project` (ongoing work, decisions) | `reference` (pointers to docs/URLs/paths).
- **Search:** default `hybrid` mode; `rerank: true` when comparing 3+ results; scope filters over broad queries.
- **Before storing:** `search_memories` for duplicates → prefer `update_memory` over creating a near-duplicate. On conflict, prefer the recent fact and archive the stale one.
- **Tags:** lowercase-hyphenated, 2–4 per memory, domain + action (e.g. `deploy`, `testing-workflow`).
```

---

## 6. Firewall (VPN Cross-Device Access)

Only needed if other devices reach this KOPENG over a VPN (WireGuard, Tailscale, …).

Windows (run as admin):

```powershell
New-NetFirewallRule -DisplayName "KOPENG API" `
  -Direction Inbound -Protocol TCP -LocalPort 3200 `
  -InterfaceAlias "<your VPN interface>" `
  -Action Allow -Profile Any
```

Linux (ufw shown; scope to the VPN interface or subnet, don't open it wide):

```bash
sudo ufw allow in on wg0 to any port 3200 proto tcp
```

---

## 6b. Reserve Docker Ports from WinNAT (Windows — required if you run any Docker-backed optional service)

On every reboot, Windows' NAT driver (winnat, used by Hyper-V/WSL2) reserves a fresh set of *random* port ranges. If a range lands on a port one of the KOPENG Docker containers publishes, that container comes up "healthy" but its host port silently never binds — the service degrades with no error anywhere except an `ECONNREFUSED` in KOPENG's own logs. This is not theoretical: a reboot can land a reserved range on 6379 and silently kill the Redis cache layer. If it lands on the Postgres port, **KOPENG is fully down** (the server now waits in a connection-retry loop until the port is freed, but it will wait forever).

Fix: permanently reserve every published port as an "administered exclusion" so winnat can never grab it. One-time, survives reboots. Run as admin (reservations can only be added while winnat is stopped):

```powershell
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=5432 numberofports=1   # Postgres (POSTGRES_HOST_PORT)
netsh int ipv4 add excludedportrange protocol=tcp startport=6379 numberofports=1   # Redis
netsh int ipv4 add excludedportrange protocol=tcp startport=7474 numberofports=1   # Neo4j browser
netsh int ipv4 add excludedportrange protocol=tcp startport=7687 numberofports=1   # Neo4j bolt
netsh int ipv4 add excludedportrange protocol=tcp startport=9000 numberofports=2   # MinIO API + console (9000-9001)
net start winnat
```

Adjust the Postgres line if `POSTGRES_HOST_PORT` differs (default 5432, matching `.env.example` and the Compose file). Reserve the ports for the services you run; reserving the full set costs nothing and saves the port if a service is added later. SQLite-only installs with no Docker services can skip this section entirely.

**Ordering matters:** run this BEFORE starting the Docker containers. A reservation fails with `The process cannot access the file because it is being used by another process` if anything is currently bound to the port — on an already-running install, `docker stop` the containers first, add the reservations, then `docker start` them and restart the kopeng service.

**Verify** (the new reservations show with a `*` = administered):

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

**Diagnosing a hit after the fact:** container shows `Up` in `docker ps` but the `Ports` column lacks the `127.0.0.1:<port>->` mapping, `docker port <name>` prints nothing, and recreating it fails with `bind: An attempt was made to access a socket in a way forbidden by its access permissions`. That error means winnat owns the port — apply the block above.

---

## 7. Optional Services

KOPENG supports three optional services, each behind a feature flag in `.env`. All degrade gracefully — the core memory system works without them.

| Service | Flag | What it adds | Standup doc |
|---------|------|--------------|-------------|
| Neo4j | `NEO4J_ENABLED=true` | Entity graph, `traverse_memory` tool | `docs/neo4j-standup-steps.md` |
| MinIO | `MINIO_ENABLED=true` | Artifact storage, `store_artifact`/`get_artifact` tools | `docs/minio-standup-steps.md` |
| Redis | `REDIS_ENABLED=true` | Ephemeral context store, `set_context`/`get_context` tools | `docs/redis-standup-steps.md` |

Each standup doc contains the full operator sequence: generate credentials, update `.env`, start the Docker container, create any required resources, restart KOPENG, and verify.

Docker Compose files for each service are in the repo root (`docker-compose.neo4j.yml`, `docker-compose.minio.yml`, `docker-compose.redis.yml`, `docker-compose.postgres.yml`). All bind to `127.0.0.1` on the host — not exposed over the network.

### PostgreSQL (alternative backend, not an add-on layer)

Postgres replaces SQLite rather than adding a layer, so it has no `*_ENABLED` flag and no standup doc — it's selected with `DATABASE_TYPE=postgres`. Compose reads two variables that the other services don't:

```bash
# .env
DATABASE_TYPE=postgres
POSTGRES_PASSWORD=<choose one>            # REQUIRED — Compose fails fast if unset (the container will not initialize without it)
POSTGRES_HOST_PORT=5432                   # optional; host side only, override if 5432 is taken by a native install
POSTGRES_URL=postgresql://kopeng:<same password>@localhost:5432/kopeng
```

```bash
docker compose -f docker-compose.postgres.yml up -d
npm start                                  # migrations run on boot
curl http://localhost:3200/api/stats       # confirm it came up on the new backend
```

The container, database, user, and volume are named `kopeng*`. To migrate an existing SQLite corpus across, see `npm run migrate:postgres`.

---

## 8. Staple Memories

**Staple memories** are identity-level facts (design systems, infrastructure names, named projects) that must never be missed by the recall hook regardless of how long or off-topic the surrounding prompt is.

### Why they exist

The `UserPromptSubmit` recall hook embeds the whole prompt (up to 200 chars) and runs pure cosine similarity. A rare proper noun embedded in a long prompt — e.g. *"a quick web gui based on acme UI … vst workflows …"* (where "acme" is your in-house design system) — gets diluted by the surrounding context. The semantic score for the "acme design system" memories can drop below the 0.40 threshold even though "acme" appears literally in the query.

Fixes shipped (2026-06-10, routes.ts):
1. **Hybrid-lite recall**: the recall endpoint now runs FTS in parallel with semantic search and uses RRF to merge the results. A keyword match on "acme" in the memory content lifts those memories above the threshold even when the semantic score is diluted.
2. **Staple injection**: memories tagged `staple` whose `metadata.trigger_terms` match a whole-word token in the query are force-injected at score 0.99, bypassing the semantic threshold entirely.

### Marking a memory as a staple

Two steps via MCP `update_memory`:

1. Add the `staple` tag to the memory's tag list.
2. Add `trigger_terms` to its metadata — an array of lowercase strings that, if found as whole words in a prompt, trigger injection.

```
update_memory(id=XXXX, tags=[...existing..., "staple"], metadata={"trigger_terms": ["acme", "use acme"]})
```

**Trigger term design:** be specific enough to avoid noise. For identity disambiguation (design system name, infra nickname, project shorthand) use the exact token(s) an operator would naturally type. Multiple trigger_terms OR together — any match fires.

### Example staples

| Name | trigger_terms |
|------|---------------|
| Design-system disambiguation ("acme" the DS vs anything else named acme) | `["acme"]` |
| Design-system overview & token reference | `["acme"]` |
| Design-system adoption guide | `["use acme", "adopt acme", "apply acme", "acme setup", "set up acme"]` |
| Query KOPENG before guessing proper nouns (lesson) | `["kopeng", "query memories", "search memories"]` |

### Decay / archival protection

Staples must be stored with **`confidence: 1.0` passed explicitly** (the server default for an omitted confidence is `0.9`, which is decay-eligible). `1.0` is the Hard Anchor: the decay pipeline, the dream auto-apply path, and the promotion pipeline all skip memories with `confidence >= 1.0` or `is_locked = 1`.

```
store_memory(content="...", confidence=1.0, metadata={"trigger_terms": [...]})
```

To promote an existing memory (imported, migrated, or stored without the override) to a Hard Anchor, use the REST update path with the admin key:

```bash
curl -X PUT http://localhost:3200/api/memories/<id> -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_API_KEY" -d '{"confidence": 1.0}'
```

(The MCP `update_memory` tool edits content/metadata only — it does not change confidence.)

### Verification after adding a staple

Run a diluted prompt containing the trigger term through the recall hook and check the output:
```bash
echo '{"user_prompt":"web gui based on acme UI for the vst project","cwd":"'$PWD'"}' \
  | node scripts/hooks/memory-prompt-search.mjs
```
The response's `hookSpecificOutput.additionalContext` should contain entries for the staple.
(`systemMessage`, if present, carries only operator health alarms — the model never sees it.)

Or via REST (after restart):
```bash
curl -s -X POST http://localhost:3200/api/memories/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"web gui based on acme UI for the vst project","scopes":["project:<your-project>","global"],"threshold":0.40,"limit":3}'
```
The staple memory must appear with `score: 0.99`.

---

## Verification

```bash
curl http://localhost:3200/api/health        # service up
curl http://localhost:3200/api/stats         # DB initialized
```

In Claude Code: confirm `mcp__kopeng__*` tools appear in the toolset and recall fires on session start (visible in conversation context).

---

## Troubleshooting

First stop: `curl http://localhost:3200/api/health` — it reports embedding-index status alongside liveness, which splits every problem into "server" vs "client" in one call.

**First boot is slow / needs network.** On first run the server downloads the embedding model (~30 MB) into `models/`, and the first *search* additionally lazy-loads the reranker (~1s one-time). Both are cached forever after. Air-gapped install: copy a populated `models/` directory from another machine — same layout, no code change. `data/` and `logs/` are auto-created; there is no seed step.

**`better-sqlite3` fails to load (`NODE_MODULE_VERSION` mismatch / "was compiled against a different Node.js version").** The native module was built for a different Node than the one running. Rebuild against the active Node: `npm rebuild better-sqlite3` (or delete `node_modules` and `npm ci`). This bites most often when a service manager (NSSM, systemd) runs a different Node than your shell — point the service at the same `node` binary you built with. On Linux, if npm falls back to compiling from source (no prebuilt binary for your Node/arch), install the toolchain first: `sudo apt install build-essential python3` (or distro equivalent).

**`EADDRINUSE` on start.** Something already owns port 3200 — set `PORT` in `.env` (and update `MEMORY_API_URL` everywhere clients reference it: MCP registration, hook env).

**MCP tools don't appear in Claude Code.** Almost always the stdio registration path: `args` must be an **absolute path** to `dist/index.js` (forward slashes on Windows), and `dist/` must exist (`npm run build`). Restart Claude Code after editing `~/.claude.json`. Test the server directly: `curl http://localhost:3200/api/health` — the MCP process is a thin client; if the REST API is down, every tool call fails.

**Hooks are silent (no recall, no observations).** Work through [§4e](#4e-verify-the-hooks-work): pipe a fake prompt into the hook script directly. If the script works standalone but not in Claude Code, check that `node` is on the PATH Claude Code spawns hooks with and that the `<REPO>` absolute paths in `settings.json` are correct. Hooks are deliberately fail-open — they exit 0 and print nothing rather than break your session, so a misconfigured path *looks* like silence, not an error.

**Observation POSTs return 401/403.** `OBSERVATION_API_KEY` (server `.env`) and `KOPENG_API_KEY` (hook env in `~/.claude/settings.json`) must hold the same value — see §2. The hook buffers failed batches locally and retries, so nothing is lost while you fix the key.

**Remote clients get `429 Too Many Requests`.** Loopback is exempt from rate limiting; remote IPs get `RATE_LIMIT_MAX` per minute (default 100). Raise it in `.env` or run latency-sensitive clients on the server box.

**Docker optional services "up" but unreachable (Windows).** If a container shows `Up` but its port never binds (`docker port <name>` prints nothing, recreate fails with "socket access forbidden"), Windows' NAT driver reserved the port — see [§6b](#6b-reserve-docker-ports-from-winnat-windows--required).

**Search returns nothing on a fresh install.** Not a bug — the store is empty until the hooks capture something (requires `OBSERVATION_INGESTION_ENABLED=true` + `DISCOVERY_DETECTION_ENABLED=true` in the server `.env`, see §2) or you store a memory. Quick self-test:

```bash
curl -s -X POST http://localhost:3200/api/memories -H "Content-Type: application/json" \
  -d '{"content":"hello kopeng","type":"reference","scope":"global"}'
curl -s -X POST http://localhost:3200/api/memories/search -H "Content-Type: application/json" \
  -d '{"query":"hello"}'
```
