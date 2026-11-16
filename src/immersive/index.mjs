/**
 * 沉浸工具（door + 后台助手）：让「纯对话」预设（默认 qq-bare）的角色在不跳戏的前提下用上全部工具。
 *
 *   所有者前台 —— 请求里是 find_tools，加上它钉选过的功能（下一步直接调用），以及点名保留的少数工具。
 *                  不再把差事交给后台助手干等。调用过程仍对聊天对方隐藏（见 channels/process-hide.mjs）。
 *   其他人前台 —— 仍只剩一把「门」errand。
 *   门        —— 把差事同步交给后台助手，结果当作一段普通的话还回去；办不成回一句中性的「没办成」。
 *   后台助手  —— 本功能建的隐藏会话（所有者 / 访客两种），拿真正的工具；访客只放行开放集合。
 *
 * 与具体工具清单解耦：前台角色靠「只剩门」收敛，访客助手靠 owner-gate 的 isOpenTool 判断
 * （不在开放集合里的一律不放行，包括以后新装的任何 MCP），所以增删 MCP 不需要改这里。
 *
 * 设置 immersiveEnabled 默认关闭：开了才会改写模型请求、注册门与闸门、建助手会话。
 * 前台会话的预设不变（预设锁在会话上，不能换）；工具是在请求层收敛的，不改会话预设。
 */
import { join } from 'node:path'
import { createHelperPool } from './helper.mjs'
import { createDoorTool } from './door.mjs'
import { isOwnerTurn, setHiddenPredicate } from './bridge.mjs'
import { wrapLlmForImmersive, detachImmersiveWrap, isImmersiveWrapped } from './wrap.mjs'
import {
  DEFAULT_KEEP_TOOLS,
  classifyRole,
  helperDenyReason,
  otherDenyReason,
  parseNameList,
  personaDenyReason,
  personaHint,
  resolveHint,
} from './policy.mjs'

export const IMMERSIVE_KEYS = [
  'immersiveEnabled',
  'immersivePresets',
  'immersiveHelperPreset',
  'immersiveKeepTools',
  'immersiveHint',
  'immersiveErrandTimeoutSec',
  'immersiveHelperMaxTurns',
  'immersiveHideProcess',
  'immersiveHelperProvider',
  'immersiveHelperModel',
]

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function immersiveSettings(cfg) {
  const c = cfg || {}
  const presetList = parseNameList(c.immersivePresets)
  const keepRaw = String(c.immersiveKeepTools ?? '').trim()
  let keepList
  if (!keepRaw) keepList = [...DEFAULT_KEEP_TOOLS]
  else if (/^(none|无|-)$/i.test(keepRaw)) keepList = []
  else keepList = parseNameList(keepRaw)
  return {
    enabled: c.immersiveEnabled === true,
    presets: new Set(presetList.length ? presetList : ['qq-bare']),
    helperPreset: String(c.immersiveHelperPreset ?? '').trim() || 'qq-tools-only',
    keep: new Set(keepList),
    hint: resolveHint(c.immersiveHint),
    timeoutMs: clampInt(c.immersiveErrandTimeoutSec, 10, 600, 90) * 1000,
    maxTurns: clampInt(c.immersiveHelperMaxTurns, 5, 200, 30),
    hideProcess: c.immersiveHideProcess !== false,
    helperProvider: String(c.immersiveHelperProvider ?? '').trim(),
    helperModel: String(c.immersiveHelperModel ?? '').trim(),
  }
}

function svc(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(name)
      if (v != null) return v
    }
  } catch { /* 退回属性 */ }
  try { return ctx?.[name] ?? null } catch { return null }
}

/** agents.get 可能返回 agent 本体，也可能是 { agent }。 */
function agentOf(value) {
  if (!value || typeof value !== 'object') return null
  if (value.ctx || value.session) return value
  if (value.agent && typeof value.agent === 'object') return value.agent
  return null
}

/** 宿主的 markAgentLoopRequest（WeakSet 必须是宿主那份，不能打进本产物）。 */
function resolveMarkAgentLoopRequest() {
  try {
    const spec = ['@deepseek-ai', 'dsh-llm'].join('/')
    const req = typeof require === 'function' ? require : null
    if (!req) return null
    const mod = req(spec)
    return typeof mod?.markAgentLoopRequest === 'function' ? mod.markAgentLoopRequest : null
  } catch {
    return null
  }
}

const SEEN_CAP = 500

/**
 * @param {any} ctx
 * @param {() => any} getConfig
 * @param {{ dir: string, markAgentLoopRequest?: Function, pins?: { list: (sessionId: string) => string[] } }} options
 *   pins：与 find_tools 共用的会话钉选（google-tool-cap 的 pin store）。
 */
export function createImmersiveFeature(ctx, getConfig, options = {}) {
  const log = ctx.logger ?? console
  const dir = options.dir || join(process.cwd(), 'immersive')
  const state = { status: 'off', detail: '未启用' }
  const presetCache = new Map() // sessionId → 预设 id（预设锁在会话上，非空才缓存）
  const loggedRoles = new Set()
  const markAgentLoopRequest = options.markAgentLoopRequest ?? resolveMarkAgentLoopRequest()
  let disposed = false
  let gen = 0
  let pool = null
  let fork = null
  let injectFork = null
  let wrapReady = false
  let offHidden = null
  const guardOffs = []
  const wrappedLlms = new Set()

  const settings = () => immersiveSettings(getConfig?.())

  function presetOfSession(sessionId) {
    const cached = presetCache.get(sessionId)
    if (cached) return cached
    let preset = ''
    try {
      const agent = agentOf(svc(ctx, 'agents')?.get?.(sessionId))
      const fromHost = svc(ctx, 'agentPresets')?.composedPreset?.(agent?.ctx)
      preset = String(fromHost || agent?.session?.header?.agentPreset || agent?.session?.meta?.agentPreset || '').trim()
    } catch { preset = '' }
    if (preset) {
      if (presetCache.size >= SEEN_CAP) presetCache.delete(presetCache.keys().next().value)
      presetCache.set(sessionId, preset)
    }
    return preset
  }

  /** 'persona' | 'helper-owner' | 'helper-open' | 'other' */
  function roleOf(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return 'other'
    const presets = settings().presets
    const kind = pool?.kindOf(sid) || ''
    if (kind) return classifyRole({ sessionId: sid, helperKind: () => kind, presets })
    return classifyRole({ sessionId: sid, preset: presetOfSession(sid), presets })
  }

  /** tools.guard：单调拒绝闸门（返回字符串即拒绝）。与通道的所有者闸门各管各的，任何一方拒绝都生效。 */
  function guard(exec) {
    const sid = String(exec?.agent?.id || exec?.sessionId || '').trim()
    if (!sid) return undefined
    const name = exec?.name
    const role = roleOf(sid)
    if (role === 'helper-owner') return helperDenyReason('owner', name)
    if (role === 'helper-open') return helperDenyReason('open', name)
    if (role === 'persona') {
      if (!wrapReady) return undefined
      const owner = isOwnerTurn(sid)
      const pins = owner ? new Set(options.pins?.list?.(sid) || []) : null
      return personaDenyReason(name, settings().keep, { direct: owner, pins })
    }
    return otherDenyReason(name)
  }

  function noteRewrite({ sessionId, role, before, after, hinted }) {
    if (role === 'other') return
    const key = `${role}:${sessionId}`
    if (loggedRoles.has(key)) return
    if (loggedRoles.size >= SEEN_CAP) loggedRoles.clear()
    loggedRoles.add(key)
    log.info?.(`dsh-workbench immersive: role=${role} session=${String(sessionId).slice(0, 8)} tools ${before}→${after}${hinted ? ' hint=on' : ''}`)
  }

  const wrapDeps = {
    roleOf,
    keep: () => settings().keep,
    directOf: (sessionId) => isOwnerTurn(sessionId),
    pinsOf: (sessionId) => options.pins?.list?.(sessionId) || [],
    hint: (sessionId) => personaHint(getConfig()?.immersiveHint, { direct: isOwnerTurn(sessionId) }),
    onRewrite: noteRewrite,
    markAgentLoopRequest,
  }

  function wrapLlm(llm) {
    if (!llm || typeof llm.stream !== 'function') return false
    if (!wrapLlmForImmersive(llm, wrapDeps)) return false
    wrappedLlms.add(llm)
    wrapReady = true
    return true
  }

  function ensureLlmInject() {
    if (injectFork || typeof ctx.inject !== 'function') return
    try {
      injectFork = ctx.inject(['llm'], (sub) => {
        if (disposed || !pool) return
        wrapLlm(svc(sub, 'llm') || svc(ctx, 'llm'))
      })
    } catch (e) {
      log.warn?.('dsh-workbench immersive: llm inject failed', e?.name || e)
    }
  }

  async function stop() {
    gen += 1
    try { offHidden?.() } catch { /* ignore */ }
    offHidden = null
    for (const off of guardOffs.splice(0)) { try { off?.() } catch { /* ignore */ } }
    const f = fork
    fork = null
    if (f) { try { await f.dispose?.() } catch (e) { log.warn?.('dsh-workbench immersive: stop fork failed', e?.name || 'error') } }
    for (const llm of wrappedLlms) detachImmersiveWrap(llm)
    wrappedLlms.clear()
    wrapReady = false
    const p = pool
    pool = null
    if (p) { try { await p.dispose() } catch (e) { log.warn?.('dsh-workbench immersive: pool dispose failed', e?.message || e) } }
    presetCache.clear()
    loggedRoles.clear()
  }

  async function start() {
    const myGen = ++gen
    if (typeof ctx.plugin !== 'function') {
      state.status = 'error'
      state.detail = '宿主不支持挂载子插件（ctx.plugin）'
      return
    }
    pool = createHelperPool({
      ctx,
      dir,
      log,
      getSettings: () => {
        const s = settings()
        return { helperPreset: s.helperPreset, maxTurns: s.maxTurns, provider: s.helperProvider, model: s.helperModel }
      },
    })
    offHidden = setHiddenPredicate((sid) => settings().hideProcess && roleOf(sid) === 'persona')
    wrapLlm(svc(ctx, 'llm'))
    ensureLlmInject()
    try {
      const door = createDoorTool({
        ask: (kind, prompt, opts) => (pool ? pool.ask(kind, prompt, opts) : Promise.resolve({ ok: false, reason: 'unavailable' })),
        isOwnerTurn,
        getTimeoutMs: () => settings().timeoutMs,
      })
      fork = ctx.plugin({
        name: 'dsh-workbench-immersive',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            toolCtx.tools.register(door)
            const off = toolCtx.tools.guard(guard)
            if (typeof off === 'function') guardOffs.push(off)
          })
          sub.inject(['llm'], (llmCtx) => {
            if (disposed || !pool) return
            wrapLlm(svc(llmCtx, 'llm') || svc(sub, 'llm'))
          })
        },
      })
    } catch (e) {
      state.status = 'error'
      state.detail = '门挂载失败'
      log.warn?.('dsh-workbench immersive: start failed', e?.name || e)
      await stop()
      return
    }
    if (myGen !== gen) { await stop(); return }
    state.status = 'on'
    state.detail = wrapReady ? '已启用' : '已启用 · 等待 llm 服务（未就绪前前台角色仍看得到全部工具）'
  }

  async function sync() {
    if (disposed) return
    const s = settings()
    const active = !!fork || !!pool
    if (s.enabled && !active) {
      await start()
    } else if (!s.enabled && active) {
      await stop()
      state.status = 'off'
      state.detail = '未启用'
    } else if (s.enabled) {
      state.detail = wrapReady ? '已启用' : '已启用 · 等待 llm 服务（未就绪前前台角色仍看得到全部工具）'
    }
  }

  return {
    sync,
    roleOf,
    state() {
      return {
        status: state.status,
        detail: state.detail,
        wrapped: [...wrappedLlms].some((llm) => isImmersiveWrapped(llm)),
        helpers: pool?.status() ?? null,
      }
    },
    async dispose() {
      disposed = true
      try { await injectFork?.dispose?.() } catch { /* ignore */ }
      injectFork = null
      await stop()
      state.status = 'off'
      state.detail = '已卸载'
    },
  }
}
