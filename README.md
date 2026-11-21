# sim-opencode-provider

**Bring Sim's hosted models into OpenCode.** An OpenAI-compatible proxy that also emulates tool calling, so an agent can read files, run shell commands and patch code — no per-provider API key required.

```
OpenCode ──/v1/chat/completions──▶ 127.0.0.1:8787 ──▶ Sim /api/v2/tools/llm_chat/execute
```

Sim exposes no OpenAI-style endpoint, and its `llm_chat` tool has no `tools` parameter. This proxy bridges both gaps: translates the chat format and turns prompt-level tool calls back into standard `tool_calls`.

## Features

- **88 hosted models** out of the box (Claude Opus/Sonnet 5.5, GPT-5.6/5.3-codex, Gemini 4, Grok 4.7, Kimi K3, GLM 5.3…) — catalog pulled live from Sim
- **Tool-call emulation** with JSON **and** `<invoke>` XML parsing
- **Argument repair** — type coercion, unknown keys dropped, required fields filled, duplicates removed
- **Nudge loop** — malformed tool attempt triggers an automatic re-ask
- **Built-in tools** executed by the proxy: `now`, `web_fetch`, `web_search`
- **Response cache**, **model fallback**, **SSE keepalive**, **retries**, **parallelism cap**
- **Stats** at `/stats`, structured request log
- **Setup wizard + control panel** (`setup.bat` / `manage.bat`) with automatic OpenCode provider install
- **Zero dependencies** — Node built-ins only

## Structure

```
sim-opencode-provider/
├─ src/
│  ├─ server.mjs        HTTP proxy, emulation, cache, proxy tools
│  ├─ cli.mjs           setup wizard + control panel
│  └─ opencode.mjs      install / inspect / remove the OpenCode provider
├─ docs/
│  ├─ opencode.md       step-by-step OpenCode integration (RU)
│  ├─ configuration.md  every config key and tuning recipe (RU)
│  └─ architecture.md   request flow and design limits (RU)
├─ tests/smoke.mjs      7 end-to-end checks
├─ setup.bat / manage.bat / start.cmd / start-hidden.vbs
├─ config.example.json
└─ .github/workflows/ci.yml
```

## Install

Requirements: Node.js 20+, a Sim account and API key (`sk-sim-…`).

### Windows (one click)

```bat
setup.bat     :: wizard: key -> workspace -> model check -> port -> autostart -> OpenCode
manage.bat    :: control panel
```

### Any OS

```bash
cp config.example.json config.json    # fill simApiKey + workspaceId
node src/server.mjs
curl http://127.0.0.1:8787/health
node tests/smoke.mjs
```

## Connect to OpenCode

```powershell
node src/cli.mjs opencode-install
```

Adds a `sim` provider to `~/.config/opencode/opencode.json` (with a timestamped backup), then `/models` → **Sim (free)**.

Manual JSON, model picks and troubleshooting: **[docs/opencode.md](docs/opencode.md)**.

## CLI

| Command | Purpose |
|---|---|
| `node src/cli.mjs` | panel |
| `node src/cli.mjs setup` | wizard |
| `start` / `stop` / `restart` / `status` | proxy lifecycle |
| `test` | one live request |
| `logs [n]` / `models` | diagnostics |
| `opencode-install` / `opencode-remove` / `opencode-status` | OpenCode integration |
| `autostart-on` / `autostart-off` | Windows startup entry |

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, model count, flags |
| `GET` | `/stats` | counters, per-model latency |
| `GET` | `/v1/models` | hosted ids (`?all=1` — full catalog) |
| `POST` | `/v1/chat/completions` | OpenAI chat, streaming |

## Limitations

- Emulation is **not** native function calling: a model may skip a tool or claim success without calling one.
- **No true streaming** — Sim returns the whole completion; SSE chunks are replayed.
- **No prompt caching** on the `llm_chat` path, so every step re-sends the full context.
- Sim free plan: 2 concurrent runs, 300 s per call, 1000 credits (~1 per run).
- Unofficial integration — if Sim changes its billing or model catalog, the proxy can start returning `401/402`.

## Security

- Binds to `127.0.0.1` only.
- `config.json` holds the Sim key in plaintext and is git-ignored — never commit it.
- `web_fetch` blocks loopback/private addresses, but is not a sandbox: treat model-supplied URLs as untrusted.

## License

MIT — [LICENSE](LICENSE). Русская версия: [README.ru.md](README.ru.md).
