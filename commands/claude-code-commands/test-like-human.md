Verify a change has been done properly, "test like a human" style: visually confirm the rendered output in its destination using visible Playwright when there's a UI surface, or run an alternative verification when there isn't.

The user's input is: $ARGUMENTS

**Argument parsing:**
- If $ARGUMENTS is a Jira URL or key (e.g. `PROJ-1234`), source = Jira.
- If $ARGUMENTS is an Asana task URL or GID, source = Asana.
- If $ARGUMENTS contains `basecamp.com` or is a Basecamp todo GID, source = Basecamp.
- If $ARGUMENTS is empty, source = current chat context: verify the most recently completed change in this conversation.

**Steps:**

1. **Fetch the change's source-of-truth** to derive what "done properly" means:
   - Jira: `atlassian_jira_get_issue` then read description + comments. The most recent dev/PM comment typically states what was changed and where.
   - Asana: `asana_get_task` + `asana_get_task_stories` for the same intent.
   - Basecamp: `basecamp_get_todo` + read the latest comments.
   - No argument: scan recent conversation for the change made (file edits, deploys, PRs pushed) and the URL or surface it was supposed to affect.

2. **Extract the verification spec** and write it down explicitly before doing anything else:
   - **Surface to inspect**: URL, modal, page section, Slack channel, email inbox, DB row, log file, etc.
   - **Expected state**: what the user should now see (e.g. "only the Generic Connector visible in the Add Connection modal").
   - **Negative cases**: things that should NOT be there (e.g. "no legacy connectors listed").

3. **Decide UI vs. non-UI**:
   - **UI** (has a viewable URL or surface): go to step 4.
   - **Non-UI** (backend, config, scheduled task, DB-only): skip Playwright. Pick the alt verification:
     - HTTP endpoint: `curl` via Bash
     - DB row: your database query tool (e.g. a SQL MCP)
     - Log file: `Bash` tail / grep
     - Scheduled task: check next-run timestamp or last-run log
     - None of these fit: output a manual-check checklist and stop at step 6.

4. **Reproduce the human path with visible Playwright**:
   - `browser_navigate` to the surface URL.
   - If auth is required, log in the way a real user would: use your app's normal login flow (or an admin "log in as" link if your tooling provides one) to reach the state the ticket describes. Do not skip auth by hitting an API directly; the point is to see what a human sees.
   - Click through to the exact UI state the ticket described (open modal, expand row, etc.).
   - `browser_snapshot` to read the rendered DOM and compare against the expected state from step 2.
   - `browser_take_screenshot` with a BARE filename: `<source-key>-<surface-slug>-YYYY-MM-DD.png` (no path prefix). Configure the Playwright MCP `outputDir` to your workspace `temp/` so a bare filename lands at `temp/<filename>` automatically. The resolved path for the upload step is therefore `temp/<filename>`, no `find` needed. NEVER pass an absolute path or a bare filename that would resolve against the project root; if you must be explicit, use `temp/<filename>`.

5. **Decide PASS or FAIL**:
   - **PASS** = every expected element from step 2 is present, every negative-case element is absent.
   - **FAIL** = any expected element missing or any negative-case element still present.

6. **Report inline first** in this format:

   ```
   ## Verification: [PASS ✅ | FAIL ❌] · [source key]

   **Surface**: [URL or location]
   **Expected**: [from step 2]
   **Observed**: [what the snapshot showed]
   **Screenshot**: [path]
   ```

7. **Auto-post back to source, PASS only**:
   - PASS: upload screenshot to source ticket, then add a verification comment summarizing surface + observed result + screenshot filename. Use the source-appropriate tool:
     - Jira: `atlassian_jira_add_attachment` + `atlassian_jira_add_comment`
     - Asana: `asana_upload_attachment` + `asana_create_task_story`
     - Basecamp: `basecamp_upload_attachment` + `basecamp_create_comment`
   - FAIL: do NOT auto-post. Stop after step 6 and let the user decide next steps.
   - No-arg (current chat): no source to post back to; stop after step 6.

8. **Confirm** by displaying the source ticket URL as a markdown link so the user can spot-check the posted comment.

**Rules:**
- "Test like a human" means verify the OUTPUT in its destination, not use Playwright to drive the change itself. If the ticket asks you to run a script as part of verification, run the script with its native tool (Bash, MCP), then use Playwright only to look at the result.
- Never mark the source ticket complete. Verification confirms the work, it does not close the ticket. Closure requires an explicit "close it" from the user.
- Auto-post is for PASS only. On FAIL, the inline report is the deliverable. The user decides whether to reopen, comment, or push back.
- Always use the visible Playwright browser, never headless. Visible browser matches what a human would see.
- Save screenshots with a bare filename; point the Playwright MCP `outputDir` at your workspace `temp/`, so the upload path is `temp/<filename>`. Never write a screenshot to the project root.
- No em dashes in any generated text (comment body, screenshot filenames, report).
