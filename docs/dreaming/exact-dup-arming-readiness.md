# `auto_accept_exact_dup` arming readiness

Status as of 2026-08-24: **not armed, TWO independent blockers on file, evidence gathered but incomplete.** This doc exists so a future session can pick this up without re-deriving anything below. It is prep only — read-only investigation and one gap-analysis addendum below; no `auto_accept_exact_dup`-gated code has been changed.

## Blocker #2 (Phase 7 / Round 27, 2026-08-21 — added 2026-08-24, was never folded into this doc when filed)

The Phase 7 counterfactual (tracker Round 27; KOPENG memory #8487) hand-reviewed 20 pairs that only became visible as duplicate candidates after the T46 scope-identity work, and found **6 of 20 were genuinely-distinct-referent template noise** reaching the ≥0.95 collapse tier: a reversed sequence bigram, `App.tsx` vs `app.ts` (frontend/backend, not a duplicate), `OrderBookClassicView` vs `OrderBook`, two different-API-file pairs, two scratch tool-result files. This is a **different** blocker from the one this doc otherwise tracks (below) — it was filed with an explicit instruction to "pin the structural argument... in `docs/dreaming/exact-dup-arming-readiness.md`", which did not actually happen until this addendum. Root cause, verified directly against the code (not re-derived from the tracker note):

- The `semantic_duplicate` signal (cosine ≥0.95, content not byte-identical — the tier immediately adjacent to `exact_dup`) already runs a referent guard before it can become a deterministic `merge`: `isDifferentReferent` (`src/dreaming/gates.ts:158`), called from `pipeline.ts:469`.
- But `isDifferentReferent` depends on `extractTemplateReferents` (`gates.ts:110`), which **requires the content to be bullet-list-shaped** (`lines.length >= 2` and at least one `  - item` line) — i.e. it only recognizes the synthesizer's `referent_list` family (key-files/infra-commands lists). For ANY member that isn't list-shaped — every plain-prose `sequence` bigram memory ("Workflow sequence detected: A → B...") and every single-line `repeated_tool`/`repeated_command` memory — `extractTemplateReferents` returns `null`, so `isDifferentReferent` short-circuits to `false` ("not different") at `gates.ts:166` and the pair proceeds toward `merge` if the evidence gates pass.
- **This is a strictly narrower guard than T31's** `referentGuard`/`parseDiscoveryTemplate` (`src/dreaming/contradiction.ts`), which DOES cover `sequence` and `repeated_tool` (now including `repeated_command`, post-Round-23) — but that guard is only wired at the `near_duplicate`/`flagged_contradiction` (reasoner-driven) tiers and the ingestion tier-2 guard. It was never wired into the `semantic_duplicate` collapse-tier check.

**Blast radius, precisely scoped (per the Phase 7 finding, verified consistent with the code):** all resulting entries are `change_class: 'merge'`, which is `deterministic-safe` tier and **always queues** for operator review regardless of any `auto_accept_*` flag (flag-per-class gating; pinned by `dream-apply.test.ts`) — never `exact_dup`, so **there is no live auto-apply path for this specific defect today, fully armed or not.** The actual damage is review-queue pollution (T31's whole reason for existing, recurring at a different tier), not silent data loss. But it is a second, independent, structural reason `auto_accept_exact_dup` should stay OFF until addressed — arming that flag while a sibling tier's guard is known-incomplete is exactly the kind of "trust the subsystem broadly because one part of it is safe" reasoning that both T31 and this defect argue against.

**Not yet done (this addendum is documentation only):** extend `isDifferentReferent`'s coverage to the `sequence`/`repeated_tool` families (most direct: call `parseDiscoveryTemplate` first and fall back to `extractTemplateReferents` only for the `referent_list` shape it doesn't cover — mirroring, not duplicating, T31's logic) OR fold both call sites onto ONE shared referent-extraction function so this class of drift (one guard widened, its sibling forgotten) can't recur. No code has been written for this; it is next-session work, not evaluated for risk of regressing the Phase-0 replay gold set.

## Blocker #1 (original — Round 22/23, T31)

Status as of 2026-08-20, unchanged: **not armed, no blocking defect known, evidence gathered but incomplete.** This doc exists so a future session can pick this up without re-deriving anything below. It is prep only — read-only investigation, no code or config changed.

## What the flag actually gates

`auto_accept_exact_dup` gates ONLY the `exact_duplicate` signal in `DuplicateCandidateSelector` (`src/dreaming/pipeline.ts`): a same-scope union-find component where **every member's `normalizeContent()`** (`content.trim().toLowerCase().replace(/\s+/g,' ')`) **is byte-identical**. That's a much narrower and stricter bar than it sounds like on first read of "exact_dup":

- It does **not** consult `referentGuard` or the reasoner at all — pure deterministic string equality, computed inside the selector before classification ever runs.
- The nearby `semantic_duplicate` signal (cosine ≥0.95, content *not* identical) is a **different**, already-gated path: `isDifferentReferent` (R13/T31 machinery) runs on it before it can become a deterministic `merge`, and even a pass there produces `change_class: 'merge'`, never `exact_dup`.
- So the **T31 fix landed 2026-08-20** (round-22→23, folding `detectRepeatedCommands`'s template into `referentGuard`) does **not** de-risk this flag — it fixed a different tier (`near_duplicate`/reasoner-driven).

## The hypothesis that was checked

Original worry (raised when T31 was discussed): the discovery producers in `heuristics.ts` truncate stored content to `.slice(0, 200)`. Two genuinely different long commands/payloads sharing an identical first-200-char prefix would produce **byte-identical stored `content`** → `normalizeContent` equality → `exact_duplicate` signal → auto-archivable the instant the flag is ON, with zero guard or reasoner involved.

## What was checked live (2026-08-20, read-only, the production Postgres container via `docker exec psql`)

**1. Same-scope+type exact-normalized-content collisions across the WHOLE active corpus, right now:**

```sql
SELECT scope, type, lower(trim(regexp_replace(content, '\s+', ' ', 'g'))) AS norm,
       count(*) AS n, min(length(content)) AS min_len, array_agg(id ORDER BY id) AS ids
FROM memories
WHERE is_archived = false
GROUP BY 1,2,3
HAVING count(*) > 1
ORDER BY n DESC LIMIT 50;
```

Result: **0 rows.** Not one same-scope, same-type, exact-normalized-content collision exists anywhere in the live active corpus. (Also re-ran type-restricted to `discovery` only — also 0.)

**2. How often the truncation boundary is actually hit** (the collision *surface*, independent of whether it's produced a live collision):

```sql
SELECT count(*) FILTER (WHERE length(content) >= 195) AS near_or_at_200,
       count(*) FILTER (WHERE length(content) >= 200) AS at_or_over_200,
       count(*) AS total
FROM memories
WHERE is_archived = false AND type = 'discovery'
  AND (content LIKE 'The operator frequently runs this command in the project:%'
    OR content LIKE 'When working in this project, the operator frequently uses%');
```

Result: **229 of 491 (47%)** repeated_tool/repeated_command discovery rows are at-or-over the 200-char truncation boundary — so truncation itself is common. The absence of collisions in check #1 is not because truncation rarely happens.

## Why zero collisions is the expected result, not luck

Traced the structural reason rather than trusting the empirical zero on its own (small-sample luck is not a safety argument):

- `store()` on both backends (`pg-queries.ts:101,164`) does an exact `content_hash` (SHA256, global unique index) lookup before insert — the doc comment in `apply.ts`/CLAUDE.md already notes this makes raw hash-equality "a stricter, near-impossible bar" for the *exact_dup* apply-time revalidation. Two byte-identical strings can never become two live rows via `store()` at all.
- More importantly for the truncation scenario specifically: discovery ingestion's dedup (`discovery-engine.ts:456`) reinforces rather than creates on **cosine ≥0.95** against an existing candidate match ("Tier 1... pure reinforcement"), and this runs BEFORE a new row is ever created — upstream of `referentGuard`/T31 entirely. Two byte-identical strings (which is what a truncation collision produces) embed to **cosine exactly 1.0** through the same deterministic embedder, always landing in Tier 1. So a truncation collision is structurally absorbed into a reinforcement of the existing memory, not a second row — it never reaches the corpus as two live rows for the dream selector to see, let alone auto-archive.

**Net: the truncation-collision hypothesis, while a real surface (47% hit the boundary), is neutralized by the discovery ingestion path itself, not by anything in the dream/apply layer.** This is a materially different (better) risk picture than what was assumed when T31 was scoped.

## What is NOT yet covered by that reasoning — the actual remaining gap

The Tier-1 reinforce argument only covers memories created **through the discovery ingestion path**. It says nothing about:

1. **Non-discovery write paths** — direct `store_memory` (operator/MCP), `sync:indexes` (already has a *known*, unrelated bug: Round 22 finding — it creates a second catalog row instead of updating on a changed description; confirmed NOT an exact_dup case since descriptions differ, but it proves this write path can produce duplicate-ish rows KOPENG's own dedup doesn't catch), migration/import scripts, or any future write path that bypasses `discovery-engine.ts`'s reinforce check.
2. **Historic rows** predating whatever dedup logic was in place when they were written (D2.2's classify-before-reinforce, the Tier-1 threshold itself, etc. all have landing dates — a row from before a given fix could still be a stale exact_dup risk that the live corpus hasn't happened to surface yet because those pass windows haven't scanned it, or a fixed-since bug already cleaned it out).
3. **Cross-type or cross-scope drift** — the live query is same-scope+type only, matching the selector's own grouping; a scope-alias migration or a `sync:indexes --prune` misstep could in principle put two identical-content rows into what T46/registry now treats as one canonical scope, which this check would then catch on a re-run (worth re-running after any scope-migration work).

None of these are known-active problems today — #1's `sync:indexes` bug is confirmed NOT to produce exact_dup content collisions (verified: the 5 known duplicate pairs differ in description, so `normalizeContent` differs). But they're the reason "0 live collisions today" is evidence, not proof, and why re-running the check #1 query close to the actual arming decision (not relying on this doc's 2026-08-20 snapshot) matters.

## Suggested arming criteria (unchanged in spirit from the original answer, refined with this evidence)

Arm `auto_accept_exact_dup` when:

1. **Re-run check #1 fresh** at arming time (not this doc's snapshot) — still 0, or any hits reviewed by hand and understood.
2. **The `sync:indexes` reconcile bug (Round 22 minor finding #2) is fixed or explicitly ruled irrelevant** — it's the one confirmed live source of "same tool/skill, different content" duplication; low risk for `exact_dup` specifically since it produces content *differences*, but worth closing before trusting an unattended archive path in the same subsystem.
3. **Blocker #2 above is closed** — `isDifferentReferent` covers the `sequence`/`repeated_tool` families the way `referentGuard` already does, or the two are unified. This is the harder-blocking of the two: it's a structural coverage gap in the exact tier family (`semantic_duplicate`) sitting immediately next to the one this flag gates, not just an ingestion-side risk that turned out to be self-neutralizing.
4. **A stretch of live `exact_dup` diff entries has been reviewed manually** with the flag still OFF (dreaming will keep queuing `exact_dup` proposals as `deterministic-safe`/pending regardless of the flag — they're visible via `GET /api/dreams/pending` / the viz review tab without arming anything) — build the same kind of empirical track record `auto_accept_decay` earned over its 6 weeks / 372 archives before it was trusted.
5. **Rollback stays proven for this class specifically** — same bar decay cleared (Round 22: `rollbackMemory` + G1 rescue proven live), not assumed to carry over.

None of this is time-boxed to a date — it's evidence-gated, same posture as decay's arming was retroactively found to be.

## Where to pick this up

- The two SQL queries above are copy-paste ready against the production Postgres container: `docker exec <pg-container> psql -U <user> -d <db> -c "..."` (names in the operator's local notes, deliberately not in this public doc).
- No script was written for check #1 — it was a one-off investigation. If arming work starts, consider whether a `scripts/ops/check-exact-dup-collisions.ts` (read-only, mirrors `propose-scope-aliases.ts`'s posture) is worth adding to `npm run` so criterion #1 becomes a repeatable pre-arming gate rather than a manual psql query pasted from this doc.
- Blocker #2's fix is straightforward TDD scope (RED test constructing a sequence-bigram or repeated_tool pair that currently sails through `isDifferentReferent` as `false`, then extend the function) — no live corpus investigation needed, unlike blocker #1.
- KOPENG memory ID:8285 carries the pointer to this doc for blocker #1 (2026-08-20). KOPENG memory #8487 carries the full Phase 7 counterfactual writeup blocker #2 is drawn from.
