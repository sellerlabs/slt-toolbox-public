const cron = require('node-cron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SCHEDULE_PATH = path.join(__dirname, '..', 'schedule.json');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
// Persistent ledger of each task's last successful run (epoch ms). Survives
// process restarts so a fire missed *while the process was down* can be detected
// and recovered on the next startup. node-cron's recoverMissedExecutions only
// covers ticks missed while the process is alive (blocked event loop) — it keeps
// no cross-restart state, so a weekly job whose single fire lands during downtime
// is silently lost without this ledger. (See the 2026-06-29 weekly-digest miss.)
const LAST_RUNS_PATH = path.join(LOGS_DIR, 'last-runs.json');
// How far back startup catch-up will look for a missed fire. A task down for
// longer than this is treated as a fresh start (don't replay ancient misses).
const CATCHUP_LOOKBACK_MS = 50 * 60 * 60 * 1000; // 50 hours — covers a weekend gap

// One-time jobs: a task with `runAt` (ISO datetime with offset) instead of `cron`
// fires once, then the scheduler archives it out of schedule.json itself.
//  - CLAIMS: { "<name>|<runAt>": epochMs } written BEFORE spawn, so a job fires at
//    most once even across a crash/restart or a failed archive write. A duplicate
//    public post is worse than a missed one.
//  - HISTORY: array of archived entries (the original task + firedAt/outcome).
const ONE_TIME_CLAIMS_PATH = path.join(LOGS_DIR, 'one-time-runs.json');
const ONE_TIME_HISTORY_PATH = path.join(LOGS_DIR, 'one-time-history.json');
const ONE_TIME_TICK_MS = 30000;
const DEFAULT_MAX_LATE_MINUTES = 240; // scheduler down at runAt: run late up to 4h, else skip + alert
let oneTimeTasks = []; // current enabled runAt tasks, refreshed on every schedule reload
let oneTimeConfig = null;

let activeJobs = [];
let runningTasks = new Set();
// Last time each task was *started* (epoch ms). Used to suppress duplicate
// fires from node-cron's recoverMissedExecutions, which can replay a tick 1s
// later and double-run fast tasks that already finished (so runningTasks no
// longer guards them). The shortest real cron cadence here is every-minute
// (~60s apart), so a 50s guard catches 1s recovery re-fires while still letting
// legitimate per-minute ticks through even with sub-second scheduling jitter.
let lastStartMs = new Map();
const MIN_RUN_INTERVAL_MS = 50000;

// --- Utility functions ---

function getDateStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTimestamp() {
  const now = new Date();
  const date = getDateStamp();
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${date} ${h}:${min}:${s}`;
}

function getLogPath(taskName) {
  return path.join(LOGS_DIR, `${taskName}-${getDateStamp()}.log`);
}

function appendLog(filePath, message) {
  fs.appendFileSync(filePath, message + '\n');
}

function logScheduler(message) {
  const line = `[${getTimestamp()}] ${message}`;
  appendLog(getLogPath('scheduler'), line);
  console.log(line);
}

// --- Last-run ledger (cross-restart missed-fire recovery) ---

// Read the persisted { taskName: epochMs } map. Returns {} on any error (a
// corrupt/missing ledger must never block startup — worst case we skip catch-up).
function readLastRuns() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUNS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Record a task's last successful run. Read-modify-write so concurrent task
// completions don't clobber each other's entries.
function recordLastRun(taskName, epochMs) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LAST_RUNS_PATH, 'utf8'));
  } catch {
    data = {};
  }
  data[taskName] = epochMs;
  try {
    fs.writeFileSync(LAST_RUNS_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logScheduler(`!!! WARNING: could not write last-runs ledger: ${e.message}`);
  }
}

// --- Cron "previous fire time" (for startup catch-up) ---
//
// node-cron exposes no "previous scheduled time" API and we deliberately avoid
// adding a cron-parser dependency (keeps the scheduler dep-light; this folder
// lives under OneDrive). Instead we step backward minute-by-minute from `from`
// and return the first minute that matches the 5-field cron expression. The
// lookback is bounded (CATCHUP_LOOKBACK_MS), so this is at most a few thousand
// cheap iterations — only ever run once per task at startup.
//
// Supports the standard 5 fields (min hour day-of-month month day-of-week) with
// `*`, `*/step`, `a-b` ranges, `a,b` lists, and plain numbers — which is the full
// syntax used across schedule.json. Day-of-month and day-of-week follow cron's
// OR semantics when both are restricted.
function fieldMatches(spec, value) {
  if (spec === '*') return true;
  for (const part of spec.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (!step) continue;
      let lo, hi;
      if (range === '*') { lo = -Infinity; hi = Infinity; }
      else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; }
      else { lo = Number(range); hi = Infinity; }
      if (value < lo || value > hi) continue;
      const base = (range === '*' || !range.includes('-')) ? (lo === -Infinity ? 0 : lo) : lo;
      if ((value - base) % step === 0) return true;
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (value >= a && value <= b) return true;
    } else if (Number(part) === value) {
      return true;
    }
  }
  return false;
}

// Returns true if a Date matches the cron expression's min/hour/dom/month/dow.
function dateMatchesCron(cronExpr, date) {
  const [min, hour, dom, month, dow] = cronExpr.trim().split(/\s+/);
  if (!fieldMatches(min, date.getMinutes())) return false;
  if (!fieldMatches(hour, date.getHours())) return false;
  if (!fieldMatches(month, date.getMonth() + 1)) return false;
  // Cron OR-semantics: when BOTH day-of-month and day-of-week are restricted
  // (neither is '*'), a match on EITHER counts. When one is '*', the other rules.
  const domR = dom !== '*';
  const dowR = dow !== '*';
  const domMatch = fieldMatches(dom, date.getDate());
  const dowMatch = fieldMatches(dow, date.getDay()); // 0=Sun, JS aligns with cron
  if (domR && dowR) {
    if (!(domMatch || dowMatch)) return false;
  } else {
    if (!domMatch || !dowMatch) return false;
  }
  return true;
}

// Most recent time at or before `from` (exclusive of the current minute's
// remainder) that the cron expression would have fired, within the lookback
// window. Returns null if no fire is found in range.
function previousFireTime(cronExpr, from, lookbackMs) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const floor = from - lookbackMs;
  for (let i = 0; i <= lookbackMs / 60000; i++) {
    if (d.getTime() < floor) break;
    if (dateMatchesCron(cronExpr, d)) return d.getTime();
    d.setMinutes(d.getMinutes() - 1);
  }
  return null;
}

// --- Claude CLI resolution ---

// Resolve the claude CLI to an absolute path so we never depend on the inherited
// PATH of whatever shell restarted this long-running process.
//
// History: this scheduler is launched by a Windows Scheduled Task that runs as the
// SYSTEM account (so it fires on boot/hourly regardless of login). SYSTEM's %APPDATA%
// is C:\Windows\System32\config\systemprofile\AppData\Roaming — NOT the user's profile —
// so the claude CLI (installed only at <USER_HOME>\AppData\Roaming\npm\claude.cmd)
// is invisible both on SYSTEM's PATH and via %APPDATA%. That is why every claude task
// failed on 6/13-6/14 with "'claude' is not recognized" after the hourly SYSTEM
// relaunch, even though an earlier user-context restart had resolved it fine.
//
// Fix: probe the user's ABSOLUTE install path first (independent of any env var), then the
// %APPDATA%-derived path (correct for a user-context run), then bare `claude` (PATH).
// CLAUDE_BIN env var still wins if explicitly set.
// Forward slashes work on Windows in Node fs/spawn and avoid backslash-escaping pitfalls.
const USER_CLAUDE_PATHS = [
  '<USER_HOME>/AppData/Roaming/npm/claude.cmd',
  '<USER_HOME>/AppData/Roaming/npm/claude',
  '<USER_HOME>/.local/bin/claude.exe',
  '<USER_HOME>/.local/bin/claude',
];
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  const candidates = [
    ...USER_CLAUDE_PATHS,
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'claude'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'claude'; // last-resort PATH fallback (will warn at startup if unresolved)
}

const CLAUDE_BIN = resolveClaudeBin();

// --- Doppler secrets ---
//
// Optional: shared secrets (e.g. SLACK_BOT_TOKEN) can live in a Doppler config
// instead of a plaintext .env that might sync to the cloud. We resolve them ONCE at
// startup here and inject them into every spawned task's env, so individual scripts
// just read process.env.SLACK_BOT_TOKEN and never need Doppler logic of their own.
//
// A read-only DOPPLER_TOKEN is read from the .env at SCHEDULER_SECRETS_ENV (default:
// .env next to schedule.json). No file or no token = no injection; tasks still run.
// Binary resolution: winget install path first, then bare `doppler` on PATH.
const SLACK_ENV_PATH = process.env.SCHEDULER_SECRETS_ENV || path.join(__dirname, '..', '.env');

function resolveDopplerBin() {
  const wingetBin = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Doppler.doppler_Microsoft.Winget.Source_8wekyb3d8bbwe', 'doppler.exe'
  );
  return fs.existsSync(wingetBin) ? wingetBin : 'doppler';
}

// Cached across all task runs — fetched lazily on first use, then reused for the
// lifetime of the scheduler process. Returns {} on any failure (logged, non-fatal):
// a Doppler outage must not take down every scheduled task.
let _dopplerSecrets = null;
function getDopplerSecrets() {
  if (_dopplerSecrets) return _dopplerSecrets;
  _dopplerSecrets = {};
  try {
    const env = fs.readFileSync(SLACK_ENV_PATH, 'utf8');
    const tokenMatch = env.match(/^DOPPLER_TOKEN=(.+)/m);
    if (!tokenMatch) {
      logScheduler('!!! WARNING: DOPPLER_TOKEN not found in .env — scheduled tasks will run without injected secrets (SLACK_BOT_TOKEN etc.)');
      return _dopplerSecrets;
    }
    const dopplerBin = resolveDopplerBin();
    const out = require('child_process').execSync(
      `"${dopplerBin}" secrets download --no-file --format env`,
      { env: { ...process.env, DOPPLER_TOKEN: tokenMatch[1].trim() }, encoding: 'utf8' }
    );
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      // Doppler's env format double-quotes values; strip the wrapping quotes.
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      _dopplerSecrets[m[1]] = val;
    }
    logScheduler(`Loaded ${Object.keys(_dopplerSecrets).length} secret(s) from Doppler for task injection`);
  } catch (e) {
    logScheduler(`!!! WARNING: Doppler secret fetch failed (${e.message}) — scheduled tasks will run without injected secrets`);
  }
  return _dopplerSecrets;
}

// --- Task execution ---

function buildClaudeArgs(task, config) {
  // Lead with a unique, human-readable title line so each scheduled run gets a
  // meaningful session name in the Claude UI (the title is derived from the start
  // of the prompt). Without this, every task shows the same "Read the file '...'".
  const title = `${task.name} — scheduled run ${getDateStamp()}`;
  const desc = task.description ? ` (${task.description})` : '';
  const prompt = `${title}${desc}. Read the file '${task.instructionFile}' and execute every step listed in it.`;
  const cwd = config.settings.projectRoot;
  const maxTurns = task.maxTurns || 50;
  // Build full shell command string to avoid Windows cmd.exe arg-quoting issues
  // (spawn with shell:true concatenates args without quoting, splitting multi-word prompts)
  const escapedPrompt = prompt.replace(/"/g, '""'); // cmd.exe double-quote escaping
  const modelFlag = task.model ? ` --model ${task.model}` : '';
  // CLAUDE_BIN is resolved to an absolute path (quoted in case it contains spaces)
  // so the spawn never relies on the inherited PATH of the restarting shell.
  const claudeBin = CLAUDE_BIN.includes(' ') ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;
  const command = `${claudeBin} -p "${escapedPrompt}" --settings .claude/settings.scheduled.json --max-turns ${maxTurns}${modelFlag}`;
  return {
    command,
    args: [],
    cwd: cwd
  };
}

function buildCommandArgs(task, config) {
  const cwd = task.cwd || config.settings.projectRoot;
  // If command contains quotes, it's a pre-formatted shell command (e.g. wscript.exe "...") — use as-is
  if (task.command.includes('"')) {
    return { command: task.command, args: [], cwd };
  }
  // Resolve relative bare filenames to full path — windowsHide:true prevents cmd.exe
  // from finding batch files via the cwd option alone
  const resolved = path.isAbsolute(task.command)
    ? task.command
    : path.join(cwd, task.command);
  // Quote paths with spaces so cmd.exe doesn't split them
  const command = resolved.includes(' ') ? `"${resolved}"` : resolved;
  return {
    command,
    args: [],
    cwd: cwd
  };
}

// Transient API errors worth retrying (server-side capacity / rate limits),
// as opposed to a genuine task failure that retrying won't fix.
// Network-level drops are transient too: on 2026-09-08 a run died with a bare
// "API Error: Connection closed mid-response" AFTER generating its charts but
// BEFORE the Slack post. The old pattern required a numeric HTTP status, so a
// plain connection drop was misclassified as permanent and never retried --
// silently narrowing maxRetries to "HTTP status errors only".
const TRANSIENT_API_PATTERN = /overloaded_error|rate_limit_error|API Error:\s*(429|500|502|503|529)|connection closed|connection error|connection reset|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network error|fetch failed/i;

// An agent that gives up cannot fail its own process: a Bash-tool `exit 1` exits the
// subshell, not `claude`, so the run still closes with code 0 (verified 2026-08-11).
// The agent reports the failure in prose and the scheduler records a clean success —
// which is how four MCP-startup failures (7/04, 8/09, 8/10, 8/11) were logged green
// and never retried by startup catch-up. These phrases are the agent SAYING it did
// not do the work. They are deliberately specific: bare "failed" is not here, because
// healthy runs legitimately report things like "0 failed".
const SELF_REPORTED_FAILURE_PATTERN = /still connecting|tools (?:were|are) unavailable|MCP (?:server|tools?) (?:is |are |was |were )?(?:not |un)available|tools? (?:is|are|were) not available|no \S+ tools? (?:are|were) (?:discoverable|available)|not discoverable through it|unable to complete|could not run|could not complete|no accounts were checked|giving up|aborting the run|the slack gate blocked|slack (?:post|message) (?:is|was) gated|posting outside [^\n]{0,60}needs your explicit go-ahead|approve-slack-post/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Posts a failure alert to SLACK_ALERT_CHANNEL from THIS parent process.
//
// Why it lives here and not in the task's own instructions: until 2026-09-08 the
// only failure signal was a Slack post the AGENT was told to make. When the agent
// could not post (trust flag dropped its permissions on 9/06, connection drop on
// 9/08), the alert failed for the very same reason the report did -- a fallback
// sharing a failure mode with the thing it guards is not a fallback. Two silent
// weekly misses is what that cost.
//
// This path deliberately avoids the Claude permission layer and the MCP entirely:
// raw HTTPS, parent-process credentials. It cannot be gated, denied, or talked out
// of firing by the model it is reporting on. Best-effort: a notifier that throws
// must never take down the scheduler, so everything is swallowed.
function notifyTaskFailure(taskName, reason, logPath) {
  return new Promise((resolve) => {
    try {
      const token = process.env.SLACK_BOT_TOKEN || getDopplerSecrets().SLACK_BOT_TOKEN;
      const alertChannel = process.env.SLACK_ALERT_CHANNEL || getDopplerSecrets().SLACK_ALERT_CHANNEL;
      const alertUsername = process.env.SLACK_ALERT_USERNAME || getDopplerSecrets().SLACK_ALERT_USERNAME;
      if (!token || !alertChannel) {
        logScheduler(`!!! ${taskName} failed but SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL is not set — alert NOT sent`);
        return resolve();
      }
      const text = [
        `:rotating_light: Scheduled task failed: *${taskName}*`,
        reason,
        `Log: \`${path.basename(logPath)}\``,
      ].join('\n');
      const body = JSON.stringify({
        channel: alertChannel,
        ...(alertUsername ? { username: alertUsername } : {}),
        text,
      });
      const req = https.request({
        hostname: 'slack.com',
        path: '/api/chat.postMessage',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.ok) logScheduler(`${taskName} failure alert posted to ${alertChannel}`);
            else logScheduler(`!!! ${taskName} failure alert REJECTED by Slack: ${parsed.error}`);
          } catch { logScheduler(`!!! ${taskName} failure alert: unparseable Slack response`); }
          resolve();
        });
      });
      req.on('error', (e) => { logScheduler(`!!! ${taskName} failure alert failed to send: ${e.message}`); resolve(); });
      req.on('timeout', () => { req.destroy(); logScheduler(`!!! ${taskName} failure alert timed out`); resolve(); });
      req.write(body);
      req.end();
    } catch (e) {
      logScheduler(`!!! ${taskName} failure alert threw: ${e.message}`);
      resolve();
    }
  });
}

// Runs the task process once.
// Resolves with { exitCode, sawTransientError, sawSelfReportedFailure }.
function runOnce(task, spawnConfig, env, logPath) {
  return new Promise((resolve) => {
    let sawTransientError = false;
    let killedByTimeout = false;
    let sawStdout = false;
    let sawSelfReportedFailure = false;

    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: spawnConfig.cwd,
      shell: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    // Timeout handling
    let timeoutHandle = null;
    const timeoutMs = task.timeout !== undefined ? task.timeout : 900000;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        killedByTimeout = true;
        appendLog(logPath, `\nTIMEOUT: Task exceeded ${timeoutMs}ms, killing process`);
        logScheduler(`${task.name} timed out after ${timeoutMs}ms, killing`);
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    const handleData = (isStdout) => (data) => {
      const text = data.toString();
      if (TRANSIENT_API_PATTERN.test(text)) sawTransientError = true;
      if (SELF_REPORTED_FAILURE_PATTERN.test(text)) sawSelfReportedFailure = true;
      // A `claude -p` task's final report goes to stdout. If the child produced
      // stdout before we timed it out, its work completed and only the process
      // shutdown ran long — that's a success we shouldn't flag red.
      if (isStdout && text.trim().length > 0) sawStdout = true;
      fs.appendFileSync(logPath, text);
    };

    child.stdout.on('data', handleData(true));
    child.stderr.on('data', handleData(false));

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Our own timeout SIGTERM leaves code=null. If the task had already emitted
      // its report to stdout, treat it as success (exit 0) so a task that merely
      // shuts down slowly stops showing a false exit 1.
      if (killedByTimeout && sawStdout) {
        appendLog(logPath, `\nNote: killed by timeout after producing output — treating as success.`);
        resolve({ exitCode: 0, sawTransientError, sawSelfReportedFailure });
        return;
      }
      resolve({ exitCode: code !== null ? code : 1, sawTransientError, sawSelfReportedFailure });
    });

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      appendLog(logPath, `\nERROR: ${err.message}`);
      resolve({ exitCode: 1, sawTransientError });
    });
  });
}

async function executeTask(task, config) {
  if (runningTasks.has(task.name)) {
    logScheduler(`Skipping ${task.name}: previous run still in progress`);
    return;
  }

  // Suppress recoverMissedExecutions double-fires: a fast task can finish and
  // clear runningTasks before the spurious 1s-later re-fire arrives, so guard on
  // last start time too. Blocks any re-fire within MIN_RUN_INTERVAL_MS.
  const now = Date.now();
  const prevStart = lastStartMs.get(task.name);
  if (prevStart !== undefined && now - prevStart < MIN_RUN_INTERVAL_MS) {
    logScheduler(`Skipping ${task.name}: duplicate fire ${now - prevStart}ms after last start (recovery re-fire)`);
    return;
  }
  lastStartMs.set(task.name, now);

  runningTasks.add(task.name);
  const logPath = getLogPath(task.name);

  appendLog(logPath, '============================================================');
  appendLog(logPath, `Run started: ${getTimestamp()}`);
  appendLog(logPath, '============================================================');

  logScheduler(`Starting task: ${task.name}`);

  let spawnConfig;
  if (task.type === 'claude') {
    spawnConfig = buildClaudeArgs(task, config);
  } else {
    spawnConfig = buildCommandArgs(task, config);
  }

  // Clear Claude nesting env vars so spawned claude sessions work
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Inject the shared Doppler secrets (SLACK_BOT_TOKEN etc.) so every task can read
  // them from process.env without its own Doppler logic. Existing process.env values
  // win (so an explicitly-set override is never clobbered).
  for (const [k, v] of Object.entries(getDopplerSecrets())) {
    if (env[k] === undefined) env[k] = v;
  }
  // NEVER let ANTHROPIC_API_KEY reach a spawned `claude` process. When it is set,
  // the Claude CLI bills to pay-as-you-go API rates instead of the subscription.
  // From 2026-06-23 (when Doppler injection landed) to 2026-07-26 this quietly put
  // every scheduled claude task on the API meter: ~$0.50/day -> ~$24/day, $636 in
  // July alone. The Doppler
  // secret has since been renamed so nothing carries this name, but keep the delete
  // as belt-and-braces -- command-type tasks that legitimately need a key should
  // read their own differently-named variable.
  delete env.ANTHROPIC_API_KEY;
  // Use Windows system CA store so SSL works regardless of which shell launched the scheduler
  env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + '--use-system-ca';
  // Skip Playwright MCP for scheduled tasks — prevents Chrome from opening in background
  if (task.type === 'claude') {
    env.PLAYWRIGHT_MCP_SKIP = '1';
    // Slack approval gate exemption. Headless runs have nobody to approve a post, so
    // a PreToolUse approval hook, if you run one, would deny every scheduled
    // Slack post. This marker is the exemption credential: it can only be set by THIS
    // parent process, never by an agent inside a conversation, so it cannot be forged
    // by the model it exempts. Scheduled tasks are still confined to the channels
    // listed in slackApprovalGate.scheduledChannels.
    env.CLAUDE_SCHEDULED_RUN = '1';
  }

  // Retry-with-backoff config. Only retries on transient API errors (529/503/429/overloaded).
  const maxRetries = task.maxRetries !== undefined ? task.maxRetries : 3;
  const baseDelayMs = task.retryBaseDelayMs !== undefined ? task.retryBaseDelayMs : 30000;

  try {
    let result;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      result = await runOnce(task, spawnConfig, env, logPath);

      const failedTransiently = result.exitCode !== 0 && result.sawTransientError;
      if (!failedTransiently || attempt > maxRetries) break;

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // 30s, 60s, 120s...
      const delaySec = Math.round(delayMs / 1000);
      appendLog(logPath, `\nTransient API error detected (attempt ${attempt}/${maxRetries + 1}). Retrying in ${delaySec}s...`);
      logScheduler(`${task.name} hit transient API error, retry ${attempt}/${maxRetries} in ${delaySec}s`);
      await sleep(delayMs);
      appendLog(logPath, '============================================================');
      appendLog(logPath, `Retry attempt ${attempt + 1}: ${getTimestamp()}`);
      appendLog(logPath, '============================================================');
    }

    // An exit-0 run whose own output says it could not do the work is NOT a success.
    // The agent cannot set its own exit code (a Bash `exit 1` exits the subshell, not
    // `claude`), so without this check the ledger stamps a give-up as green and
    // startup catch-up never re-fires it. See SELF_REPORTED_FAILURE_PATTERN.
    const selfReportedFailure = result.exitCode === 0 && result.sawSelfReportedFailure;

    appendLog(logPath, '');
    if (selfReportedFailure) {
      appendLog(logPath, `WARNING: the task exited 0 but its own output reports it could not complete the work.`);
      appendLog(logPath, `Not recording this run as successful, so startup catch-up can re-fire it.`);
      logScheduler(`${task.name} exited 0 but SELF-REPORTED FAILURE — not recorded as success`);
    }
    appendLog(logPath, `Run finished: ${getTimestamp()} (exit code: ${result.exitCode}${selfReportedFailure ? ', SELF-REPORTED FAILURE' : ''})`);
    appendLog(logPath, '============================================================');
    logScheduler(`${task.name} finished (exit code: ${result.exitCode})`);

    // Surface failures OUT of the log and into Slack. Both shapes count: a non-zero
    // exit, and an exit-0 run whose own output admits it could not do the work.
    // Without this, an unattended failure is visible only to whoever opens the log.
    if (result.exitCode !== 0 || selfReportedFailure) {
      const reason = selfReportedFailure
        ? 'Exited 0 but its own output reports it could not complete the work.'
        : `Exited with code ${result.exitCode}${result.sawTransientError ? ' after exhausting transient-error retries' : ''}.`;
      await notifyTaskFailure(task.name, reason, logPath);
    }
    // Record successful runs in the cross-restart ledger so startup catch-up
    // knows this fire happened. Only exit-0 counts as success — a failed run
    // should remain "missed" so the next startup can retry it.
    //
    // NOTE: this deliberately does NOT feed the retry gate above, which still requires
    // exitCode !== 0. Retrying on output text alone would re-run tasks that already
    // succeeded, and 22 scheduled tasks send email, post Slack, and write sheets —
    // duplicate side effects are worse than the bug being fixed. This only withholds
    // the green stamp so the failure stays visible and eligible for catch-up.
    if (result.exitCode === 0 && !selfReportedFailure) {
      recordLastRun(task.name, Date.now());
    }
    return { exitCode: result.exitCode, selfReportedFailure, logPath };
  } finally {
    runningTasks.delete(task.name);
  }
}

// --- Schedule loading ---

function loadAndSchedule() {
  // Stop existing jobs
  activeJobs.forEach(j => j.cronJob.stop());
  activeJobs = [];

  // Parse schedule.json
  let config;
  try {
    const raw = fs.readFileSync(SCHEDULE_PATH, 'utf-8');
    config = JSON.parse(raw);
  } catch (err) {
    logScheduler(`Failed to parse schedule.json: ${err.message} — keeping previous schedule`);
    return;
  }

  if (!config.tasks || !Array.isArray(config.tasks)) {
    logScheduler('No tasks array found in schedule.json');
    return;
  }

  // Schedule each enabled task
  const nextOneTime = [];
  for (const task of config.tasks) {
    if (!task.enabled) {
      logScheduler(`Skipped (disabled): ${task.name}`);
      continue;
    }

    if (!task.name || !(task.cron || task.runAt) || !task.type) {
      logScheduler(`Skipped (missing required fields): ${JSON.stringify(task)}`);
      continue;
    }

    if (task.runAt) {
      if (task.cron) {
        logScheduler(`Skipped ${task.name}: has both cron and runAt, pick one`);
        continue;
      }
      if (Number.isNaN(Date.parse(task.runAt)) || !/(Z|[+-]\d\d:\d\d)$/.test(task.runAt)) {
        logScheduler(`Invalid runAt "${task.runAt}" for ${task.name} (need ISO datetime with offset, e.g. 2026-09-25T09:30:00-04:00), skipping`);
        continue;
      }
    }

    if (task.type === 'claude' && !task.instructionFile) {
      logScheduler(`Missing instructionFile for claude task ${task.name}, skipping`);
      continue;
    }

    if (task.type === 'command' && !task.command) {
      logScheduler(`Missing command for command task ${task.name}, skipping`);
      continue;
    }

    if (task.runAt) {
      nextOneTime.push(task);
      logScheduler(`Queued one-time: ${task.name} [runAt ${task.runAt}] — ${task.description || ''}`);
      continue;
    }

    if (!cron.validate(task.cron)) {
      logScheduler(`Invalid cron "${task.cron}" for ${task.name}, skipping`);
      continue;
    }

    if (task.type === 'claude' && !task.instructionFile) {
      logScheduler(`Missing instructionFile for claude task ${task.name}, skipping`);
      continue;
    }

    if (task.type === 'command' && !task.command) {
      logScheduler(`Missing command for command task ${task.name}, skipping`);
      continue;
    }

    const cronJob = cron.schedule(task.cron, () => {
      executeTask(task, config).catch(err => {
        logScheduler(`Uncaught error in ${task.name}: ${err.message}`);
        runningTasks.delete(task.name);
      });
    }, { recoverMissedExecutions: true });

    activeJobs.push({ name: task.name, cronJob });
    logScheduler(`Scheduled: ${task.name} [${task.cron}] — ${task.description || ''}`);
  }

  oneTimeTasks = nextOneTime;
  oneTimeConfig = config;
  logScheduler(`${activeJobs.length} task(s) scheduled, ${oneTimeTasks.length} one-time job(s) queued`);
  return config;
}

// --- One-time jobs (runAt): fire once, then self-archive out of schedule.json ---

function oneTimeKey(task) {
  return `${task.name}|${task.runAt}`;
}

function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write (temp + rename) so a crash mid-write never leaves a truncated file.
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function claimOneTime(task) {
  const claims = readJsonOr(ONE_TIME_CLAIMS_PATH, {});
  claims[oneTimeKey(task)] = Date.now();
  writeJsonAtomic(ONE_TIME_CLAIMS_PATH, claims);
}

// Move the entry out of schedule.json into the history file. Re-reads
// schedule.json fresh and removes ONLY the entry matching name + runAt, so a
// concurrent human edit to any other task is preserved. The rewrite trips the
// fs.watchFile reload, which is harmless. If this fails, the claim still
// prevents a refire; the stale entry is just left for manual cleanup.
function archiveOneTime(task, outcome) {
  try {
    const history = readJsonOr(ONE_TIME_HISTORY_PATH, []);
    history.push({ ...task, archivedAt: new Date().toISOString(), ...outcome });
    writeJsonAtomic(ONE_TIME_HISTORY_PATH, history);

    const config = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
    const before = config.tasks.length;
    config.tasks = config.tasks.filter(t => !(t.name === task.name && t.runAt === task.runAt));
    if (config.tasks.length !== before) {
      writeJsonAtomic(SCHEDULE_PATH, config);
    }
    // Drop it in memory too, so a tick before the 5s reload can't archive it twice.
    oneTimeTasks = oneTimeTasks.filter(t => oneTimeKey(t) !== oneTimeKey(task));
    logScheduler(`One-time ${task.name} archived (${outcome.status}) and removed from schedule.json`);
  } catch (e) {
    logScheduler(`!!! WARNING: could not archive one-time ${task.name}: ${e.message} (claim still blocks a refire; remove the entry by hand)`);
  }
}

async function fireOneTime(task, config) {
  claimOneTime(task);
  const firedAt = new Date().toISOString();
  const lateMin = Math.round((Date.now() - Date.parse(task.runAt)) / 60000);
  logScheduler(`One-time run: ${task.name} (runAt ${task.runAt}${lateMin >= 2 ? `, ${lateMin} min late` : ''})`);
  let res;
  try {
    res = await executeTask(task, config);
  } catch (err) {
    logScheduler(`Uncaught error in one-time ${task.name}: ${err.message}`);
    runningTasks.delete(task.name);
  }
  const ok = res && res.exitCode === 0 && !res.selfReportedFailure;
  archiveOneTime(task, {
    status: ok ? 'succeeded' : 'failed',
    firedAt,
    exitCode: res ? res.exitCode : null,
    logFile: res ? path.basename(res.logPath) : null,
  });
}

function oneTimeTick() {
  if (oneTimeTasks.length === 0) return;
  const claims = readJsonOr(ONE_TIME_CLAIMS_PATH, {});
  const now = Date.now();
  for (const task of oneTimeTasks) {
    const key = oneTimeKey(task);
    const due = Date.parse(task.runAt);
    if (now < due) continue;

    if (claims[key] !== undefined) {
      // Already fired (e.g. archive write failed last time). Retry the cleanup only.
      if (!runningTasks.has(task.name)) {
        archiveOneTime(task, { status: 'already-fired', firedAt: new Date(claims[key]).toISOString() });
      }
      continue;
    }

    const maxLateMin = task.maxLateMinutes !== undefined ? task.maxLateMinutes : DEFAULT_MAX_LATE_MINUTES;
    const lateMs = now - due;
    if (lateMs > maxLateMin * 60000) {
      claimOneTime(task);
      const lateMin = Math.round(lateMs / 60000);
      logScheduler(`One-time ${task.name} SKIPPED: ${lateMin} min past runAt (max ${maxLateMin})`);
      notifyTaskFailure(task.name, `One-time job skipped: scheduler was down at ${task.runAt} and it is now ${lateMin} min late (max ${maxLateMin}). Not run.`, getLogPath(task.name));
      archiveOneTime(task, { status: 'skipped-late', lateMinutes: lateMin });
      continue;
    }

    claims[key] = now; // local copy, so the same tick can't double-fire
    fireOneTime(task, oneTimeConfig).catch(err => logScheduler(`One-time ${task.name} error: ${err.message}`));
  }
}

// --- Startup catch-up: recover fires missed while the process was down ---
//
// For each enabled task, compare its most recent scheduled fire time (within the
// lookback window) against the last successful run recorded in the ledger. If the
// task should have fired since it last ran, run it once now.
//
// Guards:
//  - Only tasks WITH a prior ledger entry are eligible. A task that has never run
//    (no entry) is treated as a fresh start — we never replay history on first deploy.
//  - Per-minute watchdogs ("* * * * *") is skipped: it self-recovers
//    within 60s and catching it up is meaningless.
//  - Runs are staggered so we don't launch several heavy claude tasks simultaneously.
function runStartupCatchup(config) {
  const lastRuns = readLastRuns();
  const now = Date.now();
  const due = [];

  for (const task of config.tasks) {
    if (!task.enabled || !task.name || !task.cron) continue;
    // Skip sub-minute / per-minute watchdogs — they self-recover.
    if (task.cron.trim().startsWith('* * * * *')) continue;

    const lastRun = lastRuns[task.name];
    if (lastRun === undefined) continue; // first run ever — don't replay

    const prevFire = previousFireTime(task.cron, now, CATCHUP_LOOKBACK_MS);
    if (prevFire === null) continue; // no scheduled fire in the lookback window

    // Missed if the most recent scheduled fire is newer than the last run.
    // 60s slack absorbs the case where the run started slightly before its
    // exact cron second.
    if (prevFire > lastRun + 60000) {
      due.push({ task, prevFire });
    }
  }

  if (due.length === 0) {
    logScheduler('Startup catch-up: no missed fires to recover.');
    return;
  }

  due.sort((a, b) => a.prevFire - b.prevFire);
  logScheduler(`Startup catch-up: ${due.length} missed fire(s) to recover — ${due.map(d => d.task.name).join(', ')}`);

  // Stagger by 90s so heavy claude tasks don't pile up on a cold start.
  due.forEach((d, i) => {
    const delayMs = i * 90000;
    setTimeout(() => {
      const missedAt = new Date(d.prevFire).toISOString();
      logScheduler(`Catch-up run: ${d.task.name} (missed fire at ${missedAt})`);
      executeTask(d.task, config).catch(err => {
        logScheduler(`Uncaught error in catch-up ${d.task.name}: ${err.message}`);
        runningTasks.delete(d.task.name);
      });
    }, delayMs);
  });
}

// --- Main ---

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

logScheduler('=== Claude Task Scheduler starting ===');

// Startup self-check: fail loud if the claude CLI can't be resolved, so a bad
// restart (stripped PATH) is caught immediately instead of failing silently all
// night across every claude-type task.
if (CLAUDE_BIN === 'claude') {
  logScheduler('!!! WARNING: claude CLI not found at CLAUDE_BIN or the npm global bin dir. Falling back to bare "claude" on PATH. If this process was restarted from a stripped-down shell, ALL claude tasks will fail with "\'claude\' is not recognized". Set CLAUDE_BIN or restart from a full-PATH shell.');
} else {
  logScheduler(`claude CLI resolved to: ${CLAUDE_BIN}`);
}

const initialConfig = loadAndSchedule();

// Recover any fires missed while this process was down (e.g. a weekly job whose
// single fire landed during a restart). Runs once at startup, after scheduling.
if (initialConfig) {
  try {
    runStartupCatchup(initialConfig);
  } catch (e) {
    logScheduler(`Startup catch-up failed (non-fatal): ${e.message}`);
  }
}

// One-time (runAt) jobs: check every 30s. The first tick runs immediately so a
// job that came due while the process was down is handled on boot.
function safeOneTimeTick() {
  try {
    oneTimeTick();
  } catch (e) {
    logScheduler(`One-time tick failed (non-fatal): ${e.message}`);
  }
}
safeOneTimeTick();
setInterval(safeOneTimeTick, ONE_TIME_TICK_MS);

// Watch schedule.json for changes (5s poll — reliable on OneDrive/Windows)
fs.watchFile(SCHEDULE_PATH, { interval: 5000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    logScheduler('schedule.json changed — reloading...');
    loadAndSchedule();
  }
});

// Graceful shutdown
function shutdown() {
  logScheduler('=== Shutting down ===');
  activeJobs.forEach(j => j.cronJob.stop());
  fs.unwatchFile(SCHEDULE_PATH);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  logScheduler(`=== UNCAUGHT EXCEPTION: ${err.message} ===`);
  logScheduler(err.stack || '(no stack)');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logScheduler(`=== UNHANDLED REJECTION: ${reason} ===`);
});

logScheduler('Scheduler running. Watching schedule.json for changes. Press Ctrl+C to stop.');
