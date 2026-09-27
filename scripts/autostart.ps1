<#
.SYNOPSIS
  Start the brain map server automatically when you log on to Windows.

.DESCRIPTION
  Registers (or with -Remove, deletes) a per-user Scheduled Task that runs the
  server windowless under the project venv's pythonw.exe at logon, logging to
  logs\brainmap.log. No administrator rights are needed. The task runs as you,
  binds loopback only (http://127.0.0.1:8770/) and has no run-time limit.
  Safe to run again: it replaces the existing task.

  Watchdog: a second trigger fires every minute. While the server is running
  the new instance is ignored (MultipleInstances IgnoreNew), so it costs
  nothing; if the server dies it is back within a minute. Task Scheduler's own
  "restart on failure" only covers a task that fails to launch, not a process
  that dies later (verified). The flip side: to stop the server for good, use
  -Remove or Disable-ScheduledTask, because killing it brings it back.

.EXAMPLE
  .\scripts\autostart.ps1            # install and start now
  .\scripts\autostart.ps1 -Remove    # stop and uninstall
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'agenticos brain map'
$Root = Split-Path -Parent $PSScriptRoot
$Pythonw = Join-Path $Root '.venv\Scripts\pythonw.exe'
$Server = Join-Path $Root 'brainmap\server.py'
$Log = Join-Path $Root 'logs\brainmap.log'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if ($Remove) {
    Write-Host "Removed '$TaskName'. Any server it had started has been stopped."
    return
}

if (-not (Test-Path $Pythonw)) {
    throw "No project venv at $Root\.venv. Create it first: py -3 -m venv `"$Root\.venv`""
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $Pythonw `
    -Argument "`"$Server`" --log `"$Log`"" -WorkingDirectory $Root
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
# The watchdog needs its own trigger: a repetition hung on the logon trigger
# only arms after a logon fires it (verified: no next run until then). This
# one starts now and repeats every minute indefinitely; with an interactive
# principal it can only run while you are logged on.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$trigger = @($atLogon, $watchdog)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Read-only brain map viewer for the tiered memory system (agenticos). Loopback only, port 8770.' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName': starts at logon; started now. http://127.0.0.1:8770/  (log: $Log)"
