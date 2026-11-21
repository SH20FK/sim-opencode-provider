# Подключение к OpenCode

Прокси отдаёт OpenAI-совместимый API на `http://127.0.0.1:8787/v1`, поэтому в OpenCode он подключается как обычный провайдер с `@ai-sdk/openai-compatible`.

## Что понадобится

- запущенный прокси (`manage.bat` → 1, или автозапуск)
- OpenCode, запущенный хотя бы раз (он создаёт `~/.config/opencode/opencode.json`)
- Node.js 20+ (для прокси, не для OpenCode)

## Способ 1 — автоматически (рекомендуется)

```
manage.bat → 4 (Подключить к OpenCode) → 1 (Установить / обновить)
```

Или из консоли:

```powershell
node src/cli.mjs opencode-install
```

Что произойдёт:

1. Найдётся `~/.config/opencode/opencode.json` (на Windows — `C:\Users\<имя>\.config\opencode\opencode.json`).
2. Рядом появится бэкап `opencode.json.bak-sim-2026-11-21T18-30-00`.
3. В объект `provider` добавится ключ `sim` с 22 моделями и вашим `baseURL`.
4. Остальные провайдеры, модели и `mcp`-серверы не трогаются.

Проверить:

```powershell
node src/cli.mjs opencode-status
```

## Способ 2 — вручную

Откройте `opencode.json` и добавьте в объект `"provider"` (рядом с другими провайдерами):

```json
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
```

Правила, на которых спотыкаются:

- ключ `model-id` должен совпадать с id модели **побайтово** (`claude-sonnet-5-5`, а не `Claude Sonnet 5.5`);
- `"sim-local"` — заглушка: OpenCode требует непустой `apiKey`, прокси его не проверяет;
- запятые между блоками — JSON не прощает лишнюю;
- после правки перезапустить OpenCode.

## Как выбрать модель

1. Запустить OpenCode в проекте.
2. `/models` → **Sim (free)**.
3. Выбрать модель (например `Claude Sonnet 5.5 (Sim)`).
4. Задать вопрос. В логе прокси (`manage.bat` → 7) видно каждый шаг: `chat claude-sonnet-5-5 ok in 2740ms · tools=13+3 · EMULATED 1: read`.

## Что выбрать под задачу

| Задача | Модель | Почему |
|---|---|---|
| агент правит код | `gpt-5.3-codex`, `claude-sonnet-5-5` | лучше всех держат формат тулов |
| быстрый чат/объяснения | `gemini-3.8-flash`, `glm-5.3-flash` | дешёвые по латентности |
| длинный контекст | `gemini-3.1-pro-preview` (1M), `gpt-5.4` (400k) | большие окна |
| сложное рассуждение | `claude-opus-5-5`, `gpt-5.6-sol` | медленнее, но точнее |

## Проверка, что всё живо

```powershell
curl http://127.0.0.1:8787/health        # {"ok":true,...}
curl http://127.0.0.1:8787/v1/models     # список id
node tests/smoke.mjs                     # 7 проверок подряд
```

## Частые проблемы

| Симптом | Причина | Что делать |
|---|---|---|
| `connection refused` в OpenCode | прокси не запущен | `manage.bat` → 1 |
| модель отвечает «not found» | id в конфиге не совпал | скопировать точный id из `/v1/models` |
| `401 API key is required` | модель не hosted (нужен BYOK) | взять модель из списка hosted (`node src/cli.mjs models`) |
| `402` | кончились кредиты/лимит Sim | проверить баланс в Sim |
| агент пишет «готово», но файл не создан | модель не вызвала тул | повторить запрос; сменить модель на codex/sonnet |
| OpenCode перезаписал конфиг | редактировался через UI | установить провайдера заново пунктом 4 |

## Как убрать

```
manage.bat → 4 → 2 (Удалить провайдера)
```

или

```powershell
node src/cli.mjs opencode-remove
```

Бэкап `opencode.json.bak-sim-*` остаётся рядом — можно откатиться вручную.
