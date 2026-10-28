<#
.SYNOPSIS
    Creates a Windows scheduled task that starts JobsNotifier after you log in.

.DESCRIPTION
    Without -Apply this only PRINTS the task it would create; nothing is changed.
    The task runs as you (no password stored, no admin rights), starts 1 minute after
    logon, runs hidden, never times out, and allows only one instance.
    It launches scripts\supervisor.js, which restarts the bot after a crash.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1           # preview
    powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1 -Apply    # create
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Update,
    [switch]$StartNow,
    [string]$TaskName = "JobsNotifier"
)
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $ProjectDir "scripts\supervisor.js"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$PowerShellExe = Join-Path $PSHOME "powershell.exe"
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Quote([string]$s) { "'" + $s.Replace("'", "''") + "'" }

# powershell.exe only hosts node with a hidden window. No secrets are passed: the bot reads .env itself.
$Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& $(Quote $Node) $(Quote $Supervisor)`""

$Action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $Arguments -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Trigger.Delay = "PT1M"
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Description = "JobsNotifier: hourly sarkariresult.com check -> WhatsApp group. Project: $ProjectDir"

Write-Host "Scheduled task '$TaskName'"
Write-Host "  Runs as      : $User (only when logged in, standard rights, no stored password)"
Write-Host "  Trigger      : at logon of $User, delayed 1 minute"
Write-Host "  Program      : $PowerShellExe"
Write-Host "  Arguments    : $Arguments"
Write-Host "  Start in     : $ProjectDir"
Write-Host "  Settings     : one instance only; no time limit; runs on battery; Task Scheduler retries launch 3x / 1 min"
Write-Host "  Crash restart: scripts\supervisor.js (backoff 10s..10min, gives up after 10 crashes/hour)"
Write-Host "  Logs         : $ProjectDir\logs\bot.log, supervisor.log (rotated at 5 MB, 5 kept)"
Write-Host ""

if (-not (Test-Path (Join-Path $ProjectDir ".env"))) { Write-Warning ".env not found - create it before the task runs." }
if (-not (Test-Path (Join-Path $ProjectDir "auth\creds.json"))) { Write-Warning "WhatsApp is not linked yet - run 'npm run login' first, or the bot will stop immediately." }

# Refuse to create a second task that runs this same project under another name.
$duplicates = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -ne $TaskName -and ($_.Actions | Where-Object { "$($_.Arguments)" -like "*$Supervisor*" })
}
if ($duplicates) {
    Write-Error "Another scheduled task already runs this bot: $($duplicates.TaskName -join ', '). Remove it first."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    $a = $existing.Actions[0]
    $same = $a.Execute -eq $PowerShellExe -and $a.Arguments -eq $Arguments -and $a.WorkingDirectory -eq $ProjectDir
    if ($same -and -not $Update) {
        Write-Host "Task '$TaskName' already exists with the same action (state: $($existing.State)). Nothing to do."
        exit 0
    }
    if (-not $Update) {
        Write-Host "Task '$TaskName' exists with a DIFFERENT action:"
        Write-Host "  Program  : $($a.Execute)"
        Write-Host "  Arguments: $($a.Arguments)"
        Write-Host "  Start in : $($a.WorkingDirectory)"
        Write-Host "Re-run with -Apply -Update to replace it."
        exit 1
    }
}

if (-not $Apply) {
    Write-Host "Preview only - nothing was changed. Re-run with -Apply to create the task."
    exit 0
}

Register-ScheduledTask -TaskName $TaskName -Description $Description `
    -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force:$Update | Out-Null
Write-Host "Task '$TaskName' registered. It will start at your next logon."

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Task started now."
}
