/**
 * 聊天室文本协议（纯函数，无 I/O）：
 *   [PASS]                         本轮不补充（静默，不转发 Telegram）
 *   [[NEXT: 名字]]                 交棒：下一位发言者（也识别「交给 Gemini」「let Gemini take this」）
 *   [[CURSOR_HANDOFF {...json}]]   无原生工具调用时的 cursor_handoff 回退写法
 *   @名字                           用户消息里 @ 某位 → 该 AI 为本任务主答
 *   批准 +N / 执行                  所有者指令（预算追加 / 执行 Cursor 任务书）
 */
export const PASS_TOKEN = '[PASS]'

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '')

export function isPass(text) {
  const t = String(text || '').trim()
  if (!t) return true
  return t === PASS_TOKEN || (t.toUpperCase().startsWith(PASS_TOKEN) && t.length <= PASS_TOKEN.length + 8)
}

/** 名字 / id / 别名 → 席位。 */
export function findSeat(seats, name) {
  const n = norm(name)
  if (!n) return null
  return seats.find((s) => norm(s.id) === n || norm(s.name) === n || (s.aliases || []).some((a) => norm(a) === n)) || null
}

function namePattern(seats) {
  const names = []
  for (const s of seats) for (const v of [s.name, s.id, ...(s.aliases || [])]) if (v) names.push(String(v))
  names.sort((a, b) => b.length - a.length)
  return names.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
}

/** 用户消息里第一个 @名字 → 席位（本任务主答）。 */
export function parseMention(text, seats) {
  const pat = namePattern(seats)
  if (!pat) return null
  const m = new RegExp(`@(${pat})(?![A-Za-z0-9])`, 'i').exec(String(text || ''))
  return m ? findSeat(seats, m[1]) : null
}

/**
 * AI 回复里的交棒：显式 [[NEXT: X]] 优先；否则识别「交给 X」「让 X 来」「let X take (this|it|over)」「X, take this」。
 * 返回 { seat, text }，text 去掉了显式标记。交给自己 / 未知名字 → seat=null。
 */
export function parseHandoff(text, seats, selfId) {
  let t = String(text || '')
  let target = null
  const ex = /\[\[\s*NEXT\s*[:：]\s*([^\]]+?)\s*\]\]/i.exec(t)
  if (ex) {
    target = findSeat(seats, ex[1])
    t = (t.slice(0, ex.index) + t.slice(ex.index + ex[0].length)).trim()
  } else {
    const pat = namePattern(seats)
    if (pat) {
      const res = [
        new RegExp(`(?:交给|交由|让|请)\\s*@?(${pat})\\s*(?:来|接手|接着|回答|处理|负责)`, 'i'),
        new RegExp(`(?:交给|交棒给)\\s*@?(${pat})`, 'i'),
        new RegExp(`\\blet\\s+@?(${pat})\\s+(?:take|handle|answer|cover)\\b`, 'i'),
        new RegExp(`\\bhand(?:ing)?\\s+(?:this\\s+|it\\s+)?(?:off\\s+|over\\s+)?to\\s+@?(${pat})\\b`, 'i'),
      ]
      for (const re of res) { const m = re.exec(t); if (m) { target = findSeat(seats, m[1]); break } }
    }
  }
  if (target && target.id === selfId) target = null
  return { seat: target, text: t }
}

/** 所有者指令：「批准 +N」「批准+3」「approve +2」→ { kind:'approve', n }；「执行」→ { kind:'execute', briefId? }。 */
export function parseOwnerCommand(text) {
  const t = String(text || '').trim()
  let m = /^(?:批准|approve)\s*[+＋]\s*(\d{1,3})\s*$/i.exec(t)
  if (m) return { kind: 'approve', n: Math.max(1, Math.min(100, Number(m[1]))) }
  m = /^(?:执行|execute)(?:\s+#?([a-z0-9-]+))?\s*[。.!！]?$/i.exec(t)
  if (m) return { kind: 'execute', ...(m[1] ? { briefId: m[1] } : {}) }
  if (/^(?:取消执行|不执行|cancel)\s*$/i.test(t)) return { kind: 'cancel' }
  return null
}

/** 回退写法 [[CURSOR_HANDOFF {...}]] → { args, text }。JSON 无效时 args=null 并给出 error。 */
export function parseCursorDirective(text) {
  const t = String(text || '')
  const i = t.search(/\[\[\s*CURSOR_HANDOFF\b/i)
  if (i < 0) return null
  const start = t.indexOf('{', i)
  if (start < 0) return { args: null, error: 'missing JSON', text: t.slice(0, i).trim() }
  let depth = 0; let inStr = false; let esc = false; let end = -1
  for (let k = start; k < t.length; k++) {
    const c = t[k]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = k; break } }
  }
  if (end < 0) return { args: null, error: 'unterminated JSON', text: t.slice(0, i).trim() }
  const close = t.indexOf(']]', end)
  const rest = close >= 0 ? t.slice(close + 2) : t.slice(end + 1)
  try { return { args: JSON.parse(t.slice(start, end + 1)), text: (t.slice(0, i) + rest).trim() } } catch (e) {
    return { args: null, error: String(e.message || e), text: (t.slice(0, i) + rest).trim() }
  }
}

/** 过时检查的回复：SEND / DROP / REVISE: 新文本。不认识 → send（保守：保留原稿）。 */
export function parseStaleDecision(text) {
  const t = String(text || '').trim()
  if (/^\[?\s*DROP\s*\]?/i.test(t) || /^(?:撤回|丢弃|不发)/.test(t)) return { action: 'drop' }
  const m = /^\[?\s*REVISE\s*\]?\s*[:：]?\s*([\s\S]+)$/i.exec(t)
  if (m && m[1].trim()) return { action: 'revise', text: m[1].trim() }
  return { action: 'send' }
}

/** 去掉模型自己加的「[名字] 」前缀。 */
export function stripSelfPrefix(text, name) {
  const t = String(text || '').trimStart()
  const p = `[${name}]`
  return t.startsWith(p) ? t.slice(p.length).trimStart() : String(text || '')
}
