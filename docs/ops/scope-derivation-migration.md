# Scope-Derivation Migration — `project:<basename>` → `project:<owner>-<repo>` (RULING-C, WS7.6)

The recall/observe hooks no longer mint `project:<basename(cwd)>`. They derive
`project:<owner>-<repo>` from the nearest `.git` remote (`scripts/hooks/project-scope.mjs`),
overridable per-directory by a `.kopeng.json` `project` key, with `basename(cwd)`
kept only as the no-remote/no-marker fallback. This is a **supervised,
one-operator migration** — nothing in this deploy auto-moves existing rows.
Old-basename scopes and new-derived scopes coexist safely (T46's alias layer
was built for exactly this kind of client-side rename); this runbook is about
converging them deliberately, on your schedule.

The commands below assume a from-source checkout (the `scripts/ops/*` drivers
are not in the published tarball) and:

```bash
export KOPENG_API_URL=http://localhost:3200   # your server
export ADMIN_API_KEY=…                        # from your .env, if set
```

## Why this needs a runbook, not a script

- Two repos historically sharing a basename (`api` under two different clients)
  now derive to two different scopes — that's the fix working as intended, not
  drift to repair.
- Two directories that used to derive to *different* basenames but are actually
  the same repo (a rename, a relocated clone) now derive to the *same* remote
  scope — that convergence is the win, but it means an old scope's rows need to
  either get an alias entry or get bulk-moved, and only the operator knows
  which old scopes are "the same project, finally reunified" versus "two
  genuinely different things that happened to share a folder name."
- `PRIMARY_SCOPE` and any `.kopeng.json` markers naming an old basename need a
  human decision about whether to update them to the new derived name or pin
  them explicitly (a marker `project` override always wins over the remote, so
  a stale marker is a silent trap otherwise).
- **The corpus itself cannot tell you what changed.** The hooks keep no record
  of what a directory used to derive to, and — see the next section — the drift
  detector is structurally blind to this rename class. The only reliable
  old→new anchor is a scope inventory you capture *before* you deploy.

## `active_rows_adrift` is NOT a check for this migration

Do not verify this migration with `GET /api/ops/scope-drift`. It cannot see
this rename class, and it will read clean whether you converged everything or
nothing.

`slugifyScope` (`src/scopes/resolver.ts`) folds case and separators and nothing
else, and `clusterScopes` (`src/scopes/drift.ts`) groups scopes by the resulting
slug *part*. `project:kopeng` slugs to the part `kopeng`; `project:djy89-kopeng`
slugs to `djy89-kopeng`. Different parts ⇒ different groups ⇒ each is emitted as
a `passthrough` singleton, and passthrough rows never enter `clusters` at all —
so they contribute nothing to `clusters_uncovered`, `clusters_actionable`, or
`active_rows_adrift`. Adding `<owner>-` to a name is exactly the transformation
the fold does not model.

The consequence, if you ignore this: you deploy, run a session per project,
curl scope-drift, read `clusters_actionable: 0` / `active_rows_adrift: 0`, and
conclude there is nothing to converge — while every project-scoped memory
written before the merge sits on a scope recall no longer queries.

Scope-drift keeps its normal job (watching for NEW casing/separator drift) and
has exactly one use here, in step 6: `data.summary.alias_entries_rejected`
tells you whether the alias entries you wrote were actually accepted.

## Steps

### 1. BEFORE deploying: snapshot the scope inventory

This is the only reliable old→new anchor, and it is only capturable while the
old scopes are still the ones being written to. Do it first.

```bash
curl -s "$KOPENG_API_URL/api/stats" | jq '.data.by_scope' > pre-merge-scopes.json
```

`by_scope` is `{scope: active_row_count}` over non-archived rows
(`IMemoryStore.getScopeStats`). Keep this file for the whole migration —
steps 4 and 6 both read it.

If you have already deployed, you are not stuck: nothing moved your rows, so
`/api/stats` still lists every old scope. You just have to tell old from new by
name yourself, which is precisely what the snapshot spares you.

### 2. Deploy, then run one real session per active project

After the server + hooks are updated, open one Claude Code (or Codex) session
per project you actively work in and issue any prompt long enough to trigger
recall (`MIN_PROMPT_LEN`, ~25 chars). This is enough for the hooks to compute
and use the new derived scope going forward — no batch step is required for
new writes to land correctly.

### 3. Let the registry mint the new scopes

New scopes get registry rows at the write choke point, not at recall time. The
row you want — the one carrying the claiming directory — is minted when the
discovery engine resolves an observation's scope, so it appears after the next
detection cycle, and **only if `DISCOVERY_DETECTION_ENABLED=true`**. A direct
API/MCP write also mints a row, but registers `origin_cwd: null` (an explicit
write carries no cwd), which is no use for mapping.

The same is true of any project whose writes are all direct — its registry row
carries no directory to match on. In both cases the remedy is identical and
registry-independent: `pre-merge-scopes.json` is the authoritative list of what
existed before, and step 4's `comm` diff of pre- vs post-merge `/api/stats`
keys is the authoritative list of what appeared after. The registry is a
convenience for naming the pairs, never the source of the pair list.

With detection off, skip ahead: you will map old→new by name from
`pre-merge-scopes.json` and your own knowledge of the repos, and the rest of
the runbook is unchanged.

### 4. Build the old→new list from the registry

```bash
curl -s "$KOPENG_API_URL/api/ops/scope-registry" \
  | jq '.data.rows | map({scope, claimant_raw, origin_cwd, status, first_seen})'
```

`origin_cwd` is what links a new scope back to an old one: it names the
directory that claimed the scope, and that directory is the same one whose
basename produced the old scope. Cross-reference it against
`pre-merge-scopes.json`:

```bash
# scopes that exist NOW but did not exist before the deploy
comm -13 \
  <(jq -r 'keys[]' pre-merge-scopes.json | sort) \
  <(curl -s "$KOPENG_API_URL/api/stats" | jq -r '.data.by_scope | keys[]' | sort)
```

Write the pairs down. There is no automated mapping — the hooks have no memory
of what a directory used to derive to, and `origin_cwd` is populated only for
the observation-minted rows above.

A project that produced **no** new registry row and no new scope is usually a
`.kopeng.json` `project` override pinning the old basename (step 7) — that key
wins over the remote, so the directory never moves.

### 5. Per pair, converge it — and the route is NOT a free choice

Decide first whether the old scope's bare name is generic. `isGenericCapture`
(`src/scopes/resolver.ts`) **rejects** any alias entry whose key is
`project:<generic-name>` and whose canonical has a different bare name. The
generic set (`GENERIC_BASENAMES`, verbatim) is:

```
web, backup, platform, src, dist, build, app, apps, api, docs, doc, test,
tests, tmp, temp, data, lib, main, code, project, new, old, work, repo,
server, client, frontend, backend, admin, assets, public, scripts, config
```

`project:web → project:acme-web` is rejected — which is exactly the collision
this derivation change exists to fix, so it is a case you will hit. A name like
`kopeng` is not in the set, so `project:kopeng → project:djy89-kopeng` is fine
by the alias route. Note the rule constrains **alias-table entries only**;
`project:api` remains a perfectly legal scope to store rows under. And note the
asymmetry: only the KEY is tested, so a generic name on the right
(`project:kopeng → project:data`) is not a capture.

**Option A — alias entry** (non-generic keys only; keeps the old scope
readable, canonicalizes new writes):

Use the **validated** ruling endpoint, not a raw `PATCH /api/operator-config`:

```bash
curl -s -X POST "$KOPENG_API_URL/api/admin/scopes/rule" \
  -H "Content-Type: application/json" -H "x-api-key: $ADMIN_API_KEY" \
  -d '{"scope":"project:old-basename","action":"merge_into","target":"project:owner-repo"}' | jq
```

The raw `PATCH /api/operator-config` path is a trap here: that handler never
runs `buildScopeResolution`. It returns `200`, the entry is written, and the
resolver drops it later at load time with only a `logger.warn` — so a rejected
entry looks like a success and (per the section above) shows up in no drift
number either. `POST /api/admin/scopes/rule` runs the same shared resolver
before writing and refuses a bad entry to your face.

Responses worth knowing:

- `200` — the entry landed, the old scope's registry row is confirmed, and
  `meta.follow_ups` names the two commands you may want next.
- `400 … rejected: generic_capture` — the key is in the list above. Use
  option B; there is no alias route for it.
- `400 … would break accepted alias "…"` — your new entry would knock an
  existing, working entry out of the accepted table. Rethink the pair.
- `400 … is reserved` — a system row (`project:_unrouted`, a rename
  tombstone). Never a migration target.
- `404 No registry row for scope "…"` — the old scope predates the registry
  and has had no writes since. There is nothing to rule on; use option B.

After an alias entry, rows **stay on the old scope** — recall reaches them by
expanding the alias group. If you also want them physically moved:

```bash
npm run migrate:scope-aliases -- --only project:old-basename            # dry-run
npm run migrate:scope-aliases -- --only project:old-basename --apply
```

**Option B — bulk move** (required for generic keys; also the route when you
want the old scope gone rather than aliased):

```bash
npx tsx scripts/ops/migrate-project-scope.ts --from project:old-basename --to project:owner-repo
# review the dry-run output, then:
npx tsx scripts/ops/migrate-project-scope.ts --from project:old-basename --to project:owner-repo --apply
```

Dry-run by default; `--apply` is required to write. Each row moves via an
audited `PUT /api/memories/:id` (never direct SQL). Respects the server's rate
limit with retry-after backoff.

### 6. Verify per scope — not with a drift number

**After option B (bulk move)** the old scope must be empty of active rows.
`GET /api/memories` is exact-match on `scope` by default (no alias expansion),
which is exactly what makes it a valid emptiness proof:

```bash
curl -s "$KOPENG_API_URL/api/memories?scope=project:old-basename&limit=1&fields=lite" \
  | jq '.data | length'    # expect 0

curl -s "$KOPENG_API_URL/api/stats" \
  | jq '.data.by_scope["project:owner-repo"]'   # expect the old count, from pre-merge-scopes.json
```

**After option A (alias)** the old scope is still populated by design, so check
two different things instead — that the table accepted your entry, and that the
rows are reachable under the new name:

```bash
# 0 means the resolver accepted every entry in your table.
curl -s "$KOPENG_API_URL/api/ops/scope-drift" | jq '.data.summary.alias_entries_rejected'

# A row stored on project:old-basename must come back under the new scope.
curl -s -X POST "$KOPENG_API_URL/api/memories/recall" \
  -H "Content-Type: application/json" \
  -d '{"query":"<a phrase you know is in an old memory>","scopes":["project:owner-repo"],"limit":3}' \
  | jq '.data | map({id, scope})'
```

Seeing `"scope": "project:old-basename"` in that recall result is the pass: the
row is where it always was, and the new scope now reaches it.

Repeat both checks per pair. There is no single number that answers this for
the whole corpus — that is the point of the section above.

### 7. Update `PRIMARY_SCOPE` and any pinning `.kopeng.json` markers

- `PRIMARY_SCOPE` (env) and `operator_config.primary_scope` (column, takes
  precedence over the env at runtime) — if either names an old basename scope,
  update it to the new derived name:

  ```bash
  curl -s -X PATCH "$KOPENG_API_URL/api/operator-config" \
    -H "Content-Type: application/json" -H "x-api-key: $ADMIN_API_KEY" \
    -d '{"primary_scope":"project:owner-repo"}' | jq
  ```

  (or `{"primary_scope": null}` to clear it and fall back to
  `project:_unrouted` triage). The column is validated against `isScopeForm`,
  so a malformed value is a 400 — unlike the `config` blob, this key is checked.

- Any `.kopeng.json` `project` key pinning an old basename — a marker override
  always wins over the remote-derived scope, so a stale one silently keeps a
  directory on the old name forever, and that directory will simply never show
  up in step 4. Update it to the new derived scope (or remove the override if
  the plain remote derivation is now correct) — a marker's `scopes` array key
  (the P4 additive-recall-scopes feature) is unrelated and does not need
  touching.

## Local client caches self-heal — no action needed

- **Sequence/trigger-term caches** (`~/.kopeng/cache/sequences_{project}.json`,
  `~/.kopeng/cache/canonical_triggers_{project}.json`) are keyed by the derived
  project scope. The first prompt after cutover simply misses (cold cache for
  the new name) and repopulates on that miss — TTL-driven, no manual clear.
- **Session breadcrumbs** (`~/.claude/session-data/<project>.last-session.json`)
  are keyed by the derived bare name. **One orphaned OLD breadcrumb per active
  project is expected at cutover** — the last breadcrumb written under the old
  `basename(cwd)` name is never read again once the hooks derive the new name.
  It is inert (a small JSON file with no reader) and safe to delete manually or
  leave in place; it does not reappear or cause drift.

## Related

- Derivation module: `scripts/hooks/project-scope.mjs` (`deriveProjectScope`)
- Alias layer: `CLAUDE.md` § Scope-Alias Layer (T46), § Shared Scope Definition (Phase 1)
- Alias-entry validation: `src/scopes/resolver.ts` (`buildScopeResolution`, `GENERIC_BASENAMES`, `isGenericCapture`)
- Registry/minting/rulings: `CLAUDE.md` § Scope Registry & Minting (Phase 3)
- Drift detector (and why it does not apply here): `src/scopes/drift.ts` (`clusterScopes`), `GET /api/ops/scope-drift`
- Bulk movers: `scripts/ops/migrate-project-scope.ts`, `scripts/ops/migrate-scope-aliases.ts`
