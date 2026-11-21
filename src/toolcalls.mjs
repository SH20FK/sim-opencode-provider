// Tool-call spellings that hosted models produce without native support, and
// the cleanup that keeps those spellings out of the visible answer.

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

// Remove the tool-call spellings a model leaves in its prose once the calls
// have been extracted: otherwise the caller shows raw JSON, XML and `_call:`
// lines next to the answer.
export function stripToolArtifacts(text) {
  let s = text
  if (/tool_calls|toolCalls|"arguments"/.test(s)) {
    for (const candidate of jsonCandidates(s)) {
      try {
        if (normalizeCalls(JSON.parse(candidate), null)) s = s.split(candidate).join('')
      } catch {}
    }
  }
  s = s.replace(/```[a-zA-Z]*\s*```/g, '')
  s = s.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
  s = s.replace(/<invoke(?:_tool)?\b[^>]*>[\s\S]*?<\/invoke(?:_tool)?>/gi, '')
  s = s.replace(/<\/?invoke(?:_tool)?\b[^>]*>/gi, '')
  s = s.replace(/<\/?antml:[^>]*>/gi, '')
  s = s.replace(/^[ \t]*_call\s*:.*$/gim, '')
  s = s.replace(/^[ \t]*\+\d+[ \t]+(?:command|tool)s?[ \t]*$/gim, '')
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// The two extractors used by the proxy. Kept here so they can be tested
// without starting a server.
export function extractJsonCalls(text, tools) {
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
