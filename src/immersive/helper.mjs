/**
 * 后台助手会话池：沉浸前台角色通过「门」委托差事时，由这里的隐藏会话真正去办。
 *
 * 两种助手（各自一个长期会话）：
 *   owner —— 委托人是所有者：拿预设里的全部工具（含用户以后自己装的 MCP）；
 *   open  —— 委托人是陌生人：工具清单与 tools.guard 都收窄到 owner-gate 的开放集合（见 policy.mjs）。
 * 助手会话本身不绑定任何通道，不会往外发消息；它的回复文字与图片由这里从 session/event 里收走，
 * 作为「门」的返回值交给前台角色，由前台角色用自己的口吻转述。
 *
 * 可靠性约定：
 *   - 每种助手同一时刻只办一件差事（排队）；每件差事有总时限，超时取消并返回「没办成」的中性话。
 *   - 差事不会抛异常给前台角色：任何失败都变成 { ok:false, reason }，由门转成自然语言。
 *   - 助手会话 id 持久化到数据目录，重启后 resume；满 maxTurns 轮就换一个新会话，避免上下文无限膨胀。
 *   - 会话列表里可见（用 listableSeed 清掉 blank），方便所有者回看助手到底做了什么。
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { listableSeed } from '../chatroom/room-sessions.mjs'
import { assistantTextOf, imageRefsOf } from './policy.mjs'

export const HELPER_KINDS = Object.freeze(['owner', 'open'])
const TITLES = Object.freeze({ owner: '后台助手（所有者）', open: '后台助手（访客）' })
const MAX_REMEMBERED_SESSIONS = 40
const MAX_IMAGES = 6

function svc(ctx, name) {
  try { const v = ctx?.get?.(name); if (v != null) return v } catch { /* 退回属性 */ }
  try { return ctx?.[name] ?? null } catch { return null }
}

function asAgent(value) {
  if (value && typeof value.followup === 'function') return value
  if (value?.agent && typeof value.agent.followup === 'function') return value.agent
  return null
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const fail = (reason) => ({ ok: false, reason, text: '', images: [] })

function emptyState() {
  return { current: {}, sessions: {} }
}

function loadState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const st = emptyState()
    for (const kind of HELPER_KINDS) {
      const c = raw?.current?.[kind]
      if (c && typeof c.sessionId === 'string' && c.sessionId) st.current[kind] = { sessionId: c.sessionId, turns: Number(c.turns) || 0 }
    }
    for (const [id, kind] of Object.entries(raw?.sessions ?? {})) {
      if (typeof id === 'string' && HELPER_KINDS.includes(kind)) st.sessions[id] = kind
    }
    for (const kind of HELPER_KINDS) {
      const c = st.current[kind]
      if (c) st.sessions[c.sessionId] = kind
    }
    return st
  } catch {
    return emptyState()
  }
}

/**
 * @param {{
 *   ctx: any,
 *   dir: string,
 *   getSettings: () => { helperPreset: string, maxTurns: number, provider?: string, model?: string },
 *   log?: any,
 *   idleWaitMs?: number,
 * }} deps
 */
export function createHelperPool(deps) {
  const { ctx, dir } = deps
  const log = deps.log ?? console
  const idleWaitMs = deps.idleWaitMs ?? 5000
  const stateFile = join(dir, 'helpers.json')
  const cwd = join(dir, 'workspace')
  const state = loadState(stateFile)
  const handles = new Map() // kind → { sessionId, agent, handle }
  const collectors = new Map() // sessionId → { job, lastText, images, turn, live }
  const chains = { owner: Promise.resolve(), open: Promise.resolve() }
  let disposed = false
  let persistChain = Promise.resolve()
  const warn = (m, e) => { try { log.warn?.(`dsh-workbench immersive: ${m}`, e?.message || e || '') } catch { /* ignore */ } }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2)
    persistChain = persistChain.then(async () => {
      await mkdir(dir, { recursive: true })
      const tmp = `${stateFile}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, stateFile)
    }).catch((e) => warn('persist helpers.json failed', e))
    return persistChain
  }

  function rememberSession(sessionId, kind) {
    state.sessions[sessionId] = kind
    const keep = new Set(Object.values(state.current).map((c) => c.sessionId))
    let excess = Object.keys(state.sessions).length - MAX_REMEMBERED_SESSIONS
    // 对象键按插入顺序，最旧的先丢；当前正在用的助手会话永远保留。
    for (const id of Object.keys(state.sessions)) {
      if (excess <= 0) break
      if (keep.has(id)) continue
      delete state.sessions[id]
      excess -= 1
    }
  }

  async function composition(presetId) {
    const presets = svc(ctx, 'agentPresets')
    const id = String(presetId || '').trim()
    if (!presets || typeof presets.resolve !== 'function') return { agentPreset: id || undefined, setup: undefined }
    let resolved
    try { resolved = (await presets.resolve(id))?.id } catch { resolved = undefined }
    if (!resolved) throw new Error(`未找到后台助手预设「${id}」`)
    return {
      agentPreset: resolved,
      setup: async (agentCtx) => { if (typeof presets.mount === 'function') await presets.mount(agentCtx, resolved) },
    }
  }

  function agentOptions(settings) {
    const model = String(settings.model || '').trim()
    if (model) {
      const provider = String(settings.provider || '').trim()
      return { model, ...(provider ? { provider } : {}) }
    }
    try {
      const sel = svc(ctx, 'agentDefaultModel')?.currentSelection?.()
      if (sel?.model) return { model: sel.model, ...(sel.provider ? { provider: sel.provider } : {}) }
    } catch { /* 用宿主默认 */ }
    return undefined
  }

  function retitle(sessionId, kind, agent) {
    try {
      const titles = svc(ctx, 'sessionTitle')
      const session = svc(ctx, 'sessions')?.get?.(sessionId) || agent?.session
      if (titles && typeof titles.rename === 'function' && session) titles.rename(session, TITLES[kind])
    } catch (e) { warn('rename helper session failed', e) }
  }

  async function dropHandle(kind) {
    const cur = handles.get(kind)
    handles.delete(kind)
    try { await cur?.handle?.dispose?.() } catch (e) { warn('dispose helper failed', e) }
  }

  /** 取（必要时 resume / 新建 / 轮换）某种助手的智能体。 */
  async function ensure(kind) {
    const settings = deps.getSettings()
    const maxTurns = Math.max(1, Number(settings.maxTurns) || 30)
    const persisted = state.current[kind]
    const cur = handles.get(kind)
    if (cur && persisted && persisted.sessionId === cur.sessionId && persisted.turns < maxTurns) return cur
    if (cur) await dropHandle(kind)

    const agents = svc(ctx, 'agents')
    if (!agents || typeof agents.create !== 'function') throw new Error('agents service unavailable')
    const comp = await composition(settings.helperPreset)
    const options = agentOptions(settings)

    if (persisted?.sessionId && persisted.turns < maxTurns) {
      const live = asAgent(typeof agents.get === 'function' ? agents.get(persisted.sessionId) : null)
      if (live) {
        const entry = { sessionId: persisted.sessionId, agent: live, handle: null }
        handles.set(kind, entry)
        return entry
      }
      if (typeof agents.resume === 'function') {
        try {
          const handle = await agents.resume({
            resumeSessionId: persisted.sessionId,
            ...(options ? { agentOptions: options } : {}),
            ...(comp.setup ? { setup: comp.setup } : {}),
          })
          const agent = asAgent(handle)
          if (agent) {
            const entry = { sessionId: persisted.sessionId, agent, handle }
            handles.set(kind, entry)
            return entry
          }
        } catch (e) {
          warn(`resume ${kind} helper failed, creating a new one`, e)
        }
      }
    }

    const sessionId = randomUUID()
    await mkdir(cwd, { recursive: true })
    const handle = await agents.create({
      sessionId,
      meta: { cwd, ...(comp.agentPreset ? { agentPreset: comp.agentPreset } : {}) },
      ...(options ? { agentOptions: options } : {}),
      seed: listableSeed(),
      ...(comp.setup ? { setup: comp.setup } : {}),
    })
    const agent = asAgent(handle)
    if (!agent) throw new Error('agents.create returned no agent')
    state.current[kind] = { sessionId, turns: 0 }
    rememberSession(sessionId, kind)
    void persist()
    retitle(sessionId, kind, agent)
    const entry = { sessionId, agent, handle }
    handles.set(kind, entry)
    return entry
  }

  function finish(job, result) {
    job.d.resolve(result)
  }

  /** session/event：收助手这一轮的最后一段文字、图片，并在 turn/end 时交卷。 */
  function onEvent(session, event) {
    const id = String(session?.id ?? '')
    const c = id ? collectors.get(id) : undefined
    if (!c) return
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        c.live = true
        if (c.turn == null) c.turn = data.turn
        break
      case 'assistant/message': {
        c.live = true
        const text = assistantTextOf(data.message)
        if (text.trim()) c.lastText = text
        break
      }
      case 'tool/call':
        c.live = true
        break
      case 'tool/result': {
        c.live = true
        for (const ref of imageRefsOf(data.message)) {
          if (c.images.length >= MAX_IMAGES) break
          if (!c.images.some((r) => r.attachmentId === ref.attachmentId)) c.images.push(ref)
        }
        break
      }
      case 'turn/end': {
        // 取消上一件差事时迟到的 turn/end 会先于本件差事的任何事件到达：没见过本轮事件就忽略。
        if (!c.live) break
        if (c.turn != null && data.turn != null && data.turn !== c.turn) break
        const kind = data.reason?.kind
        if (kind === 'error') warn('helper turn failed', data.reason?.error)
        const text = c.lastText.trim()
        if (text && (kind == null || kind === 'completed')) finish(c.job, { ok: true, reason: 'completed', text, images: c.images })
        else finish(c.job, fail('failed'))
        break
      }
      default:
        break
    }
  }

  const offEvent = typeof ctx?.on === 'function' ? ctx.on('session/event', onEvent) : null

  async function waitIdle(agent) {
    let timer
    try {
      await Promise.race([
        Promise.resolve(typeof agent.whenIdle === 'function' ? agent.whenIdle() : undefined),
        new Promise((resolve) => { timer = setTimeout(resolve, idleWaitMs) }),
      ])
    } catch { /* 仍然继续下一件 */ } finally { clearTimeout(timer) }
  }

  async function run(job) {
    if (job.abandoned || disposed) return
    let entry
    try { entry = await ensure(job.kind) } catch (e) {
      warn(`${job.kind} helper unavailable`, e)
      finish(job, fail('unavailable'))
      return
    }
    if (job.abandoned || disposed) return
    const { agent, sessionId } = entry
    collectors.set(sessionId, { job, lastText: '', images: [], turn: null, live: false })
    job.abort = () => { try { agent.cancel?.({ kind: 'user' }, { keepInbox: false }) } catch { /* ignore */ } }
    try {
      // 宿主在把收件箱消息写入会话前会读 message.source.kind（用来认出 runtime-context）。
      // 缺 source 时这一轮在请求模型之前就以 “reading 'kind'” 结束，门只能回报「这事没办成」。
      agent.followup({
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text: job.prompt }],
        source: { kind: 'user' },
      })
    } catch (e) {
      collectors.delete(sessionId)
      warn(`${job.kind} helper rejected the errand`, e)
      finish(job, fail('failed'))
      return
    }
    await job.d.promise
    collectors.delete(sessionId)
    const st = state.current[job.kind]
    if (st && st.sessionId === sessionId) { st.turns += 1; void persist() }
    if (job.aborted) await waitIdle(agent)
  }

  /**
   * 办一件差事。永不抛异常。
   * @param {'owner'|'open'} kind
   * @param {string} prompt
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok: boolean, reason: string, text: string, images: any[] }>}
   */
  function ask(kind, prompt, opts = {}) {
    if (disposed || !HELPER_KINDS.includes(kind)) return Promise.resolve(fail('unavailable'))
    const timeoutMs = Math.max(50, Number(opts.timeoutMs) || 90000)
    const job = { kind, prompt: String(prompt ?? ''), abandoned: false, aborted: false, abort: null, d: deferred() }
    const timer = setTimeout(() => {
      job.abandoned = true
      job.aborted = true
      finish(job, fail('timeout'))
      try { job.abort?.() } catch { /* ignore */ }
    }, timeoutMs)
    chains[kind] = chains[kind]
      .then(() => run(job))
      .catch((e) => { warn(`${kind} errand crashed`, e); finish(job, fail('failed')) })
    return job.d.promise.finally(() => clearTimeout(timer))
  }

  return {
    ask,
    /** 这个会话是不是后台助手：'owner' | 'open' | ''。重启前建的助手也认（来自 helpers.json）。 */
    kindOf(sessionId) {
      return state.sessions[String(sessionId ?? '')] || ''
    },
    status() {
      return {
        owner: state.current.owner ? { ...state.current.owner } : null,
        open: state.current.open ? { ...state.current.open } : null,
        running: [...collectors.keys()],
      }
    },
    async dispose() {
      disposed = true
      try { offEvent?.() } catch { /* ignore */ }
      for (const c of collectors.values()) finish(c.job, fail('unavailable'))
      collectors.clear()
      for (const kind of HELPER_KINDS) await dropHandle(kind)
      try { await persistChain } catch { /* ignore */ }
    },
  }
}
