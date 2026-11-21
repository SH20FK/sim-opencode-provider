// Setup wizard + control panel for the Sim -> OpenAI proxy.
//
//   node src/cli.mjs                 panel (wizard on first run)
//   node src/cli.mjs setup           configure API key / workspace
//   node src/cli.mjs start|stop|restart|status|test|logs|models
//   node src/cli.mjs opencode-install|opencode-remove|opencode-status
//   node src/cli.mjs autostart-on|autostart-off

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import * as opencode from './opencode.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = process.env.SIM_PROVIDER_CONFIG
  ? path.resolve(process.env.SIM_PROVIDER_CONFIG)
  : path.join(ROOT, 'config.json')
const MODELS_CACHE = path.join(ROOT, 'models.cache.json')
const LOG_PATH = path.join(ROOT, 'server.log')
const ERR_PATH = path.join(ROOT, 'server.err.log')
const SIM = 'https://www.sim.ai/api/v2'
const VERSION = '2.0'

// ------------------------------------------------------------------ styling
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', inverse: '\x1b[7m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m',
}
const paint = (color, s) => `${C[color]}${s}${C.reset}`
const ok = (s) => console.log(`${paint('green', '✓')} ${s}`)
const bad = (s) => console.log(`${paint('red', '✗')} ${s}`)
const warn = (s) => console.log(`${paint('yellow', '!')} ${s}`)
const info = (s) => console.log(paint('gray', s))
const clear = () => process.stdout.write('\x1b[2J\x1b[0f')

const SPLASH = process.env.SIM_CLI_SPLASH === '1'

function banner() {
  if (SPLASH) return
  const W = 60
  const row = (left, right = '') => {
    const pad = W - left.length - right.length
    return paint('cyan', '│') + '  ' + left + ' '.repeat(Math.max(1, pad)) + right + '  ' + paint('cyan', '│')
  }
  const top = paint('cyan', '┌' + '─'.repeat(W + 4) + '┐')
  const bottom = paint('cyan', '└' + '─'.repeat(W + 4) + '┘')
  console.log('')
  console.log(top)
  console.log(row(`${C.bold}SIM  →  OPENCODE${C.reset}`, `${C.gray}v${VERSION}${C.reset}`))
  console.log(row(`${C.gray}free hosted models · tool-calling emulation${C.reset}`))
  console.log(bottom)
}

// ------------------------------------------------------------------ helpers
const DEFAULTS = {
  simApiKey: '', workspaceId: '', workflowId: '', port: 8787,
  toolEmulation: true, toolTemperature: 0, maxConcurrent: 2, requestTimeoutMs: 290000,
  fallbackModel: '',
  cache: { enabled: true, ttlMs: 600000, maxEntries: 200 },
  proxyTools: { now: true, web_fetch: true, web_search: true },
  nudge: { enabled: true, maxRetries: 2 },
  maxProxyToolHops: 3,
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
    return {
      ...DEFAULTS,
      ...raw,
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
const baseURL = (cfg) => `http://127.0.0.1:${cfg.port}/v1`

const rl = readline.createInterface({ input, output })
const ask = (q, def = '') =>
  new Promise((resolve) => {
    rl.question(`${q}${def ? paint('gray', ` [${def}]`) : ''}: `, (a) => resolve((a || '').trim() || def))
  })

function askHidden(q) {
  return new Promise((resolve) => {
    const prompt = `${q}: `
    const orig = rl._writeToOutput
    rl._writeToOutput = (str) => {
      if (str.includes(q)) return rl.output.write(prompt)
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
  if (await alive(cfg)) {
    if (!quiet) ok(`Уже запущен на порту ${cfg.port}`)
    return true
  }
  if (!(await portFree(cfg.port))) {
    bad(`Порт ${cfg.port} занят другим процессом`)
    return false
  }
  const out = fs.openSync(LOG_PATH, 'a')
  const err = fs.openSync(ERR_PATH, 'a')
  const child = spawn(process.execPath, [path.join('src', 'server.mjs')], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await alive(cfg)) {
      if (!quiet) ok(`Запущен на ${paint('cyan', baseURL(cfg))} (pid ${child.pid})`)
      return true
    }
  }
  bad('Не поднялся за 10 секунд — смотри пункт «Логи»')
  return false
}

async function stopServer(cfg, quiet = false) {
  if (!(await alive(cfg))) {
    if (!quiet) warn('Не запущен')
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

async function smokeTest(key, workspaceId, model = 'claude-sonnet-5-5') {
  const r = await api('/tools/llm_chat/execute', key, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, input: { model, context: 'Ответь одним словом: ок' } }),
  })
  const d = (r.body && r.body.data) || {}
  if (r.status === 200 && d.status === 'succeeded') return { ok: true, text: (d.output && d.output.content) || '' }
  return { ok: false, error: `${r.status} ${(d.error && d.error.message) || JSON.stringify(r.body).slice(0, 160)}` }
}

// ------------------------------------------------------------------- setup
async function setupWizard(existing) {
  clear()
  banner()
  console.log(paint('bold', '\n  Мастер настройки'))
  info('  Ключ: sim.ai → Settings → API keys (начинается с sk-sim-)')
  info('  Ключ сохраняется только локально, в config.json.\n')

  let key = existing.simApiKey
  if (key) {
    const keep = (await ask('Оставить текущий ключ? (y/n)', 'y')).toLowerCase()
    if (!keep.startsWith('y')) key = ''
  }

  let workspaces = null
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!key) key = await askHidden('  API ключ')
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
    bad('Авторизация не прошла — выхожу')
    return null
  }

  let workspaceId = existing.workspaceId
  if (workspaces.length === 1) {
    workspaceId = workspaces[0].id
    ok(`Воркспейс: ${workspaces[0].name}`)
  } else {
    console.log()
    workspaces.forEach((w, i) => console.log(`   ${i + 1}) ${w.name}  ${paint('gray', w.id)}`))
    const pick = Number(await ask('  Номер воркспейса', '1'))
    workspaceId = (workspaces[pick - 1] || workspaces[0]).id
  }

  process.stdout.write('\n  Проверяю hosted-модель… ')
  const test = await smokeTest(key, workspaceId)
  if (test.ok) console.log(paint('green', `ок → «${test.text.slice(0, 40)}»`))
  else console.log(paint('red', `ошибка: ${test.error}`))

  const port = Number(await ask('\n  Порт', String(existing.port || 8787))) || 8787

  const cfg = { ...existing, simApiKey: key, workspaceId, port }
  saveConfig(cfg)
  ok(`Сохранено: ${CONFIG_PATH}`)

  const auto = (await ask('  Автозапуск при входе в Windows? (y/n)', 'y')).toLowerCase()
  setAutostart(auto.startsWith('y'))

  return cfg
}

// --------------------------------------------------------------- autostart
function startupLink() {
  const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
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
    const vbs = path.join(ROOT, 'start-hidden.vbs')
    if (!fs.existsSync(vbs)) {
      fs.writeFileSync(
        vbs,
        [
          "' Auto-generated: starts the proxy without a console window.",
          'Set fso = CreateObject("Scripting.FileSystemObject")',
          'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
          'Set sh = CreateObject("WScript.Shell")',
          'sh.CurrentDirectory = dir',
          `sh.Run "cmd /c cd /d """ & dir & """ && node src\\server.mjs >> server.log 2>> server.err.log", 0, False`,
          '',
        ].join('\r\n'),
      )
    }
    const ps1 = path.join(ROOT, '.autostart.ps1')
    const esc = (s) => s.replace(/'/g, "''")
    fs.writeFileSync(
      ps1,
      '\uFEFF' +
        [
          `$sh = New-Object -ComObject WScript.Shell`,
          `$lnk = $sh.CreateShortcut('${esc(link)}')`,
          `$lnk.TargetPath = 'wscript.exe'`,
          `$lnk.Arguments = '"${esc(vbs)}"'`,
          `$lnk.WorkingDirectory = '${esc(ROOT)}'`,
          `$lnk.Description = 'Sim -> OpenAI proxy for OpenCode'`,
          `$lnk.Save()`,
          '',
        ].join('\r\n'),
    )
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { stdio: 'ignore', windowsHide: true })
    if (fs.existsSync(ps1)) fs.unlinkSync(ps1)
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
  console.log(`\n  ${paint('green', 'работает')}  uptime ${Math.floor(health.uptimeSec / 60)} мин  ·  порт ${cfg.port}`)
  console.log(`  моделей ${health.models}  ·  эмуляция тулов ${health.toolEmulation ? 'вкл' : 'выкл'}  ·  кеш ${health.cache ? 'вкл' : 'выкл'}`)
  console.log(`  свои тулы: ${(health.proxyTools || []).join(', ') || '—'}`)
  console.log(
    `  запросов ${st.chatRequests || 0}  ·  тул-вызовов ${st.emulatedToolCalls || 0}  ·  своих ${st.proxyToolRuns || 0}` +
      `  ·  кеш-хитов ${st.cacheHits || 0}  ·  ошибок ${st.errors || 0}`,
  )
  console.log(`  токенов ${st.tokensIn || 0} in / ${st.tokensOut || 0} out  ·  средняя ${avg} мс`)
  const top = Object.entries(st.byModel || {})
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 4)
  for (const [name, m] of top) info(`    ${name}: ${m.calls} выз., ${Math.round(m.latencyMs / m.calls)} мс`)
  console.log()
}

async function quickTest(cfg) {
  if (!(await alive(cfg))) {
    bad('Сначала запусти прокси')
    return
  }
  const model = await ask('  Модель', 'claude-sonnet-5-5')
  const prompt = await ask('  Запрос', 'Ответь одним словом: работает')
  const t0 = Date.now()
  const r = await proxyFetch(cfg, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  })
  const ms = Date.now() - t0
  if (r.status !== 200) return bad(`${r.status}: ${r.body.error ? r.body.error.message : JSON.stringify(r.body)}`)
  ok(`${ms} мс · ${r.body.usage.total_tokens} токенов`)
  console.log(paint('gray', `  → ${String(r.body.choices[0].message.content).slice(0, 220)}`))
}

function tailLog(n = 25) {
  let printed = false
  for (const f of [ERR_PATH, LOG_PATH]) {
    if (!fs.existsSync(f)) continue
    const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)
    if (!lines.length || (lines.length === 1 && !lines[0])) continue
    printed = true
    console.log(paint('gray', `\n${path.basename(f)}:`))
    console.log(lines.slice(-n).join('\n'))
  }
  if (!printed) warn('Логов пока нет')
}

function listModels() {
  try {
    const m = JSON.parse(fs.readFileSync(MODELS_CACHE, 'utf8'))
    console.log(`hosted (без ключа): ${m.hosted.length} из ${m.all.length}`)
    console.log('  ' + m.hosted.join(', '))
  } catch {
    bad('Кэш каталога пуст — запусти прокси, он подтянет список')
  }
}

// ------------------------------------------------------- OpenCode section
function printOpencodeGuide(cfg) {
  const file = opencode.configPath()
  console.log(paint('bold', '\n  Как подключить вручную'))
  console.log(`
  1. Открой конфиг OpenCode:
     ${paint('cyan', file)}

  2. Внутри объекта "provider" добавь блок:

${paint('gray', `     "sim": {
       "npm": "@ai-sdk/openai-compatible",
       "name": "Sim (free)",
       "options": {
         "baseURL": "${baseURL(cfg)}",
         "apiKey": "sim-local"
       },
       "models": {
         "claude-sonnet-5-5": {
           "name": "Claude Sonnet 5.5 (Sim)",
           "limit": { "context": 200000, "output": 32000 },
           "cost": { "input": 0, "output": 0 }
         }
       }
     }`)}

  3. Сохрани файл и запусти OpenCode.
  4. Введи ${paint('cyan', '/models')} и выбери ${paint('bold', 'Sim (free)')} → нужную модель.

  Важно:
  · "apiKey": "sim-local" — заглушка, OpenCode требует поле. Настоящий ключ
    Sim лежит в config.json прокси и в OpenCode не попадает.
  · Прокси должен быть запущен, иначе модели ответят connection refused.
  · Порт поменял — поменяй и baseURL.
  · Проверить: ${paint('cyan', `curl ${baseURL(cfg)}/models`)}
`)
}

async function installProvider(cfg) {
  const hosted = await opencode.fetchHosted(cfg)
  const res = opencode.install(baseURL(cfg), { hosted })
  return { ...res, hosted: Boolean(hosted) }
}

async function opencodeMenu(cfg) {
  for (;;) {
    const st = opencode.inspect()
    const health = await alive(cfg)
    clear()
    banner()
    console.log(paint('bold', '\n  OpenCode'))
    info(`  конфиг: ${st.path}`)
    if (!st.exists) bad('  файл не найден — запусти OpenCode хотя бы раз')
    else if (st.installed) ok(`  провайдер установлен · ${st.models} моделей · ${st.baseURL || 'без baseURL'}`)
    else warn('  провайдер не установлен')
    if (health) ok(`  прокси отвечает · ${health.models} моделей`)
    else bad(`  прокси не отвечает на порту ${cfg.port}`)
    if (st.error) bad(`  ошибка чтения конфига: ${st.error}`)

    console.log(`
  1  Установить / обновить провайдера (${opencode.MODELS.length} моделей)
  2  Удалить провайдера
  3  Показать инструкцию вручную
  0  Назад`)
    const choice = await ask('\n  Выбор', '0')

    if (choice === '1') {
      if (!st.exists) {
        bad('Нет opencode.json — сначала запусти OpenCode, он создаст файл')
        continue
      }
      try {
        const r = await installProvider(cfg)
        ok(`Провайдер установлен: ${r.models} моделей${r.hosted ? ' (весь hosted-каталог)' : ' (каталог недоступен, базовый набор)'}`)
        info(`  бэкап: ${path.basename(r.backup)}`)
        console.log(paint('gray', '\n  Перезапусти OpenCode, затем /models → Sim (free)'))
      } catch (err) {
        bad(err.message)
      }
      await ask('\n  Enter — продолжить')
    } else if (choice === '2') {
      try {
        const r = opencode.remove()
        r.removed ? ok(`Провайдер удалён, бэкап: ${path.basename(r.backup)}`) : warn('Провайдер не был установлен')
      } catch (err) {
        bad(err.message)
      }
      await ask('\n  Enter — продолжить')
    } else if (choice === '3') {
      printOpencodeGuide(cfg)
      await ask('\n  Enter — назад')
    } else return
  }
}

async function installProviderQuietly(cfg) {
  const st = opencode.inspect()
  if (!st.exists) {
    warn('opencode.json не найден — пропускаю автоподключение')
    return
  }
  try {
    const r = await installProvider(cfg)
    ok(`Провайдер добавлен в OpenCode (${r.models} моделей${r.hosted ? '' : ', каталог недоступен'})`)
    info(`  бэкап: ${path.basename(r.backup)}`)
  } catch (err) {
    bad(`OpenCode: ${err.message}`)
  }
}

// ---------------------------------------------------------------- settings
async function settingsMenu(cfg) {
  for (;;) {
    clear()
    banner()
    console.log(paint('bold', '\n  Настройки\n'))
    console.log(`  1  Порт                       ${paint('cyan', cfg.port)}`)
    console.log(`  2  Эмуляция тулов             ${paint('cyan', cfg.toolEmulation ? 'вкл' : 'выкл')}`)
    console.log(`  3  Кеш ответов                ${paint('cyan', cfg.cache.enabled ? 'вкл' : 'выкл')}`)
    console.log(`  4  Fallback-модель            ${paint('cyan', cfg.fallbackModel || '—')}`)
    console.log(`  5  Свои тулы                   ${paint('cyan', ['now', 'web_fetch', 'web_search'].filter((k) => cfg.proxyTools[k]).join(', ') || 'выкл')}`)
    console.log('  0  Назад')
    const choice = await ask('\n  Выбор', '0')
    if (choice === '1') cfg.port = Number(await ask('  Новый порт', String(cfg.port))) || cfg.port
    else if (choice === '2') cfg.toolEmulation = !cfg.toolEmulation
    else if (choice === '3') cfg.cache.enabled = !cfg.cache.enabled
    else if (choice === '4') cfg.fallbackModel = await ask('  Модель при ошибке (пусто — выкл)', cfg.fallbackModel || '')
    else if (choice === '5') {
      const v = await ask('  Включить (now,web_fetch,web_search; пусто — выключить)', 'now,web_fetch,web_search')
      for (const k of ['now', 'web_fetch', 'web_search']) cfg.proxyTools[k] = v.split(',').map((s) => s.trim()).includes(k)
    } else if (choice === '0') return cfg
    saveConfig(cfg)
    ok('Сохранено (применится после перезапуска прокси)')
    await sleep(500)
  }
}

// -------------------------------------------------------------------- menu
async function menu(cfg) {
  for (;;) {
    const health = await alive(cfg)
    const st = opencode.inspect()
    clear()
    banner()
    console.log(paint('gray', `  ${'─'.repeat(62)}`))
    const dot = health ? paint('green', '● работает') : paint('red', '○ остановлен')
    const oc = st.installed ? paint('green', 'подключён') : paint('yellow', 'не подключён')
    console.log(`\n  ${dot}   :${cfg.port}   ${health ? health.models : '—'} моделей   OpenCode: ${oc}`)
    info(`  ключ …${cfg.simApiKey ? cfg.simApiKey.slice(-6) : '—'}   воркспейс …${cfg.workspaceId ? cfg.workspaceId.slice(-6) : '—'}`)
    console.log(`
  ${paint('bold', '1')}  ${health ? 'Перезапустить' : 'Запустить'}
  ${paint('bold', '2')}  Остановить
  ${paint('bold', '3')}  Статус и статистика
  ${paint('bold', '4')}  Подключить к OpenCode
  ${paint('bold', '5')}  Тест запроса
  ${paint('bold', '6')}  Настройки
  ${paint('bold', '7')}  Логи
  ${paint('bold', 'Q')}  Выход`)
    const choice = (await ask('\n  Выбор', 'Q')).toLowerCase()

    if (choice === '1') {
      if (health) await stopServer(cfg, true)
      await startServer(cfg)
      await ask('\n  Enter — продолжить')
    } else if (choice === '2') {
      await stopServer(cfg)
      await ask('\n  Enter — продолжить')
    } else if (choice === '3') {
      await showStatus(cfg)
      await ask('  Enter — продолжить')
    } else if (choice === '4') await opencodeMenu(cfg)
    else if (choice === '5') {
      await quickTest(cfg)
      await ask('\n  Enter — продолжить')
    } else if (choice === '6') cfg = await settingsMenu(cfg)
    else if (choice === '7') {
      tailLog()
      await ask('\n  Enter — продолжить')
    } else if (choice === 'q' || choice === '0') return
  }
}

// -------------------------------------------------------------------- main
const [, , cmd, arg] = process.argv
let cfg = loadConfig()

if (cmd === 'setup' || (!configured(cfg) && !cmd)) {
  const next = await setupWizard(cfg)
  if (!next) process.exit(1)
  cfg = next

  const health = await alive(cfg)
  if (!health) {
    const start = (await ask('\n  Запустить прокси сейчас? (y/n)', 'y')).toLowerCase()
    if (start.startsWith('y')) await startServer(cfg)
  }
  const install = (await ask('  Добавить провайдера в OpenCode автоматически? (y/n)', 'y')).toLowerCase()
  if (install.startsWith('y')) await installProviderQuietly(cfg)
  if (!cmd) {
    await ask('\n  Enter — открыть панель')
    await menu(cfg)
  }
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
else if (cmd === 'models') listModels()
else if (cmd === 'opencode-install') {
  const r = await installProvider(cfg)
  ok(`Провайдер установлен: ${r.models} моделей → ${r.path}`)
  info(`  бэкап: ${r.backup}`)
  if (!r.hosted) warn('  каталог Sim недоступен — поставлен базовый набор из 29 моделей')
} else if (cmd === 'opencode-remove') {
  const r = opencode.remove()
  r.removed ? ok(`Провайдер удалён (бэкап: ${r.backup})`) : warn('Провайдер не был установлен')
} else if (cmd === 'opencode-status') {
  const st = opencode.inspect()
  const health = await alive(cfg)
  console.log(`opencode.json: ${st.path} (${st.exists ? 'есть' : 'нет'})`)
  console.log(`провайдер sim: ${st.installed ? `установлен, ${st.models} моделей, ${st.baseURL}` : 'не установлен'}`)
  console.log(`прокси: ${health ? `работает, ${health.models} моделей` : 'не отвечает'}`)
} else if (cmd === 'autostart-on') setAutostart(true)
else if (cmd === 'autostart-off') setAutostart(false)
else if (!cmd) {
  if (!(await alive(cfg))) warn(`Прокси не запущен (порт ${cfg.port})`)
  await menu(cfg)
} else {
  console.log(
    'Использование: node src/cli.mjs [setup|start|stop|restart|status|test|logs|models|opencode-install|opencode-remove|opencode-status|autostart-on|autostart-off]',
  )
}

rl.close()
