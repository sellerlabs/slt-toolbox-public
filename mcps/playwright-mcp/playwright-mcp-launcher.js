const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Change CWD so bare-filename artifacts (screenshots, snapshot dumps) resolve to a
// predictable place rather than the project root. Prefer the workspace-root temp/
// folder when this MCP sits inside it (playwright-mcp -> two levels up);
// otherwise fall back to this folder, which is the standalone-clone case.
const workspaceTemp = path.join(__dirname, '..', '..', 'temp');
try {
  fs.mkdirSync(workspaceTemp, { recursive: true });
  process.chdir(workspaceTemp);
} catch {
  process.chdir(__dirname);
}

// Resolve @playwright/mcp wherever it actually is. Absolute paths to one machine's
// global npm root do not survive being cloned (or scrubbed) onto another machine,
// so check the standard install locations in order and fall back to asking npm.
function resolvePlaywrightMcpCli() {
  // A local node_modules install wins: `require.resolve` finds it from here.
  try {
    return require.resolve('@playwright/mcp/cli.js');
  } catch { /* not installed locally - try global locations */ }

  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'mcp', 'cli.js'),
    '/opt/homebrew/lib/node_modules/@playwright/mcp/cli.js',
    '/usr/local/lib/node_modules/@playwright/mcp/cli.js',
    '/usr/lib/node_modules/@playwright/mcp/cli.js',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(globalRoot, '@playwright', 'mcp', 'cli.js');
    if (fs.existsSync(p)) return p;
  } catch { /* npm not on PATH */ }

  throw new Error('@playwright/mcp not found. Run: npm install -g @playwright/mcp');
}

require(resolvePlaywrightMcpCli());
