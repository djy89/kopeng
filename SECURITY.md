# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository ("Security" tab → "Report a vulnerability"). Please do not open a public issue for anything exploitable.

You can expect an acknowledgment within a few days. This is a single-maintainer project — there is no security team and no bug bounty, but reports are taken seriously and fixes are prioritized over feature work.

If private reporting is unavailable to you (no GitHub account, or the tab is missing), email `hello@kopeng.net` with the details and I'll open the advisory. Prefer the GitHub channel when you can — it keeps the disclosure timeline and the fix in one place.

## Threat model (read this before reporting)

KOPENG is a **local developer preview**: self-hosted, single-operator infrastructure designed to run on a machine you own, bound to loopback. **Remote deployment is unsupported for the preview**, even with all keys configured — if you route to it over a private VPN or an authenticating reverse proxy, that outer boundary is required and is yours to provide. Several properties are deliberate design decisions, not vulnerabilities:

- **Reads are unauthenticated by design — the whole read surface, not just ops.** `/api/stats`, `/api/ops/*`, `/api/observations/stream` (SSE), the replay endpoints, memory listing, the POST-shaped reads (`/api/memories/recall`, `/search`, `/surface`, `/traverse` — called by the recall hooks on every prompt with no key), and the keyless `GET /api/operator-config`, which exposes operator settings including the scope-alias map (i.e. client names). The consequence to understand on a shared machine: **any local process that can reach the port can read the whole corpus.** The mitigation is network placement and machine hygiene, not auth. Do not expose port 3200 to untrusted networks.
- **Operator mutations require the admin key, and there is no keyless default.** On first run the server resolves `ADMIN_API_KEY` (precedence: non-empty launch env > non-empty `.env` value) or **generates one into `.env`** (written atomically, mode `0600` on POSIX — the key must not be readable by other local accounts); if `.env` cannot be written, the boot is refused with instructions rather than proceeding keyless (`tests/unit/first-run.test.ts`). The key gates memory create/update/archive and batch, slots, Redis context, MinIO artifacts, graph writes, operator-config PATCH, dream trigger/resolve, memory rollback, and admin promote/reindex/backup/discover/discovery-maintain (`X-API-Key` header; pinned by `tests/unit/core-crud-auth.test.ts` — mutations 401 without the key, reads never 401).
- **Observation ingestion — OFF on the preview path — uses its own separate, optional key when enabled** (`OBSERVATION_API_KEY`, `X-API-Key` header). Deliberately a *separate* key from the admin key: it is distributed to hook clients on several machines and must not carry admin power. The flip side: the admin key alone does not gate ingestion writes, so an install that enables ingestion on a non-loopback bind needs both keys — which the bind policy below enforces.
- **Non-loopback binds refuse to boot without both keys, and are unsupported regardless.** "Loopback" is exactly `localhost`, `::1`, or a real IPv4 address whose first octet is `127` (a hostname like `127.example.test` is *not* loopback — `tests/unit/bind-refusal.test.ts`). Any other `HOST` refuses to boot unless both `ADMIN_API_KEY` and `OBSERVATION_API_KEY` are set, naming the missing key(s) and this file. The refusal exists because the keys gate mutations only: reads stay public, so **the bind address remains the primary control**, and widening it hands read access to the network no key can take back. Because memories are recalled into a model's context on later prompts, an unauthenticated write would be a persistent prompt-injection channel, not just a data-integrity problem — that channel is what the mandatory admin key closes. The bind check runs against the *resolved* key state, before any generation, so a refused non-loopback boot generates and persists nothing — a missing `ADMIN_API_KEY` on a non-loopback `HOST` is a refusal naming the key, never a silently minted fresh key on a wide bind.
- **The bundled viz proxy binds loopback by default** and injects the admin key server-side (the browser never holds it). Remote-binding it (`VIZ_HOST=0.0.0.0`) is an explicit opt-in. On a remote bind the proxy **refuses every non-GET method** (403) unless `VIZ_ALLOW_REMOTE_ADMIN=1`, so a remote viz is genuinely read-only rather than merely admin-key-less — the method restriction is enforced at the proxy precisely because it must hold even when no API key is configured. VPN-only either way.
- **Secret scrubbing is defense-in-depth, not a guarantee.** Tool-use observations pass through two scrub layers (client hook + server preHandler, keyword and format-based) plus a content denylist that rejects `curl|sh` / reverse-shell / URL-payload shapes. Bypasses of the scrubber are in scope and welcome as reports.
- **The optional LLM reasoner is classify-only; the deterministic engine owns and performs every write.** A known, documented, contained finding (R15, GATE 2 review): the classify prompt is injectable via memory content, which can force a verdict. On the **dream consolidation** path a forced verdict can only *queue* a review entry (reasoner-driven entries never auto-apply). On the **discovery ingestion dedup** path (0.85–0.95 similarity band) a forced `duplicate` produces the same *reinforce* that runs when no reasoner is configured — a confidence bump (capped at 0.85) plus an access-clock reset on the existing memory, its content unchanged, recorded in `reinforcement_history`. So a verdict can steer routing toward *safer* outcomes but cannot trigger any write the reasoner-absent baseline would not perform, and it can never rewrite content, archive, or supersede. The pre-filter that catches classifier-directed content is a best-effort English-pattern denylist. Novel escalations from a forced verdict to an unaudited *content* mutation are very much in scope.

## In scope

- Auth bypass on endpoints that do enforce a key
- Scrubber bypasses that persist secrets into observations or memories
- Any path from reasoner output (or memory content) to an unaudited store mutation
- SQL injection, path traversal, SSRF in any route
- Memory-poisoning vectors that survive the content denylist

## Out of scope

- Reports assuming the API is exposed to the public internet or reachable from untrusted networks (remote deployment is unsupported for the preview — see the threat model above)
- Missing auth on the deliberately-open read endpoints listed above
- Denial of service via the local, unauthenticated surface

## Known dependency advisories

`npm audit --omit=dev` reports **5 residual advisories (1 critical, 4 high)**, all in a single dependency chain. It is retained deliberately — it is not reachable in KOPENG's runtime — and tracked for a future major-version bump:

- **`@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`, plus `sharp`** (1 critical + 4 high). KOPENG loads one fixed, locally-cached **text** embedding model (`all-MiniLM-L6-v2`). The protobufjs RCE gadget requires loading an attacker-controlled `.proto`/JSON descriptor via reflection (`protobuf.load()`), which `onnx-proto` never calls — it uses precompiled static message classes for wire-format decode only. `sharp`'s libvips image codepath is never exercised for text feature-extraction. `@xenova/transformers@2.x` is the final 2.x line and pins these transitive versions; the remediation is the migration to `@huggingface/transformers` (backlogged).
Fastify's own advisory chain was cleared by the move to Fastify 5, and the `@modelcontextprotocol/sdk` → `@hono/node-server` moderates (a Windows path-traversal in `serve-static`, in the SDK's bundled HTTP/SSE transport that KOPENG never constructs) were cleared by refreshing the SDK to 1.30.0 within its existing `^1.0.0` range — no override, no API change. A reachable exploit demonstrated through the residual chain in KOPENG's actual configuration is in scope.

**Development-only advisories are not counted above.** A full `npm audit` additionally reports findings reachable only through the test/coverage toolchain and the dev runner's build dependency. They do not ship, are absent from a `npm ci --omit=dev` install, and are excluded from the production number by design — the figure that matters for a deployment is `npm audit --omit=dev`.
