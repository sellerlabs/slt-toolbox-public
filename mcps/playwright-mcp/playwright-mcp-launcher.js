const fs = require('fs');
const path = require('path');
const { resolveEngine } = require('./resolve-engine');

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

require(resolveEngine().cli);
