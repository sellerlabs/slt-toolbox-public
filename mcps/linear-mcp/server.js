// Entry point for the Linear MCP.
//
// Credentials live in a plain gitignored .env (LINEAR_API_KEY), the default per
// the secrets rule (Doppler is opt-in only). Create the key at
// Linear -> Settings -> Account -> Security & Access -> Personal API keys.
//
// Reminder that costs everyone a debugging hour: a Linear PERSONAL API key goes
// in the Authorization header RAW. There is no "Bearer " prefix. OAuth access
// tokens use Bearer; personal keys do not, and sending one with Bearer returns
// a 400 AUTHENTICATION_ERROR that reads like a bad key. See Linear-MCP-Context.md.
await import('./linear-mcp-server.js');
