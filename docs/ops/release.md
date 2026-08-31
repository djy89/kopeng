# Release Runbook (Install Strategy release pipeline)

How a `kopeng` release actually ships: version bump -> tag -> CI proves it
installs on every supported platform -> operator-gated publish to npm.
Covers `.github/workflows/release.yml` (Task 2.5.3) and
`scripts/ci/install-smoke.mjs` (Task 2.5.1).

## What CI does for you

Pushing a `v*` tag (or a manual "Run workflow" dispatch) runs three jobs, in
order:

1. **`pack`** — `npm ci` -> `npm run build` -> `npx vitest run tests/unit` ->
   `npm pack` -> uploads the resulting tarball as a build artifact
   (`kopeng-tarball`). This is the exact release candidate every later job
   installs and (if everything passes) publishes — never rebuilt per
   platform.
2. **`smoke`** — downloads that same tarball and runs
   `scripts/ci/install-smoke.mjs` against it on five platforms in parallel
   (`fail-fast: false`, so one platform's failure doesn't hide another's):
   `ubuntu-latest` (x64), `ubuntu-24.04-arm` (arm64), `windows-latest` (x64),
   `macos-latest` (arm64), `macos-15-intel` (x64, Intel). Each run is a REAL
   `npm install` of the tarball into a sandbox, then the installed CLI's
   `init --non-interactive` (real embedding-model download, real server,
   real client-config wiring against a fake `HOME`), `canary` (a real store
   -> embed -> recall round trip), then `uninstall --yes` and
   `uninstall --yes --purge` — never against your real machine, your real
   `~/.kopeng`, or port 3200.
3. **`publish`** — runs only from a **tag** on the **public** repo
   (`if: github.ref_type == 'tag' && github.repository == 'djy89/kopeng'`),
   only once `smoke` is green on every platform, and only after an
   environment approval. Publishes the SAME tarball `pack` built, with
   `npm publish --provenance --access public`.

`ci.yml` (the push/PR gate) is untouched — this is a separate workflow that
only ever fires on a version tag or a manual dispatch. **A manual dispatch
runs `guard` -> `pack` -> `smoke` and stops there**; it cannot publish. That
is deliberate: dispatching this workflow is how the 5-platform install smoke
gets run on demand, and doing so must never risk an immutable npm publish
(T74 — it did, until 2026-08-30).

## Which repo publishes (T74)

**Releases publish from the PUBLIC repo, `djy89/kopeng` — not from
`djy89/kopeng-dev`.** This is a hard requirement, not a preference:

- npm dropped provenance from **private** source repositories in July 2023.
  `npm publish --provenance` from `kopeng-dev` fails with "Unsupported GitHub
  Actions source repository visibility. Only public source repositories are
  supported when publishing with provenance."
- Provenance also requires package.json's `repository` to match the repo you
  publish from. Ours already reads `git+https://github.com/djy89/kopeng.git`.
- GitHub gates **environment protection rules** (required reviewers) behind a
  paid plan on private repos; they are free on public ones.

This matches how releases already worked — the signed tags `v1.0.0` and
`v1.1.0` live on the public repo. `release.yml` reaches the public repo
through the export manifest's recursive `.github` include, so there is only
ever ONE copy of this workflow to maintain. Sync the mirror before tagging.

## One-time setup (operator)

Set these up on the **public** repo. Until both exist, a pushed tag stops
cleanly after a green `smoke` and nothing further happens (no error — the job
is just gated open).

1. **`NPM_TOKEN` repo secret** — an npm **automation** token (Settings ->
   Secrets and variables -> Actions -> "New repository secret", named
   `NPM_TOKEN`) with publish rights on the `kopeng` package.
   *Preferred alternative:* **npm trusted publishing** via OIDC went GA
   2025-07-31 and needs no long-lived token at all (it also requires a public
   repo). It sidesteps the fact that npm 2FA blocks non-interactive CLI
   publishes. Consider it before minting another token.
2. **`npm-publish` GitHub Environment** — **DONE 2026-08-30** on
   `djy89/kopeng`: `required_reviewers: [djy89]`, verified via
   `gh api repos/djy89/kopeng/environments/npm-publish`. Optionally restrict
   it to the `v*` tag pattern under "Deployment branches and tags" as well.

Both are one-time. Every future release's `publish` job now waits for your
approval before it touches npm.

## Cutting a release

1. **Version bump.** Update `version` in `package.json` to the new semver
   (`npm version <patch|minor|major>` works, or edit it directly — either
   way, **RULING-A: semver in `package.json` is THE version**, surfaced at
   runtime by `GET /api/health` and checked by `doctor`'s server-vs-local
   skew warning).
2. **CHANGELOG.md**: promote the `## [Unreleased]` section to
   `## [X.Y.Z] — YYYY-MM-DD`, and start a fresh empty `## [Unreleased]`
   above it for the next round of changes.
3. **README v2** ships in the same release as this pipeline (Task 2.6) —
   confirm it reflects the version being cut before tagging.
4. Commit the bump: `git commit -am "chore(release): vX.Y.Z"`.
5. **Sync the public mirror.** *(Maintainer step — the export tooling and its
   runbook live in the private development repo and are not part of this
   cut.)* The tag must be cut on `djy89/kopeng`, so the version bump has to
   land there first. Skipping this is the easy mistake: a tag pushed to the
   development repo runs `guard`/`pack`/`smoke` and then silently skips
   `publish`, because `publish` is public-repo-only.
6. **Tag and push** — on the public repo, signed:
   ```bash
   git --git-dir="$GD" tag -s vX.Y.Z -m "vX.Y.Z"
   git --git-dir="$GD" push origin vX.Y.Z
   ```
   The tag push is what triggers `release.yml`. Verify the signature took:
   `gh api repos/djy89/kopeng/git/tags/<sha> --jq .verification.verified`.
7. **Watch CI**: `pack` then `smoke` (all five platforms) must go green.
   A `smoke` failure names the exact step that failed (see "Reading a smoke
   failure" below) — fix it on `main`, delete the tag (`git push --delete
   origin vX.Y.Z && git tag -d vX.Y.Z`), and re-tag once fixed. Never publish
   a tag whose smoke run failed.
8. **Approve the publish**: Actions -> the release run -> "Review
   deployments" -> approve. The `npm-publish` environment on the public repo
   requires it (configured 2026-08-30), so `publish` will wait here.
9. **First publish only**: if `NPM_TOKEN` isn't set up yet, `publish` never
   runs. Publish that one release by hand instead —
   `npm publish --provenance --access public` from a clean checkout of the
   **public** repo at the tag (provenance fails from a private checkout),
   using your own npm account with 2FA. Set up the secret — or trusted
   publishing — afterward so every subsequent release is automated.
10. **Post-publish sanity, on one real machine** (not CI, not a container —
   the point is to prove the thing a user will actually run):
   ```bash
   npx kopeng@latest init
   ```
   Confirm it completes, `kopeng doctor` passes, and `kopeng viz` opens.
   **Manual spot-check (Windows, spaced profile path):** the install-smoke
   sandbox's own paths never contain a space, so CI cannot prove the win32
   npm-install argument quoting (`src/cli/npm-spawn.ts`, Task 2.5 fix round
   1) survives a real spaced path end to end — `tests/unit/npm-spawn.test.ts`
   proves the quoting algorithm and a real cmd.exe round-trip, but not the
   whole `kopeng init` flow. Before (or shortly after) a release that
   touches `src/cli/npm-spawn.ts`, run `npx kopeng@latest init` once on a
   Windows account whose profile path contains a space (e.g. a local account
   named with a space, or any `C:\Users\<First Last>\...` profile) and
   confirm it completes cleanly.

## Reading a `smoke` failure

`install-smoke.mjs` names the step that failed — check the job log for a
line like:

```
install-smoke FAILED at step 'init': kopeng init exited with code 1
```

Steps, in order: `sandbox` (temp-dir setup) -> `npm-install` (bootstrap
install of the tarball) -> `init` (the real install + its own internal
doctor/canary + the post-init assertions: server health, `.env`'s
`ADMIN_API_KEY`, the ensure knob, and the 5 wired client hooks) -> `canary`
(a second, standalone canary run through the installed CLI) -> `uninstall`
(plain uninstall + its assertions: app dir gone, data kept, client configs
clean) -> `purge` (`uninstall --purge` on the same sandbox + the
zero-residue assertion).

A `npm-install` failure whose log contains a node-gyp/prebuild-install
signature (missing prebuilt binary, missing MSBuild/make/Python) means that
platform+Node combination has no prebuilt native binary and no local build
toolchain — see Task 2.5.2's `diagnoseNpmFailure` (`src/cli/init.ts`), which
prints the same plain-language diagnosis to anyone hitting this during a
real `kopeng init`, not just in CI.

The script always tries to stop any server it started (the shutdown
endpoint first, then a platform-specific "whatever is listening on port
3299" kill) and always deletes its sandbox, even on failure — a red `smoke`
run should never leave a runner in a dirty state that explains a later
flake.

## Running the smoke script yourself

Useful before ever pushing a tag, or to reproduce a CI failure locally:

```bash
npm run build
npm pack
node scripts/ci/install-smoke.mjs kopeng-*.tgz
```

It creates its own temp sandbox (a fake `HOME`/`USERPROFILE` and
`KOPENG_HOME`, port 3299) under your OS temp dir by default — override the
parent directory with `INSTALL_SMOKE_ROOT=<dir>` if you want it somewhere
specific. It never touches your real `~/.kopeng`, your real client configs,
or port 3200.
