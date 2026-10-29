/**
 * 每个已连接座位一个 Minecraft 控制会话。
 * 空闲 15 秒后唤醒一次；唤醒轮自己的观察、发言和回流不重新计时。
 * 聊天室心跳和 end_round 不读、不写这里的计时。
 * 寻路与占格落地之前，本会话只能 say。
 * 每席回复队列见 mc-public-channel.mjs 的 createSeatQueues（本文件只提供单席 deadline / disarm）。
 */
import { randomUUID } from 'node:crypto'

export const IDLE_MS = 15000
export const SAY_TOOL = {
  name: 'say',
  description: 'Speak in the Minecraft chat box. audience defaults to public. private requires target. emote is chat text only.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say.' },
      audience: { type: 'string', description: 'public or private. Defaults to public.' },
      target: { type: 'string', description: 'Online player name. Required when audience is private.' },
      emote: { type: 'string', description: 'Short action text shown in the chat line. Not a world action.' },
    },
    required: ['text'],
  },
}

export function controlSystemPrompt(presence, persona, focus) {
  const lines = [
    '你是这个席位的 Minecraft 控制会话。只有本会话驱动这个 NPC。',
    '寻路和占格还没就绪：你只能用 say 说话，不能移动、挖掘、放置或攻击。',
    'say 的 audience 默认 public。private 必须带 target（在线玩家名）。emote 只写进聊天框，不是世界动作。',
    '本席只有一条回复队列：公屏与私聊挨个处理，同一回合只回应队首，不要混进其他聊天意图。',
    '观察里的公屏全文和本席私聊只作上下文；可执行焦点是队首那一条。',
  ]
  if (focus?.id) {
    const audience = focus.audience || 'public'
    const speaker = focus.speaker || '(unknown)'
    const text = String(focus.text || '').slice(0, 500)
    lines.push(`本回合队首：audience=${audience}，发言者=${speaker}，内容=${text}`)
    if (audience === 'private' && focus.target) {
      lines.push(`私聊目标提示：${focus.target}`)
    }
    // 玩家聊天（公/私）必须实质回复，禁止学观察里其他席的「保持安静 / 不主动发言」。
    if (focus.kind === 'bystander' || audience === 'private') {
      lines.push('队首是玩家发来的聊天：本回合必须用 say 给出一句实质回复（回答问题或接话），不要保持安静，不要说「没有待回复」「空闲唤醒」。')
    }
  } else {
    lines.push('当前没有待回复的聊天队首（连接/空闲唤醒）：可观察与按设计行动（移动/环顾/表情等）；聊天默认不发言（不要用 say），禁止对公屏说「没有待回复」「空闲唤醒」「保持安静」等元话语，不要编造要回复的对象。')
  }
  const extra = String(persona || '').trim()
  if (extra) lines.push(extra)
  if (presence?.lines?.length) lines.push(presence.lines.join('\n'))
  return lines.join('\n')
}
function blank(id) {
  return {
    id,
    connected: false,
    generation: 0,
    owner: 'control',
    busy: false,
    deadline: null,
    seen: new Set(),
    self: new Set(),
    abort: null,
  }
}

/** 执行一轮决定。非 say 的工具调用被丢掉，不会发到游戏。 */
export async function applyDecision(decision, ctx) {
  const calls = Array.isArray(decision?.toolCalls) ? decision.toolCalls : []
  const rejected = []
  const spoken = []
  let used = false
  const speak = async (params) => {
    if (!ctx.current()) return { stale: true, spoken, rejected }
    const sayId = randomUUID()
    ctx.markSelf(sayId)
    const result = await ctx.act({ ...params, say_id: sayId })
    if (!ctx.current()) return { stale: true, spoken, rejected, dropped: result }
    spoken.push(result)
    return null
  }
  for (const call of calls) {
    const name = String(call?.name || '')
    if (name !== 'say' || used) {
      rejected.push(name || '(empty)')
      continue
    }
    used = true
    const params = call?.arguments && typeof call.arguments === 'object' ? { ...call.arguments } : {}
    delete params.say_id
    delete params.agent_id
    delete params.member_id
    const stopped = await speak(params)
    if (stopped) return stopped
  }
  const text = String(decision?.text || '').trim()
  if (!used && text) {
    const stopped = await speak({ text, audience: 'public' })
    if (stopped) return stopped
  }
  return { stale: false, spoken, rejected }
}

export function createMcControl({ now = Date.now, runTurn } = {}) {
  const seats = new Map()

  function seatOf(memberId) {
    const id = String(memberId || '').trim()
    let seat = seats.get(id)
    if (!seat) {
      seat = blank(id)
      seats.set(id, seat)
    }
    return seat
  }

  function remember(seat, id) {
    if (!id || seat.seen.has(id)) return false
    seat.seen.add(id)
    if (seat.seen.size > 500) {
      seat.seen.clear()
      for (const self of seat.self) seat.seen.add(self)
      seat.seen.add(id)
    }
    return true
  }

  return {
    connect(memberId) {
      const seat = seatOf(memberId)
      seat.abort?.abort()
      seat.connected = true
      seat.generation += 1
      seat.owner = 'control'
      seat.busy = false
      seat.deadline = null
      seat.seen = new Set()
      seat.self = new Set()
      seat.abort = null
      this.note(memberId, { id: `connect:${seat.generation}`, self: false })
      return { ok: true, generation: seat.generation, owner: seat.owner }
    },
    disconnect(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat) return { ok: true }
      seat.abort?.abort()
      seat.connected = false
      seat.generation += 1
      seat.busy = false
      seat.deadline = null
      seat.abort = null
      seat.self = new Set()
      return { ok: true, generation: seat.generation }
    },
    takeover(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat?.connected) return { ok: false, error: 'NPC 还没连接' }
      seat.abort?.abort()
      seat.owner = 'manual'
      seat.busy = false
      seat.deadline = null
      seat.abort = null
      return { ok: true, owner: 'manual', hint: '你现在可以自己用 mc_act。做完后调用 mc_resume，控制会话会重新接管。' }
    },
    resume(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat?.connected) return { ok: false, error: 'NPC 还没连接' }
      seat.abort?.abort()
      seat.owner = 'control'
      seat.busy = false
      seat.abort = null
      seat.generation += 1
      this.note(memberId, { id: `resume:${seat.generation}`, self: false })
      return { ok: true, owner: 'control', generation: seat.generation }
    },
    blocksMember(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      return !!(seat?.connected && seat.owner === 'control')
    },
    /**
     * 外部事件武装空闲计时。
     * delayMs 默认 IDLE_MS；公屏通道换下一位时可传 0，下一 tick 即醒，避免 N×15s。
     */
    note(memberId, event, { delayMs = IDLE_MS } = {}) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat?.connected || seat.owner !== 'control') return false
      const id = String(event?.id || '')
      if (!id || event?.self || seat.self.has(id)) return false
      if (!remember(seat, id)) return false
      const wait = Number.isFinite(delayMs) ? Math.max(0, Number(delayMs)) : IDLE_MS
      seat.deadline = now() + wait
      return true
    },
    /** 清掉尚未到期的空闲武装（不打断 busy 回合）。 */
    disarm(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat || seat.busy) return false
      seat.deadline = null
      return true
    },
    disarmAllExcept(keepId) {
      const keep = String(keepId || '').trim()
      for (const [id, seat] of seats) {
        if (id === keep || seat.busy) continue
        seat.deadline = null
      }
    },
    markSelf(memberId, id) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat || !id) return
      seat.self.add(String(id))
    },
    tick(at = now()) {
      for (const [memberId, seat] of seats) {
        if (!seat.connected || seat.owner !== 'control' || seat.busy || seat.deadline == null) continue
        if (at < seat.deadline) continue
        seat.deadline = null
        seat.busy = true
        const generation = seat.generation
        const abort = new AbortController()
        seat.abort = abort
        const current = () => seat.connected && seat.generation === generation && !abort.signal.aborted
        Promise.resolve(runTurn?.({
          memberId,
          generation,
          signal: abort.signal,
          current,
          markSelf: (id) => { if (id) seat.self.add(String(id)) },
        })).catch(() => {}).finally(() => {
          if (seat.generation !== generation) return
          seat.busy = false
          if (seat.abort === abort) seat.abort = null
        })
      }
    },
    stopAll() {
      for (const id of [...seats.keys()]) this.disconnect(id)
    },
    connectedIds() {
      return [...seats.entries()].filter(([, seat]) => seat.connected).map(([id]) => id)
    },
    view(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat) return null
      return {
        connected: seat.connected,
        generation: seat.generation,
        owner: seat.owner,
        busy: seat.busy,
        deadline: seat.deadline,
      }
    },
  }
}
