Spawn Fable as an adversarial critic to attack a claim, diagnosis, or plan before it gets acted on or published. Reviews REASONING, not code.

Requires the `critic` agent from `agents/critic.md` copied into your `.claude/agents/`.

The thing to review is: $ARGUMENTS

This can be a claim ("the invalid_scope bug is fixed"), a diagnosis, an analysis, a plan, or a draft about to be posted or sent. If no argument is given, default to reviewing the main conclusion of the current session, and say which conclusion you picked before proceeding.

**Goal:** catch claims that outrun their evidence before they reach a live ticket, an engineer, a customer, or production. This is not `/review` or `/security-review`; those cover code. This covers reasoning.

## When to run this (gate)

A critic run costs roughly 50k to 60k subagent tokens. Run it when the conclusion is about to be acted on and being wrong is expensive:
- Posting a diagnosis or root cause to a live ticket, or sending it to an engineer or customer.
- A recommendation that would send someone into a specific codebase, system, or vendor.
- A financial, infrastructure, or data-integrity call.
- Any confident conclusion built on tests that partly failed, partly ran, or produced ambiguous output.

Skip it for low-stakes claims, quick lookups, or anything easily reversible. If the user invokes it on something clearly trivial, say so and ask whether to run anyway rather than burning the tokens silently.

## Before spawning: assemble the brief

The prototype run worked because of what went INTO it. Do this assembly yourself, do not delegate it:

1. **Enumerate the claims.** Break the conclusion into discrete, individually checkable claims and label them A, B, C. Include the headline claim even when it feels obviously true; that is usually the one that breaks.
2. **Attach the raw evidence, not your summary of it.** Actual network traces, status codes, log lines, query output, URLs, file paths with line numbers, test output including the parts that failed or were skipped. If a code path was inspected but never executed, say so explicitly in the brief.
3. **Include your own self-identified holes.** Everything you already doubt about the conclusion. The critic is instructed to find holes in the self-critique itself, so withholding them wastes the run.
4. **Include what you did NOT test**, and why. Skipped steps are where overreach hides.
5. **Write numbered specific questions.** Name the actual mechanisms in play (for example: cookie scoping, scheme mismatch, state replay, cache staleness, race on write). Generic "what is wrong with this" returns generic answers.
6. **State what happens next if the conclusion stands.** The critic needs the stakes to judge the worst case.

## Spawn the critic

Use the Agent tool with `subagent_type: critic`. Do NOT pass a `model` override; the `critic` agent definition already pins `claude-fable-5-1`, and overriding a pinned agent model is against the documented rule (see `/orchestrate-via-fable`).

Open the prompt with the refute instruction, verbatim in spirit: "Your job is to REFUTE, not to agree." A neutral "please review this" invites agreement, which is the failure mode this whole command exists to prevent.

Then hand over the assembled brief from the previous section: labeled claims, raw evidence, self-identified holes, untested gaps, numbered questions, and the stakes.

## After the critic returns

1. **Report the findings to the user before acting on them.** Lead with `action_recommendation` and the ranked overreach. Do not quietly fold the critique into a revised conclusion; the user needs to see what was caught.
2. **Separate what you agree with from what you dispute.** The critic can be wrong too. If you disagree with a verdict, say which one and why, with evidence. Do not capitulate to a finding you can actually refute, and do not defend a claim just because you made it.
3. **Do not act on the reviewed conclusion until the user says to.** If the critic returns DO_NOT_PROCEED, the posting, sending, or shipping does not happen. Nothing gets posted to a ticket, emailed, or pushed off the back of this command.
4. **State the next test** the critic named, and offer to run it.

## Validation

A run has succeeded when it surfaces at least one substantive finding the session did not already self-identify. A review that only echoes doubts already listed in the brief has failed; say so plainly rather than presenting it as a clean bill of health.

## Rules

- Reasoning review only. Route code to `/review`, security to `/security-review`.
- Never pass a model override to a pinned agent.
- The critic never writes code, copy, or fixes. It produces critique only; implementation stays with the main session.
- Never post, send, complete a task, or push as a result of this command. Those all require explicit permission from the user.
- No em dashes in the review brief, the findings, or your report back.
