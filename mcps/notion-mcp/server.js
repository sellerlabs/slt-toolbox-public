// Entry point for the Notion MCP.
//
// Credentials live in a plain gitignored .env (NOTION_TOKEN), the default per
// the secrets rule (Doppler is opt-in only). NOTION_TOKEN is an internal
// integration token created at https://www.notion.so/profile/integrations.
//
// Reminder that costs everyone a debugging hour: a valid token still returns
// 404 for any page or database that has not been explicitly shared with the
// integration in the Notion UI (Page -> ... -> Connections -> add integration).
// See notion-mcp-Context.md.
await import('./notion-mcp-server.js');
