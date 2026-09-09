/**
 * Lazy MCP Hub
 *
 * Acts as a single MCP server to Claude while lazy-spawning child MCP servers
 * only when their tools are actually called. Children are kept alive for 30 min
 * of idle time, then killed automatically.
 *
 * Uses the low-level Server API to forward exact child inputSchemas to Claude,
 * so all parameters are passed through correctly.
 *
 * Configured child servers: robinhood, opusclip, quickbooks, ynab,
 *                           atlassian (jira), basecamp, slt-admin, supabase,
 *                           github (npx), codex
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CHILD SERVER CONFIG ─────────────────────────────────────────────────────
// The child registry lives in children.json (NOT hardcoded here) so the hub can
// re-read it on every hub_rediscover — adding a new MCP needs only a children.json
// edit + hub_rediscover, no VS Code reload. children.json fields per child:
//   command, args, cwd (relative to this folder), env (process.env keys to
//   forward), and optional callTimeout (ms).
//
// All tools are always prefixed with their serverKey (hyphens -> underscores),
// so the child MCP source is always visible in the VS Code activity display.
// e.g. github's search_repositories -> github_search_repositories.

const CHILDREN_PATH = resolve(__dirname, 'children.json');

function resolveDir(rel) {
  return resolve(__dirname, rel);
}

/**
 * Read children.json fresh and return a map of serverKey -> normalized config
 * { command, args, cwd (absolute), env (string[]), callTimeout? }.
 * Read on every call so edits take effect via hub_rediscover without a reload.
 */
function loadChildren() {
  let raw;
  try {
    raw = readFileSync(CHILDREN_PATH, 'utf8');
  } catch (err) {
    process.stderr.write(`[lazy-hub] FATAL: cannot read children.json: ${err.message}\n`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[lazy-hub] ERROR: children.json is not valid JSON (${err.message}) — keeping previous config\n`);
    return null; // signal "bad file" so callers can fall back to last-good
  }
  const out = {};
  for (const [key, cfg] of Object.entries(parsed.children || {})) {
    out[key] = {
      command: cfg.command,
      args: cfg.args || [],
      cwd: resolveDir(cfg.cwd),
      env: cfg.env || [],
      ...(cfg.callTimeout ? { callTimeout: cfg.callTimeout } : {}),
      ...(cfg.discoveryTimeout ? { discoveryTimeout: cfg.discoveryTimeout } : {}),
      ...(cfg.envVars ? { envVars: cfg.envVars } : {}),
      ...(cfg.noIdleTimeout ? { noIdleTimeout: true } : {}),
    };
  }
  return out;
}

// Last-good child config — refreshed whenever children.json parses cleanly, so a
// mid-edit broken JSON file never wipes the running registry.
let CHILD_SERVERS = loadChildren() || {};

/** Reload children.json into CHILD_SERVERS; on parse error keep the last-good map. */
function refreshChildren() {
  const next = loadChildren();
  if (next === null) return CHILD_SERVERS; // bad JSON — keep last-good
  CHILD_SERVERS = next;
  return CHILD_SERVERS;
}

const IDLE_MS = 30 * 60 * 1000; // 30 minutes

// Startup-safety caps. A single child that hangs on connect/listTools must never
// stall the whole hub: DISCOVERY_TIMEOUT_MS bounds each child's discovery, and the
// hub answers the client's initialize handshake immediately, before discovery has
// finished (a slow child previously made the whole hub show up as "Failed" in
// VS Code). NOTE: an older STARTUP_DISCOVERY_CAP_MS (8s) constant was removed; only
// the two constants below exist now.
const DISCOVERY_TIMEOUT_MS = 18 * 1000; // per-child timeout for on-demand spawns and startup discovery retries

// Bounds how long the FIRST tools/list call will wait on startup discovery
// before answering with whatever's registered so far. Prevents a client (esp.
// a headless `claude -p` run whose first turn calls ToolSearch within seconds
// of connect) from racing ahead of background discovery and seeing an
// incomplete tool list with no guaranteed follow-up query.
//
// ⚠️ MEASURED 2026-08-11: THIS CAP IS TOO SHORT ON A TRULY COLD START, and the
// comment that used to sit here ("comfortably above discoverToolsWithRetry's worst
// case") was wrong. On a cold machine, 7 of 26 children time out at 18s on attempt
// 1 and google-workspace times out TWICE, so full discovery takes ~55s. The first
// tools/list therefore fires at 45s and returns a near-empty set (measured: 1 tool)
// AS A SUCCESSFUL RESPONSE, with no in-band signal that discovery is still running.
// A headless `claude -p` client reads that as "my tools do not exist" and gives up
// ~4s before they arrive. This is the root cause of four scheduled-task failures
// (7/04, 8/09, 8/10, 8/11). A warm-substrate second run finishes in ~5s, which is
// why this went unnoticed for so long: it only reproduces from a genuinely cold
// page cache. See lazy-hub-mcp-Context.md § "Cold-start timing and the partial-toolset trap".
//
// FIXED 2026-08-11, two changes, because raising this cap alone would not have been
// enough: (1) the cap is now 90s, clearing the measured ~55s worst case with margin;
// (2) more importantly, the tools/list handler no longer presents a partial set as if
// it were complete — it prepends a `hub_discovery_in_progress` sentinel tool whenever
// discovery is still running, so a client that asks early is TOLD the list is
// incomplete instead of concluding its tools do not exist. Verified by forcing this
// cap to 1ms: the early list came back labeled, and the sentinel self-cleared on the
// post-discovery re-fetch.
//
// Related: a child with its own larger `discoveryTimeout` in children.json
// (codegraph: 60s, for a cold-start open of a ~186MB SQLite graph) exceeds this cap
// even on a warm start. Discovery runs in parallel per child, so it delays no one
// else, and sendToolListChanged fires when it finishes to prompt a re-fetch.
// Raised 45s -> 90s on 2026-08-11 against the measured ~55s cold discovery, so the
// cap clears the real worst case with margin instead of losing to it by ~5s. Warm
// starts are unaffected: discovery finishes in ~5s and this promise resolves early,
// so the cap is a ceiling, never a delay. Even cold, the client waits only until
// discovery actually completes.
const FIRST_LIST_WAIT_CAP_MS = 90 * 1000;

// ─── PER-CHILD ENV ISOLATION ─────────────────────────────────────────────────
// Windows system vars needed for Node.js to function + child-specific secrets.
// Most child servers load credentials from local JSON files, so process.env
// leakage is limited to the keys each child lists in children.json `env`.

const WINDOWS_BASE_KEYS = [
  'PATH', 'NODE_ENV', 'NODE_PATH',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir',
  'COMSPEC', 'OS', 'COMPUTERNAME', 'USERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
];

function buildChildEnv(serverKey) {
  const env = {};
  for (const key of WINDOWS_BASE_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of (CHILD_SERVERS[serverKey]?.env || [])) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Literal key/value pairs from children.json `envVars`. Unlike `env` (which
  // forwards keys already present in process.env), these set values the hub
  // defines itself — used to align a child's internal lifecycle timers with the
  // hub's own IDLE_MS. Applied last so they win over a forwarded key.
  Object.assign(env, CHILD_SERVERS[serverKey]?.envVars || {});
  return env;
}

// ─── RUNTIME STATE ───────────────────────────────────────────────────────────

// serverKey -> { client: Client, timer: Timeout }
const runningClients = new Map();

// toolName (as exposed to Claude) -> serverKey
const toolToServer = new Map();

// toolName (as exposed to Claude) -> { name, description, inputSchema }
const toolDefs = new Map();

// hubToolName -> childToolName (only set for prefixed tools, used at call time
// to forward the request under the name the child actually knows)
const toolOriginalName = new Map();

// ─── TOOL REGISTRATION ───────────────────────────────────────────────────────
// Registers a tool from a child under a hub-namespace name. Every tool is
// prefixed with its serverKey (hyphens -> underscores) so the source MCP is
// always visible in the VS Code activity display. Returns the exposed name on
// successful registration, or null if already registered (no-op on rediscover).

function registerTool(serverKey, tool) {
  const prefix = serverKey.replace(/-/g, '_');
  let toolName = tool.name;
  // Strip redundant prefix already present in child tool name.
  // Full match handles: opusclip_opusclip_*, x_x_*, ynab_ynab_*
  // Compound match handles: slt-admin prefix "slt_admin" stripping "slt_" from slt_get_cohorts
  if (toolName.startsWith(prefix + '_')) {
    toolName = toolName.slice(prefix.length + 1);
  } else if (prefix.includes('_')) {
    const firstSegment = prefix.split('_')[0];
    if (toolName.startsWith(firstSegment + '_')) {
      toolName = toolName.slice(firstSegment.length + 1);
    }
  }
  const exposedName = `${prefix}_${toolName}`;
  const known = toolDefs.has(exposedName);
  const nextDef = {
    name: exposedName,
    description: tool.description || `Tool from ${serverKey}`,
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
  // A tool already registered may still have CHANGED upstream (new param, new
  // description) after a child edit + hub_rediscover. Refresh the cached
  // definition rather than keeping the stale one, otherwise an added parameter
  // stays invisible to the client until a full VS Code reload.
  if (known) {
    const prev = toolDefs.get(exposedName);
    const changed = JSON.stringify(prev.inputSchema) !== JSON.stringify(nextDef.inputSchema)
      || prev.description !== nextDef.description;
    if (!changed) return null; // genuinely unchanged, keep rediscover a no-op
    toolDefs.set(exposedName, nextDef);
    toolToServer.set(exposedName, serverKey);
    toolOriginalName.set(exposedName, tool.name);
    return null; // updated in place, not a NEW tool
  }
  toolToServer.set(exposedName, serverKey);
  toolDefs.set(exposedName, nextDef);
  toolOriginalName.set(exposedName, tool.name);
  return exposedName;
}

// ─── LAZY CLIENT MANAGEMENT ──────────────────────────────────────────────────

async function killClient(serverKey) {
  const entry = runningClients.get(serverKey);
  if (!entry) return;
  clearTimeout(entry.timer);
  // Deliberate shutdown: drop the unexpected-death handler so it doesn't also
  // fire and log a misleading "closed unexpectedly".
  entry.client.onclose = undefined;
  runningClients.delete(serverKey);
  try { await entry.client.close(); } catch { /* ignore */ }
  process.stderr.write(`[lazy-hub] ${serverKey} idle timeout — killed\n`);
}

async function getOrSpawnClient(serverKey) {
  if (runningClients.has(serverKey)) {
    const entry = runningClients.get(serverKey);
    clearTimeout(entry.timer);
    // Children marked noIdleTimeout hold live state the reaper must not destroy
    // (e.g. playwright owns a browser session; killing it closes the user tab).
    entry.timer = CHILD_SERVERS[serverKey]?.noIdleTimeout
      ? null
      : setTimeout(() => killClient(serverKey), IDLE_MS);
    return entry.client;
  }

  const cfg = CHILD_SERVERS[serverKey];
  process.stderr.write(`[lazy-hub] spawning ${serverKey}...\n`);

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    cwd: cfg.cwd,
    env: buildChildEnv(serverKey),
  });

  const client = new Client({ name: `lazy-hub-${serverKey}`, version: '1.0.0' });
  await client.connect(transport);

  const timer = cfg.noIdleTimeout ? null : setTimeout(() => killClient(serverKey), IDLE_MS);
  const entry = { client, timer };
  // A child can die on its own (crash, external kill, OOM). Nothing else cleans
  // up `runningClients` except killClient(), so without this the dead client
  // stays cached and every later call returns "Not connected" until a manual
  // hub_rediscover. Evict on close so the next call spawns a fresh child.
  // Guarded by identity: a later respawn replaces the map entry, and this
  // handler must not delete that newer one when the old transport finally closes.
  client.onclose = () => {
    if (runningClients.get(serverKey) !== entry) return;
    clearTimeout(entry.timer);
    runningClients.delete(serverKey);
    process.stderr.write(`[lazy-hub] ${serverKey} closed unexpectedly — evicted, will respawn on next call\n`);
  };
  runningClients.set(serverKey, entry);
  process.stderr.write(`[lazy-hub] ${serverKey} ready\n`);
  return client;
}

// ─── STARTUP: DISCOVER TOOL SCHEMAS ─────────────────────────────────────────

async function discoverTools(serverKey, cfg, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    cwd: cfg.cwd,
    env: buildChildEnv(serverKey),
  });
  const client = new Client({ name: `lazy-hub-discovery-${serverKey}`, version: '1.0.0' });
  try {
    // Race the connect+listTools against a hard timeout so a hung child can't
    // block discovery. The outer finally still closes the client, killing the
    // child process even when the timeout wins (no leaked processes).
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`discovery timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    const work = (async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return tools;
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

// Discovery is fragile for children that build their tool list via a network
// call at spawn time (e.g. supabase fetches api.supabase.com on listTools). A
// single startup blip there used to leave the child with zero tools for the
// whole session, with no retry. Retry both a thrown error AND an empty tool
// list (the child can stay alive but return [] when its fetch fails) with
// exponential backoff so one transient network hiccup doesn't disable a child.
const DISCOVERY_RETRIES = 3;
const DISCOVERY_RETRY_BASE_MS = 750;

async function discoverToolsWithRetry(serverKey, cfg, timeoutMs = cfg?.discoveryTimeout ?? DISCOVERY_TIMEOUT_MS) {
  let lastErr;
  for (let attempt = 1; attempt <= DISCOVERY_RETRIES; attempt++) {
    try {
      const tools = await discoverTools(serverKey, cfg, timeoutMs);
      if (tools && tools.length > 0) return tools;
      lastErr = new Error('child returned zero tools');
    } catch (err) {
      lastErr = err;
    }
    if (attempt < DISCOVERY_RETRIES) {
      const delay = DISCOVERY_RETRY_BASE_MS * 2 ** (attempt - 1);
      process.stderr.write(`[lazy-hub] ${serverKey} discovery attempt ${attempt} failed (${lastErr?.message}); retrying in ${delay}ms\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error(`discovery failed for ${serverKey}`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const hubServer = new Server(
    { name: 'lazy-mcp-hub', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } }
  );

  // Resolves once the initial startup discovery pass finishes (see runDiscovery
  // below). The tools/list handler awaits this (bounded by FIRST_LIST_WAIT_CAP_MS)
  // on the first call only, so a fast-moving client's very first tool query
  // reflects the fully-discovered set instead of racing background discovery.
  let resolveStartupDiscovery;
  const startupDiscoveryDone = new Promise((resolve) => { resolveStartupDiscovery = resolve; });
  let firstListToolsCall = true;
  // Whether the startup discovery pass has actually FINISHED, as opposed to the
  // first-list race merely having settled. Read by the tools/list handler so it can
  // tell the client that an early list is incomplete instead of presenting a partial
  // set as if it were the whole thing. See the ⚠️ block on FIRST_LIST_WAIT_CAP_MS.
  let startupDiscoveryComplete = false;

  // Discover tools from all child servers in parallel. Defined here but invoked
  // after the request handlers are registered, so it can run either before the
  // connect (fast path) or in the background (if it exceeds the startup cap).
  async function runDiscovery() {
    process.stderr.write('[lazy-hub] discovering tools from child servers...\n');

    // TEST HOOK — inert in normal operation. Set LAZY_HUB_TEST_DELAY_MS to make
    // discovery artificially slow so a cold start can be reproduced on demand.
    // Killing hub processes is NOT enough to simulate one: the OS page cache
    // survives, so a "cold" hub still finishes in ~5s instead of the ~55s a truly
    // cold machine takes. This is the only practical way to exercise the
    // first-list race (and the hub_discovery_in_progress sentinel) before a real
    // 3 AM run. Never set this in children.json or ~/.claude.json.
    const testDelay = Number(process.env.LAZY_HUB_TEST_DELAY_MS || 0);
    if (testDelay > 0) {
      process.stderr.write(`[lazy-hub] TEST MODE: delaying discovery by ${testDelay}ms\n`);
      await new Promise((r) => setTimeout(r, testDelay));
    }

    const discoveries = await Promise.allSettled(
      Object.entries(CHILD_SERVERS).map(async ([serverKey, cfg]) => {
        const tools = await discoverToolsWithRetry(serverKey, cfg);
        return { serverKey, tools };
      })
    );

    for (const result of discoveries) {
      if (result.status === 'fulfilled') {
        const { serverKey, tools } = result.value;
        for (const tool of tools) registerTool(serverKey, tool);
        process.stderr.write(`[lazy-hub] ${serverKey}: ${tools.length} tools discovered\n`);
      } else {
        process.stderr.write(`[lazy-hub] WARNING: discovery failed: ${result.reason?.message}\n`);
      }
    }

    process.stderr.write(`[lazy-hub] total tools discovered: ${toolDefs.size}\n`);
    startupDiscoveryComplete = true;
    resolveStartupDiscovery();
  }

  // ─── TOOL: hub_rediscover (built-in) ─────────────────────────────────────
  toolDefs.set('hub_rediscover', {
    name: 'hub_rediscover',
    description: 'Re-read children.json and re-discover tools from child MCP servers, registering any new ones with Claude. Call this after adding new tools to a child OR after adding a brand-new child to children.json — no VS Code restart needed. (To USE a newly-registered tool, start a new conversation so it loads as a deferred tool.)',
    inputSchema: {
      type: 'object',
      properties: {
        server_key: {
          type: 'string',
          description: `Optional: one of ${Object.keys(CHILD_SERVERS).join(', ')}. Omit to rediscover all.`,
        },
      },
    },
  });

  // ─── LIST TOOLS ──────────────────────────────────────────────────────────
  // On the first call only, wait for startup discovery to finish (bounded by
  // FIRST_LIST_WAIT_CAP_MS) so a client that queries tools/list immediately
  // after connect — e.g. a headless `claude -p` run — gets the complete set
  // rather than whatever had registered so far. Subsequent calls return
  // immediately; sendToolListChanged (fired when discovery completes) already
  // prompts the client to re-fetch if it queried before that point anyway.
  hubServer.setRequestHandler(ListToolsRequestSchema, async () => {
    if (firstListToolsCall) {
      firstListToolsCall = false;
      await Promise.race([
        startupDiscoveryDone,
        new Promise((resolve) => setTimeout(resolve, FIRST_LIST_WAIT_CAP_MS)),
      ]);
    }

    const tools = Array.from(toolDefs.values());

    // If discovery is STILL running, this list is incomplete. Say so in-band.
    // MCP's tools/list has no "partial" flag and the response is not an error, so a
    // client that asked early previously could not distinguish "these are all the
    // tools" from "ask again in a moment" — it would reasonably conclude its tools
    // do not exist and give up. That is the root cause of four scheduled-task
    // failures (7/04, 8/09, 8/10, 8/11); on 8/11 a headless run gave up 4 seconds
    // before its tools arrived. The tool array is the one channel every client is
    // guaranteed to read, so the signal goes there.
    if (!startupDiscoveryComplete) {
      process.stderr.write(
        `[lazy-hub] WARNING: tools/list answered with ${tools.length} tools while discovery is still running — returning incomplete-set sentinel\n`
      );
      tools.unshift({
        name: 'hub_discovery_in_progress',
        description:
          `INCOMPLETE TOOL LIST — do not treat missing tools as unavailable. The lazy-hub MCP server is still starting its child servers, so only ${tools.length} of its tools are registered so far. A cold start takes roughly 55 seconds. If a tool you expect is missing, WAIT and re-query rather than concluding it does not exist; the hub sends a tools/list_changed notification when discovery completes. This sentinel disappears from the list once discovery is done.`,
        inputSchema: { type: 'object', properties: {} },
      });
    }

    return { tools };
  });

  // ─── CALL TOOL ───────────────────────────────────────────────────────────
  hubServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Built-in: hub_discovery_in_progress. Only ever listed while startup discovery
    // is still running (see the tools/list handler). Calling it blocks until
    // discovery finishes, so an agent that notices the sentinel has a way to WAIT
    // rather than guess or give up.
    if (name === 'hub_discovery_in_progress') {
      const waitStart = Date.now();
      await Promise.race([
        startupDiscoveryDone,
        new Promise((resolve) => setTimeout(resolve, FIRST_LIST_WAIT_CAP_MS)),
      ]);
      const waited = Math.round((Date.now() - waitStart) / 1000);
      const done = startupDiscoveryComplete;
      return {
        content: [{
          type: 'text',
          text: done
            ? `Discovery complete after waiting ${waited}s. ${toolDefs.size} tools are now registered. Re-query tools/list (or run ToolSearch again) and the tools you were missing should be present.`
            : `Discovery is STILL running after waiting ${waited}s, which is unusual. ${toolDefs.size} tools registered so far. Wait a little longer and re-query before concluding a tool is unavailable.`,
        }],
      };
    }

    // Built-in: hub_rediscover
    if (name === 'hub_rediscover') {
      // Re-read children.json so newly-added children are picked up without a
      // VS Code reload. (Bad JSON keeps the last-good registry.)
      refreshChildren();
      const { server_key } = args;
      const targets = server_key
        ? (CHILD_SERVERS[server_key] ? { [server_key]: CHILD_SERVERS[server_key] } : null)
        : CHILD_SERVERS;

      if (!targets) {
        return { content: [{ type: 'text', text: `Unknown server key: "${server_key}". Valid keys: ${Object.keys(CHILD_SERVERS).join(', ')}` }] };
      }

      const results = [];
      for (const [key, cfg] of Object.entries(targets)) {
        // Kill cached running client so next call spawns fresh with updated code
        if (runningClients.has(key)) await killClient(key);
        try {
          const tools = await discoverToolsWithRetry(key, cfg);
          const before = new Map([...toolDefs].map(([k, v]) => [k, JSON.stringify(v)]));
          const newTools = tools.map(t => registerTool(key, t)).filter(Boolean);
          // Tools whose cached definition registerTool refreshed in place. Surfaced
          // so a schema change is visible in the result, not silently swallowed.
          const updatedTools = [...toolDefs]
            .filter(([k, v]) => before.has(k) && before.get(k) !== JSON.stringify(v))
            .map(([k]) => k);
          process.stderr.write(`[lazy-hub] rediscover ${key}: ${tools.length} total, ${newTools.length} new, ${updatedTools.length} updated
`);
          results.push({ server: key, total: tools.length, new_tools: newTools, updated_tools: updatedTools });
        } catch (err) {
          process.stderr.write(`[lazy-hub] rediscover ${key} failed: ${err.message}\n`);
          results.push({ server: key, error: err.message });
        }
      }

      // Notify Claude of updated tool list
      await hubServer.sendToolListChanged();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    // Proxy to child server
    const serverKey = toolToServer.get(name);
    if (!serverKey) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    const client = await getOrSpawnClient(serverKey);
    const childToolName = toolOriginalName.get(name) || name;
    const cfg = CHILD_SERVERS[serverKey];
    const callOpts = cfg?.callTimeout ? { timeout: cfg.callTimeout } : undefined;
    const result = await client.callTool({ name: childToolName, arguments: args }, undefined, callOpts);
    return result;
  });

  // Connect immediately so VS Code's MCP handshake succeeds without racing
  // against a startup cap. Discovery runs in the background; when it finishes
  // sendToolListChanged notifies the client to re-fetch the full tool list.
  // This removes the coupling between discovery latency and VS Code's ~15s
  // handshake timeout that previously caused the hub to show as "Failed" when
  // slow children (e.g. OAuth-based google-workspace) pushed the cap above 15s.
  const transport = new StdioServerTransport();
  await hubServer.connect(transport);

  runDiscovery()
    .then(() => {
      process.stderr.write('[lazy-hub] startup discovery complete — notifying client\n');
      return hubServer.sendToolListChanged();
    })
    .catch((err) => {
      process.stderr.write(`[lazy-hub] startup discovery error: ${err?.message}\n`);
    });

  // Clean up on exit
  process.on('SIGTERM', async () => {
    for (const key of runningClients.keys()) await killClient(key);
    process.exit(0);
  });
}

main().catch(err => {
  process.stderr.write(`[lazy-hub] fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
