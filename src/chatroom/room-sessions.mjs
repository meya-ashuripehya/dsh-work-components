/**
 * 房间会话：每个聊天室房间在 DSH 左侧会话列表里对应一个真实会话（ctx.agents.create），
 * 打开该会话时客户端在右侧停靠窗显示这个房间（与棋类共用同一个停靠窗）。
 *   - 预设固定为「访客模式」guest（纯对话、无工具）；预设不存在时拒绝创建，不改用其他预设。
 *   - 无论会话由谁挂起（本插件 resume 或 DSH 界面打开时自行 resume），都经插件级监听生效：
 *       ctx.tools.guard：房间会话里的任何工具调用一律拒绝；
 *       agent/pre-step：拒绝进入模型步骤，用户在该会话普通输入框里写的文字改为以用户身份发到聊天室。
 *     因此房间会话的智能体从不调用模型，也不会以访客人设作答；聊天室记录仍是唯一的对话来源。
 *   - 标题经 sessionTitle.rename 设为「聊天室：<房间名>」，不产生对话回合；服务不可用时保持 DSH 默认标题。
 *   - 列表可见性：DSH 侧栏对 blank 会话（尚无 turn/start）默认隐藏（见 dsh-client-ui-workspace
 *     sessionVisible）。创建时用一条已关闭的空回合（turn/start + turn/end，无用户/助手消息）写入日志，
 *     清除 blank，会话立刻出现在左侧列表；对话界面不会出现可见消息。已有空房间在 resume 时同样补写。
 *   - 房间 ↔ 会话编号写在房间 meta.json 的 sessionId；重启后 resume 原会话，不重复创建。
 */
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ChatroomError } from './store.mjs'

export const ROOM_PRESET = 'guest'
export const NO_TOOLS_MESSAGE = '聊天室房间会话不提供任何工具。'
export const WORKSPACE_TITLE = '聊天室'

export function roomSessionTitle(room) {
  return `聊天室：${String(room?.title || '').trim() || '新房间'}`
}

/** 从一批 UserMessage 里取出用户写的文字（只取 role:user 的 text 块）。 */
export function userTextOf(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role && m.role !== 'user')) continue
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim())
  }
  return parts.join('\n\n').trim()
}

/**
 * 创建时写入的种子事件：一条已关闭的空回合，用于清除 sessionListMetadata.blank。
 * 不含 user/assistant/system 消息，对话界面无可见内容。
 */
export function listableSeed(now = Date.now()) {
  const time = Number.isSafeInteger(now) ? now : Date.now()
  return [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

const MISSING_RE = /not\s*found|missing|unknown session|no such|does not exist|ENOENT|不存在/i

function svc(ctx, name) {
  try { const v = ctx?.get?.(name); if (v != null) return v } catch {}
  try { return ctx?.[name] ?? null } catch { return null }
}

/**
 * @param {{ ctx: any, store: any, cwd: string, onUserText: (roomId: string, text: string) => any, logger?: any }} deps
 */
export function createRoomSessions({ ctx, store, cwd, onUserText, logger }) {
  const bySession = new Map() // sessionId → roomId
  const handles = new Map() // roomId → AgentHandle（本插件创建 / resume 的，卸载时 dispose）
  const pending = new Map() // roomId → Promise
  const offs = []
  let disposed = false
  const warn = (m, e) => { try { logger?.warn?.(`dsh-workbench chatroom: ${m}`, e?.message || e || '') } catch {} }

  function roomOf(sessionId) { return bySession.get(String(sessionId ?? '')) || null }

  function liveSession(sessionId) {
    try { return svc(ctx, 'sessions')?.get?.(sessionId) || svc(ctx, 'agents')?.get?.(sessionId)?.session || null } catch { return null }
  }

  /** 会话是否仍被侧栏视为 blank（无 turn/start → 非当前会话时不显示）。 */
  function isBlank(session) {
    if (!session) return true
    try {
      const meta = svc(ctx, 'sessionProjections')?.stateOf?.(session, 'sessionListMetadata')
      if (meta && typeof meta.blank === 'boolean') return meta.blank
    } catch {}
    try {
      const events = typeof session.events === 'function' ? session.events() : session.log
      if (Array.isArray(events) && events.some((e) => e?.type === 'turn/start')) return false
    } catch {}
    return Number(session.seq ?? 0) === 0
  }

  /**
   * 向已有会话补写一条已关闭的空回合，清除 blank。
   * 若智能体已在运行，补写后 dispose 再 resume，使 turnBoundary.lastTurn 与日志一致。
   */
  async function markListable(roomId, sessionId, agents) {
    const session = liveSession(sessionId)
    if (!session || typeof session.append !== 'function') return false
    if (!isBlank(session)) return false
    let lastTurn = 0
    try { lastTurn = Number(svc(ctx, 'sessionProjections')?.stateOf?.(session, 'turnBoundary')?.lastTurn) || 0 } catch {}
    const turn = lastTurn + 1
    try {
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (e) {
      warn('mark listable append failed', e)
      return false
    }
    const prev = handles.get(roomId)
    if (!prev || typeof agents?.resume !== 'function') return true
    try { await prev.dispose?.() } catch {}
    handles.delete(roomId)
    try {
      const comp = await composition().catch(() => ({ setup: undefined }))
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions(),
        ...(comp.setup ? { setup: comp.setup } : {}),
      })
      handles.set(roomId, handle)
    } catch (e) {
      warn('mark listable re-resume failed (blank cleared; agent may be cold)', e)
    }
    return true
  }

  /** 插件级闸门与步骤拦截：对所有智能体注册，只处理房间会话。 */
  function mount() {
    if (offs.length || !ctx) return
    try {
      const tools = ctx.tools || svc(ctx, 'tools')
      if (tools && typeof tools.guard === 'function') offs.push(tools.guard((exec) => (roomOf(exec?.agent?.id) ? NO_TOOLS_MESSAGE : undefined)))
    } catch (e) { warn('tools.guard failed', e) }
    try {
      if (typeof ctx.on === 'function') {
        offs.push(ctx.on('agent/pre-step', async (payload, next) => {
          const roomId = roomOf(payload?.agent?.id)
          if (!roomId) return next()
          const text = userTextOf(payload?.messages)
          if (text) {
            try { await onUserText(roomId, text) } catch (e) { warn('forward composer text failed', e) }
          }
          return { kind: 'reject' }
        }, { prepend: true }))
      }
    } catch (e) { warn('agent/pre-step hook failed', e) }
  }

  async function composition() {
    const presets = svc(ctx, 'agentPresets')
    if (!presets || typeof presets.resolve !== 'function') return { agentPreset: ROOM_PRESET, setup: undefined }
    let id
    try { id = (await presets.resolve(ROOM_PRESET))?.id } catch (e) { id = undefined }
    if (id !== ROOM_PRESET) throw new ChatroomError('未找到「访客模式」预设（guest），无法创建房间会话', 409)
    return { agentPreset: id, setup: async (agentCtx) => { if (typeof presets.mount === 'function') await presets.mount(agentCtx, id) } }
  }

  function agentOptions() {
    try {
      const sel = svc(ctx, 'agentDefaultModel')?.currentSelection?.()
      if (sel?.model) return { model: sel.model, ...(sel.provider ? { provider: sel.provider } : {}) }
    } catch {}
    return undefined
  }

  function retitleLive(sessionId, room) {
    try {
      const titles = svc(ctx, 'sessionTitle')
      const session = liveSession(sessionId)
      if (!titles || typeof titles.rename !== 'function' || !session) return false
      titles.rename(session, roomSessionTitle(room))
      return true
    } catch (e) { warn('session title rename failed', e); return false }
  }

  async function attachWorkspace(sessionId) {
    try {
      const registry = svc(ctx, 'workspaceRegistry')
      if (!registry || !cwd) return
      let ws = await registry.resolveByPath?.(cwd)?.catch?.(() => undefined)
      if (!ws && typeof registry.create === 'function') ws = await registry.create(cwd, WORKSPACE_TITLE)
      await ws?.attachSession?.(sessionId)
    } catch (e) { warn('workspace attach failed (session kept)', e) }
  }

  async function create(room, agents) {
    const comp = await composition()
    const sessionId = randomUUID()
    if (cwd) await mkdir(cwd, { recursive: true })
    const handle = await agents.create({
      sessionId,
      meta: { ...(cwd ? { cwd } : {}), agentPreset: comp.agentPreset },
      agentOptions: agentOptions(),
      seed: listableSeed(),
      ...(comp.setup ? { setup: comp.setup } : {}),
    })
    bySession.set(sessionId, room.id)
    handles.set(room.id, handle)
    await store.setRoomSession(room.id, sessionId)
    await attachWorkspace(sessionId)
    retitleLive(sessionId, room)
    // 种子写入失败时退回路上补写（极少见）。
    if (isBlank(liveSession(sessionId))) await markListable(room.id, sessionId, agents)
    return sessionId
  }

  async function ensureNow(roomId) {
    if (disposed) throw new ChatroomError('聊天室已卸载', 409)
    const room = await store.getRoom(roomId)
    const agents = svc(ctx, 'agents')
    if (!agents || typeof agents.create !== 'function') throw new ChatroomError('DSH 智能体服务不可用，无法创建房间会话', 503)
    const sid = room.sessionId ? String(room.sessionId) : ''
    if (!sid) return { sessionId: await create(room, agents), created: true }
    bySession.set(sid, room.id)
    if (handles.has(room.id)) {
      retitleLive(sid, room)
      const marked = await markListable(room.id, sid, agents)
      return { sessionId: sid, created: false, ...(marked ? { listable: true } : {}) }
    }
    // 他方已挂起该会话时不要在其 live agent 上补写回合（会与其内存中的 lastTurn 错位）。
    if (agents.get?.(sid)) {
      retitleLive(sid, room)
      return { sessionId: sid, created: false }
    }
    try {
      const comp = await composition().catch(() => ({ setup: undefined }))
      const handle = await agents.resume({ resumeSessionId: sid, agentOptions: agentOptions(), ...(comp.setup ? { setup: comp.setup } : {}) })
      handles.set(room.id, handle)
      retitleLive(sid, room)
      const marked = await markListable(room.id, sid, agents)
      return { sessionId: sid, created: false, resumed: true, ...(marked ? { listable: true } : {}) }
    } catch (e) {
      if (agents.get?.(sid)) {
        retitleLive(sid, room)
        const marked = await markListable(room.id, sid, agents)
        return { sessionId: sid, created: false, ...(marked ? { listable: true } : {}) }
      }
      if (!MISSING_RE.test(String(e?.message || e))) throw new ChatroomError('恢复房间会话失败：' + String(e?.message || e), 502)
      // 原会话已被删除：重新创建并改写映射（旧编号不再指向任何房间）。
      bySession.delete(sid)
      return { sessionId: await create(room, agents), created: true, replaced: sid }
    }
  }

  function ensure(roomId) {
    const hit = pending.get(roomId)
    if (hit) return hit
    const p = ensureNow(roomId).finally(() => pending.delete(roomId))
    pending.set(roomId, p)
    return p
  }

  /** 登记全部映射并挂上闸门（总是执行，聊天室关闭时房间会话同样不作答）；resume 为真时逐个恢复已有的房间会话。各只执行一次。 */
  let loaded = null
  let resumed = null
  function load() {
    mount()
    if (!loaded) loaded = (async () => {
      let rooms = []
      try { rooms = await store.listRooms() } catch { rooms = [] }
      for (const r of rooms) if (r.sessionId) bySession.set(String(r.sessionId), r.id)
      return rooms
    })()
    return loaded
  }
  function start({ resume = true } = {}) {
    const l = load()
    if (!resume) return l
    if (!resumed) resumed = l.then(async (rooms) => {
      for (const r of rooms) {
        if (!r.sessionId || disposed) continue
        try { await ensure(r.id) } catch (e) { warn(`resume room session ${r.id} failed`, e) }
      }
    })
    return resumed
  }

  async function retitle(roomId) {
    try { const room = await store.getRoom(roomId); if (room.sessionId) retitleLive(String(room.sessionId), room) } catch {}
  }

  function list() {
    const out = {}
    for (const [sid, roomId] of bySession) out[sid] = roomId
    return out
  }

  async function dispose() {
    disposed = true
    for (const off of offs.splice(0)) { try { off?.() } catch {} }
    const hs = [...handles.values()]
    handles.clear()
    for (const h of hs) { try { await h?.dispose?.() } catch {} }
    bySession.clear()
  }

  return { mount, load, start, ensure, retitle, roomOf, list, dispose, isBlank, markListable, listableSeed }
}
