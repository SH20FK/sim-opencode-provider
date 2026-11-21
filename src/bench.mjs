// Model benchmark: speed, reasoning overhead, tool-call and JSON reliability.
//
//   node src/cli.mjs bench            # curated list
//   node src/cli.mjs bench --all      # every hosted model
//   node src/cli.mjs bench --models=a,b,c
//
// The speed probe talks to Sim directly (so it also gets the per-model price),
// the tool probe goes through the proxy so it exercises the real pipeline.

import fs from 'node:fs'

const SIM = 'https://www.sim.ai/api/v2'

const SPEED_PROMPT = 'Напиши связный текст примерно на 150 слов про море, маяки и корабли. Без заголовков и списков.'
const JSON_PROMPT =
  'Ответь только JSON-объектом с полями ok (логическое true) и n (число 2). Без пояснений, без markdown, без текста вокруг.'
const TOOL_PROMPT = 'Прочитай файл package.json и скажи, какая там версия. Сначала вызови инструмент read.'

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
    },
  },
]

async function simCall({ simApiKey, workspaceId, model, context, timeoutMs = 200000 }) {
  const t0 = Date.now()
  const res = await fetch(`${SIM}/tools/llm_chat/execute`, {
    method: 'POST',
    headers: { 'X-API-Key': simApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, input: { model, context } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {}
  const d = data.data || {}
  const out = d.output || {}
  return {
    ms: Date.now() - t0,
    status: res.status,
    ok: d.status === 'succeeded',
    error: (data.error && data.error.message) || (d.error && d.error.message) || null,
    content: typeof out.content === 'string' ? out.content : '',
    tokens: out.tokens || null,
    pricing: (out.cost && out.cost.pricing) || null,
  }
}

async function proxyCall({ proxyUrl, token, body, timeoutMs = 240000 }) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const t0 = Date.now()
  const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json().catch(() => ({}))
  return { ms: Date.now() - t0, status: res.status, data }
}

function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch {}
  }
  return null
}

async function benchOne(model, ctx) {
  const row = { model, speed: null, tool: null, json: null, error: null }

  try {
    const speed = await simCall({ ...ctx, model, context: SPEED_PROMPT })
    if (!speed.ok) {
      row.error = speed.error || `HTTP ${speed.status}`
      return row
    }
    const outTokens = (speed.tokens && speed.tokens.output) || 0
    const chars = speed.content.length
    const seconds = speed.ms / 1000
    row.speed = {
      seconds: Math.round(seconds * 10) / 10,
      outputTokens: outTokens,
      chars,
      tokPerSec: seconds > 0 ? Math.round((outTokens / seconds) * 10) / 10 : 0,
      reasoningPct:
        outTokens > 0 ? Math.max(0, Math.round((1 - chars / 4 / outTokens) * 100)) : null,
    }
    row.price = speed.pricing ? { input: speed.pricing.input, output: speed.pricing.output } : null
  } catch (err) {
    row.error = String(err.message || err).slice(0, 120)
    return row
  }

  try {
    const tool = await proxyCall({
      ...ctx,
      body: { model, messages: [{ role: 'user', content: TOOL_PROMPT }], tools: TOOLS },
    })
    const msg = (tool.data.choices && tool.data.choices[0] && tool.data.choices[0].message) || {}
    const call = (msg.tool_calls || [])[0]
    let argsOk = false
    if (call) {
      try {
        const args = JSON.parse(call.function.arguments || '{}')
        argsOk = typeof args.filePath === 'string' && args.filePath.length > 0
      } catch {}
    }
    row.tool = { name: (call && call.function && call.function.name) || null, argsOk, seconds: Math.round(tool.ms / 100) / 10 }
  } catch (err) {
    row.tool = { error: String(err.message || err).slice(0, 80) }
  }

  try {
    const json = await proxyCall({ ...ctx, body: { model, messages: [{ role: 'user', content: JSON_PROMPT }] } })
    const content = (json.data.choices && json.data.choices[0] && json.data.choices[0].message && json.data.choices[0].message.content) || ''
    const parsed = parseJsonLoose(content)
    // The probe tests "can it answer with JSON", not "can it echo a literal".
    const ok = Boolean(parsed && (parsed.ok === true || parsed.ok === 'true') && Number(parsed.n) === 2)
    row.json = {
      ok,
      seconds: Math.round(json.ms / 100) / 10,
      snippet: ok ? undefined : String(content).replace(/\s+/g, ' ').slice(0, 100),
    }
  } catch (err) {
    row.json = { ok: false, error: String(err.message || err).slice(0, 80) }
  }

  return row
}

export async function runBench(options, onProgress = () => {}) {
  const { models, concurrency = 2 } = options
  const results = new Array(models.length)
  let next = 0
  let done = 0

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= models.length) return
      results[i] = await benchOne(models[i], options)
      done++
      onProgress(done, models.length, results[i])
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 4)) }, worker))
  return results.filter(Boolean)
}

function verdict(row) {
  if (row.error) return /is not available|api key is required/i.test(row.error) ? 'недоступна у Sim' : 'ошибка'
  const toolOk = row.tool && row.tool.name === 'read' && row.tool.argsOk
  const jsonOk = row.json && row.json.ok
  const tps = (row.speed && row.speed.tokPerSec) || 0
  if (toolOk && jsonOk && tps >= 25) return 'агент'
  if (toolOk && jsonOk) return 'агент (медленный)'
  if (toolOk && !jsonOk) return 'тул ок, JSON нет'
  if (!toolOk && row.speed) return 'только текст'
  return '—'
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderTableHtml(rows, meta = {}) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const body = rows
    .map((r) => {
      const sp = r.speed || {}
      const price = r.price ? `$${r.price.input} / $${r.price.output}` : '—'
      const toolMark = r.tool ? (r.tool.name === 'read' && r.tool.argsOk ? '✓' : r.tool.name ? `~ ${r.tool.name}` : '✗') : '—'
      const toolTitle = r.tool ? (r.tool.error || `name: ${r.tool.name || '—'}, args ok: ${r.tool.argsOk}`) : ''
      const jsonMark = r.json ? (r.json.ok ? '✓' : '✗') : '—'
      const jsonTitle = r.json ? r.json.error || r.json.snippet || 'ok' : ''
      return `<tr>
        <td class="m">${esc(r.model)}</td>
        <td>${price}</td>
        <td>${sp.seconds ?? '—'}</td>
        <td>${sp.tokPerSec ?? '—'}</td>
        <td>${sp.reasoningPct != null ? `${sp.reasoningPct}%` : '—'}</td>
        <td class="${toolMark === '✓' ? 'ok' : toolMark === '✗' ? 'bad' : ''}" title="${esc(toolTitle)}">${esc(toolMark)}</td>
        <td class="${jsonMark === '✓' ? 'ok' : jsonMark === '✗' ? 'bad' : ''}" title="${esc(jsonTitle)}">${jsonMark}</td>
        <td class="v">${r.error ? `<span class="bad">${esc(String(r.error).slice(0, 60))}</span>` : esc(verdict(r))}</td>
      </tr>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Sim — модели</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { opacity: .6; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 1100px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.25); white-space: nowrap; }
  th { cursor: pointer; user-select: none; font-weight: 600; position: sticky; top: 0; background: Canvas; }
  tr:hover td { background: rgba(128,128,128,.08); }
  td.m { font-family: ui-monospace, Consolas, monospace; }
  td.v { opacity: .8; }
  .ok { color: #1a7f37; }
  .bad { color: #cf222e; }
  .hint { margin-top: 16px; opacity: .6; }
</style>
</head>
<body>
<h1>Sim: hosted-модели</h1>
<div class="sub">Замер ${when} · ${rows.length} моделей · ток/с и reasoning измерены на запросе ~150 слов · тул и JSON — через прокси</div>
<table id="t">
  <thead><tr>
    <th>модель</th><th>$/1M in / out</th><th>сек</th><th>tok/s</th><th>reasoning</th><th>тул</th><th>JSON</th><th>вердикт</th>
  </tr></thead>
  <tbody>
${body}
  </tbody>
</table>
<div class="hint">Клик по заголовку — сортировка. «агент» = тул и JSON ок, скорость ≥ 25 tok/s. reasoning % — доля выходных токенов, ушедшая в размышления.</div>
<script>
const t = document.getElementById('t')
const dirs = new Map()
t.querySelectorAll('th').forEach((th, i) => th.addEventListener('click', () => {
  const dir = dirs.get(i) === 'asc' ? 'desc' : 'asc'
  dirs.set(i, dir)
  const rows = [...t.tBodies[0].rows]
  const num = (s) => { const m = String(s).replace(/[^\\d.+-]/g, ''); return m === '' ? -Infinity : Number(m) }
  rows.sort((a, b) => {
    const x = a.cells[i].textContent.trim(), y = b.cells[i].textContent.trim()
    const nx = num(x), ny = num(y)
    const cmp = Number.isFinite(nx) && Number.isFinite(ny) && /\\d/.test(x) && /\\d/.test(y)
      ? nx - ny : x.localeCompare(y, 'ru')
    return dir === 'asc' ? cmp : -cmp
  })
  rows.forEach((r) => t.tBodies[0].appendChild(r))
}))
</script>
</body>
</html>
`
}

export function defaultDesktopPath() {
  return process.env.SIM_BENCH_OUT || `${process.env.USERPROFILE || ''}\\Desktop\\sim-models.html`
}

export function writeTable(rows, file, meta) {
  fs.writeFileSync(file, renderTableHtml(rows, meta))
  return file
}
