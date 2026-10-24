/**
 * 按 chat.id 分流：已绑定聊天室 → chatroom；私聊 / 通道允许群 → channel；其余群 → chatroom（发现新群）。
 * 脏数据（群同时出现在两边）以聊天室绑定为准。
 */
import { chatIdKey } from '../channels/telegram/group-conflict.mjs'

export function extractChatFromUpdate(raw) {
  const m = raw?.message || raw?.edited_message || raw?.my_chat_member || raw?.callback_query?.message
  if (!m?.chat) return null
  const chat = m.chat
  const id = String(chat.id)
  const type = chat.type
  const isGroup = type === 'group' || type === 'supergroup'
  return { chatId: id, type, isGroup, title: String(chat.title || ''), message: raw.message || raw.edited_message || null, raw }
}

/**
 * @param {{ chatId: string, isGroup: boolean }} chat
 * @param {{ boundIds: Iterable<string>, channelGroupIds: string|string[], chatroomEnabled?: boolean }} ctx
 * @returns {'chatroom'|'channel'|'ignore'}
 */
export function classifyDestination(chat, ctx = {}) {
  if (!chat?.chatId) return 'ignore'
  if (!chat.isGroup) return 'channel' // 私聊走通道；非通道成员 bot 的私聊由聊天室侧忽略
  if (ctx.chatroomEnabled === false) return 'channel'
  const key = chatIdKey(chat.chatId)
  const bound = new Set([...(ctx.boundIds || [])].map(chatIdKey).filter(Boolean))
  if (key && bound.has(key)) return 'chatroom'
  const allowed = new Set(
    (Array.isArray(ctx.channelGroupIds)
      ? ctx.channelGroupIds
      : String(ctx.channelGroupIds || '').split(/[\s,，;；]+/))
      .map(chatIdKey)
      .filter(Boolean),
  )
  if (key && allowed.has(key)) return 'channel'
  return 'chatroom' // 未绑定且不在通道允许列表 → 发现新群 /bind
}
