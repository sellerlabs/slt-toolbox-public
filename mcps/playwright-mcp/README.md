# Playwright MCP — Persistent Visible Browser

A Playwright-based MCP (Model Context Protocol) server built around a **persistent, visible, real-Chrome session** that is shared across every MCP client window and **survives the client/session closing**.

This wraps [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) with a small server layer that solves the problems the stock browser tools have for real-world web automation:

- **Real system Chrome, not bundled Chromium** — so installed browser **extensions work** (password managers and the rest), and sites that block automated browsers see a normal Chrome.
- **One shared, persistent browser** — multiple agent sessions/windows all drive the **same** Chrome instance and profile via a local server on port `3456`. Log in once; every session is logged in.
- **Survives session close** — when an MCP client window closes, only *that session's tabs* close. Chrome (and your logins) stay alive for the next session. On Windows this required escaping the client's process job object (see below).
- **Robust downloads** — routes Chrome's native downloads to your system Downloads folder and repairs extensionless files by magic-byte-sniffing and adding the correct extension.
- **Snapshot pruning** — large accessibility snapshots are shrunk before they reach the model's context window. Deterministic: no API key, no network call (see below).

## Two modes

| Mode | Entry file | When to use |
|---|---|---|
| **Visible** (system Chrome, persistent, shared) | `playwright-mcp-visible.js` | Default. Anything involving logins, extensions, or multi-session work. |
| **Headless** (bundled Chromium, ephemeral) | `playwright-mcp-headless.js` | One-off scripted automation with no persistent profile. |

## Prerequisites

- Node.js 18+
- Google Chrome installed (for visible mode)
- `@playwright/mcp`

## Setup

### 1. Install

```bash
npm install
npx playwright install
```

A global install (`npm install -g @playwright/mcp`) also works: every entry point resolves the package from a local `node_modules`, the standard global locations, or `npm root -g`, in that order.

### 2. Register with your MCP client

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "playwright-visible": {
      "command": "node",
      "args": ["--use-system-ca", "playwright-mcp-visible.js"],
      "cwd": "/absolute/path/to/playwright-mcp"
    }
  }
}
```

**OpenClaw** (`openclaw.json`) uses the identical stdio format.

On the first tool call, the shared browser server auto-launches on port `3456` and a visible Chrome window opens. Subsequent sessions attach to the same server.

Tools are exposed with a `browser_*` prefix: `browser_navigate`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, `browser_tabs`, `browser_network_requests`, `browser_wait_for`, and more.

## How persistence works

Two layers keep Chrome alive across session close:

1. **Session proxy** (`playwright-mcp-server.js`) — each session's `close()` closes only its own pages. `close` / `closeBrowserContext` on the shared context are blocked no-ops.
2. **Process escape on Windows** (`playwright-mcp-visible.js`) — some MCP clients wrap their process tree in a Job Object and tree-kill it on session close, and a plain `spawn(detached:true)` does **not** escape that. The visible launcher registers the shared server as a Scheduled Task instead, so it runs in the interactive desktop session (Chrome is actually visible) while being parented outside the client's job. On macOS and Linux a normal detached spawn is sufficient.

**Verify (Windows):** after a change, the process on port `3456` should have a parent outside your editor's tree, and force-killing the client should leave both the server and Chrome running. If Chrome shows "Restore pages? Chrome didn't shut down correctly", something force-killed it — re-check the spawn path.

## Snapshot pruning

A real page's accessibility snapshot is large: a shopping search result can exceed 400KB, which is a substantial share of a model's context window. Any tool result over 10KB is pruned first.

The pruning is **purely deterministic** — no model call, no API key, no network round trip:

- per-element `[ref=...]` and `[cursor=pointer]` annotations are stripped
- nodes with no label, text or state are dropped
- wrapper chains that contribute only indentation are collapsed
- URLs are trimmed to scheme, host and path, dropping query strings

Measured on live pages: a shopping search fell 66%, a code-host org page 40%, an encyclopedia article 24%, with every button, link, textbox and checkbox preserved exactly. Commerce pages gain most because opaque ad-tracking URLs (often several hundred characters each) dominate their markup.

Set `COMPRESS_SNAPSHOTS=0` to disable pruning and pass snapshots through untouched.

## Files

| File | Purpose |
|---|---|
| `playwright-mcp-visible.js` | Visible-mode bridge — ensures the shared server, proxies MCP over its SSE endpoint, prunes snapshots |
| `playwright-mcp-headless.js` | Headless-mode entry (bundled Chromium) |
| `playwright-mcp-server.js` | The shared server — session proxy, download routing/repair, persistence |
| `playwright-mcp-launcher.js` | Thin launcher that resolves and runs `@playwright/mcp` directly |
| `mask-credentials.js` | Masks credential-shaped values in tool results before they reach the model |

## Notes

- **Temporary files** (screenshots, downloads, page snapshots) go in `temp/`, which is gitignored — never committed. Browser profiles under `.playwright-profiles/` hold live session cookies and are gitignored for the same reason.
- Do **not** set `acceptDownloads:true` or add a `context.on('download')` listener — Chrome owns downloads here, and either one makes Playwright and Chrome fight over the same artifact (ENOENT crash).
