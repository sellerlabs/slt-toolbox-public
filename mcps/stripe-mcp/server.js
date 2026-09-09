/**
 * Stripe MCP — read-only reporting server.
 *
 * Runs as a LazyHub child (key `stripe`). Tools: mcp__lazy-hub__stripe_*.
 * v1 surface is READ-ONLY: list payouts and list subscriptions, shaped to the
 * columns the two weekly runbooks expect. NO charge/refund/payout-create tools.
 *
 * Auth: a Stripe RESTRICTED read-only key in stripe-mcp/.env as
 *   STRIPE_API_KEY=...    (STRIPE_SECRET_KEY also accepted as an alias)
 *
 * Two things that silently corrupt the sheets if wrong, handled here:
 *   - Stripe returns integer CENTS -> we convert to dollars for Amount columns.
 *   - Stripe returns Unix timestamps in UTC -> we format ISO UTC, never localize.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Stripe from 'stripe';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');

// Manual .env parse — no dotenv dependency (workspace convention).
function loadEnv() {
  try {
    const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file — rely on process.env */ }
}
loadEnv();

// Up to three SEPARATE Stripe accounts (NOT Connect sub-accounts), so each
// needs its own restricted key: a key cannot reach any account but its own.
// Labels and account ids come from .env so nothing about your business is
// baked into this file. Only `primary` is required.
const ACCOUNTS = {
  primary: { label: process.env.STRIPE_LABEL_PRIMARY || 'Primary', acct: process.env.STRIPE_ACCT_PRIMARY || '', envVar: 'STRIPE_API_KEY' },
  second:  { label: process.env.STRIPE_LABEL_SECOND  || 'Second',  acct: process.env.STRIPE_ACCT_SECOND  || '', envVar: 'STRIPE_API_KEY_SECOND' },
  third:   { label: process.env.STRIPE_LABEL_THIRD   || 'Third',   acct: process.env.STRIPE_ACCT_THIRD   || '', envVar: 'STRIPE_API_KEY_THIRD' },
};
// Only expose accounts that actually have a key configured.
const ACCOUNT_KEYS = Object.keys(ACCOUNTS).filter((k) => k === 'primary' || process.env[ACCOUNTS[k].envVar]);
const DEFAULT_ACCOUNT = 'primary';

const API_KEY = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY;
if (!API_KEY) {
  console.error(
    'Stripe MCP: no STRIPE_API_KEY. Add a restricted read-only key to stripe-mcp/.env'
  );
}

const STRIPE_OPTS = {
  // Pin an API version so field shapes are stable across Stripe upgrades.
  apiVersion: '2024-06-20',
  maxNetworkRetries: 2, // built-in exponential backoff, covers 429/5xx
  appInfo: { name: 'stripe-mcp', version: '1.1.0' },
};

// One client per account, built on first use.
const clients = new Map();
function clientFor(account) {
  const name = (account || DEFAULT_ACCOUNT).toLowerCase();
  const cfg = ACCOUNTS[name];
  if (!cfg) {
    throw new Error(
      'Unknown account "' + account + '". Valid: ' + ACCOUNT_KEYS.join(', ')
    );
  }
  if (clients.has(name)) return clients.get(name);
  // STRIPE_SECRET_KEY stays accepted as an alias for the SLT default only.
  const key = name === DEFAULT_ACCOUNT
    ? (process.env[cfg.envVar] || process.env.STRIPE_SECRET_KEY)
    : process.env[cfg.envVar];
  if (!key) {
    throw new Error(
      'No key for account "' + name + '" (' + cfg.label + '). Set '
      + cfg.envVar + ' in stripe-mcp/.env'
    );
  }
  const c = new Stripe(key, STRIPE_OPTS);
  clients.set(name, c);
  return c;
}

const ACCOUNT_PARAM = z
  .enum(ACCOUNT_KEYS)
  .optional()
  .describe(
    'Which Stripe account to query. Defaults to "primary". '
    + 'Separate accounts, each with its own key: '
    + ACCOUNT_KEYS.map((k) => k + ' = ' + ACCOUNTS[k].label).join(', ') + '.'
  );

const MAX_PAGES = 100; // safety cap: 100 pages * 100 rows = 10k rows

// --- helpers -------------------------------------------------------------

function centsToDollars(cents) {
  if (cents == null) return null;
  return Math.round(cents) / 100;
}

// Stripe Unix seconds (UTC) -> "YYYY-MM-DD HH:MM:SS" UTC. Never localize.
function unixToUtc(ts) {
  if (ts == null) return null;
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// Stripe Unix seconds (UTC) -> "YYYY-MM-DD" (date only, UTC).
function unixToUtcDate(ts) {
  if (ts == null) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Accept ISO string or Unix seconds; return Unix seconds for Stripe filters.
function toUnix(value) {
  if (value == null) return undefined;
  if (typeof value === 'number') return Math.floor(value);
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Unparseable date: ${value}`);
  return Math.floor(ms / 1000);
}

// ISO 8601 week number of a UTC timestamp (matches the sheet's Week # column).
function isoWeek(ts) {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
}

function utcYear(ts) {
  if (ts == null) return null;
  return new Date(ts * 1000).getUTCFullYear();
}

// Auto-paginate a Stripe list endpoint via cursor pagination.
async function listAll(listFn, params, limit) {
  const rows = [];
  let starting_after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageSize = limit ? Math.min(100, limit - rows.length) : 100;
    if (pageSize <= 0) break;
    const res = await listFn({ ...params, limit: pageSize, starting_after });
    rows.push(...res.data);
    if (!res.has_more || (limit && rows.length >= limit)) break;
    starting_after = res.data[res.data.length - 1]?.id;
    if (!starting_after) break;
  }
  return rows;
}

// --- server --------------------------------------------------------------

const server = new McpServer({ name: 'stripe-mcp', version: '1.0.0' });

server.tool(
  'stripe_list_payouts',
  'List Stripe payouts (READ-ONLY) shaped for the Revenue Sheet 2026 tab. Returns a flat array of row objects with dollars (not cents) and UTC dates. Auto-paginates.',
  {
    created_after: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Only payouts created at/after this date. ISO string or Unix seconds (UTC).'),
    created_before: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Only payouts created at/before this date. ISO string or Unix seconds (UTC).'),
    status: z
      .string()
      .optional()
      .describe('Filter by payout status (e.g. paid, pending, in_transit, failed, canceled).'),
    limit: z.number().int().positive().optional().describe('Max rows to return across all pages.'),
    account: ACCOUNT_PARAM,
  },
  async ({ created_after, created_before, status, limit, account }) => {
    const stripe = clientFor(account);
    const acctLabel = ACCOUNTS[(account || DEFAULT_ACCOUNT).toLowerCase()].label;
    const created = {};
    if (created_after != null) created.gte = toUnix(created_after);
    if (created_before != null) created.lte = toUnix(created_before);

    const params = {
      expand: ['data.destination', 'data.balance_transaction'],
    };
    if (Object.keys(created).length) params.created = created;
    if (status) params.status = status;

    const payouts = await listAll((p) => stripe.payouts.list(p), params, limit);

    const rows = payouts.map((po) => {
      const dest = typeof po.destination === 'object' ? po.destination : null;
      const bt = typeof po.balance_transaction === 'object' ? po.balance_transaction : null;
      return {
        week: isoWeek(po.created),
        year: utcYear(po.created),
        id: po.id,
        amount: centsToDollars(po.amount),
        created_utc: unixToUtc(po.created),
        currency: po.currency,
        arrival_date_utc: unixToUtcDate(po.arrival_date),
        source_type: po.source_type,
        status: po.status,
        type: po.type,
        method: po.method,
        balance_transaction: bt ? bt.id : po.balance_transaction || null,
        destination_name: dest ? dest.bank_name || dest.name || null : null,
        destination_country: dest ? dest.country || null : null,
        destination_last4: dest ? dest.last4 || null : null,
        // Which Stripe account this payout came from. The Revenue Sheet has an
        // Account column; without this, rows from different accounts are
        // indistinguishable once written and the Charts sumifs would mis-total.
        account: acctLabel,
      };
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({ account: acctLabel, count: rows.length, payouts: rows }, null, 2) }],
    };
  }
);

server.tool(
  'stripe_list_subscriptions',
  'List Stripe subscriptions (READ-ONLY) status=all by default. Returns a flat array with dollars (not cents) and UTC dates. Auto-paginates.',
  {
    status: z
      .string()
      .optional()
      .describe('Subscription status filter. Defaults to "all" (active, trialing, canceled, etc.).'),
    created_after: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Only subscriptions created at/after this date. ISO string or Unix seconds (UTC).'),
    created_before: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Only subscriptions created at/before this date. ISO string or Unix seconds (UTC).'),
    limit: z.number().int().positive().optional().describe('Max rows to return across all pages.'),
    account: ACCOUNT_PARAM,
  },
  async ({ status, created_after, created_before, limit, account }) => {
    const stripe = clientFor(account);
    const created = {};
    if (created_after != null) created.gte = toUnix(created_after);
    if (created_before != null) created.lte = toUnix(created_before);

    const params = {
      // Stripe caps expansion at 4 levels, and the list wrapper counts —
      // so data.items.data.price.product (5) is rejected. Expand to price only,
      // then resolve product names separately (cached below).
      status: status || 'all',
      expand: ['data.customer', 'data.items.data.price'],
    };
    if (Object.keys(created).length) params.created = created;

    const subs = await listAll((p) => stripe.subscriptions.list(p), params, limit);

    // Resolve distinct product ids -> names once (small set; cached). Requires
    // the key's Products Read scope; if absent, Stripe 403s and we fall back to
    // the price nickname / product id (see plan_name below).
    const productIds = new Set();
    for (const sub of subs) {
      const price = sub.items?.data?.[0]?.price;
      if (price && typeof price.product === 'string') productIds.add(price.product);
    }
    const productNames = {};
    for (const pid of productIds) {
      try {
        const prod = await stripe.products.retrieve(pid);
        productNames[pid] = prod?.name || null;
      } catch {
        productNames[pid] = null; // no Products Read scope, or deleted product
      }
    }

    // Tiered prices don't carry `tiers` in a list response — Stripe only returns
    // the tier table on an explicit retrieve with expand:['tiers']. Cache per
    // price id so a 1000+ subscription page costs one retrieve per distinct plan.
    const tieredPriceCache = new Map();
    async function resolveTiers(price) {
      if (!price || price.billing_scheme !== 'tiered') return null;
      if (Array.isArray(price.tiers) && price.tiers.length) return price.tiers;
      if (tieredPriceCache.has(price.id)) return tieredPriceCache.get(price.id);
      let tiers = null;
      try {
        const full = await stripe.prices.retrieve(price.id, { expand: ['tiers'] });
        tiers = Array.isArray(full?.tiers) && full.tiers.length ? full.tiers : null;
      } catch {
        tiers = null; // no Prices Read scope, or price deleted
      }
      tieredPriceCache.set(price.id, tiers);
      return tiers;
    }

    // Charge for `qty` under a tier table. Tiers are ordered ascending by `up_to`,
    // with the final tier carrying up_to === null (unbounded).
    //   volume    — the single tier the quantity lands in prices the whole quantity.
    //   graduated — each tier prices only the units that fall inside its own band.
    // Both may carry a flat_amount, a per-unit unit_amount, or both.
    function tieredCents(tiers, qty, mode) {
      if (!Array.isArray(tiers) || !tiers.length) return null;
      if (mode === 'graduated') {
        let remaining = qty;
        let prevUpTo = 0;
        let total = 0;
        for (const t of tiers) {
          if (remaining <= 0) break;
          const upTo = t.up_to === null ? Infinity : t.up_to;
          const band = Math.min(remaining, upTo - prevUpTo);
          if (band > 0) {
            total += (t.flat_amount || 0) + (t.unit_amount || 0) * band;
            remaining -= band;
          }
          prevUpTo = upTo;
        }
        return total;
      }
      // volume (Stripe's default when tiers_mode is absent)
      for (const t of tiers) {
        if (t.up_to === null || qty <= t.up_to) {
          return (t.flat_amount || 0) + (t.unit_amount || 0) * qty;
        }
      }
      return null;
    }

    const rows = [];
    for (const sub of subs) {
      const cust = typeof sub.customer === 'object' ? sub.customer : null;
      const items = sub.items?.data?.length ? sub.items.data : [null];

      // Sum every line item so multi-item subscriptions aren't undercounted.
      // A single null stays null; a null alongside priced items is treated as
      // unknown for that line and leaves the total null rather than guessing low.
      let totalCents = 0;
      let anyPriced = false;
      let anyUnknown = false;

      for (const item of items) {
        const price = item && typeof item.price === 'object' ? item.price : null;
        if (!price) {
          anyUnknown = true;
          continue;
        }
        const qty = item?.quantity ?? sub.quantity ?? 1;
        let cents = null;
        if (price.billing_scheme === 'tiered') {
          const tiers = await resolveTiers(price);
          cents = tieredCents(tiers, qty, price.tiers_mode);
        } else if (price.unit_amount != null) {
          cents = price.unit_amount * qty;
        }
        if (cents == null) anyUnknown = true;
        else {
          totalCents += cents;
          anyPriced = true;
        }
      }

      const amountCents = anyUnknown && !anyPriced ? null : anyUnknown ? null : totalCents;

      const primary = items[0];
      const price = primary && typeof primary.price === 'object' ? primary.price : null;
      const qty = primary?.quantity ?? sub.quantity ?? 1;
      // Product name: prefer resolved product name, then price nickname,
      // then the bare product id as a last resort.
      const pid = typeof price?.product === 'string' ? price.product : null;
      const planName = (pid && productNames[pid]) || price?.nickname || pid || null;
      rows.push({
        customer_email: cust ? cust.email || null : null,
        plan: price ? price.id : null,
        customer_description: cust ? cust.description || null : null,
        date_created_utc: unixToUtc(sub.created),
        quantity: qty,
        currency: price ? price.currency : sub.currency,
        interval: price?.recurring?.interval ?? null,
        amount: amountCents == null ? null : centsToDollars(amountCents),
        status: sub.status,
        plan_name: planName,
      });
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ count: rows.length, subscriptions: rows }, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Stripe MCP (read-only) running on stdio.');
