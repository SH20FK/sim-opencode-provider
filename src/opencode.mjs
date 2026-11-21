// OpenCode integration: install / inspect / remove the `sim` provider block
// in opencode.json. Every write is preceded by a timestamped backup.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROVIDER_ID = 'sim'

// Curated subset of Sim's hosted models. `baseURL` comes from the proxy config.
export const MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5 (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (Sim)', context: 200000, output: 64000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Sim)', context: 200000, output: 32000 },
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex (Sim)', context: 400000, output: 128000 },
  { id: 'gpt-5.4', name: 'GPT 5.4 (Sim)', context: 1050000, output: 128000 },
  { id: 'gpt-5.4-mini', name: 'GPT 5.4 mini (Sim)', context: 400000, output: 128000 },
  { id: 'gpt-5.5', name: 'GPT 5.5 (Sim)', context: 1050000, output: 128000 },
  { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (Sim)', context: 1050000, output: 128000 },
  { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol (Sim)', context: 1050000, output: 128000 },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon (Sim)', context: 1048576, output: 65536 },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Sim)', context: 1048576, output: 65536 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Sim)', context: 1048576, output: 65536 },
  { id: 'grok-4.7', name: 'Grok 4.7 (Sim)', context: 500000, output: 32768 },
  { id: 'grok-4.6', name: 'Grok 4.6 (Sim)', context: 500000, output: 32768 },
  { id: 'kimi-k3', name: 'Kimi K3 (Sim)', context: 1048576, output: 131072 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (Sim)', context: 262144, output: 32768 },
  { id: 'glm-5.3', name: 'GLM 5.3 (Sim)', context: 1000000, output: 131072 },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash (Sim)', context: 1000000, output: 131072 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2 (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 (Sim)', context: 1000000, output: 128000 },
  { id: 'claude-fable-5', name: 'Claude Fable 5 (Sim)', context: 1000000, output: 128000 },
  { id: 'gpt-6-astra', name: 'GPT 6 Astra (Sim)', context: 1050000, output: 128000 },
  { id: 'gpt-6.1-terra', name: 'GPT 6.1 Terra (Sim)', context: 1050000, output: 128000 },
  { id: 'gpt-6-luna', name: 'GPT 6 Luna (Sim)', context: 1050000, output: 128000 },
  { id: 'o3-pro', name: 'o3-pro (Sim, дорогая)', context: 200000, output: 100000 },
]

export function configPath() {
  if (process.env.OPENCODE_CONFIG) return path.resolve(process.env.OPENCODE_CONFIG)
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
}

export function readConfig(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = `${file}.bak-${PROVIDER_ID}-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

export function buildProvider(baseURL, ids) {
  const known = new Map(MODELS.map((m) => [m.id, m]))
  const list = ids && ids.length ? ids : MODELS.map((m) => m.id)
  const models = {}
  for (const id of list) {
    const meta = known.get(id) || { name: `${id} (Sim)`, context: 200000, output: 32000 }
    models[id] = {
      name: meta.name,
      limit: { context: meta.context, output: meta.output },
      cost: { input: 0, output: 0 },
    }
  }
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Sim (free)',
    options: { baseURL, apiKey: 'sim-local' },
    models,
  }
}

// All hosted models (no BYOK needed) straight from Sim's catalogue.
export async function fetchHosted({ simApiKey, workspaceId }) {
  try {
    const res = await fetch(
      `https://www.sim.ai/api/v2/blocks/agent?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { 'X-API-Key': simApiKey }, signal: AbortSignal.timeout(15000) },
    )
    if (!res.ok) return null
    const body = await res.json()
    const field = ((body.data && body.data.inputSchema) || []).find((f) => f && f.id === 'model' && Array.isArray(f.options))
    if (!field) return null
    const hosted = field.options.filter((o) => o.hosted).map((o) => o.id)
    return hosted.length ? hosted : null
  } catch {
    return null
  }
}

export function inspect(file = configPath()) {
  const result = { path: file, exists: fs.existsSync(file), installed: false, models: 0, baseURL: null }
  if (!result.exists) return result
  try {
    const cfg = readConfig(file)
    const p = cfg.provider && cfg.provider[PROVIDER_ID]
    if (p) {
      result.installed = true
      result.models = p.models ? Object.keys(p.models).length : 0
      result.baseURL = (p.options && p.options.baseURL) || null
    }
  } catch (err) {
    result.error = err.message
  }
  return result
}

export function install(baseURL, opts = {}, file = configPath()) {
  if (!fs.existsSync(file)) {
    throw new Error(`opencode.json не найден: ${file}\nЗапусти OpenCode хотя бы раз, чтобы он создал конфиг.`)
  }
  const cfg = readConfig(file)
  const saved = backup(file)
  cfg.provider = cfg.provider || {}
  cfg.provider[PROVIDER_ID] = buildProvider(baseURL, opts.hosted)
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return { path: file, backup: saved, models: Object.keys(cfg.provider[PROVIDER_ID].models).length }
}

export function remove(file = configPath()) {
  if (!fs.existsSync(file)) throw new Error(`opencode.json не найден: ${file}`)
  const cfg = readConfig(file)
  if (!cfg.provider || !cfg.provider[PROVIDER_ID]) return { removed: false, path: file }
  const saved = backup(file)
  delete cfg.provider[PROVIDER_ID]
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return { removed: true, path: file, backup: saved }
}

export async function checkProxy(baseURL) {
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { ok: body.ok === true, models: body.models || 0, body }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
