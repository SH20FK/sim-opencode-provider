# Конфигурация и настройка

Все настройки — в `config.json` в корне репозитория. Файл в `.gitignore`; шаблон — `config.example.json`. Править можно руками или через `manage.bat` → 6.

```json
{
  "simApiKey": "sk-sim-…",
  "workspaceId": "…",
  "workflowId": "",
  "port": 8787,
  "toolEmulation": true,
  "toolTemperature": 0,
  "maxConcurrent": 2,
  "requestTimeoutMs": 290000,
  "fallbackModel": "claude-sonnet-5-5",
  "cache": { "enabled": true, "ttlMs": 600000, "maxEntries": 200 },
  "proxyTools": { "now": true, "web_fetch": true, "web_search": true },
  "nudge": { "enabled": true, "maxRetries": 2 },
  "maxProxyToolHops": 3
}
```

## Ключи

| Ключ | По умолчанию | Что делает |
|---|---|---|
| `simApiKey` | — | ключ Sim `sk-sim-…`; мастер проверяет его на входе |
| `workspaceId` | — | воркспейс Sim; мастер находит автоматически по ключу |
| `workflowId` | `""` | не используется прокси, оставлено на будущее |
| `port` | `8787` | локальный порт, слушается только `127.0.0.1` |
| `toolEmulation` | `true` | подставлять схемы тулов в промпт; выключить = чистый чат |
| `toolTemperature` | `0` | температура в режиме тулов; 0 держит JSON строгим |
| `maxConcurrent` | `2` | параллельные вызовы Sim (free-план — 2) |
| `requestTimeoutMs` | `290000` | таймаут вызова (лимит Sim — 300 с) |
| `fallbackModel` | `""` | модель для повтора при `402/404/429/5xx` |
| `cache.enabled` | `true` | кеш ответов (только чат без тулов) |
| `cache.ttlMs` | `600000` | время жизни записи кеша |
| `cache.maxEntries` | `200` | размер кеша (LRU) |
| `proxyTools.now` | `true` | тул `now` — текущее время |
| `proxyTools.web_fetch` | `true` | тул `web_fetch` — текст страницы |
| `proxyTools.web_search` | `true` | тул `web_search` — DuckDuckGo |
| `nudge.enabled` | `true` | переспрос при сломанном вызове тула |
| `nudge.maxRetries` | `2` | сколько раз переспрашивать |
| `maxProxyToolHops` | `3` | внутренние раунды своих тулов |

## Рецепты

**Модель часто «забывает» вызвать тул** → сменить на `gpt-5.3-codex` или `claude-sonnet-5-5`, оставить `toolTemperature: 0`, увеличить `nudge.maxRetries` до 3.

**Ответы приходят слишком медленно** → `toolEmulation: false` (чистый чат без тулов, один вызов вместо цикла), либо модель `gemini-3.8-flash`.

**Нужно сэкономить кредиты** → `cache.enabled: true`, `maxConcurrent: 1` (последовательные вызовы реже ловят лимит).

**Не нужны свои тулы** → выключить `proxyTools.*`; модели перестанут видеть `now`/`web_fetch`/`web_search`.

**Порт занят** → `manage.bat` → 6 → 1, новый порт, перезапуск; затем пункт 4 обновит `baseURL` в OpenCode.

## Переменные окружения

| Переменная | Значение |
|---|---|
| `OPENCODE_CONFIG` | путь к `opencode.json` вместо стандартного (удобно для тестов) |
| `SIM_CLI_SPLASH` | `1` — не печатать ASCII-баннер в панели (ставится батниками) |
| `PROXY_URL`, `MODEL` | для `tests/smoke.mjs` |

## Логи и диагностика

- `server.log` — запросы: модель, время, число тулов, эмуляции, токены.
- `server.err.log` — падения.
- `GET /stats` — счётчики в реальном времени.
- `GET /health` — живость и флаги.
- `node src/cli.mjs logs 50` — хвост логов.
