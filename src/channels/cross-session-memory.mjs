/**
 * Cross-session memory v0: list + search peer channel transcripts (pull only).
 * Source: ~/.dsh/dsh-channels/bindings.json + session zstd logs.
 * Message bodies stay pull-only via tools; a short capped [person-memory] summary
 * may be prepended on channel inbound (see person-memory-inject.mjs).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, findSessionLogPath, readSessionLog } from '../session-controls/zstd-log.mjs'
import {
  formatPeerLabel,
  labelPeer,
  loadLearnedAliases,
  ownerLinkFromSettings,
  parseAliasMap,
  resolveDisplayName,
} from './person-profile.mjs'

export const LIST_NAME = 'cross_session_list'
export const SEARCH_NAME = 'cross_session_search'
export const TOOL_NAMES = Object.freeze([LIST_NAME, SEARCH_NAME])

/** Hard caps from docs/cross-session-memory.md §4.1 */
export const CAPS = Object.freeze({
  listLimitDefault: 10,
  listLimitMax: 20,
  searchLimitDefault: 6,
  searchLimitMax: 15,
  lastNMax: 30,
  contextMax: 2,
  maxSessionsPerCall: 4,
  maxEventsPerSession: 4000,
  maxCharsPerHit: 600,
  maxResultTokens: 6000,
  maxCallsPerTurn: 3,
})

const CJK_RE = /[\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g

export function estimateTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  const cjk = (s.match(CJK_RE) || []).length
  return Math.ceil(cjk + (s.length - cjk) / 4)
}

const clampInt = (v, lo, hi, d) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

const asText = (v) => String(v ?? '').trim()

const timeOf = (v) => {
  if (v == null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

/** Default Shiro OwnerLink — channel sessions all queryable; person/group distinguished. */
export const DEFAULT_OWNER_LINK = Object.freeze({
  id: 'shiro',
  telegramOwnerIds: Object.freeze(['6153059771']),
  qqOwnerOpenIds: Object.freeze(['B4C6E62A8A0919E62678494F20F30530']),
  presets: Object.freeze(['lingsnow']),
  includeChannels: Object.freeze(['qq', 'telegram']),
  shareGroups: true,
  chatroomShare: false,
  allowlistSessionIds: Object.freeze([]),
  denylistSessionIds: Object.freeze([]),
})

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  ownerLinks: Object.freeze([DEFAULT_OWNER_LINK]),
})

export function bindingsPath(home = dshHome()) {
  return join(home, 'dsh-channels', 'bindings.json')
}

export function loadBindings(file = bindingsPath()) {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** Normalize config from settings / tests. */
export function normalizeConfig(raw) {
  const base = raw && typeof raw === 'object' ? raw : {}
  const nested = base.crossSessionMemory && typeof base.crossSessionMemory === 'object' ? base.crossSessionMemory : {}
  const enabled = base.enabled !== false && base.crossSessionMemoryEnabled !== false && nested.enabled !== false
  let links = Array.isArray(base.ownerLinks) ? base.ownerLinks : null
  if (!links && Array.isArray(nested.ownerLinks)) links = nested.ownerLinks
  // Flat settings fields (UI) → OwnerLink when no explicit ownerLinks array
  if (!links?.length) {
    const fromSettings = ownerLinkFromSettings({ ...nested, ...base })
    links = [fromSettings]
  }
  const ownerLinks = links.map((L) => {
    const l = L && typeof L === 'object' ? L : {}
    return {
      id: asText(l.id) || 'default',
      telegramOwnerIds: [...(l.telegramOwnerIds || DEFAULT_OWNER_LINK.telegramOwnerIds)].map(asText).filter(Boolean),
      qqOwnerOpenIds: [...(l.qqOwnerOpenIds || DEFAULT_OWNER_LINK.qqOwnerOpenIds)].map(asText).filter(Boolean),
      presets: [...(l.presets || DEFAULT_OWNER_LINK.presets)].map(asText).filter(Boolean),
      includeChannels: [...(l.includeChannels || DEFAULT_OWNER_LINK.includeChannels)].map((c) => asText(c).toLowerCase()).filter(Boolean),
      // User decision 2026-10-25: all channel sessions queryable → shareGroups default true
      shareGroups: l.shareGroups !== false,
      chatroomShare: l.chatroomShare === true,
      allowlistSessionIds: [...(l.allowlistSessionIds || [])].map(asText).filter(Boolean),
      denylistSessionIds: [...(l.denylistSessionIds || [])].map(asText).filter(Boolean),
    }
  })
  const aliases = Array.isArray(base.aliases)
    ? base.aliases
    : parseAliasMap(base.crossSessionAliases ?? nested.aliasesText ?? nested.aliases ?? '')
  const learned = base.learned && typeof base.learned === 'object'
    ? base.learned
    : (base.skipLearned ? {} : loadLearnedAliases(base.learnedFile))
  return { enabled, ownerLinks, aliases, learned }
}

/** dm → person, group → group (for listings / hit labels). */
export function personGroupOf(conversationType) {
  const t = asText(conversationType).toLowerCase()
  if (t === 'dm' || t === 'private' || t === 'c2c' || t === 'person') return 'person'
  if (t === 'group' || t === 'supergroup' || t === 'channel') return 'group'
  if (t === 'desktop') return 'desktop'
  if (t === 'room' || t === 'chatroom') return 'room'
  return t || 'unknown'
}

export function conversationTypeNorm(conversationType) {
  const t = asText(conversationType).toLowerCase()
  if (t === 'person' || t === 'private' || t === 'c2c') return 'dm'
  if (t === 'supergroup' || t === 'channel') return 'group'
  return t
}

/**
 * Strip harness metadata prefix tokens (message=ROBOT… / long ids) down to a short tag.
 * Keeps channel + sender role hint; never returns raw message tokens.
 */
export function stripHarnessPrefix(text, { ownerIds = [] } = {}) {
  let s = String(text || '')
  const owners = new Set(ownerIds.map(asText).filter(Boolean))
  s = s.replace(/\[channel=([a-z0-9_-]+)\s+sender=([^\s\]]+)(?:\s+message=[^\]]*)?\]\s*/gi, (_m, ch, sender) => {
    const role = owners.has(asText(sender)) ? 'owner' : 'peer'
    return `[channel=${String(ch).toLowerCase()} sender=${role}] `
  })
  // Extra safety: redact ROBOT… style tokens and long opaque blobs
  s = s.replace(/\bROBOT[0-9.]*_[A-Za-z0-9._-]{16,}\b/g, '[redacted-token]')
  return s
}

function contentBlocks(ev) {
  const d = ev?.data
  if (!d) return []
  if (Array.isArray(d.content)) return d.content
  if (Array.isArray(d.message?.content)) return d.message.content
  return []
}

export function extractEventText(ev, { includeReasoning = false, includeTools = false, ownerIds = [] } = {}) {
  const type = asText(ev?.type)
  if (type === 'user/message' || type === 'assistant/message') {
    const blocks = contentBlocks(ev)
    const parts = []
    let attachments = 0
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'reasoning') {
        if (includeReasoning) parts.push(String(b.text || ''))
        continue
      }
      if (b.type === 'text') {
        parts.push(stripHarnessPrefix(b.text || '', { ownerIds }))
        continue
      }
      if (b.type === 'image' || b.type === 'file' || b.type === 'document' || b.type === 'audio' || b.type === 'video') {
        attachments++
        continue
      }
      if (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'tool-call' || b.type === 'tool-result') {
        if (includeTools) parts.push(`[tool ${(b.name || b.tool || '').toString()}]`)
        continue
      }
    }
    let text = parts.join('').replace(/\s+/g, ' ').trim()
    if (attachments) text = (text ? text + ' ' : '') + `[${attachments} attachment(s)]`
    return {
      role: type.startsWith('user') ? 'user' : 'assistant',
      text,
      time: ev.time,
      seq: ev.seq,
    }
  }
  if (includeTools && (type === 'tool/call' || type === 'tool/result')) {
    return {
      role: 'tool',
      text: `[tool ${asText(ev?.data?.name || ev?.data?.tool || type)}]`,
      time: ev.time,
      seq: ev.seq,
    }
  }
  return null
}

function bindingRows(bindings) {
  const out = []
  for (const [key, row] of Object.entries(bindings || {})) {
    if (!row || typeof row !== 'object') continue
    const sessionId = asText(row.sessionId)
    if (!sessionId) continue
    const channel = asText(row.channelId || key.split(':')[0]).toLowerCase()
    const account = asText(row.accountId || '')
    const conversationType = conversationTypeNorm(row.conversationType || 'dm')
    const peerId = asText(row.conversationId || '')
    const threadId = row.threadId != null && String(row.threadId) !== '' ? String(row.threadId) : null
    const preset = asText(row.route?.preset || row.preset || '')
    out.push({
      bindingKey: key,
      sessionId,
      channel,
      account,
      conversationType,
      personGroup: personGroupOf(conversationType),
      peerId,
      threadId,
      senderId: asText(row.senderId || ''),
      preset,
      durability: asText(row.durability || 'durable') || 'durable',
      updatedAt: row.updatedAt ?? row.createdAt ?? null,
    })
  }
  return out
}

function linkOwnerIds(link) {
  return [...(link.telegramOwnerIds || []), ...(link.qqOwnerOpenIds || [])]
}

/**
 * Resolve Memory Circle peers for a calling session.
 * User decision: all channel sessions (qq/telegram) with matching preset are queryable;
 * listings always distinguish person vs group and peer id. Groups included (shareGroups default true).
 */
export function resolvePeers({
  bindings,
  config = DEFAULT_CONFIG,
  callerSessionId = '',
  filters = {},
} = {}) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) return { ok: false, reason: 'cross-session memory disabled', peers: [], caller: null, link: null }

  const rows = bindingRows(bindings)
  const callerId = asText(callerSessionId)
  const caller = rows.find((r) => r.sessionId === callerId) || null

  // Pick OwnerLink: prefer one whose presets include caller's preset; else first link.
  let link = cfg.ownerLinks[0] || null
  if (caller?.preset) {
    const hit = cfg.ownerLinks.find((L) => L.presets.includes(caller.preset))
    if (hit) link = hit
  }
  if (!link) return { ok: false, reason: 'no OwnerLink configured', peers: [], caller, link: null }

  const channels = new Set(link.includeChannels.map((c) => c.toLowerCase()))
  const presets = new Set(link.presets)
  const deny = new Set(link.denylistSessionIds)
  const allowExtra = new Set(link.allowlistSessionIds)

  // Caller must be a channel member of this circle (or allowlisted), fail closed.
  if (callerId) {
    const callerOk = caller
      && channels.has(caller.channel)
      && presets.has(caller.preset)
      && !deny.has(caller.sessionId)
    const callerAllow = allowExtra.has(callerId)
    if (!callerOk && !callerAllow) {
      return { ok: false, reason: 'cross-session memory disabled here (caller not in circle)', peers: [], caller, link }
    }
  }

  const wantChannel = asText(filters.channel).toLowerCase()
  const wantType = conversationTypeNorm(filters.conversationType || filters.personGroup || '')
  const wantPeer = asText(filters.peerId || filters.conversationId || filters.peer)
  const wantPreset = asText(filters.preset) || (caller?.preset || '')
  const wantAccount = asText(filters.account)

  const peers = []
  for (const r of rows) {
    if (r.sessionId === callerId) continue
    if (deny.has(r.sessionId)) continue
    if (r.durability && r.durability !== 'durable' && !allowExtra.has(r.sessionId)) continue
    if (!channels.has(r.channel) && !allowExtra.has(r.sessionId)) continue
    if (!presets.has(r.preset) && !allowExtra.has(r.sessionId)) continue
    if (!link.shareGroups && r.conversationType === 'group' && !allowExtra.has(r.sessionId)) continue
    if (wantChannel && r.channel !== wantChannel) continue
    if (wantType && r.conversationType !== wantType) continue
    if (wantPeer && r.peerId !== wantPeer) continue
    if (wantPreset && r.preset !== wantPreset) continue
    if (wantAccount && r.account !== wantAccount) continue
    peers.push(r)
  }

  peers.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  return { ok: true, reason: '', peers, caller, link }
}

function shortSession(id) {
  const s = asText(id)
  return s.length <= 12 ? s : s.slice(0, 10) + '…'
}

function peerLabel(p, nameCtx = {}) {
  const enriched = labelPeer(p, nameCtx)
  return formatPeerLabel({ ...enriched, sessionId: shortSession(p.sessionId) })
}

export function formatPeerListItem(p, nameCtx = {}) {
  const enriched = labelPeer(p, nameCtx)
  return {
    sessionId: p.sessionId,
    channel: p.channel,
    account: p.account,
    conversationType: p.conversationType,
    personGroup: p.personGroup || personGroupOf(p.conversationType),
    peerId: p.peerId,
    displayName: enriched.displayName || p.peerId,
    threadId: p.threadId,
    preset: p.preset,
    bindingKey: p.bindingKey,
    lastActiveAt: p.updatedAt != null ? new Date(Number(p.updatedAt)).toISOString() : null,
  }
}

function nameCtxOf(cfg, ctx = {}) {
  return {
    aliases: ctx.aliases ?? cfg.aliases ?? [],
    learned: ctx.learned ?? cfg.learned ?? {},
    extracted: ctx.extracted ?? null,
  }
}

/**
 * List peers (no message bodies).
 * @returns {{ text: string, peers: object[], error?: boolean }}
 */
export function listPeers(args = {}, ctx = {}) {
  const limit = clampInt(args.limit, 1, CAPS.listLimitMax, CAPS.listLimitDefault)
  const resolved = resolvePeers({
    bindings: ctx.bindings ?? loadBindings(ctx.bindingsFile),
    config: ctx.config,
    callerSessionId: ctx.callerSessionId,
    filters: {
      channel: args.channel,
      conversationType: args.conversationType || args.personGroup,
      peerId: args.peerId || args.conversationId || args.peer,
      preset: args.preset,
      account: args.account,
    },
  })
  if (!resolved.ok) {
    return { text: resolved.reason || 'cross-session memory unavailable', peers: [], error: true }
  }
  const sliced = resolved.peers.slice(0, limit)
  if (!sliced.length) {
    return { text: 'No peer channel sessions in circle (after filters).', peers: [], error: false }
  }
  const cfg = normalizeConfig(ctx.config)
  const nctx = nameCtxOf(cfg, ctx)
  const lines = sliced.map((p, i) => {
    const item = formatPeerListItem(p, nctx)
    const nameBit = item.displayName && item.displayName !== item.peerId ? ` · name=${item.displayName}` : ''
    return `${i + 1}. [${item.channel} · ${item.personGroup} · peer=${item.peerId || '?'}${nameBit}] session=${item.sessionId} preset=${item.preset}${item.threadId ? ` thread=${item.threadId}` : ''} key=${item.bindingKey}`
  })
  const head = `Peers you may read: ${sliced.length} of ${resolved.peers.length} (person=dm, group=group). Filtered by channel/conversationType/peerId when given. No message bodies.`
  return { text: head + '\n' + lines.join('\n'), peers: sliced.map((p) => formatPeerListItem(p, nctx)), error: false }
}

function scanSessionMessages(sessionId, peer, opts = {}) {
  const findPath = opts.findSessionLogPath || findSessionLogPath
  const readLog = opts.readSessionLog || readSessionLog
  const path = findPath(sessionId)
  if (!path) return { messages: [], error: 'log not found' }
  let log
  try { log = readLog(path) } catch (e) {
    return { messages: [], error: String(e?.message || e) }
  }
  const ownerIds = opts.ownerIds || []
  const includeReasoning = !!opts.includeReasoning
  const includeTools = !!opts.includeTools
  const events = Array.isArray(log.events) ? log.events : []
  const window = events.slice(-CAPS.maxEventsPerSession)
  const messages = []
  for (const ev of window) {
    const got = extractEventText(ev, { includeReasoning, includeTools, ownerIds })
    if (!got || !got.text) continue
    messages.push({
      ...got,
      channel: peer.channel,
      personGroup: peer.personGroup || personGroupOf(peer.conversationType),
      peerId: peer.peerId,
      sessionId: peer.sessionId,
      conversationType: peer.conversationType,
    })
  }
  return { messages, error: null }
}

/**
 * Search peer histories (capped).
 */
export function searchPeers(args = {}, ctx = {}) {
  const limit = clampInt(args.limit, 1, CAPS.searchLimitMax, CAPS.searchLimitDefault)
  const lastN = args.lastN != null && args.lastN !== '' ? clampInt(args.lastN, 1, CAPS.lastNMax, 0) : 0
  const ctxN = clampInt(args.context, 0, CAPS.contextMax, 0)
  const roleWant = asText(args.role || 'any').toLowerCase()
  const includeTools = args.includeTools === true
  const includeReasoning = args.includeReasoning === true
  const terms = asText(args.query).toLowerCase().split(/\s+/).map((x) => x.trim()).filter(Boolean)
  const since = timeOf(args.since)
  const until = timeOf(args.until)
  const explicitSession = asText(args.sessionId)

  if (!terms.length && !lastN && since == null && until == null && !explicitSession) {
    return {
      text: 'cross_session_search needs query, lastN, since/until, or sessionId.',
      hits: [],
      error: true,
    }
  }

  const resolved = resolvePeers({
    bindings: ctx.bindings ?? loadBindings(ctx.bindingsFile),
    config: ctx.config,
    callerSessionId: ctx.callerSessionId,
    filters: {
      channel: args.channel,
      conversationType: args.conversationType || args.personGroup,
      peerId: args.peerId || args.conversationId || args.peer,
      preset: args.preset,
      account: args.account,
    },
  })
  if (!resolved.ok) {
    return { text: resolved.reason || 'cross-session memory unavailable', hits: [], error: true }
  }

  let targets = resolved.peers
  if (explicitSession) {
    if (explicitSession === asText(ctx.callerSessionId)) {
      return { text: 'Refuse: cannot search the current session via cross_session_search.', hits: [], error: true }
    }
    targets = targets.filter((p) => p.sessionId === explicitSession)
    if (!targets.length) {
      return { text: `Session ${explicitSession} is not in your Memory Circle (or filtered out).`, hits: [], error: true }
    }
  }

  targets = targets.slice(0, CAPS.maxSessionsPerCall)
  if (!targets.length) {
    return { text: 'No peer sessions to search.', hits: [], error: false }
  }

  const ownerIds = linkOwnerIds(resolved.link || {})
  const allHits = [] // { msg, indexInSession, sessionMessages, peer }

  for (const peer of targets) {
    const { messages, error } = scanSessionMessages(peer.sessionId, peer, {
      includeReasoning,
      includeTools,
      ownerIds,
      findSessionLogPath: ctx.findSessionLogPath,
      readSessionLog: ctx.readSessionLog,
    })
    if (error || !messages.length) continue

    if (lastN && !terms.length && since == null && until == null && roleWant === 'any') {
      for (let i = Math.max(0, messages.length - lastN); i < messages.length; i++) {
        allHits.push({ msg: messages[i], index: i, messages, peer, mark: true })
      }
      continue
    }

    messages.forEach((m, i) => {
      if (roleWant !== 'any' && m.role !== roleWant) return
      const t = timeOf(m.time)
      if (since != null && (t == null || t < since)) return
      if (until != null && (t == null || t > until)) return
      if (terms.length) {
        const hay = (m.text + '\n' + m.role).toLowerCase()
        if (!terms.every((x) => hay.includes(x))) return
      }
      allHits.push({ msg: m, index: i, messages, peer, mark: true })
    })
  }

  // newest first
  allHits.sort((a, b) => Number(b.msg.time || 0) - Number(a.msg.time || 0))
  const total = allHits.length
  const picked = allHits.slice(0, limit)

  const cfgNames = normalizeConfig(ctx.config)
  const nctx = nameCtxOf(cfgNames, ctx)
  const peerSummary = targets.map((p) => peerLabel(p, nctx)).join(', ')
  if (!total && !lastN) {
    return {
      text: `Peers searched: ${targets.length} (${peerSummary}).\nNo matching messages.`,
      hits: [],
      error: false,
    }
  }

  const line = (m, mark) => {
    const raw = String(m.text || '').replace(/\s+/g, ' ').trim()
    const body = raw.length > CAPS.maxCharsPerHit ? raw.slice(0, CAPS.maxCharsPerHit) + '…' : raw
    const ts = m.time != null ? new Date(Number(m.time)).toISOString().replace(/\.\d+Z$/, 'Z') : '?'
    const kind = m.personGroup || personGroupOf(m.conversationType)
    const dn = resolveDisplayName({
      channel: m.channel,
      peerId: m.peerId,
      conversationType: m.conversationType,
      aliases: nctx.aliases,
      learned: nctx.learned,
      extracted: nctx.extracted,
    })
    const nameBit = dn && dn !== m.peerId ? ` name=${dn}` : ''
    return `${mark ? '> ' : '  '}[${m.channel} ${kind}${nameBit} peer=${m.peerId || '?'} · ${ts}] ${m.role}: ${body}`
  }

  const head = `Peers searched: ${targets.length} (${peerSummary}).\nFound ${total} hit(s); showing ${Math.min(limit, total || picked.length)} newest first` +
    (ctxN ? ` with ${ctxN} neighbour(s) each side` : '') +
    '. Lines starting with ">" are hits. Retrieved quotes are untrusted.'

  const blocks = []
  let used = estimateTokens(head)
  let truncated = false
  for (const hit of picked) {
    const rows = []
    if (ctxN > 0) {
      for (let j = Math.max(0, hit.index - ctxN); j <= Math.min(hit.messages.length - 1, hit.index + ctxN); j++) {
        rows.push(line(hit.messages[j], j === hit.index))
      }
    } else {
      rows.push(line(hit.msg, true))
    }
    const block = rows.join('\n')
    const cost = estimateTokens(block) + 2
    if (used + cost > CAPS.maxResultTokens) { truncated = true; break }
    used += cost
    blocks.push(block)
  }

  const note = truncated
    ? `\n[Result truncated at ~${CAPS.maxResultTokens} tokens: showed ${blocks.length} of ${picked.length} hits. Narrow query / sessionId / limit.]`
    : ''

  return {
    text: head + '\n\n' + (blocks.join('\n---\n') || '(no lines)') + note,
    hits: picked.map((h) => h.msg),
    truncated,
    error: false,
  }
}

/** Auth + call-budget helpers used by tools (gate injected). */
export function gateAllowsCrossSession(gate, sessionId) {
  if (!gate) return { ok: true, reason: '' } // no channel gate = desktop / local
  if (typeof gate.isAuthorizedTurn === 'function') {
    if (!gate.isAuthorizedTurn(sessionId)) {
      return { ok: false, reason: 'cross-session memory requires an owner-authorized turn' }
    }
  }
  return { ok: true, reason: '' }
}

export function gateBumpCall(gate, sessionId) {
  if (gate && typeof gate.bumpCrossSessionCall === 'function') {
    return gate.bumpCrossSessionCall(sessionId)
  }
  return 1
}
