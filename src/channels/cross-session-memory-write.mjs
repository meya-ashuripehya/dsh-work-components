/**
 * Write + gate helpers for preset JSONL cross-session memory.
 * Channel inbound/outbound and chatroom seats call into here.
 */
import { loadBindings, bindingsPath, estimateTokens } from './cross-session-memory.mjs'
import {
  ownerLinkFromSettings,
  presetsFromMemorySeats,
  resolveDisplayName,
  parseAliasMap,
  loadLearnedAliases,
} from './person-profile.mjs'
import {
  appendTaggedMessage,
  buildInjectBlock,
  maybeCompactPreset,
  STORE_CAPS,
  presetMemoryPath,
} from './cross-session-memory-store.mjs'
import {
  isCompanionCompactionEnabled,
  resolveCompanionInstruction,
} from '../session-history/companion-compaction.mjs'
import { COMPANION_COMPACTION_INSTRUCTION } from '../session-history/companion-instruction.mjs'

const asText = (v) => String(v ?? '').trim()

/** Master switch + nested.enabled. */
export function isMasterMemoryEnabled(cfg = {}) {
  const nested = cfg.crossSessionMemory && typeof cfg.crossSessionMemory === 'object'
    ? cfg.crossSessionMemory
    : {}
  return cfg.crossSessionMemoryEnabled !== false && nested.enabled !== false
}

/** Presets that may write/inject (seat-centric, with legacy fallback). */
export function memoryPresetsOf(cfg = {}) {
  const link = ownerLinkFromSettings(cfg)
  return [...(link.presets || [])]
}

export function isPresetMemoryEnabled(cfg, preset) {
  if (!isMasterMemoryEnabled(cfg)) return false
  const p = asText(preset)
  if (!p) return false
  return memoryPresetsOf(cfg).includes(p)
}

/**
 * Resolve channel binding row for an inbound event (best-effort).
 */
export function resolveBindingForEvent(event, bindings = loadBindings()) {
  const channel = asText(event?.channel).toLowerCase()
  const account = asText(event?.accountId || 'main')
  const peer = asText(event?.conversation?.id ?? event?.conversationId)
  const thread = event?.conversation?.threadId ?? event?.threadId
  if (!channel || !peer) return null
  const key = thread != null && String(thread) !== ''
    ? `${channel}:${account}:${peer}:${thread}`
    : `${channel}:${account}:${peer}`
  const row = bindings?.[key]
  if (row && typeof row === 'object') return { key, ...row }
  // Fallback: scan by channel+conversationId
  for (const [k, r] of Object.entries(bindings || {})) {
    if (!r || typeof r !== 'object') continue
    if (asText(r.channelId || k.split(':')[0]).toLowerCase() !== channel) continue
    if (asText(r.conversationId) !== peer) continue
    if (thread != null && String(thread) !== '' && String(r.threadId ?? '') !== String(thread)) continue
    return { key: k, ...r }
  }
  return null
}

export function sceneFromEvent(event, binding) {
  return {
    sessionId: asText(binding?.sessionId),
    channel: asText(event?.channel).toLowerCase(),
    peerId: asText(event?.conversation?.id ?? event?.conversationId),
    conversationType: asText(event?.conversation?.type || binding?.conversationType || 'dm'),
    accountId: asText(event?.accountId || binding?.accountId || 'main'),
    threadId: event?.conversation?.threadId ?? event?.threadId ?? binding?.threadId ?? null,
  }
}

export function sceneFromBinding(binding) {
  return {
    sessionId: asText(binding?.sessionId),
    channel: asText(binding?.channelId).toLowerCase(),
    peerId: asText(binding?.conversationId),
    conversationType: asText(binding?.conversationType || 'dm'),
    accountId: asText(binding?.accountId || 'main'),
    threadId: binding?.threadId ?? null,
  }
}

/**
 * Runtime bag set by createCrossSessionFeature.
 * @type {null | {
 *   getConfig: () => any,
 *   getLlm?: () => any,
 *   bindingsFile?: string,
 *   home?: string,
 *   log?: any,
 *   compacting?: Set<string>,
 * }}
 */
let runtime = null

export function setMemoryWriteRuntime(bag) {
  runtime = bag && typeof bag === 'object' ? bag : null
}

export function getMemoryWriteRuntime() {
  return runtime
}

function cfgOf() {
  return runtime?.getConfig?.() || {}
}

function loadBinds() {
  return loadBindings(runtime?.bindingsFile || bindingsPath(runtime?.home))
}

/**
 * Compaction instruction: companion when enabled, else a short generic prompt.
 */
export function compactionInstructionFor(cfg) {
  if (isCompanionCompactionEnabled(cfg)) {
    return resolveCompanionInstruction(cfg)
  }
  return [
    'Summarize the following cross-session dialogue into a concise checkpoint.',
    'Keep speakers, scenes, open threads, preferences, and promises.',
    'Do not invent facts. Prefer short bullet points.',
  ].join('\n')
}

async function streamSummarize({ instruction, corpus, provider, model }) {
  const llm = runtime?.getLlm?.()
  if (!llm || typeof llm.stream !== 'function') return null
  const p = asText(provider) || 'deepseek'
  const m = asText(model) || 'deepseek-chat'
  const messages = [
    { role: 'user', content: [{ type: 'text', text: String(corpus || '').slice(0, 120000) }] },
    { role: 'user', content: [{ type: 'text', text: String(instruction || '') }] },
  ]
  const stream = llm.stream({
    model: { provider: p, model: m },
    messages,
    purpose: 'compaction',
  })
  let text = ''
  for await (const c of stream) {
    if (c?.type === 'text-delta' && c.text) text += c.text
    else if (c?.type === 'finish') {
      const r = c.reason || {}
      if (r.kind === 'error') throw new Error(r.failure?.message || 'compaction llm error')
      break
    }
  }
  return asText(text).slice(0, 12000) || null
}

function summarizerModelFrom(cfg) {
  // Prefer chatroom summarizer settings if present; else first memory seat; else deepseek defaults.
  const sp = asText(cfg.chatroomSummarizerProvider || cfg.companionCompactionProvider)
  const sm = asText(cfg.chatroomSummarizerModel || cfg.companionCompactionModel)
  if (sp && sm) return { provider: sp, model: sm }
  const seats = Array.isArray(cfg.chatroomSeats) ? cfg.chatroomSeats : []
  for (const s of seats) {
    if (s?.crossSessionMemoryEnabled === true && asText(s.provider) && asText(s.model)) {
      return { provider: asText(s.provider), model: asText(s.model) }
    }
  }
  return { provider: 'deepseek', model: 'deepseek-chat' }
}

export function scheduleCompact(preset) {
  const p = asText(preset)
  if (!p || !runtime) return
  const cfg = cfgOf()
  if (!isPresetMemoryEnabled(cfg, p)) return
  if (!runtime.compacting) runtime.compacting = new Set()
  if (runtime.compacting.has(p)) return
  runtime.compacting.add(p)
  void (async () => {
    try {
      const { provider, model } = summarizerModelFrom(cfg)
      await maybeCompactPreset({
        preset: p,
        home: runtime.home,
        threshold: STORE_CAPS.compactThresholdTokens,
        instruction: compactionInstructionFor(cfg),
        summarize: ({ instruction, corpus }) => streamSummarize({ instruction, corpus, provider, model }),
      })
    } catch (e) {
      runtime.log?.warn?.('dsh-workbench: cross-session memory compact failed', e?.message || e)
    } finally {
      runtime.compacting?.delete(p)
    }
  })()
}

/**
 * Append inbound user text for a channel event (if gated).
 */
export async function writeInboundChannelMessage(event, text, extra = {}) {
  const cfg = cfgOf()
  if (!isMasterMemoryEnabled(cfg)) return null
  const binding = extra.binding || resolveBindingForEvent(event, loadBinds())
  const preset = asText(extra.preset || binding?.route?.preset || binding?.preset)
  if (!isPresetMemoryEnabled(cfg, preset)) return null
  const body = asText(text)
  if (!body) return null
  const scene = sceneFromEvent(event, binding)
  const aliases = parseAliasMap(cfg.crossSessionAliases || '')
  const speaker = resolveDisplayName({
    channel: scene.channel,
    peerId: asText(event?.sender?.id) || scene.peerId,
    conversationType: scene.conversationType,
    aliases,
    learned: loadLearnedAliases(),
    liveName: event?.sender?.name,
  }) || asText(event?.sender?.name) || asText(event?.sender?.id) || 'user'

  const entry = await appendTaggedMessage(preset, {
    scene,
    speaker,
    role: 'user',
    text: body,
    home: runtime?.home,
  })
  scheduleCompact(preset)
  return entry
}

/**
 * Append assistant reply after channel turn finalize.
 */
export async function writeAssistantChannelMessage(binding, text) {
  const cfg = cfgOf()
  if (!isMasterMemoryEnabled(cfg)) return null
  const preset = asText(binding?.route?.preset || binding?.preset)
  if (!isPresetMemoryEnabled(cfg, preset)) return null
  const body = asText(text)
  if (!body) return null
  const scene = sceneFromBinding(binding)
  const speaker = asText(preset) || 'assistant'
  const entry = await appendTaggedMessage(preset, {
    scene,
    speaker,
    role: 'assistant',
    text: body,
    home: runtime?.home,
  })
  scheduleCompact(preset)
  return entry
}

/**
 * Chatroom message → preset jsonl when the involved seat has memory enabled.
 * For user messages: write once per memory-enabled seat preset in the room (deduped).
 * For seat messages: write to that seat's preset only.
 */
export async function writeChatroomMemoryMessage({
  roomId,
  roomName,
  msg,
  seats = [],
  sessionIdByPreset = {},
} = {}) {
  const cfg = cfgOf()
  if (!isMasterMemoryEnabled(cfg)) return []
  if (!msg || !asText(msg.text)) return []
  const kind = asText(msg.kind)
  if (kind !== 'user' && kind !== 'seat') return []

  const written = []
  const seen = new Set()

  const targets = []
  if (kind === 'seat') {
    const seat = (seats || []).find((s) => s?.id === msg.speaker?.id) || null
    if (seat?.crossSessionMemoryEnabled === true && asText(seat.preset)) {
      targets.push(seat)
    }
  } else {
    for (const seat of seats || []) {
      if (seat?.crossSessionMemoryEnabled === true && asText(seat.preset)) targets.push(seat)
    }
  }

  for (const seat of targets) {
    const preset = asText(seat.preset)
    if (!preset || seen.has(preset)) continue
    if (!isPresetMemoryEnabled(cfg, preset)) continue
    seen.add(preset)
    const scene = {
      sessionId: asText(sessionIdByPreset[preset]) || asText(msg.sessionId) || '',
      channel: 'chatroom',
      roomId: asText(roomId),
      peerId: asText(roomId),
      conversationType: 'room',
      roomName: asText(roomName),
    }
    const speaker = asText(msg.speaker?.name) || asText(msg.speaker?.id) || (kind === 'user' ? 'user' : preset)
    const entry = await appendTaggedMessage(preset, {
      scene,
      speaker,
      role: kind === 'seat' ? 'assistant' : 'user',
      text: asText(msg.text),
      time: msg.time ? Date.parse(msg.time) || Date.now() : Date.now(),
      home: runtime?.home,
    })
    if (entry) written.push(entry)
    scheduleCompact(preset)
  }
  return written
}

/**
 * Build inject text for a channel turn (exclude current session).
 */
export function injectForChannel({ preset, sessionId, maxTokens } = {}) {
  const cfg = cfgOf()
  if (!isPresetMemoryEnabled(cfg, preset)) return ''
  const { text } = buildInjectBlock({
    preset,
    excludeSessionId: sessionId,
    maxTokens: maxTokens ?? STORE_CAPS.injectMaxTokens,
    home: runtime?.home,
  })
  return text
}

/**
 * Build inject text for a chatroom seat turn (exclude current room).
 */
export function injectForChatroomSeat({ seat, roomId, maxTokens } = {}) {
  const cfg = cfgOf()
  if (!seat || seat.crossSessionMemoryEnabled !== true) return ''
  const preset = asText(seat.preset)
  if (!isPresetMemoryEnabled(cfg, preset)) return ''
  const { text } = buildInjectBlock({
    preset,
    excludeRoomId: roomId,
    // Also exclude guest session if known — room-scoped exclude is enough for "other sessions"
    maxTokens: maxTokens ?? STORE_CAPS.injectMaxTokens,
    home: runtime?.home,
  })
  return text
}

export { STORE_CAPS, presetMemoryPath, buildInjectBlock, COMPANION_COMPACTION_INSTRUCTION }
