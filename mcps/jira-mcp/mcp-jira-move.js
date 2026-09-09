#!/usr/bin/env node
/**
 * MCP server that adds jira_move_issue — moves a Jira issue to a different project.
 * Uses the Jira REST API to update the project field directly (true move, new key assigned).
 * Reads credentials from env vars (same as mcp-atlassian).
 */

import { createInterface } from 'readline';

const JIRA_URL = process.env.JIRA_URL?.replace(/\/$/, '');
const JIRA_USERNAME = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

function authHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_USERNAME}:${JIRA_API_TOKEN}`).toString('base64');
}

function baseHeaders() {
  return {
    'Authorization': authHeader(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function getIssue(issueKey) {
  const url = `${JIRA_URL}/rest/api/3/issue/${issueKey}?fields=summary,issuetype,project,status,description,assignee,priority,labels,components`;
  const res = await fetch(url, { headers: baseHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch issue ${issueKey}: ${res.status} ${text}`);
  }
  return res.json();
}

async function moveIssue(issueKey, targetProjectKey, targetIssueType) {
  const url = `${JIRA_URL}/rest/api/3/issue/${issueKey}`;

  const fields = {
    project: { key: targetProjectKey },
  };
  if (targetIssueType) {
    fields.issuetype = { name: targetIssueType };
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: baseHeaders(),
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Move failed (${res.status}): ${text}`);
  }

  // 204 No Content on success — fetch updated issue to get new key
  const updated = await getIssue(issueKey);
  return updated;
}

// --- Minimal MCP stdio server ---

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const TOOLS = [
  {
    name: 'jira_move_issue',
    description: 'Move a Jira issue to a different project. The issue gets a new key in the target project. Optionally specify the target issue type (defaults to Task).',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: {
          type: 'string',
          description: "Jira issue key to move, e.g. 'ESC-610'",
        },
        target_project_key: {
          type: 'string',
          description: "Target project key, e.g. 'SD'",
        },
        target_issue_type: {
          type: 'string',
          description: "Issue type in the target project (e.g. 'Task', 'Bug', 'Story'). Defaults to 'Task'.",
        },
      },
      required: ['issue_key', 'target_project_key'],
    },
  },
];

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'jira-move', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'jira_move_issue') {
      try {
        const { issue_key, target_project_key, target_issue_type = 'Task' } = args;

        if (!JIRA_URL || !JIRA_USERNAME || !JIRA_API_TOKEN) {
          throw new Error('Missing JIRA_URL, JIRA_USERNAME, or JIRA_API_TOKEN env vars');
        }

        const before = await getIssue(issue_key);
        const beforeKey = before.key;
        const beforeProject = before.fields?.project?.key;

        await moveIssue(issue_key, target_project_key, target_issue_type);

        // After move, the issue key changes — find it by searching
        // Jira keeps the same issue ID internally; fetch by original key first
        // (some Jira instances redirect old key, others don't)
        let newKey = beforeKey;
        try {
          const after = await getIssue(beforeKey);
          newKey = after.key;
        } catch {
          // old key may no longer resolve; that's expected
          newKey = `(new key in ${target_project_key})`;
        }

        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Moved ${beforeKey} from project ${beforeProject} to ${target_project_key}.\nNew issue key: ${newKey}`,
              },
            ],
          },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          },
        });
      }
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }

  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
