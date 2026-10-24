/**
 * Chatroom rolling context summary (滚动摘要):
 *   Model prompt = roomRules + one total summary + recent non-hidden window (~24).
 *   Auto-compress when estimated history tokens >= threshold (default 200k).
 *   Compacted messages stay on disk / in the UI; AIs skip them (contextHidden / untilSeq).
 *   Summarizer uses an independent small-model provider/model (via DSH llm); if unset,
 *   auto-compress is skipped and manual compress reports 未配置.
 */
import { randomUUID } from 'node:crypto'
import { cardTitle } from './tool-results.mjs'
import { hiddenFromAi } from './card-bin.mjs'
import { parseOwnerCommand } from './directives.mjs'

/** Mirror transcript.isBudgetChatter (avoid circular import with transcript). */
function isBudgetChatter(m) {
  if (m.budgetReport) return true
  const t = String(m.text || '')
  if (m.kind === 'user' && (m.owner || m.speaker?.id === 'user') && parseOwnerCommand(t)?.kind === 'approve') return true
  if (m.kind === 'seat' && (/批准\s*[+＋]\s*(?:N|\d)/i.test(t) || /预估还需(?:的)?(?:轮次|回合)|回合预算|turn budget/i.test(t))) return true
  return false
}

const isFailedTool = (m) => m.kind === 'tool' && !!m.data && !m.data.cursorTask && (m.data.ok === false || !!m.data.blocked || !!m.data.denied)

export const DEFAULT_HISTORY_WINDOW = 24
export const DEFAULT_TOKEN_THRESHOLD = 150000
/** Fixed per-image token estimate (real images sent to vision models). */
export const IMAGE_TOKENS = 1500
/** Auto-compress never waits past this share of a model's known context window. */
export const CONTEXT_WINDOW_SHARE = 0.75
/** Shown when no summarizer model is selected (auto and manual compress). */
export const UNCONFIGURED_NOTICE = '自动压缩未启用：请选择摘要模型'
export const SUMMARY_MAX_CHARS = 6000
export const SUMMARY_MAX_TOKENS = 2048

const CJK_RE = /[\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g

/** Cheap token estimate: CJK chars ~1 token each, other text ~4 chars/token. */
export function estimateTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  const cjk = (s.match(CJK_RE) || []).length
  return Math.ceil(cjk + (s.length - cjk) / 4)
}

// Keys that carry ids / binary payloads rather than prompt text.
const SKIP_KEYS = new Set(['id', 'toolCallId', 'data', 'base64', 'url', 'uri', 'mediaType', 'mimeType', 'replayState', 'source', 'role', 'type'])

function walkTokens(v, depth = 0) {
  if (v == null || depth > 12) return 0
  if (typeof v === 'string') return estimateTokens(v)
  if (typeof v === 'number' || typeof v === 'boolean') return 1
  if (Array.isArray(v)) { let n = 0; for (const x of v) n += walkTokens(x, depth + 1); return n }
  if (typeof v !== 'object') return 0
  if (v.type === 'image' || v.type === 'image_url' || (typeof v.mediaType === 'string' && /^image\//.test(v.mediaType))) return IMAGE_TOKENS
  let n = 0
  for (const [k, x] of Object.entries(v)) {
    if (SKIP_KEYS.has(k)) continue
    if (k === 'images' && Array.isArray(x)) { n += x.length * IMAGE_TOKENS; continue }
    n += walkTokens(x, depth + 1)
  }
  return n
}

/**
 * Estimate one model request: system prompt (persona + room rules) + built messages
 * (including tool JSON, in-turn tool results, images) + tool schemas.
 */
export function estimateRequestTokens({ system = '', messages = [], tools = [] } = {}) {
  let n = estimateTokens(system)
  for (const m of messages || []) n += 4 + walkTokens(m)
  if (Array.isArray(tools) && tools.length) {
    let s = ''
    try { s = JSON.stringify(tools) } catch { s = '' }
    n += estimateTokens(s)
  }
  return n
}

/** Auto-compress threshold for one member: min(setting, 75% of the model's context window if known). */
export function effectiveThreshold(setting, contextWindow = 0) {
  const base = Math.max(1000, Math.floor(Number(setting) || DEFAULT_TOKEN_THRESHOLD))
  const cw = Math.floor(Number(contextWindow) || 0)
  return cw > 0 ? Math.max(1000, Math.min(base, Math.floor(cw * CONTEXT_WINDOW_SHARE))) : base
}

const hasAtt = (m) => (Array.isArray(m.attachments) && m.attachments.length > 0) || (Array.isArray(m.videoLinks) && m.videoLinks.length > 0)

/** Messages that can enter the AI prompt (before window / summary injection). */
export function isPromptCandidate(m, untilSeq = 0) {
  if (!m) return false
  if (m.contextHidden === true) return false
  if (untilSeq > 0 && Number(m.seq) > 0 && Number(m.seq) <= untilSeq) return false
  if (isBudgetChatter(m)) return false
  const ok = new Set(['ok', 'stopped'])
  if ((m.kind === 'user' || m.kind === 'seat' || m.kind === 'brief') && ok.has(m.status || 'ok') && (String(m.text || '').trim() || hasAtt(m))) return true
  if (m.kind === 'system' && (m.game === true || m.aiVisible === true) && String(m.aiText || m.text || '').trim()) return true
  if (m.kind === 'tool' && !hiddenFromAi(m)) return true
  return false
}

/** One-line form for summarizer input (cards → title only). */
export function compressLine(m, userName = '用户') {
  if (!m) return ''
  if (m.kind === 'tool') {
    const d = m.data || {}
    const title = d.title || cardTitle({ tool: m.tool, args: d.args, chars: d.chars, ok: d.ok !== false })
    const who = m.speaker?.name || '?'
    return '[card by ' + who + ' · ' + title + ']'
  }
  if (m.kind === 'system') return ('[聊天室] ' + (m.aiText || m.text || '')).slice(0, 500)
  if (m.kind === 'brief') return '[' + (m.speaker?.name || '?') + '] (Cursor brief #' + m.briefId + ') ' + String(m.text || '').slice(0, 400)
  const who = m.speaker?.name || (m.kind === 'user' ? userName : '?')
  const text = String(m.text || '').replace(/\s+/g, ' ').trim()
  return '[' + who + '] ' + text.slice(0, 800) + (text.length > 800 ? '…' : '')
}

/** Token estimate for threshold checks (fuller than summarizer input lines). */
export function estimateMessageTokens(m, userName = '用户') {
  if (!m) return 0
  if (m.kind === 'tool') {
    // Same body the prompt sends (transcript.lineOf): cards → one line, other tools → JSON up to 12,000 chars.
    if (m.data?.resultId || m.data?.cursorTask) return estimateTokens(compressLine(m, userName))
    let body = ''
    try { body = JSON.stringify(m.data ?? null) } catch { body = '' }
    return estimateTokens(String(m.text || '') + body.slice(0, 12000))
  }
  if (m.kind === 'system') return estimateTokens(String(m.aiText || m.text || ''))
  return estimateTokens(String(m.text || '')) + (Array.isArray(m.attachments) ? m.attachments.length * 20 : 0)
}

export function estimateHistoryTokens(messages, { untilSeq = 0, summary = '', userName = '用户' } = {}) {
  let n = estimateTokens(summary)
  for (const m of messages || []) {
    if (!isPromptCandidate(m, untilSeq)) continue
    if (isFailedTool(m)) continue
    n += estimateMessageTokens(m, userName)
  }
  return n
}

export function summarizerConfigured(settings = {}) {
  return !!(String(settings.provider || '').trim() && String(settings.model || '').trim())
}

/**
 * Plan what falls out of the recent window.
 * @returns {{ falling: object[], keep: object[], untilSeq: number, empty: boolean }}
 */
export function planCompress(messages, { window = DEFAULT_HISTORY_WINDOW, untilSeq = 0 } = {}) {
  const win = Math.max(0, Math.floor(Number(window) || 0))
  const visible = (messages || []).filter((m) => isPromptCandidate(m, untilSeq))
  if (win <= 0 || visible.length <= win) {
    return { falling: [], keep: visible, untilSeq: untilSeq || 0, empty: true }
  }
  const falling = visible.slice(0, visible.length - win)
  const keep = visible.slice(visible.length - win)
  const nextUntil = falling.reduce((a, m) => Math.max(a, Number(m.seq) || 0), untilSeq || 0)
  return { falling, keep, untilSeq: nextUntil, empty: falling.length === 0 }
}

export function buildSummarizerPrompt({ priorSummary = '', falling = [], userName = '用户' } = {}) {
  const lines = []
  if (String(priorSummary || '').trim()) {
    lines.push('Previous rolling summary:', String(priorSummary).trim(), '')
  }
  lines.push('Messages to fold into the rolling summary (oldest first; tool cards are title-only):')
  for (const m of falling) {
    const line = compressLine(m, userName)
    if (line) lines.push(line)
  }
  const system = 'You maintain one brief rolling summary of a multi-AI house group chat for later model context. ' +
    'Merge the previous summary (if any) with the new messages. Keep names, decisions, open tasks, constraints, and key facts. ' +
    'Drop chatter, repeated jokes, and tool noise. Plain text only, no markdown headings, at most ' +
    SUMMARY_MAX_CHARS +
    ' characters. Write in Chinese unless the chat is clearly another language.'
  return { system, user: lines.join('\n').slice(0, 120000) }
}

/**
 * Request ceiling for the summarizer call. DSH has no per-request reasoning budget, and
 * reasoning models spend maxTokens on thinking first; so the request allows a generous
 * reasoning allowance and the answer-text cap (SUMMARY_MAX_TOKENS) is enforced locally.
 */
export const SUMMARY_REASONING_ALLOWANCE = 30000
export const SUMMARY_EMPTY_ERROR = '摘要模型未返回正文'

export async function streamSummary(llm, { provider, model, system, user, maxTokens = SUMMARY_MAX_TOKENS, reasoningAllowance = SUMMARY_REASONING_ALLOWANCE, signal, onDelta, onReasoning }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 服务商服务不可用（ctx.llm 未就绪）')
  const textCap = Math.max(1, Math.floor(Number(maxTokens) || SUMMARY_MAX_TOKENS))
  const local = new AbortController()
  const merged = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, local.signal]) : (signal || local.signal)
  let text = ''
  let reasoningChars = 0
  let capped = false
  const stream = llm.stream({
    provider, model, system, signal: merged,
    maxTokens: textCap + Math.max(0, Math.floor(Number(reasoningAllowance) || 0)),
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }],
  })
  try {
    for await (const c of stream) {
      if (c.type === 'text-delta' && c.text) {
        text += c.text
        if (typeof onDelta === 'function') { try { onDelta(c.text) } catch {} }
        if (estimateTokens(text) >= textCap) { capped = true; break }
      } else if (c.type === 'reasoning-delta') {
        const piece = String(c.text || c.delta || '')
        reasoningChars += piece.length || 1
        if (piece && typeof onReasoning === 'function') { try { onReasoning(piece) } catch {} }
      } else if (c.type === 'finish') {
        const r = c.reason || {}
        if (r.kind === 'error') throw new Error(r.failure?.message || r.failure?.code || '摘要模型请求失败')
        if (r.kind === 'aborted') {
          if (capped || (local.signal.aborted && !signal?.aborted)) break
          throw Object.assign(new Error('已停止'), { aborted: true })
        }
        break
      }
    }
  } catch (e) {
    // Our own cap abort surfaces as an error from some streams; keep the text so far.
    if (!(capped || (local.signal.aborted && !signal?.aborted))) throw e
  } finally {
    if (capped && !local.signal.aborted) { try { local.abort() } catch {} }
  }
  if (signal?.aborted) throw Object.assign(new Error('已停止'), { aborted: true })
  const out = String(text || '').trim().slice(0, SUMMARY_MAX_CHARS)
  if (!out) {
    throw new Error(reasoningChars > 0
      ? SUMMARY_EMPTY_ERROR + '：模型仅输出了推理内容，未生成摘要正文。'
      : SUMMARY_EMPTY_ERROR + '。')
  }
  return out
}

/**
 * @param {{ store, getLlm: () => any, getSettings: () => { provider, model, window, threshold, userName }, emit?: Function, now?: () => number }} opts
 */
export function createCompressor(opts) {
  const store = opts.store
  const getLlm = opts.getLlm || (() => null)
  const getSettings = opts.getSettings || (() => ({}))
  const emit = opts.emit || (() => {})
  const now = opts.now || (() => Date.now())
  const locks = new Map()

  function readSummary(meta) {
    const s = meta?.contextSummary
    if (!s || typeof s !== 'object') return { text: '', untilSeq: 0, at: '' }
    return {
      text: String(s.text || '').trim(),
      untilSeq: Math.max(0, Math.floor(Number(s.untilSeq) || 0)),
      at: String(s.at || ''),
    }
  }

  async function notice(roomId, text) {
    try {
      const msg = await store.append(roomId, {
        kind: 'system',
        speaker: { id: 'system', name: '聊天室' },
        text,
        notice: 'ctx-compress',
      })
      try { emit(roomId, { type: 'message', message: msg }) } catch {}
      return msg
    } catch { return null }
  }

  /**
   * @param {string} roomId
   * @param {{ force?: boolean, signal?: AbortSignal }} [o]
   * force=true → manual; otherwise only when estimated tokens >= threshold.
   */
  async function compress(roomId, o = {}) {
    const force = o.force === true
    const quiet = o.quiet === true
    const settings = getSettings() || {}
    const window = Math.max(0, Math.floor(Number(settings.window) || DEFAULT_HISTORY_WINDOW))
    const threshold = Math.max(1000, Math.floor(Number(o.threshold) || Number(settings.threshold) || DEFAULT_TOKEN_THRESHOLD))
    const userName = String(settings.userName || '用户').trim() || '用户'

    if (!summarizerConfigured(settings)) {
      return { ok: false, skipped: true, reason: 'unconfigured', notice: UNCONFIGURED_NOTICE }
    }

    if (locks.has(roomId)) {
      return { ok: false, skipped: true, reason: 'busy', error: '上下文压缩正在进行，请稍后再试。', notice: '上下文压缩进行中，请稍候。' }
    }

    let release
    const gate = new Promise((r) => { release = r })
    locks.set(roomId, gate)

    try {
      const messages = await store.readMessages(roomId)
      const meta = await store.getRoom(roomId)
      const prior = readSummary(meta)
      const historyTokens = estimateHistoryTokens(messages, { untilSeq: prior.untilSeq, summary: prior.text, userName })
      // requestTokens: the caller's estimate of the real request (system + tools + built messages), when known
      const tokens = Math.max(historyTokens, Math.floor(Number(o.requestTokens) || 0))

      if (!force && tokens < threshold) {
        return { ok: true, skipped: true, reason: 'under-threshold', tokens, threshold, window }
      }

      const plan = planCompress(messages, { window, untilSeq: prior.untilSeq })
      if (plan.empty) {
        return { ok: true, skipped: true, reason: 'nothing-to-fold', tokens, threshold, window }
      }

      const { system, user } = buildSummarizerPrompt({ priorSummary: prior.text, falling: plan.falling, userName })

      // Ephemeral live view of the summarizer (page only): never stored, never in AI prompts.
      const provider = String(settings.provider).trim()
      const model = String(settings.model).trim()
      const streamId = 'ctxsum-' + Number(now()).toString(36) + Math.random().toString(36).slice(2, 6)
      const live = (ev) => { try { emit(roomId, { ...ev, id: streamId }) } catch {} }
      live({ type: 'compress-start', auto: !force, provider, model, folded: plan.falling.length })

      let text
      try {
        text = await streamSummary(getLlm(), {
          provider, model, system, user, signal: o.signal,
          onDelta: (t) => live({ type: 'compress-delta', text: t }),
          onReasoning: (t) => live({ type: 'compress-thinking', text: t }),
        })
      } catch (e) {
        if (e?.aborted) { live({ type: 'compress-end', ok: false, error: '已停止' }); throw e }
        live({ type: 'compress-end', ok: false, error: String(e?.message || e).slice(0, 200) })
        const line = '上下文压缩失败，已保留原窗口。'
        if (!quiet) await notice(roomId, line)
        return { ok: false, skipped: false, reason: 'summarize-failed', error: String(e?.message || e).slice(0, 200), notice: line, tokens }
      }

      if (!text) {
        live({ type: 'compress-end', ok: false, error: SUMMARY_EMPTY_ERROR })
        const line = '上下文压缩失败，已保留原窗口。'
        if (!quiet) await notice(roomId, line)
        return { ok: false, skipped: false, reason: 'empty-summary', error: SUMMARY_EMPTY_ERROR, notice: line, tokens }
      }

      const untilSeq = plan.untilSeq
      const at = new Date(now()).toISOString()
      await store.patchMeta(roomId, (m) => {
        m.contextSummary = { text, untilSeq, at, tokensBefore: tokens, folded: plan.falling.length }
      })
      if (typeof store.markContextHidden === 'function') {
        try { await store.markContextHidden(roomId, untilSeq) } catch {}
      }

      live({ type: 'compress-end', ok: true })
      try { emit(roomId, { type: 'context-summary', summary: { text, untilSeq, at } }) } catch {}
      const line = force ? '已压缩较早的上下文。' : '已自动压缩较早的上下文。'
      if (!quiet) await notice(roomId, line)
      return { ok: true, skipped: false, summary: { text, untilSeq, at }, folded: plan.falling.length, tokens, threshold, window, notice: line }
    } finally {
      locks.delete(roomId)
      try { release() } catch {}
    }
  }

  /** Auto path: no-op when unset / under threshold / busy / nothing to fold. */
  async function maybeAutoCompress(roomId, o = {}) {
    const settings = getSettings() || {}
    if (!summarizerConfigured(settings)) return { ok: true, skipped: true, reason: 'unconfigured' }
    if (locks.has(roomId)) return { ok: true, skipped: true, reason: 'busy' }
    try {
      return await compress(roomId, { force: false, signal: o.signal, requestTokens: o.requestTokens, threshold: o.threshold })
    } catch (e) {
      if (e?.aborted) return { ok: false, skipped: false, reason: 'aborted' }
      return { ok: false, skipped: false, reason: 'error', error: String(e?.message || e).slice(0, 200) }
    }
  }

  return {
    compress,
    maybeAutoCompress,
    isBusy: (roomId) => locks.has(roomId),
    readSummary,
    estimateHistoryTokens: (messages, extra) => estimateHistoryTokens(messages, { ...extra, userName: (getSettings() || {}).userName }),
  }
}
