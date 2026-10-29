// Warms the lazy-hub MCP before a scheduled `claude -p` task that depends on it.
//
// Why (2026-10-28): x-post-ai-was-bad-so-i-quit fired at 09:30, the CLI took ~3.7 min
// to reach its first turn, and no lazy-hub tool (not even hub_rediscover) was ever
// visible to the agent. It waited, ended its turn on a background Monitor, and exited 0
// without posting. Yesterday's identical job found a warm hub and posted in 2.5 min.
// A cold hub needs ~55s to discover its children; a warm one ~5s, and that warmth
// (OS page cache, refreshed tokens) is shared with the NEXT hub process, i.e. the one
// the task's own CLI spawns. See lazy-hub-mcp/lazy-hub-mcp-Context.md
// "Cold-start timing and the partial-toolset trap".
//
// So: start a throwaway hub over stdio, exactly as a client would, and poll tools/list
// until every tool the task needs is listed and the hub_discovery_in_progress sentinel
// is gone. Then kill it. Best-effort: never throws, always resolves.

const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 150000;
const POLL_MS = 5000;

function prewarmHub({ projectRoot, tools = [], timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const serverPath = path.join(projectRoot, 'Tools', 'lazy-hub-mcp', 'server.js');
    let child;
    try {
      child = spawn(process.execPath, ['--use-system-ca', serverPath], {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, ms: 0, reason: `spawn failed: ${e.message}` });
    }

    let buf = '';
    let nextId = 1;
    const pending = new Map();
    let done = false;
    let pollTimer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      if (pollTimer) clearTimeout(pollTimer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ...result, ms: Date.now() - started });
    };
    const overall = setTimeout(() => finish({ ok: false, reason: `timed out after ${timeoutMs}ms` }), timeoutMs);

    const send = (method, params, isNotification = false) => {
      const msg = { jsonrpc: '2.0', method, params };
      if (isNotification) {
        child.stdin.write(JSON.stringify(msg) + '\n');
        return Promise.resolve();
      }
      const id = nextId++;
      msg.id = id;
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(JSON.stringify(msg) + '\n');
      });
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    child.stdin.on('error', () => { /* hub exited; finish() handles it */ });
    child.on('exit', (code) => finish({ ok: false, reason: `hub exited early (code ${code})` }));
    child.on('error', (e) => finish({ ok: false, reason: `hub error: ${e.message}` }));

    const poll = async () => {
      if (done) return;
      const res = await send('tools/list', {});
      if (done) return;
      const names = new Set(((res.result && res.result.tools) || []).map(t => t.name));
      const missing = tools.filter(t => !names.has(t));
      const discovering = names.has('hub_discovery_in_progress');
      if (missing.length === 0 && !discovering) {
        return finish({ ok: true, toolCount: names.size });
      }
      log(`hub prewarm: ${names.size} tools listed${discovering ? ', discovery still running' : ''}${missing.length ? `, missing ${missing.join(', ')}` : ''}; retrying in ${POLL_MS / 1000}s`);
      // Discovery finished but a needed tool is absent: a child timed out during the
      // cold start and the hub will not retry it on its own, so re-listing never
      // helps (2026-10-28 smoke test: 278 of 532 tools, no x_*, for the full 150s).
      // By now the disk is warm, so a rediscover brings the child up in seconds.
      if (!discovering && missing.length) {
        log('hub prewarm: discovery done with tools missing; calling hub_rediscover');
        await send('tools/call', { name: 'hub_rediscover', arguments: {} });
        if (done) return;
      }
      pollTimer = setTimeout(poll, POLL_MS);
    };

    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'task-scheduler-prewarm', version: '1.0.0' },
    }).then(async () => {
      await send('notifications/initialized', {}, true);
      poll();
    });
  });
}

module.exports = { prewarmHub };
