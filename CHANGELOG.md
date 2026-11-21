# Changelog

## 1.0.0

- OpenAI-compatible `/v1/chat/completions` and `/v1/models` backed by Sim's `llm_chat`.
- Tool-call emulation from prompt to `tool_calls` (JSON, with `<invoke>` XML fallback).
- Setup wizard and control panel (`setup.bat`, `manage.bat`, `cli.mjs`).
- Response cache, fallback model, SSE keepalive, stats endpoint.
- Built-in proxy tools: `now`, `web_fetch`, `web_search`.
- Argument repair, dedup and nudge loop for malformed tool calls.
