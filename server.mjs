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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, 'config.json')
const MODELS_CACHE = path.join(__dirname, 'models.cache.json')

const DEFAULTS = {
  simApiKey: '',
  workspaceId: '',
  port: 8787,
  toolEmulation: true,
  toolTemperature: 0,
  maxConcurrent: 2,
  requestTimeoutMs: 290000,
  fallbackModel: '',
  cache: { enabled: true, ttlMs: 600000, maxEntries: 200 },
  proxyTools: { now: true, web_fetch: true, web_search: true },
  nudge: { enabled: true, maxRetries: 2 },
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
    proxyTools: { ...DEFAULTS.proxyTools, ...(raw.proxyTools || {}) },
    nudge: { ...DEFAULTS.nudge, ...(raw.nudge || {}) },
  }
}

const cfg = loadConfig()
const SIM_API = 'https://www.sim.ai/api/v2'

const FALLBACK_MODELS = [
  'claude-sonnet-5-5', 'claude-opus-5', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5',
  'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.5',
  'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro',
  'grok-4.7', 'kimi-k2.7-code', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro',
]

const log = (...args) => console.log(new Date().toISOString(), ...args)
const short = (s, n = 300) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}...(${s.length})` : s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------- stats
const stats = {
  startedAt: new Date().toISOString(),
  chatRequests: 0,
  emulatedToolCalls: 0,
  proxyToolRuns: 0,
  nudges: 0,
  cacheHits: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  latencyMs: 0,
  byModel: {},
}

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
const gate = new Semaphore(Math.max(1, cfg.maxConcurrent || 2))

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
    const hosted = field.options.filter((o) => o.hosted).map((o) => o.id)
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
  web_search: {
    spec: {
      name: 'web_search',
      description: 'Search the web (DuckDuckGo) and return the top results as title, url and snippet.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results, default 5' },
        },
        required: ['query'],
      },
    },
    run: async ({ query, limit }) => {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query))}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(20000),
      })
      const html = await res.text()
      const n = Math.min(Math.max(Number(limit) || 5, 1), 10)
      const out = []
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>)?/g
      let m
      while ((m = re.exec(html)) !== null && out.length < n) {
        let href = m[1]
        const uddg = /[?&]uddg=([^&]+)/.exec(href)
        if (uddg) href = decodeURIComponent(uddg[1])
        out.push({ title: htmlToText(m[2]).slice(0, 200), url: href, snippet: htmlToText(m[3] || '').slice(0, 300) })
      }
      if (!out.length) return 'No results (search engine returned an empty page).'
      return out.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')
    },
  },
}

function activeProxyTools() {
  return Object.entries(PROXY_TOOLS)
    .filter(([name]) => cfg.proxyTools && cfg.proxyTools[name])
    .map(([name, t]) => ({ type: 'function', function: t.spec }))
}

// ---------------------------------------------------------------- sim client
async function simChat({ model, systemPrompt, context, temperature, maxTokens, signal }) {
  const input = { model, context }
  if (systemPrompt) input.systemPrompt = systemPrompt
  if (typeof temperature === 'number') input.temperature = temperature
  if (typeof maxTokens === 'number' && maxTokens > 0) input.maxTokens = maxTokens

  const body = JSON.stringify({ workspaceId: cfg.workspaceId, input })
  let lastErr

  for (let attempt = 0; attempt < 3; attempt++) {
    await gate.acquire()
    try {
      const timeout = AbortSignal.timeout(cfg.requestTimeoutMs || 290000)
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
      if (!res.ok) {
        const msg = (data.error && (data.error.message || data.error.code)) || `HTTP ${res.status}`
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          lastErr = new Error(`Sim ${res.status}: ${msg}`)
          await sleep(700 * (attempt + 1))
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
        throw new Error(`Sim model error: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
      }
      const out = payload.output || {}
      return {
        content: typeof out.content === 'string' ? out.content : '',
        tokens: out.tokens || null,
        cost: out.cost || null,
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err
      lastErr = err
      if (/fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(String(err.message)) && attempt < 2) {
        await sleep(700 * (attempt + 1))
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

// Fill/coerce arguments against the tool schema so providers stop rejecting calls.
function repairCalls(calls, tools) {
  const byName = new Map(tools.map((t) => [(t.function || t).name, t.function || t]))
  const out = []
  for (const call of calls) {
    const fn = byName.get(call.name)
    let args
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      args = {}
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
    const schema = (fn && fn.parameters) || {}
    const props = schema.properties || {}
    for (const key of Object.keys(args)) if (Object.keys(props).length && !props[key]) delete args[key]
    for (const [key, def] of Object.entries(props)) {
      const want = def && def.type
      let value = args[key]
      if (value === undefined || value === null || value === '') {
        if ((schema.required || []).includes(key)) {
          args[key] = want === 'number' ? 0 : want === 'boolean' ? false : want === 'array' ? [] : want === 'object' ? {} : ''
        }
        continue
      }
      if (want === 'string' && typeof value !== 'string') args[key] = String(value)
      else if (want === 'number' && typeof value !== 'number') {
        const n = Number(value)
        if (!Number.isNaN(n)) args[key] = n
      } else if (want === 'boolean' && typeof value !== 'boolean') args[key] = value === true || value === 'true'
      else if (want === 'array' && !Array.isArray(value)) args[key] = [value]
    }
    out.push({ name: call.name, arguments: JSON.stringify(args) })
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

function buildTranscript(messages) {
  const systems = []
  const turns = []
  const nameById = new Map()

  for (const msg of messages || []) {
    const role = msg.role
    if (role === 'system' || role === 'developer') {
      systems.push(contentToText(msg.content))
      continue
    }
    if (role === 'tool') {
      const id = msg.tool_call_id || ''
      const name = nameById.get(id) || msg.name || 'tool'
      turns.push(`[tool result ${name}${id ? ` #${id}` : ''}]\n${contentToText(msg.content)}`)
      continue
    }
    if (role === 'assistant') {
      const text = contentToText(msg.content)
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        for (const c of msg.tool_calls) if (c.id) nameById.set(c.id, (c.function || {}).name)
        const rendered = msg.tool_calls
          .map((c) => `[tool call ${(c.function || {}).name} #${c.id || ''}]\n${(c.function || {}).arguments || '{}'}`)
          .join('\n')
        turns.push(`[assistant]\n${text ? `${text}\n` : ''}${rendered}`)
      } else if (text) turns.push(`[assistant]\n${text}`)
      continue
    }
    turns.push(`[${role || 'user'}]\n${contentToText(msg.content)}`)
  }

  return { system: systems.filter(Boolean).join('\n\n'), context: turns.join('\n\n') }
}

// ------------------------------------------------------------------ cache
const cache = new Map()

function cacheKey(parts) {
  return crypto.createHash('sha1').update(parts).digest('hex')
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > cfg.cache.ttlMs) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  if (cache.size >= cfg.cache.maxEntries) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), value })
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
  const systemPrompt = [system, emulation ? 'Tool calling protocol is defined at the very end of the transcript. Follow it exactly.' : '']
    .filter(Boolean)
    .join('\n\n')

  const temperature =
    typeof body.temperature === 'number' ? body.temperature : emulation ? cfg.toolTemperature : undefined
  const maxTokens = body.max_tokens || body.maxTokens

  const cacheable = cfg.cache.enabled && !emulation && (temperature === undefined || temperature === 0)
  const ckey = cacheable ? cacheKey([requestedModel, systemPrompt, transcript].join('\u0000')) : null

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
  }
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  let model = requestedModel
  let content = ''
  let tokens = null
  let calls = null
  let hops = 0
  let usedCache = false

  try {
    if (ckey) {
      const hit = cacheGet(ckey)
      if (hit) {
        stats.cacheHits++
        usedCache = true
        content = hit
      }
    }

    if (!usedCache) {
      let workingContext = [transcript, toolBlock].filter(Boolean).join('\n\n')

      for (let hop = 0; hop <= (cfg.maxProxyToolHops || 3); hop++) {
        hops = hop
        let result
        try {
          result = await simChat({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
        } catch (err) {
          const status = err.status
          if (cfg.fallbackModel && cfg.fallbackModel !== model && (status === 402 || status === 404 || status === 429 || status >= 500)) {
            log(`fallback ${model} -> ${cfg.fallbackModel} (${short(err.message, 120)})`)
            model = cfg.fallbackModel
            result = await simChat({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
          } else {
            throw err
          }
        }

        content = result.content
        tokens = result.tokens
        bump(model, Date.now() - startedAll, (tokens && tokens.input) || 0, (tokens && tokens.output) || 0)

        calls = null
        if (emulation) {
          calls = extractJsonCalls(content, tools) || extractXmlCalls(content, tools)
          if (calls) {
            calls = repairCalls(calls, tools)
            if (/<invoke|<function_calls/i.test(content)) content = stripXml(content)
          }
        }

        // Nudge: model produced something that looks like a broken call.
        if (emulation && !calls && cfg.nudge.enabled && looksLikeFailedCall(content)) {
          let fixed = false
          for (let attempt = 0; attempt < (cfg.nudge.maxRetries || 1) && !fixed; attempt++) {
            stats.nudges++
            workingContext +=
              `\n\n[assistant]\n${content}\n\n[user]\nThat reply was not a valid tool call. ` +
              'Reply with ONLY the JSON object {"tool_calls":[{"name":...,"arguments":{...}}]} and nothing else.'
            const retry = await simChat({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
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
          const retry = await simChat({ model, systemPrompt, context: workingContext, temperature, maxTokens, signal: controller.signal })
          content = retry.content
          tokens = retry.tokens
          calls = null
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
    const msg = String((err && err.message) || err)
    stats.errorsByCode = stats.errorsByCode || {}
    log(`chat ${model} FAILED in ${Date.now() - startedAll}ms: ${short(msg, 240)}`)
    const status = /no longer available|not found|unknown model/i.test(msg)
      ? 404
      : /api key is required|unauthorized/i.test(msg)
        ? 401
        : /402|credit|limit/i.test(msg)
          ? 402
          : 502
    if (res.headersSent) {
      sendSse(res, { error: { message: msg, type: 'upstream_error' } })
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    return openaiError(res, status, msg, 'upstream_error')
  }

  cleanup()

  const usage = {
    prompt_tokens: (tokens && tokens.input) || 0,
    completion_tokens: (tokens && tokens.output) || 0,
    total_tokens: (tokens && tokens.total) || 0,
  }
  const id = newId()
  const created = Math.floor(Date.now() / 1000)
  const clientCalls = calls ? calls : null

  stats.chatRequests++
  if (clientCalls) stats.emulatedToolCalls += clientCalls.length
  const ms = Date.now() - startedAll
  log(
    `chat ${model} ok in ${ms}ms${usedCache ? ' (cache)' : ''} · tools=${clientTools.length}+${proxyTools.length}` +
      (clientCalls ? ` · EMULATED ${clientCalls.length}: ${clientCalls.map((c) => c.name).join(',')}` : '') +
      (hops ? ` · hops=${hops}` : '') +
      ` · ${usage.total_tokens} tok`,
  )

  if (ckey && !usedCache && content) cacheSet(ckey, content)

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
    return json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
      usage,
    })
  }

  if (body.stream) {
    sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    const text = content || ''
    for (let i = 0; i < text.length; i += 48) {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text.slice(i, i + 48) }, finish_reason: null }] })
    }
    sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  return json(res, 200, {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || '' }, finish_reason: 'stop' }],
    usage,
  })
}

// ------------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'GET' && (p === '/' || p === '/health')) {
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      models: models.hosted.length,
      toolEmulation: cfg.toolEmulation !== false,
      proxyTools: Object.keys(cfg.proxyTools || {}).filter((k) => cfg.proxyTools[k]),
      cache: cfg.cache.enabled,
      maxConcurrent: cfg.maxConcurrent,
    })
  }

  if (req.method === 'GET' && p === '/stats') return json(res, 200, stats)

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
  log(`sim proxy v2 on http://127.0.0.1:${cfg.port}/v1 · models=${models.hosted.length} · emulation=${cfg.toolEmulation} · cache=${cfg.cache.enabled}`)
})

setInterval(refreshModels, 12 * 3600 * 1000).unref?.()
