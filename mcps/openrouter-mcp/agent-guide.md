# OpenRouter MCP, agent guide

## Stack
Node ESM, `@modelcontextprotocol/sdk` over stdio, `zod` for input schemas, `dotenv` for the key. No HTTP client, native `fetch`.

## Layout
- `server.js` — thin entry, imports the real server.
- `openrouter-mcp-server.js` — everything: config, `getApiKey()`, the `orFetch()` wrapper, four `registerTool` calls, stdio connect.
- `README.md` — tools, parameters, setup and gotchas. Read it first.

## Local dev run
```
npm install
npm start
```
Speaks stdio, so it needs an MCP client on the other end. For a quick check, drive it with an `StdioClientTransport` from the same SDK.

## LazyHub child
Registered as `openrouter` in `lazy-hub-mcp/children.json`. Tools surface as `mcp__lazy-hub__openrouter_*`. After editing `children.json`, call `hub_rediscover` in the same conversation.

## Auth and secrets
`OPENROUTER_API_KEY` in a gitignored `.env` next to the server. Read lazily at call time so the server still boots keyless for discovery. Never echo the key, never put it in `.mcp.json`.

## Conventions
- No em dashes in tool output or docs.
- Tool responses are plain text with a `[model: ... | tokens: ... | cost: ...]` footer, not JSON.
- Handlers throw plain `Error`; the SDK converts. No try/catch in handlers, no `isError` flag.
- Errors always include the OpenRouter response body.
