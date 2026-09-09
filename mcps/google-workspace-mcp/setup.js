#!/usr/bin/env node
/**
 * setup.js — CLI for managing Google account connections
 *
 * Usage:
 *   node setup.js add <nickname> [alias1,alias2]  — connect a new Google account
 *   node setup.js list                            — list all connected accounts
 *   node setup.js remove <nickname>               — disconnect an account
 *
 * Optional aliases let you address the account by other emails it also receives
 * (e.g. add work "you@example.com" so that alias resolves to this token).
 */

// NOTE: deliberately does NOT import the `googleapis` meta-package. The
// `google-auth-library: ^10.5.0` override hoists v10, but googleapis@144's
// googleapis-common expects v9's `DefaultTransporter` export, which v10 removed
// — importing it here crashed setup.js at load with
// "google_auth_library_1.DefaultTransporter is not a constructor" (2026-08-12).
// The OAuth2 client comes from auth.js (same reasoning as its own header
// comment), and userinfo is a plain authorized fetch.
import { createServer } from 'http'
import open from 'open'
import { existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { loadOAuthClient, saveAccountTokens, listAccounts, SCOPES } from './auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKENS_DIR = join(__dirname, 'tokens')
const REDIRECT_PORT = 3000
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`

const [,, command, nickname, aliasArg] = process.argv

async function addAccount(nick, aliasArg) {
  if (!nick) {
    console.error('Usage: node setup.js add <nickname> [alias1,alias2]')
    console.error('Example: node setup.js add work you@example.com')
    process.exit(1)
  }
  const aliases = (aliasArg || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

  let auth
  try {
    auth = loadOAuthClient()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  // Override redirect URI to our local server
  auth.redirectUri = REDIRECT_URI

  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh token every time
  })

  console.log(`\nConnecting account "${nick}"...`)
  console.log('Opening browser for Google sign-in...\n')

  // Start local callback server
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
      if (url.pathname === '/oauth2callback') {
        const authCode = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        if (error) {
          res.writeHead(400)
          res.end(`<h2>Auth failed: ${error}</h2><p>You can close this tab.</p>`)
          server.close()
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        res.writeHead(200)
        res.end('<h2>✅ Connected! You can close this tab.</h2>')
        server.close()
        resolve(authCode)
      }
    })

    server.listen(REDIRECT_PORT, () => {
      open(authUrl).catch(() => {
        console.log('Could not open browser automatically. Open this URL manually:\n')
        console.log(authUrl)
      })
    })

    server.on('error', reject)
    setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for OAuth callback (2 min)'))
    }, 300_000)
  })

  // Exchange code for tokens
  const { tokens } = await auth.getToken(code)
  auth.setCredentials(tokens)

  // Fetch the account email (plain authorized fetch — see import note above)
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!res.ok) throw new Error(`userinfo failed: ${res.status} ${await res.text()}`)
  const email = (await res.json()).email

  saveAccountTokens(nick, tokens, email, aliases)

  console.log(`\n✅ Connected: ${nick} → ${email}`)
  if (aliases.length) console.log(`   Aliases: ${aliases.join(', ')}`)
  console.log(`   Token saved to tokens/${nick}.json\n`)
}

function listAllAccounts() {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    console.log('\nNo accounts connected yet.')
    console.log('Run: node setup.js add <nickname>\n')
    return
  }
  console.log('\nConnected Google accounts:')
  for (const { nickname: nick, email, aliases } of accounts) {
    const aliasNote = aliases && aliases.length ? `  [aliases: ${aliases.join(', ')}]` : ''
    console.log(`  ${nick.padEnd(15)} ${email}${aliasNote}`)
  }
  console.log()
}

function removeAccount(nick) {
  if (!nick) {
    console.error('Usage: node setup.js remove <nickname>')
    process.exit(1)
  }
  const tokenPath = join(TOKENS_DIR, `${nick}.json`)
  if (!existsSync(tokenPath)) {
    console.error(`No account found with nickname "${nick}"`)
    process.exit(1)
  }
  unlinkSync(tokenPath)
  console.log(`Removed account "${nick}"`)
}

// Main
switch (command) {
  case 'add':
    await addAccount(nickname, aliasArg)
    break
  case 'list':
    listAllAccounts()
    break
  case 'remove':
    removeAccount(nickname)
    break
  default:
    console.log('Google Workspace MCP — Account Setup')
    console.log()
    console.log('Commands:')
    console.log('  node setup.js add <nickname> [alias1,alias2]  Connect a Google account')
    console.log('  node setup.js list                            List connected accounts')
    console.log('  node setup.js remove <nickname>               Disconnect an account')
    console.log()
    console.log('Examples:')
    console.log('  node setup.js add work you@example.com')
    console.log('  node setup.js add personal')
    console.log('  node setup.js list')
}
