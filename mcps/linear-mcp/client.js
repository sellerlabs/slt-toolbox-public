// Thin GraphQL client for the Linear API.
//
// Kept separate from the tool definitions so the transport, auth and error
// shaping can be reasoned about (and tested) on their own.

const ENDPOINT = 'https://api.linear.app/graphql';

// Linear allows 2,500 requests/hour and 3,000,000 complexity points/hour per
// user on a personal API key. We surface the remaining budget on errors rather
// than polling it, so a run that dies mid-way says WHY.
let lastRateLimit = null;

export function getRateLimitSnapshot() {
  return lastRateLimit;
}

function readRateLimit(headers) {
  const num = (h) => {
    const v = headers.get(h);
    return v === null ? undefined : Number(v);
  };
  const snap = {
    requestsRemaining: num('X-RateLimit-Requests-Remaining'),
    requestsLimit: num('X-RateLimit-Requests-Limit'),
    complexityRemaining: num('X-RateLimit-Complexity-Remaining'),
    complexityLimit: num('X-RateLimit-Complexity-Limit'),
    resetAt: num('X-RateLimit-Requests-Reset'),
  };
  if (snap.requestsRemaining !== undefined || snap.complexityRemaining !== undefined) {
    lastRateLimit = snap;
  }
  return snap;
}

export class LinearError extends Error {
  constructor(message, { code, status, rateLimit } = {}) {
    super(message);
    this.name = 'LinearError';
    this.code = code;
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

function apiKey() {
  const key = (process.env.LINEAR_API_KEY || '').trim();
  if (!key) {
    throw new LinearError(
      'Missing LINEAR_API_KEY. Create a personal API key at Linear -> Settings -> Account -> ' +
        'Security & Access -> Personal API keys, then put it in this folder’s .env as LINEAR_API_KEY.'
    );
  }
  // The single most common setup mistake. A personal key is sent RAW; only OAuth
  // access tokens take a Bearer prefix. Catch it here with a clear message
  // instead of letting Linear return an opaque 400.
  if (/^Bearer\s/i.test(key)) {
    throw new LinearError(
      'LINEAR_API_KEY must not include a "Bearer " prefix. Linear personal API keys are sent raw ' +
        'in the Authorization header; only OAuth access tokens use Bearer. Remove the prefix from .env.'
    );
  }
  return key;
}

// Turn Linear's error array into one readable line, keeping the machine code
// so callers can branch on it.
function describeErrors(errors) {
  const first = errors[0] || {};
  const code = first.extensions?.code || first.extensions?.type;
  const parts = errors.map((e) => {
    const path = Array.isArray(e.path) ? ` (at ${e.path.join('.')})` : '';
    return `${e.message}${path}`;
  });
  return { message: parts.join('; '), code };
}

export async function gql(query, variables = {}) {
  // Resolve auth OUTSIDE the network try/catch. A missing or malformed key is a
  // config error, and wrapping it in "could not reach the API" sends whoever
  // hits it looking for a network problem they do not have.
  const auth = apiKey();

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new LinearError(`Could not reach the Linear API: ${err.message}`);
  }

  const rateLimit = readRateLimit(res.headers);

  if (res.status === 429) {
    const resetAt = rateLimit.resetAt ? new Date(rateLimit.resetAt).toISOString() : 'unknown';
    throw new LinearError(
      `Linear rate limit exceeded. Window resets at ${resetAt}. ` +
        `Requests remaining: ${rateLimit.requestsRemaining ?? '?'}/${rateLimit.requestsLimit ?? '?'}.`,
      { code: 'RATELIMITED', status: 429, rateLimit }
    );
  }

  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    throw new LinearError(
      `Linear returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`,
      { status: res.status, rateLimit }
    );
  }

  if (body.errors?.length) {
    const { message, code } = describeErrors(body.errors);
    if (code === 'AUTHENTICATION_ERROR' || res.status === 401 || res.status === 400) {
      throw new LinearError(
        `Linear rejected the request: ${message}. If this reads like a bad key, check that ` +
          'LINEAR_API_KEY in .env is the raw key with no "Bearer " prefix and has not been revoked.',
        { code, status: res.status, rateLimit }
      );
    }
    throw new LinearError(`Linear API error: ${message}`, { code, status: res.status, rateLimit });
  }

  if (!res.ok) {
    throw new LinearError(`Linear API returned HTTP ${res.status}.`, { status: res.status, rateLimit });
  }

  return body.data;
}

// --- shared GraphQL fragments ---------------------------------------------
// Every issue-returning query selects the same field set, so the flattener has
// a consistent shape to work with and a new field only has to be added once.
export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  estimate
  dueDate
  createdAt
  updatedAt
  completedAt
  canceledAt
  state { id name type }
  assignee { id name }
  creator { id name }
  team { id key name }
  project { id name }
  cycle { id number name }
  parent { id identifier }
  labels { nodes { id name } }
`;

export const PROJECT_FIELDS = `
  id
  name
  description
  url
  state
  progress
  health
  startDate
  targetDate
  createdAt
  updatedAt
  completedAt
  lead { id name }
  teams { nodes { id key } }
`;

export const COMMENT_FIELDS = `
  id
  body
  url
  createdAt
  updatedAt
  user { id name }
`;
