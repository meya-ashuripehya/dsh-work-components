/**
 * search_history：房间级内置只读工具。成员 AI 查找本房间较早的消息（尤其是已折叠进滚动摘要的部分）。
 * 只读当前房间的 messages.jsonl；可见性沿用 isPromptCandidate（忽略压缩隐藏标记），
 * 系统提示（含上下文压缩通知）、回收站卡片、失败 / 隐藏消息不返回；卡片只给标题，成员思考过程不在消息里，也从不返回。
 */
import { isPromptCandidate, estimateTokens } from './ctx-compress.mjs'
import { cardTitle } from './tool-results.mjs'

export const SEARCH_HISTORY_NAME = 'search_history'
export const SEARCH_HISTORY_MAX_TOKENS = 8000
const TEXT_CAP = 600

export const SEARCH_HISTORY = Object.freeze({
  name: SEARCH_HISTORY_NAME,
  description: 'Search older messages in this chat room (only this room), including messages that were folded into the earlier conversation summary. Returns matching messages newest first with seq, time, sender and text, plus nearby messages for context. Use it when you need exact details (names, numbers, decisions, quotes) that the summary may have dropped.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to find. Case-insensitive substring match; whitespace separates terms and every term must appear. Works with Chinese/Japanese text (no word segmentation needed). May be empty when other filters are given.' },
      sender: { type: 'string', description: 'Optional: only messages from this sender (member name, or "user" for the human owner).' },
      fromSeq: { type: 'integer', description: 'Optional: lowest message seq to include.' },
      toSeq: { type: 'integer', description: 'Optional: highest message seq to include.' },
      since: { type: 'string', description: 'Optional: ISO time; only messages at or after it.' },
      until: { type: 'string', description: 'Optional: ISO time; only messages at or before it.' },
      context: { type: 'integer', description: 'Optional: neighbouring messages to show on each side of a hit, 0-3 (default 1).' },
      limit: { type: 'integer', description: 'Optional: maximum hits to return, 1-20 (default 8).' },
    },
  },
})

const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
const timeOf = (v) => { if (v == null || v === '') return null; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null }

/** 消息在搜索中呈现的文字（与成员上下文同一口径：卡片只给标题）。 */
function bodyOf(m) {
  if (m.kind === 'tool') {
    const d = m.data || {}
    return '[card · ' + (d.title || cardTitle({ tool: m.tool, args: d.args, chars: d.chars, ok: d.ok !== false })) + ']'
  }
  if (m.kind === 'system') return String(m.aiText || m.text || '')
  const t = String(m.text || '').trim()
  const att = (m.attachments || []).length ? ' [' + m.attachments.length + ' attachment(s)]' : ''
  return (t || '') + att
}
function senderOf(m, userName) {
  if (m.kind === 'user') return userName || 'user'
  if (m.kind === 'system') return 'room'
  return m.speaker?.name || '?'
}

/** 可被搜索的消息：成员能看到的那些（压缩隐藏的仍可搜，回收站卡片不可）。 */
export function searchableMessages(messages, { binned } = {}) {
  const bin = binned instanceof Set ? binned : new Set(binned || [])
  return (messages || []).filter((m) => {
    if (!m || m.notice === 'ctx-compress' || m.ephemeral || m.pending) return false
    if (m.kind === 'tool' && m.id && bin.has(m.id)) return false
    return isPromptCandidate({ ...m, contextHidden: false }, 0)
  })
}

/**
 * 纯函数：执行搜索，返回给模型的文字与统计。
 * @returns {{ text: string, total: number, shown: number, truncated: boolean }}
 */
export function searchHistory(messages, args = {}, { userName = '用户', binned } = {}) {
  const list = searchableMessages(messages, { binned })
  const terms = String(args.query || '').toLowerCase().split(/\s+/).map((x) => x.trim()).filter(Boolean)
  const senderQ = String(args.sender || '').trim().toLowerCase()
  const fromSeq = Number(args.fromSeq) > 0 ? Math.floor(Number(args.fromSeq)) : 0
  const toSeq = Number(args.toSeq) > 0 ? Math.floor(Number(args.toSeq)) : 0
  const since = timeOf(args.since), until = timeOf(args.until)
  const ctxN = clampInt(args.context, 0, 3, 1)
  const limit = clampInt(args.limit, 1, 20, 8)
  if (!terms.length && !senderQ && !fromSeq && !toSeq && since == null && until == null) {
    return { text: 'search_history needs a query or at least one filter (sender, fromSeq/toSeq, since/until).', total: 0, shown: 0, truncated: false, error: true }
  }
  const userKeys = new Set(['user', 'owner', '用户', String(userName || '').toLowerCase()].filter(Boolean))
  const hits = []
  list.forEach((m, i) => {
    const seq = Number(m.seq) || 0
    if (fromSeq && seq < fromSeq) return
    if (toSeq && seq > toSeq) return
    const t = timeOf(m.ts)
    if (since != null && (t == null || t < since)) return
    if (until != null && (t == null || t > until)) return
    if (senderQ) {
      const name = String(m.speaker?.name || '').toLowerCase()
      const ok = m.kind === 'user' ? (userKeys.has(senderQ) || name === senderQ) : (name === senderQ || String(m.speaker?.id || '').toLowerCase() === senderQ)
      if (!ok) return
    }
    if (terms.length) {
      const hay = (bodyOf(m) + '\n' + senderOf(m, userName)).toLowerCase()
      if (!terms.every((x) => hay.includes(x))) return
    }
    hits.push(i)
  })
  const total = hits.length
  if (!total) return { text: 'No matching messages in this room.', total: 0, shown: 0, truncated: false }
  const picked = hits.slice(-limit).reverse() // newest first
  const line = (m, mark) => {
    const raw = bodyOf(m).replace(/\s+/g, ' ').trim()
    const body = raw.length > TEXT_CAP ? raw.slice(0, TEXT_CAP) + '…' : raw
    return (mark ? '> ' : '  ') + '#' + (m.seq ?? '?') + ' ' + String(m.ts || '').replace(/\.\d+Z$/, 'Z') + ' [' + senderOf(m, userName) + '] ' + body
  }
  const head = 'Found ' + total + ' matching message(s) in this room; showing ' + Math.min(limit, total) + ' newest first' + (ctxN ? ' with ' + ctxN + ' neighbour(s) each side' : '') + '. Lines starting with ">" are hits.'
  const blocks = []
  let used = estimateTokens(head), truncated = false
  for (const i of picked) {
    const rows = []
    for (let j = Math.max(0, i - ctxN); j <= Math.min(list.length - 1, i + ctxN); j++) rows.push(line(list[j], j === i))
    const block = rows.join('\n')
    const cost = estimateTokens(block) + 2
    if (used + cost > SEARCH_HISTORY_MAX_TOKENS) { truncated = true; break }
    used += cost
    blocks.push(block)
  }
  const note = truncated ? '\n[Result truncated at ~' + SEARCH_HISTORY_MAX_TOKENS + ' tokens: showed ' + blocks.length + ' of ' + picked.length + ' hits. Narrow the query or use fromSeq/toSeq/limit.]' : ''
  return { text: head + '\n\n' + blocks.join('\n---\n') + note, total, shown: blocks.length, truncated }
}