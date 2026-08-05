# Scheduled Sync — claude-index catalog (C1)

Keeps the KOPENG **claude-index** catalog fresh by running the importer
(`npm run sync:indexes`) on a daily cadence via Windows Task Scheduler. This is
the scheduled driver for the C1 static-surfacing importer — the one locked C1
decision that was previously manual-only.

## What it does

A daily scheduled task runs `scripts/ops/sync-indexes-task.ps1`, which calls
`npm run sync:indexes`. The importer parses
`~/.claude/{TOOLS,SKILLS,PROJECT}_INDEX.md` and upserts them into KOPENG as
`type: 'reference'`, confidence **0.55** catalog memories
(`client:claude-tool` / `client:claude-skill` / `project:<slug>`). It is:

- **Idempotent** — content-hash dedup + external-key reconcile; unchanged entries are no-ops.
- **Rate-limit-aware** — prefetch + 429-aware retry (server limit is 100 req/min).
- **Live-DB-writing** — it targets the running production server at `http://localhost:3200`.

Output is teed to `logs/sync-indexes-<timestamp>.log` (gitignored; 30 most recent kept).

## Why Task Scheduler (not NSSM)

NSSM hosts long-running services (like the `kopeng` server process itself). This
is a periodic one-shot, so it belongs in Task Scheduler.

## Why it must run as the operator (not SYSTEM)

The importer reads the indexes from the **running user's** home directory
(`os.homedir()` → `%USERPROFILE%`). Under SYSTEM that resolves to
`C:\Windows\System32\config\systemprofile`, where the `.claude` indexes do not
exist. The installer registers the task to run as the **current user** with
LogonType **S4U** ("run whether logged on or not", no stored password).

## Install

From an **elevated** PowerShell (registering a scheduled task needs admin), in the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1
```

Options:

```powershell
# Custom time (HH:mm) and enable pruning of orphaned catalog memories:
powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1 -Time 05:00 -Prune

# If S4U fails (account lacks "Log on as a batch job"), run only when logged on:
powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1 -Interactive

# Remove the task:
powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1 -Uninstall
```

The installer is idempotent — re-running replaces the existing task.

## Verify

```powershell
Start-ScheduledTask -TaskName 'KOPENG Sync Claude Indexes'
Get-ScheduledTaskInfo -TaskName 'KOPENG Sync Claude Indexes'   # LastTaskResult should be 0
Get-Content (Get-ChildItem logs\sync-indexes-*.log | Sort-Object LastWriteTime -Desc | Select -First 1) -Tail 20
```

A healthy run ends with `Sync complete: N created / M updated / K skipped / 0 errors`
(a steady-state run is mostly `skipped`).

## Manual / smoke test

The runner forwards `-DryRun` and `-Prune` to the importer:

```powershell
# No writes — just exercise the wiring:
powershell -ExecutionPolicy Bypass -File scripts\ops\sync-indexes-task.ps1 -DryRun
```

## Troubleshooting

- **`Cannot reach KOPENG server`** — the `kopeng` NSSM service must be running
  (it's 24/7). `Get-Service kopeng`.
- **Task runs but writes nothing / errors on every entry** — likely running as
  the wrong user (can't see `~/.claude`). Confirm the task's principal is the
  operator account, not SYSTEM.
- **S4U registration fails** — re-run with `-Interactive` (runs only while the
  operator is logged on).
- **Re-running the importer too aggressively** — it's idempotent and
  rate-limit-aware, so a daily cadence is safe; avoid sub-minute loops.

## Related

- Importer: `scripts/sync-claude-indexes.ts` (`npm run sync:indexes`)
- Surfacing endpoint: `src/surfacing/surface.ts` (`POST /api/surface`)
