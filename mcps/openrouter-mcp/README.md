# openrouter-mcp

MCP server for [OpenRouter](https://openrouter.ai): one API key that reaches ~400 models from every major vendor through an OpenAI-compatible endpoint. Use it for second opinions from models you have no dedicated connector for, multi-model panels, vision/OCR, and image generation.

## Tools

| Tool | What it does |
|---|---|
| `openrouter_chat` | Ask any model a question, optionally with images attached (vision/OCR). |
| `openrouter_list_models` | Search the catalog with context window and price per million tokens, cheapest first. |
| `openrouter_usage` | Credit balance, total spend, and this key's daily / weekly / monthly usage. |
| `openrouter_panel` | One prompt to several models in parallel, answers side by side. Capped at 4. |
| `openrouter_benchmarks` | Rank models by independent quality scores (Artificial Analysis, OpenRouter evals, Design Arena). |
| `openrouter_image` | Generate an image from a text prompt and save it to disk. |

| Tool | Required | Optional |
|---|---|---|
| `openrouter_chat` | `prompt` | `system`, `model`, `temperature`, `max_tokens`, `images` |
| `openrouter_list_models` | none | `search`, `free_only`, `sort`, `limit` (default 20, max 100) |
| `openrouter_benchmarks` | none | `source` (`aa` default, `openrouter`, `design-arena`), `metric`, `search`, `limit` (default 10) |
| `openrouter_usage` | none | none |
| `openrouter_panel` | `prompt` | `models[]`, `system`, `max_tokens` |
| `openrouter_image` | `prompt` | `model`, `filename`, `out_dir`, `max_tokens` |

Every response ends with a `[model: ... | tokens: ... | cost: ...]` footer carrying the real per-call cost in USD.

## Setup

```
npm install
cp .env.example .env      # then paste your key from https://openrouter.ai/keys
npm start                 # stdio server, expects an MCP client on stdin
```

The key is read lazily at call time, so the server boots and lists its tools with no key present. Everything else in `.env.example` is optional. Generated images land in `output/` next to the server unless you set `OPENROUTER_IMAGE_DIR` or pass `out_dir`.

As a lazy-hub child:

```json
"openrouter": { "command": "node", "args": ["--use-system-ca", "server.js"], "cwd": "../openrouter-mcp", "env": [], "callTimeout": 120000 }
```

## Gotchas

- **Use `openrouter_image` for image generation, never `openrouter_chat`.** Image models return the picture in `message.images[]`, not `message.content`, so a chat call returns an empty response and still bills.
- **Images bill per token.** Around $0.03 per image on the cheapest image model, far more than a dedicated image API. Fine for one-off art, wrong for volume.
- **Vision input needs a vision-capable model.** Pass local paths (`.jpg/.jpeg/.png/.gif/.webp`, inlined as base64) or `https://` URLs in `images`, and set `model` explicitly.
- **Reasoning models need a big `max_tokens`.** Hidden reasoning eats the budget: too low and you get empty content (flagged) or a silently truncated sentence (not flagged). Use 1500+ for anything real.
- **`openrouter_usage` lags.** Credits can read $0 right after a paid call. The per-call footer cost is the accurate figure.
- **Free models are for smoke tests.** They are rate-limited from a shared upstream pool (HTTP 429 is normal), answer unreliably, and the `:free` suffix gets withdrawn without notice. Re-check with `free_only: true` instead of hardcoding one.
- **`:batch` variants sort to the top of price searches** because they are cheapest. They have different latency semantics.
- **Popularity is not quality.** For "best model" questions use `openrouter_benchmarks`, not price sorting or usage leaderboards.
- **Out of credit** returns HTTP 402; top up at https://openrouter.ai/credits.
