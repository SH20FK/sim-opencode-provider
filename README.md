# sim-opencode-provider

An OpenAI-compatible proxy that brings **Sim's hosted models** (Claude, GPT, Gemini, Grok, Kimi, GLM…) into **OpenCode** — no per-provider API key needed, just a Sim API key.

Sim does not expose an OpenAI-style `/v1/chat/completions` endpoint, and its `llm_chat` tool has no `tools` parameter. This proxy bridges both gaps: it translates the OpenAI chat format to Sim's tool API and **emulates function calling** on top, so an OpenCode agent can actually read files, run shell commands and patch code with those models.

```
OpenCode ──/v1/chat/completions──▶ 127.0.0.1:8787 ──▶ Sim /api/v2/tools/llm_chat/execute
```

## Features

| Feature | Details |
|---|---|
| **Hosted model catalog** | 88 models that work without BYOK, pulled live from Sim (`?all=1` for all 288) |
| **OpenAI chat API** | `POST /v1/chat/completions`, `stream: true` (SSE), `tool_calls` responses |
| **Tool-call emulation** | tool schemas injected at the end of the transcript, answers parsed back into `tool_calls` (JSON and `<invoke>` XML) |
| **Argument repair** | type coercion, unknown keys dropped, missing required fields filled, duplicates removed |
| **Nudge loop** | malformed tool attempt triggers an automatic re-ask (configurable) |
| **Built-in proxy tools** | `now`, `web_fetch` (HTML→text, private IPs blocked), `web_search` (DuckDuckGo) — executed by the proxy, invisible to the client |
| **Response cache** | SHA-1 of model + prompt, TTL 10 min, LRU (plain chat only) |
| **Model fallback** | retry on `402/404/429/5xx` against a fallback model |
| **SSE keepalive** | pings every 10 s while Sim is thinking |
| **Stats** | `/stats`: requests, tool calls, tokens, cache hits, per-model latency |
| **Setup wizard + panel** | `setup.bat` / `manage.bat` — API key, workspace autodetect, port, autostart, logs, tests |
| **Zero dependencies** | Node built-ins only, single file proxy |

## Requirements

- Node.js **20+**
- A Sim account and API key (`sk-sim-…`) — Settings → API keys on [sim.ai](https://www.sim.ai)

## Quick start (Windows)

```bat
setup.bat     :: wizard: API key -> workspace -> model check -> port -> autostart
manage.bat    :: control panel (start / stop / status / logs / settings / test)
```

Then in OpenCode: `/models` → **Sim (free)** → pick a model.

## Quick start (any OS)

```bash
cp config.example.json config.json     # then fill simApiKey + workspaceId
node cli.mjs setup                     # or edit the file by hand
node server.mjs
```

Check it:

```bash
curl http://127.0.0.1:8787/health
node tests/smoke.mjs
```

## OpenCode provider

`~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "sim": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Sim (free)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "sim-local"
      },
      "models": {
        "claude-sonnet-5-5": {
          "name": "Claude Sonnet 5.5 (Sim)",
          "limit": { "context": 200000, "output": 32000 },
          "cost": { "input": 0, "output": 0 }
        },
        "gpt-5.3-codex": {
          "name": "GPT 5.3 Codex (Sim)",
          "limit": { "context": 400000, "output": 128000 },
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  }
}
```

`apiKey` here is a dummy value — OpenCode requires the field, the proxy ignores it. The real Sim key lives in `config.json`.

## Configuration

`config.json` (git-ignored; start from `config.example.json`):

| Key | Default | Meaning |
|---|---|---|
| `simApiKey` | — | Sim API key (`sk-sim-…`) |
| `workspaceId` | — | Sim workspace ID (the wizard detects it) |
| `workflowId` | `""` | optional, only for the "run workflow" menu item |
| `port` | `8787` | local port (binds `127.0.0.1` only) |
| `toolEmulation` | `true` | inject tool schemas into the prompt |
| `toolTemperature` | `0` | temperature used in tool mode (keeps JSON strict) |
| `maxConcurrent` | `2` | parallel Sim calls (free plan allows 2) |
| `requestTimeoutMs` | `290000` | per-call timeout |
| `fallbackModel` | `""` | retry model on upstream errors |
| `cache.enabled` | `true` | response cache |
| `cache.ttlMs` | `600000` | cache TTL |
| `proxyTools.now/web_fetch/web_search` | `true` | built-in tools |
| `nudge.maxRetries` | `2` | re-asks on a malformed tool call |
| `maxProxyToolHops` | `3` | internal tool-round limit |

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, model count, feature flags |
| `GET` | `/stats` | counters and per-model latency |
| `GET` | `/v1/models` | hosted model IDs (`?all=1` for the full catalog) |
| `POST` | `/v1/chat/completions` | OpenAI chat format, streaming supported |

## How tool emulation works

1. OpenCode sends `tools` (JSON Schema) with every request.
2. The proxy appends a strict "tool calling protocol" block **after** the transcript (closest to generation) plus the schemas.
3. The model replies with `{"tool_calls":[{"name":"read","arguments":{...}}]}`.
4. The proxy validates arguments against the schema, repairs types, and returns a standard OpenAI `tool_calls` message.
5. OpenCode executes the tool locally and sends the result back as `role: "tool"`; the proxy flattens it into the transcript and continues.

If the model answers with prose or broken XML instead, the proxy nudges it once or twice before giving up.

## Limitations

- **Emulation is not native function calling.** A model may skip a tool, claim success without calling anything, or repeat a call. Nudge/dedup/repair reduce this, not eliminate it.
- **No true streaming.** Sim returns the whole completion; SSE chunks are replayed afterwards.
- **No prompt caching** on the `llm_chat` path (Sim only offers it inside workflow Agent blocks), so every step re-sends the full context.
- **Free plan limits:** 2 concurrent runs, 300 s per call, 1000 credits (~1 credit per run, hosted models billed at 0).
- **Unofficial.** If Sim starts billing tool calls or removes hosted models, the proxy returns `401/402` — that cannot be fixed client-side.

## Security

- The proxy binds to `127.0.0.1` only.
- `config.json` stores the Sim key in plaintext — keep it out of git (already in `.gitignore`) and don't paste it into issues.
- `web_fetch` refuses loopback/private addresses, but it is not a hardened sandbox: treat model-generated URLs as untrusted.

## License

MIT — see [LICENSE](LICENSE).

---

Русская версия: [README.ru.md](README.ru.md)
