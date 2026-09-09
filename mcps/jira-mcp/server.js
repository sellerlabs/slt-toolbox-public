// Entry point for the Atlassian/Jira MCP.
//
// As of 2026-06-27 this MCP no longer uses Doppler — credentials live in a plain
// gitignored .env (JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN), following the default
// (Doppler is opt-in only). The real server (jira-mcp-server.js) reads .env itself
// and uses the JIRA_* keys from process.env, so this entry just hands off to it.
await import('./jira-mcp-server.js');
