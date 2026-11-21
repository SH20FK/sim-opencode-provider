# Changelog

## 2.0.0

- Restructured into `src/` and `docs/`; CLI and panel redesigned.
- `src/opencode.mjs`: one-command install / inspect / remove of the OpenCode provider, with timestamped backups.
- Setup wizard now offers automatic provider install and drops the workflow prompt.
- Panel trimmed to 7 actions: start/restart, stop, status, OpenCode, test, settings, logs.
- ASCII splash in the launchers, colored panel inside the CLI.
- `SIM_PROVIDER_CONFIG` and `OPENCODE_CONFIG` overrides for testing.

## 1.0.0

- OpenAI-compatible `/v1/chat/completions` and `/v1/models` backed by Sim's `llm_chat`.
- Tool-call emulation from prompt to `tool_calls` (JSON, with `<invoke>` XML fallback).
- Setup wizard and control panel (`setup.bat`, `manage.bat`, `cli.mjs`).
- Response cache, fallback model, SSE keepalive, stats endpoint.
- Built-in proxy tools: `now`, `web_fetch`, `web_search`.
- Argument repair, dedup and nudge loop for malformed tool calls.
