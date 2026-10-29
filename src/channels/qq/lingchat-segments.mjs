/**
 * LingChat-style reply segments for QQ outbound.
 * Model outputs multiple 【情绪】台词; we pile them up during the turn (buffered),
 * then send each as a separate QQ message with the emotion tag stripped.
 */
const EMOTION_RE = /【([^】]*)】/g
const SKIP_RE = /^(?:【\s*(?:跳过|略过|沉默|无关)\s*】|\s*(?:跳过|略过|沉默|无关)\s*)$/u

/** Short format reminder prepended to QQ inbound (keep compact). */
export const QQ_LINGCHAT_FORMAT_HINT = [
  '[reply-format] 用多条「台词」回复；每条以【情绪】开头（2~5字情绪，无主语），后接1~2句正文；不要写（）动作或旁白。',
  '单次回复台词条数≤4（最多四个【情绪】）。话题与你无关时只输出【跳过】，不要解释。禁止颜文字。',
].join('')

/**
 * Split assistant text into LingChat segments.
 * @returns {{ emotion: string, text: string }[]}
 */
export function parseLingChatSegments(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return []

  const matches = [...text.matchAll(EMOTION_RE)]
  if (!matches.length) {
    return [{ emotion: '', text }]
  }

  const out = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const emotion = String(m[1] ?? '').trim()
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    let body = text.slice(start, end).trim()
    // Drop a leading blank line between tag and body
    body = body.replace(/^\n+/, '').trim()
    if (!body && !emotion) continue
    out.push({ emotion, text: body })
  }
  return out
}

/** Whether this whole reply means "stay silent". */
export function isSkipReply(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return true
  if (SKIP_RE.test(t)) return true
  const segs = parseLingChatSegments(t)
  if (!segs.length) return true
  if (segs.length === 1 && /^(?:跳过|略过|沉默|无关)$/u.test(segs[0].emotion) && !segs[0].text) return true
  return false
}

/**
 * Plain QQ bubble texts: emotion tags removed; empty bodies dropped.
 * If no 【】 tags, returns the original text as one piece (still one send).
 * @returns {string[]}
 */
export function qqOutboundPieces(raw) {
  if (isSkipReply(raw)) return []
  const segs = parseLingChatSegments(raw)
  const pieces = []
  for (const s of segs) {
    if (/^(?:跳过|略过|沉默|无关)$/u.test(s.emotion) && !s.text.trim()) continue
    const body = String(s.text || '').trim()
    if (!body) continue
    pieces.push(body)
  }
  return pieces
}

/**
 * Wrap a QQ adapter so text replies are buffered-split:
 * pile segments from the finished text, strip 【情绪】, send each bubble in order.
 */
export function installQqLingChatOutbound(adapter, { gapMs = 350, enabled = true } = {}) {
  if (!adapter || adapter.__dshLingChatOutbound) return adapter
  if (!enabled) return adapter

  const origSend = adapter.send.bind(adapter)
  const origResolve = typeof adapter.resolveStreamingMode === 'function'
    ? adapter.resolveStreamingMode.bind(adapter)
    : null

  // Always buffer so we can split the finished text (native C2C stream would leak tags).
  adapter.resolveStreamingMode = () => 'buffered'

  adapter.send = async function lingChatSend(target, message) {
    const text = message?.text
    if (text == null || typeof text !== 'string') {
      return origSend(target, message)
    }
    // Media / actions: leave untouched
    if (message.parts?.length || message.actions?.length) {
      return origSend(target, message)
    }
    const pieces = qqOutboundPieces(text)
    if (!pieces.length) {
      // Silent skip — do not send empty/tag-only spam
      return { delivered: true, skipped: true }
    }
    // No tags → single send of cleaned/original body
    if (pieces.length === 1 && !/【[^】]+】/.test(text)) {
      return origSend(target, { ...message, text: pieces[0] })
    }
    let last = null
    for (let i = 0; i < pieces.length; i++) {
      last = await origSend(target, { ...message, text: pieces[i] })
      if (i + 1 < pieces.length && gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs))
      }
    }
    return last
  }

  Object.defineProperty(adapter, '__dshLingChatOutbound', { value: true })
  // Keep reference for tests / restore
  adapter.__dshLingChatOrigResolve = origResolve
  return adapter
}