# Setup: from a bare machine to a working MCP stack

This is the ordered path. The [README](README.md) is a catalog, it assumes you already have an environment. This file assumes you have nothing.

The order matters more than it looks. Two steps are out of alphabetical or obvious sequence on purpose, and both are explained where they appear: **install Lazy Hub before any other MCP**, and **install Playwright before any MCP whose setup lives in a browser**.

Written for someone comfortable with a terminal. Per-MCP detail lives in each MCP's own README; this file links rather than duplicates, so there is one place for each fact to drift.

## 1. Prerequisites

| What | Why |
|---|---|
| [Node.js](https://nodejs.org) 18 or newer | Every MCP here is a Node process. Nothing past this step works without it. |
| [git](https://git-scm.com) | To clone this repo. |
| An editor with an MCP client | [VS Code](https://code.visualstudio.com) plus the Claude Code extension is the combination these servers are developed against. Any MCP client over stdio works. |

Check Node before going further:

```bash
node --version   # must print v18.x or higher
```

If you are installing on a fresh machine, do these three first and in this order. Node is the one people miss, because the editor and the extension both install fine without it and the failure only shows up later, when an MCP silently will not start.

## 2. Claude Code extension

Install it from inside VS Code (Extensions, search "Claude Code"), sign in, then open a folder. MCP servers are registered per project or globally; the rest of this guide uses the CLI form, which works either way.

## 3. Clone this repo

```bash
git clone https://github.com/sellerlabs/slt-toolbox-public.git
cd slt-toolbox-public
```

Nothing is installed at the top level. Each MCP carries its own dependencies and is installed in its own folder.

## 4. Lazy Hub, first

Install this before any leaf MCP. It is the step that changes the cost of every step after it.

Lazy Hub is an MCP that loads other MCPs. You register **one** server with your client, and reach all the others through it. Adding an MCP later becomes a line in a JSON file plus a `hub_rediscover` call, instead of a new client registration and an editor restart.

The saving compounds. At MCP number one it is roughly break-even. At MCP number six it is the difference between a config edit and six restarts.

```bash
cd mcps/lazy-hub-mcp
npm install
cp children.example.json children.json
```

Open `children.json` and fix the `cwd` paths to match your checkout. They are relative to the `lazy-hub-mcp` folder, so the shipped defaults (`../google-workspace-mcp`) are already correct if you kept the repo layout.

Remove any children you do not intend to use. A child whose folder has no `npm install` yet will fail discovery, which is noisy but not fatal.

Register the hub:

```bash
claude mcp add lazy-hub -- node /absolute/path/to/mcps/lazy-hub-mcp/server.js
```

From here on, every MCP you add is:

1. `npm install` in its folder,
2. a line in `children.json`,
3. `hub_rediscover`.

No restart.

## 5. Playwright, second

Out of order on purpose. Playwright is not just another connector, it is the one that installs the others.

Several MCPs here authenticate against a console UI rather than a token you can paste. The Google Workspace MCP is the clearest case: it needs a cloud project, four APIs enabled, a consent screen configured, and an OAuth client downloaded. That is a long click-path, and it is exactly the kind of work an agent with a browser can drive for you.

So the general rule, which outlives this specific repo:

> Install the MCP that can operate a browser **before** the MCPs whose setup lives in a browser.

```bash
cd ../playwright-mcp
npm install
```

Add it to `children.json`. It ships two entries, visible and headless, and both need `noIdleTimeout`:

```json
"playwright-visible":  { "command": "node", "args": ["--use-system-ca", "playwright-mcp-visible.js"],  "cwd": "../playwright-mcp", "env": [], "noIdleTimeout": true },
"playwright-headless": { "command": "node", "args": ["--use-system-ca", "playwright-mcp-headless.js"], "cwd": "../playwright-mcp", "env": [], "noIdleTimeout": true }
```

`noIdleTimeout` is not optional and not cosmetic. The hub reaps idle children after 30 minutes; without this flag the reaper closes the browser tab you are working in, mid-session.

Use the **visible** one for setup work. You want to watch the console navigation and take over when a login or a consent dialog needs a human.

Then call `hub_rediscover`.

See the [Playwright MCP README](mcps/playwright-mcp/README.md) for session and profile behavior.

## 6. Google Workspace, driven by Playwright

This is where the ordering pays off.

```bash
cd ../google-workspace-mcp
npm install
```

The setup has two halves. The first is console work, the second is a local OAuth handshake.

**The console half** needs a Google Cloud project with the Gmail, Calendar, Drive and Sheets APIs enabled, an OAuth consent screen with your own account added as a test user, and a **Desktop app** OAuth client whose JSON you save as `credentials.json` in the MCP folder. The exact click-path is in the [Google Workspace MCP README](mcps/google-workspace-mcp/README.md), which is the one place it is maintained.

This is the half to hand to Playwright. Open a visible browser, sign in to the Google Cloud Console yourself, then give the agent the goal and let it navigate. Take the keyboard back for the sign-in and for any consent dialog. Console UIs change often enough that a rigid step list goes stale, while an agent reading the live page does not.

**The local half** is a single command per account:

```bash
node setup.js add work
```

It opens a browser, runs the consent flow against a callback server on `localhost:3000`, and writes a token to `tokens/work.json`. Repeat for each account under whatever nickname you like, then `node setup.js list` to confirm. Tokens and `credentials.json` are gitignored and must stay that way.

Add the child to `children.json`, call `hub_rediscover`, done.

## 7. Everything else

The remaining MCPs are flat: get a token, put it in `.env`, register the child. No console choreography.

```bash
cd ../<the-mcp-you-want>
npm install
cp .env.example .env     # then fill in your token
```

| MCP | Token you need |
|---|---|
| [slack-mcp](mcps/slack-mcp/) | Slack bot token. The bot must be invited to a channel before it can post there. |
| [jira-mcp](mcps/jira-mcp/) | Atlassian API token. |
| [notion-mcp](mcps/notion-mcp/) | Notion internal integration token. Share each page or database with the integration, or it sees nothing. |
| [linear-mcp](mcps/linear-mcp/) | Linear personal API key. |
| [stripe-mcp](mcps/stripe-mcp/) | Stripe restricted key, read-only is enough. |

Each one: add to `children.json`, call `hub_rediscover`, no restart.

## Recap

```
Node.js + git + editor        prerequisites, Node is the one people miss
  └─ Claude Code extension
      └─ Lazy Hub             first, so everything after it is cheap
          └─ Playwright       second, because it installs the rest
              └─ Google Workspace   the console work, driven
                  └─ Slack, Jira, Notion, Linear, Stripe   flat
```

## When something does not start

- **A child fails discovery.** Almost always a missing `npm install` in that child's folder, or a `cwd` in `children.json` that does not resolve. The paths are relative to `lazy-hub-mcp`.
- **Nothing works and Node is new.** Confirm `node --version` is 18 or higher in the *same shell* your editor launched from. A fresh install often is not on the PATH of an already-open editor. Restart it.
- **A browser tab closes itself mid-session.** The `noIdleTimeout` flag is missing from the Playwright child.
- **Google tools return auth errors after working fine.** Re-run `node setup.js add <nickname>` for that account. A revoked or expired refresh token has to be reissued, not repaired.
