/**
 * 控制会话挂在工作台：侧栏里单独一条转录，不走 GameBot 大脑，也不进聊天室心跳。
 */
import { randomUUID } from 'node:crypto'

export const CONTROL_PRESET = 'guest'

export function controlTitle(name) {
  return `Minecraft 控制：${String(name || '').trim() || 'NPC'}`
}

export async function ensureControlSession({ agents, presets, titles, memberId, name, remembered, sessions }) {
  if (!agents || typeof agents.create !== 'function') return { sessionId: null, reason: 'no-agents' }
  try {
    const resolved = await presets?.resolve?.(CONTROL_PRESET)
    if (resolved && resolved.id !== CONTROL_PRESET) return { sessionId: null, reason: 'no-guest' }
  } catch {
    return { sessionId: null, reason: 'no-guest' }
  }
  const existing = remembered?.[memberId]
  if (existing) {
    try {
      const handle = agents.get?.(existing) || (typeof agents.resume === 'function' ? await agents.resume({ resumeSessionId: existing }) : null)
      const session = handle?.session || agents.get?.(existing)?.session
      if (session || handle) {
        try { titles?.rename?.(session, controlTitle(name)) } catch { /* 标题服务不可用时会话仍可作转录 */ }
        sessions?.add(existing)
        return { sessionId: existing, created: false, handle }
      }
    } catch {
      /* 旧会话恢复失败时另开一条，旧回合的动作已经因代际失效 */
    }
  }
  const sessionId = randomUUID()
  const now = Date.now()
  const handle = await agents.create({
    sessionId,
    meta: { agentPreset: CONTROL_PRESET, mcControl: memberId },
    seed: [
      { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: now, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  sessions?.add(sessionId)
  try { titles?.rename?.(handle?.session, controlTitle(name)) } catch { /* 同上 */ }
  return { sessionId, created: true, handle }
}

/** agents.get / resume 可能直接返回 session，也可能包在 { session } 里。 */
export function resolveControlSession(handle) {
  if (!handle) return null
  if (typeof handle.append === 'function') return handle
  if (typeof handle.session?.append === 'function') return handle.session
  return null
}

export function writeControlTurn(session, text) {
  if (!session || typeof session.append !== 'function') return false
  const turn = (Number(session._mcTurn) || 1) + 1
  session._mcTurn = turn
  const time = Date.now()
  session.append('turn/start', { turn, time })
  session.append('user/message', {
    role: 'user',
    id: randomUUID(),
    time,
    content: [{ type: 'text', text: String(text || '').slice(0, 2000) }],
  })
  session.append('turn/end', { turn, time, reason: { kind: 'completed' } })
  return true
}

export function mountControlGuards(ctx, sessionIds) {
  const offs = []
  try {
    const tools = ctx?.tools || ctx?.get?.('tools')
    if (tools && typeof tools.guard === 'function') {
      offs.push(tools.guard((exec) => (sessionIds.has(exec?.agent?.id) ? 'Minecraft 控制会话不从输入框驱动世界。' : undefined)))
    }
  } catch { /* 宿主没有工具闸门时，唤醒环仍是唯一驱动 */ }
  try {
    if (typeof ctx?.on === 'function') {
      offs.push(ctx.on('agent/pre-step', (payload, next) => {
        if (!sessionIds.has(payload?.agent?.id)) return next()
        return { kind: 'reject' }
      }, { prepend: true }))
    }
  } catch { /* 同上 */ }
  return () => {
    for (const off of offs) {
      try { off?.() } catch { /* 卸载时忽略 */ }
    }
  }
}
