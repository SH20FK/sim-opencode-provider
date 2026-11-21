# sim-opencode-provider

**Hosted-модели Sim внутри OpenCode.** OpenAI-совместимый прокси, который вдобавок эмулирует tool calling — агент реально читает файлы, запускает команды и правит код, без ключей отдельных провайдеров.

```
OpenCode ──/v1/chat/completions──▶ 127.0.0.1:8787 ──▶ Sim /api/v2/tools/llm_chat/execute
```

У Sim нет OpenAI-эндпоинта, а у `llm_chat` нет параметра `tools`. Прокси закрывает оба пробела: переводит формат и превращает вызовы тулов из промпта обратно в стандартные `tool_calls`.

## Возможности

- **88 hosted-моделей** из коробки (Claude Opus/Sonnet 5.5, GPT-5.6/5.3-codex, Gemini 4, Grok 4.7, Kimi K3, GLM 5.3…) — каталог тянется из Sim
- **Эмуляция тулов** с разбором JSON **и** XML `<invoke>`
- **Починка аргументов** — типы, лишние ключи, обязательные поля, дедуп
- **Nudge** — сломанный вызов → автоматический переспрос
- **Свои тулы**: `now`, `web_fetch`, `web_search` (исполняет прокси)
- **Кеш ответов**, **fallback-модель**, **SSE keepalive**, **ретраи**, **лимит параллельности**
- **Статистика** `/stats` и структурный лог запросов
- **Мастер + панель** (`setup.bat` / `manage.bat`) с автоподключением провайдера в OpenCode
- **Без зависимостей** — только встроенные модули Node

## Структура

```
sim-opencode-provider/
├─ src/
│  ├─ server.mjs        прокси, эмуляция, кеш, свои тулы
│  ├─ cli.mjs           мастер настройки и панель
│  └─ opencode.mjs      установка/удаление провайдера в OpenCode
├─ docs/
│  ├─ opencode.md       подробная инструкция подключения
│  ├─ configuration.md  все настройки и рецепты
│  └─ architecture.md   как устроено и где пределы
├─ tests/smoke.mjs      7 сквозных проверок
├─ setup.bat / manage.bat / start.cmd / start-hidden.vbs
├─ config.example.json
└─ .github/workflows/ci.yml
```

## Установка

Нужен Node.js 20+, аккаунт Sim и ключ (`sk-sim-…`).

### Windows (в один клик)

```bat
setup.bat     :: мастер: ключ -> воркспейс -> проверка модели -> порт -> автозапуск -> OpenCode
manage.bat    :: панель управления
```

### Любая ОС

```bash
cp config.example.json config.json    # вписать simApiKey + workspaceId
node src/server.mjs
curl http://127.0.0.1:8787/health
node tests/smoke.mjs
```

## Подключение к OpenCode

```powershell
node src/cli.mjs opencode-install
```

Добавляет провайдера `sim` в `~/.config/opencode/opencode.json` (с бэкапом), затем `/models` → **Sim (free)**.

Ручной JSON, выбор моделей и разбор проблем: **[docs/opencode.md](docs/opencode.md)**.

## CLI

| Команда | Что делает |
|---|---|
| `node src/cli.mjs` | панель |
| `node src/cli.mjs setup` | мастер |
| `start` / `stop` / `restart` / `status` | жизненный цикл прокси |
| `test` | один живой запрос |
| `logs [n]` / `models` | диагностика |
| `opencode-install` / `opencode-remove` / `opencode-status` | интеграция с OpenCode |
| `autostart-on` / `autostart-off` | автозапуск Windows |

## HTTP API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | живость, число моделей, флаги |
| `GET` | `/stats` | счётчики и задержки по моделям |
| `GET` | `/v1/models` | hosted-id (`?all=1` — весь каталог) |
| `POST` | `/v1/chat/completions` | чат OpenAI, стриминг |

## Ограничения

- Эмуляция — **не** нативный function calling: модель может пропустить тул или соврать «готово».
- **Настоящего стриминга нет** — SSE нарезается после получения ответа.
- **Нет кеша промпта** на пути `llm_chat`, поэтому каждый шаг отправляет весь контекст заново.
- Free-план Sim: 2 параллельных запуска, 300 с на вызов, 1000 кредитов (~1 за запуск).
- Интеграция неофициальная: если Sim поменяет биллинг или каталог, прокси начнёт отдавать `401/402`.

## Безопасность

- Слушает только `127.0.0.1`.
- `config.json` хранит ключ Sim в открытом виде и лежит в `.gitignore` — не коммитить.
- `web_fetch` блокирует loopback/приватные адреса, но это не песочница: URL от модели считай недоверенными.

## Лицензия

MIT — [LICENSE](LICENSE). English: [README.md](README.md).
