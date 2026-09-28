#!/usr/bin/env node
// scheduled-runs-viewer.js
//
// Why this exists: the VS Code Claude Code extension hardcodes hiding any session
// whose `entrypoint` is one of sdk-cli / sdk-ts / sdk-py from its interactive
// "resume" picker (extension.js: `JRt = new Set(["sdk-cli","sdk-ts","sdk-py"])`,
// checked in `XRt`). Every scheduled task here runs via `claude -p`, which always
// stamps `entrypoint: "sdk-cli"` — and there is NO CLI flag / env var that changes
// that (verified 2026-07-23: CLAUDE_CODE_ENTRYPOINT is ignored in -p mode). So the
// runs ARE saved to disk in the same store the picker reads, they're just filtered
// out of the picker on purpose. This viewer reads that same store directly and
// surfaces the scheduled runs the picker refuses to show.
//
// It scans ~/.claude/projects/<project-hash>/*.jsonl, keeps only sdk-cli sessions
// whose first prompt matches the scheduler's title pattern ("<task> — scheduled
// run <date>"), joins them against last-runs.json (last SUCCESSFUL run per task),
// and writes a self-contained HTML dashboard. Read-only: never mutates sessions.
//
// Usage:
//   node "scheduled-runs-viewer.js"            # writes + opens the HTML report
//   node "scheduled-runs-viewer.js" --no-open  # write only, don't launch browser
//   node "scheduled-runs-viewer.js" --json     # print JSON to stdout instead
//   node "scheduled-runs-viewer.js" --days 30  # only runs from the last N days (default 7)
//
// The written HTML is a STATIC snapshot — a file:// page cannot rescan the session
// store, so reloading the browser alone will never pull in newer runs. The page
// therefore self-reloads every REFRESH_SECONDS, and the `refresh-scheduled-runs`
// scheduler task re-runs this script (with --no-open) on the same cadence so the
// file behind that reload is actually fresh. The "Refresh now" button just forces
// the reload early; it still only shows what the last regen wrote.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// --- Paths ---------------------------------------------------------------

// The project store is keyed by a sanitized cwd. This app lives under the
// workspace, so derive the hash the same way Claude Code does: lowercase-drive
// path with non-alphanumerics -> '-'. We hardcode the known hash but fall back to
// auto-detecting the single project dir that contains "scheduled run" sessions.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const KNOWN_HASH = process.env.SCHEDULER_PROJECT_HASH || '';
const LAST_RUNS_PATH = path.join(__dirname, '..', 'logs', 'last-runs.json');
const OUT_HTML = path.join(__dirname, '..', 'logs', 'scheduled-runs.html');

// --- Args ----------------------------------------------------------------

const args = process.argv.slice(2);
const NO_OPEN = args.includes('--no-open');
const AS_JSON = args.includes('--json');
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 7 : 7;

// How often the page auto-reloads itself. Keep in sync with the cron on the
// `refresh-scheduled-runs` task in schedule.json (every 15 min) — reloading more
// often than the file is regenerated just re-renders identical HTML.
const REFRESH_SECONDS = 15 * 60;

// --- Helpers -------------------------------------------------------------

function resolveProjectDir() {
  const known = KNOWN_HASH ? path.join(PROJECTS_DIR, KNOWN_HASH) : null;
  if (known && fs.existsSync(known)) return known;
  // Fallback: scan all project dirs, pick the one with the most sdk-cli sessions.
  let best = null, bestCount = -1;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    let files = [];
    try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    if (files.length > bestCount) { best = full; bestCount = files.length; }
  }
  return best;
}

// Read just the first ~4KB of a jsonl to find the first user record cheaply,
// then the whole file only if it matched (keeps a 1000-file scan fast).
function firstUserRecord(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, 8192, 0);
    const chunk = buf.slice(0, bytes).toString('utf8');
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; } // partial last line
      if (d.type === 'user' && d.entrypoint) return d;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// The scheduler builds the prompt as:
//   "<task.name> — scheduled run <YYYY-MM-DD> (<description>). Read the file ..."
// Parse task name + date + description out of it.
const TITLE_RE = /^(.*?)\s+[—-]\s+scheduled run\s+(\d{4}-\d{2}-\d{2})(?:\s*\(([^)]*)\))?/;

function extractPromptText(rec) {
  const m = rec.message;
  if (!m) return '';
  let c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && x.text) || '').join(' ');
  return '';
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Scan ----------------------------------------------------------------

function scan() {
  const projDir = resolveProjectDir();
  if (!projDir) return { projDir: null, runs: [] };

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  let files = [];
  try { files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')); } catch { /* */ }

  const runs = [];
  for (const f of files) {
    const full = path.join(projDir, f);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;

    const rec = firstUserRecord(full);
    if (!rec) continue;
    if (rec.entrypoint !== 'sdk-cli') continue; // only headless scheduled/SDK runs

    const prompt = extractPromptText(rec);
    const m = prompt.match(TITLE_RE);
    if (!m) continue; // not a scheduler-shaped run (e.g. an ad-hoc -p call)

    const startTs = rec.timestamp ? Date.parse(rec.timestamp) : stat.mtimeMs;
    runs.push({
      sessionId: rec.sessionId || f.slice(0, -6),
      task: m[1].trim(),
      runDate: m[2],
      description: (m[3] || '').trim(),
      startMs: startTs,
      endMs: stat.mtimeMs,
      durationMs: Math.max(0, stat.mtimeMs - startTs),
      file: full,
    });
  }

  // Join against last-runs.json (last SUCCESSFUL run epoch per task name).
  let lastRuns = {};
  try { lastRuns = JSON.parse(fs.readFileSync(LAST_RUNS_PATH, 'utf8')); } catch { /* */ }
  // last-runs keys are the scheduler task IDs (kebab), session titles are the
  // human task.name — so we can't key-match reliably. Attach the whole map for
  // the summary panel instead.

  runs.sort((a, b) => b.startMs - a.startMs);
  return { projDir, runs, lastRuns };
}

// --- Render --------------------------------------------------------------

function renderHtml({ projDir, runs, lastRuns }) {
  const byTask = {};
  for (const r of runs) (byTask[r.task] ||= []).push(r);
  const taskNames = Object.keys(byTask).sort();

  const rows = runs.map(r => {
    const mins = Math.round(r.durationMs / 60000);
    const dur = mins >= 1 ? `${mins}m` : `${Math.round(r.durationMs / 1000)}s`;
    const resumeCmd = `claude --resume ${r.sessionId}`;
    return `<tr>
      <td class="task">${esc(r.task)}</td>
      <td class="date">${esc(fmtDate(r.startMs))}</td>
      <td class="dur">${esc(dur)}</td>
      <td class="desc" title="${esc(r.description)}">${esc(r.description.slice(0, 80))}${r.description.length > 80 ? '…' : ''}</td>
      <td class="sid"><code title="Copy and run in a terminal to open this run">${esc(resumeCmd)}</code></td>
    </tr>`;
  }).join('\n');

  const lastRunRows = Object.entries(lastRuns || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(fmtDate(v))}</td></tr>`)
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scheduled Runs — Claude Task Scheduler</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#9aa4b2;--green:#4caf7d;--accent:#6ea8fe}
  @media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--fg:#1a1d23;--dim:#5c6672;--green:#1f8a5b;--accent:#2b6cff}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--dim);margin:0 0 20px;font-size:13px}
  .grid{display:grid;grid-template-columns:1fr 320px;gap:20px;align-items:start}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:0;padding:12px 16px;border-bottom:1px solid var(--line)}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:8px 16px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);font-weight:600;position:sticky;top:0;background:var(--card)}
  tr:last-child td{border-bottom:none}
  td.task{font-weight:600}
  td.date,td.dur{white-space:nowrap;color:var(--dim);font-variant-numeric:tabular-nums}
  td.desc{color:var(--dim);max-width:280px}
  code{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;background:rgba(110,168,254,.12);color:var(--accent);padding:2px 6px;border-radius:5px;cursor:pointer;user-select:all;white-space:nowrap}
  .tablewrap{max-height:70vh;overflow:auto}
  .filter{padding:12px 16px;border-bottom:1px solid var(--line)}
  .filter input{width:100%;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
  .stat{display:flex;gap:16px;flex-wrap:wrap;padding:12px 16px}
  .stat div{font-size:13px}.stat b{font-size:20px;display:block;color:var(--fg)}
  .empty{padding:40px 16px;text-align:center;color:var(--dim)}
  .topbar{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  button.refresh{font:inherit;font-size:13px;padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
  button.refresh:hover{border-color:var(--accent);color:var(--accent)}
  #age{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
</style></head><body>
<div class="topbar"><h1>📅 Scheduled Runs</h1>
<button class="refresh" onclick="location.reload()" title="Reloads this file. It is regenerated every ${Math.round(REFRESH_SECONDS / 60)} min by the refresh-scheduled-runs task.">↻ Refresh now</button>
<span id="age"></span></div>
<p class="sub">Headless <code style="cursor:auto;user-select:auto">claude -p</code> sessions from the Task Scheduler — the ones the VS Code picker hides (entrypoint <code style="cursor:auto;user-select:auto">sdk-cli</code>). Last ${DAYS} days · ${runs.length} run(s) · generated ${esc(fmtDate(Date.now()))}.<br>Store: <code style="cursor:auto;user-select:auto">${esc(projDir || 'not found')}</code></p>
<div class="grid">
  <div class="card">
    <h2>Runs</h2>
    <div class="filter"><input id="q" placeholder="Filter by task or description…" oninput="filterRows()"></div>
    <div class="tablewrap">
      <table id="runs"><thead><tr><th>Task</th><th>Started</th><th>Dur</th><th>Description</th><th>Open (click to select, then copy)</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="empty">No scheduled runs found in the last ${DAYS} days.</td></tr>`}</tbody></table>
    </div>
  </div>
  <div class="card">
    <h2>Last successful run per task</h2>
    <div class="stat"><div>Distinct tasks seen<b>${taskNames.length}</b></div><div>Total runs<b>${runs.length}</b></div></div>
    <table><thead><tr><th>Task ID</th><th>Last success</th></tr></thead><tbody>${lastRunRows || '<tr><td colspan="2" class="empty">last-runs.json not found</td></tr>'}</tbody></table>
  </div>
</div>
<script>
function filterRows(){
  var q=document.getElementById('q').value.toLowerCase();
  document.querySelectorAll('#runs tbody tr').forEach(function(tr){
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// Age of THIS snapshot, not of the data — stamped when the file was written.
var GENERATED_AT = ${Date.now()};
var REFRESH_SECONDS = ${REFRESH_SECONDS};
function tickAge(){
  var mins = Math.floor((Date.now() - GENERATED_AT) / 60000);
  document.getElementById('age').textContent =
    mins < 1 ? 'generated just now' : 'generated ' + mins + 'm ago';
}
tickAge();
setInterval(tickAge, 30000);

// Static file: only a reload picks up a newer regen. Don't reload while the user
// is typing a filter — it would wipe what they're doing mid-search.
setTimeout(function(){
  var q = document.getElementById('q');
  if (q && (q.value || document.activeElement === q)) return;
  location.reload();
}, REFRESH_SECONDS * 1000);
</script>
</body></html>`;
}

// --- Main ----------------------------------------------------------------

const data = scan();

if (AS_JSON) {
  process.stdout.write(JSON.stringify(data.runs, null, 2) + '\n');
  process.exit(0);
}

if (!data.projDir) {
  console.error('Could not locate the Claude projects directory under', PROJECTS_DIR);
  process.exit(1);
}

const html = renderHtml(data);
fs.writeFileSync(OUT_HTML, html);
console.log(`Wrote ${data.runs.length} scheduled run(s) to:\n  ${OUT_HTML}`);

if (!NO_OPEN) {
  // Windows: `start`; mac: `open`; linux: `xdg-open`.
  const opener = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const openArgs = process.platform === 'win32' ? ['/c', 'start', '', OUT_HTML] : [OUT_HTML];
  try {
    spawn(opener, openArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    console.log('(could not auto-open; open the file above manually)');
  }
}
