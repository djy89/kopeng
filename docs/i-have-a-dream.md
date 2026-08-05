# Dreaming for KOPENG

> **Purpose of this document**
> Reference doc dropped into the KOPENG directory. It frames the concept of "dreaming" as memory consolidation, the problems it solves, the pitfalls to design around, and the specific way it should be implemented on top of the existing KOPENG stack (Postgres + pgvector, Neo4j, Redis, MinIO, auto-observe hooks).
>
> **KOPENG is model-agnostic.** It is an MCP server that any LLM client can consume — Claude, GPT, local models, future clients not yet built. Nothing in this design ties dreaming to a specific vendor, prompt format, or feature. The dream runner uses whatever LLM is configured for KOPENG's existing inference path; the consolidation logic, schema, and reinforcement model are vendor-neutral.
>
> **KOPENG is single-operator for the foreseeable future.** It is personal infrastructure that may eventually run on a dedicated always-on machine on the operator's private network, with their devices connecting to it. A public service offering is a long-term intent but explicitly out of scope — captured in the Future appendix and *not* designed into the schema or runtime now. See §8 for deployment progression.
>
> The implementing agent should use this as the conceptual brief, then produce an implementation plan and runnable steps. Do not implement against assumptions — read this fully, then propose architecture before writing code.

---

## 1. What KOPENG already is

KOPENG is a standalone, model-agnostic persistence layer exposed as an MCP server. Any LLM client that speaks MCP can consume it. Current state:

- **Storage stack:** Postgres + pgvector (semantic + relational), Neo4j (graph relationships between memories/entities), Redis (working/ephemeral context), MinIO (artifacts).
- **Memory shape:** memories have `content`, `type`, `scope`, `tags`, and embeddings. Search is hybrid (semantic + keyword) with optional cross-encoder rerank.
- **Auto-observe hooks:** memories are being written automatically from tool-use observations.
- **Trigger discovery:** a discovery run already exists to analyze recent observations and surface patterns.
- **Already storing:** feedback/corrections, lessons learned, project context, verification rules.
- **LLM-neutral:** KOPENG calls out to whatever inference endpoint is configured. Embedding model, reranker, and any LLM used for consolidation are all swappable. No vendor lock-in.

This document is about adding a **dreaming layer** on top of all that — not replacing it, and not tying it to any specific model or client.

---

## 2. What "dreaming" means in this context

Dreaming is a scheduled consolidation pass over KOPENG's accumulated memory. Loose analogy to biological sleep: while "awake" (sessions), the system writes incrementally and noisily; while "asleep," it sifts, merges, restructures, and strengthens.

A dream pass:

1. Reads a window of memories + the observations/transcripts that produced them.
2. Detects duplicates, near-duplicates, contradictions, and emerging patterns.
3. Emits a **proposed** updated state — never overwrites the live store directly.
4. Surfaces a diff for review (or that meets criteria for auto-acceptance).
5. Updates reinforcement signals on memories that survived: strength, confidence, last-confirmed timestamp.

The naming is just a metaphor for the consolidation pattern — it doesn't imply any specific vendor's implementation. KOPENG dreaming operates on Postgres rows with embeddings, graph edges, and provenance. The LLM call that performs the actual consolidation reasoning is a swappable component, not a fixed dependency.

### Triggering: scheduled and manual

Dreams fire in two ways:

- **Scheduled (the primary path).** A server-side scheduler running inside KOPENG fires a dream when the operator-offline window opens. Definition of offline: after midnight in the operator's configured local time **and** no active client sessions for ≥15 minutes. The 15-minute idle gate prevents a dream from firing during a late-night work session. If the operator is still active at 12:00am, the scheduler waits.
- **Manual.** Exposed as an MCP tool any connected client can invoke. Same code path as the scheduled trigger, different invocation source. Idempotent — repeated triggers for the same window collapse to one run. Should accept an optional `reason` field for the dream record.

Dreams run server-side on whatever machine KOPENG lives on. They do not depend on any client being connected; the diff/review interface is async and durable. When the operator reconnects, pending dreams are queryable via MCP tool.

---

## 3. Problems KOPENG dreaming is meant to solve

### 3.1 Memory bloat in the vector store
Auto-observe hooks write aggressively. Over weeks, pgvector accumulates near-duplicate entries. Search precision degrades because too many similar vectors compete for top-k slots. Dreams collapse these into single canonical entries with frequency counters.

### 3.2 Contradiction and drift
Preferences and decisions change. "I use `pnpm` for NCM" gets written, then six weeks later I switch to `bun`. Without consolidation, both live in the store and the agent guesses. Dreams detect the contradiction, encode the conditional or the latest value, and demote the stale entry without deleting it.

### 3.3 Cross-session pattern invisibility
A single session can't see that I've done the same scaffolding sequence on three new client projects in a row. Dreams operate across sessions and can encode workflow patterns ("when the operator starts a new vertical agency project, the first three steps are X, Y, Z") that no individual session would record.

### 3.4 Graph staleness
Neo4j edges between entities/memories get added as observations come in. Some of those edges become weak signal over time. Dreams should also touch the graph — strengthening edges that keep getting re-traversed, weakening edges that don't.

### 3.5 The "less correcting, more predicting" goal
The thing I actually want: instead of correcting the LLM every session, the agent predicts what I'm trying to achieve based on accumulated workflow patterns. That requires the memory layer to encode not just facts but **workflow shapes** and **frequency-weighted patterns** — which is exactly what dreaming produces when designed correctly. This holds regardless of which model is on the other end of the MCP connection.

---

## 4. The reinforcement model (the core idea)

This is the part I care most about. Vanilla consolidation is janitorial. The interesting version is reinforcement.

### Frequency-weighted memory strength
Every memory entry should carry:

| Field | Meaning |
|---|---|
| `observation_count` | How many distinct sessions/observations have produced this memory or a near-duplicate |
| `first_seen` | When it first appeared (durability) |
| `last_seen` | When it was last confirmed (recency) |
| `last_contradicted` | When it was last contradicted, if ever |
| `strength` | Derived score: combines count, recency, consistency |
| `confidence` | How sure the system is this is a real pattern vs. coincidence |
| `criticality` | Manual flag — overrides pruning regardless of strength |
| `source_observations` | Provenance — which raw observations produced this |

### Behaviour driven by strength

- **Promotion:** when `observation_count` and `confidence` cross a threshold, a tentative memory in the working layer gets promoted to a durable encoded pattern. The agent now treats it as a learned preference, not a guess.
- **Reinforcement on re-observation:** when a dream pass sees the same pattern in new observations, it increments the count, refreshes `last_seen`, and bumps `strength`. The memory becomes harder to prune.
- **Decay without deletion:** memories that haven't been re-observed in N sessions get their `strength` decayed. They drop in retrieval ranking but are not deleted. They can come back if re-observed.
- **Contradiction handling:** when a new observation contradicts an existing memory, both are kept. The dream pass decides whether this is (a) a clean replacement, (b) a conditional pattern, or (c) noise — and encodes the result with provenance pointing at both.

### Pattern recognition: whole-corpus and windowed
Two modes both need to run:

- **Whole-corpus dream** (weekly?) — read all encoded patterns, find macro-level structure. "The operator's client work clusters into three workflow archetypes." Slow, expensive, high-signal.
- **Windowed dream** (nightly?) — read the last N days of observations and the working-layer memory. Find emerging shifts, recent contradictions, new patterns crossing promotion thresholds. Fast, cheap, catches evolution.

### The end state I'm aiming at
> "Multiple micro-memories of a similar nature form stronger memories. Similarities between memories help it adapt and better understand my workflow. Less correcting and more predicting what I am trying to achieve."

That's reinforcement (count → strength), pattern recognition (similarity clustering across micro-memories), and prediction (strong patterns get used proactively, not just retrieved on demand).

---

## 5. Memory layer separation

Strict separation. Dreams operate on some layers and not others. All layers below are KOPENG-internal except where explicitly noted as external client state.

| Layer | Storage | Dreams touch it? | Notes |
|---|---|---|---|
| **Client-side instructions** (any host-app config: system prompts, project rules, persona files, etc.) | External to KOPENG | **No** | KOPENG doesn't own this. Out of scope. |
| **Promoted workflows / playbooks** | MinIO or filesystem, versioned | **No** | Graduated, durable workflows. Promotion is manual. |
| **Encoded patterns** | Postgres + pgvector, Neo4j edges | **Yes — careful, diff-reviewed** | Promoted from working memory. Reinforced/decayed by dreams. |
| **Working memory** | Postgres + pgvector | **Yes — primary target** | Recent observations, tentative patterns, fair game for consolidation. |
| **Ephemeral context** | Redis | **No** | TTL-based. Dies on its own. |
| **Raw observations / transcripts** | Postgres / MinIO archive | **Read-only input** | Ground truth. Dreams read but never modify. |
| **Artifacts** | MinIO | **No** | Linked from memories, not consolidated. |

The promotion path is: ephemeral (Redis) → working memory (pgvector) → encoded pattern (pgvector + Neo4j edges) → promoted workflow (versioned, manual).

Dreams move things along the middle of that chain. They never touch the ends.

---

## 6. Pitfalls — what the implementation has to defend against

### 6.1 Silent loss of rare-but-critical information
The most dangerous failure mode. A one-time security note, a specific client constraint, a hard-won debugging fix gets pruned as "low frequency." Some single-mention facts are load-bearing.

**Defence:** `criticality` flag, set automatically for certain memory types (security, hard-stop rules, client constraints, verification gates) and settable manually. Critical memories are never auto-pruned regardless of strength.

### 6.2 Cascade failure (dreams feeding on dreams)
If dream N consolidates memories that include the outputs of dream N-1, biases compound. The system reinforces its own mistakes.

**Defence:** dreams always read raw observations as input alongside the current memory state. Output of a dream is a new memory revision, not a transformation of the previous revision. Provenance always points back to raw observations.

### 6.3 Pattern hallucination
The system sees three coincidences and encodes them as a pattern. Wrong patterns acted on confidently waste weeks of debugging.

**Defence:** minimum sample size for promotion (configurable, e.g. ≥5 observations across ≥3 distinct sessions). Confidence score has to clear a threshold. Promotion explanation stored as a memory itself so I can audit why.

### 6.4 Overwriting without preserving provenance
Each consolidation loses a little of what came before. After many passes, the trail is gone.

**Defence:** Postgres rows are versioned. Old versions are marked superseded, not deleted. Neo4j edges carry timestamps. Every encoded pattern has a `source_observations` list pointing to the raw rows that produced it.

### 6.5 Recency bias
Naive consolidation weights recent sessions more heavily simply because they're fresh. A 20-session pattern can get drowned out by last week's anomaly.

**Defence:** strength formula must weight `observation_count` and `first_seen` durability alongside `last_seen`. A pattern seen 20 times over 6 months beats a pattern seen 3 times last week.

### 6.6 Contradiction collapse
When two entries contradict, picking a winner loses the conditional structure. Sometimes the contradiction is the signal ("PowerShell for client work, bash for personal projects").

**Defence:** contradiction handler prefers encoding the condition (`when context = X → A; when context = Y → B`) over picking one. Falls back to picking only when no context distinguisher is found.

### 6.7 Cross-scope contamination
KOPENG scopes memories (per-project, per-client, global). A dream operating on the global scope could pull a project-specific memory into the global pool.

**Defence:** dreams run per scope, not across scopes. Cross-scope pattern detection is a separate, explicit operation with its own review gate.

### 6.8 Style and schema drift in encoded patterns
Each dream rewrites memories. Over many passes, the writing style and structure drift away from conventions.

**Defence:** an explicit memory schema (fields, naming conventions, tag taxonomy) that the dream pass must conform to. Weekly diff review surfaces drift early.

### 6.9 Auto-observe hook amplification
Auto-observe is already aggressive. If dreaming promotes patterns based on observation count, and auto-observe is producing redundant observations, frequency gets falsely inflated.

**Defence:** auto-observe dedup happens before count. Distinct observations are counted by session ID and content hash, not by raw row count.

### 6.10 Graph thrashing
Neo4j edges get added and removed across dream passes. Without care, the graph topology becomes unstable.

**Defence:** edges have their own reinforcement model — strength based on traversal count and re-confirmation. Edges below a threshold are weakened, not deleted, with the same decay-without-deletion principle.

---

## 7. Single-operator now, don't paint into corners

KOPENG is built for one operator on their own hardware. No tenancy, no per-tenant isolation, no rate limiting across tenants, no `tenant_id` columns. That's all premature.

But a few cheap architectural choices now prevent painful rewrites if a public service is ever forked from this codebase:

- **Configurable principal/operator identity.** Don't hardcode "the operator" anywhere in the runtime. Use an `operator_id` field even though it's always set to a single value. The scheduler loop should be written as "schedule a dream for operator X when their quiet window opens" even though X has one value. Loop with one iteration is fine.
- **Database-stored operator config.** Quiet-hours window, timezone, dream cadence, auto-acceptance thresholds, criticality rules, LLM provider preference all live in a config table (one row, for now), not in environment variables or YAML. If a future fork needs many configs, the table just gains rows.
- **LLM reasoner as a swappable interface.** The component that performs consolidation reasoning is a `ConsolidationReasoner` interface with stub-able methods (`merge_candidates`, `detect_contradiction`, `classify_pattern`). Implementation chosen at startup from config. Lets me change providers without touching the dream runner, and lets tests run without any LLM call.
- **No assumptions about co-location.** KOPENG may eventually live on a dedicated server with clients connecting over a private network. The dream runner already runs server-side, so this is mostly already true — just don't write any code that assumes the dream-trigger client and the KOPENG server are the same process.

These are cheap now. Tenancy proper — auth, isolation, rate limits, billing, GDPR-style export/delete — is explicitly **not** in scope and should not be designed into this build.

---

## 8. Deployment progression

The same KOPENG codebase moves through these stages. Dreaming is designed to work at each stage without rewrites.

### Stage 1 (current): local
KOPENG runs on the operator's workstation; clients connect locally. Dream scheduler runs in-process. Operator-offline detection is simple: after midnight operator-local time, ≥15 minutes since last MCP request.

### Stage 2: a dedicated server
KOPENG moves to a dedicated always-on machine on a private network. The operator's devices — laptops, desktops, future agents — connect to it as MCP clients. Dreams fire nightly on the server regardless of which devices are connected. Backup and disaster recovery become real concerns at this stage: if the server dies, every device loses memory simultaneously. The version-chain design helps, but offsite backup of Postgres + Neo4j + MinIO state is required before declaring this stage done.

What changes from Stage 1: nothing in the dreaming logic. The scheduler is already server-side. Operator-offline detection already works on whichever machine KOPENG runs on. The only adjustments are operational (deployment, monitoring, backup).

### Stage 3 (long-term, out of scope): public service fork
See §10 (Future appendix). Treated as a **fork**, not an evolution of this codebase. Different operational envelope, different priorities, different tradeoffs.

---

## 9. What the implementing agent should do with this document

This is the brief. The implementation plan should propose:

1. **Schema additions** to KOPENG's existing Postgres tables to support the reinforcement fields (`observation_count`, `strength`, `confidence`, `criticality`, version chains, provenance arrays). Backwards-compatible migrations.
2. **A `dreams` table** capturing each dream pass: scope, window, input memory revision range, output diff, acceptance status, trigger source (scheduled vs. manual), reason, runtime metadata.
3. **An `operator_config` table** with a single row holding quiet-hours window, timezone, dream cadence, auto-acceptance thresholds, criticality rules, and LLM provider config. Single-row now; structured to allow multiple rows in a future fork without schema change.
4. **The dream scheduler** — server-side daemon (or in-process scheduler loop), fires when operator-offline criteria are met (after midnight operator-local + ≥15 min idle). Reads from `operator_config`. Logs every scheduling decision (fired, skipped because active, skipped because already ran today).
5. **The dream runner itself** — broken into windowed (nightly-style) and whole-corpus (weekly-style) modes. Pluggable so the consolidation logic can evolve without changing the runner. The LLM used for reasoning steps is configured via KOPENG's existing inference path — not hardcoded to a specific provider.
6. **A manual-trigger MCP tool** — same code path as the scheduler, idempotent, accepts an optional reason string. Writes to the `dreams` table with `trigger_source = 'manual'`.
7. **Promotion/decay logic** as a separate, testable module. Pure functions over memory records, no side effects. Easy to unit test. Must not depend on any LLM call.
8. **Contradiction handler** as its own module with the condition-detection logic.
9. **Diff and review interface** — exposed as MCP tools so any client can read pending dreams, accept or reject all/some, and configure auto-acceptance criteria. No client-specific UI.
10. **`ConsolidationReasoner` interface** — abstract interface for the LLM-driven reasoning steps (merge, contradiction, classification). Implementation chosen at startup from `operator_config`. Test stubs included.
11. **Hooks into the existing auto-observe and trigger-discovery layers** rather than rebuilding them.
12. **A test harness** — synthetic memories with known patterns/contradictions/duplicates, run a dream pass, assert the output. Non-negotiable; without it the system can silently corrupt the store. Must run without any LLM call (use stubs for the `ConsolidationReasoner`).

### What I don't want
- Don't rebuild KOPENG. It works.
- Don't introduce tenancy, `tenant_id` columns, or multi-operator concepts. Single operator.
- Don't introduce vendor-specific dependencies. Embedding model, LLM, and reranker stay swappable.
- Don't touch external client state (host-app config files, prompts, personas). Out of scope.
- Don't touch Redis ephemeral context. Out of scope.
- Don't auto-accept dream outputs into the live store until the test harness exists and I've reviewed a few passes by hand.
- Don't ship anything that can't be rolled back. Every dream output should be revertable from the version chain.

### Suggested first runnable step
Before any consolidation logic: write the schema migration (reinforcement fields, `dreams` table, `operator_config` table), and stand up a dream runner that reads memories, produces an empty diff, and writes the dream record. Also stand up the scheduler with offline detection — it can fire the empty-diff runner. No LLM call yet — pure plumbing. That gives us the harness. Consolidation logic plugs into it next. Then promotion. Then contradiction. Then graph. Reinforcement-as-a-formula gets dialed in last, against the test harness.

Propose the plan. Wait for review before writing migrations.

---

## 10. Future appendix: public service offering (out of scope)

Captured here so the intent isn't lost. **Nothing in this section should be implemented now.** When/if I build the public service, it will be a fork of this codebase, not an evolution of the same instance.

**Vision:** KOPENG-as-a-service. Tenants connect their LLM clients via MCP, get a personal memory layer with reinforcement-based dreaming. "Your AI memory gets better while you sleep" as the headline. Dreaming is the product feature, not just an implementation detail.

**What the fork will need that this build deliberately omits:**
- Tenancy (`tenant_id` on every relevant table, isolation, query scoping)
- Authentication and authorization
- Per-tenant LLM provider config (bring-your-own-key vs. pooled provider)
- Per-tenant quiet-hours windows (different timezones, different schedules)
- Per-tenant resource budgeting and rate limiting (fair scheduling, queueing)
- Audit logging, data residency, GDPR-style export and deletion
- A real web UI for diff/review — MCP tools are the right starting point but won't carry the product
- Billing, plan tiers, usage metering
- Operational tooling: per-tenant observability, dream success/failure dashboards, support workflows

**What carries over from this build:**
- Schema for memories and reinforcement fields (adds `tenant_id`)
- Dream runner architecture
- `ConsolidationReasoner` interface
- Promotion/decay and contradiction handler modules
- Test harness pattern
- The conceptual model: reinforcement, evolution, adaptation, prediction over correction

The architectural notes in §7 (configurable operator identity, DB-stored config, swappable reasoner, no co-location assumptions) are the bridge. They keep the fork path open without paying the multi-tenant tax today.
