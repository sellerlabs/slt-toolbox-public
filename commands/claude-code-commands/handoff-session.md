Package the current session's state into a handoff file so a fresh ("cold") session can pick up the work seamlessly, without inheriting this session's bloated context window.

**Why this exists:** Long sessions drift after the first compaction and valuable state gets lost. Instead of one endless session, you hand off to a cold session. Rather than pasting a huge prompt, this skill writes everything to a temp MD file and gives you a short pointer to paste. The cold session reads the file and starts running immediately.

---

## Step 0: Get the purpose (ask if missing)

The handoff needs a stated PURPOSE: what the next session is supposed to accomplish.

- If the user gave a purpose as an argument or in their message, use it.
- If NOT, ask exactly one question and wait: **"What is this handoff for, and what should the next session accomplish?"** Do not write the file until they answer.

Do not guess the purpose silently. Everything else in the file you infer from the conversation; the purpose you confirm.

---

## Step 1: Verify, don't recall

Every fact you write must be verified against the LIVE state right now, not from memory of earlier in the conversation:

- File paths → confirm they exist.
- "Done / not done" claims → check the actual file, task, build output, or command result.
- Wiring (tools, skills, MCP, commands) → confirm the names are current.
- If you cannot verify something, mark it `[UNVERIFIED]` rather than asserting it.

This verification pass is the whole point: a handoff full of stale assumptions is worse than none.

---

## Step 2: Write the handoff file

Filename: `handoff-[topic-with-dashes]-YYYY-MM-DD-HHMM.md`
- `[topic-with-dashes]`: 2-5 word slug of the work (dashes, no spaces/emojis).
- Date + 24h time so multiple handoffs in a day don't collide.

Save location: `temp/` at the workspace root (e.g. `<workspace-root>/temp/`). Never the project root.

Write the file in EXACTLY this structure. Omit a section only if it genuinely does not apply; never pad.

```markdown
# Handoff: [Topic]
Generated: [Month DD, YYYY HH:MM] · from session: [1-line what this session was]

> Every fact below is verified against the live repo/task state as of generation, not memory. Items I could not verify are tagged [UNVERIFIED].

## Purpose
[Exactly what the next session must accomplish. The user's stated goal, verbatim intent.]

## First action
[The single concrete thing to do first. A command to run, a file to open, a check to make. So the cold session can "just hit go."]

## Canonical state
- **Goal:** [the end state we're driving toward]
- **Done:** [what is already complete and verified]
- **Not done:** [what remains, in priority order]
- **In flight:** [anything half-finished, and exactly where it was left]

## Traps & edge cases
[The non-obvious things that will break the next session if it doesn't know them: a stray comma/dash that throws errors, a table that must be refreshed, an API that lags, a step that must run before another. If none discovered, write "None discovered this session."]

## Wiring: files, tools, skills, MCP, commands
- **Key files:** [path, one-line role each]
- **Skills/commands to use:** [/skill-name, when/why]
- **MCP/tools:** [tool or prefix, what it's for here]
- **Env/secrets:** [which .env or secret store, by pointer only, never the value]

## Validation baseline
[How the next session knows the work is actually working: the command whose output confirms success, the URL to check, the test to run, the expected result.]

## Constraints & standing orders
[What NOT to touch or do. Approval gates that apply. Anything the user said was off-limits. Relevant project-instruction / memory rules that bear on this work.]
```

Rules for the content:
- Concise and scannable: the cold session reads this to move fast, not to read prose. Bullets over paragraphs.
- Absolute paths for anything the next session must open or run.
- Never write a secret value into the file, pointer only.
- No em dashes anywhere in the file: use commas, colons, or restructure.

---

## Step 3: Give the user the pointer to paste

After writing the file, output ONLY the pointer for the next session, not the file's contents.

Emit the pointer INSIDE a fenced code block (triple backticks). Claude Code's chat UI auto-attaches a one-click copy button to fenced code blocks, so this gives the user a single-click copy of the exact text to paste into the cold session. Emit it EXACTLY like this, backticks included:

````
```
Read the handoff file temp/handoff-[filename].md in full, then continue that work starting from the "First action" section. Verify anything tagged [UNVERIFIED] before relying on it.
```
````

Then, OUTSIDE the code block, output exactly two confirmation lines (the clickable link doubles as the "saved to" confirmation, so do not add a separate "Handoff saved to:" line). The link TEXT is the full absolute path (so the user sees exactly where it saved), but the link TARGET stays the zero-hop relative path (so it opens in the editor):

```
Open: [<workspace-root>/temp/handoff-[filename].md](temp/handoff-[filename].md)
Topic: [the topic]
```

Rules for the pointer:
- The instruction inside the code block must be ONE single copy-paste unit (do not split it across multiple blocks).
- Inside the code block, use the plain relative path `temp/handoff-[filename].md` (not a markdown link), because a markdown link renders as raw `[text](...)` syntax inside a code fence. The cold session resolves the plain path fine.
- The "Open:" link TARGET must be the zero-hop relative path with NO spaces (`temp/handoff-[filename].md`) so it opens correctly in the editor, even though the visible link TEXT is the full absolute path.

Do not paste the whole file back into this chat. Keeping it in the file instead of this window is the entire point.
