#!/usr/bin/env node
/**
 * MCP server that adds jira_add_attachment to the Jira integration.
 * Reads credentials from env vars set in .claude.json (same as mcp-atlassian).
 */
import { createReadStream, existsSync, statSync } from 'fs';
import { basename } from 'path';
import { createInterface } from 'readline';

const JIRA_URL = process.env.JIRA_URL?.replace(/\/$/, '');
const JIRA_USERNAME = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

function authHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_USERNAME}:${JIRA_API_TOKEN}`).toString('base64');
}

async function uploadAttachment(issueKey, filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileName = basename(filePath);
  const fileSize = statSync(filePath).size;

  // Build multipart/form-data manually (no dependencies needed)
  const boundary = '----McpJiraAttach' + Date.now();
  const fileStream = createReadStream(filePath);

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  const totalLength = header.length + fileSize + footer.length;

  const url = `${JIRA_URL}/rest/api/3/issue/${issueKey}/attachments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'X-Atlassian-Token': 'no-check',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': totalLength,
    },
    body: new ReadableStream({
      async start(controller) {
        controller.enqueue(header);
        for await (const chunk of fileStream) {
          controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        controller.enqueue(footer);
        controller.close();
      },
    }),
    duplex: 'half',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira API error ${response.status}: ${text}`);
  }

  const result = await response.json();
  const attachment = Array.isArray(result) ? result[0] : result;
  return {
    id: attachment?.id,
    filename: attachment?.filename ?? fileName,
    size: attachment?.size ?? fileSize,
    content: attachment?.content,
  };
}

// --- Minimal MCP stdio server ---

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const TOOLS = [
  {
    name: 'jira_add_attachment',
    description: 'Attach a local file to a Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: {
          type: 'string',
          description: "Jira issue key, e.g. 'SLT-123'",
        },
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to attach.',
        },
      },
      required: ['issue_key', 'file_path'],
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
        serverInfo: { name: 'jira-attachments', version: '1.0.0' },
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
    if (name === 'jira_add_attachment') {
      try {
        const info = await uploadAttachment(args.issue_key, args.file_path);
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Attached "${info.filename}" to ${args.issue_key} (id: ${info.id}, size: ${info.size} bytes)${info.content ? '\nURL: ' + info.content : ''}`,
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

  // Unknown method - return empty response to avoid hanging
  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
