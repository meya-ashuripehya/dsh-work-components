/**
 * 网关核验（会话级开关）：在 llm/stream 瀑布上包一层只读采集器，不改动任何块。
 * 开关打开的会话，每次主循环模型调用结束后按 llm-gateway-bench 的判定函数出五项结论，按「会话 › 回合」保存，
 * 客户端在「用量」右侧显示核验芯片。
 *
 * 数据：<数据目录>/gateway-trust/state.json（开启的会话）与 sessions/<会话>.json（每会话最多 MAX_TURNS 个回合）。
 * API：GET  /dsh-workbench/api/trust/state?sessionId=…  → { installed, available, reason, dir, enabled }（每次重新检查安装目录，下载后无需重启）
 *      POST /dsh-workbench/api/trust/toggle { sessionId, enabled }
 *      GET  /dsh-workbench/api/trust/turns?sessionId=…  → { turns: { <回合>: { rows, overall, calls, at } } }
 *      GET  /dsh-workbench/api/trust/bench             → 设置页：llm-gateway-bench 安装状态 / 下载任务（含日志）
 *      POST /dsh-workbench/api/trust/bench/install      → 下载钉死提交到 <数据目录>/tools/llm-gateway-bench
 *      POST /dsh-workbench/api/trust/bench/cancel
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { loadBench } from './bench.mjs'
import { benchInstallStatus, cancelBenchInstall, managedBenchDir, startBenchInstall } from './install.mjs'
import { createCallRecorder, evaluateCall, mergeTurn } from './evaluate.mjs'

export { createCallRecorder, evaluateCall, mergeTurn } from './evaluate.mjs'
export { loadBench } from './bench.mjs'

export const MAX_TURNS = 300
const SAFE_ID = /^[\w.:-]{1,128}$/

function service(ctx, name) {
  try { const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined; if (v != null) return v } catch { /* ignore */ }
  try { return ctx?.[name] ?? null } catch { return null }
}

/** 当前回合号：优先读活跃 agent 的 phase；读不到时用本模块从会话事件记下的值。 */
function liveTurn(ctx, sessionId, fallback) {
  try {
    const agent = service(ctx, 'agents')?.get?.(sessionId)
    const phase = agent?.phase
    if (phase && phase.kind === 'running' && Number.isSafeInteger(phase.turn) && phase.turn > 0) return phase.turn
  } catch { /* ignore */ }
  const f = fallback.get(sessionId)
  return Number.isSafeInteger(f) ? f : null
}

export function createGatewayTrust(ctx, getConfig, { base = dataDir(), dir = join(base, 'gateway-trust'), now = () => Date.now(), importImpl, installImpl } = {}) {
  const stateFile = join(dir, 'state.json')
  let enabled = new Set()
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (Array.isArray(raw?.enabled)) enabled = new Set(raw.enabled.filter((s) => typeof s === 'string' && SAFE_ID.test(s)))
  } catch { /* 首次使用 */ }
  const sessions = new Map() // sessionId → { turns: Map<turn, { calls: [], at }>, maxPrompt }
  const turnHint = new Map()
  const writes = new Map()

  const bench = () => loadBench(managedBenchDir(base), importImpl ? { importImpl } : {})

  function sessionFile(id) { return join(dir, 'sessions', id + '.json') }

  function loadSession(id) {
    let s = sessions.get(id)
    if (s) return s
    s = { turns: new Map(), maxPrompt: null }
    try {
      const raw = JSON.parse(readFileSync(sessionFile(id), 'utf8'))
      for (const [k, v] of Object.entries(raw?.turns ?? {})) if (v && Array.isArray(v.calls)) s.turns.set(Number(k), v)
      if (typeof raw?.maxPrompt === 'number') s.maxPrompt = raw.maxPrompt
    } catch { /* none yet */ }
    sessions.set(id, s)
    return s
  }

  async function atomicWrite(file, data) {
    await mkdir(join(file, '..'), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, file)
  }

  function scheduleWrite(id) {
    if (writes.has(id)) return
    writes.set(id, setTimeout(() => {
      writes.delete(id)
      const s = sessions.get(id)
      if (!s) return
      const turns = {}
      for (const [k, v] of s.turns) turns[k] = v
      atomicWrite(sessionFile(id), JSON.stringify({ version: 1, maxPrompt: s.maxPrompt, turns })).catch((e) => ctx.logger?.warn?.('dsh-workbench: gateway-trust write failed', e))
    }, 500))
  }

  async function saveState() {
    await atomicWrite(stateFile, JSON.stringify({ version: 1, enabled: [...enabled] }))
  }

  function record(sessionId, turn, result, rec) {
    const s = loadSession(sessionId)
    const key = Number.isSafeInteger(turn) ? turn : 0
    const entry = s.turns.get(key) ?? { calls: [], at: 0 }
    entry.calls.push({ rows: result.rows, overall: result.overall, provider: rec.provider, requestedModel: rec.requestedModel, responseModel: rec.responseModel, at: rec.endedAt })
    if (entry.calls.length > 64) entry.calls.splice(0, entry.calls.length - 64)
    entry.at = rec.endedAt
    s.turns.set(key, entry)
    while (s.turns.size > MAX_TURNS) s.turns.delete(s.turns.keys().next().value)
    const u = rec.usage || {}
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0)
    if (prompt > 0) s.maxPrompt = Math.max(s.maxPrompt ?? 0, prompt)
    scheduleWrite(sessionId)
  }

  /** llm/stream 监听：只读包装；任何采集或判定错误都吞掉，不影响模型调用。 */
  function onStream(options, next) {
    const sessionId = options?.sessionId
    if (typeof sessionId !== 'string' || !enabled.has(sessionId) || !SAFE_ID.test(sessionId)) return next()
    const turn = liveTurn(ctx, sessionId, turnHint)
    let recorder = null
    try { recorder = createCallRecorder({ provider: options.provider, model: options.model, now }) } catch { return next() }
    const priorMaxPrompt = loadSession(sessionId).maxPrompt
    async function* wrapped() {
      const source = await next()
      try {
        for await (const chunk of source) {
          try { recorder.onChunk(chunk) } catch { /* ignore */ }
          yield chunk
        }
      } finally {
        try {
          const done = recorder.end()
          if (done.rec.chunks > 0 || done.rec.usage) {
            const b = await bench()
            if (b.ok) record(sessionId, turn, evaluateCall(done, b.mod, { priorMaxPrompt }), done.rec)
          }
        } catch (e) { ctx.logger?.debug?.('dsh-workbench: gateway-trust evaluate failed', e) }
      }
    }
    return wrapped()
  }

  function install() {
    const disposers = []
    if (typeof ctx.on === 'function') {
      try { const off = ctx.on('llm/stream', onStream); if (typeof off === 'function') disposers.push(off) } catch (e) { ctx.logger?.warn?.('dsh-workbench: gateway-trust cannot hook llm/stream', e) }
    }
    return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
  }

  async function state(sessionId) {
    const b = await bench()
    return { installed: !!b.installed, available: b.ok, reason: b.ok ? '' : b.reason, dir: b.dir || '', enabled: b.ok && !!sessionId && enabled.has(sessionId) }
  }

  async function handleApi(req, res, sub, { sendJson, readBody }) {
    const url = new URL(req.url ?? '/', 'http://local')
    if (sub === '/trust/state' && req.method === 'GET') {
      const id = url.searchParams.get('sessionId') || ''
      return sendJson(res, 200, { ok: true, ...await state(SAFE_ID.test(id) ? id : '') })
    }
    if (sub === '/trust/toggle' && req.method === 'POST') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      const body = JSON.parse(await readBody(req) || '{}')
      const id = String(body.sessionId || '')
      if (!SAFE_ID.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid sessionId' })
      if (body.enabled) {
        const b = await bench()
        if (!b.ok) return sendJson(res, 409, { ok: false, error: b.reason })
        enabled.add(id)
      } else enabled.delete(id)
      await saveState()
      return sendJson(res, 200, { ok: true, ...await state(id) })
    }
    if (sub === '/trust/bench' && req.method === 'GET') {
      const b = await bench()
      return sendJson(res, 200, { ok: true, ...benchInstallStatus(base), active: { installed: !!b.installed, available: b.ok, dir: b.dir || '', reason: b.ok ? '' : b.reason } })
    }
    if ((sub === '/trust/bench/install' || sub === '/trust/bench/cancel') && req.method === 'POST') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      if (sub === '/trust/bench/cancel') { cancelBenchInstall(); return sendJson(res, 200, { ok: true, ...benchInstallStatus(base) }) }
      const start = installImpl || startBenchInstall
      start({ base, proxy: String(getConfig()?.proxy || '') || undefined }).catch((e) => ctx.logger?.warn?.('dsh-workbench: llm-gateway-bench install failed', e))
      return sendJson(res, 200, { ok: true, ...benchInstallStatus(base) })
    }
    if (sub === '/trust/turns' && req.method === 'GET') {
      const id = url.searchParams.get('sessionId') || ''
      if (!SAFE_ID.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid sessionId' })
      const s = sessions.get(id) ?? (existsSync(sessionFile(id)) ? loadSession(id) : null)
      const turns = {}
      if (s) for (const [k, v] of s.turns) turns[k] = { ...mergeTurn(v.calls), at: v.at, models: [...new Set(v.calls.map((c) => c.responseModel).filter(Boolean))] }
      return sendJson(res, 200, { ok: true, enabled: enabled.has(id), turns })
    }
    return false
  }

  return {
    install,
    handleApi,
    state,
    onStream,
    /** 测试 / 事件兜底：记下某会话的回合号。 */
    noteTurn(sessionId, turn) { if (Number.isSafeInteger(turn)) turnHint.set(sessionId, turn) },
    isEnabled: (id) => enabled.has(id),
    async flush() {
      for (const [id, t] of writes) { clearTimeout(t); writes.delete(id); const s = sessions.get(id); if (!s) continue; const turns = {}; for (const [k, v] of s.turns) turns[k] = v; await atomicWrite(sessionFile(id), JSON.stringify({ version: 1, maxPrompt: s.maxPrompt, turns })) }
    },
    dispose() { for (const t of writes.values()) clearTimeout(t); writes.clear() },
  }
}
