# sim-opencode-provider

Hosted-модели Sim в OpenCode. Локальный OpenAI-совместимый прокси + эмуляция tool calling, чтобы агент реально читал файлы, запускал команды и правил код.

```
OpenCode ──▶ 127.0.0.1:8787 ──▶ Sim /api/v2/tools/llm_chat/execute
```

## Запуск

```bat
setup.bat     :: ключ Sim -> автопоиск воркспейса -> порт -> автозапуск -> OpenCode
manage.bat    :: панель: старт, стоп, статус, OpenCode, тест, настройки, логи
```

Нужен Node.js 20+ и ключ `sk-sim-…` с [sim.ai](https://www.sim.ai).

## OpenCode

Автоматически: `manage.bat` → `4` → `1` (бэкап конфига делается сам).

Или вручную в `~/.config/opencode/opencode.json`:

```json
"sim": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Sim (free)",
  "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "sim-local" },
  "models": {
    "claude-sonnet-5-5": {
      "name": "Claude Sonnet 5.5 (Sim)",
      "limit": { "context": 200000, "output": 32000 },
      "cost": { "input": 0, "output": 0 }
    }
  }
}
```

Затем перезапустить OpenCode → `/models` → **Sim (free)**.

`apiKey` — заглушка, настоящий ключ лежит в `config.json` прокси.

## Что умеет

- 88 hosted-моделей (Claude 5.5, GPT-5.6/5.3-codex, Gemini 4, Grok 4.7, Kimi K3, GLM 5.3)
- эмуляция тулов: JSON и XML, починка аргументов по схеме, дедуп, переспрос
- длинные ответы режутся на части и склеиваются — Sim обрывает один вызов на ~120 с
- части уходят в поток по мере готовности, размер части подстраивается под модель
- свои тулы `now`, `web_fetch`, `web_search`
- кеш ответов, fallback-модель, SSE keepalive, статистика `/stats` и остаток кредитов
- без зависимостей

## Ограничения

- эмуляция ≠ нативный function calling: модель может пропустить тул или соврать «готово»
- стриминга от Sim нет: внутри одной части ответ приходит целиком
- один вызов Sim не дольше ~120 с, поэтому очень длинный ответ идёт в несколько приёмов и получается медленнее

Логи лежат в `%LOCALAPPDATA%\sim-opencode-provider\`, а не в папке проекта.

`config.json` в `.gitignore` — ключ не попадёт в репозиторий.

MIT
