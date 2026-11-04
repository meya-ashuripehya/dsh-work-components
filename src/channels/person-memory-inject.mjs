/**
 * Channel inbound: learn aliases, append JSONL, hang CSM (+ TG person-memory) on
 * event.`__dshInboundPrefix` then bridge `agent.inject` (form recall), not user message body. Also appends inbound user text to preset JSONL
 * and patches ReplyRouter.finalize to append assistant replies.
 *
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
import { DEFAULT_OWNER_LINK, normalizeConfig, stripHarnessPrefix } from './cross-session-memory.mjs'
import {
  writeInboundChannelMessage,
  writeAssistantChannelMessage,
  injectForChannel,
  resolveBindingForEvent,
  isMasterMemoryEnabled,
} from './cross-session-memory-write.mjs'

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
  const norm = normalizeConfig({
    enabled: true,
    ownerLinks: nested.ownerLinks?.length ? nested.ownerLinks : [link],
    crossSessionMemoryEnabled: true,
  })
  return {
    aliases,
    link: norm.ownerLinks[0] || link || DEFAULT_OWNER_LINK,
    learnedFile: raw.learnedFile,
    config: cfg,
  }
}

function conversationIdOf(event) {
  return String(event?.conversation?.id ?? event?.conversationId ?? '').trim()
}

function channelOf(event) {
  return String(event?.channel ?? '').trim().toLowerCase()
}

function plainUserText(event) {
  const content = Array.isArray(event?.message?.content) ? event.message.content : []
  const parts = []
  for (const b of content) {
    if (b && b.type === 'text' && b.text) parts.push(String(b.text))
  }
  let s = parts.join('').trim()
  s = s.replace(/^\[person-memory\][^\n]*\n?/m, '')
  s = s.replace(/^\[reply-format\][^\n]*\n?/m, '')
  s = s.replace(/^\[cross-session-memory[^\]]*\][^\n]*\n?/m, '')
  s = stripHarnessPrefix(s)
  return s.trim()
}

/**
 * Learn live sender name; append inbound user line to preset JSONL.
 * Hang CSM (+ Telegram person-memory) on event.`__dshInboundPrefix`; bridge seeds it via
 * `agent.inject` with source form `recall` (not merged into the user-authored UserMessage).
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
      if (peerId && peerId !== senderId) saveLearnedAlias(channel, peerId, liveName, snap.learnedFile)
    } catch { /* never block delivery */ }
  }

  const binding = resolveBindingForEvent(event)
  const preset = String(binding?.route?.preset || binding?.preset || '').trim()
  const sessionId = String(binding?.sessionId || '').trim()
  const userText = plainUserText(event)

  if (userText && isMasterMemoryEnabled(snap.config || {})) {
    void writeInboundChannelMessage(event, userText, { binding, preset }).catch(() => {})
  }

  const parts = []
  const inject = preset ? injectForChannel({ preset, sessionId }) : ''
  if (inject) parts.push(inject.trimEnd())

  // QQ: format constraints stay in Agent preset only. Telegram keeps short person-memory on prefix.
  if (channel !== 'qq') {
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
    if (summary) parts.push(String(summary).trimEnd())
  }

  const prefixText = parts.filter(Boolean).join('\n')
  if (!prefixText) return event

  // Do not mutate message.content — bridge injects __dshInboundPrefix as plugin recall context.
  return {
    ...event,
    __dshInboundPrefix: prefixText,
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

/**
 * Install once on ReplyRouter: after finalize delivers assistant text, append to preset JSONL.
 */
export function installAssistantMemoryWrite(ReplyRouter) {
  const proto = ReplyRouter?.prototype
  if (!proto || proto.__dshCsmAssistantWrite || typeof proto.finalize !== 'function') {
    return false
  }
  const original = proto.finalize
  proto.finalize = async function finalize(active, turn) {
    let text = ''
    try {
      text = (active?.textBuffer && active.textBuffer.length > 0) ? active.textBuffer : (active?.finalText || '')
      if (active?.bufferedSteps?.length) {
        text = [...active.bufferedSteps, text].filter(Boolean).join('\n\n')
      }
    } catch { text = '' }
    try {
      await original.call(this, active, turn)
    } finally {
      try {
        if (text && active?.binding) {
          void writeAssistantChannelMessage(active.binding, text).catch(() => {})
        }
      } catch { /* never break delivery */ }
    }
  }
  Object.defineProperty(proto, '__dshCsmAssistantWrite', { value: true })
  return true
}