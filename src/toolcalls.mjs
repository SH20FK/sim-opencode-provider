// Tool-call spellings that hosted models produce without native support, and
// the cleanup that keeps those spellings out of the visible answer.

// Models often write raw newlines and tabs inside JSON strings, which is
// invalid JSON. Escape them (and drop trailing commas) before giving up.
function parseLoose(candidate) {
  try {
    return JSON.parse(candidate)
  } catch {}
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of candidate) {
    if (inStr) {
      if (esc) {
        out += ch
        esc = false
        continue
      }
      if (ch === '\\') {
        out += ch
        esc = true
        continue
      }
      if (ch === '"') {
        out += ch
        inStr = false
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  try {
    return JSON.parse(out)
  } catch {}
  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'))
  } catch {}
  return null
}

// Pull every balanced {...} object out of the text, fences first.
export function jsonCandidates(text) {
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

// Normalize the shapes models use into [{ name, arguments }] where arguments is
// a JSON string. `allowed`, when given, drops calls to unknown tools.
export function normalizeCalls(obj, allowed) {
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

// `<invoke_tool name="x">` blocks seen in the wild, and the two-line
// `_call: name` / `_call: {json}` form some models copy from other harnesses.
export function extractCallLines(text, tools) {
  if (!tools || !tools.length) return null
  const allowed = new Set(tools.map((t) => (t.function || t).name))
  const calls = []
  const re = /^[ \t]*_call\s*:\s*([A-Za-z0-9_.-]+)[ \t]*\r?\n[ \t]*_call\s*:\s*(\{.*\})[ \t]*$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    if (!allowed.has(m[1])) continue
    try {
      const args = JSON.parse(m[2])
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        calls.push({ name: m[1], arguments: JSON.stringify(args) })
      }
    } catch {}
  }
  return calls.length ? calls : null
}

// Some models write the tag with the name glued on: `invoke:websearch` on its
// own line, then <parameter name="…">…</parameter>, then </invoke>.
export function extractBareInvokes(text, tools) {
  if (!tools || !tools.length) return null
  const allowed = new Set(tools.map((t) => (t.function || t).name))
  const calls = []
  const marker = /^[ \t]*invoke(?:_tool)?[ \t]*[:_][ \t]*([A-Za-z0-9_.-]+)[ \t]*$/gim
  const marks = [...text.matchAll(marker)]
  const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/g
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1]
    if (!allowed.has(name)) continue
    const from = marks[i].index + marks[i][0].length
    const to = i + 1 < marks.length ? marks[i + 1].index : text.length
    let body = text.slice(from, to)
    const close = body.indexOf('</invoke>')
    if (close >= 0) body = body.slice(0, close)
    const args = {}
    let p
    paramRe.lastIndex = 0
    while ((p = paramRe.exec(body)) !== null) {
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

// Remove the tool-call spellings a model leaves in its prose once the calls
// have been extracted: otherwise the caller shows raw JSON, XML and `_call:`
// lines next to the answer.
export function stripToolArtifacts(text) {
  let s = text
  if (/tool_calls|toolCalls|"arguments"/.test(s)) {
    for (const candidate of jsonCandidates(s)) {
      const parsed = parseLoose(candidate)
      if (parsed !== null && normalizeCalls(parsed, null)) s = s.split(candidate).join('')
    }
  }
  s = s.replace(/```[a-zA-Z]*\s*```/g, '')
  s = s.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
  s = s.replace(/<invoke(?:_tool)?\b[^>]*>[\s\S]*?<\/invoke(?:_tool)?>/gi, '')
  s = s.replace(/<\/?invoke(?:_tool)?\b[^>]*>/gi, '')
  s = s.replace(/<\/?antml:[^>]*>/gi, '')
  // Only touch loose markers and <parameter> blocks when the text actually
  // contains an invoke form; plain XML in a normal answer must survive.
  if (/<invoke(?:_tool)?\b|^[ \t]*invoke(?:_tool)?[ \t]*[:_]/im.test(text)) {
    s = s.replace(/^[ \t]*invoke(?:_tool)?[ \t]*[:_][^\n]*$/gim, '')
    s = s.replace(/^[ \t]*<\/invoke>[ \t]*$/gim, '')
    s = s.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '')
  }
  s = s.replace(/^[ \t]*_call\s*:.*$/gim, '')
  s = s.replace(/^[ \t]*\+\d+[ \t]+(?:command|tool)s?[ \t]*$/gim, '')
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// The two extractors used by the proxy. Kept here so they can be tested
// without starting a server.
export function extractJsonCalls(text, tools) {
  if (!tools || !tools.length || text.length > 200000) return null
  const allowed = new Set(tools.map((t) => (t.function || t).name))
  for (const candidate of jsonCandidates(text)) {
    const parsed = parseLoose(candidate)
    if (parsed === null) continue
    const calls = normalizeCalls(parsed, allowed)
    if (calls) return calls
  }
  return null
}

export function extractXmlCalls(text, tools) {
  if (!tools || !tools.length) return null
  const allowed = new Set(tools.map((t) => (t.function || t).name))
  const calls = []
  // Models mix formats: <invoke>…</invoke> and <invoke_tool>…</invoke_tool>.
  const invokeRe = /<invoke(?:_tool)?\b([^>]*)>([\s\S]*?)<\/invoke(?:_tool)?>/g
  let match
  while ((match = invokeRe.exec(text)) !== null) {
    const attrs = match[1] || ''
    const inner = match[2] || ''
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
