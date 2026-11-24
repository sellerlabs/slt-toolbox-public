// Locates @playwright/mcp for all three entry points, so they agree on one engine.
// Order: local node_modules, standard global locations, `npm root -g`.
//
// The visible server loads internals (lib/mcp/browser/...) that @playwright/mcp
// 0.0.69 removed. Installs without them are skipped; 0.0.68 is the tested version.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENGINE_VERSION = require('./package.json').dependencies['@playwright/mcp'];

const REQUIRED_INTERNALS = ['browser/browserServerBackend', 'browser/config', 'browser/tab', 'sdk/http']
  .map((m) => 'lib/mcp/' + m);

// npm hoists `playwright` beside @playwright in a local install but nests it under
// @playwright/mcp in a global one. Resolving from the engine's folder covers both.
function playwrightDirFor(mcpDir) {
  return path.dirname(require.resolve('playwright/package.json', { paths: [mcpDir] }));
}

function* candidateDirs() {
  // Resolve package.json, not cli.js: the package's `exports` map blocks cli.js.
  try {
    yield path.dirname(require.resolve('@playwright/mcp/package.json'));
  } catch (e) { /* not installed locally */ }
  if (process.env.APPDATA) yield path.join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'mcp');
  yield '/opt/homebrew/lib/node_modules/@playwright/mcp';
  yield '/usr/local/lib/node_modules/@playwright/mcp';
  yield '/usr/lib/node_modules/@playwright/mcp';
  try {
    yield path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@playwright', 'mcp');
  } catch (e) { /* npm not on PATH */ }
}

function resolveEngine() {
  const rejected = [];
  for (const mcpDir of candidateDirs()) {
    if (!fs.existsSync(path.join(mcpDir, 'package.json'))) continue;
    const { version } = JSON.parse(fs.readFileSync(path.join(mcpDir, 'package.json'), 'utf8'));
    try {
      const playwrightDir = playwrightDirFor(mcpDir);
      for (const m of REQUIRED_INTERNALS) require.resolve(path.join(playwrightDir, m));
      return { mcpDir, playwrightDir, cli: path.join(mcpDir, 'cli.js'), version };
    } catch (e) {
      rejected.push(`${version} at ${mcpDir}`);
    }
  }
  throw new Error(
    `No compatible @playwright/mcp found (need ${ENGINE_VERSION}). Run \`npm install\` in ${__dirname}, ` +
    `or: npm install -g @playwright/mcp@${ENGINE_VERSION}` +
    (rejected.length ? `. Skipped incompatible: ${rejected.join('; ')}` : ''));
}

module.exports = { resolveEngine };
