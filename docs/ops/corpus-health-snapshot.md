# Weekly Corpus-Health Snapshot (T24 / F5)

Appends a point-in-time corpus-quality snapshot to a dated JSONL log on a
weekly cadence via Windows Task Scheduler. This is the **M3 time series**
behind "dreaming leaves the corpus leaner" — one line per week, diffable over
months.

## What it does

A weekly scheduled task runs `scripts/ops/corpus-health-task.ps1`, which calls
`npm run snapshot:corpus-health`. The script GETs two **read-only** ops
endpoints from the running server:

- `GET /api/ops/corpus-health` — active count, mean confidence, contradiction
  flags, duplicate-pair breakdown (total/actionable/anchored/cross_scope/
  condition_linked), decayed-at-risk count
- `GET /api/ops/confidence-distribution` — per-type / per-tier confidence
  histogram

and appends **one JSON line** to the log:

```json
{ "ts": "<ISO timestamp>", "corpus_health": { ..., "meta": { "sample_size": N, "sampled": true } }, "confidence_distribution": { "by_type": [...], "by_tier": {...} } }
```

It is:

- **Append-only** — never rewrites the series; each run adds exactly one line.
- **Fail-soft** — server unreachable or non-200 → clear error on stderr,
  non-zero exit, **no partial line written** (both endpoints must respond
  before anything touches the log).
- **Read-only against the server** — hits only public ops GETs; takes no
  consolidation lock, mutates nothing.

Default log: `~/.kopeng/metrics/corpus-health.jsonl` (parent dirs created).
Runner output is teed to `logs/corpus-health-<timestamp>.log` (gitignored; 30
most recent kept).

## Why Task Scheduler (not NSSM)

NSSM hosts long-running services (like the `kopeng` server process itself).
This is a periodic one-shot, so it belongs in Task Scheduler — same split as
the daily index sync (`docs/ops/scheduled-sync.md`).

## Why it must run as the operator (not SYSTEM)

The log lives under the **running user's** home directory (`os.homedir()` →
`%USERPROFILE%\.kopeng\metrics`). Under SYSTEM that resolves to
`C:\Windows\System32\config\systemprofile`, so the series would land where
nobody reads it. The installer registers the task to run as the **current
user** with LogonType **S4U** ("run whether logged on or not", no stored
password).

## Manual run

```bash
# Against the live local server, appending to the real series:
npm run snapshot:corpus-health

# Smoke test without touching the real log:
npm run snapshot:corpus-health -- --out ./scratch/corpus-health-verify.jsonl

# Non-default server:
npm run snapshot:corpus-health -- --url http://localhost:3200
```

`--url` defaults to `$KOPENG_API_URL`, else `http://localhost:3200`.

## Install

From an **elevated** PowerShell (registering a scheduled task needs admin), in
the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1
```

Options:

```powershell
# Custom day (default Sunday) and time (default 05:00):
powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1 -DayOfWeek Monday -Time 06:00

# If S4U fails (account lacks "Log on as a batch job"), run only when logged on:
powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1 -Interactive

# Remove the task:
powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1 -Uninstall
```

The installer is idempotent — re-running replaces the existing task.

## Verify

```powershell
Start-ScheduledTask -TaskName 'KOPENG Corpus Health Snapshot'
Get-ScheduledTaskInfo -TaskName 'KOPENG Corpus Health Snapshot'   # LastTaskResult should be 0
Get-Content "$env:USERPROFILE\.kopeng\metrics\corpus-health.jsonl" -Tail 2
```

A healthy run appends one line and the runner log ends with `exit=0`.

## How to read the series

Each line is one snapshot; diff consecutive lines to see the corpus move.
The signals that matter:

- **`corpus_health.duplicate_pairs.actionable`** — the dreaming-health
  diagnostic. Trending to/holding at 0 while `active_memory_count` grows =
  dreaming is keeping up. A large `total` with `actionable = 0` is the healthy
  steady state (anchored + cross-scope pairs are by-design exempt).
- **`corpus_health.decayed_at_risk_count`** — memories under the 0.2 archive
  line. Should stay bounded, not climb monotonically.
- **`corpus_health.contradiction_flagged_count`** — flagged pairs awaiting the
  dream layer. Sustained growth = the contradiction queue isn't draining.
- **`corpus_health.mean_confidence`** — full-corpus, undecayed. Slow drift is
  normal; a step change usually means a bulk operation (triage, crystallize).
- **`confidence_distribution.by_tier`** — the noted→pattern→actionable→
  confirmed shape. Healthy discovery shifts mass rightward over time.
- **`corpus_health.meta.sampled`** — when `true`, duplicate-pair and
  decayed-at-risk counts cover only the first `sample_size` active rows
  (endpoint cost guard) and undercount the full corpus; compare like with
  like across weeks.

Quick eyeball from git-bash:

```bash
tail -5 ~/.kopeng/metrics/corpus-health.jsonl | \
  node -e "process.stdin.on('data',d=>d.toString().trim().split('\n').forEach(l=>{const j=JSON.parse(l);console.log(j.ts, 'active='+j.corpus_health.active_memory_count, 'actionable_dups='+j.corpus_health.duplicate_pairs.actionable, 'at_risk='+j.corpus_health.decayed_at_risk_count)}))"
```

## Troubleshooting

- **`GET ... failed: ECONNREFUSED`** — the `kopeng` NSSM service must be
  running (it's 24/7). `Get-Service kopeng`. No line was written; re-run once
  the server is up.
- **Task runs but the series doesn't grow** — likely running as the wrong user
  (writing under SYSTEM's profile). Confirm the task's principal is the
  operator account, not SYSTEM.
- **S4U registration fails** — re-run with `-Interactive` (runs only while the
  operator is logged on).
- **First poll after a quiet period looks stale** — the corpus-health endpoint
  is memoized in-process for 60s; a weekly cadence never notices.

## Related

- Snapshot script: `scripts/ops/corpus-health-snapshot.ts` (`npm run snapshot:corpus-health`)
- Endpoint semantics: README "REST API" → `/api/ops/corpus-health` (implementation: `src/api/routes.ts`)
- Sibling scheduled task: `docs/ops/scheduled-sync.md` (daily index sync)
- Unit tests: `tests/unit/corpus-health-snapshot.test.ts`
