# Stripe MCP — Agent Guide

## Stack
- Node.js, ESM (`"type": "module"`).
- `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), official `stripe` client, `zod` for tool params.
- No dotenv — `.env` is parsed manually in `server.js` (`loadEnv`).

## Layout
```
stripe-mcp/
├── server.js               ← LazyHub-child entry; two read-only tools
├── .env                    ← STRIPE_API_KEY= (gitignored, restricted read-only key)
├── .env.example            ← variable name only
├── .gitignore              ← node_modules, .env, config.json
├── package.json
├── stripe-mcp-Context.md   ← capabilities, field mappings, gotchas
├── agent-guide.md          ← this file
├── Docs/
└── Logs/
```

## Run
- Install: `npm install` (from `stripe-mcp/`).
- Manual smoke test: `node server.js` (serves over stdio; Ctrl-C to stop). Errors print to stderr.
- In use it is spawned by LazyHub, not run standalone.

## LazyHub wiring
- Child key: `stripe`. Tool prefix: `mcp__lazy-hub__stripe_*`.
- Registered in `lazy-hub-mcp/children.json` (`command: node`, `args: ["--use-system-ca","server.js"]`, `cwd: ../stripe-mcp`, `env: []` — the child loads its own key from `.env`).
- After any code change or re-key: `mcp__lazy-hub__hub_rediscover` then `ToolSearch` in the SAME conversation. NEVER a VS Code reload, NEVER a standalone `.mcp.json` entry.

## Conventions / gotchas
- READ-ONLY. Do not add write/charge/refund/payout-create tools (money-movement → CLAUDE.md approval rule).
- Amounts are converted cents→dollars in-tool; dates are UTC-formatted in-tool. Keep that contract — the sheets depend on it.
- Both tools auto-paginate; `limit` caps rows. 10k-row hard safety cap (`MAX_PAGES`).
- Pin the Stripe `apiVersion` when upgrading the client so row shapes stay stable.
