# sim-opencode-provider

> ## ⛔ Не работает с 23 ноября 2026
>
> Sim закрыл hosted-ключи на бесплатном плане. Любая модель теперь отвечает:
>
> ```
> <model> with Sim's hosted key is available on paid plans.
> Upgrade your plan, or add your own API key under Settings > BYOK.
> ```
>
> Проверено: 12 моделей подряд (Claude, GPT, Gemini, Grok, Kimi, GLM) и workflow-агент — отказ
> у всех. Кредиты при этом на месте (997/1000), план `free`, `active`, так что это смена политики
> Sim, а не исчерпанный лимит.
>
> Проект остаётся рабочим только в двух случаях:
> — **BYOK**: свои ключи провайдеров, в настройках Sim (Settings → BYOK) или в `config.json` → `"byok"`;
> — **платный план Sim** или self-host.
>
> Если ключей нет, проще ходить в OpenCode к провайдеру напрямую (Google AI Studio, Groq,
> OpenRouter) — там нативный стриминг и tool calling, без прослойки. Подробнее — в разделе
> [«Статус»](#статус).

Hosted-модели Sim в OpenCode. Локальный OpenAI-совместимый прокси + эмуляция tool calling, чтобы агент реально читал файлы, запускал команды и правил код.

```
OpenCode ──▶ 127.0.0.1:8787 ──▶ Sim /api/v2/tools/llm_chat/execute
```

## Статус

**23.11.2026 — бесплатный доступ к hosted-моделям закрыт.**

Что проверено на живом API:

| проверка | результат |
|---|---|
| `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-2` | `available on paid plans` |
| `gpt-5.4`, `gpt-5.4-mini`, `gemini-3.8-flash`, `grok-4.7` | то же |
| `kimi-k3`, `glm-5.3` | то же |
| `deepseek-v4-pro` | `Provider "deepseek" is not available` |
| workflow-агент (`executeWorkflow`) | то же сообщение про paid plans |
| `billing/status` | план `free`, `active`, кредитов 997/1000 |

Воркфлоу не помогает: модель внутри Agent-блока ходит через тот же hosted-ключ.

Варианты, если проект ещё нужен:

1. **BYOK в Sim** — Settings → BYOK, ключ Anthropic / OpenAI / Google. Модели идут на твоём ключе.
2. **BYOK в прокси** — `config.json`:
   ```json
   "byok": { "claude-sonnet-5-5": "sk-ant-…" }
   ```
   Прокси передаст ключ в `llm_chat` (`input.apiKey`), настройки Sim трогать не надо.
3. **Платный план Sim** или **self-host** (Sim open source, docker-compose, ключи свои).
4. **Напрямую в OpenCode** к бесплатному провайдеру (Google AI Studio, Groq, OpenRouter) — без этого прокси.

Ошибка теперь возвращается как `402` с внятным текстом, а не `502`.

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

`apiKey` — локальный токен прокси (генерируется при установке и лежит в `config.json`). Ключ Sim в OpenCode не попадает.

## Что умеет

- 88 hosted-моделей (Claude 5.5, GPT-5.6/5.3-codex, Gemini 4, Grok 4.7, Kimi K3, GLM 5.3)
- эмуляция тулов: JSON и XML, починка аргументов по схеме, дедуп, переспрос
- длинные ответы режутся на части и склеиваются; один вызов Sim можно растянуть до 300 с (`simTimeoutSec`)
- части уходят в поток по мере готовности, размер части подстраивается под модель и запоминается
- устаревшие чтения одного файла выкидываются из контекста
- свои тулы `now` и `web_fetch`
- кеш ответов: на диске (`cache.json`), переживает перезапуск, LRU по числу и размеру, TTL общий и по моделям
- метрики за последний час: p50/p95, доля 429 и таймаутов, размер ответа, попадания в кеш — `node src/cli.mjs stats` или `/stats`
- реальные лимиты моделей: при установке контекст и выход берутся из models.dev (`node src/cli.mjs limits`), а не 200k/32k для всех
- BYOK: ключ провайдера на модель (`"byok": {"claude-sonnet-5-5": "sk-ant-…"}`) — нужен, если у Sim бесплатный план больше не даёт hosted-ключи
- псевдо-стриминг (по умолчанию выключен): готовый текст можно отдавать порциями по 12 символов, а не одним блоком (`streamPacing`)
- чистка мусора в ответах: `<br>`-лавины (бывает у Haiku 5.5) превращаются в переводы строк
- fallback-модель отключена: при таймауте повторяем ту же модель, а не подменяем её другой
- SSE keepalive, трейс `/trace`
- остаток кредитов Sim и последние ошибки в панели
- бенчмарк моделей: скорость, reasoning, тул и JSON → таблица на рабочем столе
- локальный токен, чтобы прокси не использовали другие приложения
- без зависимостей

## Ограничения

- эмуляция ≠ нативный function calling: модель может пропустить тул или соврать «готово»
- стриминга от Sim нет: внутри одной части ответ приходит целиком
- один вызов Sim не дольше ~120 с, поэтому очень длинный ответ идёт в несколько приёмов и получается медленнее

Логи лежат в `%LOCALAPPDATA%\sim-opencode-provider\`, а не в папке проекта.

`config.json` в `.gitignore` — ключ не попадёт в репозиторий.

MIT
