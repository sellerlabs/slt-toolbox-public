# task-scheduler (engine)

A JSON-queue-driven task runner for Claude Code headless tasks on Windows. You
edit `schedule.json` to add, remove or enable tasks; the running process re-reads
the file (5s poll) and picks up changes **without a restart**. That no-restart
property is the whole point: slot a task into the queue whenever you want.

This is the **engine only**. You bring your own `schedule.json` and your own task
instruction files.

## What it does beyond plain cron

- **Hot reload**: saving `schedule.json` is the whole deploy. A JSON parse error
  keeps the previous schedule running and logs the failure.
- **Missed-run catch-up**: a ledger in `logs/last-runs.json` records each task's
  last successful run, so a fire missed while the process was down is replayed
  once on the next startup (50-hour lookback).
- **One-time jobs**: use `runAt` (ISO datetime with offset) instead of `cron`. The
  job fires once, is claimed in `logs/one-time-runs.json` before it spawns (so it
  never double-fires across a crash), then is removed from `schedule.json` and
  archived to `logs/one-time-history.json`.
- **Retry on transient API errors** (429/5xx/overloaded/connection drops) with
  exponential backoff. Genuine failures are not retried.
- **Self-reported failure detection**: an agent that gives up still exits 0. Runs
  whose output says they could not do the work are not recorded as successful.
- **Failure alerts to Slack** from the parent process, so an alert cannot be
  blocked by the same failure that broke the task.
- **Subscription billing guard**: `ANTHROPIC_API_KEY` is always stripped from the
  spawned `claude` environment, so scheduled runs never bill at API rates.

## Setup

```bash
cd "JS App"
npm install
cd ..
cp schedule.example.json schedule.json
```

Then replace the placeholder tokens below with your own values. The mirrored
scripts have machine-specific values scrubbed to placeholders; search and
replace these across the folder before running:

| Placeholder | Replace with |
|-------------|--------------|
| `<SCHEDULER_DIR>` | Absolute path to this `task-scheduler` folder |
| `<USER_HOME>` | Your home dir, e.g. `C:\Users\yourname` |
| `<WORKSPACE>` | Your Claude Code workspace root path |
| `<WIN_USER>` | Your Windows principal, `DOMAIN\username` (or `COMPUTERNAME\username`) |
| `<WIN_HOST>` | Your computer or domain name |
| `<USER>` | Your OS username |

### Files that reference these placeholders

| File | Contains |
|------|----------|
| `schedule.json` | Your task queue. Set `settings.projectRoot` to your workspace path. |
| `start-scheduler.bat` | `CLAUDE_BIN` (`<USER_HOME>`), `SCHEDULER_DIR` and `SCHEDULER_LOG` (`<SCHEDULER_DIR>`). |
| `start-scheduler.vbs` | `<SCHEDULER_DIR>`. |
| `restart-scheduler.ps1` | `$consoleLog` (`<SCHEDULER_DIR>`). |
| `setup-windows-task.ps1` | `$vbsPath`, `$workDir` (`<SCHEDULER_DIR>`), `$logFile` (`<USER_HOME>`), and the principal (`<WIN_USER>`). |
| `JS App/scheduler.js` | The `claude` binary candidate paths near the top (it probes several; `CLAUDE_BIN` env var wins if set). |

### Required: `.claude/settings.scheduled.json` in your workspace

Every `claude` task is spawned as:

```
claude -p "<prompt>" --settings .claude/settings.scheduled.json --max-turns N [--model M]
```

with `cwd` set to `settings.projectRoot`, so that file must exist in your
workspace. Permission rules **merge** across scopes (user, project, and this
file); its `deny` list is enforced, its `allow` list adds to what you already
allow. A minimal version:

```json
{
  "permissions": {
    "allow": [],
    "deny": []
  }
}
```

### Optional: Slack failure alerts

Set these in the scheduler's environment (or in the Doppler config below):

| Variable | Meaning |
|----------|---------|
| `SLACK_BOT_TOKEN` | Bot token with `chat:write`. |
| `SLACK_ALERT_CHANNEL` | Channel ID (or `#name`) that receives failure alerts. |
| `SLACK_ALERT_USERNAME` | Optional display-name override for the alert. |

With no token or channel, failures are still logged; the alert is just skipped.

### Optional: shared secrets from Doppler

If `SCHEDULER_SECRETS_ENV` (default: `.env` next to `schedule.json`) contains a
read-only `DOPPLER_TOKEN`, the scheduler downloads that Doppler config once at
startup and injects every secret into each spawned task's environment. Existing
environment values always win. Without it, tasks run with the scheduler's own
environment.

## How it runs

`setup-windows-task.ps1` registers a Windows Scheduled Task that launches
`start-scheduler.vbs` (silent), which runs `start-scheduler.bat`, which runs
`node "JS App/scheduler.js"`. The task runs as your user via S4U so it has your
profile and live Claude OAuth credentials, and still fires headless after a
reboot without an interactive login. After the one-time registration you never
restart it for a task change.

Cron expressions use the host clock.

## Task types in schedule.json

- `type: "claude"`: runs a Claude Code CLI prompt that tells the agent to read and
  execute `instructionFile` (a markdown file, relative to `projectRoot`), with
  optional `model`, `maxTurns`, `timeout`, `maxRetries`. The task's `description`
  is included in the prompt, so write it as useful context.
- `type: "command"`: runs a shell `command` in `cwd` (both absolute paths). Use
  `timeout: 0` for long-running watchdog tasks (cron `* * * * *`; the engine
  no-ops if the previous run is still going).

See `schedule.example.json` for one of each.

## Viewing past runs

Every run is a `claude -p` session, which some editors hide from their session
pickers. `JS App/scheduled-runs-viewer.js` reads the session store directly and
writes `logs/scheduled-runs.html` (then opens it). Flags: `--json`, `--days N`,
`--no-open`. `open-scheduled-runs-viewer.vbs` runs it without a console window.
Set `SCHEDULER_PROJECT_HASH` to your workspace's folder name under
`~/.claude/projects/` to skip auto-detection.
