<#
.SYNOPSIS
  Register (or refresh / uninstall) the "KOPENG Sync Claude Indexes" scheduled task.

.DESCRIPTION
  Idempotent installer. Unregisters any existing task of the same name, then
  registers a daily task that runs scripts/ops/sync-indexes-task.ps1 to keep the
  KOPENG claude-index catalog in sync with ~/.claude/{TOOLS,SKILLS,PROJECT}_INDEX.md.

  The task runs as the CURRENT user with LogonType S4U ("run whether the user is
  logged on or not", no stored password). This is required: the importer reads
  the operator's ~/.claude indexes, so it must NOT run as SYSTEM (whose home
  directory is C:\Windows\System32\config\systemprofile).

  Run this from an ELEVATED PowerShell — registering a scheduled task requires admin.

.PARAMETER Time
  Daily start time, HH:mm (default 04:30). Picked to sit outside typical nightly
  consolidation traffic; the importer takes no consolidation lock, so exact timing
  is not critical.

.PARAMETER TaskName
  Scheduled task name (default "KOPENG Sync Claude Indexes").

.PARAMETER Prune
  Register the task to run with --prune (archive orphaned catalog memories).
  Default is off (sync only; never archive) — flip this on once you trust the run.

.PARAMETER Interactive
  Use LogonType Interactive instead of S4U (task runs ONLY when the user is logged
  on). Use this if S4U fails because the account lacks the "Log on as a batch job"
  right.

.PARAMETER Uninstall
  Remove the task and exit.

.EXAMPLE
  # From an elevated PowerShell, in the repo root:
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1

.EXAMPLE
  # Custom time + enable pruning:
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1 -Time 05:00 -Prune

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-sync-task.ps1 -Uninstall

.NOTES
  Written to be Windows PowerShell 5.1 compatible.
#>
param(
  [string]$Time = '04:30',
  [string]$TaskName = 'KOPENG Sync Claude Indexes',
  [switch]$Prune,
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
$RunnerPath = Join-Path $PSScriptRoot 'sync-indexes-task.ps1'
if (-not (Test-Path $RunnerPath)) { throw "Runner not found: $RunnerPath" }

$RunnerArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`""
if ($Prune) { $RunnerArgs += ' -Prune' }

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument $RunnerArgs `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

$User = "$env:USERDOMAIN\$env:USERNAME"
$LogonType = if ($Interactive) { 'Interactive' } else { 'S4U' }
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType $LogonType -RunLevel Limited

$Description = "Daily sync of ~/.claude/{TOOLS,SKILLS,PROJECT}_INDEX.md into the KOPENG claude-index catalog (npm run sync:indexes). Idempotent + rate-limit-aware. Runs as $User."

Register-ScheduledTask -TaskName $TaskName `
  -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
  -Description $Description | Out-Null

Write-Host "Registered task '$TaskName':"
Write-Host "  Schedule : daily at $Time"
Write-Host "  Run as   : $User (LogonType $LogonType, RunLevel Limited)"
Write-Host "  Prune    : $($Prune.IsPresent)"
Write-Host "  Runner   : $RunnerPath"
Write-Host ""
Write-Host "Run it now to verify:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'   # LastTaskResult should be 0"
Write-Host "Latest log: logs\sync-indexes-*.log"
