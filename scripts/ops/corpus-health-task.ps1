<#
.SYNOPSIS
  Scheduled runner for the KOPENG weekly corpus-health snapshot.

.DESCRIPTION
  Invoked by the "KOPENG Corpus Health Snapshot" scheduled task (see
  install-corpus-health-task.ps1). Runs `npm run snapshot:corpus-health`
  against the local live KOPENG server, tees output to a timestamped log under
  logs/, prunes old snapshot logs, and exits non-zero on failure so Task
  Scheduler records the result.

  The snapshot script is append-only and fail-soft: it reads two READ-ONLY ops
  endpoints and appends one JSON line to ~/.kopeng/metrics/corpus-health.jsonl
  (server down => non-zero exit, no partial line). It writes under the running
  user's home directory, so this MUST run as the operator (never SYSTEM).

.PARAMETER Out
  Pass --out <path> through to the snapshot script (override the default
  ~/.kopeng/metrics/corpus-health.jsonl log). Useful for a manual smoke test
  that must not touch the real series.

.PARAMETER Url
  Pass --url <base> through to the snapshot script (default is the script's
  own default, http://localhost:3200).

.NOTES
  Written to be Windows PowerShell 5.1 compatible (Task Scheduler default shell).
#>
param(
  [string]$Out,
  [string]$Url
)

$ErrorActionPreference = 'Stop'

# Repo root = two levels up from scripts/ops/
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$Stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$LogFile = Join-Path $LogDir "corpus-health-$Stamp.log"

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

# Build args: `npm run snapshot:corpus-health [-- <forwarded flags>]`
$Forward = @()
if ($Url) { $Forward += '--url'; $Forward += $Url }
if ($Out) { $Forward += '--out'; $Forward += $Out }
$NpmArgs = @('run', 'snapshot:corpus-health')
if ($Forward.Count -gt 0) { $NpmArgs += '--'; $NpmArgs += $Forward }

("[{0}] kopeng snapshot:corpus-health starting (npm={1}) flags=[{2}]" -f $Stamp, $Npm, ($Forward -join ' ')) |
  Tee-Object -FilePath $LogFile

& $Npm @NpmArgs *>&1 | Tee-Object -FilePath $LogFile -Append
$Code = $LASTEXITCODE

("[{0}] exit={1}" -f (Get-Date).ToString('yyyyMMddTHHmmss'), $Code) |
  Tee-Object -FilePath $LogFile -Append

# Retention: keep the 30 most recent snapshot logs (logs/ is gitignored).
Get-ChildItem $LogDir -Filter 'corpus-health-*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 30 |
  Remove-Item -Force -ErrorAction SilentlyContinue

exit $Code
