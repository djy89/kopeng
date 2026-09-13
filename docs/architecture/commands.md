# Commands (annotated reference)

> The full annotated command list, extracted verbatim from CLAUDE.md (2026-09-07). CLAUDE.md keeps the command names and a one-line purpose each; the caveats, gates, and flag semantics live here.

```bash
npm run dev          # REST server with watch mode (tsx watch src/server.ts)
npm run dev:mcp      # MCP server with watch mode (tsx watch src/index.ts)
npm run build        # TypeScript compile (tsc)
npm start            # Production REST server (node dist/server.js)
npm run start:mcp    # Production MCP server (node dist/index.js)
npm test             # Run all tests (vitest run)
npm run test:watch   # Tests in watch mode
npm run test:coverage # Tests with v8 coverage

npm run viz          # Viz server (proxy on port 8780) — graph/live/ops/replay tabs over the REST API
npm run doctor       # Install/health diagnostics: hooks wired, env resolution, live recall probe
npm run wire         # Interactive client hook wiring (profiles: minimal/recommended/everything)

# Eval harness (requires running server)
npm run eval              # Hybrid + reranking
npm run eval:baseline     # Without reranking
npm run eval:reranked     # With reranking

# Data operations
npm run migrate           # Import file-based memories to SQLite
npm run migrate:postgres  # SQLite → PostgreSQL migration
npm run backfill:graph    # Entity extraction for existing memories → Neo4j
npm run promote           # Run memory promotion pipeline
npm run promote:dry       # Dry-run promotion
npm run discover          # Trigger discovery run (requires running server)
npm run discover:maintain # Run discovery maintenance (purge, archive, promote)

# Dreaming replay harness (zero-LLM, in-memory SQLite — no server needed)
npm run dream:replay      # NoOpReasoner dream passes over the synthetic gold set + all scenario gates; exits non-zero on ANY gate failure. Phase 5: pass B pins classify_calls to the exact per-band-pair count (not the tautological zero-LLM check) and gates both selector boundaries from both sides (cosine 0.96/0.94 around the 0.95 collapse threshold, 0.86/0.84 around the 0.85 band floor); pass C proves alias-closure-sensitive grouping (promote_global without the closure, exact_dup + provenance with it) with the table validated by the real buildScopeResolution

# Dream-effectiveness harness (in-process, zero live mutation — proves dreaming leaves the corpus leaner while retrieval holds)
npm run dream:effectiveness            # Synthetic corpus: before/after corpus-health + retrieval (P@k/R@k/MRR/NDCG); emits scratch/dream-effectiveness.json (the launch-video data source). Phase 5: GATED — re-reads the emitted report and asserts the headline per lane (corpus shrank, dups dropped, retrieval held, ≥1 audited archive, decay lane live), non-zero exit on failure; --quiet suppresses the stdout JSON (CI logs), file + gates always emit
# npm run dream:effectiveness -- --db memory.copy.db --out report.json   # Run over a COPY of a real DB (refuses live memory.db/observations.db by name; copy-db mode gates only on pass completion — an arbitrary copy may be clean)

# Dirty-corpus drill (T28 — end-to-end precision/recall under planted mess: real embedder + LIVE qwen3:8b + apply/audit, scratch DB, auto_accept flags armed to prove reasoner entries still never auto-apply)
npm run dream:drill                    # Preflights Ollama; 11 hard gates (exit non-zero) + confusion matrix + rollback probes; report → scratch/dream-drill-report.json; baseline + rubric: docs/dreaming/dirty-corpus-drill.md
# npm run dream:drill -- --no-llm      # NoOpReasoner structural smoke (CI-safe; Phase-1 flagged fallbacks are the expected outcomes)

# Static surfacing (C1)
npm run sync:indexes      # Import ~/.claude/{TOOLS,SKILLS,PROJECT}_INDEX.md into KOPENG (idempotent; --dry-run / --prune flags)
npm run metric:surfacing  # Causal acceptance metric: suggestion-then-invocation ordered by timestamp within session
npm run propose:triggers  # Draft reactive→observational trigger rewrites as a reviewable before/after report (writes no skill file)

# Turn gate / adherence (T29)
npm run metric:adherence  # Causal adherence metric: were CRITICAL surfaced memories demonstrably consulted before turn-end? (voluntary / forced-inline / ignored)

# Anchor triage + type-tuned decay (T22 / T22b / T30)
npm run triage:anchors -- --db memory.copy.db                 # SQLite OFFLINE: segmentation report + reviewed bulk demote (D1 catalog→0.55, D3 aged project/reference→0.9). Dry-run default; --apply. COPY only — refuses live db names
npm run triage:anchors:live -- --url http://localhost:3200    # LIVE (Postgres/API): same D1/D3 demote over the audited PUT /api/memories/:id {confidence}. Dry-run default; --apply mutates live. Use this against the live PG corpus (the SQLite tool can't)
npm run analyze:type-decay -- --url http://localhost:3200     # T30 Phase-0: READ-ONLY model of the per-type half-lives vs the current 60d curve over the live corpus (no mutation)

# Release-posture ops (Phase 8)
npm run canary            # First-run proof that store → embed → SEMANTIC recall works end to end through the REAL recall hook (S4/CX-1: the prompt shares zero content-words with the stored row, so FTS can't rescue a dead vector path); always archives its canary row, pass or fail
npm run backup            # Server-down local SQLite backup (memory.db + observations.db when present) with a per-DB manifest — backup SHA-256, row counts, max id, newest content_hash, integrity_check (CX-2); every file tmp-written then renamed so a crash never leaves a torn backup (CX-12). Postgres deployments: docs/postgres-maintainer.md (pg_dump owns that path)
npm run restore:verify    # Verify the live data dir against the newest backup manifest (or -- --manifest <path>) — checks the restored CORPUS, not just that a file opens
npm run heartbeats        # READ-ONLY staleness evaluator over the installer-owned expected-task registry + ~/.kopeng/metrics/heartbeats.jsonl (CX-9: installed-but-never-run reads MISSING; gone-after-activity reads STALE; explicit -Uninstall removes the expectation; -- --expect <task>:<hours> bypasses the registry)
npm run clean:client      # Allowlisted cleanup of expired hint/cache files under ~/.kopeng (dry-run default; --apply). Filename-pattern allowlist, never a directory sweep — flush_error.json (the T18 outage alarm) and the buffer/queue files are untouchable by construction (CX-10)

# Offsite backup (not an npm script — PowerShell + docker + aws)
# powershell -File scripts\ops\backup-to-s3.ps1 -DryRun                      # dump + verify only, no AWS creds needed
# powershell -File scripts\ops\backup-to-s3.ps1 -Bucket <b> -AwsProfile <p>  # + upload, verified both ends
# Daily Task Scheduler pair scripts/ops/{install-,}backup-task.ps1; runbook + restore drill docs/ops/s3-backup.md.
# Backs up Postgres ONLY: Neo4j is derived (npm run backfill:graph), Redis is ephemeral, MinIO is opt-in (-IncludeArtifacts).

# Corpus-health snapshot (T24 — the F5/M3 weekly time series)
npm run snapshot:corpus-health    # Append one {ts, corpus_health, confidence_distribution} JSONL line to ~/.kopeng/metrics/corpus-health.jsonl (read-only ops GETs; fail-soft — server down = non-zero exit, no partial line; --out/--url overrides; weekly Task Scheduler pair scripts/ops/{install-,}corpus-health-task.ps1, runbook docs/ops/corpus-health-snapshot.md)
```

