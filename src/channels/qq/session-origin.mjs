/**
 * QQ session → conversation origin registry (tools/transports only).
 *
 * Mirrors Telegram's boards-link origins Map so resolveChannelId / originForSession
 * can tell qq from desktop without asking the model. Rich QQ outbound adapters
 * (calendar HTML, map venue, board/card photos) are not wired yet.
 *
 * Live harness register() context (channel-harness bridge) looks like:
 *   { conversationType, senderId, replyToMessageId, raw, runId }
 * with no top-level conversationId. QQ SDK raw is C2CMessageEvent
 * (author.user_openid) or GroupMessageEvent (group_openid + author.member_openid).
 * C2C conversation.id === senderId; group conversation.id === group_openid.
 */
const origins = new Map()
const MAX_SESSIONS = 500

/**
 * @param {unknown} context harness reply context or inbound-like object
 * @returns {{ chatId: string, senderId: string, conversationType: 'dm'|'group', accountId?: string } | null}
 */
export function originFromQQContext(context) {
  if (!context || typeof context !== 'object') return null
  const raw = context.raw && typeof context.raw === 'object' ? context.raw : null
  const author = raw?.author && typeof raw.author === 'object' ? raw.author : null
  const typeHint = context.conversationType
    ?? context.conversation?.type
    ?? (raw?.group_openid ? 'group' : undefined)
  const conversationId = context.conversationId
    ?? context.conversation?.id
    ?? raw?.group_openid
    ?? author?.user_openid
    ?? author?.id
    ?? context.chatId
    ?? context.peerId
    // Live DM register context has senderId but no conversationId; mapper sets
    // conversation.id = senderId for C2C. Never use senderId as group chatId.
    ?? (typeHint === 'group' ? undefined : (context.senderId ?? context.sender?.id))
  const chatId = conversationId === undefined || conversationId === null ? '' : String(conversationId).trim()
  if (!chatId) return null
  const senderId = context.senderId === undefined && context.sender?.id === undefined
    ? ''
    : String(context.senderId ?? context.sender?.id ?? '').trim()
  const type = typeHint
    ?? (raw?.group_openid ? 'group' : 'dm')
  const accountId = String(context.accountId ?? raw?.accountId ?? '').trim()
  return {
    chatId,
    senderId,
    conversationType: type === 'group' ? 'group' : 'dm',
    ...(accountId && accountId !== 'main' ? { accountId } : {}),
  }
}

export function noteQQSessionOrigin(sessionId, contextOrOrigin) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return
  const origin = contextOrOrigin && typeof contextOrOrigin === 'object' && contextOrOrigin.chatId
    ? {
        chatId: String(contextOrOrigin.chatId),
        senderId: contextOrOrigin.senderId === undefined ? '' : String(contextOrOrigin.senderId),
        conversationType: contextOrOrigin.conversationType === 'group' ? 'group' : 'dm',
        ...(contextOrOrigin.accountId ? { accountId: String(contextOrOrigin.accountId) } : {}),
      }
    : originFromQQContext(contextOrOrigin)
  if (!origin) return
  origins.delete(sid)
  origins.set(sid, origin)
  if (origins.size > MAX_SESSIONS) origins.delete(origins.keys().next().value)
}

export function lookupQQSessionOrigin(sessionId) {
  return origins.get(String(sessionId ?? '')) || null
}

export function resetQQSessionOrigins() {
  origins.clear()
}

/**
 * Patch ReplyContextStore.register so QQ inbound notes session origins.
 * Safe no-op if already installed or prototype missing.
 */
export function installQQSessionOriginLink(ReplyContextStore) {
  const store = ReplyContextStore?.prototype
  if (!store || store.__dshQQSessionOrigin) return false
  const original = store.register
  if (typeof original !== 'function') return false
  store.register = function register(messageId, pending) {
    try { noteQQSessionOrigin(pending?.sessionId, pending?.context) } catch { /* never block delivery */ }
    return original.call(this, messageId, pending)
  }
  Object.defineProperty(store, '__dshQQSessionOrigin', { value: true })
  return true
}
