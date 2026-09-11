# Lazy Hub MCP

A single MCP (Model Context Protocol) server that **aggregates many child MCP servers behind one endpoint** and **lazy-spawns each child on demand**.

Instead of registering ten MCP servers in your client (and paying the startup cost of all of them), you register **one** — `lazy-hub` — and every child's tools appear under a `{childKey}_*` namespace. Children are spawned on their first tool call and killed after a period of idle time, so nothing you don't use is running.

## Why

- **One registration, many servers.** Your MCP client sees a single server; the hub fans out.
- **Lazy startup.** A child process only starts when one of its tools is first called.
- **Idle reaping.** Children are shut down after ~30 min idle to free resources.
- **Hot reload.** The child list lives in `children.json`, which the hub re-reads on `hub_rediscover` — add or change a child without restarting your client.
- **Startup resilience.** Discovery is time-bounded per child and overall, so one slow or hung child can't stop the hub from answering your client's handshake.

## Prerequisites

- Node.js 18+
- One or more child MCP servers to aggregate. Every other MCP in this repo is a ready-to-wire child.

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure children — `children.json`

Copy `children.example.json` to `children.json` and edit it. Each entry describes how to spawn a child MCP server:

```json
{
  "children": {
    "google-workspace":   { "command": "node", "args": ["--use-system-ca", "server.js"], "cwd": "../google-workspace-mcp", "env": [] },
    "playwright-visible": { "command": "node", "args": ["--use-system-ca", "playwright-mcp-visible.js"], "cwd": "../playwright-mcp", "env": [] }
  }
}
```

Per-child fields:

| Field | Meaning |
|---|---|
| `command` | Executable (usually `node`) |
| `args` | Arguments passed to it |
| `cwd` | Working dir for the child, **relative to this folder** (adjust to where you cloned each child) |
| `env` | Array of `process.env` keys to forward to that child (most children load their own credentials from local config, so this is usually `[]`) |
| `callTimeout` | Optional per-call timeout override in ms |
| `envVars` | Optional literal key/value pairs set on the child (unlike `env`, which only forwards keys already present) |

**The hub does not pass your whole environment through.** Each child gets a fixed set of system variables plus exactly the keys it declares in `env`. If a child needs a secret, add its key to that child's `env` array **and** make sure the key is set in the environment the hub itself runs under (via your MCP client's `env` block). A child whose `env` is `[]` cannot see any of your secrets, which is the point.

### 3. Register the hub with your MCP client

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "lazy-hub": {
      "command": "node",
      "args": ["server.js"],
      "cwd": "/absolute/path/to/lazy-hub-mcp",
      "env": {}
    }
  }
}
```

**OpenClaw** (`openclaw.json`) uses the identical stdio format.

All child tools then appear as `mcp__lazy-hub__{childKey}_{toolName}` (exact prefix depends on your client). For example the Google Workspace child's `gmail_search` becomes `mcp__lazy-hub__google_workspace_gmail_search`.

## Adding a child later

1. Add an entry to the `children` block in `children.json`.
2. Call the `hub_rediscover` tool (no `server_key`, or the new key) — the hub re-reads `children.json`, spawns the child, and registers its tools.
3. Start a new conversation to *use* the new tools (MCP tools are snapshotted at conversation start).

No client reload is needed for the hub to pick up the change — only a new conversation to surface the new tools.

## Special tool: `hub_rediscover`

Re-reads `children.json`, re-spawns children, and re-registers their tools without restarting your client. Note it only affects the current client instance — each open client window runs its own hub process.

## Startup robustness

- **Per-child discovery timeout** (~15s) — a hung child is abandoned and its process killed, no leaks.
- **Overall startup cap** (~8s) — the hub connects to your client even if discovery is still running, then fires a `tools/list_changed` when it finishes.
- **Debugging a failed hub:** run `node server.js` standalone — it logs each child's tool count and any discovery failures. A child that times out is the culprit; remove or fix it in `children.json`.

## Files

| File | Purpose |
|---|---|
| `server.js` | The hub — spawns/reaps children, aggregates and namespaces their tools |
| `children.example.json` | Template child registry; copy to `children.json` and edit |
