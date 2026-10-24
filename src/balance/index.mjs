/**
 * 「通用」›「余额查询」：默认关闭。各服务商使用本卡片中单独保存的密钥（不复用 DSH 聊天服务商的密钥），
 * 只请求官方查询接口（见 ./providers.mjs）。结果在内存中缓存约 60 秒；可按设置定时自动刷新。
 * 打开「AI 查询工具」时在子插件里注册 balance_query（只返回金额与币种）；该工具不在 Telegram OPEN_TOOLS 中，仅授权用户可用。
 *
 * 可选的本地扩展：若存在 <插件目录>/src/balance/custom-entries.local.mjs 或 <数据目录>/balance/custom-entries.local.mjs，
 * 运行时动态加载，提供一组可由用户自行添加的「附加条目」（名称 + 地址 + 密钥）；文件不存在时静默跳过，界面也不显示该分组。
 * 附加条目及其密钥保存在数据目录 balance/extra-entries.json，不进插件设置，接口只返回「已配置」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { dataDir, pluginRoot } from '../tools.mjs'
import { BalanceError, PROVIDERS, UNSUPPORTED, providerById, providerConfigured, redactText, REQUEST_TIMEOUT_MS } from './providers.mjs'
import { createBalanceTools } from './tools.mjs'

export const CACHE_MS = 60_000
export const AUTO_REFRESH_OPTIONS = ['0', '10', '30', '60']
export const MAX_EXTRA_ENTRIES = 20
export const EXTENSION_FILE = 'custom-entries.local.mjs'

/** 设置页通用字段（卡片表单）。各服务商的键见 PROVIDERS。 */
export const BALANCE_KEYS = ['balanceEnabled', 'balanceAiTool', 'balanceAutoRefreshMin', 'balanceLowThreshold']

/** 所有服务商相关的设置键（含密钥）。 */
export const BALANCE_PROVIDER_KEYS = PROVIDERS.flatMap((p) => [p.enabledKey, ...p.fields.map((f) => f.key)])

/** SettingsSchema 片段。密钥一律 role('secret')。 */
export function balanceSchemaShape(z) {
  const shape = {
    balanceEnabled: z.boolean().default(false).description('启用余额查询。默认关闭。各服务商使用本卡片中单独保存的密钥，只请求官方查询接口。'),
    balanceAiTool: z.boolean().default(true).description('启用余额查询后，向会话提供 balance_query 工具（只返回金额与币种）。仅授权用户可在 Telegram 中使用。'),
    balanceAutoRefreshMin: z.string().default('0').description('自动刷新间隔（分钟）：0（关闭）、10、30 或 60。'),
    balanceLowThreshold: z.number().default(0).description('余额低于该数值时提示（按各服务商自身币种比较）；0 为不提示。'),
  }
  for (const p of PROVIDERS) {
    shape[p.enabledKey] = z.boolean().default(false).description(`余额查询：启用 ${p.name}。`)
    for (const f of p.fields) {
      if (f.type === 'secret') shape[f.key] = z.string().role('secret').default('').description(`余额查询：${p.name} 的 ${f.label}。只保存在本插件设置中，接口与日志不以明文返回。`)
      else if (f.type === 'switch') shape[f.key] = z.boolean().default(f.def === true).description(`余额查询：${p.name} · ${f.label}。`)
      else shape[f.key] = z.string().default(f.def ?? '').description(`余额查询：${p.name} · ${f.label}。`)
    }
  }
  return shape
}

export function balanceSettings(cfg) {
  const c = cfg || {}
  const auto = AUTO_REFRESH_OPTIONS.includes(String(c.balanceAutoRefreshMin)) ? Number(c.balanceAutoRefreshMin) : 0
  const low = Number(c.balanceLowThreshold)
  return {
    enabled: c.balanceEnabled === true,
    toolEnabled: c.balanceAiTool !== false,
    autoRefreshMin: auto,
    lowThreshold: Number.isFinite(low) && low > 0 ? low : 0,
  }
}

// ── 附加条目存储（数据目录 JSON）──
export function createExtraStore(file) {
  function read() {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(j?.entries) ? j.entries.filter((e) => e && typeof e.id === 'string') : []
    } catch { return [] }
  }
  function write(entries) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ entries }, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch {}
  }
  return { read, write, file }
}

function genericBaseUrl(raw) {
  const text = String(raw ?? '').trim()
  let url
  try { url = new URL(text) } catch { throw new BalanceError('地址格式不正确。') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BalanceError('地址仅支持 http 或 https 协议。')
  if (url.username || url.password) throw new BalanceError('地址中不能包含用户名或密码。')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

/**
 * 合并界面提交的附加条目：apiKey 为 secretMask / 未提供时保留原值，'' 清除，其它字符串替换。
 * @returns {Array<{ id, name, baseUrl, enabled, apiKey }>}
 */
export function mergeExtraEntries(prev, incoming, { secretMask, normalizeBaseUrl = genericBaseUrl } = {}) {
  if (!Array.isArray(incoming)) throw new BalanceError('条目列表格式不正确。')
  if (incoming.length > MAX_EXTRA_ENTRIES) throw new BalanceError(`最多添加 ${MAX_EXTRA_ENTRIES} 个条目。`)
  const byId = new Map((prev || []).map((e) => [e.id, e]))
  const seen = new Set()
  const out = []
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue
    let id = typeof raw.id === 'string' && /^[a-z0-9-]{3,40}$/.test(raw.id) ? raw.id : ''
    if (!id || seen.has(id)) id = 'e-' + randomBytes(4).toString('hex')
    seen.add(id)
    const old = byId.get(id)
    const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!name) throw new BalanceError('请为每个条目填写名称。')
    const baseUrl = normalizeBaseUrl(raw.baseUrl)
    let apiKey = old?.apiKey || ''
    if (typeof raw.apiKey === 'string' && raw.apiKey !== secretMask) apiKey = raw.apiKey.trim()
    out.push({ id, name, baseUrl, enabled: raw.enabled === true, apiKey })
  }
  return out
}

/** 可选本地扩展的候选路径。 */
export function extensionCandidates() {
  return [join(pluginRoot(), 'src', 'balance', EXTENSION_FILE), join(dataDir(), 'balance', EXTENSION_FILE)]
}

async function loadExtension(paths, log) {
  for (const p of paths) {
    if (!p || !existsSync(p)) continue
    try {
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod?.query === 'function' && typeof mod?.describe === 'function') return mod
    } catch (error) {
      log?.warn?.('dsh-workbench: balance extension failed to load', error?.name || 'error')
    }
  }
  return null
}

const nowIso = (now) => (now ? now() : new Date()).toISOString()

/** 结果是否低于提示阈值（只看 balance 类型）。 */
export function isLow(result, threshold) {
  if (!threshold || !result?.ok) return false
  return (result.items || []).some((x) => x.type === 'balance' && typeof x.value === 'number' && x.value < threshold)
}

/**
 * @param ctx Cordis ctx
 * @param getConfig () => 当前设置
 * @param o { fetchImpl?, now?, extensionPaths?, storeFile?, timeoutMs? }
 */
export function createBalanceFeature(ctx, getConfig, o = {}) {
  const log = ctx?.logger ?? console
  const cache = new Map() // id → result
  const inflight = new Map()
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  const store = createExtraStore(o.storeFile || join(dataDir(), 'balance', 'extra-entries.json'))
  let ext
  let extLoading = null
  let timer = null
  let timerMin = 0
  let snapshot = ''
  let disposed = false

  async function extension() {
    if (ext !== undefined) return ext
    if (!extLoading) extLoading = loadExtension(o.extensionPaths || extensionCandidates(), log).then((m) => { ext = m; return m })
    return extLoading
  }

  function cfg() { return getConfig() || {} }

  /** 当前应当查询的条目 id：已启用、已配置的官方服务商与附加条目。 */
  async function activeIds() {
    const c = cfg()
    const ids = PROVIDERS.filter((p) => c[p.enabledKey] === true && providerConfigured(p, c)).map((p) => p.id)
    if (await extension()) for (const e of store.read()) if (e.enabled && e.apiKey) ids.push('x:' + e.id)
    return ids
  }

  async function runOne(id) {
    const c = cfg()
    const base = { provider: id, checkedAt: nowIso(o.now) }
    const opts = { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs || REQUEST_TIMEOUT_MS, now: o.now }
    try {
      if (id.startsWith('x:')) {
        const m = await extension()
        const e = store.read().find((x) => 'x:' + x.id === id)
        if (!m || !e) throw new BalanceError('条目不存在。')
        if (!e.apiKey) throw new BalanceError('尚未保存密钥。')
        const r = await m.query({ baseUrl: e.baseUrl, apiKey: e.apiKey }, opts)
        return { ...base, name: e.name, kind: 'balance', ok: true, items: Array.isArray(r?.items) ? r.items : [], ...(r?.note ? { note: String(r.note).slice(0, 200) } : {}) }
      }
      const p = providerById(id)
      if (!p) throw new BalanceError('未知的服务商。')
      if (!providerConfigured(p, c)) throw new BalanceError('尚未保存密钥。')
      const r = await p.query(c, opts)
      return { ...base, name: p.name, kind: p.kind, ok: true, items: r.items || [], ...(r.note ? { note: r.note } : {}) }
    } catch (error) {
      const secrets = []
      for (const p of PROVIDERS) for (const f of p.fields) if (f.type === 'secret' && c[f.key]) secrets.push(c[f.key])
      for (const e of store.read()) if (e.apiKey) secrets.push(e.apiKey)
      const msg = error instanceof BalanceError ? error.message : '查询失败：' + (error?.message || error)
      const name = providerById(id)?.name || store.read().find((x) => 'x:' + x.id === id)?.name || id
      return { ...base, name, kind: providerById(id)?.kind || 'balance', ok: false, items: [], error: redactText(msg, secrets).slice(0, 300) }
    }
  }

  /** 查询（带 60 秒缓存与并发去重）。force 时忽略缓存。 */
  async function refresh(ids, { force = false } = {}) {
    const list = ids && ids.length ? ids : await activeIds()
    const now = (o.now ? o.now() : new Date()).getTime()
    const tasks = list.map(async (id) => {
      const hit = cache.get(id)
      if (!force && hit && now - Date.parse(hit.checkedAt) < CACHE_MS) return hit
      if (inflight.has(id)) return inflight.get(id)
      const run = runOne(id).then((r) => { cache.set(id, r); return r }).finally(() => inflight.delete(id))
      inflight.set(id, run)
      return run
    })
    return Promise.all(tasks)
  }

  function forget(id) { cache.delete(id) }

  /** 工具用：按 id / 名称筛选（不区分大小写），返回只含金额与币种的结果。 */
  async function query(filter) {
    const ids = await activeIds()
    let pick = ids
    if (filter) {
      const f = String(filter).trim().toLowerCase()
      const entries = store.read()
      pick = ids.filter((id) => {
        if (id.toLowerCase() === f) return true
        const p = providerById(id)
        if (p && p.name.toLowerCase().includes(f)) return true
        const e = entries.find((x) => 'x:' + x.id === id)
        return !!(e && e.name.toLowerCase().includes(f))
      })
      if (!pick.length) throw new BalanceError(`没有已启用的条目与「${String(filter).slice(0, 40)}」匹配。可用：${ids.join(', ') || '（无）'}。`)
    }
    if (!pick.length) throw new BalanceError('余额查询中没有已启用且已保存密钥的服务商。请在设置页「通用 › 余额查询」中配置。')
    const results = await refresh(pick)
    return results.map((r) => ({
      provider: r.provider, name: r.name, kind: r.kind, ok: r.ok, checkedAt: r.checkedAt,
      items: (r.items || []).map((x) => ({ label: x.label, value: x.value, currency: x.currency, type: x.type })),
      ...(r.error ? { error: r.error } : {}),
      ...(r.note ? { note: r.note } : {}),
    }))
  }

  async function stopTool() {
    const fork = state.fork
    state.fork = null
    if (fork) { try { await fork.dispose?.() } catch {} }
  }

  function syncTimer(s) {
    const min = s.enabled ? s.autoRefreshMin : 0
    if (min === timerMin && (min === 0 || timer)) return
    if (timer) { clearInterval(timer); timer = null }
    timerMin = min
    if (!min || disposed) return
    timer = setInterval(() => { void refresh(null, { force: true }).catch(() => {}) }, min * 60_000)
    timer.unref?.()
  }

  async function sync() {
    if (disposed) return
    const s = balanceSettings(cfg())
    syncTimer(s)
    const snap = s.enabled ? (s.toolEnabled ? 'tool' : 'on') : 'off'
    if (snap === snapshot) return
    const gen = ++state.gen
    await stopTool()
    if (gen !== state.gen) return
    snapshot = snap
    if (!s.enabled) { state.status = 'off'; state.detail = '未启用'; cache.clear(); return }
    state.status = 'on'
    state.detail = '已启用'
    if (!s.toolEnabled) return
    if (typeof ctx?.plugin !== 'function') { state.detail = '已启用（宿主不支持挂载工具）'; return }
    try {
      state.fork = ctx.plugin({
        name: 'dsh-workbench-balance',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            for (const tool of createBalanceTools({ query })) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) await stopTool()
    } catch (error) {
      snapshot = ''
      state.detail = '已启用（AI 查询工具挂载失败）'
      log.warn?.('dsh-workbench: balance tool mount failed', error?.name || 'error')
    }
  }

  /** 设置页状态：不含任何密钥，只给「已配置」。 */
  async function view() {
    const c = cfg()
    const s = balanceSettings(c)
    const providers = PROVIDERS.map((p) => ({
      id: p.id, name: p.name, kind: p.kind, desc: p.desc, console: p.console,
      enabled: c[p.enabledKey] === true,
      configured: providerConfigured(p, c),
      fields: p.fields.map((f) => f.type === 'secret'
        ? { key: f.key, label: f.label, type: 'secret', placeholder: f.placeholder || '', configured: typeof c[f.key] === 'string' && c[f.key] !== '' }
        : { key: f.key, label: f.label, type: f.type, placeholder: f.placeholder || '', options: f.options, value: f.type === 'switch' ? c[f.key] === true : String(c[f.key] ?? f.def ?? '') }),
      result: decorate(cache.get(p.id), s.lowThreshold),
    }))
    const m = await extension()
    let extra = null
    if (m) {
      let d = {}
      try { d = m.describe() || {} } catch {}
      extra = {
        title: String(d.title || '附加条目'), note: String(d.note || ''), keyLabel: String(d.keyLabel || 'API Key'),
        example: d.example && typeof d.example === 'object' ? { name: String(d.example.name || ''), baseUrl: String(d.example.baseUrl || '') } : null,
        entries: store.read().map((e) => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, enabled: e.enabled === true, configured: !!e.apiKey, result: decorate(cache.get('x:' + e.id), s.lowThreshold) })),
      }
    }
    return { enabled: s.enabled, toolEnabled: s.toolEnabled, autoRefreshMin: s.autoRefreshMin, lowThreshold: s.lowThreshold, status: state.status, detail: state.detail, providers, unsupported: UNSUPPORTED, extra }
  }

  function decorate(r, threshold) {
    if (!r) return null
    return { ...r, low: isLow(r, threshold) }
  }

  async function saveExtra(entries, secretMask) {
    const m = await extension()
    if (!m) throw new BalanceError('当前未加载附加条目扩展。', { status: 404 })
    const norm = typeof m.normalizeBaseUrl === 'function' ? (raw) => m.normalizeBaseUrl(raw) : genericBaseUrl
    const merged = mergeExtraEntries(store.read(), entries, { secretMask, normalizeBaseUrl: norm })
    store.write(merged)
    for (const k of [...cache.keys()]) if (k.startsWith('x:')) cache.delete(k)
  }

  return {
    sync, refresh, query, view, forget, saveExtra, extension,
    async dispose() {
      disposed = true
      state.gen++
      snapshot = ''
      if (timer) { clearInterval(timer); timer = null }
      await stopTool()
    },
    state() { return { status: state.status, detail: state.detail, mounted: state.fork != null } },
  }
}

const refuseCrossSite = (req) => req.headers?.['sec-fetch-site'] === 'cross-site'

/**
 * 设置页 API（均不返回密钥）：
 *   GET  /balance/state                    → { ok, ...view }
 *   POST /balance/refresh { id? }          → 强制刷新一项或全部已启用项
 *   POST /balance/config { provider, enabled?, values? }   保存某服务商的开关 / 密钥 / 选项（密钥 '' 清除，掩码保持）
 *   POST /balance/extra { entries }        保存附加条目（仅扩展存在时）
 */
export async function handleBalanceApi(req, res, sub, { sendJson, readBody, feature, applyPatch, secretMask }) {
  if (sub === '/balance/state' && req.method === 'GET') return sendJson(res, 200, { ok: true, ...await feature.view() })
  if (req.method !== 'POST' || !['/balance/refresh', '/balance/config', '/balance/extra'].includes(sub)) return false
  if (refuseCrossSite(req)) return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
  let body = {}
  try { body = JSON.parse(await readBody(req) || '{}') || {} } catch { return sendJson(res, 400, { ok: false, error: '请求格式不正确。' }) }
  try {
    if (sub === '/balance/refresh') {
      const id = typeof body.id === 'string' && body.id ? body.id : ''
      await feature.refresh(id ? [id] : null, { force: true })
      return sendJson(res, 200, { ok: true, ...await feature.view() })
    }
    if (sub === '/balance/config') {
      const p = providerById(String(body.provider || ''))
      if (!p) return sendJson(res, 400, { ok: false, error: '未知的服务商。' })
      const patch = {}
      if (typeof body.enabled === 'boolean') patch[p.enabledKey] = body.enabled
      const values = body.values && typeof body.values === 'object' ? body.values : {}
      for (const f of p.fields) {
        if (!Object.prototype.hasOwnProperty.call(values, f.key)) continue
        const v = values[f.key]
        if (f.type === 'secret') {
          if (typeof v !== 'string' || v === secretMask) continue
          patch[f.key] = v.trim()
        } else if (f.type === 'switch') {
          patch[f.key] = v === true
        } else if (f.type === 'select') {
          if (f.options.some((x) => x.value === v)) patch[f.key] = v
        } else {
          patch[f.key] = String(v ?? '').trim().slice(0, 200)
        }
      }
      if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, ...await feature.view() })
      await applyPatch(patch)
      feature.forget(p.id)
      return sendJson(res, 200, { ok: true, ...await feature.view() })
    }
    if (sub === '/balance/extra') {
      await feature.saveExtra(body.entries, secretMask)
      return sendJson(res, 200, { ok: true, ...await feature.view() })
    }
  } catch (error) {
    const msg = error instanceof BalanceError ? error.message : '保存失败。'
    return sendJson(res, error?.status === 404 ? 404 : 400, { ok: false, error: msg })
  }
  return false
}
