/**
 * 聊天室入站接收者选择：默认主接收（ingest）；显式 @ / 回复成员 bot 时临时切换。
 * 纯函数，两边各自独立判断，不靠 getUpdates 先后。
 */

/** Telegram 实体 offset/length 按 UTF-16 代码单元计。 */
export function utf16Slice(text, offset, length) {
  const s = String(text || '')
  const chars = Array.from(s)
  // entities 用 UTF-16 下标；先转成代码单元数组再切片
  const units = []
  for (const ch of chars) {
    const code = ch.codePointAt(0)
    if (code > 0xffff) {
      const adj = code - 0x10000
      units.push(String.fromCharCode(0xd800 + (adj >> 10)), String.fromCharCode(0xdc00 + (adj & 0x3ff)))
    } else units.push(ch)
  }
  return units.slice(offset, offset + length).join('')
}

/**
 * @param {{ id: string, telegram?: { ingest?: boolean, username?: string }, enabled?: boolean }[]} seats
 * @param {{ id?: number, botId?: number, username?: string }[]} [botMeta] seatId → bot 身份（可选，并入 seats）
 */
export function seatBotIndex(seats, clientsBySeat = {}) {
  const byId = new Map() // botId number → seat
  const byUser = new Map() // username lower → seat
  let primary = null
  for (const s of seats || []) {
    if (!s || s.enabled === false) continue
    if (s.telegram?.ingest) primary = s
    const c = clientsBySeat[s.id]
    const botId = Number(c?.botId || c?.id || 0) || 0
    const username = String(c?.username || s.telegram?.username || '').replace(/^@/, '').toLowerCase()
    if (botId) byId.set(botId, s)
    if (username) byUser.set(username, s)
  }
  if (!primary) primary = (seats || []).find((s) => s?.enabled !== false && s?.telegram?.ingest) || null
  return { primary, byId, byUser }
}

function entitiesOf(message) {
  const list = []
  if (Array.isArray(message?.entities)) list.push(...message.entities.map((e) => ({ ...e, source: 'text' })))
  if (Array.isArray(message?.caption_entities)) list.push(...message.caption_entities.map((e) => ({ ...e, source: 'caption' })))
  return list.sort((a, b) => (a.offset || 0) - (b.offset || 0))
}

/**
 * 从 entities 里找出第一个命中本房间成员的 @。
 * @returns {{ seat: object, via: 'mention'|'text_mention'|'bot_command', label: string } | null}
 */
export function firstMentionedSeat(message, index) {
  const text = message?.text || message?.caption || ''
  for (const e of entitiesOf(message)) {
    if (e.type === 'mention') {
      const raw = utf16Slice(text, e.offset || 0, e.length || 0)
      const u = raw.replace(/^@/, '').toLowerCase()
      const seat = index.byUser.get(u)
      if (seat) return { seat, via: 'mention', label: u }
    } else if (e.type === 'text_mention') {
      const id = Number(e.user?.id || 0)
      const seat = id ? index.byId.get(id) : null
      if (seat) return { seat, via: 'text_mention', label: String(e.user?.username || id) }
    } else if (e.type === 'bot_command') {
      const raw = utf16Slice(text, e.offset || 0, e.length || 0)
      const m = /^\/\w+@([A-Za-z0-9_]+)/.exec(raw)
      if (m) {
        const u = m[1].toLowerCase()
        const seat = index.byUser.get(u)
        if (seat) return { seat, via: 'bot_command', label: u }
      }
    }
  }
  return null
}

/** 回复某成员 bot 的消息 → 当作 @ 了它。 */
export function replyTargetSeat(message, index) {
  const from = message?.reply_to_message?.from
  if (!from?.is_bot) return null
  const id = Number(from.id || 0)
  let seat = id ? index.byId.get(id) : null
  if (!seat && from.username) seat = index.byUser.get(String(from.username).toLowerCase()) || null
  if (!seat) return null
  return { seat, via: 'reply', label: String(from.username || id) }
}

/**
 * 这条消息应由哪个成员接收。
 * @returns {{ seat: object|null, via: string, label: string, switchRequested: boolean }}
 */
export function receiverFor(message, seats, clientsBySeat = {}) {
  const index = seatBotIndex(seats, clientsBySeat)
  const mentioned = firstMentionedSeat(message, index)
  if (mentioned) return { ...mentioned, switchRequested: true }
  const replied = replyTargetSeat(message, index)
  if (replied) return { ...replied, switchRequested: true }
  return { seat: index.primary, via: 'primary', label: index.primary?.id || '', switchRequested: false }
}

/** 进程内小去重：只防重连重复，不负责选接收者。 */
export function createDedupe({ ttlMs = 10 * 60 * 1000, max = 2000 } = {}) {
  const map = new Map()
  function seen(chatId, messageId, editDate) {
    const key = `${chatId}:${messageId}:${editDate || 0}`
    const now = Date.now()
    if (map.has(key)) return true
    map.set(key, now)
    if (map.size > max) {
      for (const [k, t] of map) {
        if (now - t > ttlMs || map.size > max) map.delete(k)
        else break
      }
    }
    return false
  }
  return { seen, clear: () => map.clear() }
}

export function notInGroupNotice(label) {
  const name = String(label || '').replace(/^@/, '')
  return `无法将接收切换到 @${name}：该机器人不在本群`
}

/** 被 @ 成员的机器人当前没法用（未保存令牌 / 令牌读不到 / 它的轮询已停止）。和「不在本群」区分开。 */
export function botNotRunningNotice(label, reason = '') {
  const name = String(label || '').replace(/^@/, '')
  return `无法将接收切换到 @${name}：该成员的机器人未启动（${String(reason || '未保存令牌或令牌不可用')}）`
}

/** ChatMember → 'member' | 'absent' | 'unknown' */
export function memberStateOf(m) {
  const st = m?.status || m
  if (st === 'member' || st === 'administrator' || st === 'creator') return 'member'
  if (st === 'restricted') return m?.is_member === false ? 'absent' : 'member'
  if (st === 'left' || st === 'kicked') return 'absent'
  return 'unknown'
}

/**
 * getChatMember 结果缓存：key = chatId:botId → { state, at }。
 * 只缓存确定结果（在群 / 不在群）；查询出错（网络、PARTICIPANT_ID_INVALID 等）不缓存，也不当作「不在群」。
 * fetchers：一个或一组 (chatId, botId) => ChatMember，按顺序尝试，前一个出错才试下一个。
 * 注意：Bot API 下机器人一般查不到「别的机器人」（超级群里报 PARTICIPANT_ID_INVALID），所以应先用目标机器人自己的令牌查它自己。
 */
export function createMemberCache({ ttlMs = 60_000 } = {}) {
  const map = new Map()
  /** @returns {Promise<{ state: 'member'|'absent'|'error', error?: string, cached?: boolean }>} */
  async function check(chatId, botId, fetchers) {
    const key = `${chatId}:${botId}`
    const hit = map.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return { state: hit.state, cached: true }
    const list = (Array.isArray(fetchers) ? fetchers : [fetchers]).filter((f) => typeof f === 'function')
    const errors = []
    for (const f of list) {
      try {
        const state = memberStateOf(await f(chatId, botId))
        if (state === 'unknown') { errors.push('未知的成员状态'); continue }
        map.set(key, { state, at: Date.now() })
        return { state }
      } catch (e) {
        errors.push(String(e?.message || e))
      }
    }
    return { state: 'error', error: errors.join('；') || '无法查询成员状态' }
  }
  async function isMember(chatId, botId, fetchers) {
    return (await check(chatId, botId, fetchers)).state === 'member'
  }
  /** 该机器人刚从这个群收到过消息 → 必然在群里。 */
  function markMember(chatId, botId) {
    if (botId) map.set(`${chatId}:${botId}`, { state: 'member', at: Date.now() })
  }
  function invalidate(chatId, botId) {
    if (botId == null) {
      for (const k of [...map.keys()]) if (k.startsWith(`${chatId}:`)) map.delete(k)
    } else map.delete(`${chatId}:${botId}`)
  }
  return { check, isMember, markMember, invalidate, clear: () => map.clear() }
}
