# KOPENG — Claude Code Setup (Bootstrap)

Get KOPENG running on a fresh device and wired to Claude Code. For full architecture, REST API, and eval harness see [README.md](./README.md).

> **Platform note:** this walkthrough was written from a Windows production deployment, but KOPENG is plain Node — everything except the OS-specific sections (§3 NSSM, §6 firewall, §6b winnat) is identical on Linux/macOS. Linux users: install/build in §1 (use bash instead of PowerShell), then jump to [§3b systemd](#3b-linux-systemd-service); §6b does not apply to you.

---

## Prerequisites

- Node.js 20+. **On Windows prefer Node 20 or 22 LTS:** on Node 24 the recall hook is killed by an
  upstream Node bug ([nodejs/node#58091](https://github.com/nodejs/node/issues/58091)) — a libuv assertion
  when a script calls `process.exit()` after `fetch()` — so hooks fail silently (they are fail-open, so you
  get no recall rather than an error). Installing and building are fine on Node 24; it is only the hooks.
  Tracked as backlog T52.
- **Windows only:** the [Microsoft Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe). The
  embedding runtime (`onnxruntime-node`) is a native module that will not load without it. A fresh Windows
  image often does not have it; see the `ERR_DLOPEN_FAILED` entry under [Troubleshooting](#troubleshooting)
  for what that looks like.
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

## 2. Configure & First Run

The fresh path is: clone → `npm install` → `npm run build` (§1) → optionally
set `PRIMARY_SCOPE` → start → `npm run canary`. Continuing from §1, you may
first create a plain UTF-8 `.env` in the repo root containing the one
recommended day-one value: `PRIMARY_SCOPE=project:my-project`.

**Terminal 1 — start the server and leave this terminal running:**

```bash
npm start          # or install as a service first (§3 / §3b)
```

**Terminal 2 — open a second terminal in the same repo directory:**

```bash
npm run canary     # first-run proof: store → embed → semantic recall
```

There is no required `.env` editing step: the server boots with working defaults
(loopback bind, SQLite at `./data/memory.db`), and `npm run canary` (see
[Verification](#verification)) tells you in plain language whether the install works.
The full variable reference is `.env.example` — its quick-start half is the part
that matters; its advanced half is not part of the preview path.

**Admin key — auto-generated, don't set it by hand.** On first run the server
generates `ADMIN_API_KEY` and writes it into this repo's `.env` (a log line
announces the generation; the key value itself is not printed to the log). If
`.env` isn't writable, the server
refuses to boot with instructions rather than running keyless. Precedence: a
non-empty launch-environment value wins, else a non-empty `.env` value, else
one is generated. The key gates every **operator-mutating** endpoint: memory
create/update/archive and batch, slots, Redis context, MinIO artifacts, graph
writes, operator-config PATCH, dream trigger/resolve, memory rollback, and
admin promote/reindex/backup/discover/discovery-maintain. Reads stay public —
including the POST-shaped ones (`/api/memories/recall`, `/search`, `/surface`,
`/traverse`) that the recall hooks call on every prompt.

Clients need no per-client plumbing: the MCP server and the repo's ops scripts
read `ADMIN_API_KEY` from this repo's `.env` (or the environment) and send it
themselves, so the MCP write tools (`store_memory`, `update_memory`,
`archive_memory`, `set_context`, `store_artifact`, `trigger_discovery`) just
work. The viz proxy injects it server-side, so the browser never holds it.

**`PRIMARY_SCOPE`** names your primary working scope (`project:<name>` or `client:<name>`). A write
that arrives with no scope — and any write whose scope string is malformed — lands there instead of
silently defaulting to `global` (global only ever holds what you *explicitly* put in it). Leave it
unset and those writes land in the reserved triage scope `project:_unrouted` instead — never lost,
never `global`, visible via `GET /api/ops/scope-registry`, and routable later by operator ruling.
Either way the write response's `meta` announces the routing, and a malformed scope's raw string is
preserved in `metadata.raw_scope`. Hot-editable later without a restart via the
`operator_config.primary_scope` column (`PATCH /api/operator-config {"primary_scope": ...}`, `null`
clears), which takes precedence over the env value.

### Advanced: passive learning

When you reach §4, `npm run wire` asks how much KOPENG should enable and shows
the matching `.env` changes in its dry-run report:

| Profile | Day-one behavior |
|---------|------------------|
| `minimal` | Adds no learning flags; fresh installs use manual memory only. |
| `recommended` | Adds observation ingestion and discovery detection; it does not add dreaming. |
| `everything` | Adds passive learning plus the nightly dreaming pass. Auto-apply is not armed. |

Press Enter at the interactive prompt for `recommended`. Non-interactive runs
never prompt and choose `minimal`; pass `--profile recommended` or
`--profile everything` to opt in explicitly. `wire` appends only missing flags
to this repo's `.env` and never overwrites an active assignment already there.
The shipped defaults remain OFF for anyone who does not run `wire`.

The manual equivalent for passive learning is:

```
OBSERVATION_INGESTION_ENABLED=true     # accept + store tool-use observations
DISCOVERY_DETECTION_ENABLED=true       # turn stored observations into discovered memories
```

Add `DREAMING_ENABLED=true` for the `everything` posture. The `auto_accept_*`
controls are separate operator-config gates and no `wire` profile changes them.

**Observation write auth.** If other machines can reach the server, generate a shared secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The same value goes in two places under two names:
- Server side: `OBSERVATION_API_KEY=<value>` in this repo's `.env` — the server then requires `X-API-Key` on the observation write endpoints.
- Client side: `KOPENG_API_KEY=<value>` in the `env` block of `~/.claude/settings.json` (step 4b) — the hooks send it as `X-API-Key`.

There are three key variable names but only two credentials: `ADMIN_API_KEY`
is the server's operator-admin credential; `OBSERVATION_API_KEY` is the
server-side observation credential; and client hooks receive that same
observation credential as `KOPENG_API_KEY`. The recall hooks read no key —
memory reads stay public by design.

> **Naming note:** everything here uses the `kopeng` names — `KOPENG_*` env vars, the `kopeng-observe.js` hook script, the `~/.kopeng/` client-side data directory.

If you skip this, observation writes are open — acceptable only when the server is loopback-only (the default `HOST=127.0.0.1`). The observation credential is deliberately separate because it may be distributed to hook clients on other machines and must not carry admin power.

### Remote access

**Remote deployment is unsupported for the 0.x preview.** `HOST=127.0.0.1`
(default) binds loopback only, and the server **refuses to boot** on a
non-loopback `HOST` unless BOTH `ADMIN_API_KEY` and `OBSERVATION_API_KEY` are
set — the refusal message names the missing key(s) and points at
[SECURITY.md](SECURITY.md). ("Loopback" = `localhost`, `::1`, or a real IPv4
`127.*` address — a hostname like `127.evil.test` does not qualify.)

If you widen the bind anyway (e.g. over a private VPN), understand that the
keys are necessary but **not sufficient**: ops/read endpoints are public by
design, and the scrubber is defense-in-depth rather than a boundary. Treat a
non-loopback bind as requiring an outer boundary — a VPN or an authenticating
reverse proxy. See [SECURITY.md](SECURITY.md) for the full threat model.

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

From the repo root, let KOPENG merge its MCP registration and five baseline
hooks into your existing Claude Code config:

```bash
npm run wire                 # choose a profile; dry-run and review actual values
# Run the exact "Apply these changes with" command printed by the dry run.
# Non-interactive example:
npm run wire -- --apply --profile recommended
# If wire changed .env, stop and restart the server process (or service) now.
npm run doctor               # verify server + MCP + hooks + feature posture
```

Feature flags are read when the server starts. If `wire` adds profile values to
`.env`, restart the foreground process or installed KOPENG service before
running `doctor`.

`wire` is idempotent: re-run it after moving the clone and it updates KOPENG's
paths without duplicating entries. It preserves unrelated MCP servers, env
values, hooks, and explicit profile flags. If your client uses a non-default
server URL, pass it explicitly as
`npm run wire -- --apply --api-url <url> --profile <profile>`.

If you run the dry run from a linked Git worktree, `wire` warns that its paths
may be temporary and refuses an implicit `--apply`. Run from the stable checkout
or pass it explicitly with `--repo-root <path-to-stable-kopeng-checkout>`.

Prefer to inspect or maintain the JSON yourself? The manual equivalent remains
below as §4a–§4e.

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
  "KOPENG_API_URL": "http://localhost:3200"
}
```

On the default loopback install, that is the complete client env block.
`KOPENG_API_KEY` is optional: add it only when you enabled observation write
auth in §2, using the same value as the server's `OBSERVATION_API_KEY`. It is
inert while passive learning is off, and the recall hooks never read it.

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

### 4e. Verify the hooks manually (fallback client-wiring check)

`npm run doctor` is the recommended client-wiring check. It verifies these
paths automatically and runs a live recall through the real hook. The commands
below are the manual fallback when diagnosing one hook in isolation.

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

On every reboot, Windows' NAT driver (winnat, used by Hyper-V/WSL2) reserves a fresh set of *random* port ranges. If a range lands on a port one of the KOPENG Docker containers publishes, that container comes up "healthy" but its host port silently never binds — the service degrades with no error anywhere except an `ECONNREFUSED` in KOPENG's own logs. This is not theoretical: a reboot can land a reserved range on 6379 and silently kill the Redis cache layer. (Maintainer-only Postgres backend: the same failure mode takes KOPENG fully down — its port-reservation row lives in [docs/postgres-maintainer.md](./docs/postgres-maintainer.md).)

Fix: permanently reserve every published port as an "administered exclusion" so winnat can never grab it. One-time, survives reboots. Run as admin (reservations can only be added while winnat is stopped):

```powershell
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=6379 numberofports=1   # Redis
netsh int ipv4 add excludedportrange protocol=tcp startport=7474 numberofports=1   # Neo4j browser
netsh int ipv4 add excludedportrange protocol=tcp startport=7687 numberofports=1   # Neo4j bolt
netsh int ipv4 add excludedportrange protocol=tcp startport=9000 numberofports=2   # MinIO API + console (9000-9001)
net start winnat
```

Reserve the ports for the services you run; reserving the full set costs nothing and saves the port if a service is added later. SQLite-only installs with no Docker services can skip this section entirely.

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

Docker Compose files for each service are in the repo root (`docker-compose.neo4j.yml`, `docker-compose.minio.yml`, `docker-compose.redis.yml`). All bind to `127.0.0.1` on the host — not exposed over the network.

### PostgreSQL

The alternative Postgres backend is supported for the maintainer only and is not part of the 0.x preview path — see [docs/postgres-maintainer.md](./docs/postgres-maintainer.md).

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

The staple-injection mechanism itself is covered by an automated test
(`tests/unit/staple-injection.test.ts`), so this recipe is a verification aid
for *your* staple — its trigger terms and metadata — not the only coverage of
the path. Run a diluted prompt containing the trigger term through the recall
hook and check the output:
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

Run both checks after first setup:

```bash
npm run canary    # server path: store → embed → semantic recall
npm run doctor    # whole install: server + MCP + hooks + feature posture
```

**`npm run canary`** is the server-path proof. It stores a canary
memory carrying a fresh random token, then spawns the **real** recall hook
(`scripts/hooks/memory-prompt-search.mjs`) and asserts the token comes back —
so a pass exercises store → embed → **semantic** recall end to end. The canary
prompt deliberately shares no content words with the stored memory, so a
keyword (FTS) match cannot rescue a dead vector path. On failure it prints a
plain-language diagnosis and splits the fault: a direct REST probe that
returns the token means the semantic path is fine and the problem is hook-side
(node on PATH, paths in your config); an empty probe points at the
embedder/index. The canary archives its own rows on every run, pass or fail —
a few archived `canary`-tagged rows accumulating over time are expected
residue. One rare honest limit: on a large, mature corpus the canary row can
be crowded out of the probe's top-5 results by higher-scoring memories, so a
failure there can misreport a healthy install — re-run, or verify via the
§4e REST check.

What the canary does **not** test: the MCP registration and hook commands in
your Claude Code config. `npm run doctor` checks that client half, reports each
failure with its exact fix, and prints whether passive learning and dreaming
are currently on or off. It never changes the feature flags.

Quick liveness checks, any time:

```bash
curl http://localhost:3200/api/health        # service up (+ embedding-index status)
curl http://localhost:3200/api/stats         # DB initialized
```

In Claude Code: confirm `mcp__kopeng__*` tools appear in the toolset and recall fires on session start (visible in conversation context).

---

## Backup & Restore

**`npm run backup`** snapshots the SQLite databases — `memory.db` and, when
present, `observations.db` — into `BACKUP_PATH` (default `./data/backups`).
Each output file is written to a `.tmp` sibling, integrity-checked, then
renamed into place, and every backup writes a `backup-<stamp>.manifest.json`
recording each backup DB's SHA-256 plus active/archived row counts, max id,
newest-row content hash, and the `PRAGMA integrity_check` result. The two
databases are snapshotted
**sequentially**, not in one transaction — run the backup with the server
stopped to get a mutually-consistent pair.

**Restore procedure:**

1. Stop the service (`nssm stop kopeng` / `sudo systemctl stop kopeng`).
2. Move aside the destination `.db` **and its `-wal`/`-shm` siblings as a
   unit** — a stale WAL pair left beside a restored database file belongs to
   the old database and must not be replayed into the new one.
3. Copy the backup files into place under the live names.
4. While the service is still stopped, run
   `npm run restore:verify -- --manifest <path>` — checks that each restored DB's
   SHA-256 exactly matches the backed-up snapshot, then checks its corpus stats
   and integrity. A running service may legitimately change SQLite bytes and
   invalidate this exact proof.
5. Start the service.
6. `npm run canary` — end-to-end recall proof over the restored corpus.

Maintainer-only Postgres backend: `npm run backup` exits with an error under
`DATABASE_TYPE=postgres` — see [docs/postgres-maintainer.md](./docs/postgres-maintainer.md).

---

## Troubleshooting

First stop: `curl http://localhost:3200/api/health` — it reports embedding-index status alongside liveness, which splits every problem into "server" vs "client" in one call.

**First boot is slow / needs network.** On first run the server downloads the embedding model (~30 MB) into `models/`, and the first *search* additionally lazy-loads the reranker (~1s one-time). Both are cached forever after. Air-gapped install: copy a populated `models/` directory from another machine — same layout, no code change. `data/` and `logs/` are auto-created; there is no seed step.

**`better-sqlite3` fails to load (`NODE_MODULE_VERSION` mismatch / "was compiled against a different Node.js version").** The native module was built for a different Node than the one running. Rebuild against the active Node: `npm rebuild better-sqlite3` (or delete `node_modules` and `npm ci`). This bites most often when a service manager (NSSM, systemd) runs a different Node than your shell — point the service at the same `node` binary you built with. On Linux, if npm falls back to compiling from source (no prebuilt binary for your Node/arch), install the toolchain first: `sudo apt install build-essential python3` (or distro equivalent).

**Embedding model never loads (`ERR_DLOPEN_FAILED` on `onnxruntime_binding.node`).** The ONNX runtime is a native
module and needs the Microsoft Visual C++ Redistributable on Windows (see [Prerequisites](#prerequisites)); install it
and restart. The server is *designed* to survive this — it logs `Continuing with keyword-only search` and keeps serving
FTS/keyword results, so `/api/memories/search` still works while `/api/memories/recall` (semantic-only) returns empty.
Until 2026-08-26 it logged that line and then died anyway on Node <= 20, because a failing ESM import of a throwing
CommonJS dependency surfaces the same error twice and the second one is unreachable; that is fixed, and pinned by
`tests/unit/import-duplicate-rejection.test.ts`.

**`EADDRINUSE` on start.** Something already owns port 3200 — set `PORT` in `.env` (and update `MEMORY_API_URL` everywhere clients reference it: MCP registration, hook env).

**MCP tools don't appear in Claude Code.** Almost always the stdio registration path: `args` must be an **absolute path** to `dist/index.js` (forward slashes on Windows), and `dist/` must exist (`npm run build`). Restart Claude Code after editing `~/.claude.json`. Test the server directly: `curl http://localhost:3200/api/health` — the MCP process is a thin client; if the REST API is down, every tool call fails.

**Hooks are silent (no recall, no observations).** Run `npm run doctor`, then use [§4e](#4e-verify-the-hooks-manually-fallback-client-wiring-check) to pipe a fake prompt into one hook directly. If the script works standalone but not in Claude Code, check that `node` is on the PATH Claude Code spawns hooks with and that the `<REPO>` absolute paths in `settings.json` are correct. Hooks are deliberately fail-open — they exit 0 and print nothing rather than break your session, so a misconfigured path *looks* like silence, not an error.

**Observation POSTs return 401/403.** `OBSERVATION_API_KEY` (server `.env`) and `KOPENG_API_KEY` (hook env in `~/.claude/settings.json`) must hold the same value — see §2. The hook buffers failed batches locally and retries, so nothing is lost while you fix the key.

**Remote clients get `429 Too Many Requests`.** Loopback is exempt from rate limiting; remote IPs get `RATE_LIMIT_MAX` per minute (default 100). Raise it in `.env` or run latency-sensitive clients on the server box.

**Docker optional services "up" but unreachable (Windows).** If a container shows `Up` but its port never binds (`docker port <name>` prints nothing, recreate fails with "socket access forbidden"), Windows' NAT driver reserved the port — see [§6b](#6b-reserve-docker-ports-from-winnat-windows--required).

**Stale client-side hint/cache files.** `npm run clean:client` removes expired hint and cache files under `~/.kopeng` (allowlisted paths only).

**Scheduled tasks silently stopped running.** The sync-indexes / corpus-health
installers (`scripts/ops/install-*-task.ps1`) maintain a durable expected-task
registry under `~/.kopeng/metrics/`. `npm run heartbeats` reads that registry
plus the per-run heartbeat log and exits non-zero when an installed task is
missing, stale, or failing. An installed task is MISSING even before its first
run, so deleting or disabling it cannot look like a fresh install. Explicit
`-Uninstall` removes its registry entry; a machine where no task was installed
has no expectations and reads clean. `--expect <task>:<hours>` bypasses the
registry for one-off checks.

**Search returns nothing on a fresh install.** Not a bug — the store is empty until you store a memory, or until the hooks capture something (requires `OBSERVATION_INGESTION_ENABLED=true` + `DISCOVERY_DETECTION_ENABLED=true` in the server `.env` — see §2 "Advanced: passive learning"). Quick self-test:

```bash
curl -s -X POST http://localhost:3200/api/memories -H "Content-Type: application/json" \
  -d '{"content":"hello kopeng","type":"reference","scope":"global"}'
curl -s -X POST http://localhost:3200/api/memories/search -H "Content-Type: application/json" \
  -d '{"query":"hello"}'
```
