@echo off
REM ============================================================
REM  Claude Task Scheduler — persistent background process
REM  Registered in Windows Task Scheduler with multiple triggers:
REM    - At system startup
REM    - At user logon
REM    - Every hour (with "do not start if already running")
REM ============================================================

REM Clear Claude Code nesting detection so spawned claude sessions work
SET CLAUDECODE=
SET CLAUDE_CODE_ENTRYPOINT=

REM Pin the claude CLI to an absolute path. This task is registered to run as SYSTEM, whose
REM %APPDATA% and PATH do NOT include the user's npm global dir, so a bare `claude` (or an
REM %APPDATA%-derived path) fails with "'claude' is not recognized". scheduler.js also hardcodes
REM this path, but setting CLAUDE_BIN here makes the override explicit for the spawned process.
REM (Caused all claude-type bots to fail 2026-06-13/14 after the hourly SYSTEM relaunch.)
SET CLAUDE_BIN=<USER_HOME>\AppData\Roaming\npm\claude.cmd

REM Check if the node process running scheduler.js is already running
REM (Use PowerShell — wmic is deprecated in Windows 11 and causes false positives)
powershell -Command "if (Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*scheduler.js*' }) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    echo Scheduler node process already running, exiting.
    exit /b 0
)

title Claude Task Scheduler

SET SCHEDULER_DIR=<SCHEDULER_DIR>\JS App
SET SCHEDULER_LOG=<SCHEDULER_DIR>\logs\scheduler-console.log
cd /d "%SCHEDULER_DIR%"
REM Redirect heartbeat to a log file -- the task launches this hidden (no console), so without
REM this redirect the scheduler's console.log output would be lost.
"C:\Program Files\nodejs\node.exe" scheduler.js >> "%SCHEDULER_LOG%" 2>&1
