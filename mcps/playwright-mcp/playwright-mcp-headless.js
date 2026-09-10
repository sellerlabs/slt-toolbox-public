const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Create a unique user data dir per process to allow multiple parallel instances
const userDataDir = path.join(os.tmpdir(), `playwright-mcp-headless-${process.pid}`);
fs.mkdirSync(userDataDir, { recursive: true });

// Force bundled Chromium in headless mode - no visible window, faster, no conflicts
// Use --output-dir to explicitly set where screenshots/exports go: the project-root
// temp/ folder, matching the visible server (playwright-mcp-server.js) so bare-filename
// artifacts never land in Tools/Playwright. __dirname = Tools/Playwright, root is two up.
process.argv.push('--browser', 'chromium', '--headless', '--user-data-dir', userDataDir, '--output-dir', path.join(__dirname, '..', '..', 'temp'));

// Find @playwright/mcp cli.js dynamically across platforms
function findPlaywrightMcp() {
  // Try common global npm paths
  const candidates = [
    // Windows
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'mcp', 'cli.js'),
    // macOS Homebrew (Apple Silicon)
    '/opt/homebrew/lib/node_modules/@playwright/mcp/cli.js',
    // macOS Homebrew (Intel)
    '/usr/local/lib/node_modules/@playwright/mcp/cli.js',
    // Linux / generic
    '/usr/lib/node_modules/@playwright/mcp/cli.js',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: ask npm where global modules live
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const npmPath = path.join(globalRoot, '@playwright', 'mcp', 'cli.js');
    if (fs.existsSync(npmPath)) return npmPath;
  } catch (e) { /* ignore */ }

  throw new Error('@playwright/mcp not found. Run: npm install -g @playwright/mcp');
}

// ── Credential masking ───────────────────────────────────────────────────────
//
// The visible bridge is a stdio<->SSE proxy, so it can mask tool-result text as
// it forwards. This file has no such seam: it loads the upstream @playwright/mcp
// CLI in-process, and that CLI owns the stdio transport end to end. The only
// interception point is process.stdout.write itself.
//
// Patching it is upstream's OWN technique for this exact situation: their test
// harness swaps process.stdout.write to capture MCP traffic
// (playwright/lib/mcp/test/testContext.js, claimStdio/releaseStdio).
//
// This MUST be installed BEFORE the require() below, so the StdioServerTransport
// binds to the wrapped write rather than the original.
const { maskJsonRpcLine, selfTest } = require('./mask-credentials');

selfTest('playwright-mcp-headless');

const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, encoding, callback) {
  try {
    if (typeof chunk === 'string') {
      // JSON-RPC over stdio is newline-delimited. Mask per line so a batched
      // write cannot slip a payload through, and preserve the exact line
      // structure (including a trailing newline) on the way out.
      chunk = chunk.split('\n').map(maskJsonRpcLine).join('\n');
    }
  } catch (e) {
    // Never let masking break the transport: fall through with the original
    // chunk, but make the failure visible on stderr.
    process.stderr.write(`[playwright-mcp-headless] Mask error: ${e.message}\n`);
  }
  return _origStdoutWrite(chunk, encoding, callback);
};

require(findPlaywrightMcp());
