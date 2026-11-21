// Smoke test against a running proxy.
//   node tests/smoke.mjs
// Env: PROXY_URL (default http://127.0.0.1:8787), MODEL (default claude-sonnet-5-5)

const BASE = (process.env.PROXY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const MODEL = process.env.MODEL || 'claude-sonnet-5-5'

let failures = 0
const pass = (name, extra = '') => console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`)
const fail = (name, extra = '') => {
  failures++
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
}

const post = (body) =>
  fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

console.log(`proxy: ${BASE} · model: ${MODEL}\n`)

// 1. health
try {
  const h = await fetch(`${BASE}/health`).then((r) => r.json())
  h.ok ? pass('health', `${h.models} models`) : fail('health', JSON.stringify(h))
} catch (err) {
  fail('health', err.message)
  console.log('\nIs the proxy running? Start it with: node server.mjs')
  process.exit(1)
}

// 2. models
const models = await fetch(`${BASE}/v1/models`).then((r) => r.json())
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
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'Say: stream ok' }] }),
}).then((r) => r.text())
sse.includes('[DONE]') && sse.includes('chat.completion.chunk') ? pass('stream') : fail('stream')

// 7. stats
const stats = await fetch(`${BASE}/stats`).then((r) => r.json())
typeof stats.chatRequests === 'number' ? pass('stats', `${stats.chatRequests} requests`) : fail('stats')

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
