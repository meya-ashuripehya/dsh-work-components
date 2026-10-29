/**
 * Inject capped [person-memory] summary into channel inbound turns.
 * Patches ChannelHarnessBridge.prototype.handleQueuedMessage (same style as cards-link).
 * Also learns Telegram/QQ sender.name into peer-aliases-learned.json for later list/search labels.
 */
import {
  buildPersonSummary,
  ownerLinkFromSettings,
  parseAliasMap,
  saveLearnedAlias,
  loadLearnedAliases,
} from './person-profile.mjs'
import { QQ_LINGCHAT_FORMAT_HINT } from './qq/lingchat-segments.mjs'
import { DEFAULT_OWNER_LINK, normalizeConfig } from './cross-session-memory.mjs'

let provider = null

/** @param {null | (() => { enabled?: boolean, config?: object, aliases?: object[], learnedFile?: string })} fn */
export function setPersonMemoryProvider(fn) {
  provider = typeof fn === 'function' ? fn : null
}

export function getPersonMemoryProvider() {
  return provider
}

function snapshotFromProvider(event) {
  const raw = provider?.() || {}
  if (raw.enabled === false) return null
  const cfg = raw.config || raw.settings || {}
  const nested = cfg.crossSessionMemory && typeof cfg.crossSessionMemory === 'object'
    ? cfg.crossSessionMemory
    : {}
  const enabled = cfg.crossSessionMemoryEnabled !== false
    && nested.enabled !== false
    && raw.enabled !== false
  if (!enabled) return null

  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
    : parseAliasMap(cfg.crossSessionAliases ?? nested.aliasesText ?? '')
  const link = ownerLinkFromSettings({
    ...cfg,
    ...nested,
    crossSessionOwnerTelegramIds: cfg.crossSessionOwnerTelegramIds ?? nested.telegramOwnerIds,
    crossSessionOwnerQqOpenIds: cfg.crossSessionOwnerQqOpenIds ?? nested.qqOwnerOpenIds,
    crossSessionPresets: cfg.crossSessionPresets,
    crossSessionShareGroups: cfg.crossSessionShareGroups,
  })
  // Prefer normalizeConfig ownerLinks[0] when nested.ownerLinks present
  const norm = normalizeConfig({
    enabled: true,
    ownerLinks: nested.ownerLinks?.length ? nested.ownerLinks : [link],
    crossSessionMemoryEnabled: true,
  })
  return {
    aliases,
    link: norm.ownerLinks[0] || link || DEFAULT_OWNER_LINK,
    learnedFile: raw.learnedFile,
  }
}

function conversationIdOf(event) {
  return String(event?.conversation?.id ?? event?.conversationId ?? '').trim()
}

function channelOf(event) {
  return String(event?.channel ?? '').trim().toLowerCase()
}

/**
 * Prepend person-memory text block; learn live sender name.
 * @returns {object} possibly rewritten event
 */
export function enrichInboundEvent(event, snap) {
  if (!event || !snap) return event
  const channel = channelOf(event)
  const peerId = conversationIdOf(event)
  if (!channel || !peerId) return event

  const liveName = String(event?.sender?.name ?? '').trim()
  const senderId = String(event?.sender?.id ?? '').trim()
  if (liveName) {
    try {
      saveLearnedAlias(channel, senderId || peerId, liveName, snap.learnedFile)
      // For DMs, also map conversation id (same as sender)
      if (peerId && peerId !== senderId) saveLearnedAlias(channel, peerId, liveName, snap.learnedFile)
    } catch { /* never block delivery */ }
  }

  // QQ: short id+nick is already in harness metadata prefix; skip long [person-memory],
  // but keep a compact LingChat reply-format reminder for segmented outbound.
  if (channel === 'qq') {
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    const already = content.some(
      (b) => b && b.type === 'text' && String(b.text || '').includes('[reply-format]'),
    )
    if (already) return event
    return {
      ...event,
      message: {
        ...event.message,
        content: [{ type: 'text', text: QQ_LINGCHAT_FORMAT_HINT + '\n' }, ...content],
      },
    }
  }

  const summary = buildPersonSummary({
    channel,
    peerId,
    conversationType: event?.conversation?.type,
    senderId,
    liveName,
    aliases: snap.aliases,
    learned: loadLearnedAliases(snap.learnedFile),
    link: snap.link,
    enabled: true,
  })
  if (!summary) return event

  const content = Array.isArray(event.message?.content) ? event.message.content : []
  // Avoid stacking duplicate person-memory blocks if a prior hook already added one
  const already = content.some(
    (b) => b && b.type === 'text' && String(b.text || '').includes('[person-memory]'),
  )
  if (already) return event

  return {
    ...event,
    message: {
      ...event.message,
      content: [{ type: 'text', text: summary + '\n' }, ...content],
    },
  }
}

/**
 * Install once on ChannelHarnessBridge (TG + QQ share @wsz987/channel-harness).
 */
export function installPersonMemoryInject(ChannelHarnessBridge) {
  const bridge = ChannelHarnessBridge?.prototype
  if (!bridge || bridge.__dshPersonMemory || typeof bridge.handleQueuedMessage !== 'function') {
    return false
  }
  const original = bridge.handleQueuedMessage
  bridge.handleQueuedMessage = async function handleQueuedMessage(event, key, text, parsed, generation) {
    let next = event
    try {
      const snap = snapshotFromProvider(event)
      if (snap) next = enrichInboundEvent(event, snap)
    } catch { /* never block delivery */ }
    return original.call(this, next, key, text, parsed, generation)
  }
  Object.defineProperty(bridge, '__dshPersonMemory', { value: true })
  return true
}
