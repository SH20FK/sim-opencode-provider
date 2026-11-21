// Checks for src/toolcalls.mjs. No proxy needed.
//   node tests/toolcalls.mjs

import { extractJsonCalls, extractXmlCalls, extractCallLines, extractBareInvokes, stripToolArtifacts } from '../src/toolcalls.mjs'

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
const tools = [
  { function: { name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
  { function: { name: 'webfetch', parameters: { type: 'object', properties: { url: { type: 'string' } } } } },
  { function: { name: 'websearch', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
]

// The exact mess from a haiku answer: prose, JSON call, XML call, _call pair.
const messy = `Ошибка 402 вызвана встроенным бэкендом.
{"tool_calls":[{"name":"shell","arguments":{"command":"Get-ChildItem"}}]}
+1 command
Сначала проверю переменные.
<invoke_tool name="shell">
<parameter name="command">$u = [Environment]::GetEnvironmentVariables('User')</parameter>
</invoke_tool>
_call: webfetch
_call: {"url":"https://opencode.ai/docs/websearch/","format":"markdown"}
конец.`

const json = extractJsonCalls(messy, tools)
check('json call extracted', json && json[0].name === 'shell' && JSON.parse(json[0].arguments).command === 'Get-ChildItem', JSON.stringify(json))

const xml = extractXmlCalls(messy, tools)
check(
  'invoke_tool parsed',
  xml && xml[0].name === 'shell' && String(JSON.parse(xml[0].arguments).command).includes("GetEnvironmentVariables('User')"),
  JSON.stringify(xml),
)

const line = extractCallLines(messy, tools)
check('_call pair parsed', line && line[0].name === 'webfetch' && JSON.parse(line[0].arguments).url.includes('docs'), JSON.stringify(line))

const stripped = stripToolArtifacts(messy)
for (const junk of ['tool_calls', '<invoke_tool', '_call:', '+1 command', '```']) {
  check(`no ${junk} in output`, !stripped.includes(junk), JSON.stringify(stripped.slice(0, 160)))
}
check('prose kept', stripped.includes('Ошибка 402') && stripped.includes('Сначала проверю') && stripped.includes('конец.'))

// A normal answer must survive untouched.
const clean = 'Вот план:\n\n1. Проверить ключ\n2. Перезапустить прокси\n\nГотово.'
check('clean answer untouched', stripToolArtifacts(clean) === clean, JSON.stringify(stripToolArtifacts(clean)))

// Loose <parameter> tags without any invoke marker are content, not a call.
const xmlAnswer = 'Пример разметки:\n<parameter name="x">value</parameter>\nконец.'
check('plain xml survives', stripToolArtifacts(xmlAnswer) === xmlAnswer, JSON.stringify(stripToolArtifacts(xmlAnswer)))

// JSON fenced call leaves no empty fence behind.
const fenced = 'Иду дальше.\n```json\n{"tool_calls":[{"name":"shell","arguments":{"command":"dir"}}]}\n```\n'
const fencedOut = stripToolArtifacts(fenced)
check('fenced call removed', !fencedOut.includes('tool_calls') && !fencedOut.includes('```'), JSON.stringify(fencedOut))

// The bare form: `invoke:websearch` with the name glued on, no opening tag.
const bare = `Ищу ещё раз.
invoke:websearch
<parameter name="query">Material 3 Expressive Flutter components support 2026</parameter>
</invoke>
invoke:websearch
<parameter name="query">m3.material.io button groups</parameter>
</invoke>`

const bareCalls = extractBareInvokes(bare, tools)
check(
  'bare invoke parsed',
  bareCalls && bareCalls.length === 2 && bareCalls.every((c) => c.name === 'websearch') && JSON.parse(bareCalls[0].arguments).query.includes('Material 3'),
  JSON.stringify(bareCalls),
)
const bareOut = stripToolArtifacts(bare)
check(
  'bare invoke stripped',
  !/invoke:|<parameter|<\/invoke>/i.test(bareOut) && bareOut.includes('Ищу ещё раз'),
  JSON.stringify(bareOut),
)

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
