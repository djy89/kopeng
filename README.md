# KOPENG

[![CI](https://github.com/djy89/kopeng/actions/workflows/ci.yml/badge.svg)](https://github.com/djy89/kopeng/actions/workflows/ci.yml) ![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue) ![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6) ![Local-first](https://img.shields.io/badge/inference-100%25%20local-orange)

**Persistent, self-curating memory for coding agents — it doesn't just remember what you've done, it cleans up after itself, fully local.**

KOPENG 0.x is a **local developer preview**: a self-hosted memory system for a single expert developer, on one machine, bound to loopback. Every autonomous layer ships OFF and is labeled advanced. What backs reliability is engineering rigor, not scale — a zero-LLM pinned-clock replay regression net, adversarial GATE reviews run against a *copy* of real data, idempotent locked consolidation passes, and fail-open/fail-silent behavior everywhere a hook or service could stall.

> Renamed 2026-07 to its current codename. Everything now uses `kopeng` — hook env vars are `KOPENG_*` and the client data directory is `~/.kopeng/`.

KOPENG is a memory and context layer for coding agents (Claude Code, Codex CLI), exposed as MCP tools plus a REST API. It learns from observed tool-use — passively turning repeated tool calls, error-then-fix patterns, hot files, and cross-session sequences into confidence-scored memories with no LLM cost — and serves them back through a hybrid retrieval pipeline (RRF fusion of semantic + keyword, optional cross-encoder rerank, confidence-blended ranking), all running on local quantized ONNX models so there is no per-query API cost or data egress. Its distinguishing layer is operator-gated nightly consolidation (the "dreaming Librarian"): a deterministic-first engine that collapses duplicate memories, decays stale ones, and routes contradictions and supersessions — every mutation snapshot-first, audited, and reversible. An optional local LLM (Ollama) is used only as a pair classifier; it never touches the write path.

Memory that curates itself instead of growing into landfill.

---

## Why KOPENG is different

Most "agent memory" is append-only store-and-retrieve RAG: it remembers, it never prunes. The corpus drifts — duplicates pile up, stale facts outrank current ones, contradictory memories ("we use X" / "we switched to Y") both keep surfacing — and the operator becomes the garbage collector. KOPENG adds the missing half: curation.

- **It curates, not just recalls — the dreaming Librarian.** An operator-gated nightly consolidation pass collapses duplicate memories, decays stale ones, and routes contradictions/supersessions for review. The engine is deterministic-first: routing, supersession direction, and **every mutation** are deterministic code — the optional LLM only *classifies* a pair (duplicate / preference-change / conditional / contested / unrelated) and is structurally locked out of the write path (`apply.ts`, invariant #3). Every consolidation write that changes an existing memory (archive, merge, supersede, contradiction-mark) is snapshot-first and audited — snapshot to revisions → mutate → append-only audit log, with a compensation path that unrolls the mutation if the audit append fails ("no unaudited change survives", invariant #11) — reversible via `POST /api/memories/:id/rollback`; memories the pass *creates* are undone by archiving them through the same endpoint. Supersession is a temporal chain (`deprecated_at` / `valid_from`), not a deletion: both the old and new statement stay active and direction is timestamp-deterministic. **This layer is feature-flagged (`DREAMING_ENABLED`, default OFF); auto-apply is hard-restricted in code to exactly two change classes (exact duplicates and decay), both shipping OFF by default — everything else queues for operator review.**
- **Learns passively from real tool-use, at zero LLM cost.** Six template-based heuristic detectors turn observed behavior — repeated tool+input, error-then-fix, hot files, repeated commands, recurring errors, A→B sequences — into confidence-scored memories. The operator never has to remember to save anything, and the replay harness asserts the detection loop makes zero model calls.
- **Fully local, no per-query cost, no data egress.** Embeddings (`all-MiniLM-L6-v2`) and the reranker (`ms-marco-MiniLM-L-6-v2`) are quantized ONNX run in-process; the optional reasoner is local Ollama on your own GPU. No cloud LLM sits in the retrieval path *or* the consolidation path — your codebase context never leaves the box.
- **Observable.** A live SSE event stream and a six-tab web viz (graph / live / ops / replay / review / slots) expose what the system is doing: real-time observation events, operational panels (confidence distribution, decay, dream history, corpus health), dream review controls, and historical session playback.

---

## Capability map

| Layer | What it does |
|-------|--------------|
| **Retrieval** | Hybrid search — Reciprocal Rank Fusion (k=60) over semantic (cosine) + keyword (FTS5/tsvector), optional `ms-marco` cross-encoder rerank, confidence-blended ranking. Fast hook-optimized recall path skips reranking. |
| **Dreaming / consolidation** | Deterministic-first nightly Librarian: duplicate collapse, durability-scaled decay, contradiction routing, supersession chains. Snapshot-first, audited, reversible. Feature-flagged, auto-apply off by default. |
| **Auto-discovery** | Observation ingestion → 6 zero-cost heuristic detectors → synthesizer → confidence scoring → semantic dedup → memory creation. Recurring-error classification and tiering. |
| **Static surfacing** | Per-prompt injection of relevant tools, skills, and project conventions from the operator's `~/.claude` indexes, with a causal acceptance metric. |
| **Optional reasoner** | Local Ollama pair classifier (`qwen3:8b`), classify/extract only — never writes. Off or provider-down degrades byte-for-byte to deterministic-only behavior. |
| **Storage backends** | SQLite (`better-sqlite3` + in-memory vector index) — the supported 0.x backend. An alternative PostgreSQL (`pg` + `pgvector`) backend implements the same store interfaces but is maintainer-only — see [docs/postgres-maintainer.md](docs/postgres-maintainer.md). |
| **Optional services** | Neo4j (graph/entity traversal), Redis (ephemeral context), MinIO (S3 artifact storage) — each feature-flagged, gracefully degrades if absent. |
| **Observability** | SSE observation stream + six-tab viz (graph, live events, ops panels, session replay, dream review, slots). |
| **Interfaces** | **19 MCP tools** (thin stdio HTTP clients) + Fastify REST API on port 3200. |

### Two entry points, one backend

- **`src/server.ts`** — Fastify REST API (port 3200). The real server: owns the database, embedding index, and all optional services.
- **`src/index.ts`** — MCP stdio server. A thin client that proxies tool calls to the REST API via `MEMORY_API_URL`; it never touches the database directly.

---

## Setup

```bash
git clone https://github.com/djy89/kopeng.git
cd kopeng
npm install
cp .env.example .env    # then edit — see below
npm run build
```

First boot downloads the embedding model (~30 MB) into `models/`, auto-creates `data/` and `logs/`, and — when no `ADMIN_API_KEY` is set in the launch environment or `.env` — generates one into `.env` (precedence: non-empty launch env > non-empty `.env` value > generated; an unwritable `.env` is a boot refusal with instructions, not a keyless boot). No seed step. **Full walkthrough — service install, Claude Code / Codex CLI wiring, hooks, API keys, and troubleshooting — is in [SETUP.md](SETUP.md).**

### Environment (.env)

`.env.example` is the complete, commented **server** configuration reference for the default SQLite path (hook/client-side variables like `KOPENG_API_URL` are documented in SETUP.md; selecting the maintainer-only Postgres backend is covered in [docs/postgres-maintainer.md](docs/postgres-maintainer.md)); these are the ones you'll touch first:

```
PORT=3200
HOST=127.0.0.1
DATABASE_PATH=./data/memory.db
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
LOG_LEVEL=info
MEMORY_API_URL=http://localhost:3200
```

> **Before you change `HOST`.** KOPENG binds loopback by default, and the 0.x preview is designed to stay there. A non-loopback `HOST` **refuses to boot** unless both `ADMIN_API_KEY` and `OBSERVATION_API_KEY` are set — the refusal names the missing key(s) and points at [SECURITY.md](SECURITY.md). "Loopback" here means `localhost`, `::1`, or a real IPv4 address starting `127.` — a hostname like `127.example.test` does not count. Even with both keys set, **remote deployment is unsupported for the 0.x preview**: an outer boundary (a private VPN or an authenticating reverse proxy) is required, because the keys gate mutations, not reads.
>
> The threat model in one paragraph: **operator mutations require the generated admin key; observation ingestion — OFF on the preview path — uses its own separate, optional key when enabled.** Reads are public by design — recall/search/surface/traverse, listing, the SSE stream, the ops snapshots, and the keyless `GET /api/operator-config` (which exposes the scope-alias map, i.e. client names) — so any process that can reach the port can read the whole corpus. Since memories are recalled into a model's context on later prompts, a write there would be a persistent prompt-injection channel — which is what the admin key exists to close. Full inventory and reasoning: [SECURITY.md](SECURITY.md).

Optional layers are off by default and gated by their own flags (each degrades gracefully if its backing service is unavailable). Set a flag to `true` to enable that layer:

```
# Auto-discovery
OBSERVATION_INGESTION_ENABLED=true
DISCOVERY_DETECTION_ENABLED=true

# Dreaming Librarian (consolidation) + optional local reasoner
DREAMING_ENABLED=false
DREAM_REASONER_ENABLED=false

# Optional services
NEO4J_ENABLED=false
REDIS_ENABLED=false
MINIO_ENABLED=false
```

The alternative PostgreSQL backend is maintainer-only and not part of the 0.x preview path — see [docs/postgres-maintainer.md](docs/postgres-maintainer.md).

## Running

```bash
npm start            # Production REST API server (node dist/server.js)
npm run dev          # REST server, watch mode (tsx watch src/server.ts)
npm run start:mcp    # Production MCP stdio server (used by Claude Code, not run directly)
npm run dev:mcp      # MCP server, watch mode
npm run viz          # Observability viz proxy (serves viz/ + proxies the API/SSE)
```

## REST API

Successful responses use the envelope `{ data: T, meta?: { ... } }`; errors return `{ error, details? }`. Input is Zod-validated; the API is rate-limited.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health + readiness probe |
| GET | `/api/stats` | Counts, DB size, index status |
| POST | `/api/memories` | Store memory (auto-embeds) |
| POST | `/api/memories/batch` | Bulk store (max 100) |
| GET | `/api/memories/:id` | Get by ID |
| GET | `/api/memories/:id/related` | Semantically similar |
| PUT | `/api/memories/:id` | Update (re-embeds if content changes) |
| PATCH | `/api/memories/:id` | Archive/unarchive |
| POST | `/api/memories/recall` | Fast semantic recall (hook-optimized, no rerank) |
| POST | `/api/memories/search` | Hybrid search |
| GET | `/api/memories` | List with filters |
| POST | `/api/memories/:id/rollback` | Restore a memory from a snapshot revision |
| GET | `/api/memories/:id/revisions` | List snapshot revisions |
| POST | `/api/surface` | Static surfacing — relevant tools/skills/conventions |
| GET | `/api/observations/stream` | Live SSE observation event feed |
| GET | `/api/ops/*` | Read-only operational snapshots (8 endpoints) |
| POST | `/api/dreams/trigger` | Manually trigger a consolidation pass |
| GET | `/api/dreams/pending` | Pending dream review queue |
| POST | `/api/dreams/:id/resolve` | Accept/reject dream entries |
| POST | `/api/admin/backup` | Trigger SQLite backup |
| POST | `/api/admin/reindex` | Rebuild FTS5 + embedding index |
| POST | `/api/admin/promote` | Run the promotion pipeline |

Optional services add their own routes (`/api/memories/traverse`, `/api/graph/*`, `/api/context*`, `/api/artifacts*`) when enabled.

### Search modes

- `hybrid` (default) — reciprocal rank fusion of semantic + keyword
- `semantic` — cosine similarity only
- `keyword` — FTS5/tsvector keyword only

### Reranking

Search results are reranked by default using a cross-encoder (`ms-marco-MiniLM-L-6-v2`, local ONNX), lazy-loaded on first search (no startup cost). Rerank logits are sigmoid-normalized and confidence-blended for final ordering.

```bash
# Reranked search (default)
curl -X POST http://localhost:3200/api/memories/search \
  -H "Content-Type: application/json" \
  -d '{"query":"coding preferences","mode":"hybrid","rerank":true}'

# Disable reranking
curl -X POST http://localhost:3200/api/memories/search \
  -H "Content-Type: application/json" \
  -d '{"query":"coding preferences","rerank":false}'

# Control candidate pool size (default 20)
curl -X POST http://localhost:3200/api/memories/search \
  -H "Content-Type: application/json" \
  -d '{"query":"coding preferences","rerank":true,"rerank_candidates":30}'
```

Response includes `rerank_score` per result and `meta.reranked: true` when active.

### Store a memory

```bash
curl -X POST http://localhost:3200/api/memories \
  -H "Content-Type: application/json" \
  -d '{"content":"...","type":"feedback","scope":"global","tags":["testing"]}'
```

Memory types: `user`, `feedback`, `project`, `reference`, `discovery`. Scopes: `global`, `project:<name>`, `client:<name>`.

## MCP Tools

**19 tools** registered in `src/index.ts`, each a thin HTTP client over the REST API. Core retrieval/CRUD:

| Tool | Description |
|------|-------------|
| `store_memory` | Store new memory with auto-embedding |
| `search_memories` | Hybrid semantic + keyword search |
| `get_memory` | Get memory by ID |
| `update_memory` | Update memory (re-embeds if content changes) |
| `list_memories` | List/filter memories with pagination |
| `archive_memory` | Archive or unarchive a memory |
| `eval_retrieval` | Ad-hoc retrieval eval with precision/recall |

Plus context/artifact/graph tools (`set_context`, `get_context`, `store_artifact`, `get_artifact`, `traverse_memory`), discovery (`trigger_discovery`), and the dream review + operator-config surface (`trigger_dream`, `list_pending_dreams`, `get_dream_diff`, `resolve_dream`, `get_operator_config`, `set_operator_config`). The `auto_accept_*` flags exposed by the config tools ship OFF — flipping them is a deliberate operator decision.

### Claude Code registration

Add to Claude Code user settings (`~/.claude.json` or the settings UI):

```json
{
  "mcpServers": {
    "kopeng": {
      "command": "node",
      "args": ["/absolute/path/to/kopeng/dist/index.js"],
      "env": {
        "MEMORY_API_URL": "http://localhost:3200"
      }
    }
  }
}
```

### Observation + recall hooks

The passive-learning and proactive-surfacing layers run as Claude Code / Codex CLI hooks (`scripts/hooks/`). The observe hook appends tool-use events to a local JSONL buffer and batch-flushes to the server; the recall hooks inject relevant memory, tools, skills, and conventions before each prompt. See `SETUP.md` and `docs/codex-setup.md` for wiring details.

## Migration

```bash
# Import existing file-based memories (dry-run first)
npx tsx scripts/migrate-from-files.ts --dry-run
npm run migrate

# SQLite → PostgreSQL (maintainer-only backend — see docs/postgres-maintainer.md)
npm run migrate:postgres
npm run migrate:verify
```

## Running as a service

KOPENG is a plain Node process — run it under any process manager. Both recipes below (and more detail) are in [SETUP.md](SETUP.md).

Linux (systemd):

```ini
# /etc/systemd/system/kopeng.service
[Unit]
Description=KOPENG memory server
After=network.target

[Service]
User=youruser
WorkingDirectory=/opt/kopeng
ExecStart=/usr/bin/node /opt/kopeng/dist/server.js
Environment=NODE_ENV=production
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kopeng
```

`WorkingDirectory` should be the repo root: the app finds `.env` next to its install automatically, but relative path values inside it (`./data/memory.db`, `./models`) resolve against the working directory. nvm users: point `ExecStart` at the absolute `node` path from `which node`.

Windows ([NSSM](https://nssm.cc/)):

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

## Network Access

The server binds `127.0.0.1:3200` by default, and the 0.x preview path assumes it stays there — **remote deployment is unsupported for this preview**. If you point peers at it anyway (e.g. over a private VPN such as WireGuard or Tailscale), know that a non-loopback `HOST` refuses to boot unless both `ADMIN_API_KEY` and `OBSERVATION_API_KEY` are set, that the keys gate mutations while reads stay public, and that the VPN (or an authenticating reverse proxy) is therefore the required outer boundary — read the warning under [Environment](#environment-env) and [SECURITY.md](SECURITY.md) first. On Windows, also allow the port through the firewall (run as admin; scope `-InterfaceAlias` to your VPN interface if you have one):

```powershell
New-NetFirewallRule -DisplayName "KOPENG API" `
  -Direction Inbound -Protocol TCP -LocalPort 3200 `
  -Action Allow -Profile Any
```

## Eval Harness

Lightweight retrieval evaluation to measure search quality.

```bash
# Generate eval dataset from existing memories (requires ANTHROPIC_API_KEY)
# ⚠ This command SENDS SELECTED MEMORY CONTENT to the Anthropic API to draft
# eval queries — the only shipped command that egresses corpus data. The
# retrieval/consolidation runtime itself never does.
ANTHROPIC_API_KEY=sk-... npm run eval:seed

# Full eval (hybrid + reranking, default)
npm run eval

# Compare baseline vs reranked
npm run eval:baseline   # hybrid without reranking
npm run eval:reranked   # hybrid with reranking

# Custom settings
npx tsx scripts/run-eval.ts --mode semantic --rerank false --k 10
```

Metrics: P@K, R@K, MRR, NDCG@K. Results saved to `data/eval_results/[timestamp].json`. The `eval_retrieval` MCP tool runs ad-hoc single-query evals from within Claude Code.

### Dreaming harnesses

The consolidation layer has its own zero-LLM regression and effectiveness harnesses (no server required):

```bash
npm run dream:replay         # Zero-LLM regression net: real pass over a synthetic gold corpus,
                             # pinned clock, asserts per-class precision/recall + llm_calls == 0
npm run dream:effectiveness  # Before/after corpus-health + retrieval over a synthetic corpus
```

Reasoner-classifier evals (require local Ollama; not part of the test suite):

```bash
npm run eval:reasoner        # Live classify/extract eval, per-class precision/recall
npm run eval:adversarial     # GATE-2 hostile pairs
npm run eval:nli             # Local ONNX NLI baseline
```

## Tests

```bash
npm test             # Vitest, all tests (in-memory SQLite — no server needed)
npm run test:watch
npm run test:coverage
```

Unit tests run against in-memory SQLite; integration tests build an in-process Fastify app (`app.inject`) — no running server needed. Backend coverage is asymmetric: SQLite is exercised for real, PostgreSQL has adapter-level coverage against a mocked pool (see CONTRIBUTING.md).

## Design docs

The dreaming layer's design brief lives at [`docs/i-have-a-dream.md`](docs/i-have-a-dream.md), and its reasoner provider setup at [`docs/dreaming/reasoner-setup.md`](docs/dreaming/reasoner-setup.md). The behavioral guarantees those docs describe are enforced by the shipped test suite (replay harness, adversarial GATE 2 regression net, auth/contract tests). The REST API contract never changes across backend swaps.

## License

KOPENG is source-available under the [Business Source License 1.1](LICENSE): you can read, run, modify, and self-host it freely (including production use), but you may not offer it to third parties as a commercial hosted memory service. On 2030-07-05 the license automatically converts to Apache 2.0.

## Contact

Built by **djy89** — a single-maintainer project.

- **More of my work:** [djy89.net](https://djy89.net)
- **Bugs, questions, design discussion:** open a [GitHub issue](https://github.com/djy89/kopeng/issues). Public discussion is preferred; it helps the next person with the same question.
- **Anything else:** `hello@kopeng.net`
- **Security vulnerabilities:** neither of the above — use GitHub's private vulnerability reporting, per [SECURITY.md](SECURITY.md). Please don't put exploitable details in a public issue or in email.
