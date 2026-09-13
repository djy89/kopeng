# Testing: harness detail and the server-free rule

> Extracted verbatim from CLAUDE.md (2026-09-07).

## The no-running-server rule and its two exceptions

- **No test needs a running server.** Integration tests build an in-process Fastify app and drive it with `app.inject` (Round 7 SF5); CI runs them alongside the unit suite. Only the eval harnesses (`npm run eval*`, `discover`) and the live drill talk to a real server or provider. **One env-gated exception (Phase 5):** `tests/integration/pg-executed-sql.test.ts` runs real SQL against a Postgres named by `KOPENG_PG_TEST_URL` — self-skips when the var is unset (repo `.env` counts: the file loads dotenv itself, since the vitest `KOPENG_ENV_FILE` pin makes config.ts's own dotenv call a no-op for the repo `.env`), so plain `npm test` stays server-free; CI runs it in a dedicated job against a pgvector service container. It TRUNCATEs, so it refuses any database without a standalone `test` name token or holding rows it didn't create. **And one deliberately-UNGATED exception (Phase 8):** `tests/integration/recall-canary.test.ts` starts its own in-process server on an ephemeral loopback port (`app.listen({port: 0})`) and loads the REAL embedding model (a cold `models/` dir downloads it) — the canary's semantic-recall proof is meaningless with synthetic vectors and the child-process hook needs a real port, so it runs in every `npm test` by design; no operator-started server is ever needed.

## Suite detail


- Framework: Vitest with `globals: true`
- Tests: `tests/unit/` and `tests/integration/`
- Test helpers: `tests/fixtures/test-helpers.ts` — `createTestDatabase()` creates in-memory SQLite, `createTestMemory()` builds test fixtures, `createTestObservationsDb()` creates in-memory observations DB, `createTestObservation()` builds observation fixtures
- Unit tests run against in-memory SQLite (no server needed)
- Integration tests build an in-process Fastify app (`app.inject`) — no running server (see the Environment note; the pre-R7 "server must be running" claim is long gone)
- Phase-4 nets: `tests/integration/server-wiring.test.ts` — behavioral closure probes over the real `composeServer()`, one named probe per alias/registry consumer (closure-dependent by construction; probes 2/4/7 carry captured RED/counterfactual evidence, and mutate-and-confirm 2026-08-20 spot-verified probe 7 fails when its closure is un-threaded); `tests/unit/decay-predicate-composition.test.ts` — the four-consumer archive-line equality net (promotion / dream decay tier / maintenance §2 / corpus-health panel over one 12-row seeded corpus, set-equality per consumer) plus the CR-5 grep-guard against the eliminated drift shape (a strength/confidence identifier compared `<`/`<=` against a literal `0.2`; known evasions in Round 24, backstopped by the set-equality groups)
- PG executed-SQL suite (`tests/integration/pg-executed-sql.test.ts`, Phase 5): the one suite that talks to a real database — env-gated on `KOPENG_PG_TEST_URL` (self-skips otherwise), destructive-guard rules in its header; CI runs it in the `pg-executed-sql` job (pgvector service container, `KOPENG_PG_REQUIRED=1` so broken env wiring fails instead of green-skipping). CI also runs `dream:drill --no-llm` and the gated `dream:effectiveness` in the main matrix
- Coverage excludes `src/index.ts` and `src/tools/**` (MCP entry point and HTTP-only tool handlers)
- Timeout: 30s for tests and hooks (model loading can be slow)

