// Sim -> OpenAI-compatible proxy for OpenCode (v2)
//
// GET  /v1/models            hosted models (?all=1 for the full catalog)
// POST /v1/chat/completions   OpenAI chat format, SSE supported
// GET  /health, /stats        liveness and counters
//
// Backend: Sim's llm_chat tool. Sim has no `tools` parameter, so tool calling is
// emulated in the prompt and repaired on the way back.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRateLimiter } from './ratelimit.mjs'
import { sanitizeModelText, hasBrFlood } from './sanitize.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = process.env.SIM_PROVIDER_CONFIG
  ? path.resolve(process.env.SIM_PROVIDER_CONFIG)
  : path.join(ROOT, 'config.json')
const MODELS_CACHE = path.join(ROOT, 'models.cache.json')

const DEFAULTS = {
  simApiKey: '',
  workspaceId: '',
  port: 8787,
  toolEmulation: true,
  toolTemperature: 0,
  maxConcurrent: 0,
  requestTimeoutMs: 320000,
  simTimeoutSec: 300,
  fallbackModel: '',
  cache: { enabled: true, ttlMs: 600000, maxEntries: 200, maxBytes: 8388608, persist: true, ttlByModel: {} },
  streamPacing: { enabled: false, chunkChars: 12, delayMs: 20 },
  proxyTools: { now: true, web_fetch: true },
  nudge: { enabled: true, maxRetries: 2 },
  chunking: { enabled: true, maxParts: 24 },
  contextDedupe: { enabled: true, minChars: 1500, staleReads: true },
  earlyHeadersMs: 90000,
  localToken: '',
  maxProxyToolHops: 3,
}

function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    console.error(`[fatal] cannot read ${CONFIG_PATH}: ${err.message}`)
    console.error('[hint] run setup.bat')
    process.exit(1)
  }
  if (!raw.simApiKey || !raw.workspaceId) {
    console.error('[fatal] simApiKey and workspaceId are required in config.json')
    console.error('[hint] run setup.bat')
    process.exit(1)
  }
  return {
    ...DEFAULTS,
    ...raw,
    cache: { ...DEFAULTS.cache, ...(raw.cache || {}) },
    streamPacing: { ...DEFAULTS.streamPacing, ...(raw.streamPacing || {}) },
    proxyTools: { ...DEFAULTS.proxyTools, ...(raw.proxyTools || {}) },
    nudge: { ...DEFAULTS.nudge, ...(raw.nudge || {}) },
    chunking: { ...DEFAULTS.chunking, ...(raw.chunking || {}) },
    contextDedupe: { ...DEFAULTS.contextDedupe, ...(raw.contextDedupe || {}) },
  }
}

const cfg = loadConfig()
const SIM_API = 'https://www.sim.ai/api/v2'

// Sim's execute endpoint cuts a call off at 120 s unless `timeoutSeconds` says
// otherwise, and the plan caps that at 300. Our own abort has to stay above it
// so Sim's error, not ours, is what the caller sees.
const SIM_TIMEOUT_SEC = Math.min(300, Math.max(0, Number(cfg.simTimeoutSec) || 0))
const CALL_TIMEOUT_MS = Math.max(Number(cfg.requestTimeoutMs) || 0, SIM_TIMEOUT_SEC * 1000 + 15000)

const FALLBACK_MODELS = [
  'claude-sonnet-5-5', 'claude-opus-5', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5',
  'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.5',
  'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro',
  'grok-4.7', 'kimi-k2.7-code', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro',
]

const log = (...args) => console.log(new Date().toISOString(), ...args)
const short = (s, n = 300) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}...(${s.length})` : s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Sim allows 60 calls per minute per workspace (x-ratelimit-limit). Shared by every
// call to llm_chat, so chunked parts and parallel requests stay under it.
const limiter = createRateLimiter(log)

// Exponential backoff with jitter, capped so a retry never stalls a request for long.
function backoffMs(attempt, base = 600, cap = 15000) {
  return Math.min(cap, Math.round(base * Math.pow(2.5, attempt) * (0.85 + Math.random() * 0.3)))
}

// ------------------------------------------------------------------- stats
const stats = {
  startedAt: new Date().toISOString(),
  chatRequests: 0,
  emulatedToolCalls: 0,
  proxyToolRuns: 0,
  nudges: 0,
  cacheHits: 0,
  errors: 0,
  timeouts: 0,
  chunks: 0,
  chunkShrinks: 0,
  fallbacks: 0,
  brFloods: 0,
  dedupedResults: 0,
  lastErrors: [],
  tokensIn: 0,
  tokensOut: 0,
  latencyMs: 0,
  byModel: {},
}

function rememberError(message) {
  stats.lastErrors.unshift({ at: new Date().toISOString(), message: short(String(message), 300) })
  if (stats.lastErrors.length > 5) stats.lastErrors.length = 5
}

// Ring buffer of the last requests: what was sent, how long each part took, how
// it ended. Read with GET /trace and shown by the panel.
const traces = []
function traceRequest(entry) {
  traces.unshift(entry)
  if (traces.length > 20) traces.length = 20
}

// Requests currently waiting on Sim, so /stats and the panel can show what is
// happening right now instead of only what already finished.
const inflight = new Map()

function bump(model, ms, tokensIn, tokensOut) {
  const m = (stats.byModel[model] = stats.byModel[model] || { calls: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0 })
  m.calls++
  m.tokensIn += tokensIn
  m.tokensOut += tokensOut
  m.latencyMs += ms
  stats.tokensIn += tokensIn
  stats.tokensOut += tokensOut
  stats.latencyMs += ms
}

// ---------------------------------------------------------------- semaphore
class Semaphore {
  constructor(n) {
    this.free = n
    this.queue = []
  }
  acquire() {
    if (this.free > 0) {
      this.free--
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }
  release() {
    const next = this.queue.shift()
    if (next) next()
    else this.free++
  }
}
// A configured limit above zero caps parallel Sim calls; 0 (or less) means no cap.
const gateLimit = Number(cfg.maxConcurrent)
const gate =
  gateLimit > 0
    ? new Semaphore(gateLimit)
    : { acquire: () => Promise.resolve(), release: () => {} }

// ------------------------------------------------------------------- models
let models = { at: 0, hosted: [], all: [] }

function readModelsCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_CACHE, 'utf8'))
    if (raw && Array.isArray(raw.hosted) && raw.hosted.length && Date.now() - raw.at < 24 * 3600 * 1000) {
      models = raw
      return true
    }
  } catch {}
  return false
}

async function refreshModels() {
  try {
    const res = await fetch(`${SIM_API}/blocks/agent?workspaceId=${encodeURIComponent(cfg.workspaceId)}`, {
      headers: { 'X-API-Key': cfg.simApiKey },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`)
    const body = await res.json()
    const field = ((body.data && body.data.inputSchema) || []).find((f) => f && f.id === 'model' && Array.isArray(f.options))
    if (!field) throw new Error('model field not found')
    const all = field.options.map((o) => o.id)
    // `jev-*` are evaluation models: Sim rejects chat requests against them.
    const hosted = field.options.filter((o) => o.hosted).map((o) => o.id).filter((id) => !/^jev-/i.test(id))
    models = { at: Date.now(), hosted, all }
    fs.writeFileSync(MODELS_CACHE, JSON.stringify(models, null, 1))
    log(`catalog: ${hosted.length} hosted / ${all.length} total`)
  } catch (err) {
    log('catalog refresh failed:', err.message)
    if (!models.hosted.length) models = { at: 0, hosted: FALLBACK_MODELS, all: FALLBACK_MODELS }
  }
}

// ------------------------------------------------------------------ proxies
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»' }

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+);/gi, (m, e) => HTML_ENTITIES[e.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
  }
  return false
}

const PROXY_TOOLS = {
  now: {
    spec: {
      name: 'now',
      description: 'Current local date and time, with timezone and ISO string. Use when the task depends on the current date/time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: async () => `${new Date().toString()} | ISO ${new Date().toISOString()} | tz ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  },
  web_fetch: {
    spec: {
      name: 'web_fetch',
      description: 'Fetch a public http(s) URL and return its readable text (scripts and markup stripped).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL' },
          max_chars: { type: 'number', description: 'Max characters to return, default 8000' },
        },
        required: ['url'],
      },
    },
    run: async ({ url, max_chars }) => {
      let parsed
      try {
        parsed = new URL(String(url))
      } catch {
        throw new Error('invalid url')
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) is allowed')
      if (isPrivateHost(parsed.hostname)) throw new Error('private/loopback addresses are blocked')
      const res = await fetch(parsed, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sim-provider/2.0)', Accept: 'text/html,text/plain,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      })
      const type = res.headers.get('content-type') || ''
      const body = await res.text()
      const text = /html|xml/i.test(type) ? htmlToText(body) : body.trim()
      const limit = Math.min(Math.max(Number(max_chars) || 8000, 500), 40000)
      return `HTTP ${res.status} ${type}\n\n${text.slice(0, limit)}${text.length > limit ? `\n...[truncated ${text.length - limit} chars]` : ''}`
    },
  },
}

function activeProxyTools() {
  return Object.entries(PROXY_TOOLS)
    .filter(([name]) => cfg.proxyTools && cfg.proxyTools[name])
    .map(([name, t]) => ({ type: 'function', function: t.spec }))
}

// ---------------------------------------------------------------- sim client
const CONTINUE_MARK = '<<<CONTINUE>>>'

// Some models answer in HTML when the task feels like a web page. OpenCode
// renders markdown, so a <br> ends up as a wall of blank lines; say it plainly.
const FORMAT_RULE =
  'Formatting: answer in markdown with real line breaks. Never emit HTML tags such as <br>, <p> or <div>.'

// Sim cuts a single tool call off at its timeout (120 s by default, 300 s when
// configured), and answers that hit max_tokens come back empty. So long answers
// are produced in parts and stitched together.
const DEFAULT_CHUNK = { words: 250, lines: 100 }
const chunkSizes = new Map()
const CHUNK_STATE = path.join(ROOT, 'chunk.state.json')
let chunkSaveTimer = null

// Learned part sizes survive a restart, so a slow model does not have to hit the
// 120 s wall once more just to rediscover its own safe size.
function loadChunkSizes() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHUNK_STATE, 'utf8').replace(/^\uFEFF/, ''))
    for (const [model, size] of Object.entries(raw)) {
      const words = Number(size && size.words)
      const lines = Number(size && size.lines)
      if (words > 0) chunkSizes.set(model, { words, lines: lines > 0 ? lines : 60 })
    }
  } catch {}
}

function saveChunkSizes() {
  if (chunkSaveTimer) return
  chunkSaveTimer = setTimeout(() => {
    chunkSaveTimer = null
    try {
      fs.writeFileSync(CHUNK_STATE, JSON.stringify(Object.fromEntries(chunkSizes), null, 2) + '\n')
    } catch {}
  }, 1000)
  chunkSaveTimer.unref?.()
}

function chunkSize(model) {
  return chunkSizes.get(model) || { ...DEFAULT_CHUNK }
}

function chunkingInstruction(size) {
  return (
    `Long-answer rule: when your reply would run longer than about ${size.words} words, or you are about to ` +
    `write a file longer than about ${size.lines} lines, do not write it all at once. Write the first part only ` +
    `and end that message with a line containing exactly ${CONTINUE_MARK}. A tool call that would carry a very ` +
    'large file is split into several smaller calls instead: write the first half, then append the rest with ' +
    'edit/patch calls. Otherwise answer normally and never mention this rule.'
  )
}

async function simChatChunked({ model, systemPrompt, context, temperature, maxTokens, signal, onPart }) {
  if (!cfg.chunking.enabled) {
    const t0 = Date.now()
    const res = await simChat({ model, systemPrompt, context, temperature, maxTokens, signal })
    if (onPart && res.content) await onPart(res.content, 0)
    return { ...res, chunks: 1, partsMs: [Date.now() - t0] }
  }

  // A large client-side cap would only make Sim return an empty body when hit.
  const limit = typeof maxTokens === 'number' && maxTokens > 0 && maxTokens <= 2000 ? maxTokens : undefined
  const maxParts = cfg.chunking.maxParts || 24
  const parts = []
  const partsMs = []
  const tokens = { input: 0, output: 0, total: 0 }
  let ctx = context
  let cost = null
  let hint = ''
  let size = chunkSize(model)
  let truncated = false

  for (let i = 0; i < maxParts; i++) {
    const system = [systemPrompt, chunkingInstruction(size), hint].filter(Boolean).join('\n\n')
    const t0 = Date.now()
    let res
    try {
      res = await simChat({ model, systemPrompt: system, context: ctx, temperature, maxTokens: limit, signal })
    } catch (err) {
      // A part that is still too long gets one retry with a smaller budget, and
      // that budget sticks for the next parts of this model.
      if (err.code === 'TIMEOUT' && !hint) {
        size = {
          words: Math.max(80, Math.round(size.words * 0.6)),
          lines: Math.max(40, Math.round(size.lines * 0.6)),
        }
        chunkSizes.set(model, size)
        saveChunkSizes()
        stats.chunkShrinks++
        log(`chunk ${i + 1} of ${model} timed out, shrinking to ${size.words} words / ${size.lines} lines`)
        hint =
          `The previous attempt was cut off for being too long. This time write a much shorter part: ` +
          `at most ${size.words} words (or ${size.lines} lines of code), and end it with ${CONTINUE_MARK}.`
        i--
        continue
      }
      throw err
    }
    const took = Date.now() - t0
    partsMs.push(took)

    // Recover the budget slowly when parts finish with plenty of room.
    if (took < 25000 && (size.words < DEFAULT_CHUNK.words || size.lines < DEFAULT_CHUNK.lines)) {
      size = {
        words: Math.min(DEFAULT_CHUNK.words, Math.round(size.words * 1.2)),
        lines: Math.min(DEFAULT_CHUNK.lines, Math.round(size.lines * 1.2)),
      }
      chunkSizes.set(model, size)
      saveChunkSizes()
    }

    if (res.tokens) {
      tokens.input += res.tokens.input || 0
      tokens.output += res.tokens.output || 0
      tokens.total += res.tokens.total || 0
    }
    if (res.cost) cost = res.cost
    let text = res.content || ''
    if (text.includes(CONTINUE_MARK)) {
      text = text.split(CONTINUE_MARK).join('')
      parts.push(text)
      stats.chunks++
      if (onPart) await onPart(text, parts.length - 1)
      ctx =
        `${context}\n\n[assistant]\n${parts.join('')}\n\n[user]\n` +
        `Continue exactly where you stopped. Do not repeat anything and do not add commentary. ` +
        `If more remains, end with ${CONTINUE_MARK} on its own line.`
      continue
    }
    parts.push(text)
    if (onPart) await onPart(text, parts.length - 1)
    return { content: parts.join(''), tokens, cost, chunks: parts.length, partsMs }
  }

  // The loop ended because of the part limit, not because the model finished.
  truncated = true
  stats.chunkLimitHits = (stats.chunkLimitHits || 0) + 1
  log(`chunk limit ${maxParts} reached for ${model}: the answer is truncated`)
  return { content: parts.join(''), tokens, cost, chunks: parts.length, partsMs, truncated }
}

async function simChat({ model, systemPrompt, context, temperature, maxTokens, signal }) {
  let limit = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : undefined
  let lastErr

  for (let attempt = 0; attempt < 3; attempt++) {
    const input = { model, context }
    if (systemPrompt) input.systemPrompt = systemPrompt
    if (typeof temperature === 'number') input.temperature = temperature
    if (limit) input.maxTokens = limit

    const body = JSON.stringify({
      workspaceId: cfg.workspaceId,
      input,
      ...(SIM_TIMEOUT_SEC > 0 ? { timeoutSeconds: SIM_TIMEOUT_SEC } : {}),
    })

    await gate.acquire()
    try {
      await limiter.before()
      const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS)
      const composed = signal && AbortSignal.any ? AbortSignal.any([timeout, signal]) : timeout
      const res = await fetch(`${SIM_API}/tools/llm_chat/execute`, {
        method: 'POST',
        headers: { 'X-API-Key': cfg.simApiKey, 'Content-Type': 'application/json' },
        body,
        signal: composed,
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`Sim returned non-JSON (HTTP ${res.status}): ${short(text, 160)}`)
      }
      limiter.note(res, data)
      if (!res.ok) {
        const msg = (data.error && (data.error.message || data.error.code)) || `HTTP ${res.status}`
        if (res.status === 429) {
          const wait = limiter.state().waitMs
          // One wait for the window is fine; a second one would keep the caller
          // hanging for minutes, so hand the 429 back instead.
          if (attempt === 0 && wait > 0) {
            lastErr = new Error(`Sim 429: ${msg}`)
            stats.rateLimited = (stats.rateLimited || 0) + 1
            await limiter.waitForReset()
            continue
          }
          const err = new Error(`Sim 429: ${msg} (Sim limit is 60 requests per minute)`)
          err.status = 429
          err.retryAfterMs = Math.max(1000, wait)
          throw err
        }
        if (res.status >= 500 && attempt < 2) {
          lastErr = new Error(`Sim ${res.status}: ${msg}`)
          const wait = backoffMs(attempt)
          log(`Sim ${res.status}, retrying in ${wait}ms`)
          await sleep(wait)
          continue
        }
        const err = new Error(`Sim ${res.status}: ${msg}`)
        err.status = res.status
        throw err
      }
      const payload = data.data || {}
      if (payload.status === 'failed') {
        const msg =
          (payload.output && payload.output.data && payload.output.data.error) ||
          (payload.error && payload.error.message) ||
          'tool failed'
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
        const err = new Error(`Sim model error: ${text}`)
        // Sim cuts a model call off at its timeout and reports it as a failed run.
        // "Provider X is not available" is permanent: the model exists in the
        // catalogue but cannot be reached, so it must not be swapped silently.
        const timedOut = /timed?\s?out|timeout/i.test(text)
        const unavailable =
          /is not available|no longer available|unknown model|api key is required|unsupported model|evaluation or chat modality|modality|does not exist|do not have access|api error \(404\)/i.test(
            text,
          )
        err.code = timedOut ? 'TIMEOUT' : unavailable ? 'UNAVAILABLE' : 'SIM_FAILED'
        err.status = timedOut ? 504 : unavailable ? 404 : 502
        throw err
      }
      const out = payload.output || {}
      const rawAnswer = typeof out.content === 'string' ? out.content : ''
      // Haiku-class models sometimes loop on <br>; turn that into newlines before
      // anything else sees the text (streaming parts, JSON scan, the client).
      if (hasBrFlood(rawAnswer)) {
        stats.brFloods++
        log(`<br> flood from ${model}: ${rawAnswer.length} chars, cleaning`)
      }
      const answer = sanitizeModelText(rawAnswer)
      // Nothing but markup: ask again instead of handing the client an empty reply.
      if (!answer && hasBrFlood(rawAnswer) && attempt < 2) {
        stats.emptyRetries = (stats.emptyRetries || 0) + 1
        lastErr = new Error('Sim returned only <br> markup')
        log(`${model} answered with <br> tags only, retrying`)
        continue
      }
      // Sim answers with an empty body when a reply is cut off by maxTokens, so
      // ask again without the cap instead of handing the client an empty answer.
      if (!answer && limit && out.tokens && Number(out.tokens.output) >= limit) {
        stats.emptyRetries = (stats.emptyRetries || 0) + 1
        log(`empty answer from ${model} at maxTokens=${limit}, retrying without the cap`)
        limit = undefined
        continue
      }
      return {
        content: answer,
        tokens: out.tokens || null,
        cost: out.cost || null,
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err
      lastErr = err
      if (/fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(String(err.message)) && attempt < 2) {
        const wait = backoffMs(attempt)
        log(`network error from Sim (${short(err.message, 80)}), retrying in ${wait}ms`)
        await sleep(wait)
        continue
      }
      throw err
    } finally {
      gate.release()
    }
  }
  throw lastErr
}

// ------------------------------------------------------ tool-call emulation
function toolSpecPrompt(tools) {
  const specs = tools.map((t) => {
    const fn = t.function || t
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    }
  })
  const first = specs[0] || { name: 'read' }
  const firstProps = (first.parameters && first.parameters.properties) || {}
  const exampleArg = firstProps.path ? '{"path":"src/index.ts"}' : firstProps.command ? '{"command":"node --version"}' : '{}'
  return [
    '## TOOL CALLING PROTOCOL (highest priority)',
    'You have tools. To read or change files, run commands, search, or touch the outside world you MUST call a tool.',
    'Never claim something was done without calling the matching tool. Never invent tool output.',
    'Tool definitions:',
    '```json',
    JSON.stringify(specs),
    '```',
    'Reply to this block with ONLY a JSON object, no prose, no code fences:',
    '{"tool_calls":[{"name":"<tool_name>","arguments":{...}}]}',
    `Example: {"tool_calls":[{"name":"${first.name}","arguments":${exampleArg}}]}`,
    'Rules:',
    '- Several calls may share the array.',
    '- Tool results arrive as `[tool result ...]`; continue from them.',
    '- If a result already reports success, do not repeat that call.',
    '- Only when no tool is needed, answer as plain text (never JSON).',
    '- Never use tool names outside this list.',
    '- Write real line breaks; never emit HTML tags such as <br>, <p> or <div>.',
    '- No XML (<invoke>, <parameter>, antml:*), no markdown fences around the JSON.',
  ].join('\n')
}

function normalizeCalls(obj, allowed) {
  let raw = null
  if (Array.isArray(obj)) raw = obj
  else if (obj && Array.isArray(obj.tool_calls)) raw = obj.tool_calls
  else if (obj && Array.isArray(obj.toolCalls)) raw = obj.toolCalls
  else if (obj && Array.isArray(obj.calls)) raw = obj.calls
  else if (obj && typeof obj.name === 'string' && (obj.arguments || obj.parameters || obj.input)) raw = [obj]
  else if (obj && obj.function && typeof obj.function.name === 'string') raw = [{ ...obj.function }]
  if (!raw || !raw.length) return null

  const calls = []
  for (const item of raw) {
    const fn = item.function || item
    const name = fn.name || fn.tool || fn.tool_name
    if (typeof name !== 'string' || (allowed && !allowed.has(name))) continue
    let args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {}
    if (typeof args === 'string') {
      const trimmed = args.trim()
      if (trimmed && !/^[[{"]/.test(trimmed)) continue
      try {
        args = JSON.parse(trimmed || '{}')
      } catch {
        continue
      }
    }
    calls.push({ name, arguments: JSON.stringify(args ?? {}) })
  }
  return calls.length ? calls : null
}

function jsonCandidates(text) {
  const out = []
  const sources = [text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1'), text]
  for (const src of sources) {
    for (let i = 0; i < src.length && out.length < 60; i++) {
      if (src[i] !== '{') continue
      let depth = 0
      let inStr = false
      let esc = false
      for (let j = i; j < src.length; j++) {
        const c = src[j]
        if (inStr) {
          if (esc) esc = false
          else if (c === '\\') esc = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') inStr = true
        else if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            out.push(src.slice(i, j + 1))
            i = j
            break
          }
        }
      }
    }
    if (out.length) break
  }
  return out
}

function extractJsonCalls(text, tools) {
  if (!tools || !tools.length || text.length > 40000) return null
  const allowed = new Set(tools.map((t) => (t.function || t).name))
  for (const candidate of jsonCandidates(text)) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const calls = normalizeCalls(parsed, allowed)
    if (calls) return calls
  }
  return null
}

function extractXmlCalls(text, tools) {
  if (!tools || !tools.length) return null
  const allowed = new Set(tools.map((t) => (t.function || t).name))
  const calls = []
  const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/g
  let m
  while ((m = invokeRe.exec(text)) !== null) {
    const attrs = m[1] || ''
    const inner = m[2] || ''
    const nameMatch = /name\s*=\s*"([^"]+)"/.exec(attrs) || /name\s*=\s*'([^']+)'/.exec(attrs)
    let name = nameMatch && nameMatch[1]
    if (!name) {
      const t = /<tool_name>([\s\S]*?)<\/tool_name>/.exec(inner)
      name = t && t[1].trim()
    }
    if (!name || !allowed.has(name)) continue
    const args = {}
    const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/g
    let p
    while ((p = paramRe.exec(inner)) !== null) {
      const key = (/(?:name|key)\s*=\s*"([^"]+)"/.exec(p[1] || '') || [])[1]
      if (!key) continue
      const rawValue = p[2].trim()
      let value = rawValue
      if (/^[[{]/.test(rawValue)) {
        try {
          value = JSON.parse(rawValue)
        } catch {}
      }
      args[key] = value
    }
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return calls.length ? calls : null
}

const stripXml = (text) =>
  text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/g, '')
    .replace(/<\/?antml:[^>]*>/g, '')
    .trim()

// Coerce one argument against its JSON-schema fragment.
function coerceValue(value, def) {
  if (value === undefined || def == null) return value
  const type = Array.isArray(def.type) ? def.type[0] : def.type
  if (type === 'string') {
    if (typeof value === 'string') return value
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  if (type === 'number' || type === 'integer') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[,_\s]/g, ''))
    if (!Number.isNaN(n)) return type === 'integer' ? Math.trunc(n) : n
    return value
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    const s = String(value).trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return false
    return value
  }
  if (type === 'array') {
    const items = def.items
    if (Array.isArray(value)) return items ? value.map((v) => coerceValue(v, items)) : value
    return [items ? coerceValue(value, items) : value]
  }
  if (type === 'object') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object') return parsed
      } catch {}
    }
    return value
  }
  return value
}

// Fill/coerce arguments against the tool schema so providers stop rejecting calls.
function repairCalls(calls, tools) {
  const byName = new Map(tools.map((t) => [(t.function || t).name, t.function || t]))
  const byLower = new Map(tools.map((t) => [(t.function || t).name.toLowerCase(), t.function || t]))
  const out = []
  for (const call of calls) {
    const fn = byName.get(call.name) || byLower.get(String(call.name || '').toLowerCase())
    const name = (fn && fn.name) || call.name
    let args
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      args = {}
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
    const schema = (fn && fn.parameters) || {}
    const props = schema.properties || {}
    const required = schema.required || []
    for (const key of Object.keys(args)) if (Object.keys(props).length && !props[key]) delete args[key]
    for (const [key, def] of Object.entries(props)) {
      let value = args[key]
      if (value === undefined || value === null || value === '') {
        if (def && def.default !== undefined) args[key] = def.default
        else if (required.includes(key)) {
          const want = def && def.type
          args[key] = want === 'number' || want === 'integer' ? 0 : want === 'boolean' ? false : want === 'array' ? [] : want === 'object' ? {} : ''
        }
        continue
      }
      args[key] = coerceValue(value, def)
      if (Array.isArray(def.enum) && def.enum.length && !def.enum.includes(args[key])) {
        const match = def.enum.find((v) => String(v).toLowerCase() === String(args[key]).toLowerCase())
        if (match !== undefined) args[key] = match
      }
    }
    out.push({ name, arguments: JSON.stringify(args) })
  }
  return out
}

const looksLikeFailedCall = (text) =>
  /<invoke|tool_calls|"arguments"|"parameters"|```json/i.test(text) && text.length < 4000

function canonCall(call) {
  try {
    const args = JSON.parse(call.arguments || '{}')
    const sort = (v) =>
      Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v
    return `${call.name}:${JSON.stringify(sort(args))}`
  } catch {
    return `${call.name}:${call.arguments}`
  }
}

function alreadyExecutedCalls(transcript) {
  const set = new Set()
  const re = /\[tool call ([^\s#]+) #[^\]]*\]\n([^\n]*)/g
  let m
  while ((m = re.exec(transcript)) !== null) set.add(canonCall({ name: m[1], arguments: m[2] }))
  return set
}

// -------------------------------------------------------------- transcript
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && part.type === 'text') return part.text || ''
        if (part && (part.type === 'image_url' || part.type === 'image')) return '[image omitted]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

// Resource key so a repeated read of the same file can be collapsed: only the
// newest copy is authoritative, older ones are stale and only cost prefill.
function staleKey(name, args) {
  if (!args || typeof args !== 'object') return null
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const file = args.filePath || args.path
  if (name === 'read' && file) return `read:${norm(file)}:${args.offset ?? ''}:${args.limit ?? ''}`
  if (name === 'grep' && args.pattern) return `grep:${args.pattern}:${norm(args.path || '')}`
  if (name === 'glob' && args.pattern) return `glob:${args.pattern}:${norm(args.path || '')}`
  return null
}

function buildTranscript(messages) {
  const systems = []
  const turns = []
  const nameById = new Map()
  const argsById = new Map()
  const list = messages || []

  // Tool call id -> name/arguments, so tool results can be matched to their call.
  for (const msg of list) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const c of msg.tool_calls) {
      if (!c.id) continue
      nameById.set(c.id, (c.function || {}).name)
      let parsed = null
      try {
        parsed = JSON.parse((c.function || {}).arguments || '{}')
      } catch {}
      if (parsed) argsById.set(c.id, parsed)
    }
  }

  // An identical tool result repeated later in the history is replaced by a note:
  // the model already sees the newest copy, and the older one only costs prefill.
  const duplicates = new Set()
  const stale = new Set()
  if (cfg.contextDedupe.enabled !== false) {
    const seen = new Map()
    const minChars = cfg.contextDedupe.minChars || 1500
    const latestByResource = new Map()
    const staleMinChars = cfg.contextDedupe.staleMinChars || 500
    list.forEach((msg, i) => {
      if (msg.role !== 'tool' || typeof msg.content !== 'string') return
      if (msg.content.length < minChars) return
      const prev = seen.get(msg.content)
      if (prev !== undefined) duplicates.add(prev)
      seen.set(msg.content, i)
    })
    if (cfg.contextDedupe.staleReads !== false) {
      list.forEach((msg, i) => {
        if (msg.role !== 'tool' || typeof msg.content !== 'string') return
        if (msg.content.length < staleMinChars) return
        const name = nameById.get(msg.tool_call_id) || msg.name
        const key = staleKey(name, argsById.get(msg.tool_call_id))
        if (!key) return
        const prev = latestByResource.get(key)
        if (prev !== undefined) stale.add(prev)
        latestByResource.set(key, i)
      })
    }
  }

  list.forEach((msg, index) => {
    const role = msg.role
    if (role === 'system' || role === 'developer') {
      systems.push(contentToText(msg.content))
      return
    }
    if (role === 'tool') {
      const id = msg.tool_call_id || ''
      const name = nameById.get(id) || msg.name || 'tool'
      if (duplicates.has(index)) {
        stats.dedupedResults++
        turns.push(`[tool result ${name}${id ? ` #${id}` : ''}]\n(same output as a later call, omitted)`)
        return
      }
      if (stale.has(index)) {
        stats.staleResults = (stats.staleResults || 0) + 1
        turns.push(`[tool result ${name}${id ? ` #${id}` : ''}]\n(stale: this file was read again later, see the newest result)`)
        return
      }
      turns.push(`[tool result ${name}${id ? ` #${id}` : ''}]\n${contentToText(msg.content)}`)
      return
    }
    if (role === 'assistant') {
      const text = contentToText(msg.content)
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const rendered = msg.tool_calls
          .map((c) => `[tool call ${(c.function || {}).name} #${c.id || ''}]\n${(c.function || {}).arguments || '{}'}`)
          .join('\n')
        turns.push(`[assistant]\n${text ? `${text}\n` : ''}${rendered}`)
      } else if (text) turns.push(`[assistant]\n${text}`)
      return
    }
    turns.push(`[${role || 'user'}]\n${contentToText(msg.content)}`)
  })

  return { system: systems.filter(Boolean).join('\n\n'), context: turns.join('\n\n') }
}

// ------------------------------------------------------------------ cache
// Answers are cached only for plain (non-tool) requests at temperature 0. The
// cache lives in memory and is mirrored to disk so a restart does not lose it.
const CACHE_FILE = path.join(ROOT, 'cache.json')
const CACHE_MAX_BYTES = Number(cfg.cache.maxBytes) || 8 * 1024 * 1024

const cache = new Map() // key -> { at, model, value, bytes }
let cacheBytes = 0
let cacheSaveTimer = null

function cacheKey(parts) {
  return crypto.createHash('sha1').update(parts).digest('hex')
}

// A model can be told to keep its answers longer (or shorter) than the default.
function cacheTtl(model) {
  const byModel = cfg.cache.ttlByModel || {}
  const ttl = Number(byModel[model])
  return ttl > 0 ? ttl : cfg.cache.ttlMs
}

function cacheDrop(key) {
  const hit = cache.get(key)
  if (!hit) return false
  cacheBytes -= hit.bytes
  return cache.delete(key)
}

function cacheGet(key, model) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > cacheTtl(hit.model || model)) {
    cacheDrop(key)
    return null
  }
  // LRU: re-insert so the newest entry is at the end of the Map.
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

function cacheSet(key, value, model) {
  const bytes = Buffer.byteLength(value) + 64
  if (bytes > CACHE_MAX_BYTES / 4) return // one answer must not own the file
  cacheDrop(key)
  const maxEntries = Math.max(1, Number(cfg.cache.maxEntries) || 200)
  while (cache.size && (cache.size >= maxEntries || cacheBytes + bytes > CACHE_MAX_BYTES)) {
    cacheDrop(cache.keys().next().value)
  }
  cache.set(key, { at: Date.now(), model, value, bytes })
  cacheBytes += bytes
  scheduleCacheSave()
}

function scheduleCacheSave() {
  if (cacheSaveTimer) return
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null
    try {
      const entries = {}
      for (const [key, hit] of cache) entries[key] = { at: hit.at, model: hit.model, value: hit.value }
      const tmp = `${CACHE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), entries }))
      fs.renameSync(tmp, CACHE_FILE)
    } catch (err) {
      log(`cache save failed: ${err.message}`)
    }
  }, 2000)
  cacheSaveTimer.unref?.()
}

function loadCache() {
  if (!cfg.cache.enabled || cfg.cache.persist === false) return
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return
  }
  const entries = (raw && raw.entries) || {}
  const now = Date.now()
  const list = []
  for (const [key, hit] of Object.entries(entries)) {
    if (!hit || typeof hit.value !== 'string' || !hit.at) continue
    if (now - hit.at > cacheTtl(hit.model)) continue
    list.push([key, hit])
  }
  list.sort((a, b) => a[1].at - b[1].at)
  for (const [key, hit] of list) cacheSet(key, hit.value, hit.model)
  // cacheSet schedules a save; the loaded file is already current, so skip it.
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer)
  cacheSaveTimer = null
  const kept = cache.size
  const dropped = Object.keys(entries).length - kept
  log(`cache loaded: ${kept} entries${dropped > 0 ? `, ${dropped} expired/over limit` : ''}`)
}

function cacheInfo() {
  return {
    enabled: Boolean(cfg.cache.enabled),
    persist: cfg.cache.persist !== false,
    entries: cache.size,
    bytes: cacheBytes,
    maxEntries: cfg.cache.maxEntries,
    maxBytes: CACHE_MAX_BYTES,
    ttlMs: cfg.cache.ttlMs,
    ttlByModel: cfg.cache.ttlByModel || {},
  }
}

// -------------------------------------------------------- rolling metrics
// Last N finished chat requests, kept so /stats can show an hour-long view:
// per-model latency percentiles, 429/timeout share, answer size, cache hit rate.
const RECENT_MAX = 500
const recent = []

function recordRequest(entry) {
  recent.unshift({ ...entry, at: Date.now() })
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function windowMetrics(windowMs = 3600000) {
  const since = Date.now() - windowMs
  const rows = recent.filter((r) => r.at >= since)
  const byModel = new Map()
  let hits = 0
  let lookups = 0
  for (const r of rows) {
    const m = byModel.get(r.model) || {
      model: r.model, requests: 0, ok: 0, errors: 0, rateLimited: 0, timeouts: 0,
      cacheHits: 0, cacheLookups: 0, latencies: [], outTokens: 0, outChars: 0,
    }
    m.requests++
    if (r.outcome === 'ok' || r.outcome === 'truncated') m.ok++
    else m.errors++
    if (r.rateLimited) m.rateLimited++
    if (r.outcome === 'timeout') m.timeouts++
    if (r.cache === 'hit') {
      m.cacheHits++
      hits++
    }
    if (r.cache === 'hit' || r.cache === 'miss') {
      m.cacheLookups++
      lookups++
    }
    m.latencies.push(r.ms)
    m.outTokens += r.outTokens || 0
    m.outChars += r.outChars || 0
    byModel.set(r.model, m)
  }
  const models = [...byModel.values()]
    .map((m) => {
      const sorted = m.latencies.sort((a, b) => a - b)
      const pct = (n) => (m.requests ? Math.round((n / m.requests) * 1000) / 10 : 0)
      return {
        model: m.model,
        requests: m.requests,
        errors: m.errors,
        rateLimitedPct: pct(m.rateLimited),
        timeoutPct: pct(m.timeouts),
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        avgTokensOut: Math.round(m.outTokens / m.requests),
        avgChars: Math.round(m.outChars / m.requests),
        cacheHitRate: m.cacheLookups ? Math.round((m.cacheHits / m.cacheLookups) * 1000) / 10 : null,
      }
    })
    .sort((a, b) => b.requests - a.requests)
  return {
    windowMs,
    since: new Date(since).toISOString(),
    requests: rows.length,
    cacheHitRate: lookups ? Math.round((hits / lookups) * 1000) / 10 : null,
    models,
  }
}

// --------------------------------------------------------------- http utils
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function openaiError(res, status, message, type = 'api_error', code = null) {
  json(res, status, { error: { message, type, code, param: null } })
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const newId = () => `chatcmpl-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
const newCallId = () => `call_${Math.random().toString(36).slice(2, 12)}`

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}
const sendSse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

// ------------------------------------------------------------------- chat
async function handleChat(req, res) {
  const startedAll = Date.now()
  const raw = await readBody(req)
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return openaiError(res, 400, 'invalid JSON body', 'invalid_request_error')
  }

  const requestedModel = body.model
  if (!requestedModel) return openaiError(res, 400, 'model is required', 'invalid_request_error')
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) return openaiError(res, 400, 'messages is required', 'invalid_request_error')

  const clientTools = Array.isArray(body.tools) ? body.tools.filter((t) => t && (t.function || t.name)) : []
  const emulation = cfg.toolEmulation !== false && clientTools.length > 0
  const proxyTools = emulation ? activeProxyTools() : []
  const tools = [...clientTools, ...proxyTools]
  const proxyNames = new Set(proxyTools.map((t) => t.function.name))

  const { system, context: transcript } = buildTranscript(messages)
  const toolBlock = emulation ? toolSpecPrompt(tools) : ''
  const systemPrompt = [
    system,
    FORMAT_RULE,
    emulation ? 'Tool calling protocol is defined at the very end of the transcript. Follow it exactly.' : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const temperature =
    typeof body.temperature === 'number' ? body.temperature : emulation ? cfg.toolTemperature : undefined
  const maxTokens = body.max_tokens || body.maxTokens

  const cacheable =
    cfg.cache.enabled && !emulation && (temperature === undefined || temperature === 0) && req.headers['x-sim-no-cache'] !== '1'
  const ckey = cacheable ? cacheKey([requestedModel, systemPrompt, transcript].join('\u0000')) : null

  const rid = `sim-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
  res.setHeader('X-Request-Id', rid)
  inflight.set(rid, { model: requestedModel, tools: `${clientTools.length}+${proxyTools.length}`, startedAt: Date.now() })
  res.once('close', () => inflight.delete(rid))
  // Where the input tokens actually go: system prompt, our tool block, history.
  const inChars = {
    system: system.length,
    tools: toolBlock.length + (emulation ? Math.max(0, systemPrompt.length - system.length) : 0),
    context: transcript.length,
  }

  // Node's fetch and other non-streaming clients give up when headers take
  // minutes. After earlyHeadersMs we answer 200 and flush the body when ready.
  const early = { sent: false, timer: null }
  const earlyMs = Number(cfg.earlyHeadersMs || 0)
  if (!body.stream && earlyMs > 0) {
    early.timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return
      early.sent = true
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders?.()
    }, earlyMs)
    early.timer.unref?.()
  }

  // Open the stream before the long await so the client never sees an idle socket.
  let pingTimer = null
  if (body.stream) {
    startSse(res)
    res.write(': open\n\n')
    pingTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, 10000)
  }
  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    if (early.timer) clearTimeout(early.timer)
    early.timer = null
  }
  const respond = (payload) => {
    if (early.sent) {
      if (!res.writableEnded) res.end(JSON.stringify(payload))
      return
    }
    return json(res, 200, payload)
  }
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  let model = requestedModel
  let content = ''
  let tokens = null
  let cost = null
  let calls = null
  let hops = 0
  let usedCache = false
  let usedFallback = null
  let truncated = false
  const partsMs = []

  const id = newId()
  const created = Math.floor(Date.now() / 1000)
  const streamed = { chars: 0, active: false, decided: false }

  // Sim returns a part whole, so without pacing the client gets one wall of
  // text per call. Sending it in small slices makes it read like typing.
  const paceChars = Math.max(4, Number((cfg.streamPacing && cfg.streamPacing.chunkChars) || 12))
  const paceDelay = Math.max(0, Number((cfg.streamPacing && cfg.streamPacing.delayMs) || 20))
  const pacing = cfg.streamPacing ? cfg.streamPacing.enabled === true : false

  const sendContent = async (text) => {
    // Pace against a deadline instead of sleeping after every slice: that keeps
    // the cadence even when a write takes longer than the slice interval.
    const step = pacing ? paceChars : 120
    const started = Date.now()
    let sent = 0
    for (let i = 0; i < text.length; i += step) {
      if (res.writableEnded || res.destroyed || controller.signal.aborted) return
      const piece = text.slice(i, i + step)
      sendSse(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })
      sent += piece.length
      if (pacing && paceDelay > 0) {
        const target = started + (sent / step) * paceDelay
        const wait = target - Date.now()
        if (wait > 0) await sleep(wait)
      }
    }
  }

  // Parts of a long answer are forwarded as they arrive, so a model that needs
  // three minutes does not look frozen. Tool calls are never streamed.
  const onPart = async (text) => {
    if (!body.stream || !text) return
    if (!streamed.decided) {
      streamed.decided = true
      const head = text.trimStart()
      const looksLikeCall =
        head.startsWith('{') ||
        head.startsWith('```') ||
        /^<(invoke|function_calls|antml)/.test(head) ||
        /"tool_calls"\s*:/.test(head.slice(0, 200))
      streamed.active = !looksLikeCall
      if (streamed.active) {
        sendSse(res, {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })
      }
    }
    if (!streamed.active) return
    await sendContent(text)
    streamed.chars += text.length
  }

  let cacheState = 'off'
  try {
    if (ckey) {
      cacheState = 'miss'
      const hit = cacheGet(ckey, requestedModel)
      if (hit) {
        stats.cacheHits++
        usedCache = true
        cacheState = 'hit'
        content = hit
      }
    }

    if (!usedCache) {
      let workingContext = [transcript, toolBlock].filter(Boolean).join('\n\n')

      for (let hop = 0; hop <= (cfg.maxProxyToolHops || 3); hop++) {
        hops = hop
        let result
        try {
          result = await simChatChunked({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal, onPart })
        } catch (err) {
          const status = err.status
          // A permanently unavailable model is not a reason to answer as another one.
          const retryable =
            err.code !== 'UNAVAILABLE' &&
            (status === 402 || status === 404 || status === 429 || status >= 500 || err.code === 'TIMEOUT')
          if (cfg.fallbackModel && cfg.fallbackModel !== model && retryable) {
            stats.fallbacks++
            usedFallback = cfg.fallbackModel
            log(`fallback ${model} -> ${cfg.fallbackModel} (${short(err.message, 120)})`)
            model = cfg.fallbackModel
            result = await simChat({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
          } else if (err.code === 'TIMEOUT' && hop === 0 && !cfg.fallbackModel) {
            // A timeout is often a one-off stall: try the same model once more before giving up.
            stats.timeouts = (stats.timeouts || 0) + 1
            log(`timeout ${model}, retrying once`)
            result = await simChat({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
          } else {
            throw err
          }
        }

        content = result.content
        tokens = result.tokens
        if (result.cost) cost = result.cost
        if (Array.isArray(result.partsMs)) partsMs.push(...result.partsMs)
        if (result.truncated) truncated = true
        bump(model, Date.now() - startedAll, (tokens && tokens.input) || 0, (tokens && tokens.output) || 0)

        calls = null
        if (emulation) {
          calls = extractJsonCalls(content, tools) || extractXmlCalls(content, tools)
          if (calls) {
            calls = repairCalls(calls, tools)
            if (/<invoke|<function_calls/i.test(content)) content = stripXml(content)
          }
        }

        // Nudge: model produced something that looks like a broken call. The
        // retry goes through the chunked path too: a plain simChat here would
        // hit Sim's per-call limit with no way to shrink the answer.
        if (emulation && !calls && cfg.nudge.enabled && looksLikeFailedCall(content)) {
          let fixed = false
          for (let attempt = 0; attempt < (cfg.nudge.maxRetries || 1) && !fixed; attempt++) {
            stats.nudges++
            workingContext +=
              `\n\n[assistant]\n${content}\n\n[user]\nThat reply was not a valid tool call. ` +
              'Reply with ONLY the JSON object {"tool_calls":[{"name":...,"arguments":{...}}]} and nothing else.'
            let retry
            try {
              retry = await simChatChunked({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
            } catch (err) {
              stats.nudgeFailures = (stats.nudgeFailures || 0) + 1
              log(`nudge retry for ${model} failed: ${short(err.message, 160)}`)
              break
            }
            bump(model, Date.now() - startedAll, (retry.tokens && retry.tokens.input) || 0, (retry.tokens && retry.tokens.output) || 0)
            content = retry.content
            tokens = retry.tokens
            calls = extractJsonCalls(content, tools) || extractXmlCalls(content, tools)
            if (calls) {
              calls = repairCalls(calls, tools)
              fixed = true
            }
          }
          if (!fixed && !calls) content = 'Не удалось получить корректный вызов инструмента. Попробуй переформулировать задачу.'
        }

        if (!calls) break

        // Dedup: identical call already present in history.
        const done = alreadyExecutedCalls(workingContext)
        const fresh = calls.filter((c) => !done.has(canonCall(c)))
        if (!fresh.length) {
          workingContext +=
            `\n\n[assistant]\n${JSON.stringify({ tool_calls: calls })}\n\n[user]\nThose exact calls already ran and their results are above. Do not repeat them; continue with the answer.`
          stats.nudges++
          let retry = null
          try {
            retry = await simChatChunked({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
          } catch (err) {
            stats.nudgeFailures = (stats.nudgeFailures || 0) + 1
            log(`dedup retry for ${model} failed: ${short(err.message, 160)}`)
          }
          calls = null
          if (retry) {
            bump(model, Date.now() - startedAll, (retry.tokens && retry.tokens.input) || 0, (retry.tokens && retry.tokens.output) || 0)
            content = retry.content
            tokens = retry.tokens
          } else {
            // Never hand the client the same tool calls again: it would run them twice.
            content = 'Не удалось продолжить после повторного вызова инструмента. Попробуй ещё раз.'
          }
          break
        }
        calls = fresh

        const proxyCalls = calls.filter((c) => proxyNames.has(c.name))
        if (!proxyCalls.length) break

        const results = []
        for (const call of proxyCalls) {
          const impl = PROXY_TOOLS[call.name]
          let args = {}
          try {
            args = JSON.parse(call.arguments || '{}')
          } catch {}
          let out
          try {
            out = await impl.run(args)
            stats.proxyToolRuns++
          } catch (err) {
            out = `ERROR: ${err.message}`
          }
          results.push(`[tool result ${call.name} #proxy${Date.now().toString(36)}]\n${out}`)
          log(`proxy tool ${call.name}(${short(JSON.stringify(args), 120)}) -> ${short(String(out), 120)}`)
        }

        if (proxyCalls.length === calls.length) {
          workingContext += `\n\n[assistant]\n${JSON.stringify({ tool_calls: calls })}\n\n${results.join('\n\n')}`
          continue
        }
        // Mixed call set: keep client calls, drop proxy ones.
        calls = calls.filter((c) => !proxyNames.has(c.name))
        break
      }
    }
  } catch (err) {
    cleanup()
    stats.errors++
    if (err && err.code === 'TIMEOUT') stats.timeouts = (stats.timeouts || 0) + 1
    recordRequest({
      model,
      ms: Date.now() - startedAll,
      outcome: err && err.code === 'TIMEOUT' ? 'timeout' : 'error',
      rateLimited: Boolean(err && err.status === 429),
      cache: cacheState,
      outTokens: (tokens && tokens.output) || 0,
      outChars: (content && content.length) || 0,
    })
    let msg = String((err && err.message) || err)
    if (err && err.code === 'TIMEOUT') {
      msg =
        `Sim stopped the call to ${model} after ~${SIM_TIMEOUT_SEC || 120} s (its per-call limit). ` +
        'The model was still generating a long answer. Ask for a smaller chunk, or switch to a faster model.'
    }
    if (err && err.code === 'UNAVAILABLE') {
      msg = `${model} is not available on Sim right now (${msg.replace(/^Sim model error:\s*/, '')}). Pick another model.`
    }
    stats.errorsByCode = stats.errorsByCode || {}
    log(`chat ${model} FAILED in ${Date.now() - startedAll}ms: ${short(msg, 240)}`)
    rememberError(msg)
    const status =
      err && err.code === 'TIMEOUT'
        ? 504
        : err && err.code === 'UNAVAILABLE'
          ? 404
          : /no longer available|not found|unknown model/i.test(msg)
            ? 404
            : /api key is required|unauthorized/i.test(msg)
              ? 401
              : /402|credit/i.test(msg)
                ? 402
                : 502
    if (body.stream && res.headersSent) {
      sendSse(res, { error: { message: msg, type: 'upstream_error' } })
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    traceRequest({
      id: rid, at: new Date().toISOString(), model, inChars, tools: tools.length,
      chunks: partsMs.length, partsMs, totalMs: Date.now() - startedAll,
      outcome: 'error', error: short(msg, 200), stream: Boolean(body.stream),
    })
    if (early.sent) {
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: msg, type: 'upstream_error', code: status } }))
      return
    }
    if (status === 429) {
      const wait = err && err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : 30
      res.setHeader('Retry-After', String(wait))
      res.setHeader('X-RateLimit-Limit', '60')
    }
    return openaiError(res, status, msg, 'upstream_error')
  }

  cleanup()

  const usage = {
    prompt_tokens: (tokens && tokens.input) || 0,
    completion_tokens: (tokens && tokens.output) || 0,
    total_tokens: (tokens && tokens.total) || 0,
  }
  const clientCalls = calls ? calls : null

  stats.chatRequests++
  if (clientCalls) stats.emulatedToolCalls += clientCalls.length
  const ms = Date.now() - startedAll
  log(
    `chat ${model} ok in ${ms}ms${usedCache ? ' (cache)' : ''} · tools=${clientTools.length}+${proxyTools.length}` +
      ` · stream=${body.stream ? `on/${streamed.chars}` : 'off'}` +
      (clientCalls ? ` · EMULATED ${clientCalls.length}: ${clientCalls.map((c) => c.name).join(',')}` : '') +
      (hops ? ` · hops=${hops}` : '') +
      ` · ${usage.total_tokens} tok`,
  )

  if (ckey && !usedCache && content) cacheSet(ckey, content, requestedModel)

  recordRequest({
    model,
    ms,
    outcome: truncated ? 'truncated' : 'ok',
    rateLimited: false,
    cache: cacheState,
    outTokens: usage.completion_tokens,
    outChars: (content && content.length) || 0,
  })

  traceRequest({
    id: rid, at: new Date().toISOString(), model, inChars, tools: tools.length,
    chunks: partsMs.length, partsMs, totalMs: ms,
    outcome: truncated ? 'truncated' : 'ok',
    fallback: usedFallback || undefined,
    toolCalls: clientCalls ? clientCalls.length : 0,
    stream: Boolean(body.stream),
    streamedChars: streamed.chars,
    cache: usedCache || undefined,
  })

  if (clientCalls) {
    const toolCalls = clientCalls.map((c) => ({ id: newCallId(), type: 'function', function: { name: c.name, arguments: c.arguments } }))
    if (body.stream) {
      sendSse(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: c.function })) },
          finish_reason: null,
        }],
      })
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    return respond({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
      usage,
      cost,
    })
  }

  if (body.stream) {
    const text = content || ''
    if (!streamed.chars) {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      await sendContent(text)
    } else {
      // Everything up to streamed.chars already went out part by part.
      await sendContent(text.slice(streamed.chars))
    }
    sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  return respond({
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || '' }, finish_reason: 'stop' }],
    usage,
    cost,
  })
}

// ------------------------------------------------------------------- server
let creditsCache = { at: 0, data: null }

async function fetchCredits(force = false) {
  if (!force && creditsCache.data && Date.now() - creditsCache.at < 300000) return creditsCache.data
  try {
    const res = await fetch(`${SIM_API}/billing/status`, {
      headers: { 'X-API-Key': cfg.simApiKey },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return creditsCache.data
    const body = await res.json()
    const d = (body && body.data) || {}
    creditsCache = { at: Date.now(), data: { plan: d.plan, credits: d.credits, limits: d.limits } }
    return creditsCache.data
  } catch {
    return creditsCache.data
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname.replace(/\/+$/, '') || '/'

  // Optional local token: keeps other apps on the machine from using the proxy.
  if (cfg.localToken) {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const key = String(req.headers['x-api-key'] || '')
    if (auth !== cfg.localToken && key !== cfg.localToken) {
      return openaiError(res, 401, 'invalid local token — reinstall the provider or check config.json', 'authentication_error')
    }
  }

  if (req.method === 'GET' && (p === '/' || p === '/health')) {
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      models: models.hosted.length,
      toolEmulation: cfg.toolEmulation !== false,
      proxyTools: Object.keys(cfg.proxyTools || {}).filter((k) => cfg.proxyTools[k]),
      cache: cfg.cache.enabled,
      maxConcurrent: cfg.maxConcurrent,
      simTimeoutSec: SIM_TIMEOUT_SEC,
    })
  }

  if (req.method === 'GET' && p === '/trace') {
    const limit = Math.min(20, Number(url.searchParams.get('limit')) || 20)
    return json(res, 200, { traces: traces.slice(0, limit) })
  }

  if (req.method === 'GET' && p === '/stats') {
    const windowSec = Math.min(24 * 3600, Math.max(60, Number(url.searchParams.get('window')) || 3600))
    return json(res, 200, {
      ...stats,
      chunkSizes: Object.fromEntries(chunkSizes),
      credits: creditsCache.data || null,
      rateLimit: limiter.state(),
      cacheInfo: cacheInfo(),
      window: windowMetrics(windowSec * 1000),
      inflight: [...inflight.entries()].map(([id, v]) => ({
        id,
        model: v.model,
        tools: v.tools,
        elapsedMs: Date.now() - v.startedAt,
      })),
    })
  }

  if (req.method === 'GET' && p === '/metrics') {
    const windowSec = Math.min(24 * 3600, Math.max(60, Number(url.searchParams.get('window')) || 3600))
    return json(res, 200, windowMetrics(windowSec * 1000))
  }

  if (req.method === 'GET' && p === '/credits') {
    return json(res, 200, (await fetchCredits(url.searchParams.has('force'))) || { error: 'unavailable' })
  }

  if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
    const list = url.searchParams.get('all') ? models.all : models.hosted
    return json(res, 200, {
      object: 'list',
      data: list.map((id) => ({ id, object: 'model', created: 0, owned_by: 'sim' })),
    })
  }

  if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
    try {
      await handleChat(req, res)
    } catch (err) {
      log('unhandled:', err && err.stack ? err.stack : err)
      if (!res.headersSent) openaiError(res, 500, String((err && err.message) || err))
      else res.end()
    }
    return
  }

  return openaiError(res, 404, `no route for ${req.method} ${p}`, 'invalid_request_error')
})

readModelsCache()
loadChunkSizes()
loadCache()
await refreshModels()

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[fatal] port ${cfg.port} is already in use — the proxy may already be running.`)
    process.exit(2)
  }
  console.error('[fatal]', err.message)
  process.exit(1)
})

server.listen(cfg.port, '127.0.0.1', () => {
  log(`sim proxy v2 on http://127.0.0.1:${cfg.port}/v1 · models=${models.hosted.length} · emulation=${cfg.toolEmulation} · cache=${cfg.cache.enabled} · call timeout=${SIM_TIMEOUT_SEC || 'default'}s`)
})

setInterval(refreshModels, 12 * 3600 * 1000).unref?.()
