// Entry point for the Slack MCP.
//
// Credentials live in a plain gitignored .env (SLACK_BOT_TOKEN) — the default
// per the secrets rule (Doppler is opt-in only; the bot token is low-rotation
// and easy to rotate). Any Slack app bot token works.
// The real server
// (slack-mcp-server.js) loads .env itself via dotenv and reads SLACK_BOT_TOKEN.
await import('./slack-mcp-server.js');
