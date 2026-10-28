<#
.SYNOPSIS
    Stops JobsNotifier and removes its scheduled task.

.DESCRIPTION
    Without -Apply this only shows what would be removed.
    Your WhatsApp session (auth\), database (data\), logs and .env are NOT deleted.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1 -Apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$TaskName = "JobsNotifier"
)
$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "No scheduled task named '$TaskName' exists."
} else {
    Write-Host "Will stop the bot and unregister task '$TaskName' (state: $($task.State))."
    Write-Host "  Program  : $($task.Actions[0].Execute)"
    Write-Host "  Arguments: $($task.Actions[0].Arguments)"
}

if (-not $Apply) {
    Write-Host "Preview only - nothing was changed. Re-run with -Apply."
    exit 0
}

& (Join-Path $PSScriptRoot "stop-bot.ps1")

if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' removed. auth\, data\, logs\ and .env were left in place."
}
