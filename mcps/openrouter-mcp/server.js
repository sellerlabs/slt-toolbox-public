// OpenRouter MCP entry point.
//
// Credentials live in a plain gitignored .env (OPENROUTER_API_KEY) next to this
// file. Doppler is opt-in only and not used here.
//
// The real server lives in openrouter-mcp-server.js.
await import('./openrouter-mcp-server.js');
