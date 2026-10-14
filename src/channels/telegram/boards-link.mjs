/**
 * Telegram 一半的棋类桥（见 src/boards/telegram-bridge.mjs）。挂原型，不改 vendor 补丁文件：
 *   - ReplyContextStore.prototype.register：记下每个会话最近一条入站来自哪个聊天（raw 更新里的 chat.id，
 *     与适配器解析的发送者），供 board_open 识别「这局来自 Telegram」并绑定聊天；
 *   - ChannelHarnessBridge.prototype.handleQueuedMessage：访问策略已放行、非命令的文字先问棋类：
 *     是绑定聊天里的合法着法就落子，再把「某某下在了…」交给 AI；明显是着法但不合法 / 不是玩家，只回一句，不唤醒 AI。
 * 授权用户闸门照旧：这里不登记、不放宽任何工具；转给 AI 的那句仍按原发送者计入本轮。
 */
import { clearTelegramBridge, getBoardsInbound, setTelegramBridge } from '../../boards/telegram-bridge.mjs'

const origins = new Map()
const MAX_SESSIONS = 500

function messageOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  for (const key of ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message']) {
    if (raw[key] && typeof raw[key] === 'object') return raw[key]
  }
  return raw.chat ? raw : null
}

/** 从一条入站上下文得出来源；拿不到 chat.id 时返回 null。 */
export function originFromContext(context) {
  const message = messageOf(context?.raw)
  const chatId = message?.chat?.id
  if (chatId === undefined || chatId === null) return null
  return {
    chatId: String(chatId),
    ...(message.is_topic_message && message.message_thread_id !== undefined ? { threadId: String(message.message_thread_id) } : {}),
    senderId: context?.senderId === undefined ? '' : String(context.senderId),
    conversationType: context?.conversationType === 'group' ? 'group' : 'dm',
  }
}

export function noteSessionOrigin(sessionId, context) {
  const sid = String(sessionId ?? '')
  const origin = sid ? originFromContext(context) : null
  if (!origin) return
  origins.delete(sid)
  origins.set(sid, origin)
  if (origins.size > MAX_SESSIONS) origins.delete(origins.keys().next().value)
}

export function lookupSessionOrigin(sessionId) {
  return origins.get(String(sessionId ?? '')) || null
}

export function resetSessionOrigins() { origins.clear() }

export function installBoardsLink(ReplyContextStore, ChannelHarnessBridge) {
  const store = ReplyContextStore?.prototype
  if (store && !store.__dshBoardsLink) {
    const original = store.register
    store.register = function register(messageId, pending) {
      try { noteSessionOrigin(pending?.sessionId, pending?.context) } catch { /* never block delivery */ }
      return original.call(this, messageId, pending)
    }
    Object.defineProperty(store, '__dshBoardsLink', { value: true })
  }
  const bridge = ChannelHarnessBridge?.prototype
  if (bridge && !bridge.__dshBoardsInbound && typeof bridge.handleQueuedMessage === 'function') {
    const original = bridge.handleQueuedMessage
    bridge.handleQueuedMessage = async function handleQueuedMessage(event, key, text, parsed, generation) {
      const hook = getBoardsInbound()
      if (hook && !parsed && event?.channel === 'telegram' && typeof text === 'string' && text.trim()) {
        let result = null
        try {
          const chatId = messageOf(event.raw)?.chat?.id ?? event.conversation?.id
          result = await hook({ chatId: String(chatId), senderId: String(event.sender?.id ?? ''), conversationType: event.conversation?.type, text })
        } catch { result = null }
        if (result?.notice) {
          try { await this.sendCommandNotice(event, result.notice) } catch { /* ignore */ }
          return undefined
        }
        if (result?.forward) {
          const forwarded = {
            ...event,
            message: { ...event.message, content: [{ type: 'text', text: result.forward }] },
          }
          return original.call(this, forwarded, key, result.forward, parsed, generation)
        }
      }
      return original.call(this, event, key, text, parsed, generation)
    }
    Object.defineProperty(bridge, '__dshBoardsInbound', { value: true })
  }
}

/** 把适配器的 Bot API 上游包成棋类要的几个方法。upstream.requestOk(endpoint, body) 接受 JSON 或 FormData。 */
export function createBoardsTelegramBridge(upstream) {
  const photo = (png) => new Blob([png], { type: 'image/png' })
  return {
    lookup: lookupSessionOrigin,
    async sendPhoto({ chatId, threadId, png, caption }) {
      const form = new FormData()
      form.append('chat_id', String(chatId))
      if (threadId) form.append('message_thread_id', String(threadId))
      form.append('photo', photo(png), 'board.png')
      if (caption) form.append('caption', caption)
      const envelope = await upstream.requestOk('sendPhoto', form)
      return envelope?.data?.result?.message_id
    },
    async deletePhoto({ chatId, messageId }) {
      await upstream.requestOk('deleteMessage', { chat_id: String(chatId), message_id: Number(messageId) })
    },
    async editPhoto({ chatId, messageId, png, caption }) {
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('message_id', String(messageId))
      form.append('media', JSON.stringify({ type: 'photo', media: 'attach://board', ...(caption ? { caption } : {}) }))
      form.append('board', photo(png), 'board.png')
      await upstream.requestOk('editMessageMedia', form)
    },
  }
}

export function mountBoardsBridge(upstream) {
  const bridge = createBoardsTelegramBridge(upstream)
  setTelegramBridge(bridge)
  return () => clearTelegramBridge(bridge)
}
