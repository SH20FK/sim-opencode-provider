// Smoke test against a running proxy.
//   node tests/smoke.mjs
// Env: PROXY_URL (default http://127.0.0.1:8787), MODEL (default claude-sonnet-5-5),
//      SIM_PROXY_TOKEN (default: localToken from config.json)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = (process.env.PROXY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const MODEL = process.env.MODEL || 'claude-sonnet-5-5'

function configToken() {
  if (process.env.SIM_PROXY_TOKEN) return process.env.SIM_PROXY_TOKEN
  try {
    const file = process.env.SIM_PROVIDER_CONFIG || path.join(ROOT, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return cfg.localToken || ''
  } catch {
    return ''
  }
}

const TOKEN = configToken()
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
const get = (p) => fetch(`${BASE}${p}`, { headers: auth }).then((r) => r.json())
const post = (body) =>
  fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

let failures = 0
const pass = (name, extra = '') => console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`)
const fail = (name, extra = '') => {
  failures++
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
}

console.log(`proxy: ${BASE} · model: ${MODEL}${TOKEN ? ' · token: yes' : ' · token: none'}\n`)

// 1. health
try {
  const h = await get('/health')
  h.ok ? pass('health', `${h.models} models`) : fail('health', JSON.stringify(h))
} catch (err) {
  fail('health', err.message)
  console.log('\nIs the proxy running? Start it with: node src/cli.mjs start')
  process.exit(1)
}

// 2. models
const models = await get('/v1/models')
Array.isArray(models.data) && models.data.length > 0 ? pass('models', String(models.data.length)) : fail('models')

// 3. plain chat
const plain = await post({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: pong' }] })
plain.status === 200 && plain.json.choices?.[0]?.message?.content ? pass('chat') : fail('chat', JSON.stringify(plain).slice(0, 200))

// 4. cache (identical request, no tools)
const first = await post({ model: MODEL, messages: [{ role: 'user', content: 'cache probe: say ok' }] })
const second = await post({ model: MODEL, messages: [{ role: 'user', content: 'cache probe: say ok' }] })
first.json.choices?.[0]?.message?.content === second.json.choices?.[0]?.message?.content
  ? pass('cache')
  : fail('cache', 'responses differ')

// 5. tool emulation
const tools = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a text file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
]
const tooled = await post({
  model: MODEL,
  tools,
  messages: [{ role: 'user', content: 'Read the file notes.txt with the read tool.' }],
})
const call = tooled.json.choices?.[0]?.message?.tool_calls?.[0]
call && call.function?.name === 'read' ? pass('tool emulation', call.function.arguments) : fail('tool emulation', JSON.stringify(tooled.json).slice(0, 240))

// 6. streaming
const sse = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'Say: stream ok' }] }),
}).then((r) => r.text())
sse.includes('[DONE]') && sse.includes('chat.completion.chunk') ? pass('stream') : fail('stream')

// 7. stats
const stats = await get('/stats')
typeof stats.chatRequests === 'number' ? pass('stats', `${stats.chatRequests} requests`) : fail('stats')

// 8. stale read collapse (same file, read twice, content differs)
const before = (await get('/stats')).staleResults || 0
const bodyA = 'version A\n'.repeat(120)
const bodyB = 'version B changed\n'.repeat(120)
const stale = await post({
  model: MODEL,
  tools,
  messages: [
    { role: 'user', content: 'test' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: bodyA },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: bodyB },
    { role: 'user', content: 'Reply with exactly: ok' },
  ],
})
const after = (await get('/stats')).staleResults || 0
stale.status === 200 && after > before
  ? pass('stale reads', `${after - before} collapsed`)
  : fail('stale reads', `${stale.status} / before ${before} after ${after}`)

// 9. trace endpoint
const trace = await get('/trace?limit=3')
Array.isArray(trace.traces) && trace.traces.length > 0 ? pass('trace', `${trace.traces.length} entries`) : fail('trace')

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
