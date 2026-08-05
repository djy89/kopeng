<#
.SYNOPSIS
  Register (or refresh / uninstall) the "KOPENG Ollama Serve" scheduled task.

.DESCRIPTION
  Idempotent installer. Unregisters any existing task of the same name, then
  registers an AT-BOOT task that runs `ollama serve` so the local dream reasoner
  provider is up before KOPENG's nightly consolidation fires — no manual start,
  no "armed but dark" reasoner (the failure the T21 ops surface now catches).

  The task runs as the CURRENT user with LogonType S4U ("run whether the user is
  logged on or not", no stored password). This is required: `ollama serve` reads
  the operator's model cache (~/.ollama) and must NOT run as SYSTEM (whose home
  is C:\Windows\System32\config\systemprofile — a different, empty model store).

  There is NO execution time limit: the task is a long-lived service, not a
  batch job. It restarts on failure so an Ollama crash relaunches, and uses the
  IgnoreNew multiple-instance policy so a boot fire is a no-op when a manual
  `ollama serve` (or a prior task instance) already holds port 11434.

  Run this from an ELEVATED PowerShell — registering a scheduled task requires admin.

.PARAMETER TaskName
  Scheduled task name (default "KOPENG Ollama Serve").

.PARAMETER OllamaPath
  Full path to ollama.exe. Default: auto-detect via Get-Command, falling back to
  %LOCALAPPDATA%\Programs\Ollama\ollama.exe (the standard Windows install).

.PARAMETER Interactive
  Use LogonType Interactive instead of S4U (task runs ONLY when the user is logged
  on). Use this if S4U fails because the account lacks the "Log on as a batch job"
  right.

.PARAMETER Uninstall
  Remove the task and exit.

.EXAMPLE
  # From an elevated PowerShell, in the repo root:
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-ollama-task.ps1

.EXAMPLE
  # Point at a non-standard ollama.exe:
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-ollama-task.ps1 -OllamaPath 'D:\tools\ollama\ollama.exe'

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-ollama-task.ps1 -Uninstall

.NOTES
  Written to be Windows PowerShell 5.1 compatible.
  Runbook: docs/dreaming/reasoner-setup.md (section "Keep Ollama running: boot task").
#>
param(
  [string]$TaskName = 'KOPENG Ollama Serve',
  [string]$OllamaPath,
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

# Resolve ollama.exe: explicit param > PATH > standard Windows install location.
if (-not $OllamaPath) {
  $cmd = Get-Command 'ollama' -ErrorAction SilentlyContinue
  if ($cmd) {
    $OllamaPath = $cmd.Source
  } else {
    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $fallback) { $OllamaPath = $fallback }
  }
}
if (-not $OllamaPath -or -not (Test-Path $OllamaPath)) {
  throw "Could not locate ollama.exe. Install Ollama or pass -OllamaPath 'C:\path\to\ollama.exe'."
}

$Action = New-ScheduledTaskAction -Execute $OllamaPath -Argument 'serve'

$Trigger = New-ScheduledTaskTrigger -AtStartup

# No time limit (long-lived service), restart on crash, and don't start a second
# instance if one is already serving. Zero ExecutionTimeLimit == unlimited.
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$User = "$env:USERDOMAIN\$env:USERNAME"
$LogonType = if ($Interactive) { 'Interactive' } else { 'S4U' }
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType $LogonType -RunLevel Limited

$Description = "At-boot `ollama serve` so the KOPENG dream reasoner provider is up before nightly consolidation. Runs as $User (S4U), no time limit, restarts on crash."

Register-ScheduledTask -TaskName $TaskName `
  -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
  -Description $Description | Out-Null

Write-Host "Registered task '$TaskName':"
Write-Host "  Trigger  : at system startup"
Write-Host "  Run as   : $User (LogonType $LogonType, RunLevel Limited)"
Write-Host "  Execute  : $OllamaPath serve (no time limit, restart x3)"
Write-Host ""
Write-Host "Start it now to verify (or reboot):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'   # LastTaskResult should be 0 (or 267009 = still running)"
Write-Host "  curl http://localhost:11434/api/tags          # provider reachable"
Write-Host "Then confirm the ops surface: GET /api/ops/reasoner-status shows reachable:true."
