# KOPENG

[![CI](https://github.com/djy89/kopeng/actions/workflows/ci.yml/badge.svg)](https://github.com/djy89/kopeng/actions/workflows/ci.yml) ![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue) ![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6) ![Local-first](https://img.shields.io/badge/inference-100%25%20local-orange)

**Memory that curates itself instead of growing into landfill.**

KOPENG is persistent, self-curating, local-first memory for coding agents (Claude Code, Codex CLI). It learns from how you actually work, recalls the right context on every prompt, and — unlike append-only RAG — cleans up after itself: duplicates collapse, stale facts decay, contradictions get routed to you for review. Every mutation is snapshot-first, audited, and reversible. All inference is 100% local: no per-query API cost, and your codebase context never leaves the box.

## Install

One prerequisite: **Node.js 20+**. That's it — no Docker, no database server, no cloud account, no API keys, no admin rights.

```bash
npx kopeng@latest init
```

On **Windows**, also install the [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) first — the local embedding runtime is a native module that will not load without it (KOPENG degrades to keyword-only search rather than failing, but you want the semantic half).

The installer is dry-run-first: it shows you exactly what it will do, then waits for your yes. On your next Claude Code prompt, recall just fires.

**What it puts on your machine** (and what `npx kopeng uninstall` removes):

| Item | Where |
| --- | --- |
| KOPENG server + CLI (prebuilt — nothing compiles) | `~/.kopeng/app` |
| Your memory data: SQLite database(s), logs, and `.env` config with a generated admin key | `~/.kopeng/data`, `~/.kopeng/logs`, `~/.kopeng/.env` |
| Embedding model (all-MiniLM-L6-v2, ~30 MB) and Reranker model (ms-marco-MiniLM-L-6-v2, downloaded on first search) | `~/.kopeng/models` |
| A user-level autostart entry (Scheduled Task / systemd --user unit / LaunchAgent) | your user session, recorded in `~/.kopeng/autostart.json` |
| MCP registration + 5 fail-open Claude Code hooks, merged minimally into your existing config (backed up first) | `~/.claude.json`, `~/.claude/settings.json` |
| Learning-profile flags (observation ingestion, discovery detection, dreaming — all off until you opt in) | `~/.kopeng/.env` |

`npx kopeng uninstall` reverses all of it and keeps your memory data unless you pass `--purge`. Nothing phones home — there is no telemetry to opt out of.

Prefer to run from source, wire configs by hand, or install as a real system service? The clone-and-`npm run wire` path lives in **[SETUP.md](SETUP.md)**, along with Codex CLI wiring and troubleshooting.

## Watch it think

```bash
npx kopeng viz
```

<!-- SCREENSHOT/GIF HERE: live tab + graph tab while a Claude Code session runs -->

KOPENG ships a six-tab dashboard that makes the whole system observable while you work: a **live feed** of tool-use observations streaming in real time, a **memory graph** you can traverse, **ops panels** (confidence distribution, decay, dream history, corpus health), the **dream review queue** where you accept or reject the Librarian's proposed consolidations, **session replay**, and **slots**. This is the difference between "trust me, it's learning" and watching it learn. Runs at `http://localhost:8780` in the foreground — Ctrl-C stops it.

## Why KOPENG

Most "agent memory" is append-only store-and-retrieve. It remembers; it never prunes. The corpus drifts — duplicates pile up, stale facts outrank current ones, contradictory memories ("we use X" / "we switched to Y") both keep surfacing — and the operator becomes the garbage collector. KOPENG adds the missing half: **curation.**

**It curates, not just recalls — the dreaming Librarian.** An operator-gated nightly consolidation pass collapses duplicates, decays stale memories, and routes contradictions and supersessions for your review. The engine is deterministic-first: every mutation is deterministic code; the optional local LLM only _classifies_ pairs and is structurally locked out of the write path. Supersession is a temporal chain, not a deletion — the history stays.

**It learns passively from real tool use, at zero LLM cost.** Six heuristic detectors turn observed behavior — repeated commands, error-then-fix patterns, hot files, cross-session sequences — into confidence-scored memories. You never have to remember to save anything.

**Every write that changes a memory is reversible.** Snapshot to revisions → mutate → append-only audit, with a compensation path if the audit append fails. Roll back any memory to any revision via one endpoint. The revision is a whole-row snapshot — content, embedding, tags, confidence, scope, type, the decay clock, and the `is_locked` Hard Anchor — so a rollback reverts protection state along with everything else. Scope of the claim, honestly: what is reversible is *memory* state. Automated (dream/promotion/maintenance) mutations additionally append a `dream_audit_log` row; operator edits and crystallization carry the revision alone as their reversibility record. Deletes are archives, never row removal — except the two admin revision-purge routes, which are the deliberate redaction escape hatch and do destroy history.

**Fully local.** Embeddings and reranking run as quantized ONNX in-process; the optional reasoner is Ollama on your own GPU. No cloud model sits in the retrieval path or the consolidation path.

## How it works

|Layer|What it does|
|---|---|
|**Retrieval**|Hybrid search — RRF fusion of semantic + keyword (FTS5), optional cross-encoder rerank, confidence-blended ranking. A fast hook-optimized recall path skips reranking.|
|**Dreaming / consolidation**|Deterministic-first nightly pass: duplicate collapse, durability-scaled decay, contradiction routing, supersession chains. Snapshot-first, audited, reversible. Off by default.|
|**Auto-discovery**|Tool-use observations → 6 zero-cost detectors → confidence scoring → semantic dedup → memories.|
|**Static surfacing**|Per-prompt injection of relevant tools, skills, and project conventions from your `~/.claude` indexes.|
|**Observability**|Live SSE event stream + the six-tab dashboard above.|
|**Optional reasoner**|Local Ollama pair classifier — classify/extract only, never writes. Absent or down, behavior degrades byte-for-byte to deterministic-only.|
|**Storage**|SQLite (supported preview backend) + in-process ONNX models. Optional, feature-flagged: Neo4j, Redis, MinIO.|
|**Interfaces**|19 MCP tools (thin stdio client) + Fastify REST API on `127.0.0.1:3200`.|

Two entry points, one backend: `src/server.ts` is the real server (owns the database, index, and services); `src/index.ts` is the MCP stdio client that proxies tool calls to it. The REST contract never changes across backend swaps.

Memory types: `user`, `feedback`, `project`, `reference`, `discovery`. Scopes: `global`, `project:<name>`, `client:<name>`, with a `PRIMARY_SCOPE` routing rule so nothing silently lands in `global`.

Three commands answer the three operational questions, any time: `wire` (is it connected?), `doctor` (is the whole install correct?), `canary` (does recall actually work, end to end?).

## Preview status

KOPENG is a **developer preview**: a self-hosted memory system for a single expert developer, on one machine, bound to loopback (`127.0.0.1:3200`).

- **Every autonomous layer ships OFF** and is labeled advanced. Passive learning, dreaming, and the reasoner are opt-in flags; the installer (`init`) and `wire` both offer minimal / recommended / everything profiles at install time.
- **Auto-apply is hard-restricted in code** to exactly two change classes (exact duplicates and decay) — both also OFF by default. Everything else queues for operator review.
- **Reliability comes from engineering rigor, not scale:** a zero-LLM pinned-clock replay regression net, adversarial reviews run against a copy of real data, idempotent consolidation passes, and fail-open behavior everywhere a hook or service could stall. ~1,800 tests run against in-memory SQLite with no server needed (`npm test`).
- **Security posture, in one paragraph:** operator mutations require a generated admin key; observation ingestion uses its own separate optional key; reads are public by design on loopback. **Remote deployment is unsupported** — a non-loopback bind refuses to boot without both keys, and even then requires an outer boundary (VPN or authenticating reverse proxy). Full threat model: [SECURITY.md](SECURITY.md).

> Renamed 2026-07 from its previous codename. Everything uses `kopeng` — hook env vars are `KOPENG_*`, client data lives in `~/.kopeng/`.

## Evals

Retrieval quality is measurable, not vibes: `npm run eval` reports P@K, R@K, MRR, and NDCG@K, with baseline-vs-reranked comparisons, and the consolidation layer has its own zero-LLM regression and effectiveness harnesses (`npm run dream:replay`, `npm run dream:effectiveness`). One deliberate exception to local-only, clearly flagged: `npm run eval:seed` sends selected memory content to the Anthropic API to draft eval queries — the only shipped command that egresses corpus data. The runtime itself never does.

## License

KOPENG is **source-available** under the [Business Source License 1.1](LICENSE): read, run, modify, and self-host it freely — including production use — but you may not offer it to third parties as a commercial hosted memory service. On **2030-07-05** the license automatically converts to **Apache 2.0**.

## Contact

Built by **djy89** — a single-maintainer project.

- More of my work: [djy89.net](https://djy89.net/)
- Bugs, questions, design discussion: open a [GitHub issue](https://github.com/djy89/kopeng/issues) — public discussion preferred; it helps the next person.
- Anything else: `hello@kopeng.net`
- Security vulnerabilities: use GitHub's private vulnerability reporting per [SECURITY.md](SECURITY.md) — not issues, not email.
