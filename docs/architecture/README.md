# Architecture reference

On 2026-09-07 the `## Architecture` section of `CLAUDE.md` had grown to 159k characters — 90% of a file that is loaded into context on every single session, and past Claude Code's 150k limit. The detail was extracted here **verbatim**: nothing was pruned, reworded, or summarized away in the move. `CLAUDE.md` keeps a subsystem map with a pointer to each file below.

If you are changing code in one of these subsystems, read its file first. Most of the prose here is not description — it is invariants, the failure that forced each one, and the test that pins it.

| File | Covers |
|---|---|
| [`scopes.md`](scopes.md) | Anchor-marker scopes (P4), scope derivation (RULING-C), the scope-alias layer (T46), the shared scope definition (Phase 1), and the scope registry / minting / rulings (Phase 3, T76, T77) |
| [`dreaming.md`](dreaming.md) | The dreaming layer: fire predicate, activity tracker, scheduler, engine, apply path, pipeline, reasoner, contradiction routing, replay harness, lock + supervisor |
| [`ops-endpoints.md`](ops-endpoints.md) | The ten read-only `GET /api/ops/*` panels, the replay endpoints, and the live observation SSE stream |
| [`discovery.md`](discovery.md) | The auto-discovery pipeline (observations → heuristics → synthesizer → confidence → dedup) and error-pattern detection |
| [`hooks.md`](hooks.md) | The observation hook and its T18 flush model, the hook output contract, in-session sequence triggers, the canonical-path gate, and the T29 turn gate + adherence metric |
| [`api-contract.md`](api-contract.md) | Response envelope, `fields=lite`, PUT snapshot semantics, revision retention and redaction, operator-config blob merge, and the admin-key posture |
| [`surfacing.md`](surfacing.md) | Static surfacing (C1): the index importer, `POST /api/surface`, the recall-hook thin client, and the causal acceptance metric |
| [`search-and-services.md`](search-and-services.md) | The search pipeline (embedding, hybrid RRF, fast recall, reranking) and the feature-flagged optional services (Neo4j, Redis, MinIO, promotion) |
| [`commands.md`](commands.md) | The fully annotated `npm run` reference — gates, flags, and safety caveats per script |
| [`testing.md`](testing.md) | The server-free testing rule with its two exceptions, and the Phase-4/Phase-5 test nets |
