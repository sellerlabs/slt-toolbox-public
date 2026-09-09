# jira-mcp — Agent Guide

AI coding-assistant instructions for working on this MCP server. Read `jira-mcp-Context.md` first for capabilities and gotchas.

## Stack
- Node.js, ESM (`"type": "module"` in package.json).
- MCP SDK `@modelcontextprotocol/sdk` (^1.29.0) over stdio transport (`StdioServerTransport`).
- Validation via `zod` (3.24.4). No other runtime deps.
- Calls the Jira Cloud REST API at `JIRA_URL/rest/api/3` and the agile API at `JIRA_URL/rest/agile/1.0`. Uses the global `fetch`; HTTP Basic auth.

## Layout
- `server.js` — thin entry point. As of 2026-06-27 it just dynamically imports `jira-mcp-server.js` (no Doppler). Registered as the LazyHub child command.
- `jira-mcp-server.js` — the actual MCP server: loads `.env`, builds auth headers, and registers all Jira tools (issues, comments, projects, agile, links, attachments, transitions, move, users).
- `mcp-jira-attach.js` — standalone helper for `jira_add_attachment` (now folded into the main server; reads creds from env vars).
- `mcp-jira-move.js` — standalone helper for `jira_move_issue` (now folded into the main server; reads creds from env vars).
- `.env` — gitignored credentials (`JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`).
- `.env.example` — template for the three JIRA_* keys.

## Local dev / run
- Install: `npm install` (from this folder).
- Run: `node server.js` (no npm scripts defined; `main` is `server.js`). Normally launched by LazyHub, not manually.

## LazyHub child
- Yes. It runs as a LazyHub child. In `lazy-hub-mcp/children.json` the child key is `atlassian` with `cwd: "../jira-mcp"`, `command: node`, `args: ["--use-system-ca", "server.js"]`, `env: []`.
- Tool prefix: `mcp__lazy-hub__atlassian_jira_*`.
- After changing server code, call `mcp__lazy-hub__hub_rediscover` (with the `atlassian` child). No VS Code reload needed.

## Auth / secrets
- Credentials live in the gitignored `.env` in this folder: `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN` (HTTP Basic, username + API token).
- To rotate the API token: edit `.env`, then `mcp__lazy-hub__hub_rediscover` the `atlassian` child.
- Never commit secrets. Never put tokens in `.mcp.json`. Keep `.env.example` in sync (placeholders only).

## Conventions
- JavaScript over TypeScript (workspace default).
- Surgical edits only — change only what the task requires.
- After any code or config change: append a newest-at-top entry to repo-root `Logs/CHANGELOG.md`, and add a dated `YYYY-MM-DD.md` entry under this folder's `Logs/`.

## Gotchas
- Context.md still describes the older Doppler-based secrets flow; the current `server.js` (2026-06-27) reads a plain gitignored `.env` instead. Trust the code: secrets are in `.env`, not Doppler.
- Read `memory/feedback-task-tools.md` before any Jira action.
- Use JQL for complex searches (`jira_search`).
- Transitions require fetching available transitions first (`jira_get_transitions`) before calling `jira_transition_issue`.
- `jira_move_issue` uses `POST /rest/api/3/bulk/issues/move` (not a PUT field update, which silently fails). It accepts an optional `epic_key` to link in the same call. `customfield_10014` is blocked on this instance's screens, so epic linking uses `parent.key` internally.
- `jira_link_to_epic` also uses `parent.key` internally for the same reason.
- @mentions in `jira_add_comment` / `jira_edit_comment` use real ADF mention nodes; pass `mention_account_ids` or embed `[~accountid:ID]`. Find an accountId via `jira_search_users`.
