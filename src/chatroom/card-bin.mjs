/**
 * 卡片回收站：成员可以把旧的工具卡片「收进控制台下面的回收站」，收进去的卡片不再出现在任何成员的提示词里
 * （连标题行也没有，也不占历史条数），只留一行「回收站里有 N 张卡片」。卡片本身（结果文件、房间记录）从不删除：
 * open_card 照样能打开，restore_card 放回，界面里折叠显示并可由用户移出。
 * 回收站状态存在房间 meta.json 的 cardBin（{ 消息 id: { by, at, ref } }）；指向已不存在消息的条目自动忽略。
 * 收进 / 取回都在回合成功提交时才生效（失败、被打断、被停止时随回合一起撤销）。
 * 收进 / 取回本身不产生卡片：只有一行只给界面看的系统提示（AI 看不到，不算新消息，不占历史条数），
 * 写明卡片名；紧接着的同类提示（同一人、同一操作）合并成一行。旧房间里存过的回收站卡片（data.binOp）按隐藏处理。
 */

export const SWEEP_CARDS_NAME = 'sweep_cards'
export const LIST_BIN_NAME = 'list_bin'
export const RESTORE_CARD_NAME = 'restore_card'
export const CARD_BIN_NAMES = new Set([SWEEP_CARDS_NAME, LIST_BIN_NAME, RESTORE_CARD_NAME])

const idsParam = { type: 'array', items: { type: 'string' }, description: 'Card ids, as shown in the chat ([card #r… · …]) or by list_bin.' }

export const SWEEP_CARDS = {
  name: SWEEP_CARDS_NAME,
  description: "Sweep old answer sheets off the table into the recycle bin under the world's console, so they stop taking up everyone's context. Nothing is deleted: swept cards vanish from the chat for every member, but open_card still reads them and restore_card puts them back. With no arguments it sweeps every card from before the current round. Or pass ids for specific cards, or before (a card id) to sweep every card older than that one. Cards fetched in your current turn stay on the table. Takes effect when your turn ends.",
  parameters: { type: 'object', properties: { ids: idsParam, before: { type: 'string', description: 'Sweep every card older than this card id.' } } },
}
export const LIST_BIN = {
  name: LIST_BIN_NAME,
  description: "Look through the recycle bin under the world's console: lists swept cards (id, title, who fetched it), newest first. Use open_card to read one, restore_card to put it back on the table.",
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional keyword to filter by title or tool.' }, offset: { type: 'integer', description: 'Skip this many entries (default 0).' }, limit: { type: 'integer', description: 'How many to show (default 20, max 50).' } } },
}
export const RESTORE_CARD = {
  name: RESTORE_CARD_NAME,
  description: "Take cards back out of the recycle bin under the world's console and put them back on the table, so their title lines show in the chat again. To just read a swept card without restoring it, use open_card. Takes effect when your turn ends.",
  parameters: { type: 'object', properties: { ids: idsParam }, required: ['ids'] },
}
export const CARD_BIN_TOOLS = [SWEEP_CARDS, LIST_BIN, RESTORE_CARD]

/**
 * 不给 AI 看的消息：status 为 hidden，或「结束本轮」卡片（旧房间里存的是 status ok，也一并按 data.endRound 认出），
 * 或旧版本留下的回收站操作卡片（data.binOp：现在改为一行界面提示）。
 * 与失败回合一样只留在界面：不进提示词、不进 list_bin / 卡片管理 / 收进或移出回收站、也不算新消息。
 */
export const hiddenFromAi = (m) => !!m && (m.status === 'hidden' || (m.kind === 'tool' && !!(m.data?.endRound || m.data?.binOp)))

export const isCardMsg = (m) => !!m && m.kind === 'tool' && !hiddenFromAi(m) && !!m.id
/** 卡片在工具参数里的编号：有结果文件用 r…，否则 s<序号>。 */
export const cardRef = (m) => String(m?.data?.resultId || ('s' + (m?.seq ?? '?')))
export const binOf = (meta) => (meta && meta.cardBin && typeof meta.cardBin === 'object' && !Array.isArray(meta.cardBin) ? meta.cardBin : {})

/** 回收站提示里的卡片名：同名工具合并（read_file ×2），最多列 max 种，其余写「等 N 张」。 */
export function binNoteNames(tools, max = 3) {
  const list = (tools || []).map((t) => String(t || 'card'))
  const groups = new Map()
  for (const t of list) groups.set(t, (groups.get(t) || 0) + 1)
  const parts = [...groups].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
  const shown = parts.slice(0, max).join('、')
  return parts.length > max ? `${shown} 等 ${list.length} 张` : shown
}
/** 一行回收站提示：「grok 把 1 张卡片收进了回收站（mcp_windows__PowerShell）」。who 已带空格或为「您」。 */
export function binNoteText({ op, who, tools }) {
  const n = (tools || []).length
  const names = binNoteNames(tools)
  const tail = names ? `（${names}）` : ''
  return op === 'sweep' ? `${who}把 ${n} 张卡片收进了回收站${tail}` : `${who}从回收站取回了 ${n} 张卡片${tail}`
}

/** 当前在回收站里的卡片消息 id（只算确实存在的卡片）。 */
export function binnedSet(messages, bin) {
  const b = bin || {}
  const out = new Set()
  for (const m of messages || []) if (isCardMsg(m) && Object.prototype.hasOwnProperty.call(b, m.id)) out.add(m.id)
  return out
}

const normRef = (x) => String(x ?? '').trim().replace(/^#/, '').replace(/^card\s*#?/i, '')

/** 编号 → 匹配的卡片消息（r… 可能对应多张同结果的卡片）。 */
export function findCards(messages, ref) {
  const r = normRef(ref)
  if (!r) return []
  const seq = /^s(\d+)$/i.exec(r)
  return (messages || []).filter((m) => isCardMsg(m) && (seq ? Number(m.seq) === Number(seq[1]) : m.data?.resultId === r))
}

/**
 * 计算要收进回收站的卡片。messages = 已入库的房间记录（本回合暂存的卡片不在其中，自然不会被收走）。
 * @param {{ ids?: string[], before?: string, roundSeq?: number, exclude?: Set<string>, turnRefs?: Set<string> }} o
 * @returns {{ ids: string[], refs: string[], unknown: string[], current: string[], already: number }}
 */
export function planSweep(messages, bin, { ids, before, roundSeq, exclude = new Set(), turnRefs = new Set() } = {}) {
  const binned = binnedSet(messages, bin)
  const skip = (m) => binned.has(m.id) || exclude.has(m.id)
  const unknown = []
  const current = []
  let picked = []
  let already = 0
  const list = Array.isArray(ids) ? ids : (typeof ids === 'string' && ids.trim() ? ids.split(/[\s,，]+/) : [])
  if (list.length) {
    for (const ref of list.map(normRef).filter(Boolean)) {
      const hit = findCards(messages, ref)
      if (!hit.length) { (turnRefs.has(ref) ? current : unknown).push(ref); continue }
      for (const m of hit) { if (skip(m)) already++; else picked.push(m) }
    }
  } else if (String(before || '').trim()) {
    const ref = normRef(before)
    const hit = findCards(messages, ref)
    if (!hit.length) (turnRefs.has(ref) ? current : unknown).push(ref)
    else {
      const edge = Math.min(...hit.map((m) => Number(m.seq) || 0))
      picked = (messages || []).filter((m) => isCardMsg(m) && Number(m.seq) < edge && !skip(m))
    }
  } else {
    picked = (messages || []).filter((m) => isCardMsg(m) && !skip(m) && (!(roundSeq > 0) || Number(m.seq) < roundSeq))
  }
  const seen = new Set()
  picked = picked.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
  return { ids: picked.map((m) => m.id), refs: [...new Set(picked.map(cardRef))], unknown, current, already }
}

/** 计算要从回收站取回的卡片。 */
export function planRestore(messages, bin, { ids, exclude = new Set() } = {}) {
  const binned = binnedSet(messages, bin)
  const list = Array.isArray(ids) ? ids : (typeof ids === 'string' && ids.trim() ? ids.split(/[\s,，]+/) : [])
  const out = []
  const unknown = []
  const notBinned = []
  for (const ref of list.map(normRef).filter(Boolean)) {
    const hit = findCards(messages, ref)
    if (!hit.length) { unknown.push(ref); continue }
    const inBin = hit.filter((m) => binned.has(m.id) && !exclude.has(m.id))
    if (!inBin.length) { notBinned.push(ref); continue }
    for (const m of inBin) if (!out.includes(m.id)) out.push(m.id)
  }
  return { ids: out, unknown, notBinned }
}

/** list_bin 的文字结果（英文，给模型）。 */
export function listBinText(messages, bin, { query = '', offset = 0, limit = 20 } = {}) {
  const b = bin || {}
  const binned = binnedSet(messages, b)
  const q = String(query || '').trim().toLowerCase()
  let rows = (messages || []).filter((m) => binned.has(m.id)).reverse()
  if (q) rows = rows.filter((m) => [m.data?.title, m.tool, m.text, m.speaker?.name, cardRef(m)].some((x) => String(x || '').toLowerCase().includes(q)))
  const total = rows.length
  const off = Math.max(0, Math.floor(Number(offset) || 0))
  const lim = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)))
  const page = rows.slice(off, off + lim)
  if (!binned.size) return 'The recycle bin is empty.'
  if (!total) return `No card in the recycle bin matches "${query}". (${binned.size} card${binned.size === 1 ? '' : 's'} in the bin.)`
  const lines = page.map((m) => {
    const d = m.data || {}
    const title = String(d.title || m.tool || 'card').replace(/\s+/g, ' ').slice(0, 120)
    const by = b[m.id]?.by ? `, swept by ${b[m.id].by}` : ''
    return `- #${cardRef(m)} · ${title} (fetched by ${m.speaker?.name || '?'}${by})${d.ok === false || d.blank ? ' [blank]' : ''}`
  })
  const more = off + page.length < total ? `\n(more: list_bin with offset ${off + page.length})` : ''
  return `Recycle bin: ${total}${q ? ' matching' : ''} card${total === 1 ? '' : 's'}${q ? ` of ${binned.size}` : ''}, showing ${off + 1}-${off + page.length}:\n${lines.join('\n')}${more}`
}
/** 卡片状态：已收进回收站优先，其次空白 / 失败，否则正常。 */
export function cardStatus(m, bin) {
  if (bin && Object.prototype.hasOwnProperty.call(bin, m.id)) return 'binned'
  const d = m.data || {}
  return d.ok === false || d.blank || d.blocked ? 'blank' : 'ok'
}
const CARD_STATUSES = new Set(['ok', 'blank', 'binned'])

/**
 * 卡片管理列表（界面用）：最新在前，按成员 / 工具 / 状态 / 关键词（标题、参数、工具名、编号）筛选后分页。
 * 返回 { total, offset, limit, items, ids（全部筛选结果的消息 id，供「全选」）, members, tools, counts }。
 */
export function listCards(messages, bin, { member = '', tool = '', status = '', q = '', offset = 0, limit = 50 } = {}) {
  const b = bin || {}
  const all = (messages || []).filter(isCardMsg).reverse()
  const members = new Map()
  const tools = new Set()
  const counts = { all: all.length, ok: 0, blank: 0, binned: 0 }
  for (const m of all) {
    if (m.speaker?.id || m.speaker?.name) members.set(String(m.speaker.id || m.speaker.name), String(m.speaker.name || m.speaker.id))
    if (m.tool) tools.add(String(m.tool))
    counts[cardStatus(m, b)]++
  }
  const kw = String(q || '').trim().toLowerCase()
  const st = CARD_STATUSES.has(status) ? status : ''
  const rows = all.filter((m) => {
    if (member && String(m.speaker?.id || m.speaker?.name || '') !== String(member)) return false
    if (tool && String(m.tool || '') !== String(tool)) return false
    if (st && cardStatus(m, b) !== st) return false
    if (kw) {
      const d = m.data || {}
      let args = d.args
      if (args && typeof args !== 'string') { try { args = JSON.stringify(args) } catch { args = '' } }
      if (![d.title, args, m.tool, d.resultId, cardRef(m), d.inline].some((x) => String(x || '').toLowerCase().includes(kw))) return false
    }
    return true
  })
  const off = Math.max(0, Math.floor(Number(offset) || 0))
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)))
  const items = rows.slice(off, off + lim).map((m) => {
    const d = m.data || {}
    let args = d.args
    if (args && typeof args !== 'string') { try { args = JSON.stringify(args) } catch { args = '' } }
    return {
      id: m.id, seq: m.seq, ref: cardRef(m), ts: m.ts || '', tool: m.tool || '',
      member: { id: m.speaker?.id || '', name: m.speaker?.name || '' },
      status: cardStatus(m, b), binnedBy: b[m.id]?.by || '', binnedAt: b[m.id]?.at || '',
      text: String(m.text || '').slice(0, 2000),
      data: { resultId: d.resultId, title: d.title, inline: d.inline, preview: d.preview, chars: d.chars, ok: d.ok, blank: d.blank, blocked: d.blocked, dedupeOf: d.dedupeOf, binOp: d.binOp, cursorTask: d.cursorTask, args: args ? String(args).slice(0, 2000) : undefined },
    }
  })
  return {
    total: rows.length, offset: off, limit: lim, items, ids: rows.map((m) => m.id),
    members: [...members].map(([id, name]) => ({ id, name })), tools: [...tools].sort(), counts,
  }
}