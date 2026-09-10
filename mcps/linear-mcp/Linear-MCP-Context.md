# Linear MCP: context

**Copy this folder's path, hand it to Claude, and this file explains what this MCP is and how to work on it.**

## What it is

An MCP server over the [Linear](https://linear.app) GraphQL API, giving Claude read and write access to issues, projects, teams, cycles, states, labels and comments. Built 2026-09-10.

- **LazyHub child key**: `linear`. Tool prefix `mcp__lazy-hub__linear_*`.
- **Auth**: `LINEAR_API_KEY` in a gitignored `.env` in this folder.
- **Endpoint**: `https://api.linear.app/graphql`.
- **Working notes**: [agent-guide.md](agent-guide.md) has the layout, run commands and the full gotcha list. Read it before changing anything.

## Why it returns flattened shapes

Linear nests every relation one object deep (`state: { name, type }`, `assignee: { name }`, `team: { key }`) and wraps every list in `{ nodes: [...] }`. Passing that through spends the model's attention on structure rather than content. `normalizer.js` flattens it to plain scalars and drops null relations. That file is pure and has no network or key dependency, which is why the tests run with `npm test` and nothing else.

## The three things that bite

1. **Personal API keys are sent RAW in the Authorization header, with no `Bearer ` prefix.** Only OAuth tokens use Bearer. `client.js` detects the mistake and says so, because Linear's own response for it reads like a revoked key.
2. **`stateType` is the only rename-proof signal for "is this done".** State names are per-team and editable; the type (`triage`/`backlog`/`unstarted`/`started`/`completed`/`canceled`/`duplicate`) is not.
3. **Priority sorts backwards.** 1 is Urgent, 4 is Low, 0 is None. And 0 is a real value, so never test priority for truthiness.

## Completion gate

There is deliberately no `linear_complete_issue` tool. Moving an issue to a done state goes through `linear_update_issue` with an explicit `state`, so closing work is always a stated intent rather than a side effect of some other call. The intent is that an agent can file, update and discuss work freely, but closing something is never an incidental side effect of another call.

## Registering it

Point your MCP client at `server.js`, or register it as a lazy-hub child with the key `linear` and `cwd` set to this folder.
