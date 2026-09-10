# Linear MCP: agent guide

## Stack

Node 18+, ES modules, `@modelcontextprotocol/sdk` over stdio. Talks to the Linear GraphQL API at `https://api.linear.app/graphql`. No SDK dependency: queries are hand-written so the field set stays visible and the complexity cost stays predictable.

## Layout

| File | Role |
|---|---|
| `server.js` | Thin entry point. Loads `.env`, imports the real server. |
| `linear-mcp-server.js` | Tool definitions and reference resolvers. |
| `client.js` | GraphQL transport, auth, error shaping, shared field fragments. |
| `normalizer.js` | Pure shaping helpers. No network, no key. |
| `test-normalizer.mjs` | Unit tests for the shaping layer. |

`server.js` is a stub whose whole body is `await import('./linear-mcp-server.js')`. Anything that publishes this MCP must ship the real server AND `client.js` AND `normalizer.js`, or it dies with `ERR_MODULE_NOT_FOUND`.

## Run

```bash
npm install
npm test          # normalizer unit tests, no key needed
node server.js    # stdio server
```

LazyHub child key `linear`, tool prefix `mcp__lazy-hub__linear_*`. After any code change call `mcp__lazy-hub__hub_rediscover` to respawn the child. No editor restart.

## Auth and secrets

`LINEAR_API_KEY` in a gitignored `.env` in this folder. Create the key at Linear, Settings, Account, Security & Access, Personal API keys.

**A personal API key goes in the `Authorization` header RAW.** There is no `Bearer ` prefix. Only OAuth access tokens use Bearer, and sending a personal key with one returns a 400 that reads like a bad key. `client.js` checks for this and says so explicitly.

Optional `LINEAR_DEFAULT_TEAM` (a team key like `ENG`) supplies the team when a call omits one.

## Tools

Read: `linear_whoami`, `linear_list_teams`, `linear_search_issues`, `linear_get_issue`, `linear_list_projects`, `linear_get_project`, `linear_list_cycles`, `linear_list_states`, `linear_list_labels`, `linear_list_users`.

Write: `linear_create_issue`, `linear_update_issue`, `linear_create_comment`, `linear_create_project`.

## Conventions

- Responses are FLATTENED. Linear nests every relation one object deep and wraps every list in `{ nodes: [...] }`. `normalizer.js` reduces that to plain scalars, drops null relations, and never returns raw GraphQL shapes to a caller.
- Reference resolvers accept the human form (team key `ENG`, issue identifier `ENG-123`, an assignee name or `me`, a project name) and turn it into the uuid the API wants. On no match they list the valid options rather than returning a bare id error.
- Shaping logic goes in `normalizer.js` so it can be tested without a key. Anything requiring a network call belongs in the server or client.

## Gotchas

**`stateType`, not `state`, decides whether work is done.** State NAMES are per-team and freely renameable ("In Progress" vs "Doing" vs "Active"). `stateType` is the stable machine value: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`. Any logic asking "is this finished" must read `stateType`.

**Priority 1 is the MOST urgent.** Linear's scale is 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low, so it sorts backwards from intuition. Responses carry both `priority` and `priorityLabel` for that reason, and `parsePriority` accepts either the word or the number. Note 0 is a real value, not "unset", so never test it for truthiness.

**Completion is never a convenience flag.** There is no `linear_complete_issue`. Closing work goes through `linear_update_issue` with an explicit state, so it is always a stated intent. Closing work should be an explicit act, not a side effect.

**`labels` on update REPLACES the set.** It does not append. Read the issue first if you mean to add one.

**Free-text search is applied client-side** in `linear_search_issues`. Linear's `IssueFilter` has no combined title-plus-description contains, and `searchIssues()` does not accept the same structured filter set, so the query filter runs over the fetched page. A result shaped this way carries `filteredLocally: true`. It means a text query plus a small `limit` can miss matches that sit further down the result set: raise `limit` when a text search looks thin.

**Rate limits are 2,500 requests and 3,000,000 complexity points per hour**, per user, on a personal key. A 429 reports the reset time. Resolvers cache team ids for the process lifetime but re-fetch users and labels per call, so a loop that creates many issues with labels will spend requests faster than it looks.
