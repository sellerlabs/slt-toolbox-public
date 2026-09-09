# lazy-hub-mcp Context

> This is the shared (slt-toolbox) copy. It documents lazy-hub generically and
> lists only the MCPs distributed via slt-toolbox. Register your own children in
> `children.json` (start from `children.example.json`).

## What It Is

A single MCP proxy/aggregator that lazy-spawns child MCP servers on demand.
Claude Code registers only one MCP entry (`lazy-hub`) and all child tools are
exposed under `mcp__lazy-hub__*`.

Children are spawned on first tool call and killed after 30 minutes of idle time.

## Architecture

- **Entry point:** `lazy-hub-mcp/server.js`
- **Child registry:** `lazy-hub-mcp/children.json` (NOT hardcoded in server.js — see below). Start from `children.example.json`.
- **Registered in:** your Claude config as `lazy-hub`
- **Protocol:** stdio JSON-RPC 2.0 (MCP SDK)
- **Tool namespacing:** every tool is prefixed with its `{serverKey}_` (hyphens → underscores)

## Child Registry — children.json (no VS Code reload to add a child)

The child list lives in `children.json`, which the hub **re-reads on every `hub_rediscover`**. This means adding a brand-new MCP no longer requires a VS Code reload:

1. Check out or create the child MCP folder (server.js, .env/config, context doc).
2. Add an entry to the `children.json` `children` block.
3. Call `mcp__lazy-hub__hub_rediscover` (no `server_key`, or the new key).
4. **Start a new conversation** to actually *use* the new tools — they arrive as deferred tools, snapshotted at conversation start (the `tools/list_changed` notification can't inject them mid-conversation). No reload needed at any point.

`children.json` per-child fields: `command`, `args`, `cwd` (relative to the lazy-hub-mcp folder), `env` (array of `process.env` keys forwarded to that child — most are `[]` since children load their own creds from local JSON), optional `callTimeout` (ms).

**Robustness:** if `children.json` is mid-edit / invalid JSON when `hub_rediscover` fires, the hub logs an error and keeps the last-good registry rather than wiping all children. Fix the JSON and rediscover again.

## Startup Robustness (a slow child can no longer mark the hub "Failed")

Startup discovery is bounded so one hung/slow child cannot stop the hub from answering VS Code's `initialize` handshake:

- **Per-child timeout** — `discoverTools` races connect+`listTools` against `DISCOVERY_TIMEOUT_MS` (15s) and always closes the client in `finally`, so a hung child is abandoned and its process killed (no leaks).
- **Startup cap** — discovery runs inside `runDiscovery()`; the hub connects its transport no later than `STARTUP_DISCOVERY_CAP_MS` (8s) even if discovery is unfinished. Healthy children finish in ~5s, so normally the hub connects *with* all tools already loaded. If discovery overruns, it connects anyway and fires `sendToolListChanged()` when it completes.
- **Debugging a "Failed" hub:** run `node --use-system-ca server.js` standalone — it logs each child's tool count and any `WARNING: discovery failed`. A child that times out at ~15s is the culprit; remove or fix it in `children.json`. Since a Failed hub is a dead process, `hub_rediscover` is unavailable, so picking up `children.json`/`server.js` fixes needs a **VS Code reload** (not just rediscover).

## Child Servers (shared via slt-toolbox)

| Key | Folder | Command | Tools Prefix |
|---|---|---|---|
| `mysql` | mysql-mcp | `node server.js` | `mysql_*` |
| `aws-insights` | aws-insight-mcp | `node server.js` | `aws_insights_*` |
| `slt-admin` | admin-mcp | `node server.js` | `slt_*` |
| `playwright-visible` | playwright-mcp | `node playwright-mcp-visible.js` | `browser_*` |
| `playwright-headless` | playwright-mcp | `node playwright-mcp-headless.js` | `browser_*` |

Add any other children you run locally to `children.json` the same way.

## Env Vars

Child env vars are injected via the `lazy-hub` `env` block in your Claude config. Each child only receives the keys listed in its `env` array in `children.json` — env is isolated per child. (Most children load credentials from their own local JSON, so their `env` is `[]`.)

## Special Tool: `hub_rediscover`

Call `mcp__lazy-hub__hub_rediscover` to make the hub **re-read `children.json`**, re-spawn children, and re-register their tools — without a VS Code reload. This picks up brand-new children added to `children.json`, not just new tools inside existing children.

**Important:** `hub_rediscover` only affects the current VS Code session's LazyHub instance. Each open VS Code window has its own LazyHub process. Other sessions retain stale child processes and require their own `hub_rediscover` call (or a full VS Code reload) to pick up the change.

## Child Server Gotchas

### slt-admin (`admin-mcp`)
- The Retool query `get_account_history_all` uses raw SQL string interpolation, NOT bound parameters. Date params must be passed as `"2026-04-11"` (with literal embedded double-quotes). Passing unquoted dates returns 0 rows with no error.
- The query returns ~85K rows/30 days across all event types. Always pass a SQL fragment to filter server-side (e.g. `'AND type = "mcp_tool_usage"'`). Without it, the full table is downloaded and the MCP stdio pipe times out.
