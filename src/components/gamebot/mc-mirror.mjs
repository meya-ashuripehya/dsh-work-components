/**
 * 把已确认的公聊，以及带冷却的路人聊天，写进绑定房间。
 * 去重看消息身份，不看正文。私聊不进房间。
 * 不打开成员会话的 MC_CHAT_FORWARD。
 */
export const MIRROR_COOLDOWN_MS = 3000

/** Drop leading <RoleName> the game/mod stamps; chatroom already has speaker. */
export function stripRolePrefix(text) {
  return String(text || '').replace(/^\uFEFF?(?:\s*<[^>\n]+>\s*)+/, '')
}

function inner(event) {

  if (event?.data?.data && typeof event.data.data === 'object') return event.data.data
  if (event?.data && typeof event.data === 'object' && (event.data.message || event.data.say_id || event.data.source)) return event.data
  return event && typeof event === 'object' ? event : {}
}

export function chatIdentity(event) {
  const data = inner(event)
  const say = data.say_id || data.message_id
  if (say) return String(say)
  const seq = event?.data?.sequence ?? event?.sequence
  if (data.source === 'player' && seq != null) return `player:${seq}`
  return ''
}

export function classifyChat(event) {
  const data = inner(event)
  const id = chatIdentity(event)
  if (!id) return null
  const audience = String(data.audience || 'public')
  const raw = String(data.message || data.sent || '')
  const player = String(data.player || data.username || '')
  const target = String(data.target || '')
  if (data.say_id || data.source === 'agent') {
    return {
      id,
      kind: 'say',
      audience,
      text: stripRolePrefix(raw),
      player,
      memberId: String(data.agent_id || player || ''),
      name: player,
      target,
    }
  }
  if (data.source === 'player') {
    return {
      id,
      kind: 'bystander',
      audience: audience === 'private' ? 'private' : 'public',
      text: stripRolePrefix(raw),
      player,
      name: player,
      target,
      memberId: '',
    }
  }
  return null
}
export function createMirror({ cooldownMs = MIRROR_COOLDOWN_MS, now = Date.now, append } = {}) {
  const seen = new Set()
  let lastBystander = null

  async function take(item) {
    if (!item?.id) return { mirrored: false, reason: 'no-id' }
    if (seen.has(item.id)) return { mirrored: false, reason: 'seen' }
    if (item.audience === 'private') {
      seen.add(item.id)
      return { mirrored: false, reason: 'private' }
    }
    if (item.kind === 'bystander') {
      seen.add(item.id)
      const at = now()
      if (lastBystander != null && at - lastBystander < cooldownMs) return { mirrored: false, reason: 'cooldown' }
      lastBystander = at
      await append?.(item)
      return { mirrored: true, reason: 'bystander' }
    }
    seen.add(item.id)
    await append?.(item)
    return { mirrored: true, reason: 'say' }
  }

  return {
    take,
    async fromAction(memberId, result, name) {
      if (!result?.ok) return { mirrored: false, reason: 'unconfirmed' }
      const extras = result.extras || {}
      const id = String(extras.message_id || extras.say_id || '')
      return take({
        id,
        kind: 'say',
        audience: String(extras.audience || 'public'),
        text: stripRolePrefix(result.sent || ''),
        memberId,
        name: name || memberId,
        player: name || memberId,
      })
    },
    consider(event) {
      const item = classifyChat(event)
      if (!item) return Promise.resolve({ mirrored: false, reason: 'ignore' })
      return take(item)
    },
  }
}
