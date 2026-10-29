/**
 * Official DSH compaction shadows earlier surface nodes behind a compact-checkpoint
 * replacement, but the append-only session log keeps every raw event.
 * These helpers recover that pre-compaction transcript for a model-facing tool.
 */
export const SEARCH_PRE_COMPACTION_NAME = 'search_pre_compaction'
export const SEARCH_PRE_COMPACTION_MAX_TOKENS = 8000
const TEXT_CAP = 800
const TOOL_CAP = 400

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])

export function isCompactCheckpointEvent(event) {
  return event?.type === 'user/message'
    && event?.data?.source?.kind === 'compact-checkpoint'
    && event?.surfaceOp
    && typeof event.surfaceOp === 'object'
    && event.surfaceOp.op === 'replace'
}

export function isAppendSurfaceEvent(event) {
  if (!event || !SURFACE_TYPES.has(event.type)) return false
  return event.surfaceOp === 'append' || event.surfaceOp == null
}

function contentBlocks(event) {
  if (event.type === 'user/message') return event.data?.content
  return event.data?.message?.content
}

/** Visible text for search / display. Tool results are truncated harder. */
export function bodyOfEvent(event) {
  const blocks = contentBlocks(event)
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      const t = String(block.text ?? '').trim()
      if (t) parts.push(t)
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name || block.toolName || '?'}]`)
    } else if (block.type === 'image' || block.type === 'file') {
      parts.push(`[${block.type}]`)
    } else if (block.type === 'tool-result' || block.type === 'tool_result') {
      const raw = String(block.content ?? block.text ?? JSON.stringify(block)).trim()
      parts.push(raw.length > TOOL_CAP ? raw.slice(0, TOOL_CAP) + '…' : raw)
    }
  }
  if (event.type === 'tool/result' && !parts.length) {
    const raw = JSON.stringify(event.data?.message ?? event.data ?? '').trim()
    return raw.length > TOOL_CAP ? raw.slice(0, TOOL_CAP) + '…' : raw
  }
  let text = parts.join('\n').trim()
  if (event.type === 'tool/result' && text.length > TOOL_CAP) text = text.slice(0, TOOL_CAP) + '…'
  return text
}

function roleOf(event) {
  if (event.type === 'user/message') {
    if (event.data?.source?.kind === 'compact-checkpoint') return 'compact-checkpoint'
    return 'user'
  }
  if (event.type === 'assistant/message') return 'assistant'
  if (event.type === 'tool/result') return 'tool'
  if (event.type === 'system/message') return 'system'
  if (event.type === 'developer/message') return 'developer'
  return event.type
}

/**
 * Collect compact-checkpoint replacements and the append-origin events they shadowed.
 * Later checkpoints may re-shadow earlier ones; each event is attributed to the
 * latest checkpoint whose replace range covers it.
 */
export function collectPreCompactionCorpus(events) {
  const list = Array.isArray(events) ? events : []
  const checkpoints = []
  for (const ev of list) {
    if (!isCompactCheckpointEvent(ev)) continue
    const startSeq = Number(ev.surfaceOp.startSeq)
    const endSeq = Number(ev.surfaceOp.endSeq)
    if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq) || endSeq < startSeq) continue
    const summaryEv = list.find((e) => e.type === 'compaction/summary'
      && e.data?.compactionId === ev.data?.source?.compactionId)
    const summaryRaw = summaryEv?.data?.summary
    let summaryPreview = ''
    if (Array.isArray(summaryRaw)) {
      summaryPreview = summaryRaw.map((b) => (b && b.type === 'text' ? String(b.text || '') : '')).filter(Boolean).join('\n')
    } else if (typeof summaryRaw === 'string') {
      summaryPreview = summaryRaw
    } else if (summaryRaw && typeof summaryRaw === 'object' && typeof summaryRaw.text === 'string') {
      summaryPreview = summaryRaw.text
    } else {
      summaryPreview = bodyOfEvent(ev)
    }
    checkpoints.push({
      compactionId: String(ev.data.source.compactionId || ''),
      checkpointSeq: ev.seq,
      startSeq,
      endSeq,
      shadowedCount: 0,
      summaryPreview: String(summaryPreview).replace(/\s+/g, ' ').trim().slice(0, 240),
      shadowedTokenCount: summaryEv?.data?.shadowedTokenCount,
    })
  }
  // Newest checkpoint wins for overlapping coverage.
  const ordered = [...checkpoints].sort((a, b) => b.checkpointSeq - a.checkpointSeq)
  const covered = new Map() // seq -> checkpoint meta
  for (const cp of ordered) {
    for (let seq = cp.startSeq; seq <= cp.endSeq; seq++) {
      if (!covered.has(seq)) covered.set(seq, cp)
    }
  }
  const entries = []
  for (const ev of list) {
    if (!isAppendSurfaceEvent(ev)) continue
    if (!SURFACE_TYPES.has(ev.type)) continue
    // Skip empty / pure structural noise with no searchable body.
    const body = bodyOfEvent(ev)
    if (!body) continue
    // Skip the checkpoint carrier itself if it were ever append (it is not).
    if (ev.data?.source?.kind === 'compact-checkpoint') continue
    const cp = covered.get(ev.seq)
    if (!cp) continue
    // Only events that are no longer on the live surface matter: if still on surface,
    // the model can already see them via deriveMessages. We approximate "shadowed"
    // as "covered by a later compact-checkpoint replace range".
    entries.push({
      seq: ev.seq,
      type: ev.type,
      role: roleOf(ev),
      body,
      compactionId: cp.compactionId,
      checkpointSeq: cp.checkpointSeq,
      rangeStart: cp.startSeq,
      rangeEnd: cp.endSeq,
    })
  }
  // Fix shadowedCount: recount properly (above increments once per entry attributed)
  for (const cp of checkpoints) {
    cp.shadowedCount = entries.filter((e) => e.compactionId === cp.compactionId && e.checkpointSeq === cp.checkpointSeq).length
  }
  return { checkpoints, entries }
}

const clampInt = (v, lo, hi, d) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

function estimateTokens(text) {
  const s = String(text || '')
  // Rough mix of CJK + ASCII; same spirit as chatroom estimateTokens.
  let cjk = 0
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++
  }
  return Math.ceil(cjk + (s.length - cjk) / 4)
}

/**
 * @returns {{ text: string, total: number, shown: number, truncated: boolean, error?: boolean, checkpoints?: number }}
 */
export function searchPreCompaction(events, args = {}) {
  const { checkpoints, entries } = collectPreCompactionCorpus(events)
  if (args.listCheckpoints === true || args.list === true) {
    if (!checkpoints.length) {
      return { text: 'No official compaction checkpoints in this session log. Nothing has been compact-shadowed yet.', total: 0, shown: 0, truncated: false, checkpoints: 0 }
    }
    const lines = checkpoints.map((cp) => {
      const tok = cp.shadowedTokenCount != null ? `, ~${cp.shadowedTokenCount} tokens` : ''
      return `- checkpointSeq=#${cp.checkpointSeq} id=${cp.compactionId || '?'} range=#${cp.startSeq}-#${cp.endSeq} recoverable=${cp.shadowedCount}${tok}\n  summary: ${cp.summaryPreview || '(none)'}`
    })
    return {
      text: `Found ${checkpoints.length} compact-checkpoint(s). Raw shadowed turns remain in the session log; use search_pre_compaction with a query (or fromSeq/toSeq) to read them.\n\n${lines.join('\n')}`,
      total: checkpoints.length,
      shown: checkpoints.length,
      truncated: false,
      checkpoints: checkpoints.length,
    }
  }

  if (!entries.length) {
    return {
      text: checkpoints.length
        ? 'Compaction checkpoints exist, but no recoverable append-origin text was found in shadowed ranges.'
        : 'No pre-compaction history: this session has no compact-checkpoint replacements yet.',
      total: 0,
      shown: 0,
      truncated: false,
      checkpoints: checkpoints.length,
    }
  }

  const terms = String(args.query || '').toLowerCase().split(/\s+/).map((x) => x.trim()).filter(Boolean)
  const roleQ = String(args.role || '').trim().toLowerCase()
  const fromSeq = Number(args.fromSeq) > 0 ? Math.floor(Number(args.fromSeq)) : 0
  const toSeq = Number(args.toSeq) > 0 ? Math.floor(Number(args.toSeq)) : 0
  const compactionId = String(args.compactionId || '').trim()
  const ctxN = clampInt(args.context, 0, 3, 1)
  const limit = clampInt(args.limit, 1, 20, 8)

  if (!terms.length && !roleQ && !fromSeq && !toSeq && !compactionId) {
    return {
      text: 'search_pre_compaction needs a query, listCheckpoints=true, or at least one filter (role, fromSeq/toSeq, compactionId).',
      total: 0,
      shown: 0,
      truncated: false,
      error: true,
      checkpoints: checkpoints.length,
    }
  }

  const hits = []
  entries.forEach((m, i) => {
    if (fromSeq && m.seq < fromSeq) return
    if (toSeq && m.seq > toSeq) return
    if (compactionId && m.compactionId !== compactionId) return
    if (roleQ && m.role !== roleQ && m.type !== roleQ) return
    if (terms.length) {
      const hay = (m.body + '\n' + m.role).toLowerCase()
      if (!terms.every((t) => hay.includes(t))) return
    }
    hits.push(i)
  })

  const total = hits.length
  if (!total) {
    return { text: 'No matching pre-compaction messages in shadowed ranges.', total: 0, shown: 0, truncated: false, checkpoints: checkpoints.length }
  }

  const picked = hits.slice(-limit).reverse()
  const line = (m, mark) => {
    const raw = m.body.replace(/\s+/g, ' ').trim()
    const body = raw.length > TEXT_CAP ? raw.slice(0, TEXT_CAP) + '…' : raw
    return (mark ? '> ' : '  ') + '#' + m.seq + ' [' + m.role + '] ' + body
  }
  const head = `Found ${total} matching pre-compaction message(s) (official compact-shadowed log); showing ${Math.min(limit, total)} newest first`
    + (ctxN ? ` with ${ctxN} neighbour(s) each side` : '')
    + `. Lines starting with ">" are hits. These events are still in the session log but absent from the model-visible surface.`
  const blocks = []
  let used = estimateTokens(head)
  let truncated = false
  for (const i of picked) {
    const rows = []
    for (let j = Math.max(0, i - ctxN); j <= Math.min(entries.length - 1, i + ctxN); j++) {
      rows.push(line(entries[j], j === i))
    }
    const block = rows.join('\n')
    const cost = estimateTokens(block) + 2
    if (used + cost > SEARCH_PRE_COMPACTION_MAX_TOKENS) { truncated = true; break }
    used += cost
    blocks.push(block)
  }
  const note = truncated
    ? `\n[Result truncated at ~${SEARCH_PRE_COMPACTION_MAX_TOKENS} tokens: showed ${blocks.length} of ${picked.length} hits. Narrow the query or use fromSeq/toSeq/limit.]`
    : ''
  return {
    text: head + '\n\n' + blocks.join('\n---\n') + note,
    total,
    shown: blocks.length,
    truncated,
    checkpoints: checkpoints.length,
  }
}

/**
 * Resolve events from a live agent session or a plain array (tests / disk).
 */
export function eventsFromExec(exec) {
  const session = exec?.agent?.session
  if (session && typeof session.snapshotEvents === 'function') {
    return session.snapshotEvents()
  }
  if (Array.isArray(exec?.events)) return exec.events
  return null
}
