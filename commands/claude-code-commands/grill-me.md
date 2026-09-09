Relentlessly interview the user one question at a time to extract their knowledge about a topic, checkpointing every answer to a brainstorm file so a long session never loses context.

The user's argument is: $ARGUMENTS

This is the topic, process, project, or decision to be grilled on (e.g. "our customer onboarding flow", "the order portal architecture", "how I pick which features to build"). If no argument is given, ask what topic to grill before starting.

**Goal:** Pull the tacit knowledge out of the user's head and into a reusable markdown file that can be fed as context into future projects, so those projects start at ~90% effectiveness instead of ~70%.

## Setup (do this first, before any questions)

1. **Determine the topic.** Use `$ARGUMENTS`. If empty, ask: "What do you want me to grill you on?" and wait.
2. **Pick the brainstorm location.** NEVER create `brainstorms/` in the workspace root. Decide in this order:
   - **a. Project folder from this session:** if the conversation so far (or the topic itself) clearly maps to a specific project/app/tool folder, use `<that-folder>/brainstorms/`.
   - **b. Unsure?** Use `temp/brainstorms/` in the workspace root. Do not guess a project folder; do not ask, just use temp. The file can be moved later.
   - Path: `<chosen-folder>/brainstorms/grill-<topic-kebab>-<YYYY-MM-DD>.md`
   - `<topic-kebab>` = the topic in lowercase with dashes, no spaces. Date at the end. (Get the date with `date`.)
   - Create the `brainstorms/` folder if it doesn't exist.
3. **Write the file header** immediately:
   ```markdown
   # Grill Session: <Topic>
   **Date:** <YYYY-MM-DD>  |  **Status:** In progress

   ## Q&A Log
   ```
4. Tell the user: the file path, that you'll ask **one question at a time**, that they can say "done", "stop", or "wrap up" anytime to finalize, and that everything is checkpointed so they can quit and resume later.

## The Interview Loop

Repeat until the user signals they're done or you've genuinely exhausted the topic:

1. **Ask exactly ONE question.** Never batch questions, and never squeeze multiple questions into one even when they are related or feel like natural parts of the same topic. ONE question means one thing being asked that has a single answer. Specifically forbidden:
   - "Two parts: first X, second Y" is two questions; ask only the first.
   - A main question that then tacks on a second decision (e.g. "what's the success bar, AND do you want to also track Z?").
   - A question that offers lettered/numbered sub-options to pick from AND a separate follow-up decision in the same message.
   If a related second question is begging to be asked, hold it: ask it as the NEXT question after they answer the first. Let their answer to the first one even reshape whether the second is still worth asking.
   Make it specific and probing: go for the decisions, edge cases, "why this not that", failure modes, the stuff only they know. Just ask the single best next question.
2. **Wait for the answer, and verify it's actually theirs and actually an answer before acting.** Do NOT record or act on a decision from an input that is ambiguous, partial, garbled, or that reads as "you decide / I don't know / whatever you think." In particular:
   - If the input looks malformed or contaminated (e.g. a role label fused onto text like `userdamn...`, pasted content that doesn't read as a fresh reply, or text that seems copied from a previous message), STOP. Quote back what you received and ask "did you mean to send this?" before doing anything else.
   - If they say "you decide" / "I don't know" / "what do you think," you MAY offer a recommendation, but treat it as a recommendation only: do NOT silently record it as their decision. Present it and ask them to confirm ("I'd go with X for these reasons, record that as your call?") before writing it to the file as a decision.
   - Never infer permission to choose. Permission to decide on their behalf must be explicit and unambiguous in that turn.
3. **Immediately append** the Q&A pair to the brainstorm file under `## Q&A Log` (use the Edit tool to append, do NOT rewrite the whole file):
   ```markdown
   **Q<n>:** <the question>
   **A<n>:** <their answer, captured faithfully>

   ```
   This checkpoint happens after EVERY answer, no exceptions. This is the whole point: it survives context-window pressure.
4. **Follow the thread.** Let their answer drive the next question. Dig into vague answers ("you said 'usually', when is it not?"). Don't move on while something is still fuzzy.
5. Keep a running mental list of **gaps**: things they don't know, defer, or that clearly need someone else's input.

## Wrapping Up (when user says done, or topic is exhausted)

Append these sections to the brainstorm file:

```markdown
## Key Decisions
- <the concrete decisions/rules that emerged, bulleted>

## Highlights
- <the most important / reusable takeaways>

## Gaps & Who to Interview
- <missing info>, suggested source: <person/role/system to consult>
```

Then update the header `**Status:**` from `In progress` to `Complete`.

Finally, tell the user:
- The full file path
- A 2-3 sentence recap of what was captured
- That they can feed this file as context into any future project, or re-run `/grill-me` later to extend it with new discoveries
- If the file landed in `temp/brainstorms/`, suggest a permanent project folder to move it to and offer to move it

## Rules
- ONE question at a time. This is non-negotiable: it's the core of the technique. One question = one thing with one answer. Never combine two related questions, never use "two parts," never append a second decision to a question. Hold the follow-up and ask it next.
- Append after every single answer. Never let unsaved Q&A pile up.
- Capture their actual words and reasoning, not your paraphrased gloss.
- Never decide for them off an ambiguous, garbled, or "you decide" input. Confirm first; a recommendation is not a recorded decision until they say yes. Malformed input (e.g. a `user` label fused onto text) = stop and ask, never act.
- Be relentless but not robotic, react to what they say.
- No em dashes in the file or your responses (use commas/colons).
- Surgical appends only, don't rewrite earlier parts of the file.
