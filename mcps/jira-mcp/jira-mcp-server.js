/**
 * Jira MCP Server - JavaScript replacement for mcp-atlassian (Python/uvx).
 * Combines: core Jira tools + jira_move_issue + jira_add_attachment
 * Reads credentials from .env in this directory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, createReadStream, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ENV LOADER ─────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(__dirname, '.env');
  try {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env not found — rely on process.env being pre-set
  }
}

loadEnv();

const JIRA_URL = (process.env.JIRA_URL || '').replace(/\/$/, '');
const JIRA_USERNAME = process.env.JIRA_USERNAME || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
// Default assignee for jira_create_issue. Resolves to the owner of the API token
// (via /myself), so this MCP stays correct if handed to a different person.
// Set JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID to override, or to 'none' to disable.
const JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID = process.env.JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID || '';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function authHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_USERNAME}:${JIRA_API_TOKEN}`).toString('base64');
}

function baseHeaders(contentType = 'application/json') {
  return {
    Authorization: authHeader(),
    'Content-Type': contentType,
    Accept: 'application/json',
  };
}

async function jiraFetch(path, options = {}) {
  const url = JIRA_URL + path;
  const res = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Resolve the accountId to auto-assign new issues to. Defaults to the owner of
// the API token, looked up once and cached for the life of the process.
// Returns null when disabled or when the lookup fails (issue is then unassigned).
let _defaultAssigneeCache;
async function defaultAssigneeAccountId() {
  if (_defaultAssigneeCache !== undefined) return _defaultAssigneeCache;
  const override = JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID.trim();
  if (override.toLowerCase() === 'none') return (_defaultAssigneeCache = null);
  if (override) return (_defaultAssigneeCache = override);
  try {
    const me = await jiraFetch('/rest/api/3/myself');
    return (_defaultAssigneeCache = me?.accountId || null);
  } catch {
    // Never let a failed lookup break issue creation.
    return (_defaultAssigneeCache = null);
  }
}

// Convert plain text to Atlassian Document Format (ADF).
// Supports inline @mention tokens so comments can ping users for real
// (the same way the Jira UI does), not just notify assignee/reporter/watchers.
//
// Mention token syntax (either form works):
//   [~accountid:557058:abc-123]   ← Jira's native wiki-markup mention form
//   @[557058:abc-123]             ← shorthand
// The token is replaced by a proper ADF "mention" node. Anything else is
// emitted as plain text, so existing callers are unaffected.
const MENTION_TOKEN = /\[~accountid:([^\]]+)\]|@\[([^\]]+)\]/g;

function textToInlineNodes(text) {
  const str = String(text);
  const nodes = [];
  let lastIndex = 0;
  let m;
  MENTION_TOKEN.lastIndex = 0;
  while ((m = MENTION_TOKEN.exec(str)) !== null) {
    if (m.index > lastIndex) {
      nodes.push({ type: 'text', text: str.slice(lastIndex, m.index) });
    }
    const accountId = m[1] || m[2];
    nodes.push({ type: 'mention', attrs: { id: accountId, text: '@user' } });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < str.length) {
    nodes.push({ type: 'text', text: str.slice(lastIndex) });
  }
  // ADF paragraphs cannot be empty; ensure at least one node.
  return nodes.length ? nodes : [{ type: 'text', text: '' }];
}

// Apply display names to mention nodes in place, so the rendered comment shows
// "@Michael Ward" instead of "@user".
function applyDisplayNames(nodes, displayNames = {}) {
  for (const n of nodes) {
    if (n.type === 'mention' && displayNames[n.attrs.id]) {
      n.attrs.text = '@' + displayNames[n.attrs.id];
    }
  }
  return nodes;
}

// Inline markdown -> ADF marks. Handles `code`, **bold**, *italic*, and
// [text](url) links, on top of the existing mention tokens. Order matters:
// code is tokenized first so markup inside backticks stays literal.
function inlineMarkdownToNodes(text, displayNames = {}) {
  const out = [];
  const str = String(text);
  // Split on code spans first; odd indexes are code content.
  const parts = str.split(/`([^`]+)`/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push({ type: 'text', text: part, marks: [{ type: 'code' }] });
      return;
    }
    // Then links, bold, italic within the non-code segments.
    const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(part)) !== null) {
      if (m.index > last) {
        out.push(...applyDisplayNames(textToInlineNodes(part.slice(last, m.index)), displayNames));
      }
      if (m[1]) {
        out.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] });
      } else if (m[3]) {
        out.push({ type: 'text', text: m[3], marks: [{ type: 'strong' }] });
      } else if (m[4]) {
        out.push({ type: 'text', text: m[4], marks: [{ type: 'em' }] });
      }
      last = m.index + m[0].length;
    }
    if (last < part.length) {
      out.push(...applyDisplayNames(textToInlineNodes(part.slice(last)), displayNames));
    }
  });
  return out.length ? out : [{ type: 'text', text: '' }];
}

const mdParagraph = (line, dn) => ({ type: 'paragraph', content: inlineMarkdownToNodes(line, dn) });

// Parse a markdown pipe table (header row, --- separator, body rows) into an
// ADF table node. Returns null if the block is not a well-formed table.
function parseMarkdownTable(lines, dn) {
  if (lines.length < 2) return null;
  const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (!/^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(lines[1])) return null;
  const headers = split(lines[0]);
  const rows = lines.slice(2).map(split).filter((r) => r.length && r.some((c) => c !== ''));
  const cell = (kind, txt) => ({
    type: kind,
    attrs: {},
    content: [mdParagraph(txt, dn)],
  });
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [
      { type: 'tableRow', content: headers.map((hh) => cell('tableHeader', hh)) },
      ...rows.map((r) => ({
        type: 'tableRow',
        content: headers.map((_, i) => cell('tableCell', r[i] === undefined ? '' : r[i])),
      })),
    ],
  };
}

// Convert markdown-ish text into a real ADF document with headings, tables,
// lists, code blocks, and blockquotes. Plain text still round-trips as a single
// paragraph, so existing callers are unaffected.
//
// Callers may also pass a pre-built ADF document object (with type:'doc'), which
// is forwarded untouched for full control.
function toADF(text, displayNames = {}) {
  if (text && typeof text === 'object' && text.type === 'doc') return text;

  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const content = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code block
    const fence = line.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      content.push({
        type: 'codeBlock',
        attrs: fence[1] ? { language: fence[1] } : {},
        content: body.length ? [{ type: 'text', text: body.join('\n') }] : [],
      });
      continue;
    }

    // ATX heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineMarkdownToNodes(heading[2], displayNames),
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      content.push({ type: 'rule' });
      i++;
      continue;
    }

    // Pipe table
    if (/\|/.test(line) && i + 1 < lines.length) {
      const block = [];
      let j = i;
      while (j < lines.length && lines[j].trim() && /\|/.test(lines[j])) block.push(lines[j++]);
      const tbl = parseMarkdownTable(block, displayNames);
      if (tbl) { content.push(tbl); i = j; continue; }
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      content.push({ type: 'blockquote', content: [mdParagraph(body.join(' '), displayNames)] });
      continue;
    }

    // Lists (bulleted or ordered); one level, which covers normal ticket usage.
    const isBullet = (l) => /^\s*[-*+]\s+/.test(l);
    const isOrdered = (l) => /^\s*\d+[.)]\s+/.test(l);
    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const items = [];
      while (i < lines.length && (ordered ? isOrdered(lines[i]) : isBullet(lines[i]))) {
        const txt = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, '');
        items.push({ type: 'listItem', content: [mdParagraph(txt, displayNames)] });
        i++;
      }
      content.push(
        ordered
          ? { type: 'orderedList', attrs: { order: 1 }, content: items }
          : { type: 'bulletList', content: items }
      );
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const buf = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*```/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) && !isBullet(lines[i]) && !isOrdered(lines[i]) &&
      !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    content.push(mdParagraph(buf.join(' '), displayNames));
  }

  return {
    type: 'doc',
    version: 1,
    content: content.length ? content : [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
  };
}

// Look up display names for a set of accountIds so mention nodes render with
// the user's real name. Failures are non-fatal (mention still resolves by id).
async function resolveDisplayNames(accountIds) {
  const map = {};
  await Promise.all(
    [...new Set(accountIds)].map(async (id) => {
      try {
        const u = await jiraFetch(`/rest/api/3/user?accountId=${encodeURIComponent(id)}`);
        if (u?.displayName) map[id] = u.displayName;
      } catch {
        // leave unresolved — mention still pings by accountId
      }
    })
  );
  return map;
}

// Extract accountIds referenced by mention tokens in a string.
function extractMentionIds(text) {
  const ids = [];
  let m;
  MENTION_TOKEN.lastIndex = 0;
  while ((m = MENTION_TOKEN.exec(String(text))) !== null) ids.push(m[1] || m[2]);
  return ids;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function escapeJql(value) {
  // Escape JQL special characters: backslash, quotes, and reserved operators
  return String(value).replace(/[\\"']/g, '\\$&');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── SERVER ──────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'jira', version: '1.0.0' });

// ─── STRICT ARG VALIDATION ───────────────────────────────────────────────────
//
// The MCP SDK parses incoming args against each tool's Zod shape and hands the
// handler the PARSED object, so unknown keys are stripped before the handler
// ever runs. A caller passing `fields` to a tool that wants `extra_fields` got
// a cheerful `{success: true}` and no write: the typo vanished silently and the
// PUT went out with an empty body, which Jira accepts as a no-op.
//
// Wrap server.tool so each registration records its allowed keys, then check the
// RAW arguments on the way in and fail loudly on anything unrecognized.
const ALLOWED_KEYS = new Map();

const _rawTool = server.tool.bind(server);
server.tool = (name, description, shape, handler) => {
  if (shape && typeof shape === 'object') ALLOWED_KEYS.set(name, new Set(Object.keys(shape)));
  return _rawTool(name, description, shape, handler);
};

// Suggest the intended parameter for a typo'd key, so the error is actionable.
function suggestKey(bad, allowed) {
  const b = bad.toLowerCase();
  const hit = [...allowed].find(k => {
    const a = k.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  });
  return hit ? ` Did you mean '${hit}'?` : '';
}

const _rawRequestHandler = server.server.setRequestHandler.bind(server.server);
let _callToolHandler = null;
server.server.setRequestHandler = (schema, fn) => {
  // Intercept only the CallTool handler; everything else passes through.
  if (schema?.shape?.method?.value === 'tools/call') {
    _callToolHandler = fn;
    return _rawRequestHandler(schema, async (request, extra) => {
      const name = request?.params?.name;
      const args = request?.params?.arguments;
      const allowed = ALLOWED_KEYS.get(name);
      if (allowed && args && typeof args === 'object') {
        const unknown = Object.keys(args).filter(k => !allowed.has(k));
        if (unknown.length) {
          const detail = unknown
            .map(k => `'${k}'${suggestKey(k, allowed)}`)
            .join(', ');
          throw new Error(
            `Unknown parameter(s) for ${name}: ${detail} ` +
            `Valid parameters: ${[...allowed].join(', ')}. ` +
            `Nothing was written — re-send with the correct parameter name.`
          );
        }
      }
      return _callToolHandler(request, extra);
    });
  }
  return _rawRequestHandler(schema, fn);
};

// ─── TOOL: jira_search ───────────────────────────────────────────────────────

server.tool(
  'jira_search',
  'Search Jira issues using JQL. Returns summary, status, assignee, priority, and type for each match.',
  {
    jql: z.string().describe('JQL query string, e.g. "project = SD AND status = Open"'),
    max_results: z.number().int().min(1).max(100).optional().default(50).describe('Max issues to return (default 50)'),
    start_at: z.number().int().min(0).optional().default(0).describe('Pagination offset'),
    fields: z.string().optional().describe('Comma-separated field names to include. Default: summary,status,assignee,priority,issuetype,created,updated,description,labels,components'),
  },
  async ({ jql, max_results, start_at, fields }) => {
    const fieldList = (fields || 'summary,status,assignee,priority,issuetype,created,updated,description,labels,components').split(',').map(f => f.trim());
    const body = { jql, maxResults: max_results, fields: fieldList, fieldsByKeys: false };
    const data = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return ok({ total: data.total, startAt: data.startAt, maxResults: data.maxResults, issues: data.issues });
  }
);

// ─── TOOL: jira_get_issue ────────────────────────────────────────────────────

server.tool(
  'jira_get_issue',
  'Get full details of a Jira issue by key (e.g. SD-1234).',
  { issue_key: z.string().describe('Issue key, e.g. SD-1234') },
  async ({ issue_key }) => {
    const data = await jiraFetch(`/rest/api/3/issue/${issue_key}`);
    return ok(data);
  }
);

// ─── TOOL: jira_create_issue ─────────────────────────────────────────────────

server.tool(
  'jira_create_issue',
  'Create a new Jira issue.',
  {
    project_key: z.string().describe('Project key, e.g. SD'),
    summary: z.string().describe('Issue summary / title'),
    issue_type: z.string().optional().default('Task').describe('Issue type name, e.g. Task, Bug, Story'),
    description: z.string().optional().describe('Issue description (plain text)'),
    assignee_account_id: z.string().optional().describe('Assignee accountId. If omitted, the issue is auto-assigned to the owner of the API token (every project). Pass an empty string to deliberately create it unassigned.'),
    priority: z.string().optional().describe('Priority name, e.g. High, Medium, Low'),
    labels: z.array(z.string()).optional().describe('Labels to apply'),
    parent_key: z.string().optional().describe('Parent issue key. Use for subtasks AND to file under an epic (e.g. SD-8570). On team-managed projects the create call silently ignores parent, so this tool re-applies it with a follow-up update and reports the result in parent_linked.'),
  },
  async ({ project_key, summary, issue_type, description, assignee_account_id, priority, labels, parent_key }) => {
    const fields = {
      project: { key: project_key },
      summary,
      issuetype: { name: issue_type },
    };
    if (description) fields.description = toADF(description);
    // Explicit accountId wins. Omitted (undefined) falls back to the token owner.
    // Empty string means "create unassigned on purpose".
    if (assignee_account_id) fields.assignee = { accountId: assignee_account_id };
    else if (assignee_account_id === undefined) {
      const defaultAssignee = await defaultAssigneeAccountId();
      if (defaultAssignee) fields.assignee = { accountId: defaultAssignee };
    }
    if (priority) fields.priority = { name: priority };
    if (labels?.length) fields.labels = labels;
    if (parent_key) fields.parent = { key: parent_key };
    const data = await jiraFetch('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });

    // Team-managed projects silently DROP `parent` on create: the POST returns
    // success and the issue comes back with no epic. (jira_link_to_epic also
    // fails there, since customfield_10014 does not exist.) So verify, and
    // re-apply via PUT when it did not stick. Reported, never silent.
    if (parent_key) {
      try {
        const created = await jiraFetch(`/rest/api/3/issue/${data.key}?fields=parent`);
        if (created?.fields?.parent?.key !== parent_key) {
          await jiraFetch(`/rest/api/3/issue/${data.key}`, {
            method: 'PUT',
            body: JSON.stringify({ fields: { parent: { key: parent_key } } }),
          });
        }
        return ok({ ...data, parent_linked: parent_key });
      } catch (err) {
        // The issue exists; only the parent link failed. Say so explicitly
        // rather than returning a bare success the caller would misread.
        return ok({ ...data, parent_linked: false, parent_error: String(err.message || err) });
      }
    }
    return ok(data);
  }
);

// ─── TOOL: jira_update_issue ─────────────────────────────────────────────────

server.tool(
  'jira_update_issue',
  'Update fields on an existing Jira issue.',
  {
    issue_key: z.string().describe('Issue key, e.g. SD-1234'),
    summary: z.string().optional().describe('New summary'),
    description: z.string().optional().describe('New description (plain text)'),
    assignee_account_id: z.string().optional().describe('New assignee accountId. Pass empty string to unassign.'),
    priority: z.string().optional().describe('Priority name'),
    labels: z.array(z.string()).optional().describe('Replace labels with this list'),
    parent_key: z.string().optional().describe("Parent issue key, to file this issue under an epic (e.g. SD-6877). Use this rather than hand-building parent in extra_fields. Verified by read-back: the response reports parent_linked."),
    extra_fields: z.record(z.unknown()).optional().describe('Any additional fields as a JSON object (merged into update)'),
  },
  async ({ issue_key, summary, description, assignee_account_id, priority, labels, parent_key, extra_fields }) => {
    const fields = { ...(extra_fields || {}) };
    if (summary !== undefined) fields.summary = summary;
    if (description !== undefined) fields.description = toADF(description);
    if (assignee_account_id !== undefined) fields.assignee = assignee_account_id ? { accountId: assignee_account_id } : null;
    if (priority !== undefined) fields.priority = { name: priority };
    if (labels !== undefined) fields.labels = labels;
    if (parent_key !== undefined) fields.parent = { key: parent_key };

    // An empty field set means the caller's intent did not survive into a write.
    // Jira accepts a no-op PUT and returns 204, which previously looked like success.
    if (!Object.keys(fields).length) {
      throw new Error(
        `jira_update_issue called with no updatable fields for ${issue_key}. ` +
        `Nothing was written. Pass at least one of: summary, description, ` +
        `assignee_account_id, priority, labels, parent_key, extra_fields.`
      );
    }

    await jiraFetch(`/rest/api/3/issue/${issue_key}`, { method: 'PUT', body: JSON.stringify({ fields }) });

    // Team-managed projects silently DROP `parent` on write (same trap as create:
    // the PUT returns 204 and the epic link never lands). Verify by read-back and
    // report the truth rather than a bare success the caller would misread.
    if (parent_key !== undefined) {
      try {
        const after = await jiraFetch(`/rest/api/3/issue/${issue_key}?fields=parent`);
        const landed = after?.fields?.parent?.key;
        if (landed !== parent_key) {
          return ok({
            success: false,
            issue_key,
            parent_linked: false,
            parent_error: `Jira accepted the update but parent is ${landed ? `'${landed}'` : 'still unset'}, not '${parent_key}'. Other fields in this call were written.`,
          });
        }
        return ok({ success: true, issue_key, parent_linked: parent_key });
      } catch (err) {
        return ok({ success: true, issue_key, parent_linked: 'unverified', parent_error: String(err.message || err) });
      }
    }
    return ok({ success: true, issue_key });
  }
);

// ─── TOOL: jira_delete_issue ─────────────────────────────────────────────────

server.tool(
  'jira_delete_issue',
  'Delete a Jira issue. Use with caution.',
  { issue_key: z.string().describe('Issue key to delete') },
  async ({ issue_key }) => {
    await jiraFetch(`/rest/api/3/issue/${issue_key}`, { method: 'DELETE' });
    return ok({ success: true, deleted: issue_key });
  }
);

// ─── TOOL: jira_add_comment ──────────────────────────────────────────────────

server.tool(
  'jira_add_comment',
  'Add a comment to a Jira issue. To @mention (ping) a user, either pass their accountId(s) in `mention_account_ids` (prepended as "@Name " to the comment) or embed a token inline in `body`: [~accountid:ACCOUNT_ID]. Mentioned users get a real notification, the same as an @mention typed in the Jira UI. Use jira_search_users to find an accountId by name.',
  {
    issue_key: z.string().describe('Issue key'),
    body: z.string().describe('Comment text. May contain inline mention tokens like [~accountid:5b10...].'),
    mention_account_ids: z.array(z.string()).optional().describe('accountIds to @mention; each is prepended to the comment as a real ping.'),
  },
  async ({ issue_key, body, mention_account_ids }) => {
    let text = body;
    if (mention_account_ids?.length) {
      const prefix = mention_account_ids.map(id => `[~accountid:${id}]`).join(' ');
      text = `${prefix} ${body}`;
    }
    const names = await resolveDisplayNames(extractMentionIds(text));
    const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: toADF(text, names) }),
    });
    return ok(data);
  }
);

// ─── TOOL: jira_edit_comment ─────────────────────────────────────────────────

server.tool(
  'jira_edit_comment',
  'Edit an existing comment on a Jira issue.',
  {
    issue_key: z.string().describe('Issue key'),
    comment_id: z.string().describe('Comment ID'),
    body: z.string().describe('Updated comment text'),
  },
  async ({ issue_key, comment_id, body }) => {
    const names = await resolveDisplayNames(extractMentionIds(body));
    const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/comment/${comment_id}`, {
      method: 'PUT',
      body: JSON.stringify({ body: toADF(body, names) }),
    });
    return ok(data);
  }
);

// ─── TOOL: jira_get_transitions ──────────────────────────────────────────────

server.tool(
  'jira_get_transitions',
  'Get available workflow transitions for a Jira issue.',
  { issue_key: z.string().describe('Issue key') },
  async ({ issue_key }) => {
    const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/transitions`);
    return ok(data.transitions?.map(t => ({ id: t.id, name: t.name, to: t.to?.name })));
  }
);

// ─── TOOL: jira_transition_issue ─────────────────────────────────────────────

server.tool(
  'jira_transition_issue',
  'Transition a Jira issue to a new status using a transition ID. Use jira_get_transitions first to find the ID.',
  {
    issue_key: z.string().describe('Issue key'),
    transition_id: z.string().describe('Transition ID from jira_get_transitions'),
    comment: z.string().optional().describe('Optional comment to add with the transition'),
  },
  async ({ issue_key, transition_id, comment }) => {
    const body = { transition: { id: transition_id } };
    if (comment) body.update = { comment: [{ add: { body: toADF(comment) } }] };
    await jiraFetch(`/rest/api/3/issue/${issue_key}/transitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return ok({ success: true, issue_key, transition_id });
  }
);

// ─── TOOL: jira_get_all_projects ─────────────────────────────────────────────

server.tool(
  'jira_get_all_projects',
  'List all Jira projects accessible to the authenticated user.',
  {
    query: z.string().optional().describe('Filter by project name or key'),
    max_results: z.number().int().min(1).max(100).optional().default(50),
  },
  async ({ query, max_results }) => {
    const params = new URLSearchParams({ maxResults: max_results });
    if (query) params.set('query', query);
    const data = await jiraFetch(`/rest/api/3/project/search?${params}`);
    return ok(data.values?.map(p => ({ id: p.id, key: p.key, name: p.name, type: p.projectTypeKey })));
  }
);

// ─── TOOL: jira_get_project_issues ───────────────────────────────────────────

server.tool(
  'jira_get_project_issues',
  'Get issues for a specific project, optionally filtered by status or assignee.',
  {
    project_key: z.string().describe('Project key, e.g. SD'),
    status: z.string().optional().describe('Filter by status name, e.g. "In Progress"'),
    assignee: z.string().optional().describe('Filter by assignee accountId or display name'),
    max_results: z.number().int().min(1).max(100).optional().default(50),
    start_at: z.number().int().min(0).optional().default(0),
  },
  async ({ project_key, status, assignee, max_results, start_at }) => {
    const conditions = [`project = "${escapeJql(project_key)}"`];
    if (status) conditions.push(`status = "${escapeJql(status)}"`);
    if (assignee) conditions.push(`assignee = "${escapeJql(assignee)}"`);
    const jql = `${conditions.join(' AND ')} ORDER BY updated DESC`;
    const data = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, maxResults: max_results, fields: ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated'], fieldsByKeys: false }),
    });
    return ok({ total: data.total, issues: data.issues });
  }
);

// ─── TOOL: jira_get_agile_boards ─────────────────────────────────────────────

server.tool(
  'jira_get_agile_boards',
  'List agile boards (Scrum or Kanban).',
  {
    project_key: z.string().optional().describe('Filter by project key'),
    type: z.enum(['scrum', 'kanban']).optional().describe('Board type filter'),
  },
  async ({ project_key, type }) => {
    const params = new URLSearchParams();
    if (project_key) params.set('projectKeyOrId', project_key);
    if (type) params.set('type', type);
    const data = await jiraFetch(`/rest/agile/1.0/board?${params}`);
    return ok(data.values?.map(b => ({ id: b.id, name: b.name, type: b.type, project: b.location?.projectKey })));
  }
);

// ─── TOOL: jira_get_board_issues ─────────────────────────────────────────────

server.tool(
  'jira_get_board_issues',
  'Get issues on a board (backlog + active sprints).',
  {
    board_id: z.number().int().describe('Board ID from jira_get_agile_boards'),
    jql: z.string().optional().describe('Additional JQL filter'),
    max_results: z.number().int().min(1).max(100).optional().default(50),
    start_at: z.number().int().min(0).optional().default(0),
  },
  async ({ board_id, jql, max_results, start_at }) => {
    const params = new URLSearchParams({ maxResults: max_results, startAt: start_at });
    if (jql) params.set('jql', jql);
    const data = await jiraFetch(`/rest/agile/1.0/board/${board_id}/issue?${params}`);
    return ok({ total: data.total, issues: data.issues });
  }
);

// ─── TOOL: jira_get_sprints_from_board ───────────────────────────────────────

server.tool(
  'jira_get_sprints_from_board',
  'List sprints for a board.',
  {
    board_id: z.number().int().describe('Board ID'),
    state: z.enum(['active', 'closed', 'future']).optional().describe('Sprint state filter'),
  },
  async ({ board_id, state }) => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    const data = await jiraFetch(`/rest/agile/1.0/board/${board_id}/sprint?${params}`);
    return ok(data.values?.map(s => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate })));
  }
);

// ─── TOOL: jira_get_sprint_issues ────────────────────────────────────────────

server.tool(
  'jira_get_sprint_issues',
  'Get issues in a specific sprint.',
  {
    sprint_id: z.number().int().describe('Sprint ID from jira_get_sprints_from_board'),
    jql: z.string().optional().describe('Additional JQL filter'),
    max_results: z.number().int().min(1).max(100).optional().default(50),
  },
  async ({ sprint_id, jql, max_results }) => {
    const params = new URLSearchParams({ maxResults: max_results });
    if (jql) params.set('jql', jql);
    const data = await jiraFetch(`/rest/agile/1.0/sprint/${sprint_id}/issue?${params}`);
    return ok({ total: data.total, issues: data.issues });
  }
);

// ─── TOOL: jira_add_issues_to_sprint ─────────────────────────────────────────

server.tool(
  'jira_add_issues_to_sprint',
  'Move one or more issues into a sprint.',
  {
    sprint_id: z.number().int().describe('Target sprint ID'),
    issue_keys: z.array(z.string()).describe('Issue keys to add, e.g. ["SD-1", "SD-2"]'),
  },
  async ({ sprint_id, issue_keys }) => {
    await jiraFetch(`/rest/agile/1.0/sprint/${sprint_id}/issue`, {
      method: 'POST',
      body: JSON.stringify({ issues: issue_keys }),
    });
    return ok({ success: true, sprint_id, added: issue_keys });
  }
);

// ─── TOOL: jira_create_issue_link ────────────────────────────────────────────

server.tool(
  'jira_create_issue_link',
  'Create a link between two Jira issues (e.g. "blocks", "is blocked by", "relates to").',
  {
    link_type: z.string().describe('Link type name, e.g. "Blocks", "Relates", "Cloners"'),
    inward_issue_key: z.string().describe('The inward issue key'),
    outward_issue_key: z.string().describe('The outward issue key'),
    comment: z.string().optional().describe('Optional comment'),
  },
  async ({ link_type, inward_issue_key, outward_issue_key, comment }) => {
    const body = {
      type: { name: link_type },
      inwardIssue: { key: inward_issue_key },
      outwardIssue: { key: outward_issue_key },
    };
    if (comment) body.comment = { body: toADF(comment) };
    await jiraFetch('/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify(body) });
    return ok({ success: true, linked: `${inward_issue_key} <-> ${outward_issue_key}` });
  }
);

// ─── TOOL: jira_link_to_epic ─────────────────────────────────────────────────

server.tool(
  'jira_link_to_epic',
  'Set the parent epic for an issue using the epic link field (customfield_10014).',
  {
    issue_key: z.string().describe('Issue to update'),
    epic_key: z.string().describe('Epic issue key to link to'),
  },
  async ({ issue_key, epic_key }) => {
    await jiraFetch(`/rest/api/3/issue/${issue_key}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { customfield_10014: epic_key } }),
    });
    return ok({ success: true, issue_key, epic: epic_key });
  }
);

// ─── TOOL: jira_get_user_profile ─────────────────────────────────────────────

server.tool(
  'jira_get_user_profile',
  'Get the profile of the currently authenticated Jira user.',
  {},
  async () => {
    const data = await jiraFetch('/rest/api/3/myself');
    return ok(data);
  }
);

// ─── TOOL: jira_search_users ─────────────────────────────────────────────────

server.tool(
  'jira_search_users',
  'Find Jira users by name or email. Returns accountId + displayName for each match — use the accountId to @mention someone in jira_add_comment.',
  {
    query: z.string().describe('Name or email to search for, e.g. "Michael Ward" or "michael@..."'),
    max_results: z.number().int().min(1).max(50).optional().default(10).describe('Max users to return (default 10)'),
  },
  async ({ query, max_results }) => {
    const data = await jiraFetch(
      `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${max_results}`
    );
    return ok(
      (data || []).map(u => ({
        accountId: u.accountId,
        displayName: u.displayName,
        emailAddress: u.emailAddress,
        active: u.active,
      }))
    );
  }
);

// ─── TOOL: jira_move_issue ───────────────────────────────────────────────────

server.tool(
  'jira_move_issue',
  'Move a Jira issue to a different project using the Jira Cloud bulk move API. Returns the new issue key. Optionally links to an epic after the move.',
  {
    issue_key: z.string().describe('Issue key to move, e.g. LD-855'),
    target_project_key: z.string().describe('Target project key, e.g. SD'),
    target_issue_type: z.string().optional().describe('Issue type name in target project. Defaults to same type as source, falls back to Task.'),
    epic_key: z.string().optional().describe('If provided, links the moved issue to this epic after the move, e.g. SD-6997'),
    send_notification: z.boolean().optional().describe('Whether to send email notifications to watchers. Defaults to false.'),
  },
  async ({ issue_key, target_project_key, target_issue_type, epic_key, send_notification }) => {
    // Step 1: Get source issue details
    const source = await jiraFetch(`/rest/api/3/issue/${issue_key}?fields=summary,issuetype,project,status`);
    const sourceProjectKey = source.fields.project.key;
    const sourceTypeName = source.fields.issuetype.name;

    if (sourceProjectKey === target_project_key) {
      throw new Error(`Issue ${issue_key} is already in project ${target_project_key}.`);
    }

    // Step 2: Resolve target issue type ID from target project
    const targetProject = await jiraFetch(`/rest/api/3/project/${target_project_key}`);
    const issueTypes = targetProject.issueTypes || [];
    const resolvedTypeName = target_issue_type || sourceTypeName;
    let targetTypeId = issueTypes.find(t => t.name === resolvedTypeName)?.id;
    let usedTypeName = resolvedTypeName;
    if (!targetTypeId) {
      // Fall back to Task
      const taskType = issueTypes.find(t => t.name === 'Task');
      if (!taskType) throw new Error(`Issue type "${resolvedTypeName}" not found in project ${target_project_key}, and no Task type available either.`);
      targetTypeId = taskType.id;
      usedTypeName = 'Task';
    }

    // Step 3: Call Jira Cloud bulk move API
    const mappingKey = `${target_project_key},${targetTypeId}`;
    const moveResp = await jiraFetch('/rest/api/3/bulk/issues/move', {
      method: 'POST',
      body: JSON.stringify({
        sendBulkNotification: send_notification ?? false,
        targetToSourcesMapping: {
          [mappingKey]: {
            issueIdsOrKeys: [issue_key],
            inferClassificationDefaults: true,
            inferFieldDefaults: true,
            inferStatusDefaults: true,
            inferSubtaskTypeDefault: true,
          },
        },
      }),
    });

    const taskId = moveResp.taskId;
    if (!taskId) throw new Error(`Bulk move API did not return a taskId. Response: ${JSON.stringify(moveResp)}`);

    // Step 4: Poll until complete (2s interval, 60s timeout)
    const deadline = Date.now() + 60_000;
    let taskStatus;
    while (Date.now() < deadline) {
      await sleep(2000);
      taskStatus = await jiraFetch(`/rest/api/3/bulk/queue/${taskId}`);
      if (taskStatus.status === 'COMPLETE' || taskStatus.status === 'FAILED') break;
    }

    if (!taskStatus || taskStatus.status !== 'COMPLETE') {
      throw new Error(`Bulk move task ${taskId} ended with status: ${taskStatus?.status ?? 'TIMEOUT'} (${taskStatus?.progressPercent ?? 0}% complete). Check Jira for details.`);
    }

    // Step 5: Recover new issue key from the moved issue's numeric ID
    const movedIds = taskStatus.processedAccessibleIssues ?? [];
    let newKey = `(check ${target_project_key} for new key)`;
    if (movedIds.length > 0) {
      const movedIssue = await jiraFetch(`/rest/api/3/issue/${movedIds[0]}?fields=summary,project`).catch(() => null);
      if (movedIssue?.key) newKey = movedIssue.key;
    }

    // Step 6: Link to epic if requested
    if (epic_key && newKey !== `(check ${target_project_key} for new key)`) {
      await jiraFetch(`/rest/api/3/issue/${newKey}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: { parent: { key: epic_key } } }),
      }).catch(err => {
        // Non-fatal — move succeeded, epic link failed
        throw new Error(`Move succeeded (${newKey}) but epic link to ${epic_key} failed: ${err.message}`);
      });
    }

    return ok({
      success: true,
      original_key: issue_key,
      new_key: newKey,
      target_project: target_project_key,
      resolved_issue_type: usedTypeName,
      task_id: taskId,
      epic_linked: epic_key ?? null,
      summary: source.fields?.summary,
    });
  }
);

// ─── TOOL: jira_add_attachment ───────────────────────────────────────────────
// Ported from mcp-jira-attach.js

server.tool(
  'jira_add_attachment',
  'Upload a file as an attachment to a Jira issue.',
  {
    issue_key: z.string().describe('Issue key to attach file to'),
    file_path: z.string().describe('Absolute path to the file to upload'),
  },
  async ({ issue_key, file_path }) => {
    if (!existsSync(file_path)) throw new Error(`File not found: ${file_path}`);
    // Block sensitive system files and dotfiles
    const resolved = resolve(file_path);
    const blockedPatterns = [/[/\\]\.env$/i, /[/\\]\.git[/\\]/i, /[/\\]credentials/i, /[/\\]\.ssh[/\\]/i, /[/\\]etc[/\\]/i, /[/\\]Windows[/\\]System/i];
    if (blockedPatterns.some(p => p.test(resolved))) {
      throw new Error(`Blocked: uploading '${basename(resolved)}' is not allowed for security reasons`);
    }
    const { FormData, Blob } = await import('buffer').then(() => globalThis);
    // Node 18+ has FormData globally; fallback to manual multipart
    const fileBuffer = readFileSync(file_path);
    const fileName = basename(file_path);
    const boundary = `----FormBoundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = `${JIRA_URL}/rest/api/3/issue/${issue_key}/attachments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'X-Atlassian-Token': 'no-check',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Jira API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return ok(data);
  }
);

// ─── START ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`Jira MCP error: ${err.message}\n`);
  process.exit(1);
});
