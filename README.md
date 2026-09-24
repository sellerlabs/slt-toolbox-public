# SLT Toolbox (Public)

Open-source [MCP](https://modelcontextprotocol.io) servers and Claude Code slash commands, published by [Seller Labs](https://sellerlabs.com).

Everything here is credential-free. You bring your own tokens, and nothing in this repo talks to Seller Labs infrastructure.

**Setting up from scratch? Start with [SETUP.md](SETUP.md)** for the ordered path from a bare machine to a working stack. The install order is not arbitrary, and two of the steps are deliberately out of the obvious sequence. This README is the catalog and assumes you already have an environment.

## What is in here

### MCP servers (`mcps/`)

| MCP | What it does | Auth |
|---|---|---|
| `google-workspace-mcp` | Multi-account Gmail, Calendar, Drive, Sheets, Docs and Slides. Register each account under a nickname and target it per call. | Your own Google Cloud OAuth desktop client |
| `slack-mcp` | Post and read messages, channels, reactions, file uploads. | Slack bot token |
| `jira-mcp` | Issues, boards, sprints, transitions, comments, attachments. | Atlassian API token |
| `notion-mcp` | Search, pages, blocks, database queries, with a property normalizer that flattens Notion's nested property shapes into plain values. | Notion internal integration token |
| `linear-mcp` | Issues, projects, teams, cycles, workflow states, labels and comments, read and write. Flattens Linear’s nested GraphQL shapes into plain values. | Linear personal API key |
| `openrouter-mcp` | One key to ~400 models: chat (with image input), multi-model panels, priced catalog search, benchmark rankings, credit usage, and image generation to disk. | OpenRouter API key |
| `stripe-mcp` | Read-only subscriptions and payouts, across up to three separate accounts. | Stripe restricted API key |
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

`google-workspace-mcp` uses an OAuth flow rather than a token. See its own [README](mcps/google-workspace-mcp/README.md).

### Running several through Lazy Hub

`lazy-hub-mcp` lets you register one MCP with your client and reach all the others through it, with hot reload when you change the roster.

```bash
cd mcps/lazy-hub-mcp
npm install
cp children.example.json children.json   # edit the cwd paths to match your checkout
claude mcp add lazy-hub -- node /absolute/path/to/mcps/lazy-hub-mcp/server.js
```

Most MCPs ship an `agent-guide.md` with setup details specific to them.

## Requirements

- Node.js 18 or newer
- Each MCP installs its own dependencies. There is no workspace-level install.

## A note on how this repo is produced

This is a publish-only mirror. The sources live in a private workspace and are mirrored out through a strict whitelist: a file ships only if a manifest glob names it explicitly, credential files are hard-blocked, and two gates run before every push. One checks that every import resolves to a file that was actually mirrored, so a server cannot ship without the module it loads. The other scans for credentials and for internal identifiers.

That means the code here is genuinely standalone, but it also means these servers are shaped by how they are used upstream. If something looks like it assumes a convention you do not share, open an issue. Fixes are applied upstream and flow back down through the mirror.

## License

MIT. See [LICENSE](LICENSE).
