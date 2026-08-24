# Changelog

All notable changes to KOPENG are documented here. This project adheres to [Semantic Versioning](https://semver.org).

## [1.1.0] — 2026-08-22

Scope identity, audited curation, and release posture — the 0.x preview program (Phases 0–8) plus the recall-reliability sprint that preceded it. No breaking API changes; all additions are additive or fail-open.

### Scope identity
- **Anchor-marker scopes**: a `.kopeng.json` marker lets a directory declare its scopes explicitly (`{ "scopes": ["client:acme", ...] }`); the recall hook walks up from `cwd`, merges declared scopes onto the base pair — purely additive, fail-open, bounded.
- **Scope-alias layer**: an operator-curated alias table (in `operator_config`, never a tracked file) with write-time canonicalization at every write site, read-time alias-group expansion on recall/search/surface, a read-only alias-draft proposer, and an audited bulk re-scope migration driver (dry-run default, one audited PUT per row, residual check).
- **One shared scope definition** (`src/scopes/resolver.ts`): a single validated, versioned resolution consumed by the write path, the drift detector, and the migration driver — with explicit rejection classes (self-map, chain, malformed scope, generic capture) and a composition test that fails if any consumer grows its own parser again.
- **Scope registry & minting**: a `scope_registry` table records each scope's provenance; new scopes are minted, name collisions are quarantined (`--q<n>`) — writes always land, never merge or block; scopeless writes route to a `project:_unrouted` triage scope instead of silently leaking to `global`; malformed scopes are captured with the raw preserved, never rejected.
- **Honest discovery watermarks**: per-scope run rows record per-scope end ids; ephemeral scopes are `held` (not silently skipped) and releasable via an operator ruling + time-preserving admin re-drive that creates no observations and rewrites no timestamps.
- **Drift visibility & rulings**: `GET /api/ops/scope-drift` (new-variant detection with per-variant evidence), `GET /api/ops/scope-registry`, and `POST /api/admin/scopes/rule` (confirm / merge_into / rename, with tombstones so freed quarantine suffixes are never re-minted).
- **One definition of "archived"** (`isArchived` / `ARCHIVED_SQL_PREDICATE`) plus a read-only reconcile reporter for legacy divergent rows.

### Curation — audited and reversible throughout
- **Every automated archive is audited**: promotion decay archival and both discovery-maintenance archive sites now route through the dream apply path (snapshot → archive → audit, compensate on failure) and honor the same operator gate; without audit dependencies they withhold rather than archive.
- **One archive-line predicate** (`isDecayedAtRisk`) shared by promotion, the dream decay tier, maintenance, and the corpus-health panel — set-equality across all four pinned by a composition test with a grep-guard against re-drift.
- **Hard Anchor contract completed**: `metadata.pinned` is honored by every archiver (previously promotion-only — dreaming/maintenance could archive a pinned row; RED-proved and closed).
- **Deterministic guards ahead of the LLM classifier**: referent guard (same-template/different-referent discovery pairs), numeric-divergence guard (changed values become supersessions, not duplicates), retirement-narration guard (self-narrated supersessions record their chain) — template noise never reaches the reasoner, and nothing a reasoner touches can auto-apply.
- **Reversibility done right**: `PUT /api/memories/:id` snapshots on every effective mutation; revisions capture scope/type/last_seen; rollback restores and *rescues* (reinforces, so a restored memory isn't immediately re-archived); revision retention with admin-gated reads and deliberate purge routes.
- **Maintenance scope promotion reworked**: audited re-scope of the best original to `global` (reversible, compensating on mid-group failure), gated OFF by default.

### Release posture & security
- **First-run posture**: `ADMIN_API_KEY` auto-generated into `.env` (atomic, owner-only); a non-loopback bind without both keys refuses to boot; loopback bind default.
- **Every mutating endpoint** outside observation ingestion requires the admin key when set — core memory CRUD included; reads stay public so keyless recall hooks keep working.
- **Operational proof commands**: `npm run canary` (store → embed → semantic recall through the real recall hook), `npm run backup` / `restore:verify` (manifested, torn-write-safe backups verified as a corpus, not a file), `npm run heartbeats` (scheduled-task staleness), `npm run clean:client` (allowlisted client-state cleanup that can never touch the outage alarm).
- **Recall context fix**: hook output now ships model-visible context on `additionalContext` (the old `systemMessage`-only emit reached the operator's transcript but never the model); the full stdout shape of both hooks is pinned by tests.

### Harnesses that can fail
- The replay harness pins exact per-band-pair classifier counts and gates both selector boundaries from both sides; the effectiveness harness re-reads its own report and asserts the headline per lane; a dirty-corpus drill runs a live local LLM against planted mess under 11 hard gates; a Postgres executed-SQL suite runs real SQL against a pgvector container in CI (its first run caught a real PG-only production bug).
- Server wiring is probed through the real composed server (`composeServer()`), not a hand-rebuilt approximation.
- Test suite grew from ~800 to ~1,400 tests.

### Docs
- Documentation-truth pass over the architecture docs: every load-bearing claim inventoried; one false claim and eight overclaims corrected in place.

## [1.0.0] — 2026-07-27

Initial public release. KOPENG is a persistent, self-hosted memory system for LLM/agent clients, exposed over the Model Context Protocol (MCP, stdio) and a REST API (Fastify).

### Core
- Hybrid semantic + keyword search (Reciprocal Rank Fusion) over a local, quantized `all-MiniLM-L6-v2` embedding model, with an optional `ms-marco-MiniLM-L-6-v2` cross-encoder reranker — 100% local inference at runtime, no data egress (the opt-in `eval:seed` dataset generator is the one exception and says so).
- SQLite (default) or PostgreSQL + pgvector backend, selected by `DATABASE_TYPE` (Postgres is maintainer-only as of 0.x — see docs/postgres-maintainer.md).
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
