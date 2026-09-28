# ============================================================
# Setup Windows Task Scheduler for Claude Task Scheduler
# Run this script as Administrator (right-click > Run as Admin)
# ============================================================
$logFile = "<USER_HOME>\AppData\Local\Temp\setup-task-output.txt"
function Log($msg) { $msg | Tee-Object -FilePath $logFile -Append; }
Log "=== setup-windows-task.ps1 started $(Get-Date) ==="

$taskName = "Claude Task Scheduler"
$vbsPath = "<SCHEDULER_DIR>\start-scheduler.vbs"
$workDir = "<SCHEDULER_DIR>"

# Remove old task if it exists
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Log "Removing existing task..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Log "Existing task removed."
}

# Action: run via wscript (window=0 = hidden) so no console window appears
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $workDir

# Triggers: startup + at logon + every 4 hours as safety net.
# AtStartup (with the S4U principal below) fires headless after a reboot WITHOUT interactive login.
# AtLogon fires a full interactive-token instance whenever the user logs in (the bat duplicate-guard
# prevents a second process). Repeat every 4h is the safety net / self-heal.
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "<WIN_USER>"
$triggerRepeat = New-ScheduledTaskTrigger -Once -At "05:00AM" `
    -RepetitionInterval (New-TimeSpan -Hours 4) `
    -RepetitionDuration (New-TimeSpan -Days 365)

# Principal: run as the user via S4U ("run whether or not user is logged on", no stored password).
# S4U loads the user profile + registry hive, so %USERPROFILE%/%APPDATA% resolve to the user's and the
# claude binary + live, self-refreshing OAuth token (<USER_HOME>\.claude\.credentials.json) are
# read directly. SYSTEM could NOT see those (its profile is the systemprofile dir), which caused the
# 6/13 "'claude' is not recognized" then 6/14-6/15 "Not logged in" failures. S4U still fires headless
# after reboot without an interactive login, so it keeps SYSTEM's only real advantage.
$principal = New-ScheduledTaskPrincipal -UserId "<WIN_USER>" -LogonType S4U -RunLevel Highest

# Settings: restart on failure, don't stop on battery, allow on AC+battery
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

# Register the task
try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $triggerStartup, $triggerLogon, $triggerRepeat `
        -Principal $principal `
        -Settings $settings `
        -Description "Persistent node-cron scheduler for Claude Code headless tasks. Auto-restarts on failure. Runs as <USER> via S4U so it has the user profile + live OAuth credentials, and still fires headless after reboot without an interactive login."
    Log "Task registered successfully."
} catch {
    Log "ERROR registering task: $_"
}

Log ""
Log "Task '$taskName' created successfully with:"
Log "  - Principal: <WIN_USER> via S4U (user profile + live OAuth creds; still headless after reboot)"
Log "  - Trigger: At system startup"
Log "  - Trigger: At logon (<USER>)"
Log "  - Trigger: Every 4 hours (safety net)"
Log "  - Restart on failure: 3 retries, 5 min apart"
Log "  - StartWhenAvailable: Yes (catches missed triggers after reboot)"
Log "  - Skip if already running: Yes"
Log ""
Log "The batch file checks if the scheduler is already running before starting."
