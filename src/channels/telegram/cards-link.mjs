/**
 * Telegram 入站里的牌类动作。挂在棋类钩子之外，不改棋类的登记。
 * 牌桌出图仍用棋类已经挂上的 Bot API 桥（globalThis 上的同一份）。
 */
import { getCardsInbound } from '../../cards/telegram-bridge.mjs'

function messageOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  for (const key of ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message']) {
    if (raw[key] && typeof raw[key] === 'object') return raw[key]
  }
  return raw.chat ? raw : null
}

export function installCardsLink(ChannelHarnessBridge) {
  const bridge = ChannelHarnessBridge?.prototype
  if (!bridge || bridge.__dshCardsInbound || typeof bridge.handleQueuedMessage !== 'function') return
  const original = bridge.handleQueuedMessage
  bridge.handleQueuedMessage = async function handleQueuedMessage(event, key, text, parsed, generation) {
    const hook = getCardsInbound()
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
  Object.defineProperty(bridge, '__dshCardsInbound', { value: true })
}
