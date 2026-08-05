<#
.SYNOPSIS
  Register (or refresh / uninstall) the "KOPENG Corpus Health Snapshot" scheduled task.

.DESCRIPTION
  Idempotent installer. Unregisters any existing task of the same name, then
  registers a WEEKLY task that runs scripts/ops/corpus-health-task.ps1 to append
  a point-in-time corpus-quality snapshot (corpus-health + confidence
  distribution) to ~/.kopeng/metrics/corpus-health.jsonl — the M3 time series
  behind "dreaming leaves the corpus leaner".

  The task runs as the CURRENT user with LogonType S4U ("run whether the user is
  logged on or not", no stored password). This is required: the snapshot writes
  under the operator's ~/.kopeng, so it must NOT run as SYSTEM (whose home
  directory is C:\Windows\System32\config\systemprofile).

  Run this from an ELEVATED PowerShell — registering a scheduled task requires admin.

.PARAMETER Time
  Weekly start time, HH:mm (default 05:00). Picked to sit outside typical
  nightly consolidation traffic; the snapshot takes no consolidation lock and
  only hits read-only endpoints, so exact timing is not critical.

.PARAMETER DayOfWeek
  Day the weekly task fires (default Sunday).

.PARAMETER TaskName
  Scheduled task name (default "KOPENG Corpus Health Snapshot").

.PARAMETER Interactive
  Use LogonType Interactive instead of S4U (task runs ONLY when the user is logged
  on). Use this if S4U fails because the account lacks the "Log on as a batch job"
  right.

.PARAMETER Uninstall
  Remove the task and exit.

.EXAMPLE
  # From an elevated PowerShell, in the repo root:
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1

.EXAMPLE
  # Custom day + time:
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1 -DayOfWeek Monday -Time 06:00

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-corpus-health-task.ps1 -Uninstall

.NOTES
  Written to be Windows PowerShell 5.1 compatible.
#>
param(
  [string]$Time = '05:00',
  [System.DayOfWeek]$DayOfWeek = [System.DayOfWeek]::Sunday,
  [string]$TaskName = 'KOPENG Corpus Health Snapshot',
  [switch]$Interactive,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  throw 'This installer must be run from an ELEVATED (Run as administrator) PowerShell.'
}

# Remove any existing task first (idempotent install + the -Uninstall path).
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed existing task '$TaskName'."
}

if ($Uninstall) {
  Write-Host "Uninstalled. Done."
  return
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RunnerPath = Join-Path $PSScriptRoot 'corpus-health-task.ps1'
if (-not (Test-Path $RunnerPath)) { throw "Runner not found: $RunnerPath" }

$RunnerArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`""

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument $RunnerArgs `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $Time

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

$User = "$env:USERDOMAIN\$env:USERNAME"
$LogonType = if ($Interactive) { 'Interactive' } else { 'S4U' }
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType $LogonType -RunLevel Limited

$Description = "Weekly corpus-health snapshot: appends /api/ops/corpus-health + /api/ops/confidence-distribution to ~/.kopeng/metrics/corpus-health.jsonl (npm run snapshot:corpus-health). Read-only endpoints, append-only log. Runs as $User."

Register-ScheduledTask -TaskName $TaskName `
  -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
  -Description $Description | Out-Null

Write-Host "Registered task '$TaskName':"
Write-Host "  Schedule : weekly on $DayOfWeek at $Time"
Write-Host "  Run as   : $User (LogonType $LogonType, RunLevel Limited)"
Write-Host "  Runner   : $RunnerPath"
Write-Host ""
Write-Host "Run it now to verify:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'   # LastTaskResult should be 0"
Write-Host "Latest log: logs\corpus-health-*.log"
