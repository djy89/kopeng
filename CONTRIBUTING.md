# Contributing

Thanks for your interest. KOPENG is a single-maintainer project with production-ops discipline; small, well-tested contributions are welcome. Issues (bug reports, design questions) are just as valuable as PRs.

Open an issue for anything about the code — that's the fastest route and it leaves a record others can find. For anything that doesn't belong in public, email `hello@kopeng.net`. Security vulnerabilities go through neither; see [SECURITY.md](SECURITY.md).

## Ground rules

- **Licensing:** the project is under the [Business Source License 1.1](LICENSE) (converts to Apache 2.0 on the change date). By submitting a contribution you agree it is licensed under the same terms, and you certify you have the right to submit it (Developer Certificate of Origin, in spirit).
- **Don't destabilize the consolidation invariants.** The deterministic engine owns and performs every write; the reasoner only classifies pairs and can never select a write the reasoner-off baseline wouldn't perform; every write that changes an existing memory (archive/merge/supersede/contradiction-mark) is snapshot-first and audited. PRs that weaken these are non-starters — the invariants are the product.
- **No linter/formatter.** Strict `tsc` (`npm run build`) is the only static gate. Match the style of the surrounding code.

## Dev setup

```bash
npm install
cp .env.example .env
npm run dev        # REST server, watch mode
```

## Before you open a PR

```bash
npm run build          # strict tsc — must be clean
npm test               # full vitest suite (in-memory SQLite, no server needed)
npm run dream:replay   # if you touched src/dreaming/ — zero-LLM regression net, must exit 0
```

Integration tests (`tests/integration/`) build an in-process Fastify app (`app.inject`) — no running server needed — and CI runs them alongside the unit suite.

**Backend coverage is asymmetric, so be careful when you touch a store.** The suite exercises **SQLite for real**; PostgreSQL has only adapter-level coverage against a mocked pool (`tests/unit/pg-dream-queries.test.ts`), and CI runs no live Postgres. A change that passes green can still be broken on PG. If you touch `IMemoryStore`/`IObservationStore`, update **both** implementations and say in the PR that the Postgres path is unverified — a maintainer will exercise it against a real instance.

## Conventions

- ESM throughout, `.js` extensions in imports, strict TypeScript.
- New server dependencies go into the `AppContext` (`src/types/app-context.ts`), not route signatures.
- Anything that mutates memories from an autonomous path must go through the audited apply path (`src/dreaming/apply.ts`) — no exceptions.
- Tests use the fixtures in `tests/fixtures/` (`createTestDatabase()`, hand-crafted unit-vector embeddings). Keep the replay harness zero-LLM.
- **Invent fixture content. Never copy it from a real system.** A memory system's test corpora are written to look like real memories, which makes them the easiest place for real hostnames, internal service names, client names, or personal details to end up — and the hardest place to notice them, because a plausible-looking fake is exactly what the fixture is supposed to contain. This has bitten this repo: a drill fixture described a real private automation, and a host nickname sat in four gold-set files for months. Neither is the kind of thing a secret scanner catches; both read as ordinary prose. Use obviously-synthetic referents (`the staging cluster`, `the build server`, `acme-service`) and reserved ranges (`192.0.2.0/24`, `example.com`) — the same rule applies to doc examples and benchmark prompts.
