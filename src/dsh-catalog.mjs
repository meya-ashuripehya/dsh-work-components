/**
 * DSH 宿主目录：服务商 / 模型 / 智能体预设，全部经宿主 Cordis 服务读取（不读配置文件、不碰密钥）。
 *   ctx.llm          @deepseek-ai/dsh-llm LlmRuntime
 *                      listProviders()               已注册（可调用）的服务商路由 { id, name }
 *                      listConfigurableProviders()   可配置但未必启用的服务商 { provider, displayName, settingsNs, error? }
 *                      listModels(provider)          该服务商的模型 { id, name, description? }
 *                      stream(GenerateOptions)       流式调用；密钥由服务商适配器从 DSH 凭据服务取得
 *   ctx.agentPresets @deepseek-ai/dsh-agent-preset-registry（0.2）/ dsh-agent-presets（0.1）
 *                      list()                        { id, name?, description?, order?, broken? }
 *                      readDocument(id)              { agentPreset, content: 预设子插件列表 YAML, name?, description? }
 *                      defaultId                     未指定时使用的预设
 * 服务按需 ctx.get()（宿主可能晚于本插件就绪，也可能未装某服务），缺失时如实返回 available: false。
 */
import yaml from 'js-yaml'

const PERSONA_ROW = /(^|\/)dsh-persona$/

function service(ctx, name) {
  try { const v = ctx?.get?.(name); if (v != null) return v } catch {}
  try { return ctx?.[name] ?? null } catch { return null }
}

/** @param ctx Cordis ctx；options.llm / options.presets 测试注入 */
export function createDshCatalog(ctx, options = {}) {
  const llm = () => (options.llm !== undefined ? options.llm : service(ctx, 'llm'))
  const presetsSvc = () => (options.presets !== undefined ? options.presets : service(ctx, 'agentPresets'))
  const personaCache = new Map() // id → { at, value }

  async function providers() {
    const l = llm()
    if (!l || typeof l.listProviders !== 'function') return { available: false, providers: [], dormant: [] }
    let live = []
    try { live = l.listProviders() || [] } catch { live = [] }
    const out = []
    for (const p of live) {
      let models = []
      let error
      try { models = (await l.listModels?.(p.id)) || [] } catch (e) { error = String(e?.message || e).slice(0, 200) }
      out.push({ id: p.id, name: p.name || p.id, models: models.map((m) => ({ id: m.id, name: m.name || m.id, ...(m.description ? { description: m.description } : {}) })), ...(error ? { error } : {}) })
    }
    let dormant = []
    try {
      const liveIds = new Set(out.map((p) => p.id))
      dormant = (l.listConfigurableProviders?.() || []).filter((c) => !liveIds.has(c.provider)).map((c) => ({ id: c.provider, name: c.displayName || c.provider, ...(c.error ? { error: String(c.error).slice(0, 200) } : {}) }))
    } catch {}
    return { available: true, providers: out, dormant }
  }

  async function presets() {
    const s = presetsSvc()
    if (!s || typeof s.list !== 'function') return { available: false, presets: [], defaultId: '' }
    let rows = []
    try { rows = (await s.list()) || [] } catch { rows = [] }
    let defaultId = ''
    try { defaultId = String(s.defaultId || '') } catch {}
    return { available: true, defaultId, presets: rows.map((r) => ({ id: r.id, name: r.name || r.id, ...(r.description ? { description: r.description } : {}), ...(r.broken ? { broken: String(r.broken).slice(0, 200) } : {}) })) }
  }

  /**
   * 预设的人设文本（预设里 @deepseek-ai/dsh-persona 行的 config.prefix）。没有人设行时返回 ''。
   * 预设不存在 / 不可用时抛错（席位据此报错，而不是悄悄换成默认人设）。
   */
  async function presetPersona(id) {
    const hit = personaCache.get(id)
    if (hit && Date.now() - hit.at < 30_000) return hit.value
    const s = presetsSvc()
    if (!s || typeof s.readDocument !== 'function') throw new Error('DSH 未提供智能体预设服务')
    const rows = (await presets()).presets
    const row = rows.find((r) => r.id === id)
    if (!row) throw new Error(`预设 ${id} 不存在`)
    if (row.broken) throw new Error(`预设 ${id} 不可用：${row.broken}`)
    const doc = await s.readDocument(id)
    const value = personaFromComposition(doc?.content ?? (typeof s.read === 'function' ? await s.read(id) : ''))
    personaCache.set(id, { at: Date.now(), value })
    return value
  }

  return { providers, presets, presetPersona, llm }
}

/** GET /dsh/llm-catalog 与 /chatroom/catalog 共用的正文。 */
export async function llmCatalogPayload(catalog) {
  const [llm, presets] = await Promise.all([catalog.providers(), catalog.presets()])
  return { llm, presets }
}

/** GET /dsh/efforts 与 /chatroom/efforts 共用：所选模型在 DSH 里声明的推理强度。 */
export async function reasoningEfforts(catalog, provider, model) {
  const llm = typeof catalog?.llm === 'function' ? catalog.llm() : null
  let efforts = []
  let defaultEffort = ''
  try {
    const info = await (llm?.resolveModelInfo?.(provider || '', model || '') ?? llm?.resolveModel?.(provider || '', model || ''))
    efforts = (info?.reasoning?.efforts || []).map((e) => ({
      id: String(e.id),
      name: e.name || String(e.id),
      ...(e.description ? { description: e.description } : {}),
    }))
    defaultEffort = String(info?.reasoning?.defaultEffort || '')
  } catch { /* 模型信息读不到时就没有可选项 */ }
  return { efforts, defaultEffort }
}

// js-yaml：预设文档里的 `!!js` 条件按原文保留，不求值。
const jsTag = (kind) => new yaml.Type('tag:yaml.org,2002:js', { kind, construct: (d) => ({ $js: d }) })
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsTag('scalar'), jsTag('mapping'), jsTag('sequence')])

/** 从预设组合（YAML 子插件列表）里找 dsh-persona 行的 prefix；模板 {{…}} 占位去掉。 */
export function personaFromComposition(text) {
  let tree
  try { tree = yaml.load(String(text || ''), { schema: SCHEMA }) } catch { return '' }
  let found = ''
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.name === 'string' && PERSONA_ROW.test(node.name) && node.disabled !== true && typeof node.config?.prefix === 'string') {
      found = node.config.prefix
      return
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(tree)
  return found.replace(/\{\{[^{}]*\}\}/g, '').trim()
}
