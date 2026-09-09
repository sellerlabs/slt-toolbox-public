Run a large build as a multi-agent org chart: a Fable boss writes the quality standard and spec, cheap worker models do all implementation, and independent checkers verify every task against the standard. Use for large multi-file builds, migrations, content-heavy site work, or any job big enough that orchestration overhead pays for itself. The run always finishes on its own and ends with a full report.

The build request is: $ARGUMENTS

Optional flags inside the arguments: `--retries N` sets the per-task checker-fail retry cap (default 3). `--agents N` sets the per-run agent ceiling (default 50).

## Core principles (from the org-chart pattern)

1. **Constitution first.** Define "what done right means" ONCE at the top. Checkers test against it every round. The prompt is a standard plus a way to check it, not task-by-task instructions.
2. **The boss never implements.** Fable produces constitutions, specs, rulings, and reviews. All code, copy, and content is written by cheaper workers.
3. **Independent verification.** Every task is verified by a checker that executes the work fresh and never reads the worker's self-report. "Done" is the checker's call, not the worker's.
4. **Rank-blind.** The boss's own artifacts (spec, design decisions, any direct output) go through the same checker pass. No rank is immune from verification.
5. **Fail-forward.** Hitting a cap never halts the run. Failed tasks are set aside; everything else finishes; unresolved items are batched into the final report.

## Step 1: Gate (do this first, state the result before proceeding)

Do NOT orchestrate if the job is small: fewer than ~3 files or under ~30 minutes of normal work, a single-file edit, or anything where agent spin-up and verification overhead exceeds the savings. In that case say "This is below the orchestration threshold, doing it directly" and just do the task normally. Otherwise state the job qualifies and continue.

## Step 2: Boss routing (model-agnostic)

Check which model this session is running on (the system prompt states it).

- **Session is Fable**: play the boss directly in the main loop. Do not spawn a boss agent.
- **Session is any other model (Opus, Sonnet, etc.)**: you are the CONDUCTOR. Spawn the `boss` agent (subagent_type: `boss`; its definition already pins the model to claude-fable-5-1, do not pass a model override) for exactly four things: the constitution (Step 3), the spec and decomposition (Step 4), mid-build dispute rulings, and the final review (Step 6). Send the boss distilled briefs only, never raw worker transcripts or full file dumps. Everything else (gathering sources, launching the Workflow, relaying results, reporting) stays on the session model.

For very large autonomous builds there is an optional alternative: start a dedicated Fable session first (`/model fable`, or a headless run with `--model claude-fable-5-1`) so the main loop is the boss. Never required.

## Step 3: Constitution (before any decomposition)

The boss writes the constitution: the written standard every build round is checked against. The conductor gathers source material in this order and hands it to the boss:

1. **Existing written standards**: brand/style guides, the project's context docs, project-instruction rules (especially any data-integrity rules for anything touching real customer or business data), and any relevant repo rules file.
2. **Prior grill files**: check `<project>/brainstorms/grill-*.md` for captured tacit knowledge and distill it in.
3. **Tacit and unwritten**: if the quality bar for this job lives only in the user's head, offer to run `/grill-me <topic>` first and then distill the resulting file into the constitution. A wrong constitution gets enforced perfectly across every task, so 15 minutes of grilling beats a build against the wrong standard.

The constitution MUST contain:
- The quality bar and hard constraints, each phrased so a checker can machine-verify it (a standard nobody can check is a wish, not a standard).
- A **protected content list**: passages, data values, and copy that are verbatim-immutable. Workers may only write connective tissue around them. Checkers diff them character-for-character (curly quotes included) every round.
- For any work touching real customer or business data: metrics and quotes are ALWAYS protected content; numbers come only from retrieved data, never estimated.

If a genuine constitution-level ambiguity exists that only the user can resolve, ask ONE AskUserQuestion now. This is the only permitted human block in the entire run; after fan-out nothing waits on a human.

## Step 4: Spec and decomposition

The boss writes the spec and the task list (each task: goal, inputs, deliverable, which constitution items apply, suggested model tier). One decomposition per run; no mid-build re-planning. Anything the boss authored directly that ships (design rules, CSS decisions, copy structure) becomes a task-level artifact that gets checked like worker output.

**Model routing table** (per task, set via the `model` option; it overrides agent-definition defaults):

| Tier | Use for | Settings |
|------|---------|----------|
| `haiku` | Mechanical work: renames, boilerplate, file moves, format conversions | `effort: low` |
| `sonnet` | Default implementer AND default checker | (default) |
| `opus` | Gnarly debugging, architecture-sensitive tasks | |
| `fable` | Boss only: constitution, spec, rulings, final review | never implements |

## Step 5: Execution via the Workflow tool

Launch a single Workflow (this skill invocation is the explicit opt-in for the Workflow tool). The script encodes the loop guards as plain-code counters (`attempts`, `disputes`, `agentCount`), never as prompt instructions, so no agent can talk its way past a cap. Per task, as a pipeline (no barriers between independent tasks):

1. **Implement**: `agent(taskBrief + constitution, {agentType: 'implementer', model: <routed tier>, schema: RESULT_SCHEMA})`. Schema returns compact JSON (files touched, deliverable summary, optional `dispute`), never prose transcripts.
2. **Check**: `agent(checkBrief + constitution, {agentType: 'checker', schema: VERDICT_SCHEMA})`. The check brief contains the task goal, deliverable location, and constitution, NOT the worker's self-report. Checker executes fresh: build it, load it, diff protected content character-for-character, refetch cited URLs. Verdict schema: `verdict` (pass/fail), `specific_failures[]` (precise and actionable, never "try again"), `constitution_items_checked[]`, `evidence`.
3. **Retry loop**: on fail, re-run the implementer with the `specific_failures[]` text verbatim. Max retries = `--retries` (default 3).
4. **Escalate**: after max retries, or on a worker dispute, call `agent(distilledDispute, {agentType: 'boss'})` with both sides' evidence. Ruling is terminal: overrule the checker (pass), amend the spec (exactly ONE post-ruling attempt), or mark the task FAILED. One dispute per task per side; a second dispute on the same task = automatic FAILED. Post-ruling failures never re-enter the loop.
5. **Fail-forward**: FAILED tasks are recorded and set aside; all other tasks continue to completion. If `agentCount` hits the `--agents` ceiling (default 50), log it, stop launching new tasks, and deliver a partial-results report. (Harness backstops exist beneath these caps: 1000-agent workflow limit, token budget guards.)

## Step 6: Final review and verification

1. The boss reviews the assembled deliverable (distilled summary + checker verdicts) and can flag anything for one final fix round through the same implement-check loop (this round counts against the agent ceiling).
2. If the deliverable has a rendered surface (web page, UI, Slack output, PDF), finish with the `/test-like-human` pattern: visible Playwright on the real rendered output, both themes where relevant.

## Step 7: Report

End with a closing summary: tasks run, pass/rework/failed counts, what the checkers caught (be specific, this is the value of the system), escalations and rulings, unresolved items needing the user's call, and a token/model breakdown (which tiers did the work).

## Rules

- The boss NEVER writes production code, copy, or content. If you catch the boss doing implementation, that is a bug in the run.
- Checkers NEVER see worker self-reports. Verification is against the constitution, not against what the worker claims.
- Protected content is verbatim-immutable, diffed character-for-character every round.
- Every loop terminates in a human-facing report, never "retry forever." Caps live in workflow script code, not prompts.
- No mid-build questions to the user. One optional AskUserQuestion before fan-out; after that the run finishes on its own.
- All agents return structured JSON via `schema`. Keep the main loop lean: distilled briefs in, compact artifacts out.
- No em dashes in any generated content (workers inherit this rule via the constitution).
- Change-log rule applies: after a run that changed code or config, append to your repo's changelog.

## Requires

This command spawns three agent types that must exist in your `.claude/agents/` folder (shipped alongside this command under `agents/`): `boss`, `checker`, `implementer`. Copy them into `.claude/agents/` so `subagent_type` resolves.
