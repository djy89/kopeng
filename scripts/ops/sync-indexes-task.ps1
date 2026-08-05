<#
.SYNOPSIS
  Scheduled runner for the KOPENG claude-index sync importer.

.DESCRIPTION
  Invoked by the "KOPENG Sync Claude Indexes" scheduled task (see
  install-sync-task.ps1). Runs `npm run sync:indexes` against the local live
  KOPENG server, tees output to a timestamped log under logs/, prunes old sync
  logs, and exits non-zero on failure so Task Scheduler records the result.

  The importer is idempotent and rate-limit-aware (it handles HTTP 429 itself),
  so re-running on a cadence only writes the catalog entries that actually
  changed. It reads ~/.claude/{TOOLS,SKILLS,PROJECT}_INDEX.md via the running
  user's home directory, so this MUST run as the operator (never SYSTEM).

.PARAMETER Prune
  Pass --prune through to the importer (archives orphaned catalog memories whose
  external_key no longer appears in any index file).

.PARAMETER DryRun
  Pass --dry-run through to the importer (no writes). Useful for a manual smoke
  test of the wiring without touching the live DB.

.NOTES
  Written to be Windows PowerShell 5.1 compatible (Task Scheduler default shell).
#>
param(
  [switch]$Prune,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Repo root = two levels up from scripts/ops/
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$Stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$LogFile = Join-Path $LogDir "sync-indexes-$Stamp.log"

# Locate npm. Task Scheduler can run with a minimal PATH, so fall back to the
# standard Node install location before giving up.
$Npm = $null
$NpmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($NpmCmd) {
  $Npm = $NpmCmd.Source
} else {
  $Candidate = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
  if (Test-Path $Candidate) { $Npm = $Candidate }
}
if (-not $Npm) { throw 'npm not found on PATH or in Program Files\nodejs' }

# Build args: `npm run sync:indexes [-- <forwarded flags>]`
$Forward = @()
if ($DryRun) { $Forward += '--dry-run' }
if ($Prune)  { $Forward += '--prune' }
$NpmArgs = @('run', 'sync:indexes')
if ($Forward.Count -gt 0) { $NpmArgs += '--'; $NpmArgs += $Forward }

("[{0}] kopeng sync:indexes starting (npm={1}) flags=[{2}]" -f $Stamp, $Npm, ($Forward -join ' ')) |
  Tee-Object -FilePath $LogFile

& $Npm @NpmArgs *>&1 | Tee-Object -FilePath $LogFile -Append
$Code = $LASTEXITCODE

("[{0}] exit={1}" -f (Get-Date).ToString('yyyyMMddTHHmmss'), $Code) |
  Tee-Object -FilePath $LogFile -Append

# Retention: keep the 30 most recent sync logs (logs/ is gitignored).
Get-ChildItem $LogDir -Filter 'sync-indexes-*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 30 |
  Remove-Item -Force -ErrorAction SilentlyContinue

exit $Code
