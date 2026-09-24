import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute, extname } from 'path';
import { writeFile, mkdir, readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from same directory as this file
const dotenv = await import('dotenv');
dotenv.config({ path: join(__dirname, '.env') });

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o';
const MAX_PANEL = Number(process.env.OPENROUTER_MAX_PANEL || 4);

// Models used by openrouter_panel when the caller does not name any.
const DEFAULT_PANEL = ['openai/gpt-4o', 'google/gemini-2.5-pro', 'anthropic/claude-sonnet-4.5'];

// OpenRouter uses these two optional headers for attribution on its public
// leaderboards. Sent only when configured in .env.
const ATTRIBUTION = {
  ...(process.env.OPENROUTER_SITE_URL && { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL }),
  ...(process.env.OPENROUTER_SITE_NAME && { 'X-Title': process.env.OPENROUTER_SITE_NAME }),
};

function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'Missing OPENROUTER_API_KEY in .env. Add it to openrouter-mcp/.env (get a key at https://openrouter.ai/keys).'
    );
  }
  return key;
}

// Shared fetch wrapper. Distinguishes network failure from an HTTP error and
// always surfaces the response body so the caller sees what OpenRouter said.
async function orFetch(path, init = {}) {
  const key = getApiKey();
  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...ATTRIBUTION,
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    throw new Error(`Network error calling OpenRouter: ${err?.message || String(err)}`);
  }

  if (!resp.ok) {
    let detail;
    try {
      detail = JSON.stringify(await resp.json());
    } catch {
      detail = await resp.text().catch(() => '');
    }
    // 402 is the one users hit constantly, so name the fix.
    const hint = resp.status === 402
      ? ' Load credit at https://openrouter.ai/credits, or use a model whose id ends in :free.'
      : '';
    throw new Error(`OpenRouter API error (HTTP ${resp.status}): ${detail}${hint}`);
  }

  return resp.json();
}

function fmtUsage(data, requestedModel) {
  const u = data.usage;
  if (!u) return '';
  const cost = typeof u.cost === 'number' ? ` | cost: $${u.cost.toFixed(6)}` : '';
  return `\n\n[model: ${data.model || requestedModel} | tokens: ${u.prompt_tokens}+${u.completion_tokens}=${u.total_tokens}${cost}]`;
}

// Reasoning models spend completion tokens on hidden reasoning. If max_tokens is
// too low the visible content comes back empty with finish_reason "length".
function extractText(data) {
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (text) return text;
  if (choice?.finish_reason === 'length') {
    const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
    return `(no visible output: the token budget was consumed${reasoning ? ` by ${reasoning} reasoning tokens` : ''}. Retry with a higher max_tokens.)`;
  }
  return '(empty response)';
}

async function chatCompletion(body) {
  // usage.include makes OpenRouter return the per-call cost alongside tokens.
  const data = await orFetch('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ ...body, usage: { include: true } }),
  });
  return { text: extractText(data), usage: fmtUsage(data, body.model), raw: data };
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}


// Vision input. OpenRouter takes images as content parts on the user message.
// Remote https:// urls pass straight through; local files are read and inlined
// as data: URIs, since OpenRouter cannot reach this machine's disk.
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

async function toImagePart(ref) {
  if (/^https?:\/\//i.test(ref) || ref.startsWith('data:')) {
    return { type: 'image_url', image_url: { url: ref } };
  }
  const abs = isAbsolute(ref) ? ref : resolve(process.cwd(), ref);
  const ext = extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new Error(
      `Unsupported image type "${ext || abs}". Supported: ${Object.keys(IMAGE_MIME).join(', ')}.`
    );
  }
  let buf;
  try {
    buf = await readFile(abs);
  } catch (err) {
    throw new Error(`Cannot read image "${abs}": ${err?.message || String(err)}`);
  }
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } };
}

// Builds the user message: plain string when there are no images, otherwise the
// content-parts array (text first, then each image in the order given).
async function buildUserContent(prompt, images) {
  if (!images || images.length === 0) return prompt;
  const parts = [{ type: 'text', text: prompt }];
  for (const ref of images) parts.push(await toImagePart(ref));
  return parts;
}

const server = new McpServer({
  name: 'openrouter-mcp',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// openrouter_chat, ask any model on OpenRouter
// ---------------------------------------------------------------------------
server.registerTool('openrouter_chat', {
  description:
    'Ask any model available on OpenRouter (GPT, Gemini, Llama, Mistral, DeepSeek, Qwen, and ~400 more) ' +
    'a question or give it a task. Use this for a second opinion from a non-Claude model, or to reach a ' +
    'vendor that has no dedicated MCP here. Pass `images` (local paths or URLs) to send pictures to a ' +
    'vision model for OCR, description, or analysis. Does NOT search the live web. ' +
    `Defaults to model ${DEFAULT_MODEL}. Use openrouter_list_models to find model ids and prices.`,
  inputSchema: {
    prompt: z.string().min(1).describe('The user prompt / question'),
    system: z.string().optional().describe('Optional system prompt to steer the model'),
    model: z.string().optional()
      .describe(`OpenRouter model id (default ${DEFAULT_MODEL}), e.g. google/gemini-2.5-pro, meta-llama/llama-3.3-70b-instruct`),
    temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2)'),
    max_tokens: z.number().int().positive().optional()
      .describe('Max completion tokens. Reasoning models need headroom (1000+) or they return no visible text.'),
    images: z.array(z.string().min(1)).optional()
      .describe('Images to send with the prompt: local file paths (jpg/jpeg/png/gif/webp, read and inlined) or https:// URLs. Requires a vision-capable model such as google/gemini-2.5-pro or openai/gpt-4o.'),
  },
}, async ({ prompt, system, model, temperature, max_tokens, images }) => {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: await buildUserContent(prompt, images) });

  const body = { model: model || DEFAULT_MODEL, messages };
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  const { text, usage } = await chatCompletion(body);
  return textResult(text + usage);
});

// ---------------------------------------------------------------------------
// openrouter_list_models, browse the priced catalog
// ---------------------------------------------------------------------------
server.registerTool('openrouter_list_models', {
  description:
    'List or search the OpenRouter model catalog with context window and price per million tokens. ' +
    'Use this to compare model costs before picking one, or to find the exact id for a model. ' +
    'Filtering is done client-side over the full catalog.',
  inputSchema: {
    search: z.string().optional()
      .describe('Case-insensitive substring to match against model id or name, e.g. "gemini", "llama", "deepseek"'),
    free_only: z.boolean().optional().describe('Only return models that cost nothing (id ends in :free)'),
    sort: z.enum(['price_asc', 'price_desc', 'context_desc', 'name']).optional()
      .describe('Order: price_asc (default, cheapest first), price_desc (most expensive, a rough proxy for frontier models), context_desc (biggest context window), name (alphabetical)'),
    limit: z.number().int().positive().max(100).optional().describe('Max models to return (default 20)'),
  },
}, async ({ search, free_only, sort, limit }) => {
  const data = await orFetch('/models');
  let models = data.data || [];

  if (free_only) models = models.filter((m) => m.id.endsWith(':free'));
  if (search) {
    const q = search.toLowerCase();
    models = models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)
    );
  }

  const total = models.length;
  if (!total) return textResult(`No models matched${search ? ` "${search}"` : ''}.`);

  const order = sort || 'price_asc';
  const price = (m) => Number(m.pricing?.prompt || 0);
  if (order === 'price_desc') models.sort((a, b) => price(b) - price(a));
  else if (order === 'context_desc') models.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  else if (order === 'name') models.sort((a, b) => a.id.localeCompare(b.id));
  else models.sort((a, b) => price(a) - price(b));

  const ORDER_LABEL = {
    price_asc: 'cheapest first',
    price_desc: 'most expensive first',
    context_desc: 'largest context first',
    name: 'alphabetical',
  };

  const cap = limit || 20;
  const shown = models.slice(0, cap);

  const perM = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '?';
    if (n === 0) return 'free';
    return `$${(n * 1_000_000).toFixed(2)}`;
  };

  const lines = shown.map((m) => {
    const ctx = m.context_length ? `${(m.context_length / 1000).toFixed(0)}k ctx` : 'ctx ?';
    return `- ${m.id}\n    ${ctx} | in ${perM(m.pricing?.prompt)}/M | out ${perM(m.pricing?.completion)}/M`;
  });

  const header = `${total} model(s) matched${search ? ` "${search}"` : ''}${free_only ? ' (free only)' : ''}, showing ${shown.length} ${ORDER_LABEL[order]}:`;
  const footer = total > shown.length ? `\n\n(${total - shown.length} more not shown, raise limit to see them)` : '';
  return textResult(`${header}\n\n${lines.join('\n')}${footer}`);
});

// ---------------------------------------------------------------------------
// openrouter_usage, credit balance and spend
// ---------------------------------------------------------------------------
server.registerTool('openrouter_usage', {
  description:
    'Show the OpenRouter credit balance and spend for this API key: total credits purchased, total used, ' +
    'remaining, and this key\'s daily / weekly / monthly usage. Read-only.',
  inputSchema: {},
}, async () => {
  const [credits, keyInfo] = await Promise.all([orFetch('/credits'), orFetch('/key')]);
  const c = credits.data || {};
  const k = keyInfo.data || {};

  const purchased = Number(c.total_credits || 0);
  const used = Number(c.total_usage || 0);
  const remaining = purchased - used;

  const lines = [
    'OpenRouter account credits:',
    `- purchased: $${purchased.toFixed(4)}`,
    `- used: $${used.toFixed(4)}`,
    `- remaining: $${remaining.toFixed(4)}`,
    '',
    'This API key:',
    `- label: ${k.label || '?'}`,
    `- tier: ${k.is_free_tier ? 'free (no credit loaded, only :free models will run)' : 'paid'}`,
    `- usage total: $${Number(k.usage || 0).toFixed(4)}`,
    `- usage today / week / month: $${Number(k.usage_daily || 0).toFixed(4)} / $${Number(k.usage_weekly || 0).toFixed(4)} / $${Number(k.usage_monthly || 0).toFixed(4)}`,
    `- spend limit: ${k.limit === null || k.limit === undefined ? 'none set' : `$${Number(k.limit).toFixed(2)}`}`,
  ];

  if (remaining <= 0) {
    lines.push('', 'No credit remaining. Paid models will return HTTP 402. Load credit at https://openrouter.ai/credits or use :free models.');
  }

  return textResult(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// openrouter_panel, one prompt to several models at once
// ---------------------------------------------------------------------------
server.registerTool('openrouter_panel', {
  description:
    'Send ONE prompt to several models in parallel and return their answers side by side. ' +
    'Use for consensus or to diff how models disagree on a judgement call. ' +
    `Costs one call per model, so it is capped at ${MAX_PANEL} models (set OPENROUTER_MAX_PANEL to change).`,
  inputSchema: {
    prompt: z.string().min(1).describe('The prompt to send to every model'),
    models: z.array(z.string()).optional()
      .describe(`Model ids to poll (default: ${DEFAULT_PANEL.join(', ')}). Max ${MAX_PANEL}.`),
    system: z.string().optional().describe('Optional system prompt applied to every model'),
    max_tokens: z.number().int().positive().optional().describe('Max completion tokens per model'),
  },
}, async ({ prompt, models, system, max_tokens }) => {
  const picked = models && models.length ? models : DEFAULT_PANEL;

  if (picked.length > MAX_PANEL) {
    throw new Error(
      `Panel capped at ${MAX_PANEL} models, got ${picked.length}. ` +
      'Drop some models, or raise OPENROUTER_MAX_PANEL in openrouter-mcp/.env.'
    );
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const results = await Promise.allSettled(
    picked.map((m) => {
      const body = { model: m, messages };
      if (max_tokens !== undefined) body.max_tokens = max_tokens;
      return chatCompletion(body);
    })
  );

  let totalIn = 0, totalOut = 0, totalCost = 0, priced = false;
  const sections = results.map((r, i) => {
    const id = picked[i];
    if (r.status === 'rejected') {
      return `## ${id}\n\n(failed: ${r.reason?.message || String(r.reason)})`;
    }
    const u = r.value.raw?.usage;
    if (u) {
      totalIn += u.prompt_tokens || 0;
      totalOut += u.completion_tokens || 0;
      if (typeof u.cost === 'number') { totalCost += u.cost; priced = true; }
    }
    return `## ${id}\n\n${r.value.text}`;
  });

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const footer =
    `\n\n---\n[panel: ${ok}/${picked.length} models answered | tokens: ${totalIn}+${totalOut}=${totalIn + totalOut}` +
    (priced ? ` | total cost: $${totalCost.toFixed(6)}` : '') + ']';

  return textResult(sections.join('\n\n') + footer);
});

// ---------------------------------------------------------------------------
// openrouter_benchmarks, independent quality scores per model
// ---------------------------------------------------------------------------
// GET /benchmarks returns one flat array mixing three sources with DIFFERENT
// shapes, keyed by `source`. They are not interchangeable, so each renders
// its own way:
//   artificial-analysis: intelligence_index / coding_index / agentic_index (0-100ish)
//   openrouter:          benchmark_type + accuracy + avg_cost_per_task
//   design-arena:        category + elo + win_rate (design and creative tasks)
const BENCH_TYPES = ['gpqa_diamond', 'tau_bench_verified_airline', 'search_browsecomp', 'search_dsqa', 'search_hle', 'search_widesearch'];

server.registerTool('openrouter_benchmarks', {
  description:
    'Rank models by independent benchmark scores, which is what "best" or "top models" actually means. ' +
    'Three sources: "aa" (Artificial Analysis intelligence / coding / agentic indices, the general quality ranking), ' +
    '"openrouter" (accuracy per benchmark: ' + BENCH_TYPES.join(', ') + '), and ' +
    '"design-arena" (Elo for design and creative work). ' +
    'Note this is QUALITY, not popularity. OpenRouter publishes usage rankings only on its website, not via API.',
  inputSchema: {
    source: z.enum(['aa', 'openrouter', 'design-arena']).optional()
      .describe('Which benchmark source (default "aa", the general intelligence ranking)'),
    metric: z.string().optional()
      .describe('For source "aa": intelligence (default), coding, or agentic. For "openrouter": one of ' + BENCH_TYPES.join(', ') + '. For "design-arena": a category such as website, uicomponent, dataviz, svg, logo, gamedev.'),
    search: z.string().optional().describe('Case-insensitive filter on model name or slug, e.g. "gemini"'),
    limit: z.number().int().positive().max(50).optional().describe('How many models to return (default 10)'),
  },
}, async ({ source, metric, search, limit }) => {
  const data = await orFetch('/benchmarks');
  const all = data.data || [];
  const src = source || 'aa';
  const cap = limit || 10;
  const srcKey = src === 'aa' ? 'artificial-analysis' : src;

  let rows = all.filter((r) => r.source === srcKey);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(
      (r) => (r.display_name || '').toLowerCase().includes(q) || (r.model_permaslug || '').toLowerCase().includes(q)
    );
  }

  const perM = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `$${(n * 1_000_000).toFixed(2)}/M` : '?';
  };

  let title, lines;

  if (src === 'aa') {
    const field = { coding: 'coding_index', agentic: 'agentic_index' }[metric || 'intelligence'] || 'intelligence_index';
    // Most catalog entries carry no AA score; drop them rather than rank nulls as 0.
    rows = rows.filter((r) => r[field] != null).sort((a, b) => b[field] - a[field]);
    title = `Artificial Analysis, ranked by ${field.replace('_index', '')} index (${rows.length} scored models)`;
    lines = rows.slice(0, cap).map((r, i) =>
      `${i + 1}. ${r.display_name}\n    ${r.model_permaslug}\n    intelligence ${r.intelligence_index ?? '?'} | coding ${r.coding_index ?? '?'} | agentic ${r.agentic_index ?? '?'} | in ${perM(r.pricing?.prompt)} out ${perM(r.pricing?.completion)}`
    );
  } else if (src === 'openrouter') {
    const type = metric || 'gpqa_diamond';
    if (!BENCH_TYPES.includes(type)) {
      throw new Error(`Unknown benchmark_type "${type}". Valid values: ${BENCH_TYPES.join(', ')}.`);
    }
    rows = rows.filter((r) => r.benchmark_type === type && r.accuracy != null)
      .sort((a, b) => b.accuracy - a.accuracy);
    title = `OpenRouter benchmark ${type} (${rows.length} models evaluated)`;
    lines = rows.slice(0, cap).map((r, i) =>
      `${i + 1}. ${r.display_name}\n    ${r.model_permaslug}\n    accuracy ${(r.accuracy * 100).toFixed(1)}% | $${Number(r.avg_cost_per_task || 0).toFixed(4)}/task | ${r.total_tasks ?? '?'} tasks | last run ${(r.last_run_timestamp || '').slice(0, 10) || '?'}`
    );
  } else {
    if (metric) rows = rows.filter((r) => r.category === metric);
    rows = rows.filter((r) => r.elo != null).sort((a, b) => b.elo - a.elo);
    const cats = [...new Set(all.filter((r) => r.source === 'design-arena').map((r) => r.category))].join(', ');
    title = `Design Arena Elo${metric ? `, category "${metric}"` : ' (all categories, pass metric to filter)'} (${rows.length} entries)\nCategories: ${cats}`;
    lines = rows.slice(0, cap).map((r, i) =>
      `${i + 1}. ${r.display_name} [${r.category}]\n    ${r.model_permaslug}\n    elo ${r.elo} | win rate ${r.win_rate ?? '?'}% | ${r.tournament_stats?.total ?? '?'} matches`
    );
  }

  if (!lines.length) return textResult(`${title}\n\nNo rows matched.`);
  return textResult(`${title}\n\n${lines.join('\n')}`);
});

// ---------------------------------------------------------------------------
// openrouter_image, generate an image and save it to disk
// ---------------------------------------------------------------------------
// Image models return the picture in choices[0].message.images[], NOT in
// message.content, so openrouter_chat silently drops it (the call still bills).
// This tool asks for the image modality explicitly, decodes the base64 data
// URLs, and writes real files. Billing is per token, so an image here costs
// cents, not the fractions of a cent a dedicated image API charges.
const DEFAULT_IMAGE_MODEL = process.env.OPENROUTER_DEFAULT_IMAGE_MODEL || 'google/gemini-3.1-flash-lite-image';

// Defaults to output/ next to this file. OPENROUTER_IMAGE_DIR overrides it;
// a relative value resolves against this folder.
const DEFAULT_IMAGE_DIR = resolve(__dirname, process.env.OPENROUTER_IMAGE_DIR || 'output');

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// The images[] entries are not uniformly shaped across vendors, so probe the
// handful of places a data URL actually shows up.
function collectImages(data) {
  const out = [];
  for (const choice of data.choices || []) {
    for (const img of choice.message?.images || []) {
      const url = typeof img === 'string' ? img : (img.image_url?.url || img.url || img.b64_json || '');
      if (url) out.push(url);
    }
  }
  return out;
}

server.registerTool('openrouter_image', {
  description:
    'Generate an image from a text prompt using an OpenRouter image model and SAVE it to disk, ' +
    'returning the file path. Use this instead of openrouter_chat for any image generation: ' +
    'openrouter_chat returns empty text for image models because it only reads message.content, ' +
    'while the picture arrives in message.images[] (the call still bills). ' +
    `Defaults to ${DEFAULT_IMAGE_MODEL}. Billing is per token, so expect a few cents per image.`,
  inputSchema: {
    prompt: z.string().min(1).describe('What to generate. Describe subject, composition, lighting, mood, and aspect ratio in words.'),
    model: z.string().optional().describe(`OpenRouter image model id (default ${DEFAULT_IMAGE_MODEL}). Find more with openrouter_list_models search "image".`),
    filename: z.string().optional().describe('Base name for the saved file, without extension. Defaults to a timestamped name.'),
    out_dir: z.string().optional().describe(`Directory to save into (default ${DEFAULT_IMAGE_DIR}).`),
    max_tokens: z.number().int().positive().optional().describe('Max completion tokens. Images consume a large block; leave unset unless output is truncated.'),
  },
}, async ({ prompt, model, filename, out_dir, max_tokens }) => {
  const chosen = model || DEFAULT_IMAGE_MODEL;
  const body = {
    model: chosen,
    messages: [{ role: 'user', content: prompt }],
    // Without this some models answer in prose instead of returning an image.
    modalities: ['image', 'text'],
  };
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  const data = await orFetch('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ ...body, usage: { include: true } }),
  });

  const urls = collectImages(data);
  const usage = fmtUsage(data, chosen);

  if (!urls.length) {
    const said = data.choices?.[0]?.message?.content;
    return textResult(
      `No image returned by ${chosen}. The call still billed.` +
      (said ? `\n\nThe model replied with text instead:\n${said}` : '') +
      `\n\nCheck that this model id actually generates images (openrouter_list_models search "image").` +
      usage
    );
  }

  const dir = out_dir ? (isAbsolute(out_dir) ? out_dir : resolve(process.cwd(), out_dir)) : DEFAULT_IMAGE_DIR;
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = (filename || `openrouter-image-${stamp}`).replace(/\.[a-z0-9]+$/i, '');

  const saved = [];
  for (const [i, url] of urls.entries()) {
    const m = DATA_URL.exec(url);
    if (!m) {
      // Some vendors hand back an https URL with a short expiry rather than base64.
      saved.push(`(not saved, model returned a link instead of image data: ${url})`);
      continue;
    }
    const ext = EXT[m[1].toLowerCase()] || 'png';
    const name = urls.length > 1 ? `${base}-${i + 1}.${ext}` : `${base}.${ext}`;
    const path = join(dir, name);
    await writeFile(path, Buffer.from(m[2], 'base64'));
    saved.push(path);
  }

  const header = `Generated ${urls.length} image(s) with ${chosen}:`;
  return textResult(`${header}\n\n${saved.map((s) => `- ${s}`).join('\n')}${usage}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
