import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from this folder (SLACK_BOT_TOKEN)
const dotenv = await import('dotenv');
dotenv.config({ path: join(__dirname, '.env') });

// The bot posts as this display name by default. Posting without it makes messages
// show as the Slack app’s own name — the #1 recurring Slack mistake, so we default it
// in code here rather than relying on the caller to remember (configure it in .env).
const DEFAULT_USERNAME = process.env.SLACK_DEFAULT_USERNAME || '';
const DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || '';

function getClient() {
  const { SLACK_BOT_TOKEN } = process.env;
  if (!SLACK_BOT_TOKEN) {
    throw new Error('Missing SLACK_BOT_TOKEN in slack-mcp/.env');
  }
  return new WebClient(SLACK_BOT_TOKEN);
}

// Resolve a channel name (#name / name) to a channel ID. IDs (C…/G…/D…) pass through.
// Cached per process so repeated calls don't re-list.
let channelCache = null;
async function resolveChannel(client, channel) {
  if (!channel) throw new Error('channel is required');
  const trimmed = channel.trim().replace(/^#/, '');
  if (/^[CGD][A-Z0-9]{6,}$/.test(channel.trim())) return channel.trim();
  if (!channelCache) {
    channelCache = new Map();
    let cursor;
    do {
      const res = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
        cursor,
      });
      for (const c of res.channels || []) channelCache.set(c.name, c.id);
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }
  const id = channelCache.get(trimmed);
  if (!id) throw new Error(`Channel "${channel}" not found (bot may not be a member, or the name is wrong).`);
  return id;
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function apiError(err) {
  const detail = err?.data ? JSON.stringify(err.data) : (err?.message || String(err));
  return new Error(`Slack API error: ${detail}`);
}

const server = new McpServer({ name: 'slack-mcp', version: '1.0.0' });

// ---- post_message ---------------------------------------------------------
server.registerTool('slack_post_message', {
  description: 'Post a message to a Slack channel. Posts under the display name set in SLACK_DEFAULT_USERNAME unless overridden. Pass thread_ts to reply in a thread. Keep the main message short (~5 lines); put detail in a thread reply by re-calling with thread_ts set to the returned ts. text is Slack mrkdwn (use <url|label> links, *bold*, not HTML).',
  inputSchema: {
    channel: z.string().optional().describe('Channel ID (C\u2026/G\u2026) or name (#general or general). Falls back to SLACK_DEFAULT_CHANNEL if omitted.'),
    text: z.string().min(1).describe('Message text in Slack mrkdwn.'),
    thread_ts: z.string().optional().describe('If set, post as a reply in this thread (the ts of the parent message).'),
    username: z.string().optional().describe('Override the display name. Defaults to SLACK_DEFAULT_USERNAME.'),
    unfurl_links: z.boolean().optional().describe('Whether to unfurl links (default Slack behavior if omitted).'),
  },
}, async ({ channel, text, thread_ts, username, unfurl_links }) => {
  const client = getClient();
  try {
    const channelId = await resolveChannel(client, channel || DEFAULT_CHANNEL);
    const res = await client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts,
      username: username || DEFAULT_USERNAME,
      ...(unfurl_links !== undefined ? { unfurl_links } : {}),
    });
    return ok(`Posted to ${channel} (${channelId}).\nts: ${res.ts}${thread_ts ? `\nthread: ${thread_ts}` : ''}\nUse this ts with slack_update_message to edit, or as thread_ts to reply.`);
  } catch (err) {
    throw apiError(err);
  }
});

// ---- update_message (fix-in-place) ---------------------------------------
server.registerTool('slack_update_message', {
  description: 'Edit an existing message in place via chat.update (the preferred fix — never delete-and-repost). Needs the channel and the message ts returned when it was posted.',
  inputSchema: {
    channel: z.string().optional().describe('Channel ID or name where the message lives.'),
    ts: z.string().describe('Timestamp (ts) of the message to edit.'),
    text: z.string().min(1).describe('New message text (Slack mrkdwn). Replaces the whole message.'),
  },
}, async ({ channel, ts, text }) => {
  const client = getClient();
  try {
    const channelId = await resolveChannel(client, channel || DEFAULT_CHANNEL);
    const res = await client.chat.update({ channel: channelId, ts, text });
    return ok(`Updated message ${res.ts} in ${channel} (${channelId}).`);
  } catch (err) {
    throw apiError(err);
  }
});

// ---- read_channel ---------------------------------------------------------
server.registerTool('slack_read_channel', {
  description: 'Read recent messages from a channel (conversations.history). Returns newest-first with each message ts so you can reply/update.',
  inputSchema: {
    channel: z.string().optional().describe('Channel ID or name to read.'),
    limit: z.number().int().min(1).max(200).default(20).describe('How many recent messages (1-200, default 20).'),
  },
}, async ({ channel, limit }) => {
  const client = getClient();
  try {
    const channelId = await resolveChannel(client, channel || DEFAULT_CHANNEL);
    const res = await client.conversations.history({ channel: channelId, limit });
    const msgs = res.messages || [];
    if (!msgs.length) return ok('No messages found.');
    // reply_count MUST be surfaced: without it a parent carrying threaded replies renders
    // identically to one with none, which silently hides whole conversations from the reader.
    const lines = msgs.map(m => `[ts ${m.ts}]${m.thread_ts && m.thread_ts !== m.ts ? ' (reply)' : ''}${m.reply_count ? ` [thread: ${m.reply_count} replies, use slack_read_thread with thread_ts ${m.ts}]` : ''} ${m.user || m.username || m.bot_id || '?'}: ${m.text || ''}`);
    return ok(lines.join('\n\n'));
  } catch (err) {
    throw apiError(err);
  }
});

// ---- read_thread ----------------------------------------------------------
server.registerTool('slack_read_thread', {
  description: 'Read all replies in a thread (conversations.replies). Pass the parent message ts as thread_ts; slack_read_channel marks parents that have replies.',
  inputSchema: {
    channel: z.string().optional().describe('Channel ID or name containing the thread.'),
    thread_ts: z.string().describe('ts of the thread parent message (from slack_read_channel).'),
    limit: z.number().int().min(1).max(200).default(100).describe('Max messages to return (1-200, default 100).'),
  },
}, async ({ channel, thread_ts, limit }) => {
  const client = getClient();
  try {
    const channelId = await resolveChannel(client, channel || DEFAULT_CHANNEL);
    const res = await client.conversations.replies({ channel: channelId, ts: thread_ts, limit });
    const msgs = res.messages || [];
    if (!msgs.length) return ok('No messages found in thread.');
    // conversations.replies returns the parent as the first element, not a reply.
    const lines = msgs.map((m, i) => `[ts ${m.ts}] ${i === 0 ? '(parent)' : '(reply)'} ${m.user || m.username || m.bot_id || '?'}: ${m.text || ''}`);
    const summary = `Thread ${thread_ts} in ${channel}: ${msgs.length - 1} repl${msgs.length - 1 === 1 ? 'y' : 'ies'} (parent shown first).`;
    return ok(summary + '\n\n' + lines.join('\n\n'));
  } catch (err) {
    throw apiError(err);
  }
});

// ---- list_channels --------------------------------------------------------
server.registerTool('slack_list_channels', {
  description: 'List channels in the workspace (conversations.list). Handy to find a channel ID by name.',
  inputSchema: {
    types: z.string().default('public_channel,private_channel').describe('Comma-separated: public_channel,private_channel,mpim,im.'),
    limit: z.number().int().min(1).max(1000).default(200).describe('Max channels to return (default 200).'),
  },
}, async ({ types, limit }) => {
  const client = getClient();
  try {
    const res = await client.conversations.list({ types, exclude_archived: true, limit });
    const chans = (res.channels || []).map(c => `${c.name || c.id}\t${c.id}${c.is_private ? '\t(private)' : ''}${c.is_member ? '\t[member]' : ''}`);
    if (!chans.length) return ok('No channels found.');
    return ok(`name\tid\n${chans.join('\n')}`);
  } catch (err) {
    throw apiError(err);
  }
});

// ---- add_reaction ---------------------------------------------------------
server.registerTool('slack_add_reaction', {
  description: 'Add an emoji reaction to a message.',
  inputSchema: {
    channel: z.string().optional().describe('Channel ID or name where the message lives.'),
    timestamp: z.string().describe('ts of the message to react to.'),
    name: z.string().describe('Emoji name WITHOUT colons (e.g. white_check_mark, eyes, thumbsup).'),
  },
}, async ({ channel, timestamp, name }) => {
  const client = getClient();
  try {
    const channelId = await resolveChannel(client, channel || DEFAULT_CHANNEL);
    await client.reactions.add({ channel: channelId, timestamp, name: name.replace(/:/g, '') });
    return ok(`Added :${name.replace(/:/g, '')}: to message ${timestamp} in ${channel}.`);
  } catch (err) {
    throw apiError(err);
  }
});

// ---- upload_file ----------------------------------------------------------
server.registerTool('slack_upload_file', {
  description: 'Upload a local file to a channel (files.uploadV2), e.g. a screenshot. Note: file uploads always post under the bot app identity — the username override does NOT apply to uploads (Slack limitation).',
  inputSchema: {
    channel: z.string().optional().describe('Channel ID or name to share the file into.'),
    file_path: z.string().describe('Absolute path to the local file to upload.'),
    title: z.string().optional().describe('Optional file title shown in Slack.'),
    initial_comment: z.string().optional().describe('Optional message posted with the file (Slack mrkdwn).'),
    thread_ts: z.string().optional().describe('Optional thread ts to attach the file to a thread.'),
  },
}, async ({ channel, file_path, title, initial_comment, thread_ts }) => {
  const client = getClient();
  try {
    const channelId = await resolveChannel(client, channel || DEFAULT_CHANNEL);
    const fileBuffer = readFileSync(file_path);
    const res = await client.files.uploadV2({
      channel_id: channelId,
      file: fileBuffer,
      filename: basename(file_path),
      title: title || basename(file_path),
      initial_comment,
      thread_ts,
    });
    const f = res.files?.[0]?.files?.[0] || res.file;
    return ok(`Uploaded ${basename(file_path)} to ${channel} (${channelId}).${f?.permalink ? `\n${f.permalink}` : ''}`);
  } catch (err) {
    throw apiError(err);
  }
});

// ---- get_file -------------------------------------------------------------
server.registerTool('slack_get_file', {
  description: 'Fetch the content of a Slack-hosted file by file ID or Slack file URL (files.info + authenticated download of url_private_download). Requires the files:read scope AND the bot being a member of the channel the file was shared in — otherwise Slack returns file_not_found. Text files are returned inline; binary files return metadata and the download URL only.',
  inputSchema: {
    file: z.string().describe('File ID (F…) or a Slack file permalink such as https://<workspace>.slack.com/files/U…/F…/name.md'),
    max_bytes: z.number().int().min(1).max(2000000).default(500000).describe('Max bytes of text content to return (default 500000).'),
  },
}, async ({ file, max_bytes }) => {
  const { SLACK_BOT_TOKEN } = process.env;
  const client = getClient();
  const match = file.trim().match(/\b(F[A-Z0-9]{6,})\b/);
  if (!match) throw new Error(`Could not extract a Slack file ID (F…) from "${file}".`);
  const fileId = match[1];
  try {
    const info = await client.files.info({ file: fileId });
    const f = info.file || {};
    const meta = `name: ${f.name || '?'}\nid: ${fileId}\ntype: ${f.filetype || '?'} (${f.mimetype || '?'})\nsize: ${f.size ?? '?'} bytes\nuser: ${f.user || '?'}\nchannels: ${[...(f.channels || []), ...(f.groups || []), ...(f.ims || [])].join(', ') || 'none visible to bot'}`;
    const url = f.url_private_download || f.url_private;
    if (!url) return ok(`${meta}\n\n(No download URL on this file.)`);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    const contentType = res.headers.get('content-type') || '';
    // Slack answers an unauthenticated/redirected fetch with an HTML login page at HTTP 200,
    // so the content type is the real success check, not res.ok.
    if (contentType.includes('text/html') && !(f.filetype || '').match(/html/i)) {
      throw new Error(`Download returned an HTML page instead of file content (likely an auth redirect). ${meta}`);
    }
    // Slack serves .md and similar as application/force-download, so content-type alone
    // is not a reliable text signal. Fall back to the filetype/extension, then to a
    // NUL-byte sniff of the actual bytes.
    const TEXT_TYPES = /^(md|markdown|text|plain|csv|tsv|json|yaml|yml|js|jsx|ts|tsx|py|java|sql|log|html|xml|css|sh|ps1|toml|ini|env|diff|patch)$/i;
    const looksTextByType = contentType.startsWith('text/')
      || contentType.includes('json')
      || contentType.includes('javascript')
      || contentType.includes('xml')
      || TEXT_TYPES.test(f.filetype || '')
      || TEXT_TYPES.test((f.name || '').split('.').pop() || '');

    const buf = Buffer.from(await res.arrayBuffer());
    const sample = buf.subarray(0, 8000);
    const hasNul = sample.includes(0);
    if (!looksTextByType && hasNul) {
      return ok(`${meta}\n\n(Binary file, content not returned. content-type: ${contentType})`);
    }
    let truncated = '';
    let bytes = buf;
    if (bytes.length > max_bytes) {
      bytes = bytes.subarray(0, max_bytes);
      truncated = `\n\n[truncated at ${max_bytes} bytes of ${buf.length}]`;
    }
    // toString('utf8') replaces any partial trailing char from the slice, no crash.
    const body = bytes.toString('utf8');
    return ok(`${meta}\n\n----- content -----\n${body}${truncated}`);
  } catch (err) {
    throw apiError(err);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
