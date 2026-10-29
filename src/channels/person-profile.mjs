/**
 * Person-centric profile for cross-session memory:
 * - alias map (manual settings) + learned names from inbound / transcripts
 * - display-name resolution: manual > learned/extracted > raw id
 * - capped person summary for channel-turn inject
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../session-controls/zstd-log.mjs'

/** Local mirrors (avoid cycle with cross-session-memory.mjs). */
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

function personGroupOf(conversationType) {
  const t = String(conversationType ?? '').trim().toLowerCase()
  if (t === 'dm' || t === 'private' || t === 'c2c' || t === 'person') return 'person'
  if (t === 'group' || t === 'supergroup' || t === 'channel') return 'group'
  if (t === 'desktop') return 'desktop'
  if (t === 'room' || t === 'chatroom') return 'room'
  return t || 'unknown'
}

function conversationTypeNorm(conversationType) {
  const t = String(conversationType ?? '').trim().toLowerCase()
  if (t === 'person' || t === 'private' || t === 'c2c') return 'dm'
  if (t === 'supergroup' || t === 'channel') return 'group'
  return t
}

export const PERSON_SUMMARY_MAX_CHARS = 420
export const LEARNED_ALIASES_FILE = 'peer-aliases-learned.json'

const asText = (v) => String(v ?? '').trim()

export function aliasKey(channel, peerId, conversationType = '') {
  const ch = asText(channel).toLowerCase()
  const peer = asText(peerId)
  const kind = conversationTypeNorm(conversationType)
  if (!ch || !peer) return ''
  // Kind optional in key lookup — primary key is channel:peerId
  return kind ? `${ch}:${peer}:${kind}` : `${ch}:${peer}`
}

export function primaryAliasKey(channel, peerId) {
  const ch = asText(channel).toLowerCase()
  const peer = asText(peerId)
  return ch && peer ? `${ch}:${peer}` : ''
}

/**
 * Parse alias map from settings textarea / JSON.
 * Line forms (Chinese UI):
 *   telegram 6153059771 Shiro
 *   qq B4C6… Shiro
 *   telegram -1003435238151 家庭群 group
 *   telegram:6153059771=Shiro
 * Or one JSON array / one JSON object per line: { "channel","peerId","name","conversationType?" }
 * @returns {{ channel: string, peerId: string, conversationType: string, name: string }[]}
 */
export function parseAliasMap(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  // Whole-document JSON array / object map
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeAliasRow).filter(Boolean)
      }
      if (parsed && typeof parsed === 'object') {
        // { "telegram:6153": "Shiro" } or { aliases: [...] }
        if (Array.isArray(parsed.aliases)) {
          return parsed.aliases.map(normalizeAliasRow).filter(Boolean)
        }
        const out = []
        for (const [k, v] of Object.entries(parsed)) {
          if (k === 'aliases') continue
          const name = asText(v)
          if (!name) continue
          const m = /^([a-z0-9_-]+):(.+)$/i.exec(asText(k))
          if (m) out.push({ channel: m[1].toLowerCase(), peerId: m[2], conversationType: '', name })
        }
        return out
      }
    } catch {
      /* fall through to line parser */
    }
  }

  const out = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#') || s.startsWith('//')) continue
    if (s.startsWith('{')) {
      try {
        const row = normalizeAliasRow(JSON.parse(s))
        if (row) out.push(row)
      } catch { /* skip bad line */ }
      continue
    }
    // channel:peerId=name
    const eq = /^([a-z0-9_-]+):([^=\s]+)\s*=\s*(.+)$/i.exec(s)
    if (eq) {
      out.push({ channel: eq[1].toLowerCase(), peerId: eq[2], conversationType: '', name: asText(eq[3]) })
      continue
    }
    // channel peerId name [conversationType]
    const parts = s.split(/[\s,，\t]+/).filter(Boolean)
    if (parts.length >= 3) {
      const channel = parts[0].toLowerCase()
      const peerId = parts[1]
      let conversationType = ''
      let nameParts = parts.slice(2)
      const last = nameParts[nameParts.length - 1]?.toLowerCase()
      if (last === 'dm' || last === 'group' || last === 'person' || last === 'private' || last === 'c2c') {
        conversationType = conversationTypeNorm(last)
        nameParts = nameParts.slice(0, -1)
      }
      const name = nameParts.join(' ').trim()
      if (name) out.push({ channel, peerId, conversationType, name })
    }
  }
  return out.filter((r) => r.name)
}

function normalizeAliasRow(row) {
  if (!row || typeof row !== 'object') return null
  const channel = asText(row.channel).toLowerCase()
  const peerId = asText(row.peerId || row.conversationId || row.id)
  const name = asText(row.name || row.displayName || row.alias)
  if (!channel || !peerId || !name) return null
  return {
    channel,
    peerId,
    conversationType: conversationTypeNorm(row.conversationType || row.personGroup || ''),
    name,
  }
}

/** Serialize aliases for textarea (stable line form). */
export function formatAliasMap(aliases) {
  return (aliases || [])
    .map((r) => {
      const kind = r.conversationType ? ` ${r.conversationType}` : ''
      return `${r.channel} ${r.peerId} ${r.name}${kind}`
    })
    .join('\n')
}

export function aliasLookupMap(aliases) {
  const map = new Map()
  for (const r of aliases || []) {
    const name = asText(r.name)
    if (!name) continue
    const primary = primaryAliasKey(r.channel, r.peerId)
    if (primary) map.set(primary, name)
    const full = aliasKey(r.channel, r.peerId, r.conversationType)
    if (full) map.set(full, name)
  }
  return map
}

export function learnedAliasesPath(home = dshHome()) {
  return join(home, 'dsh-channels', LEARNED_ALIASES_FILE)
}

export function loadLearnedAliases(file = learnedAliasesPath()) {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

export function saveLearnedAlias(channel, peerId, name, file = learnedAliasesPath()) {
  const n = asText(name)
  const key = primaryAliasKey(channel, peerId)
  if (!key || !n) return false
  // Skip pure numeric / opaque ids mistaken as names
  if (n === asText(peerId)) return false
  if (/^-?\d{5,}$/.test(n) && n.length > 8) return false
  let cur = loadLearnedAliases(file)
  if (cur[key] === n) return false
  cur = { ...cur, [key]: n }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Extract display names from transcript message texts / structured hints.
 * Recognizes:
 *   [person-memory] … name=Foo …
 *   [channel=telegram sender=ID name=Foo …
 *   Telegram-ish "name=Foo" near sender=
 */
export function extractNamesFromMessages(messages, { channel = '', peerId = '' } = {}) {
  const found = new Map() // key -> name
  const push = (ch, peer, name) => {
    const n = asText(name)
    const p = asText(peer)
    const c = asText(ch).toLowerCase() || asText(channel).toLowerCase()
    if (!n || !p || !c) return
    if (n === p) return
    found.set(primaryAliasKey(c, p), n)
  }

  for (const m of messages || []) {
    const text = String(m?.text || m || '')
    // person-memory block
    const pm = /\[person-memory\]([^\]]*)\]?/i.exec(text)
    if (pm) {
      const body = pm[1] || ''
      const name = /(?:^|\s)name=([^\s\]]+)/i.exec(body)?.[1]
      const peer = /(?:^|\s)peer=([^\s\]]+)/i.exec(body)?.[1] || peerId
      const ch = /(?:^|\s)channel=([^\s\]]+)/i.exec(body)?.[1] || channel
      if (name) push(ch, peer, decodeAliasToken(name))
    }
    // metadata-style with name=
    const meta = /\[channel=([a-z0-9_-]+)\s+sender=([^\s\]]+)(?:\s+name=([^\s\]]+))?/gi
    let hit
    while ((hit = meta.exec(text))) {
      if (hit[3]) push(hit[1], hit[2], decodeAliasToken(hit[3]))
    }
    // Fallback: if message is from this peer session and carries a bare name= near start
    if (peerId) {
      const loose = /\bname=([^\s\[\]]{1,64})/i.exec(text)
      if (loose && channel) push(channel, peerId, decodeAliasToken(loose[1]))
    }
  }
  return found
}

function decodeAliasToken(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '))
  } catch {
    return String(s)
  }
}

/**
 * Resolve display name.
 * Priority: manual alias > learned file > extractedFromHistory map > liveHint > raw id
 */
export function resolveDisplayName({
  channel,
  peerId,
  conversationType = '',
  aliases = [],
  learned = null,
  extracted = null,
  liveName = '',
} = {}) {
  const peer = asText(peerId)
  if (!peer) return ''
  const manual = aliasLookupMap(aliases)
  const full = aliasKey(channel, peer, conversationType)
  const primary = primaryAliasKey(channel, peer)
  if (full && manual.has(full)) return manual.get(full)
  if (primary && manual.has(primary)) return manual.get(primary)

  const learnedMap = learned && typeof learned === 'object' ? learned : {}
  if (primary && learnedMap[primary]) return asText(learnedMap[primary])

  if (extracted instanceof Map) {
    if (primary && extracted.has(primary)) return extracted.get(primary)
  } else if (extracted && typeof extracted === 'object' && primary && extracted[primary]) {
    return asText(extracted[primary])
  }

  const live = asText(liveName)
  if (live && live !== peer) return live

  return peer
}

/**
 * Build OwnerLink overrides from flat settings fields.
 */
export function ownerLinkFromSettings(cfg = {}) {
  const tg = asText(cfg.crossSessionOwnerTelegramIds || cfg.telegramOwnerIds)
    .split(/[\s,，;；]+/).map(asText).filter(Boolean)
  const qq = asText(cfg.crossSessionOwnerQqOpenIds || cfg.qqOwnerOpenIds)
    .split(/[\s,，;；]+/).map(asText).filter(Boolean)
  const presets = asText(cfg.crossSessionPresets || '')
    .split(/[\s,，;；]+/).map(asText).filter(Boolean)
  const shareGroups = cfg.crossSessionShareGroups !== false
  const base = { ...DEFAULT_OWNER_LINK }
  return {
    ...base,
    id: asText(cfg.crossSessionOwnerLinkId) || base.id,
    telegramOwnerIds: tg.length ? tg : [...base.telegramOwnerIds],
    qqOwnerOpenIds: qq.length ? qq : [...base.qqOwnerOpenIds],
    presets: presets.length ? presets : [...base.presets],
    shareGroups,
  }
}

/**
 * Short person summary for prompt inject (capped).
 * Details remain behind cross_session_* tools.
 */
export function buildPersonSummary({
  channel,
  peerId,
  conversationType = '',
  senderId = '',
  liveName = '',
  aliases = [],
  learned = null,
  link = null,
  enabled = true,
} = {}) {
  if (!enabled) return ''
  const ch = asText(channel).toLowerCase()
  const peer = asText(peerId)
  if (!ch || !peer) return ''

  const kind = personGroupOf(conversationType || 'dm')
  const name = resolveDisplayName({
    channel: ch,
    peerId: peer,
    conversationType,
    aliases,
    learned,
    liveName,
  })
  const ownerIds = new Set([
    ...(link?.telegramOwnerIds || DEFAULT_OWNER_LINK.telegramOwnerIds),
    ...(link?.qqOwnerOpenIds || DEFAULT_OWNER_LINK.qqOwnerOpenIds),
  ].map(asText))
  const sender = asText(senderId) || peer
  const isOwner = ownerIds.has(sender) || ownerIds.has(peer)
  const display = name && name !== peer ? name : ''

  const parts = [
    `channel=${ch}`,
    `kind=${kind}`,
    `peer=${peer}`,
  ]
  if (display) parts.push(`name=${display.replace(/\s+/g, '_')}`)
  if (isOwner) parts.push('role=owner')
  else parts.push('role=peer')
  if (link?.id) parts.push(`circle=${link.id}`)

  let body = parts.join(' ')
  // One short Chinese hint for the model
  const hint = display
    ? `对方称呼「${display}」。跨通道细节请用 cross_session_list / cross_session_search，勿臆造。`
    : `尚无称呼映射（可在通道设置填写别名）。跨通道细节请用 cross_session_list / cross_session_search。`
  let text = `[person-memory] ${body} | ${hint}`
  if (text.length > PERSON_SUMMARY_MAX_CHARS) {
    text = text.slice(0, PERSON_SUMMARY_MAX_CHARS - 1) + '…'
  }
  return text
}

/**
 * Enrich a peer row with displayName for list/search labels.
 */
export function labelPeer(peer, { aliases = [], learned = null, extracted = null } = {}) {
  const displayName = resolveDisplayName({
    channel: peer.channel,
    peerId: peer.peerId,
    conversationType: peer.conversationType,
    aliases,
    learned,
    extracted,
  })
  return { ...peer, displayName }
}

export function formatPeerLabel(peer) {
  const kind = peer.personGroup || personGroupOf(peer.conversationType)
  const name = peer.displayName && peer.displayName !== peer.peerId
    ? ` name=${peer.displayName}`
    : ''
  const peerPart = peer.peerId ? ` peer=${peer.peerId}` : ''
  const th = peer.threadId ? ` thread=${peer.threadId}` : ''
  const sid = asText(peer.sessionId)
  const short = sid.length <= 12 ? sid : sid.slice(0, 10) + '…'
  return `${peer.channel} ${kind}${name}${peerPart}${th} ${short}`
}
