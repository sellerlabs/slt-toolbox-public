# lazy-hub-mcp — Agent Guide

AI coding-assistant instructions for the LazyHub aggregator MCP. Read `lazy-hub-mcp-Context.md` first.

## Stack
- Node.js, ES modules (`"type": "module"` in package.json).
- `@modelcontextprotocol/sdk` (^1.29.0) over stdio JSON-RPC 2.0.
- The hub is itself an MCP `Server` to Claude and an MCP `Client` to each child. It lazy-spawns each child as a `child_process` via `StdioClientTransport`, talking stdio to the child's own MCP server. Children spawn on first tool call and are killed after 30 min idle (`IDLE_MS`), except those flagged `"noIdleTimeout": true` in children.json (both playwright children, which own a live browser session).

## Layout
- `server.js` — hub logic: reads children.json, discovers/namespaces child tools, proxies calls, manages lazy spawn + idle kill, exposes `hub_rediscover`.
- `children.json` — the child registry the hub re-reads on every rediscover.
- `package.json` — name `lazy-mcp-hub`, ESM, single dependency `@modelcontextprotocol/sdk`.
- No `lib/`; all logic lives in `server.js`.

## children.json (the heart of it)
- Schema: `{ "children": { "<childkey>": { command, args, cwd, env, callTimeout? } } }`.
- `command` + `args` — how to spawn the child (e.g. `"node"` + `["--use-system-ca", "server.js"]`).
- `cwd` — relative to the lazy-hub-mcp folder; points at sibling tool folders like `../YNAB-MCP`. (A few are absolute paths, e.g. codegraph.)
- `env` — array of `process.env` key names forwarded into the child. Most are `[]` because children load their own creds from local config; only keys listed here (plus a Windows base set) reach the child.
- `callTimeout` — optional per-call timeout in ms (overrides the default), used for slow children.
- Tools surface to Claude as `mcp__lazy-hub__<childkey>_<toolname>`. Hyphens in the childkey become underscores, and a redundant leading prefix already in the child's tool name is stripped (e.g. `opusclip_opusclip_*` collapses to `opusclip_*`).

## Changing children or child code
- After editing `children.json` OR any child's server code, call `mcp__lazy-hub__hub_rediscover` (optionally pass `server_key` to target one child; omit to rediscover all). This kills the cached child client, respawns it fresh, re-reads `children.json`, re-registers tools, and fires `tools/list_changed`.
- NO VS Code reload is needed for code or registry changes — the hub re-reads children.json on every rediscover.
- A brand-new child added to children.json is picked up by rediscover and becomes usable in the same conversation: rediscover fires `sendToolListChanged()`, the harness surfaces the new tool as deferred, then `ToolSearch select:<tool>` loads its schema so it can be called. (Context.md still notes the older "start a new conversation" path; rediscover + ToolSearch is the proven in-session route.)
- If `children.json` is mid-edit / invalid JSON when rediscover fires, the hub logs an error and keeps the last-good registry rather than wiping all children. Fix the JSON and rediscover again.

## Auth / secrets
- The hub itself holds no secrets. Each child loads its own credentials from its local config, or receives only the specific `process.env` keys listed in its `env` array in children.json (env is isolated per child). Never put tokens in children.json — list the env key name only.

## Conventions
- JavaScript over TypeScript. Surgical edits only.
- After any change, append to repo-root `Logs/CHANGELOG.md` (newest on top) plus a dated entry under this folder's `Logs/`.

## Gotchas
- Never register a child also as a standalone `.mcp.json` entry — it causes duplicate processes. All MCPs go through LazyHub.
- `hub_rediscover` only affects the current VS Code session's LazyHub instance; each open VS Code window has its own hub process and needs its own rediscover.
- A child that hangs on connect/`listTools` cannot stall the whole hub: per-child discovery is bounded by `DISCOVERY_TIMEOUT_MS` (18s) with retry/backoff, and the hub connects its transport immediately, running discovery in the background and notifying via `sendToolListChanged()` when done.
- If the hub itself shows "Failed" (a dead process), `hub_rediscover` is unavailable; debug by running `node --use-system-ca server.js` standalone to see per-child tool counts, and a fix then needs a VS Code reload.
- slt-admin's `get_account_history_all` uses raw SQL string interpolation (not bound params): date args need literal embedded double-quotes and you must pass a WHERE-clause filter fragment or the stdio pipe times out. See `lazy-hub-mcp-Context.md` for the full detail.
