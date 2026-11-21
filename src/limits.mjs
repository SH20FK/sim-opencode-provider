// Context and output limits for Sim's hosted models.
//
// Sim's catalogue only carries ids (`id`, `label`, `hosted`), while OpenCode
// needs `limit.context` / `limit.output` to decide when to compact history and
// how long an answer may be. The numbers come from models.dev, which knows 83
// of the 85 hosted models; the result is cached in models.limits.json so an
// install works offline.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
export const LIMITS_FILE = path.join(ROOT, 'models.limits.json')

const FALLBACK = { context: 200000, output: 32000 }

let bundled = null

export function loadLimits() {
  if (bundled) return bundled
  try {
    const raw = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    bundled = (raw && raw.models) || {}
  } catch {
    bundled = {}
  }
  return bundled
}

// models.dev wins over the hand-written list: it is refreshed upstream and
// covers the whole hosted catalogue, not just the curated subset.
export function limitsFor(id, curated) {
  const hit = loadLimits()[id]
  const context = Number(hit && hit.context) || Number(curated && curated.context) || FALLBACK.context
  const output = Number(hit && hit.output) || Number(curated && curated.output) || FALLBACK.output
  return { context, output }
}

export async function fetchModelsDev(timeoutMs = 20000) {
  const res = await fetch('https://models.dev/api.json', {
    headers: { 'User-Agent': 'sim-opencode-provider' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
  const json = await res.json()
  const byId = new Map()
  for (const provider of Object.values(json)) {
    const models = (provider && provider.models) || {}
    for (const [id, meta] of Object.entries(models)) {
      if (byId.has(id)) continue
      const limit = meta && meta.limit
      if (!limit || !Number(limit.context)) continue
      byId.set(id, { context: Number(limit.context), output: Number(limit.output) || 0 })
    }
  }
  return byId
}

export async function fetchSimCatalog({ simApiKey, workspaceId }, timeoutMs = 20000) {
  const url = `https://www.sim.ai/api/v2/blocks/agent?workspaceId=${encodeURIComponent(workspaceId)}`
  const res = await fetch(url, { headers: { 'X-API-Key': simApiKey }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`Sim catalogue HTTP ${res.status}`)
  const body = await res.json()
  const field = ((body.data && body.data.inputSchema) || []).find((f) => f && f.id === 'model' && Array.isArray(f.options))
  if (!field) throw new Error('model field not found in the catalogue')
  return field.options.map((o) => o.id)
}

// Refresh models.limits.json from models.dev for every id Sim knows about.
export async function refreshLimits(config, extraIds = []) {
  const [dev, simIds] = await Promise.all([fetchModelsDev(), fetchSimCatalog(config)])
  const ids = [...new Set([...simIds, ...extraIds])]
  const models = {}
  const missing = []
  for (const id of ids) {
    const hit = dev.get(id)
    if (!hit) {
      missing.push(id)
      continue
    }
    // Some vendors publish max output equal to the whole context window; that
    // is a placeholder, not a usable answer length.
    const output = hit.output >= hit.context ? 131072 : hit.output
    models[id] = { context: hit.context, output }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'https://models.dev/api.json',
    count: Object.keys(models).length,
    models,
  }
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(payload, null, 1) + '\n')
  bundled = models
  return { total: ids.length, found: Object.keys(models).length, missing }
}
