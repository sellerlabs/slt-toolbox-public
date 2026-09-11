/**
 * auth.js — OAuth2 token manager for Google Workspace MCP
 *
 * Manages per-account credentials. Each account is identified by a
 * nickname (e.g. "work", "personal") and stored in tokens/{nickname}.json.
 *
 * Scopes granted cover Gmail, Calendar, and Drive.
 */

// OAuth2 comes straight from google-auth-library rather than the `googleapis`
// meta-package. See the note in gmail.js: the meta-package builds ~350 API
// surfaces at import time and costs ~700ms more per process for no benefit here.
//
// ⚠️ THE `google-auth-library` OVERRIDE IN package.json IS LOAD-BEARING — do not
// remove it. The @googleapis/* clients validate the auth object by instance identity.
// Without the override npm installs SIX copies (a stale top-level 9.15.1 from the
// meta-package plus a 10.x bundled inside each scoped client), so an OAuth2Client
// built here is a different class than the one the API client expects and every call
// fails with a misleading "Login Required." even though the token is valid and
// unexpired (verified 2026-08-11: getAccessToken() succeeded, the call still failed).
// `"overrides": { "google-auth-library": "^10.5.0" }` collapses them to one copy.
import { OAuth2Client } from 'google-auth-library'
const google = { auth: { OAuth2: OAuth2Client } }
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKENS_DIR = join(__dirname, 'tokens')
const CREDENTIALS_PATH = join(__dirname, 'credentials.json')

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
]

/**
 * Load Google OAuth2 client from credentials.json
 */
export function loadOAuthClient() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'credentials.json not found in google-workspace-mcp/.\n' +
      'Download it from Google Cloud Console > APIs & Services > Credentials.'
    )
  }
  const { installed, web } = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'))
  const creds = installed || web
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris[0])
}

/**
 * Resolve an account identifier (nickname OR email OR alias) to a token filename.
 *
 * Resolution order:
 *   1. Exact nickname — tokens/{input}.json exists → use it.
 *   2. Email / alias — input contains "@"; scan token files and match (case-insensitive)
 *      against each token's `email` and any entry in its `aliases[]` array.
 *      On multiple matches (e.g. duplicate tokens), pick the freshest (highest expiry_date).
 *
 * Returns the resolved nickname (filename without .json), or null if nothing matches.
 */
export function resolveAccountId(input) {
  if (!input) return null

  // 1. Exact nickname match — cheapest, preserves existing behavior.
  if (existsSync(join(TOKENS_DIR, `${input}.json`))) return input

  // 2. Email / alias match.
  if (!input.includes('@')) return null
  if (!existsSync(TOKENS_DIR)) return null
  const needle = input.toLowerCase()
  const matches = []
  for (const f of readdirSync(TOKENS_DIR)) {
    if (!f.endsWith('.json') || f === '.gitkeep') continue
    try {
      const data = JSON.parse(readFileSync(join(TOKENS_DIR, f), 'utf8'))
      const emails = [data.email, ...(data.aliases || [])]
        .filter(Boolean)
        .map((e) => e.toLowerCase())
      if (emails.includes(needle)) {
        matches.push({ nickname: f.replace('.json', ''), expiry: data.expiry_date || 0 })
      }
    } catch {
      // skip unreadable token file
    }
  }
  if (matches.length === 0) return null
  // Freshest token wins on ties; log the choice so ambiguity is visible.
  matches.sort((a, b) => b.expiry - a.expiry)
  if (matches.length > 1) {
    console.error(
      `[auth] "${input}" matched ${matches.length} accounts (${matches.map((m) => m.nickname).join(', ')}); using "${matches[0].nickname}" (freshest).`
    )
  }
  return matches[0].nickname
}

/**
 * Load tokens for a specific account nickname, email, or alias.
 * Returns a fully-configured, auto-refreshing OAuth2 client.
 */
export function loadAccountAuth(account) {
  const nickname = resolveAccountId(account)
  if (!nickname) {
    const known = listAccounts()
      .map((a) => `  ${a.nickname} (${a.email})`)
      .join('\n')
    throw new Error(
      `No account found for "${account}". Pass a nickname, email, or alias.\n` +
      `Connected accounts:\n${known}\n` +
      `To add one: node setup.js add <nickname>`
    )
  }
  const tokenPath = join(TOKENS_DIR, `${nickname}.json`)
  const tokens = JSON.parse(readFileSync(tokenPath, 'utf8'))
  const auth = loadOAuthClient()
  auth.setCredentials(tokens)

  // Auto-save refreshed tokens
  auth.on('tokens', (newTokens) => {
    const current = JSON.parse(readFileSync(tokenPath, 'utf8'))
    const merged = { ...current, ...newTokens }
    writeFileSync(tokenPath, JSON.stringify(merged, null, 2))
  })

  return auth
}

/**
 * Save tokens for an account nickname.
 * Preserves any existing `aliases[]` on re-auth so email/alias resolution survives.
 */
export function saveAccountTokens(nickname, tokens, email, aliases) {
  // tokens/ is gitignored, so a fresh checkout has no such directory. Create it
  // here or the very first connect throws ENOENT *after* OAuth already succeeded.
  mkdirSync(TOKENS_DIR, { recursive: true })
  const tokenPath = join(TOKENS_DIR, `${nickname}.json`)
  let existingAliases = []
  if (existsSync(tokenPath)) {
    try {
      existingAliases = JSON.parse(readFileSync(tokenPath, 'utf8')).aliases || []
    } catch {
      // ignore unreadable prior token
    }
  }
  const finalAliases = aliases && aliases.length ? aliases : existingAliases
  writeFileSync(tokenPath, JSON.stringify({ ...tokens, email, aliases: finalAliases }, null, 2))
}

/**
 * List all connected accounts.
 * Returns array of { nickname, email }
 */
export function listAccounts() {
  if (!existsSync(TOKENS_DIR)) return []
  return readdirSync(TOKENS_DIR)
    .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    .map((f) => {
      const nickname = f.replace('.json', '')
      try {
        const data = JSON.parse(readFileSync(join(TOKENS_DIR, f), 'utf8'))
        return { nickname, email: data.email || 'unknown', aliases: data.aliases || [] }
      } catch {
        return { nickname, email: 'unknown', aliases: [] }
      }
    })
}

/**
 * Get auth clients for one or all accounts.
 * If accountNickname is provided, returns [{ nickname, auth }] for just that one.
 * If omitted, returns all connected accounts.
 */
export function resolveAccounts(accountNickname) {
  if (accountNickname) {
    return [{ nickname: accountNickname, auth: loadAccountAuth(accountNickname) }]
  }
  const accounts = listAccounts()
  if (accounts.length === 0) {
    throw new Error('No Google accounts connected. Run: node setup.js add <nickname>')
  }
  return accounts.map(({ nickname }) => ({ nickname, auth: loadAccountAuth(nickname) }))
}
