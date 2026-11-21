// Setup wizard + control panel for the Sim -> OpenAI proxy.
//   node cli.mjs            menu (setup on first run)
//   node cli.mjs setup      configure API key / workspace / workflow
//   node cli.mjs start|stop|restart|status|test|logs|models|autostart-on|autostart-off

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, 'config.json')
const LOG_PATH = path.join(__dirname, 'server.log')
const ERR_PATH = path.join(__dirname, 'server.err.log')
const SIM = 'https://www.sim.ai/api/v2'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
}
const c = (color, s) => `${C[color]}${s}${C.reset}`
const ok = (s) => console.log(`${c('green', '✓')} ${s}`)
const bad = (s) => console.log(`${c('red', '✗')} ${s}`)
const warn = (s) => console.log(`${c('yellow', '!')} ${s}`)
const info = (s) => console.log(`${c('gray', s)}`)
const title = (s) => console.log(`\n${c('bold', s)}\n${c('gray', '─'.repeat(Math.max(28, s.length)))}`)

const DEFAULTS = {
  simApiKey: '', workspaceId: '', workflowId: '', port: 8787,
  toolEmulation: true, toolTemperature: 0, maxConcurrent: 2, requestTimeoutMs: 290000,
  fallbackModel: '', cache: { enabled: true, ttlMs: 600000, maxEntries: 200 },
  proxyTools: { now: true, web_fetch: true, web_search: true },
  nudge: { enabled: true, maxRetries: 2 }, maxProxyToolHops: 3,
}

// ------------------------------------------------------------------ helpers
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
    return {
      ...DEFAULTS, ...raw,
      cache: { ...DEFAULTS.cache, ...(raw.cache || {}) },
      proxyTools: { ...DEFAULTS.proxyTools, ...(raw.proxyTools || {}) },
      nudge: { ...DEFAULTS.nudge, ...(raw.nudge || {}) },
    }
  } catch {
    return { ...DEFAULTS, cache: { ...DEFAULTS.cache }, proxyTools: { ...DEFAULTS.proxyTools }, nudge: { ...DEFAULTS.nudge } }
  }
}
const saveConfig = (cfg) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
const configured = (cfg) => Boolean(cfg.simApiKey && cfg.workspaceId)

const rl = readline.createInterface({ input, output })
const ask = (q, def = '') =>
  new Promise((resolve) => {
    rl.question(`${q}${def ? c('gray', ` [${def}]`) : ''}: `, (a) => resolve((a || '').trim() || def))
  })

function askHidden(q) {
  return new Promise((resolve) => {
    const prompt = `${q}: `
    const orig = rl._writeToOutput
    rl._writeToOutput = (str) => {
      if (str.includes(q)) {
        rl.output.write(prompt)
        return
      }
      const clean = str.replace(/[\r\n]/g, '')
      if (clean) rl.output.write('*'.repeat(clean.length))
      if (/[\r\n]/.test(str)) rl.output.write('\n')
    }
    rl.question(prompt, (a) => {
      rl._writeToOutput = orig
      resolve(a.trim())
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(pathname, key, init = {}) {
  const res = await fetch(`${SIM}${pathname}`, {
    ...init,
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

async function proxyFetch(cfg, pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${pathname}`, { ...init, signal: AbortSignal.timeout(120000) })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const alive = async (cfg) => {
  try {
    const r = await proxyFetch(cfg, '/health')
    return r.status === 200 && r.body && r.body.ok === true ? r.body : null
  } catch {
    return null
  }
}

function pidOnPort(port) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)
      if (m && Number(m[1]) === Number(port)) return Number(m[2])
    }
  } catch {}
  return null
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

async function startServer(cfg, quiet = false) {
  const running = await alive(cfg)
  if (running) {
    if (!quiet) ok(`Прокси уже запущен на порту ${cfg.port}`)
    return true
  }
  if (!(await portFree(cfg.port))) {
    bad(`Порт ${cfg.port} занят другим процессом`)
    return false
  }
  const out = fs.openSync(LOG_PATH, 'a')
  const err = fs.openSync(ERR_PATH, 'a')
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: __dirname,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await alive(cfg)) {
      if (!quiet) ok(`Прокси запущен на http://127.0.0.1:${cfg.port}/v1 (pid ${child.pid})`)
      return true
    }
  }
  bad('Не поднялся за 10 секунд — смотри server.err.log')
  return false
}

async function stopServer(cfg, quiet = false) {
  if (!(await alive(cfg))) {
    if (!quiet) warn('Прокси не запущен')
    return false
  }
  const pid = pidOnPort(cfg.port)
  if (!pid) {
    if (!quiet) warn('Не нашёл процесс на порту')
    return false
  }
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true })
    await sleep(600)
    if (!(await alive(cfg))) {
      if (!quiet) ok(`Остановлен (pid ${pid})`)
      return true
    }
  } catch {}
  bad('Не удалось остановить')
  return false
}

// --------------------------------------------------------------- validation
async function detectWorkspaces(key) {
  const r = await api('/workspaces', key)
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${(r.body.error && r.body.error.message) || 'invalid key'}`)
  return r.body.data || []
}

async function validateWorkflow(key, workspaceId, workflowId) {
  const r = await api(`/workflows/${encodeURIComponent(workflowId)}`, key)
  if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}` }
  const wf = r.body.data || {}
  if (wf.workspaceId && workspaceId && wf.workspaceId !== workspaceId) return { ok: false, error: 'воркфлоу из другого воркспейса' }
  return { ok: true, name: wf.name, inputs: Object.keys((wf.inputSchema && wf.inputSchema.properties) || {}) }
}

async function smokeTest(key, workspaceId, model = 'claude-sonnet-5-5') {
  const r = await api('/tools/llm_chat/execute', key, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, input: { model, context: 'Ответь одним словом: ок' } }),
  })
  const d = (r.body && r.body.data) || {}
  if (r.status === 200 && d.status === 'succeeded') return { ok: true, text: (d.output && d.output.content) || '' }
  return { ok: false, error: `${r.status} ${(d.error && d.error.message) || JSON.stringify(r.body).slice(0, 200)}` }
}

// ------------------------------------------------------------------- setup
async function setupWizard(existing) {
  title('Мастер настройки Sim → OpenCode')
  info('Ключ: sim.ai → Settings → API keys (начинается с sk-sim-)')
  info('Ключ хранится локально в config.json рядом с этим файлом.\n')

  let key = existing.simApiKey
  if (key) {
    const keep = (await ask('Оставить текущий ключ? (y/n)', 'y')).toLowerCase()
    if (!keep.startsWith('y')) key = ''
  }

  let workspaces = null
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!key) key = await askHidden('API ключ')
    if (!key) {
      warn('Пустой ключ')
      continue
    }
    try {
      workspaces = await detectWorkspaces(key)
      ok(`Ключ рабочий, воркспейсов: ${workspaces.length}`)
      break
    } catch (err) {
      bad(`Ключ не принят: ${err.message}`)
      key = ''
    }
  }
  if (!workspaces || !workspaces.length) {
    bad('Не получилось авторизоваться. Выхожу.')
    return null
  }

  let workspaceId = existing.workspaceId
  if (workspaces.length === 1) {
    workspaceId = workspaces[0].id
    ok(`Воркспейс: ${workspaces[0].name} (${workspaceId})`)
  } else {
    console.log()
    workspaces.forEach((w, i) => console.log(`  ${i + 1}) ${w.name}  ${c('gray', w.id)}`))
    const pick = Number(await ask('Номер воркспейса', '1'))
    workspaceId = (workspaces[pick - 1] || workspaces[0]).id
  }

  title('Проверка модели')
  process.stdout.write('Дёргаю hosted-модель… ')
  const test = await smokeTest(key, workspaceId)
  if (test.ok) console.log(c('green', `ок → «${test.text.slice(0, 40)}»`))
  else console.log(c('red', `ошибка: ${test.error}`))

  title('Воркфлоу (необязательно)')
  info('Провайдеру воркфлоу не нужен — он работает через llm_chat.')
  info('ID хранится на будущее и для пункта «запустить воркфлоу» в меню. Enter — пропустить.\n')
  let workflowId = existing.workflowId || ''
  const wfInput = await ask('Workflow ID', workflowId)
  if (wfInput) {
    const v = await validateWorkflow(key, workspaceId, wfInput)
    if (v.ok) {
      workflowId = wfInput
      ok(`Воркфлоу: ${v.name}${v.inputs.length ? ` · входы: ${v.inputs.join(', ')}` : c('yellow', ' · входов нет')}`)
    } else {
      warn(`Воркфлоу не принят (${v.error}) — сохраняю всё равно`)
      workflowId = wfInput
    }
  } else workflowId = ''

  const port = Number(await ask('Порт', String(existing.port || 8787))) || 8787

  const cfg = {
    ...existing,
    simApiKey: key,
    workspaceId,
    workflowId,
    port,
  }
  saveConfig(cfg)
  ok(`Сохранено в ${CONFIG_PATH}`)

  const auto = (await ask('Ставить в автозапуск при входе в Windows? (y/n)', 'y')).toLowerCase()
  if (auto.startsWith('y')) setAutostart(true)
  else setAutostart(false)

  return cfg
}

// --------------------------------------------------------------- autostart
function startupLink() {
  const dir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  return path.join(dir, 'Sim proxy.lnk')
}

function setAutostart(on) {
  const link = startupLink()
  try {
    if (!on) {
      if (fs.existsSync(link)) fs.unlinkSync(link)
      ok('Автозапуск выключен')
      return
    }
    const vbs = path.join(__dirname, 'start-hidden.vbs')
    const ps1 = path.join(__dirname, '.autostart.ps1')
    const esc = (s) => s.replace(/'/g, "''")
    fs.writeFileSync(
      ps1,
      [
        `$sh = New-Object -ComObject WScript.Shell`,
        `$lnk = $sh.CreateShortcut('${esc(link)}')`,
        `$lnk.TargetPath = 'wscript.exe'`,
        `$lnk.Arguments = '"${esc(vbs)}"'`,
        `$lnk.WorkingDirectory = '${esc(__dirname)}'`,
        `$lnk.Description = 'Sim -> OpenAI proxy for OpenCode'`,
        `$lnk.Save()`,
        '',
      ].join('\r\n'),
    )
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { stdio: 'ignore', windowsHide: true })
    fs.unlinkSync(ps1)
    ok('Автозапуск включён')
  } catch (err) {
    bad(`Автозапуск: ${err.message}`)
  }
}

// ------------------------------------------------------------------ status
async function showStatus(cfg) {
  const health = await alive(cfg)
  if (!health) {
    bad(`Прокси не запущен (порт ${cfg.port})`)
    return
  }
  const st = (await proxyFetch(cfg, '/stats')).body || {}
  const avg = st.chatRequests ? Math.round((st.latencyMs || 0) / st.chatRequests) : 0
  console.log(`  ${c('green', 'работает')}  uptime ${Math.floor(health.uptimeSec / 60)} мин · порт ${cfg.port}`)
  console.log(`  моделей: ${health.models} · эмуляция тулов: ${health.toolEmulation ? 'вкл' : 'выкл'} · кеш: ${health.cache ? 'вкл' : 'выкл'}`)
  console.log(`  свои тулы: ${(health.proxyTools || []).join(', ') || '—'}`)
  console.log(
    `  запросов: ${st.chatRequests || 0} · тул-вызовов: ${st.emulatedToolCalls || 0} · своих тулов: ${st.proxyToolRuns || 0}` +
      ` · кеш-хитов: ${st.cacheHits || 0} · подсказок: ${st.nudges || 0} · ошибок: ${st.errors || 0}`,
  )
  console.log(`  токенов: ${st.tokensIn || 0} in / ${st.tokensOut || 0} out · средняя задержка ${avg} мс`)
  const models = Object.entries(st.byModel || {}).sort((a, b) => b[1].calls - a[1].calls).slice(0, 5)
  for (const [name, m] of models) console.log(c('gray', `    ${name}: ${m.calls} выз., ${Math.round(m.latencyMs / m.calls)} мс`))
}

async function quickTest(cfg) {
  if (!(await alive(cfg))) {
    bad('Сначала запусти прокси')
    return
  }
  const model = await ask('Модель', 'claude-sonnet-5-5')
  const prompt = await ask('Запрос', 'Ответь одним словом: работает')
  const t0 = Date.now()
  const r = await proxyFetch(cfg, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  })
  const ms = Date.now() - t0
  if (r.status !== 200) return bad(`${r.status}: ${r.body.error ? r.body.error.message : JSON.stringify(r.body)}`)
  ok(`${ms} мс · ${r.body.usage.total_tokens} токенов`)
  console.log(c('gray', `  → ${String(r.body.choices[0].message.content).slice(0, 200)}`))
}

function tailLog(n = 25) {
  for (const f of [ERR_PATH, LOG_PATH]) {
    if (!fs.existsSync(f)) continue
    const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)
    if (!lines.length || (lines.length === 1 && !lines[0])) continue
    console.log(c('gray', `\n${path.basename(f)}:`))
    console.log(lines.slice(-n).join('\n'))
  }
}

function listModels(cfg) {
  const cacheFile = path.join(__dirname, 'models.cache.json')
  try {
    const m = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    console.log(`hosted (без ключа), ${m.hosted.length} из ${m.all.length}:`)
    console.log('  ' + m.hosted.join(', '))
  } catch {
    bad('Нет кэша каталога — запусти прокси, он подтянет список')
  }
}

async function runWorkflow(cfg) {
  if (!cfg.workflowId) return warn('Workflow ID не задан (пункт 10 — мастер настройки)')
  const prompt = await ask('Вход (input)', 'привет')
  const r = await api(`/workflows/${encodeURIComponent(cfg.workflowId)}/execute`, cfg.simApiKey, {
    method: 'POST',
    body: JSON.stringify({ input: { input: prompt }, waitTimeoutSeconds: 120 }),
  })
  if (r.status !== 200) return bad(`${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`)
  const d = r.body.data || {}
  console.log(`  статус: ${d.status}`)
  console.log(c('gray', JSON.stringify(d.output || d.error || {}, null, 1).slice(0, 1200)))
}

// ---------------------------------------------------------------- settings
async function settingsMenu(cfg) {
  for (;;) {
    title('Настройки')
    console.log(`  1) Порт                    ${c('cyan', cfg.port)}`)
    console.log(`  2) Эмуляция тулов          ${c('cyan', cfg.toolEmulation ? 'вкл' : 'выкл')}`)
    console.log(`  3) Температура в тул-режиме ${c('cyan', cfg.toolTemperature)}`)
    console.log(`  4) Кеш ответов             ${c('cyan', cfg.cache.enabled ? 'вкл' : 'выкл')} (ttl ${Math.round(cfg.cache.ttlMs / 60000)} мин)`)
    console.log(`  5) Свои тулы: now=${cfg.proxyTools.now ? 'on' : 'off'} web_fetch=${cfg.proxyTools.web_fetch ? 'on' : 'off'} web_search=${cfg.proxyTools.web_search ? 'on' : 'off'}`)
    console.log(`  6) Fallback-модель         ${c('cyan', cfg.fallbackModel || '—')}`)
    console.log(`  7) Параллельных запросов   ${c('cyan', cfg.maxConcurrent)}`)
    console.log('  0) Назад')
    const choice = await ask('\nВыбор', '0')
    if (choice === '1') cfg.port = Number(await ask('Новый порт', String(cfg.port))) || cfg.port
    else if (choice === '2') cfg.toolEmulation = !cfg.toolEmulation
    else if (choice === '3') cfg.toolTemperature = Number(await ask('Температура (0..2)', String(cfg.toolTemperature)))
    else if (choice === '4') cfg.cache.enabled = !cfg.cache.enabled
    else if (choice === '5') {
      const v = await ask('Включить now/web_fetch/web_search через запятую (пусто — выключить все)', 'now,web_fetch,web_search')
      for (const k of ['now', 'web_fetch', 'web_search']) cfg.proxyTools[k] = v.split(',').map((s) => s.trim()).includes(k)
    } else if (choice === '6') cfg.fallbackModel = await ask('Модель при ошибке (пусто — без fallback)', cfg.fallbackModel || '')
    else if (choice === '7') cfg.maxConcurrent = Number(await ask('Сколько параллельно', String(cfg.maxConcurrent))) || 1
    else if (choice === '0') return cfg
    saveConfig(cfg)
    ok('Сохранено')
  }
}

// -------------------------------------------------------------------- menu
async function menu(cfg) {
  for (;;) {
    title('Sim → OpenCode')
    const health = await alive(cfg)
    console.log(`  ${health ? c('green', '● запущен') : c('red', '○ остановлен')}   порт ${cfg.port}   ключ …${cfg.simApiKey.slice(-6)}   воркспейс …${cfg.workspaceId.slice(-6)}`)
    console.log(`  воркфлоу: ${cfg.workflowId ? cfg.workflowId : c('gray', 'не задан')}\n`)
    console.log('  1) Старт            6) Показать модели')
    console.log('  2) Стоп             7) Тест запроса')
    console.log('  3) Рестарт          8) Каталог моделей — обновить')
    console.log('  4) Статус           9) Автозапуск вкл/выкл')
    console.log('  5) Логи            10) Мастер настройки (ключ/воркфлоу)')
    console.log(` 11) Запустить воркфлоу   12) Настройки`)
    console.log('  0) Выход')
    const choice = await ask('\nВыбор', '0')
    if (choice === '1') await startServer(cfg)
    else if (choice === '2') await stopServer(cfg)
    else if (choice === '3') {
      await stopServer(cfg, true)
      await startServer(cfg)
    } else if (choice === '4') await showStatus(cfg)
    else if (choice === '5') tailLog()
    else if (choice === '6') listModels(cfg)
    else if (choice === '7') await quickTest(cfg)
    else if (choice === '8') {
      const r = await api(`/blocks/agent?workspaceId=${encodeURIComponent(cfg.workspaceId)}`, cfg.simApiKey)
      ok(r.status === 200 ? 'Каталог доступен, прокси обновит его при следующем старте' : `HTTP ${r.status}`)
      const cacheFile = path.join(__dirname, 'models.cache.json')
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile)
      if (await alive(cfg)) {
        await stopServer(cfg, true)
        await startServer(cfg, true)
      } else ok('Кэш удалён')
    } else if (choice === '9') setAutostart(!fs.existsSync(startupLink()))
    else if (choice === '10') {
      const next = await setupWizard(cfg)
      if (next) cfg = next
    } else if (choice === '11') await runWorkflow(cfg)
    else if (choice === '12') cfg = await settingsMenu(cfg)
    else if (choice === '0') return
  }
}

// -------------------------------------------------------------------- main
const [, , cmd, arg] = process.argv
let cfg = loadConfig()

if (cmd === 'setup' || (!configured(cfg) && !cmd)) {
  const next = await setupWizard(cfg)
  if (!next) process.exit(1)
  cfg = next
  if (!cmd) {
    const start = (await ask('\nЗапустить прокси сейчас? (y/n)', 'y')).toLowerCase()
    if (start.startsWith('y')) await startServer(cfg)
  }
  if (!cmd) await menu(cfg)
} else if (cmd === 'start') await startServer(cfg)
else if (cmd === 'stop') await stopServer(cfg)
else if (cmd === 'restart') {
  await stopServer(cfg, true)
  await startServer(cfg)
} else if (cmd === 'status') {
  if (!configured(cfg)) bad('Не настроено — запусти setup.bat')
  else if (!(await alive(cfg))) bad(`Не запущен (порт ${cfg.port})`)
  else await showStatus(cfg)
} else if (cmd === 'test') await quickTest(cfg)
else if (cmd === 'logs') tailLog(Number(arg) || 25)
else if (cmd === 'models') listModels(cfg)
else if (cmd === 'autostart-on') setAutostart(true)
else if (cmd === 'autostart-off') setAutostart(false)
else if (cmd === 'workflow') await runWorkflow(cfg)
else if (!cmd) {
  if (!(await alive(cfg))) warn(`Прокси не запущен (порт ${cfg.port})`)
  await menu(cfg)
} else {
  console.log('Использование: node cli.mjs [setup|start|stop|restart|status|test|logs|models|workflow|autostart-on|autostart-off]')
}

rl.close()
