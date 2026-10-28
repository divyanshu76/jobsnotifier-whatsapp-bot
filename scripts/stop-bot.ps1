<#
.SYNOPSIS
    Stops a running JobsNotifier (supervisor and bot) for this project folder only.
    Does not touch the scheduled task definition, the WhatsApp session, data or logs.

.DESCRIPTION
    First asks the bot to stop cleanly (it finishes a send in progress, closes the database
    and exits normally, so the supervisor and the scheduled task end too). Only if that does
    not happen in time are the processes ended forcibly.
#>
[CmdletBinding()]
param(
    [string]$TaskName = "JobsNotifier",
    [int]$TimeoutSeconds = 75
)
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $ProjectDir "scripts\supervisor.js"
$Bot = Join-Path $ProjectDir "index.js"
$StopFile = Join-Path $ProjectDir "data\stop.request"

function Get-BotProcesses([string]$scriptPath) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($scriptPath) }
}

$wasRunning = (Get-BotProcesses $Bot) -or (Get-BotProcesses $Supervisor)

# 1. Clean stop: the bot polls for this file every 2 seconds.
if (Get-BotProcesses $Bot) {
    Write-Host "Asking the bot to stop cleanly..."
    New-Item -ItemType File -Force -Path $StopFile | Out-Null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (((Get-BotProcesses $Bot) -or (Get-BotProcesses $Supervisor)) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
}

# 2. Fallback: end the scheduled task (so Task Scheduler does not relaunch it) and the processes.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
    Write-Host "Ending scheduled task '$TaskName'"
    Stop-ScheduledTask -TaskName $TaskName
}
foreach ($p in @(Get-BotProcesses $Supervisor) + @(Get-BotProcesses $Bot)) {
    Write-Host "Process $($p.ProcessId) did not exit cleanly; stopping it"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item $StopFile -Force -ErrorAction SilentlyContinue
if ($wasRunning) { Write-Host "Stopped." } else { Write-Host "JobsNotifier is not running." }
