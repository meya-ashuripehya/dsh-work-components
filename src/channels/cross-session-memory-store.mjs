/**
 * Preset-keyed cross-session memory JSONL store.
 *
 * One file per Agent preset under ~/.dsh/channels-memory/presets/<preset>.jsonl.
 * Entries: message | compaction. Append-only messages; at most one compaction
 * (previous compaction line is rewritten out when a new one is appended).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHome } from '../session-controls/zstd-log.mjs'
import { estimateTokens } from './cross-session-memory.mjs'

export const STORE_CAPS = Object.freeze({
  /** Soft threshold: after append, if injectable corpus exceeds this, compact. */
  compactThresholdTokens: 24000,
  /** Hard cap for auto-inject block (compaction + other-session tail). */
  injectMaxTokens: 2000,
  /** Max chars kept per message line in the store / inject. */
  maxTextChars: 2000,
  /** Max messages fed into one compaction corpus. */
  compactMaxMessages: 400,
})

const CJK_SAFE = /[^a-zA-Z0-9._-]+/g

export function memoryRoot(home = dshHome()) {
  return join(home, 'channels-memory')
}

export function presetsDir(home = dshHome()) {
  return join(memoryRoot(home), 'presets')
}

/** Sanitize preset id for a filename. */
export function safePresetName(preset) {
  const s = String(preset || '').trim().toLowerCase()
  if (!s) return ''
  return s.replace(CJK_SAFE, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'preset'
}

export function presetMemoryPath(preset, home = dshHome()) {
  const name = safePresetName(preset)
  if (!name) return null
  return join(presetsDir(home), `${name}.jsonl`)
}

function asText(v) {
  return String(v ?? '').trim()
}

function clampText(text, max = STORE_CAPS.maxTextChars) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/** Serial queues per file path so concurrent appends don't interleave mid-rewrite. */
const queues = new Map()

function enqueue(path, fn) {
  const prev = queues.get(path) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(path, next.catch(() => {}))
  return next
}

/**
 * Parse jsonl; skip corrupt lines.
 * @returns {object[]}
 */
export function parseMemoryJsonl(raw) {
  const out = []
  for (const line of String(raw || '').split(/\n+/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object') out.push(o)
    } catch { /* skip */ }
  }
  return out
}

export function readPresetMemory(preset, { home, file } = {}) {
  const path = file || presetMemoryPath(preset, home)
  if (!path || !existsSync(path)) return []
  try {
    return parseMemoryJsonl(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

function ensureParent(path) {
  mkdirSync(join(path, '..'), { recursive: true })
}

/**
 * Append one JSON object as a line. Returns the written entry.
 */
export async function appendMemoryEntry(preset, entry, { home, file } = {}) {
  const path = file || presetMemoryPath(preset, home)
  if (!path) throw new Error('cross-session memory: empty preset')
  const id = asText(entry.id) || randomUUID()
  const type = asText(entry.type) || 'message'
  const time = Number.isFinite(Number(entry.time)) ? Number(entry.time) : Date.now()
  const presetId = asText(entry.preset) || asText(preset)
  const row = {
    id,
    type,
    time,
    preset: presetId,
  }
  if (type === 'message') {
    row.scene = entry.scene && typeof entry.scene === 'object' ? entry.scene : {}
    row.speaker = asText(entry.speaker) || 'unknown'
    row.role = asText(entry.role) || 'user'
    row.text = clampText(entry.text)
  } else if (type === 'compaction') {
    row.text = clampText(entry.text, STORE_CAPS.maxTextChars * 4)
    row.coversUntil = Number.isFinite(Number(entry.coversUntil)) ? Number(entry.coversUntil) : time
  } else {
    Object.assign(row, entry, { id, type, time, preset: presetId })
  }

  return enqueue(path, () => {
    ensureParent(path)
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
    return row
  })
}

/**
 * Rewrite file replacing all compaction entries with `next` (or none if null).
 * Message entries are preserved in order.
 */
export async function replaceCompaction(preset, next, { home, file } = {}) {
  const path = file || presetMemoryPath(preset, home)
  if (!path) throw new Error('cross-session memory: empty preset')
  return enqueue(path, () => {
    const entries = existsSync(path) ? parseMemoryJsonl(readFileSync(path, 'utf8')) : []
    const kept = entries.filter((e) => e?.type !== 'compaction')
    if (next) {
      const row = {
        id: asText(next.id) || randomUUID(),
        type: 'compaction',
        time: Number.isFinite(Number(next.time)) ? Number(next.time) : Date.now(),
        preset: asText(next.preset) || asText(preset),
        text: clampText(next.text, STORE_CAPS.maxTextChars * 4),
        coversUntil: Number.isFinite(Number(next.coversUntil))
          ? Number(next.coversUntil)
          : (Number.isFinite(Number(next.time)) ? Number(next.time) : Date.now()),
      }
      kept.push(row)
      ensureParent(path)
      const tmp = path + '.tmp'
      writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
      renameSync(tmp, path)
      return row
    }
    ensureParent(path)
    const tmp = path + '.tmp'
    writeFileSync(tmp, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '', 'utf8')
    renameSync(tmp, path)
    return null
  })
}

export function latestCompaction(entries) {
  let best = null
  for (const e of entries || []) {
    if (e?.type !== 'compaction') continue
    if (!best || Number(e.time || 0) >= Number(best.time || 0)) best = e
  }
  return best
}

export function messagesAfter(entries, coversUntil) {
  const cut = Number(coversUntil) || 0
  return (entries || []).filter((e) => e?.type === 'message' && Number(e.time || 0) > cut)
}

/** Format one message for inject / compaction corpus. */
export function formatMemoryLine(entry, { sceneSep = ' · ' } = {}) {
  if (!entry || entry.type === 'compaction') {
    return String(entry?.text || '').trim()
  }
  const scene = entry.scene || {}
  const parts = []
  const ch = asText(scene.channel) || asText(scene.roomId ? 'chatroom' : '')
  const peer = asText(scene.peerId) || asText(scene.roomId) || asText(scene.sessionId)
  if (ch || peer) parts.push([ch, peer].filter(Boolean).join(':'))
  parts.push(asText(entry.speaker) || asText(entry.role) || '?')
  const t = Number(entry.time)
  if (Number.isFinite(t) && t > 0) {
    try { parts.push(new Date(t).toISOString()) } catch { /* skip */ }
  }
  const head = parts.filter(Boolean).join(sceneSep)
  const body = clampText(entry.text, 800)
  return head ? `${head}${sceneSep}${body}` : body
}

/**
 * Build auto-inject block: latest compaction + uncompressed tail from OTHER sessions.
 * Does not replace DSH transcript — caller prepends as an extra text hint.
 *
 * @param {{
 *   preset: string,
 *   excludeSessionId?: string,
 *   excludeRoomId?: string,
 *   maxTokens?: number,
 *   home?: string,
 *   file?: string,
 *   entries?: object[],
 * }} opts
 * @returns {{ text: string, tokens: number, compaction: object|null, tailCount: number }}
 */
export function buildInjectBlock(opts = {}) {
  const preset = asText(opts.preset)
  if (!preset) return { text: '', tokens: 0, compaction: null, tailCount: 0 }
  const maxTokens = Math.max(200, Math.floor(Number(opts.maxTokens) || STORE_CAPS.injectMaxTokens))
  const entries = Array.isArray(opts.entries) ? opts.entries : readPresetMemory(preset, opts)
  const compaction = latestCompaction(entries)
  const coversUntil = compaction ? Number(compaction.coversUntil || compaction.time || 0) : 0
  const excludeSid = asText(opts.excludeSessionId)
  const excludeRoom = asText(opts.excludeRoomId)

  let tail = messagesAfter(entries, coversUntil).filter((m) => {
    const sid = asText(m.scene?.sessionId)
    const rid = asText(m.scene?.roomId)
    if (excludeSid && sid && sid === excludeSid) return false
    if (excludeRoom && rid && rid === excludeRoom) return false
    // Also drop current-session messages that share sessionId even if room differs
    if (excludeSid && sid === excludeSid) return false
    return true
  })
  // Chronological for reading; when trimming, drop oldest first
  tail.sort((a, b) => Number(a.time || 0) - Number(b.time || 0))

  const lines = []
  let tokens = 0

  if (compaction && asText(compaction.text)) {
    const block = `[cross-session-memory compaction]\n${asText(compaction.text)}`
    const n = estimateTokens(block)
    if (n <= maxTokens) {
      lines.push(block)
      tokens += n
    } else {
      // Compaction alone over cap: truncate
      const sliced = asText(compaction.text).slice(0, Math.max(200, (maxTokens - 20) * 2))
      const block2 = `[cross-session-memory compaction]\n${sliced}…`
      lines.push(block2)
      tokens = estimateTokens(block2)
      return { text: lines.join('\n\n'), tokens, compaction, tailCount: 0 }
    }
  }

  const kept = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = formatMemoryLine(tail[i])
    if (!line) continue
    const n = estimateTokens(line) + 1
    if (tokens + n > maxTokens) continue // skip this (older) line; try nothing older? actually we iterate newest-first so skip older
    kept.push(line)
    tokens += n
  }
  kept.reverse()
  if (kept.length) {
    lines.push(`[cross-session-memory tail · other sessions]\n` + kept.join('\n'))
  }

  const text = lines.join('\n\n').trim()
  if (!text) return { text: '', tokens: 0, compaction, tailCount: 0 }
  return {
    text: text.startsWith('[cross-session-memory') ? text : `[cross-session-memory]\n${text}`,
    tokens: estimateTokens(text),
    compaction,
    tailCount: kept.length,
  }
}

/**
 * Estimate tokens of compaction + uncompressed tail (all sessions) — trigger metric.
 */
export function estimateStoreCorpusTokens(entries) {
  const compaction = latestCompaction(entries)
  const coversUntil = compaction ? Number(compaction.coversUntil || compaction.time || 0) : 0
  let n = compaction ? estimateTokens(compaction.text) : 0
  for (const m of messagesAfter(entries, coversUntil)) {
    n += estimateTokens(formatMemoryLine(m))
  }
  return n
}

/**
 * If corpus over threshold, summarize and replace compaction.
 *
 * @param {{
 *   preset: string,
 *   threshold?: number,
 *   summarize: (args: { instruction: string, corpus: string, preset: string }) => Promise<string|null>,
 *   instruction: string,
 *   home?: string,
 *   file?: string,
 * }} opts
 */
export async function maybeCompactPreset(opts = {}) {
  const preset = asText(opts.preset)
  if (!preset || typeof opts.summarize !== 'function') {
    return { ok: false, skipped: true, reason: 'no-preset-or-summarize' }
  }
  const threshold = Math.max(1000, Math.floor(Number(opts.threshold) || STORE_CAPS.compactThresholdTokens))
  const path = opts.file || presetMemoryPath(preset, opts.home)
  const entries = readPresetMemory(preset, { file: path, home: opts.home })
  const tokens = estimateStoreCorpusTokens(entries)
  if (tokens < threshold) {
    return { ok: true, skipped: true, reason: 'under-threshold', tokens, threshold }
  }

  const compaction = latestCompaction(entries)
  const coversUntil = compaction ? Number(compaction.coversUntil || compaction.time || 0) : 0
  let msgs = messagesAfter(entries, coversUntil)
  if (msgs.length > STORE_CAPS.compactMaxMessages) {
    msgs = msgs.slice(-STORE_CAPS.compactMaxMessages)
  }
  if (!msgs.length && !compaction) {
    return { ok: true, skipped: true, reason: 'empty', tokens }
  }

  const corpusParts = []
  if (compaction?.text) {
    corpusParts.push('<compacted-summary>\n' + asText(compaction.text) + '\n</compacted-summary>')
  }
  for (const m of msgs) corpusParts.push(formatMemoryLine(m))
  const corpus = corpusParts.join('\n')
  const instruction = asText(opts.instruction) || 'Summarize the cross-session dialogue into a structured checkpoint.'

  let summary
  try {
    summary = await opts.summarize({ instruction, corpus, preset })
  } catch (e) {
    return { ok: false, skipped: false, reason: 'summarize-failed', error: String(e?.message || e).slice(0, 200), tokens }
  }
  summary = asText(summary)
  if (!summary) {
    return { ok: false, skipped: false, reason: 'empty-summary', tokens }
  }

  const now = Date.now()
  const row = await replaceCompaction(preset, {
    text: summary,
    time: now,
    coversUntil: now,
    preset,
  }, { home: opts.home, file: path })

  return { ok: true, skipped: false, reason: 'compacted', tokens, threshold, compaction: row }
}

/**
 * Convenience: append a tagged message then maybe schedule compaction.
 */
export async function appendTaggedMessage(preset, {
  scene,
  speaker,
  role = 'user',
  text,
  time,
  home,
  file,
  onAfterAppend,
} = {}) {
  if (!asText(preset) || !asText(text)) return null
  const entry = await appendMemoryEntry(preset, {
    type: 'message',
    scene: scene || {},
    speaker: asText(speaker) || asText(role) || 'unknown',
    role: asText(role) || 'user',
    text,
    time: time ?? Date.now(),
    preset,
  }, { home, file })
  if (typeof onAfterAppend === 'function') {
    try { await onAfterAppend(entry) } catch { /* never block */ }
  }
  return entry
}
