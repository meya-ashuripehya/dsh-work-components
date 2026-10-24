import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 聊天室心跳（MVP）：回合结束（done / ended）后，经 DSH Host Schedule
 * schedule.create(sessionId, { title, prompt, after_seconds }) 向所选会话投递一次提醒；
 * 新一轮开始（run running:true）时 delete + 取消。相对 after 不可 update，刷新一律 delete+create。宿主 create 非 Remote，插件须 inject schedule。
 * 默认关闭；目标会话由设置 chatroomHeartbeatSessionId 指定（侧栏普通智能体会话，勿用「聊天室：…」房间会话）。
 */
export const HEARTBEAT_TITLE = '聊天室心跳'
export const DEFAULT_INTERVAL_MIN = 30
export const MIN_INTERVAL_MIN = 1
export const MAX_INTERVAL_MIN = 1440
/**
 * 到期后写入目标会话的提醒正文。
 * DSH Schedule 要求 prompt trim 后非空且无首尾空白（空串会 invalid_prompt），
 * 故用零宽空格 U+200B 作为「无可读/无指导内容」的最小合法值；不向被唤醒会话投递说明文。
 */
export const HEARTBEAT_PROMPT_EMPTY = '\u200b'
/** @deprecated 已改为空正文；保留导出以免旧引用断裂。 */
export const HEARTBEAT_PROMPT_HEAD = HEARTBEAT_PROMPT_EMPTY
export const ARM_REASONS = new Set(['done', 'ended'])

/** DSH 主目录（可用 DSH_HOME 覆盖，便于测试）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 是否不宜作为心跳目标的临时会话编号（如定时任务执行实例）。 */
export function isUnsuitableSessionId(id) {
  const s = String(id || '')
  return !s || s.startsWith('cron-exec-')
}

/**
 * 从会话投影读取可读标题。正式标题在独立投影键 `title`（非 sessionListMetadata）。
 * @param {any} proj
 * @param {any} session
 */
export function titleFromSessionMeta(proj, session) {
  // 正式标题在独立投影键 title；sessionListMetadata 仅含 blank/lastPromptAt，不含标题。
  try {
    if (proj && typeof proj.stateOf === 'function') {
      const t = proj.stateOf(session, 'title')
      if (typeof t === 'string') return t.trim()
      if (t == null) {
        /* 投影已给出空标题，不再误读 sessionListMetadata */
      } else if (typeof t === 'object' && t !== null) {
        if (typeof t.title === 'string' && t.title.trim()) return t.title.trim()
        if (typeof t.name === 'string' && t.name.trim()) return t.name.trim()
      }
    }
  } catch {}
  try {
    if (typeof session?.title === 'string' && session.title.trim()) return session.title.trim()
    if (typeof session?.name === 'string' && session.name.trim()) return session.name.trim()
  } catch {}
  return ''
}

/** @param {any} proj @param {any} session */
export function isBlankSession(proj, session) {
  try {
    return proj?.stateOf?.(session, 'sessionListMetadata')?.blank === true
  } catch {
    return false
  }
}

/**
 * 读取本机 session_projcache 中的会话标题（与侧栏同源元数据）。
 * 跳过空白会话与 cron-exec 临时实例；无标题的冷会话不进入列表。
 * @param {string} [home]
 * @returns {{ id: string, title: string, chatroom: boolean }[]}
 */
export function listSessionsFromProjCache(home = dshHome()) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return []
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (isUnsuitableSessionId(id)) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const rows = raw?.record?.rows || {}
      if (rows?.sessionListMetadata?.val?.blank === true) continue
      const title = String(rows?.title?.val ?? rows?.name?.val ?? '').trim()
      if (!title) continue
      out.push({ id, title, chatroom: title.startsWith('聊天室：') })
    } catch {}
  }
  return out
}

function sortSessionOptions(list) {
  return list.slice().sort((a, b) => {
    const byTitle = String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
    if (byTitle) return byTitle
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
}

function svc(ctx, name) {
  try { const v = ctx?.get?.(name); if (v != null) return v } catch {}
  try { return ctx?.[name] ?? null } catch { return null }
}

/** @param {any} cfg */
export function heartbeatSettings(cfg = {}) {
  const n = Number(cfg.chatroomHeartbeatIntervalMin)
  const intervalMin = Number.isFinite(n) && n >= MIN_INTERVAL_MIN
    ? Math.min(MAX_INTERVAL_MIN, Math.round(n))
    : DEFAULT_INTERVAL_MIN
  return {
    enabled: cfg.chatroomHeartbeatEnabled === true,
    intervalMin,
    sessionId: String(cfg.chatroomHeartbeatSessionId || '').trim(),
  }
}

export function afterSecondsFromMinutes(intervalMin) {
  const m = Number(intervalMin)
  const mins = Number.isFinite(m) && m >= MIN_INTERVAL_MIN ? Math.min(MAX_INTERVAL_MIN, Math.round(m)) : DEFAULT_INTERVAL_MIN
  return Math.max(1, mins * 60)
}

/**
 * 日程提醒正文：无可读内容（见 HEARTBEAT_PROMPT_EMPTY）。
 * @param {{ roomId?: string, reason?: string, roomTitle?: string, intervalMin?: number }} [_info]
 */
export function buildHeartbeatPrompt(_info = {}) {
  return HEARTBEAT_PROMPT_EMPTY
}

/**
 * @param {{ ctx: any, getConfig: () => any, logger?: any, getRoomTitle?: (roomId: string) => any }} deps
 */
export function createHeartbeat({ ctx, getConfig, logger, getRoomTitle } = {}) {
  /** @type {{ sessionId: string, id: string, roomId: string, after_seconds: number, at: number } | null} */
  let pending = null
  /** @type {{ at: number, roomId?: string, reason?: string, ok: boolean, skipped?: string, error?: string, id?: string, sessionId?: string, after_seconds?: number } | null} */
  let lastAttempt = null
  let chain = Promise.resolve()
  const warn = (m, e) => { try { logger?.warn?.('dsh-workbench chatroom heartbeat: ' + m, e?.message || e || '') } catch {} }

  function noteAttempt(rec) {
    lastAttempt = { at: Date.now(), ...rec }
    return lastAttempt
  }

  function enqueue(fn) {
    chain = chain.then(fn, fn).catch((e) => warn('async', e))
    return chain
  }

  function scheduleApi() { return svc(ctx, 'schedule') }

  async function disarm() {
    const cur = pending
    pending = null
    if (!cur?.id || !cur?.sessionId) return { ok: true, deleted: false }
    const api = scheduleApi()
    if (!api || typeof api.delete !== 'function') return { ok: false, error: 'schedule 服务不可用' }
    try {
      const r = await api.delete({ sessionId: cur.sessionId, id: cur.id })
      return { ok: true, deleted: r?.deleted === true, id: cur.id }
    } catch (e) {
      warn('delete failed', e)
      return { ok: false, error: String(e?.message || e), id: cur.id }
    }
  }

  /**
   * @param {string} roomId
   * @param {string} reason
   */
  async function arm(roomId, reason) {
    const st = heartbeatSettings(typeof getConfig === 'function' ? getConfig() : {})
    if (!st.enabled) {
      warn('arm skipped: disabled')
      return noteAttempt({ ok: false, skipped: 'disabled', roomId: String(roomId || ''), reason: String(reason || '') })
    }
    if (!st.sessionId) {
      warn('arm skipped: no-session')
      return noteAttempt({ ok: false, skipped: 'no-session', roomId: String(roomId || ''), reason: String(reason || '') })
    }
    if (!ARM_REASONS.has(String(reason || ''))) {
      warn('arm skipped: reason=' + String(reason || ''))
      return noteAttempt({ ok: false, skipped: 'reason', roomId: String(roomId || ''), reason: String(reason || '') })
    }
    const api = scheduleApi()
    // Host ScheduleService.create 未挂 Remote；若未 inject schedule，ctx.get('schedule') 可能为空或仅有 list/delete 代理。
    if (!api || typeof api.create !== 'function') {
      const kind = !api ? 'missing' : 'no-create'
      warn('arm failed: schedule 服务不可用 (' + kind + ')；请确认插件 inject 含 schedule，并重新加载 DSH')
      return noteAttempt({ ok: false, error: 'schedule 服务不可用', roomId: String(roomId || ''), reason: String(reason || ''), sessionId: st.sessionId })
    }

    await disarm()

    let roomTitle = ''
    try {
      const t = typeof getRoomTitle === 'function' ? await getRoomTitle(roomId) : ''
      roomTitle = String(t || '').trim()
    } catch {}

    const after_seconds = afterSecondsFromMinutes(st.intervalMin)
    const title = HEARTBEAT_TITLE
    const prompt = buildHeartbeatPrompt({ roomId, roomTitle, reason, intervalMin: st.intervalMin })
    try {
      const rec = await api.create(st.sessionId, { title, prompt, after_seconds })
      const id = String(rec?.id || '')
      if (!id) {
        warn('arm failed: create 未返回编号')
        return noteAttempt({ ok: false, error: 'create 未返回编号', roomId: String(roomId || ''), reason: String(reason || ''), sessionId: st.sessionId })
      }
      pending = { sessionId: st.sessionId, id, roomId: String(roomId || ''), after_seconds, at: Date.now() }
      return noteAttempt({ ok: true, id, sessionId: st.sessionId, after_seconds, roomId: String(roomId || ''), reason: String(reason || '') })
    } catch (e) {
      warn('create failed', e)
      return noteAttempt({ ok: false, error: String(e?.message || e), roomId: String(roomId || ''), reason: String(reason || ''), sessionId: st.sessionId })
    }
  }

  /** 挂到聊天室 emit：run 开始取消；run 结束且 reason 为 done/ended 时武装。 */
  function onRunEvent(roomId, event) {
    if (!event || event.type !== 'run') return
    if (event.running === true) {
      void enqueue(() => disarm())
      return
    }
    if (event.running === false) {
      void enqueue(() => arm(roomId, event.reason))
    }
  }

  /** 当前进程内已武装的一次提醒（宿主持久化；本字段仅便于面板展示）。 */
  function status() {
    return pending ? { ...pending } : null
  }

  /** 最近一次 arm 结果（含 skipped/error；便于排查「回合结束却无后台任务」）。 */
  function lastArm() {
    return lastAttempt ? { ...lastAttempt } : null
  }

  /**
   * 列举可供心跳选用的 DSH 会话（含冷会话）：本机 session_projcache 元数据标题 + 当前已加载会话投影。
   * 标题取自投影键 title（及缓存 rows.title/name），不以原始编号顶替可读名。
   * 标题以「聊天室：」开头的房间会话标记 chatroom:true（不宜作心跳目标）；空白与 cron-exec 实例排除。
   * @returns {Promise<{ id: string, title: string, chatroom: boolean }[]>}
   */
  async function listSessions() {
    /** @type {Map<string, { id: string, title: string, chatroom: boolean }>} */
    const byId = new Map()
    for (const s of listSessionsFromProjCache()) byId.set(s.id, s)

    const sessions = svc(ctx, 'sessions')
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    const proj = svc(ctx, 'sessionProjections')
    for (const s of Array.isArray(list) ? list : []) {
      const id = String(s?.id || '')
      if (isUnsuitableSessionId(id)) continue
      if (isBlankSession(proj, s)) continue
      let title = titleFromSessionMeta(proj, s)
      if (!title && byId.has(id)) title = byId.get(id).title
      const label = title || id
      byId.set(id, { id, title: label, chatroom: label.startsWith('聊天室：') })
    }
    return sortSessionOptions([...byId.values()])
  }

  async function dispose() {
    await enqueue(() => disarm())
  }

  return {
    onRunEvent,
    arm,
    disarm,
    status,
    lastArm,
    listSessions,
    dispose,
    settings: () => heartbeatSettings(typeof getConfig === 'function' ? getConfig() : {}),
  }
}
