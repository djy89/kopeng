# Changelog

All notable changes to KOPENG are documented here. This project adheres to [Semantic Versioning](https://semver.org).

## [1.0.0] — 2026-07-27

Initial public release. KOPENG is a persistent, self-hosted memory system for LLM/agent clients, exposed over the Model Context Protocol (MCP, stdio) and a REST API (Fastify).

### Core
- Hybrid semantic + keyword search (Reciprocal Rank Fusion) over a local, quantized `all-MiniLM-L6-v2` embedding model, with an optional `ms-marco-MiniLM-L-6-v2` cross-encoder reranker — 100% local inference at runtime, no data egress (the opt-in `eval:seed` dataset generator is the one exception and says so).
- SQLite (default) or PostgreSQL + pgvector backend, selected by `DATABASE_TYPE`.
- 19 MCP tools (store / search / recall / traverse / …) and a versioned REST API with a consistent `{ data, meta }` envelope, Zod validation, and rate limiting.
- Optional services, each feature-flagged and gracefully degrading: Neo4j (entity graph), Redis (ephemeral context), MinIO (artifact storage).

### Curation — the dreaming "Librarian"
- Autonomous, feature-flagged nightly consolidation: collapses duplicates, decays stale memories, and routes contradictions/supersessions for review. Deterministic-first — an optional local LLM only *classifies* pairs and is kept out of the write path. Every consolidation write that changes an existing memory is snapshot-first, audited, and reversible via `POST /api/memories/:id/rollback`; auto-apply is hard-restricted in code to the exact-duplicate and decay classes, both shipping OFF.
- Passive, zero-LLM learning from real tool-use via heuristic detectors (repeated tool+input, error→fix, hot files, recurring errors, A→B sequences), producing confidence-scored memories.
- Type-tuned confidence decay with structural floors and auto-crystallization of durable memories.

### Security
- Optional shared-secret auth on observation-write (`OBSERVATION_API_KEY`) and mutating operator (`ADMIN_API_KEY`) endpoints; loopback-first defaults; multi-layer secret scrubbing on ingested tool output. Threat model and known-non-reachable dependency advisories are documented in [SECURITY.md](SECURITY.md).

### Tooling
- Windows (NSSM) and Linux (systemd) service recipes, a live observation stream (SSE) with a D3 visualizer, and a zero-LLM replay harness as the consolidation regression net.

License: Business Source License 1.1 (converts to Apache-2.0 on 2030-07-05).
