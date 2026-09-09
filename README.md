# SLT Toolbox (Public)

Open-source [MCP](https://modelcontextprotocol.io) servers and Claude Code slash commands, published by [Seller Labs](https://sellerlabs.com).

Everything here is credential-free. You bring your own tokens; nothing in this repo talks to Seller Labs infrastructure.

## What is in here

### MCP servers (`mcps/`)

| MCP | What it does | Auth |
|---|---|---|
| `google-workspace-mcp` | Multi-account Gmail, Calendar, Drive, Sheets, Docs and Slides. Register each account under a nickname and target it per call. | Your own Google Cloud OAuth desktop client |
| `slack-mcp` | Post and read messages, channels, reactions, file uploads. | Slack bot token |
| `github-mcp` | Repos, pull requests, issues, search, workflows. | GitHub personal access token |
| `jira-mcp` | Issues, boards, sprints, transitions, comments, attachments. | Atlassian API token |
| `notion-mcp` | Search, pages, blocks, database queries, with a property normalizer that flattens Notion's nested property shapes into plain values. | Notion internal integration token |
| `stripe-mcp` | Read-only subscriptions and payouts. | Stripe restricted API key |
| `playwright-mcp` | Browser automation, visible and headless, with Chrome-native downloads. | None |
| `lazy-hub-mcp` | An MCP loader and aggregator. Registers the others as children and hot-reloads them via `hub_rediscover`, with no editor restart. | None |

### Slash commands (`commands/claude-code-commands/`)

| Command | What it does |
|---|---|
| `/grill-me` | Interviews you one question at a time to extract what you know about a topic into a structured brainstorm file. |
| `/handoff-session` | Packages the current session into a handoff file a cold session can pick up from. |
| `/test-like-human` | Verifies a change by looking at the rendered output in its real destination via a visible browser, then posts the screenshot as proof. |
| `/orchestrate-via-fable` | Runs a large build as a multi-agent org chart: a boss writes the standard and spec, cheap workers implement, independent checkers verify. Needs `agents/boss.md`, `agents/checker.md`, `agents/implementer.md`. |
| `/critical-review` | Spawns an adversarial critic to attack a claim, diagnosis or plan before it gets acted on. Needs `agents/critic.md`. |

Copy the `.md` files into your `.claude/commands/`, and the `agents/` files into your `.claude/agents/`.

## Getting started

```bash
git clone https://github.com/sellerlabs/slt-toolbox-public.git
cd slt-toolbox-public/mcps/<the-mcp-you-want>
npm install
cp .env.example .env   # then fill in your own token
```

Register it with your MCP client. For Claude Code:

```bash
claude mcp add <name> -- node /absolute/path/to/mcps/<the-mcp-you-want>/server.js
```

### Running several through Lazy Hub

`lazy-hub-mcp` lets you register one MCP with your client and get all the others through it, with hot reload when you change the roster.

```bash
cd mcps/lazy-hub-mcp
npm install
cp children.example.json children.json   # edit the cwd paths to match your checkout
claude mcp add lazy-hub -- node /absolute/path/to/mcps/lazy-hub-mcp/server.js
```

Each MCP has its own `agent-guide.md` or `README.md` with setup details specific to it.

## Requirements

- Node.js 18 or newer
- For `playwright-mcp`: `npx playwright install` after `npm install`

## A note on how this repo is produced

This is a publish-only mirror. The sources live in a private workspace and are mirrored out through a whitelist that copies only explicitly named files, hard-blocks credential files, and runs a secret scan before every push. Issues and discussion are welcome; changes are applied upstream and flow back down through the mirror.

## License

MIT. See [LICENSE](LICENSE).
