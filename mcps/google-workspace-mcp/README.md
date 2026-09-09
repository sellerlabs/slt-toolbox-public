# Google Workspace MCP

A local MCP (Model Context Protocol) server that gives an LLM agent (Claude Code, OpenClaw, or any MCP client) full read/write access to **Gmail, Google Calendar, Google Drive, and Google Sheets** across one or more Google accounts.

Multi-account by design: each account is registered under a short nickname (e.g. `work`, `personal`) and every tool call targets an account by that nickname.

## Capabilities

| Surface | Tools |
|---|---|
| **Gmail** | search, list, read; create draft, send draft, send message, delete draft/message; modify labels + read state; create/rename label; get attachment |
| **Calendar** | list events; create / update / delete event; find free time; suggest time; list calendars |
| **Drive** | list, search, read file (binary files download to disk; Docs/Sheets/Slides export as text/CSV); upload file |
| **Sheets** | create native sheet; convert a Drive file/CSV into a native sheet; get info; read / write / append / clear / batch-write ranges |

## Prerequisites

- Node.js 18+
- A Google Cloud project with OAuth credentials (see below) — **you bring your own**; no credentials ship in this repo.

## Setup

### 1. Install

```bash
npm install
```

### 2. Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create (or pick) a project.
2. **APIs & Services → Enable APIs**: enable Gmail API, Google Calendar API, Google Drive API, Google Sheets API.
3. **APIs & Services → OAuth consent screen**: configure it (External is fine for personal use), and add your Google account(s) as **Test users**.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app**.
5. Download the client JSON, rename it to `credentials.json`, and place it in this folder.
   - See [`credentials.example.json`](credentials.example.json) for the expected shape. `credentials.json` is gitignored and must never be committed.

### 3. Authorize an account

```bash
node setup.js add work
```

This opens a browser for the Google OAuth consent flow. On success, a token is written to `tokens/work.json` (gitignored). Repeat with any nickname for each account you want to connect:

```bash
node setup.js add personal
```

List connected accounts:

```bash
node setup.js list
```

### 4. Register with your MCP client

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["--use-system-ca", "server.js"],
      "cwd": "/absolute/path/to/mcp-google-workspace"
    }
  }
}
```

**OpenClaw** (`openclaw.json`) uses the identical stdio format.

Tools then appear as `google_workspace_gmail_*`, `google_workspace_calendar_*`, `google_workspace_drive_*`, `google_workspace_sheets_*` (exact prefix depends on how your client namespaces the server).

## Security notes

- `credentials.json`, `tokens/`, and `auth.json` are gitignored. **Never commit them** — they grant full access to your mailbox and drive.
- Tokens auto-refresh; the refreshed token is written back to `tokens/{nickname}.json`.
- OAuth scopes requested: `gmail.modify`, `calendar`, `drive`, `userinfo.email`.

## Files

| File | Purpose |
|---|---|
| `server.js` | MCP server entry point — registers all tools |
| `auth.js` | OAuth2 token manager (load, refresh, save, list accounts) |
| `gmail.js` / `calendar.js` / `drive.js` / `sheets.js` | Per-surface API logic |
| `setup.js` | Interactive CLI to add/list accounts |
| `get-url.mjs` | Helper to print an auth URL for headless/manual OAuth |

---

Part of the [slt-toolbox-public](https://github.com/sellerlabs/slt-toolbox-public) MCP collection.
