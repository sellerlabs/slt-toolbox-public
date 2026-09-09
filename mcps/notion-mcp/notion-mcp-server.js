import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// Pure data-shaping helpers (flattening + write-direction property building)
// live in normalizer.js so they can be unit tested without booting a transport.
// The flattener is the reason this server exists: see notion-mcp-Context.md.
import {
  richTextToPlain,
  flattenProperty,
  flattenPage,
  buildProperty,
  flattenBlock,
} from './normalizer.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from this folder (NOTION_TOKEN)
const dotenv = await import('dotenv');
dotenv.config({ path: join(__dirname, '.env') });

const NOTION_API = 'https://api.notion.com/v1';

// Pinned API version. Notion requires this header on every request; omitting it
// is an error, and letting it float means a Notion release can silently change
// response shapes under us. 2022-06-28 is the stable long-lived version whose
// database-query shape this server is written against. Version 2025-09-03
// renames databases/query to data sources, which would require rewriting
// queryDatabase and the property normalizer, so bump deliberately, not casually.
const NOTION_VERSION = '2022-06-28';

// ---------------------------------------------------------------------------
// Rate limiting
//
// Notion allows roughly 3 requests/second average per integration, among the
// tightest limits in SaaS, and answers a breach with 429 + code rate_limited.
// Rather than hope callers behave, every request funnels through this queue,
// which spaces calls ~350ms apart (under 3/s with headroom) and retries a 429
// using the Retry-After header. Pagination is the usual way to blow the budget:
// 1000 rows at 100/page is 10 requests before any real work happens.
// ---------------------------------------------------------------------------
const MIN_REQUEST_GAP_MS = 350;
const MAX_RETRIES = 3;
let lastRequestAt = 0;
let requestChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serialize requests through a promise chain so concurrent tool calls still
// respect a single global spacing window.
function schedule(fn) {
  const run = requestChain.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call rejects.
  requestChain = run.then(() => {}, () => {});
  return run;
}

function getToken() {
  const { NOTION_TOKEN } = process.env;
  if (!NOTION_TOKEN) {
    throw new Error(
      'Missing NOTION_TOKEN in notion-mcp/.env. Create an internal integration at https://www.notion.so/profile/integrations, then share at least one page with it.'
    );
  }
  return NOTION_TOKEN;
}

async function notionRequest(method, path, body, attempt = 0) {
  const res = await schedule(() =>
    fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 1;
    await sleep(retryAfter * 1000);
    return notionRequest(method, path, body, attempt + 1);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Notion returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    // The single most common Notion failure: the token is fine, but the object
    // was never shared with the integration, and Notion reports that as 404
    // rather than 403. Say so explicitly so nobody goes hunting for a bad ID.
    if (res.status === 404) {
      throw new Error(
        `Notion 404 for ${method} ${path}. In Notion this almost always means the page or database has NOT been shared with this integration, not that the ID is wrong. Fix it in the Notion UI: open the page, ... menu, Connections, add the integration. Raw: ${json.message || text}`
      );
    }
    if (res.status === 401) {
      throw new Error(
        `Notion 401 unauthorized: the NOTION_TOKEN in notion-mcp/.env is invalid or revoked. Raw: ${json.message || text}`
      );
    }
    throw new Error(`Notion API error ${res.status} (${json.code || 'unknown'}): ${json.message || text}`);
  }

  return json;
}

// Schema cache. Every write needs the property types, and re-fetching the
// schema per write would eat a third of the 3 req/s budget for no new
// information. Schemas change rarely; cache for the process lifetime.
const schemaCache = new Map();
async function getDatabaseSchema(databaseId) {
  if (schemaCache.has(databaseId)) return schemaCache.get(databaseId);
  const db = await notionRequest('GET', `/databases/${databaseId}`);
  const schema = {};
  for (const [name, prop] of Object.entries(db.properties || {})) {
    schema[name] = prop.type;
  }
  const entry = { title: richTextToPlain(db.title), schema };
  schemaCache.set(databaseId, entry);
  return entry;
}

async function propertiesFromPlain(databaseId, plain) {
  const { schema } = await getDatabaseSchema(databaseId);
  const out = {};
  for (const [name, value] of Object.entries(plain)) {
    const type = schema[name];
    if (!type) {
      throw new Error(
        `Property "${name}" does not exist in that database. Known properties: ${Object.keys(schema).join(', ')}`
      );
    }
    out[name] = buildProperty(type, value);
  }
  return out;
}

function ok(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(err) {
  return { content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'notion-mcp', version: '1.0.0' });

server.registerTool(
  'notion_whoami',
  {
    description:
      'Verify the Notion token works and show which bot/integration it belongs to (GET /v1/users/me). Run this first when anything looks broken: it separates a bad token (401) from an unshared page (404 on other calls).',
    inputSchema: {},
  },
  async () => {
    try {
      const me = await notionRequest('GET', '/users/me');
      return ok({
        id: me.id,
        name: me.name,
        type: me.type,
        workspace_name: me.bot?.workspace_name,
        notion_version: NOTION_VERSION,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_search',
  {
    description:
      'Search pages and databases shared with this integration. Note that search only ever sees objects explicitly shared with the integration, so empty results usually mean nothing was shared, not that nothing matches. Returns id, title, type and url.',
    inputSchema: {
      query: z.string().optional().describe('Text to search for in titles. Omit to list everything shared with the integration.'),
      filter: z.enum(['page', 'database']).optional().describe('Restrict results to pages or databases only.'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max results (1-100, default 25).'),
    },
  },
  async ({ query, filter, limit }) => {
    try {
      const body = { page_size: limit };
      if (query) body.query = query;
      if (filter) body.filter = { property: 'object', value: filter };
      const res = await notionRequest('POST', '/search', body);
      const results = (res.results || []).map((r) => {
        let title = '';
        if (r.object === 'database') {
          title = richTextToPlain(r.title);
        } else {
          const titleProp = Object.values(r.properties || {}).find((p) => p.type === 'title');
          title = titleProp ? richTextToPlain(titleProp.title) : '';
        }
        return { id: r.id, object: r.object, title, url: r.url, last_edited_time: r.last_edited_time };
      });
      return ok({ count: results.length, has_more: res.has_more === true, results });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_get_database',
  {
    description:
      'Get a database schema: its title and the name plus type of every property. Read this before querying or writing, so filters and property names are correct rather than guessed. The schema is cached per process.',
    inputSchema: {
      database_id: z.string().describe('Database ID (with or without dashes).'),
    },
  },
  async ({ database_id }) => {
    try {
      const { title, schema } = await getDatabaseSchema(database_id);
      return ok({ database_id, title, properties: schema });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_query_database',
  {
    description:
      'Query a database (POST /v1/databases/{id}/query, filters go in the body, not the query string). Returns rows with FLATTENED properties, so a title comes back as { Name: "Acme" } instead of properties.Name.title[0].text.content. Pass a raw Notion filter/sorts object if you need one; call notion_get_database first to get exact property names.',
    inputSchema: {
      database_id: z.string().describe('Database ID (with or without dashes).'),
      filter: z.record(z.any()).optional().describe('Raw Notion filter object, e.g. {"property":"Status","status":{"equals":"Done"}}.'),
      sorts: z.array(z.record(z.any())).optional().describe('Raw Notion sorts array, e.g. [{"property":"Name","direction":"ascending"}].'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Rows per page (1-100, default 25). Notion charges a request per page against a ~3 req/s limit, so prefer a high value over many small pages.'),
      start_cursor: z.string().optional().describe('Cursor from a previous call to fetch the next page.'),
    },
  },
  async ({ database_id, filter, sorts, limit, start_cursor }) => {
    try {
      const body = { page_size: limit };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (start_cursor) body.start_cursor = start_cursor;
      const res = await notionRequest('POST', `/databases/${database_id}/query`, body);
      return ok({
        count: (res.results || []).length,
        has_more: res.has_more === true,
        next_cursor: res.next_cursor || undefined,
        rows: (res.results || []).map(flattenPage),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_get_page',
  {
    description:
      'Get one page with its properties FLATTENED to plain values. Use notion_get_blocks for the page body content, which lives in blocks rather than properties.',
    inputSchema: {
      page_id: z.string().describe('Page ID (with or without dashes).'),
    },
  },
  async ({ page_id }) => {
    try {
      const page = await notionRequest('GET', `/pages/${page_id}`);
      return ok(flattenPage(page));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_create_page',
  {
    description:
      'Create a page as a row in a database. Pass properties as PLAIN values, e.g. {"Name":"Acme","Status":"Active","Tags":["a","b"]}; the server looks up the database schema and converts them to Notion property objects. Optionally pass content as an array of plain-text paragraphs for the page body.',
    inputSchema: {
      database_id: z.string().describe('Parent database ID.'),
      properties: z.record(z.any()).describe('Plain key/value properties. Names must match the database schema exactly (see notion_get_database).'),
      content: z.array(z.string()).optional().describe('Optional page body as plain-text paragraphs, one string per paragraph.'),
    },
  },
  async ({ database_id, properties, content }) => {
    try {
      const body = {
        parent: { database_id },
        properties: await propertiesFromPlain(database_id, properties),
      };
      if (content?.length) {
        body.children = content.map((text) => ({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
        }));
      }
      const page = await notionRequest('POST', '/pages', body);
      return ok({ created: true, ...flattenPage(page) });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_update_page',
  {
    description:
      'Update properties on an existing database page, passing PLAIN values the same way notion_create_page does. Only the properties you pass are changed. Set archived to true to move the page to trash.',
    inputSchema: {
      page_id: z.string().describe('Page ID to update.'),
      properties: z.record(z.any()).optional().describe('Plain key/value properties to change.'),
      archived: z.boolean().optional().describe('True archives (trashes) the page, false restores it.'),
    },
  },
  async ({ page_id, properties, archived }) => {
    try {
      const body = {};
      if (properties && Object.keys(properties).length) {
        // Need the parent database's schema to type the values, so read the page first.
        const page = await notionRequest('GET', `/pages/${page_id}`);
        const databaseId = page.parent?.database_id;
        if (!databaseId) {
          throw new Error(
            'This page is not a database row, so its properties cannot be set by name. Only database pages have typed properties.'
          );
        }
        body.properties = await propertiesFromPlain(databaseId, properties);
      }
      if (archived !== undefined) body.archived = archived;
      if (!Object.keys(body).length) throw new Error('Nothing to update: pass properties and/or archived.');
      const updated = await notionRequest('PATCH', `/pages/${page_id}`, body);
      return ok({ updated: true, ...flattenPage(updated) });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'notion_get_blocks',
  {
    description:
      'Get a page body as a flat list of blocks rendered to readable text (headings as #, list items as -, to-dos as [x]). Notion nests blocks recursively; set depth above 0 to follow children, at the cost of one request per parent block against a ~3 req/s limit.',
    inputSchema: {
      block_id: z.string().describe('Page ID or block ID whose children to read.'),
      limit: z.number().int().min(1).max(100).default(50).describe('Max blocks per level (1-100, default 50).'),
      depth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(0)
        .describe('How many levels of nested children to follow (0-3, default 0). Each nested parent costs an extra request.'),
    },
  },
  async ({ block_id, limit, depth }) => {
    try {
      async function fetchChildren(id, remaining) {
        const res = await notionRequest('GET', `/blocks/${id}/children?page_size=${limit}`);
        const blocks = (res.results || []).map(flattenBlock);
        if (remaining > 0) {
          for (const b of blocks) {
            if (b.has_children) b.children = await fetchChildren(b.id, remaining - 1);
          }
        }
        return blocks;
      }
      const blocks = await fetchChildren(block_id, depth);
      return ok({ count: blocks.length, blocks });
    } catch (err) {
      return fail(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
