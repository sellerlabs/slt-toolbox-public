#!/usr/bin/env node
// Clean-install test for mcps/playwright-mcp: copies the package to a temp folder,
// runs `npm install` there with no global engine visible, then starts each mode,
// checks the tool list and loads a local page. No dependencies; needs Node 22+.
// Usage: node playwright-install-test.mjs <path-to-playwright-mcp>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';

const src = path.resolve(process.argv[2] || 'mcps/playwright-mcp');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-'));
const pkg = path.join(work, 'mcps', 'playwright-mcp');
fs.cpSync(src, pkg, { recursive: true, filter: (f) => path.basename(f) !== 'node_modules' });
execSync('npm install --no-audit --no-fund', { cwd: pkg, stdio: 'inherit' });

const none = path.join(work, 'none');
// No global engine may be found, or a broken local install would go unnoticed.
const env = { ...process.env, APPDATA: none, npm_config_prefix: none };
delete env.PLAYWRIGHT_MCP_SKIP;
const PORT = 3466;
const CDP_PORT = 9466;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + String(detail).slice(0, 400)}`);
};
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, e.stack); } };
const deadline = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout: ' + what)), ms).unref())]);

const site = http.createServer((q, r) => {
  r.setHeader('content-type', 'text/html');
  r.end('<title>t</title><h1>install test page</h1>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/`;

// Minimal JSON-RPC client; `send` is the only transport-specific part.
function rpc(send) {
  let id = 0;
  const pending = new Map();
  return {
    receive(line) {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const done = pending.get(m.id);
      if (done) { pending.delete(m.id); done(m); }
    },
    request(method, params) {
      const n = ++id;
      const p = new Promise((r) => pending.set(n, r));
      send({ jsonrpc: '2.0', id: n, method, params });
      return deadline(p, 90000, method);
    },
    async init() {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-test', version: '1' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
  };
}

function stdio(script) {
  const child = spawn(process.execPath, [path.join(pkg, script)], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const c = rpc((m) => child.stdin.write(JSON.stringify(m) + '\n'));
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((x) => c.receive(x));
  });
  return { c, child };
}

async function handshake(c, mode) {
  await c.init();
  const { tools } = (await c.request('tools/list', {})).result;
  check(`${mode}: tool list`, tools.length >= 20, tools.length + ' tools');
  return tools;
}

async function loadPage(c, mode) {
  const r = await c.request('tools/call', { name: 'browser_navigate', arguments: { url } });
  const text = JSON.stringify(r);
  check(`${mode}: loads a page`, !r.error && !r.result?.isError && text.includes('install test page'), text);
}

await step('headless', async () => {
  const { c, child } = stdio('playwright-mcp-headless.js');
  try {
    await handshake(c, 'headless');
    await loadPage(c, 'headless');
    await c.request('tools/call', { name: 'browser_close', arguments: {} });
  } finally { child.kill(); }
});

// Handshake only: the bridge port is fixed at 3456, so a page load there could drive
// a developer's live browser.
let bridgeTools = [];
await step('launcher', async () => {
  const { c, child } = stdio('playwright-mcp-launcher.js');
  try { await handshake(c, 'launcher'); } finally { child.kill(); }
});
await step('visible bridge', async () => {
  const { c, child } = stdio('playwright-mcp-visible.js');
  try { bridgeTools = await handshake(c, 'visible bridge'); } finally { child.kill(); }
});

// Shared server: real Chrome page load over SSE, on its own ports, home and profile.
await step('server', async () => {
  // A relative profile name keeps the test profile out of ~/.playwright-profiles.
  // (Faking HOME/USERPROFILE instead stops Chrome opening its debug port on Windows.)
  const profile = path.relative(path.join(os.homedir(), '.playwright-profiles'), path.join(work, 'install-test-' + process.pid));
  fs.mkdirSync(path.join(os.homedir(), 'Downloads'), { recursive: true });
  const child = spawn(process.execPath, [path.join(pkg, 'playwright-mcp-server.js')], {
    env: { ...env, PLAYWRIGHT_MCP_PORT: String(PORT), PLAYWRIGHT_MCP_CDP_PORT: String(CDP_PORT), PLAYWRIGHT_MCP_PROFILE: profile },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    let res = null;
    for (let i = 0; i < 60 && !res; i++) {
      if (exited) throw new Error('server exited early');
      res = await new Promise((r) => {
        http.get(`http://localhost:${PORT}/sse`, r).on('error', () => setTimeout(() => r(null), 500));
      });
    }
    if (!res) throw new Error('server never listened');
    let endpoint;
    let ready;
    const gotEndpoint = new Promise((r) => { ready = r; });
    const c = rpc((m) => {
      fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) }).catch(() => {});
    });
    let buf = '';
    let event = '';
    res.setEncoding('utf8');
    res.on('error', () => {});
    res.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const x of lines) {
        if (x.startsWith('event: ')) event = x.slice(7).trim();
        else if (x.startsWith('data: ')) {
          if (event === 'endpoint') { endpoint = `http://localhost:${PORT}${x.slice(6).trim()}`; ready(); } else c.receive(x.slice(6));
        }
      }
    });
    await deadline(gotEndpoint, 15000, 'sse endpoint');
    const tools = await handshake(c, 'server');
    const names = (t) => JSON.stringify(t.map((x) => x.name).sort());
    check('tools-cache.json matches the engine', names(tools) === names(bridgeTools), 'cached names differ from live names');
    await loadPage(c, 'server (system Chrome)');
  } finally {
    // Close the Chrome the server spawned, through its own debug port.
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      await new Promise((r) => {
        const ws = new WebSocket(webSocketDebuggerUrl);
        ws.onopen = () => ws.send('{"id":1,"method":"Browser.close"}');
        ws.onclose = ws.onerror = r;
        setTimeout(r, 5000);
      });
    } catch { /* Chrome never started */ }
    child.kill();
  }
});

console.log(failed ? `${failed} check(s) failed` : 'All install checks passed');
process.exit(failed ? 1 : 0);
