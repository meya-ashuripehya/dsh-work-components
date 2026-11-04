/**
 * Canonical channel / surface helpers for tools and transports.
 *
 * channelId is one of: desktop | telegram | qq.
 * Resolve it only inside tool execute paths and outbound adapters — never put
 * channelId / surface / "Telegram" / "QQ" into model-visible tool descriptions,
 * system prompts, or render text that the model reads back.
 *
 * QQ calendarCard is PNG via calendar_show + harness image path; map/board still stub.
 */
import { getTelegramBridge } from '../boards/telegram-bridge.mjs'
import {
  lookupQQSessionOrigin,
  noteQQSessionOrigin,
  resetQQSessionOrigins,
} from './qq/session-origin.mjs'

/** @typedef {'desktop' | 'telegram' | 'qq'} ChannelId */

export const CHANNEL_IDS = Object.freeze(/** @type {const} */ (['desktop', 'telegram', 'qq']))

/**
 * What each surface can do for rich outbound today.
 * QQ calendarCard true (tool-side PNG); map/board still stub.
 */
export const CHANNEL_CAPABILITIES = Object.freeze({
  desktop: Object.freeze({
    calendarCard: true,
    calendarHtml: false,
    mapPlaceCard: true,
    mapVenue: false,
    mapRouteCard: true,
    boardPhoto: true,
    cardPhoto: true,
    stickerNative: false,
  }),
  telegram: Object.freeze({
    calendarCard: true,
    calendarHtml: true,
    mapPlaceCard: true,
    mapVenue: true,
    mapRouteCard: true,
    boardPhoto: true,
    cardPhoto: true,
    stickerNative: false,
  }),
  qq: Object.freeze({
    calendarCard: true,
    calendarHtml: false,
    mapPlaceCard: false,
    mapVenue: false,
    mapRouteCard: false,
    boardPhoto: false,
    cardPhoto: false,
    stickerNative: false,
  }),
})

/**
 * @param {unknown} raw
 * @returns {ChannelId | null}
 */
export function normalizeChannelId(raw) {
  const id = String(raw ?? '').trim().toLowerCase()
  if (id === 'desktop' || id === 'local' || id === 'web' || id === 'page') return 'desktop'
  if (id === 'telegram' || id === 'tg') return 'telegram'
  if (id === 'qq' || id === 'qqbot') return 'qq'
  return null
}

/**
 * @param {ChannelId | string | null | undefined} channelId
 */
export function capabilitiesFor(channelId) {
  const id = normalizeChannelId(channelId) || 'desktop'
  return CHANNEL_CAPABILITIES[id] || CHANNEL_CAPABILITIES.desktop
}

/**
 * channelId from an already-known origin / binding / harness event field.
 * Does not consult session bridges.
 * @param {unknown} source
 * @returns {ChannelId | null}
 */
export function channelIdFromSource(source) {
  if (!source || typeof source !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (source)
  return normalizeChannelId(obj.channelId)
    || normalizeChannelId(obj.channel)
    || normalizeChannelId(obj.surface)
}

/**
 * @param {unknown} event harness inbound event
 * @returns {ChannelId | null}
 */
export function channelIdFromHarnessEvent(event) {
  if (!event || typeof event !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (event)
  return channelIdFromSource(obj)
    || channelIdFromSource(obj.conversation)
    || channelIdFromSource(obj.binding)
}

/**
 * @param {object} [origin]
 * @returns {ChannelId}
 */
export function channelIdFromOrigin(origin) {
  return channelIdFromSource(origin) || 'desktop'
}

/**
 * Lookup hit from Telegram or QQ session registries (tools/transports only).
 * @param {string|null|undefined} sessionId
 * @returns {{ channelId: ChannelId, chatId: string, threadId?: string, senderId?: string, conversationType?: string, accountId?: string } | null}
 */
export function lookupSessionChannelHit(sessionId) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return null

  const bridge = getTelegramBridge()
  if (bridge) {
    let hit = null
    try { hit = bridge.lookup(sid) } catch { hit = null }
    if (hit && hit.chatId !== undefined && hit.chatId !== null && hit.chatId !== '') {
      return {
        channelId: 'telegram',
        chatId: String(hit.chatId),
        ...(hit.threadId ? { threadId: String(hit.threadId) } : {}),
        ...(hit.senderId ? { senderId: String(hit.senderId) } : {}),
        conversationType: hit.conversationType === 'group' ? 'group' : 'dm',
        ...(hit.accountId ? { accountId: String(hit.accountId) } : {}),
      }
    }
  }

  const qq = lookupQQSessionOrigin(sid)
  if (qq && qq.chatId) {
    return {
      channelId: 'qq',
      chatId: String(qq.chatId),
      ...(qq.senderId ? { senderId: String(qq.senderId) } : {}),
      conversationType: qq.conversationType === 'group' ? 'group' : 'dm',
      ...(qq.accountId ? { accountId: String(qq.accountId) } : {}),
    }
  }

  return null
}

/**
 * Resolve channelId for the current tool turn.
 * Prefer explicit origin/event; else session bridge; else desktop.
 *
 * @param {{
 *   sessionId?: string,
 *   origin?: object,
 *   event?: object,
 *   binding?: object,
 *   exec?: { agent?: { id?: string }, sessionId?: string },
 * }} [input]
 * @returns {ChannelId}
 */
export function resolveChannelId(input = {}) {
  const fromOrigin = channelIdFromSource(input.origin)
  if (fromOrigin && fromOrigin !== 'desktop') return fromOrigin
  const fromEvent = channelIdFromHarnessEvent(input.event)
  if (fromEvent && fromEvent !== 'desktop') return fromEvent
  const fromBinding = channelIdFromSource(input.binding)
  if (fromBinding && fromBinding !== 'desktop') return fromBinding

  const sid = String(
    input.sessionId
    || input.exec?.agent?.id
    || input.exec?.sessionId
    || '',
  ).trim()
  const hit = lookupSessionChannelHit(sid)
  if (hit) return hit.channelId
  return fromOrigin || fromEvent || fromBinding || 'desktop'
}

/**
 * Surface snapshot for transports (not for model prompts).
 * @param {Parameters<typeof resolveChannelId>[0]} [input]
 */
export function resolveSurface(input = {}) {
  const channelId = resolveChannelId(input)
  const hit = lookupSessionChannelHit(
    input.sessionId || input.exec?.agent?.id || input.exec?.sessionId || '',
  )
  const origin = input.origin && typeof input.origin === 'object' ? input.origin : null
  return {
    channelId,
    capabilities: capabilitiesFor(channelId),
    ...(origin?.accountId || hit?.accountId
      ? { accountId: String(origin?.accountId || hit?.accountId) }
      : {}),
    ...(origin?.conversationType || hit?.conversationType
      ? { conversationType: String(origin?.conversationType || hit?.conversationType) }
      : {}),
    ...(origin?.chatId || origin?.peerId || hit?.chatId
      ? { peerId: String(origin?.chatId || origin?.peerId || hit?.chatId) }
      : {}),
    ...(origin?.threadId || hit?.threadId
      ? { threadId: String(origin?.threadId || hit?.threadId) }
      : {}),
  }
}

/**
 * Build a session origin for cards/boards binding.
 * Returns null on desktop (no channel bind). QQ returns a stub origin;
 * QQ calendarCard is on; map/board remain capability-gated false.
 *
 * @param {string|null|undefined} sessionId
 * @param {{ opponent?: string }} [options]
 * @returns {object | null}
 */
export function originForSession(sessionId, options = {}) {
  const hit = lookupSessionChannelHit(sessionId)
  if (!hit) return null
  const opp = String(options.opponent ?? '').trim()
  if (hit.channelId === 'telegram') {
    return {
      channel: 'telegram',
      chatId: hit.chatId,
      ...(hit.threadId ? { threadId: hit.threadId } : {}),
      conversationType: hit.conversationType === 'group' ? 'group' : 'dm',
      starterId: hit.senderId ? String(hit.senderId) : '',
      ...(hit.accountId ? { accountId: String(hit.accountId) } : {}),
      ...(/^-?\d{1,20}$/.test(opp) ? { opponentId: opp } : {}),
      messageId: null,
    }
  }
  if (hit.channelId === 'qq') {
    return {
      channel: 'qq',
      chatId: hit.chatId,
      peerId: hit.chatId,
      conversationType: hit.conversationType === 'group' ? 'group' : 'dm',
      starterId: hit.senderId ? String(hit.senderId) : '',
      ...(hit.accountId ? { accountId: String(hit.accountId) } : {}),
      messageId: null,
    }
  }
  return null
}

export {
  lookupQQSessionOrigin,
  noteQQSessionOrigin,
  resetQQSessionOrigins,
}
