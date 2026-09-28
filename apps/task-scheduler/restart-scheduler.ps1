# ============================================================
# Restart the Claude Task Scheduler: clean, race-free.
# Run as Administrator (right-click > Run with PowerShell as Admin).
#
# Why this exists: start-scheduler.bat has an "exit if already running" guard,
# so simply running the bat or `Start-ScheduledTask` while the old process is
# still alive is a no-op. The correct restart is: KILL the old node process,
# WAIT for it to actually exit, THEN start. Doing the kill and start out of
# order (or without waiting) leaves the scheduler DOWN, which is exactly what
# happened on 2026-06-23. This script does the steps in the right order.
# ============================================================

$ErrorActionPreference = 'Stop'
$taskName = 'Claude Task Scheduler'
$consoleLog = '<SCHEDULER_DIR>\logs\scheduler-console.log'

# The scheduler task runs with RunLevel=Highest (elevated, S4U). A NON-elevated
# shell reads CommandLine/ExecutablePath as EMPTY for that process, so the
# detection below silently matches nothing, the kill is skipped, and the script
# reports success while the old process keeps running. Refuse to run unelevated
# rather than lie about the outcome. (Hit on 2026-07-27.)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: not running as Administrator." -ForegroundColor Red
    Write-Host "The scheduler runs elevated; unelevated this script cannot see or stop it," -ForegroundColor Red
    Write-Host "and would falsely report success. Re-run from an Administrator PowerShell." -ForegroundColor Red
    exit 1
}

function Get-SchedulerProcs {
    Get-CimInstance Win32_Process -Filter "name='node.exe'" |
        Where-Object { $_.CommandLine -like '*scheduler.js*' }
}

Write-Host "=== Restarting '$taskName' ===" -ForegroundColor Cyan

# 1. Kill any running scheduler node process(es)
$procs = Get-SchedulerProcs
if ($procs) {
    foreach ($p in $procs) {
        Write-Host ("Stopping scheduler PID {0} (started {1})" -f $p.ProcessId, $p.CreationDate)
        Stop-Process -Id $p.ProcessId -Force
    }
} else {
    Write-Host "No running scheduler process found (already down)." -ForegroundColor Yellow
}

# 2. Wait for the process(es) to actually exit (up to 15s): this is the step
#    that prevents the "start is a no-op because the old one is still alive" race.
$deadline = (Get-Date).AddSeconds(15)
while ((Get-SchedulerProcs) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
}
if (Get-SchedulerProcs) {
    Write-Host "WARNING: a scheduler process is still alive after 15s. Aborting so we don't end up with two." -ForegroundColor Red
    exit 1
}
Write-Host "Old scheduler stopped." -ForegroundColor Green

# 3. Relaunch via the scheduled task so it comes up with the correct S4U
#    principal (<USER> profile + OAuth creds), same as a boot/logon launch.
Write-Host "Starting scheduled task..."
Start-ScheduledTask -TaskName $taskName

# 4. Verify it actually came back up by watching the console log resume.
Write-Host "Waiting for the scheduler to come back up..."
$startCheck = Get-Date
$up = $false
$deadline = (Get-Date).AddSeconds(30)
$newProc = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    # Require a real process whose start time is AFTER we began the restart.
    # Do NOT accept console-log mtime as proof: the log keeps being written by a
    # still-running old process, which is how this script reported a successful
    # restart on 2026-07-27 while having killed nothing.
    $newProc = Get-SchedulerProcs | Where-Object { $_.CreationDate -gt $startCheck } | Select-Object -First 1
    if ($newProc) { $up = $true; break }
}

if ($up) {
    Write-Host ("Scheduler is back up (new PID {0}, started {1})." -f $newProc.ProcessId, $newProc.CreationDate) -ForegroundColor Green
    # Show the most recent Doppler-injection line as confirmation the new code is live.
    # Only a line stamped AFTER the restart proves anything; an older one is from
    # the previous process and must not be presented as confirmation.
    if (Test-Path $consoleLog) {
        $doppler = Select-String -Path $consoleLog -Pattern 'Loaded \d+ secret' | Select-Object -Last 1
        $dopplerFresh = $false
        if ($doppler -and ($doppler.Line -match '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]')) {
            $dopplerFresh = ([datetime]::ParseExact($matches[1], 'yyyy-MM-dd HH:mm:ss', $null) -gt $startCheck)
        }
        if ($doppler -and $dopplerFresh) {
            Write-Host ("Secret injection confirmed: " + $doppler.Line.Trim()) -ForegroundColor Green
        } elseif ($doppler) {
            Write-Host ("NOTE: newest 'Loaded N secret(s)' line is from BEFORE this restart (" + $doppler.Line.Trim() + "). The new process logs its own on the next cron tick (<=60s); re-check then.") -ForegroundColor Yellow
        } else {
            Write-Host "NOTE: no 'Loaded N secret(s) from Doppler' line seen yet; it logs on the next cron tick (<=60s). Re-check the console log shortly." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "WARNING: scheduler did not appear to come back up within 30s. Check $consoleLog and the 'Claude Task Scheduler' task in Task Scheduler." -ForegroundColor Red
    exit 1
}
