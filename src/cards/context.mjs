import { createHash } from 'node:crypto'

/**
 * 稳定的会话身份。Telegram 用聊天 id + 话题 id（不随 DSH 会话重建而变）；
 * 桌面用当前会话 id。两者都不靠回合号或消息正文。
 */
export function contextKey({ sessionId, origin } = {}) {
  if (origin?.channel === 'telegram') {
    const chat = String(origin.chatId ?? '').trim()
    if (!chat) return ''
    const thread = origin.threadId ? String(origin.threadId).trim() : ''
    return `telegram:${chat}:${thread}`
  }
  const sid = String(sessionId ?? '').trim()
  if (!sid) return ''
  return `desktop:${sid}`
}

export function saveId(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 32)
}
