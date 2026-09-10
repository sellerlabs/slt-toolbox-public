/**
 * playwright-mcp-visible.js
 *
 * Stdio ↔ SSE bridge for the shared Playwright MCP server.
 *
 * On each connect (every Claude Code window):
 *   1. Check if the shared server is running on PORT 3456
 *   2. If not, auto-start playwright-mcp-server.js as a detached background process
 *   3. Open an SSE session — gets its own tab in the shared Chrome window
 *   4. Bridge: stdin → POST /message,  SSE events → stdout
 *
 * Result: all Claude Code windows share ONE visible Chrome instance and ONE profile.
 * Sessions are tab-isolated but share cookies, logins, LastPass, etc.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
// Credential masking, shared with the headless bridge. See mask-credentials.js.
const { maskCredentials, selfTest } = require('./mask-credentials');

selfTest('playwright-mcp-visible');

const PORT = 3456;
const SERVER_SCRIPT = path.join(__dirname, 'playwright-mcp-server.js');

// ── Server health check ──────────────────────────────────────────────────────

function checkRunning() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/`, { timeout: 1000 }, res => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function waitForServer(maxMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => checkRunning().then(ok => {
      if (ok) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('Timed out waiting for playwright-mcp-server'));
      setTimeout(tick, 500);
    });
    tick();
  });
}

async function ensureServer() {
  if (await checkRunning()) {
    process.stderr.write('[playwright-mcp-visible] Connecting to existing server\n');
    return;
  }
  process.stderr.write('[playwright-mcp-visible] Starting shared server...\n');
  if (process.platform === 'win32') {
    // Windows needs TWO properties at once, and they pull in opposite directions:
    //
    //   1. Escape VS Code's Job Object. VS Code tree-kills its whole process tree
    //      on session close; detached+unref does NOT escape a Job Object, so the
    //      server AND its child Chrome died with the session.
    //   2. Run in the INTERACTIVE desktop session (session 1), or Chrome renders
    //      on a desktop nobody can see.
    //
    // The old fix used WMI (Win32_Process.Create). That satisfies (1) — the parent
    // becomes WmiPrvSE.exe, outside the job — but BREAKS (2): WMI-created processes
    // inherit session 0, the non-interactive service session. Chrome launched fine
    // and was fully drivable over CDP, but had no visible window on the user's desktop.
    // That is the "visible browser is invisible" bug.
    //
    // Scheduled Tasks satisfy BOTH. The task is registered to run as the current
    // INTERACTIVE user, so Task Scheduler starts it in that user's active session
    // (visible desktop), and the process is parented to svchost/taskeng — outside
    // VS Code's job, so it survives session close.
    const taskName = 'PlaywrightMcpSharedServer';
    // Task Scheduler has NO ShowWindow/SW_HIDE option, so an action pointing
    // straight at node.exe always allocates a visible conhost.exe console on the
    // desktop. Go through a wscript.exe VBScript shim instead: wscript is itself
    // windowless and its Run(cmd, 0, False) starts node with a hidden window.
    const vbsShim = path.join(__dirname, 'launch-server-hidden.vbs');
    const vbsArgs = `/nologo \"${vbsShim}\" \"${process.execPath}\" \"${SERVER_SCRIPT}\"`;
    const action = `New-ScheduledTaskAction -Execute 'wscript.exe' ` +
      `-Argument '${vbsArgs.replace(/'/g, "''")}' ` +
      `-WorkingDirectory '${path.dirname(SERVER_SCRIPT).replace(/'/g, "''")}'`;
    // Interactive logon-token principal == runs in the visible desktop session.
    // RunLevel Limited: no elevation, so no UAC prompt.
    const principal = `New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" ` +
      `-LogonType Interactive -RunLevel Limited`;
    // ExecutionTimeLimit 0 = never auto-kill the long-lived server.
    // AllowStartIfOnBatteries/-DontStopIfGoingOnBatteries: laptop power state must
    // not terminate it.
    const settings = `New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries ` +
      `-DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) ` +
      `-MultipleInstances IgnoreNew`;
    const psCommand =
      `$ErrorActionPreference='Stop'; ` +
      `$a = ${action}; $p = ${principal}; $s = ${settings}; ` +
      // Re-register every launch so an edited SERVER_SCRIPT path/exe is picked up.
      `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Principal $p ` +
      `-Settings $s -Force | Out-Null; ` +
      `Start-ScheduledTask -TaskName '${taskName}'`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    // Mac/Linux: plain detach works.
    const srv = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    srv.unref();
  }
  await waitForServer();
  process.stderr.write('[playwright-mcp-visible] Server ready\n');
}

// ── Unicode sanitization ─────────────────────────────────────────────────────

// Playwright snapshots of real websites can contain lone Unicode surrogates
// (U+D800–U+DFFF) that are invalid JSON. The Anthropic API rejects any request
// body containing them with a 400 "no low surrogate in string" error.
// Sanitize before writing to stdout so Claude Code never sends bad JSON to the API.
function sanitizeSurrogates(str) {
  // Replace JSON-escaped surrogates: \uD800–\uDFFF  (lone or paired — both halves)
  str = str.replace(/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/g, '\\uFFFD');
  // Replace actual surrogate code-units that slipped through as raw chars
  str = str.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  return str;
}

// ── Snapshot pruning (COMPRESS_SNAPSHOTS=0 to disable) ───────────────────────

// Shrinks large ARIA snapshots before they reach the main context window.
//
// This was previously an Anthropic API call to Haiku. It is now purely
// deterministic: no network, no API key, no latency, and identical behavior
// for anyone who clones this MCP standalone. Measured on live pages
// (2026-09-10): Amazon search 434KB -> 147KB (66% smaller), GitHub org
// 35KB -> 21KB (40%), Wikipedia article 83KB -> 64KB (24%), with every
// button/link/textbox/checkbox preserved exactly.
//
// The model was mostly being paid to delete strings. On commerce pages ~66%
// of a snapshot is opaque ad-tracking URLs (avg 482 chars, up to 1849), which
// a regex removes for free. Prose-heavy pages compress least here, since
// condensing prose is the one genuinely model-shaped job; if that ever
// matters more than cost, reintroduce a model pass behind an explicit flag.

// Container/noise node types that carry no information on their own.
const NOISE_NODE = /^\s*-\s*(generic|img|status|listitem|paragraph|list|search|group|banner|contentinfo|navigation)\s*:?\s*$/;
// A pure wrapper: a container line whose only role is to introduce deeper nodes.
const WRAPPER_NODE = /^\s*-\s*(generic|list|listitem|group)\s+"?[^"]*"?\s*:\s*$/;
const INDENT_OF = (l) => l.match(/^\s*/)[0].length;

function pruneSnapshot(text) {
  let lines = text.split(/\r?\n/);

  // 1. Strip per-element annotations. `ref` ids are only valid for the current
  //    page state and `cursor=pointer` is never actionable.
  lines = lines.map((l) => l.replace(/\s*\[ref=e\d+\]/g, '').replace(/\s*\[cursor=pointer\]/g, ''));

  // 2. Drop nodes with no label, no text and no state.
  lines = lines.filter((l) => !NOISE_NODE.test(l));

  // 3. Collapse wrapper chains that contribute only indentation.
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (WRAPPER_NODE.test(l) && i + 1 < lines.length && INDENT_OF(lines[i + 1]) > INDENT_OF(l)) continue;
    kept.push(l);
  }
  lines = kept;

  // 4. Trim URLs to something still navigable: keep scheme+host+path, drop the
  //    query string (tracking payloads), cap the remainder. Also drop a /url
  //    line whose target the preceding link text already states.
  const out = [];
  for (const l of lines) {
    const u = l.match(/^(\s*-\s*\/url:\s*)(\S+)\s*$/);
    if (u) {
      const prev = out[out.length - 1] || '';
      const target = u[2].trim();
      if (prev.includes(target)) continue;
      out.push(u[1] + target.split('?')[0].slice(0, 80));
      continue;
    }
    out.push(l);
  }

  return out.join('\n').replace(/\n{2,}/g, '\n');
}

// Intercepts SSE → stdout writes. Unless COMPRESS_SNAPSHOTS=0, prunes any
// tool result text content larger than 10KB via pruneSnapshot().
async function handleSseData(data) {
  data = sanitizeSurrogates(data);

  // Mask credential values first, unconditionally. Parsed separately from the
  // pruning block so a pruning failure (or COMPRESS_SNAPSHOTS=0) can
  // never bypass the mask.
  try {
    const msg = JSON.parse(data);
    const items = msg?.result?.content;
    if (Array.isArray(items)) {
      let masked = false;
      for (const item of items) {
        if (item.type === 'text' && item.text) {
          const out = maskCredentials(item.text);
          if (out !== item.text) { item.text = out; masked = true; }
        }
      }
      if (masked) {
        data = JSON.stringify(msg);
        process.stderr.write('[playwright-mcp-visible] Masked credential field value(s) in tool result\n');
      }
    }
  } catch (e) {
    process.stderr.write(`[playwright-mcp-visible] Mask error: ${e.message}\n`);
  }

  if (process.env.COMPRESS_SNAPSHOTS !== '0') {
    try {
      const msg = JSON.parse(data);
      const items = msg?.result?.content;
      if (Array.isArray(items)) {
        let compressed = false;
        for (const item of items) {
          if (item.type === 'text' && item.text && item.text.length > 10000) {
            const before = item.text.length;
            item.text = pruneSnapshot(item.text);
            process.stderr.write(
              `[playwright-mcp-visible] Snapshot pruned: ${before}B → ${item.text.length}B\n`
            );
            compressed = true;
          }
        }
        if (compressed) data = JSON.stringify(msg);
      }
    } catch (e) {
      process.stderr.write(`[playwright-mcp-visible] Pruning error (using original): ${e.message}\n`);
    }
  }

  process.stdout.write(data + '\n');
}

// ── SSE bridge ───────────────────────────────────────────────────────────────

function connectSSE(onClose) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let curEvent = null;
    let resolved = false;

    const req = http.get(`http://localhost:${PORT}/sse`, res => {
      res.setEncoding('utf8');

      res.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            curEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (curEvent === 'endpoint') {
              // Server tells us where to POST messages for this session
              const endpoint = `http://localhost:${PORT}${data}`;
              process.stderr.write(`[playwright-mcp-visible] Session ready\n`);
              if (!resolved) { resolved = true; resolve(endpoint); }
            } else if (resolved) {
              // Forward server → client JSON-RPC responses to stdout
              handleSseData(data).catch(e => {
                process.stderr.write(`[playwright-mcp-visible] handleSseData error: ${e.message}\n`);
                // Mask on the fallback path too — an error here must not become a bypass.
                process.stdout.write(maskCredentials(sanitizeSurrogates(data)) + '\n');
              });
            }
            curEvent = null;
          } else if (line === '') {
            curEvent = null;
          }
        }
      });

      res.on('end', () => {
        process.stderr.write('[playwright-mcp-visible] SSE connection closed — will re-init on next tool call\n');
        if (onClose) onClose();
      });
      res.on('error', err => {
        if (!resolved) return reject(err);
        process.stderr.write(`[playwright-mcp-visible] SSE error (${err.message}) — will re-init on next tool call\n`);
        if (onClose) onClose();
      });
    });

    req.on('error', reject);
  });
}

function postMessage(endpoint, msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(msg);
    const u = new URL(endpoint);
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Stub mode: if PLAYWRIGHT_MCP_SKIP=1, respond to MCP handshake messages with
  // empty/minimal responses and never start Chrome. Used by scheduled tasks that
  // don't need Playwright so Chrome doesn't pop up in the background.
  if (process.env.PLAYWRIGHT_MCP_SKIP === '1') {
    process.stderr.write('[playwright-mcp-visible] Stub mode (PLAYWRIGHT_MCP_SKIP=1) — Chrome will not start\n');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Respond only to requests that expect a response (have an id)
          if (msg.id != null) {
            let result;
            if (msg.method === 'initialize') {
              result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'playwright-mcp-visible', version: '1.0.0' } };
            } else if (msg.method === 'tools/list') {
              result = { tools: [] };
            }
            if (result !== undefined) {
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
            }
          }
        } catch (e) { /* ignore malformed JSON */ }
      }
    });
    process.stdin.on('end', () => process.exit(0));
    return;
  }

  // Fast handshake: respond to initialize and tools/list immediately from a local cache,
  // without waiting for the SSE server. This prevents VS Code from timing out during
  // MCP initialization. SSE is only connected when a real tool call arrives.
  const toolsCachePath = path.join(__dirname, 'tools-cache.json');
  let cachedTools = [];
  try {
    cachedTools = JSON.parse(fs.readFileSync(toolsCachePath, 'utf8'));
  } catch (e) {
    process.stderr.write('[playwright-mcp-visible] No tools cache — tools/list will return empty until first use\n');
  }

  // SSE state (lazy init — only on first actual tool call)
  let endpoint = null;
  let initPromise = null;

  function initOnce() {
    if (endpoint) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      process.stderr.write('[playwright-mcp-visible] First tool call — initializing server\n');
      await ensureServer();
      endpoint = await connectSSE(() => {
        // Drop the stale session so the next initOnce() rebuilds it.
        endpoint = null;
        initPromise = null;
      });
    })();
    return initPromise;
  }

  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    stdinBuf += chunk;
    const lines = stdinBuf.split('\n');
    stdinBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const isHandshake = msg.method === 'initialize' || msg.method === 'tools/list';
        const isNotification = msg.id == null; // notifications have no id

        if (isHandshake && msg.id != null) {
          // Respond immediately from local state — no SSE needed
          let result;
          if (msg.method === 'initialize') {
            result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'playwright-mcp-visible', version: '1.0.0' } };
          } else if (msg.method === 'tools/list') {
            result = { tools: cachedTools };
          }
          process.stdout.write(sanitizeSurrogates(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) + '\n');
        } else if (isNotification) {
          // Notifications (e.g. notifications/initialized) need no response — ignore
        } else {
          // Actual tool call — connect SSE and forward
          if (!endpoint) {
            initOnce().then(() => {
              postMessage(endpoint, msg).catch(e => {
                process.stderr.write('[playwright-mcp-visible] POST error: ' + e.message + '\n');
              });
            }).catch(e => {
              // Reset instead of exiting: a cached rejected initPromise would otherwise
              // wedge every later call, and killing the child drops the user's tabs.
              process.stderr.write('[playwright-mcp-visible] Init error: ' + e.message + ' — will retry on next tool call\n');
              endpoint = null;
              initPromise = null;
            });
          } else {
            postMessage(endpoint, msg).catch(e => {
              process.stderr.write('[playwright-mcp-visible] POST error: ' + e.message + '\n');
            });
          }
        }
      } catch (e) { /* malformed JSON — ignore */ }
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

main().catch(e => {
  process.stderr.write('[playwright-mcp-visible] Fatal: ' + e.message + '\n');
  process.exit(1);
});
