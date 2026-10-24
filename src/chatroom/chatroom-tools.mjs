/**
 * 聊天室工具发现（find_tools）与执行：
 *   - find_tools → DSH DeepSeek 服务商选出 ≤3 个工具 → 加入房间工具集（共享、持久、LRU）。
 *   - 工具集中的工具直接经宿主工具注册表执行（tools.get(name).execute），所有者门禁见 ./tool-gate.mjs。
 *   - 每次调用 = 一张卡片（全文存文件，消息带标题 + 预览）；其他成员只看到卡片标题，open_card（旧名 read_tool_result）分页打开。
 *   - search_history（./history-search.mjs）为房间级内置只读工具：与 web_search 一样是默认工具，只查当前房间的聊天记录。
 *   - 附件工具（view_attachment / read_attachment / send_attachment，见 ./attachment-tools.mjs）为房间级内置工具，
 *     附件功能开启时对所有成员、所有回合可用，不经 find_tools 与所有者门禁。
 */
import { FIND_TOOLS, OPEN_CARD, FIND_TOOLS_NAME, OPEN_CARD_NAMES, listCatalog, selectTools, lexicalCurrentMatch, summarizeResult, isSessionImageTool } from './tool-selector.mjs'
import { createToolsets } from './toolset.mjs'
import { createToolResults, previewText, charsForTokens, TOOL_DEFAULTS, cardTitle, inlineResult, isBlankResult } from './tool-results.mjs'
import { isOwnerOnlyTool } from '../channels/telegram/owner-gate.mjs'
import { allowedNames, denyReason, isOpen, GAME_ACTION_TOOLS, GAME_OWNER_TOOLS, MC_MEMBER_TOOLS } from './tool-gate.mjs'
import { SEARCH_HISTORY, SEARCH_HISTORY_NAME, searchHistory } from './history-search.mjs'
import { sanitizeToolSchemas } from './schema-sanitize.mjs'
import { createAttachmentTools, ATTACHMENT_TOOL_NAMES, ATTACHMENT_TOOLS, SEND_TOOL_NAMES, WATCH_VIDEO_NAME } from './attachment-tools.mjs'

export const TOOL_TIMEOUT_MS = 120000

/**
 * 房间默认工具：每个房间（含新房间）始终可用，不写入 toolset.json，不占工具集上限，/tools clear 也不会移除。
 * 仅当 DSH 工具目录里确实存在时才加入；工具关闭（enabled === false）时与其他工具一同关闭。
 */
export const DEFAULT_ROOM_TOOLS = Object.freeze(['web_search', 'web_fetch', SEARCH_HISTORY_NAME])
const DEFAULT_ROOM_TOOL_SET = new Set(DEFAULT_ROOM_TOOLS)
/** 房间自带实现的默认工具（不依赖 DSH 工具目录，始终存在）。 */
const NATIVE_DEFAULT_TOOLS = new Set([SEARCH_HISTORY_NAME])
export const isDefaultRoomTool = (name) => DEFAULT_ROOM_TOOL_SET.has(String(name || ''))

/** 纯函数：房间实际工具名 = 已存工具集 + 目录中存在的默认工具（去重，默认工具排前）。 */
export function effectiveToolNames(stored, catalogNames) {
  const have = catalogNames instanceof Set ? catalogNames : new Set(catalogNames || [])
  const out = DEFAULT_ROOM_TOOLS.filter((n) => have.has(n) || NATIVE_DEFAULT_TOOLS.has(n))
  for (const n of stored || []) if (!out.includes(n)) out.push(n)
  return out
}

const isDeepseek = (x) => /deepseek/i.test(String(x || ''))

/**
 * 解析 find_tools 选择器的服务商与模型（纯函数）。
 *   1. 设置中的服务商编号若已在 DSH 注册 → 使用；
 *   2. 否则沿用 DeepSeek 席位（默认主答优先）的服务商——席位能发言即说明该路由可用；
 *   3. 否则任一编号 / 名称含 deepseek 的已注册服务商；
 *   4. 服务商列表读不到（为空 / 服务未就绪）时不判定为缺失，按设置或席位直接尝试（与席位调用一致）。
 * 模型：设置中的模型在列表里 → 使用；否则该席位的模型（若是同一服务商）；否则列表中含 flash 的模型；列表为空则原样使用。
 */
export function resolveFinder({ settings = {}, catalog, seats = [], defaultMain = '' }) {
  const wantP = String(settings.finderProvider || '').trim()
  const wantM = String(settings.finderModel || '').trim()
  const enabledSeats = (seats || []).filter((x) => x && x.enabled !== false && x.provider)
  const dsSeats = enabledSeats.filter((x) => isDeepseek(x.provider) || isDeepseek(x.id) || isDeepseek(x.name) || isDeepseek(x.model))
  const main = enabledSeats.find((x) => x.id === defaultMain || String(x.name || '').toLowerCase() === String(defaultMain).toLowerCase())
  const seat = (main && dsSeats.includes(main) ? main : null) || dsSeats[0] || null
  const live = catalog && catalog.available !== false && Array.isArray(catalog.providers) ? catalog.providers : []
  if (!live.length) {
    const provider = wantP || seat?.provider || 'deepseek'
    const model = wantM || (seat && seat.provider === provider ? seat.model : '') || 'deepseek-flash'
    return { provider, model, ready: true, problem: '', via: 'unverified', note: '服务商列表暂不可读，按设置直接调用' }
  }
  let prov = wantP ? live.find((x) => x.id === wantP) : null
  let via = prov ? 'setting' : ''
  if (!prov && seat) { prov = live.find((x) => x.id === seat.provider); if (prov) via = 'seat' }
  if (!prov) { prov = live.find((x) => isDeepseek(x.id) || isDeepseek(x.name)); if (prov) via = 'match' }
  if (!prov) return { provider: wantP || 'deepseek', model: wantM, ready: false, problem: `DSH 中未找到 DeepSeek 服务商（已注册：${live.map((x) => x.id).join('、') || '无'}）。请在「设置 › 模型」中配置 DeepSeek，或在「工具」中填写选择器服务商。` }
  const models = Array.isArray(prov.models) ? prov.models : []
  const has = (id) => !!id && models.some((m) => m.id === id)
  let model = ''
  if (!models.length) model = wantM || (seat?.provider === prov.id ? seat.model : '') || 'deepseek-flash'
  else if (has(wantM)) model = wantM
  else if (seat?.provider === prov.id && /flash/i.test(seat.model || '') && has(seat.model)) model = seat.model
  else model = (models.find((m) => /flash/i.test(m.id)) || (seat?.provider === prov.id && has(seat.model) ? { id: seat.model } : null) || models[0]).id
  const notes = []
  if (via !== 'setting' && wantP) notes.push(`服务商 ${wantP} 未注册，改用 ${prov.id}${via === 'seat' ? `（与席位 ${seat.name} 相同）` : ''}`)
  if (wantM && model !== wantM) notes.push(`模型 ${wantM} 不在列表中，改用 ${model}`)
  return { provider: prov.id, model, ready: true, problem: '', via, ...(notes.length ? { note: notes.join('；') } : {}) }
}

export function valueText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value?.content)) {
    const t = value.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
    if (t) return t
  }
  try { return JSON.stringify(value, null, 1) } catch { return String(value) }
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  const s = String(raw ?? '').trim()
  if (!s) return {}
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {} } catch { return null }
}

/** 执行宿主注册表中的一个工具（带超时与取消）。 */
export async function execRegistryTool(tools, name, args, { signal, timeoutMs = TOOL_TIMEOUT_MS, callId = '', roomId = '', caller = null, sessionId = '', owner = false } = {}) {
  const def = typeof tools?.get === 'function' ? tools.get(name) : undefined
  if (!def || typeof def.execute !== 'function') return { ok: false, error: `工具 ${name} 未注册或当前不可用` }
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error(`${name} 在 ${Math.round(timeoutMs / 1000)} 秒内未返回`), { timeout: true })) }, timeoutMs) })
  try {
    const exec = {
      signal: ac.signal, callId, rootCallId: callId, toolName: name, args,
      ...(sessionId ? { agent: { id: String(sessionId) } } : {}),
      ...(roomId ? { game: { roomId: String(roomId), caller: caller || undefined, owner: !!owner } } : {}),
      deferContext() {}, concludeTurn() {},
    }
    const value = await Promise.race([def.execute(args, exec), timeout])
    return { ok: true, text: valueText(value) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), timeout: !!e?.timeout }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** 成员调用会话专用图片工具时的回复。 */
export const SESSION_IMAGE_TOOL_HINT = (name) => `${name} only works with images uploaded in a DSH conversation; it cannot open room attachments and is not available in this room. Use view_attachment with the room id (e.g. view_attachment("a1b2c3d4e5f6")): members who can see images get the real image, others get a text description.`

/**
 * @param {{ roomDir: (id) => string, getTools: () => any, getLlm: () => any, getSettings: () => object, providers?: () => Promise<any> }} o
 */
/** 共享历史里不留辅助引擎的候选着法。调用者本轮仍看到完整结果。 */
export function redactGameShare(name, text) {
  if (!/^board_|^card_/.test(String(name || ''))) return null
  let data
  try { data = JSON.parse(text) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (String(name).startsWith('card_')) {
    const shared = name === 'card_play' ? '出了一张公开牌。' : name === 'card_look' ? '看了自己的牌。' : name === 'card_open' ? '开了一桌牌。' : '更新了牌桌。'
    return {
      stored: JSON.stringify({ ok: true, redacted: true, game: data.game || '', turn: data.turn || '' }),
      shared,
    }
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'hints') && name !== 'board_hint') return null
  const pub = { ...data }
  delete pub.hints
  if (name === 'board_hint') {
    return {
      stored: JSON.stringify({ available: data.available === true, redacted: true }),
      shared: '看了辅助引擎的参考，候选着法没有写入房间。',
    }
  }
  return { stored: JSON.stringify(pub), shared: '' }
}

/** 工具失败的大致类别（给调用者本人，不带原始错误文本）。 */
export function failureKind(err) {
  const t = String(err || '')
  if (/not found|no such|enoent|does not exist|不存在|找不到|404/i.test(t)) return 'nothing there'
  if (/time ?out|timed out|etimedout|超时/i.test(t)) return 'it took too long'
  if (/permission|denied|forbidden|unauthori[sz]ed|eacces|eperm|401|403|权限|拒绝/i.test(t)) return 'not allowed'
  if (/invalid|required|missing|schema|argument|parameter|参数|格式/i.test(t)) return 'the request didn\'t fit, check the arguments'
  if (/rate.?limit|429|too many|busy|overload|繁忙|限流/i.test(t)) return 'too busy right now'
  return 'it didn\'t work this time'
}

/** 聊天室调用 DeepSlate 渲染工具时的宽高上限（像素）。 */
export const DEEPSLATE_ROOM_MAX_PX = 1600
export function clampRenderSize(args) {
  if (!args || typeof args !== 'object') return args
  for (const k of ['width', 'height']) {
    const v = Number(args[k])
    if (Number.isFinite(v) && v > DEEPSLATE_ROOM_MAX_PX) args[k] = DEEPSLATE_ROOM_MAX_PX
  }
  return args
}

export function createChatroomTools({ roomDir, getTools, getLlm, getSettings, providers, getSeats, getDefaultMain, getSessionId = async () => '', readRoom = null, getUserName = () => '用户', attachments = null, attachmentsEnabled = () => !!attachments, describe, watchVideo, videoEnabled = () => typeof watchVideo === 'function' }) {
  const toolsets = createToolsets(roomDir)
  const attachTools = attachments ? createAttachmentTools({ store: attachments, describe, watch: watchVideo }) : null
  const videoOn = () => typeof watchVideo === 'function' && videoEnabled?.() !== false
  const attachOn = () => !!attachTools && attachmentsEnabled?.() !== false
  const results = createToolResults(roomDir)
  const settings = () => ({ ...TOOL_DEFAULTS, ...(getSettings?.() || {}) })
  const catalog = () => listCatalog(getTools?.())
  /** 当前目录中存在的默认工具名。 */
  const defaultsPresent = (cat = catalog()) => { const have = new Set(cat.map((t) => t.name)); return DEFAULT_ROOM_TOOLS.filter((n) => have.has(n) || (NATIVE_DEFAULT_TOOLS.has(n) && historyOn())) }
  const historyOn = () => typeof readRoom === 'function'
  /** 房间实际工具名（已存工具集 + 默认工具）。 */
  const roomToolNames = async (roomId, cat = catalog()) => effectiveToolNames((await toolsets.list(roomId)).map((x) => x.name), cat.map((t) => t.name))

  /** 选择器所用的服务商 / 模型：每次调用时现查（不缓存），解析方式与 DeepSeek 席位一致。 */
  async function finderStatus() {
    const s = settings()
    const llm = getLlm?.()
    if (!llm || typeof llm.stream !== 'function') return { provider: s.finderProvider, model: s.finderModel, enabled: s.enabled !== false, ready: false, problem: 'DSH 服务商服务不可用' }
    let p = null
    try { p = providers ? await providers() : null } catch { p = null }
    return { ...resolveFinder({ settings: s, catalog: p, seats: getSeats?.() || [], defaultMain: getDefaultMain?.() || '' }), enabled: s.enabled !== false }
  }

  /** 本回合交给模型的工具定义。 */
  async function schemas(roomId, { owner, gameTurn = false }) {
    const s = settings()
    const attach = attachOn() ? ATTACHMENT_TOOLS.filter((t) => t.name !== WATCH_VIDEO_NAME || videoOn()) : []
    if (s.enabled === false) return [...attach]
    const cat = new Map(catalog().map((t) => [t.name, t]))
    const names = allowedNames(await roomToolNames(roomId, [...cat.values()]), owner).filter((n) => !ATTACHMENT_TOOL_NAMES.has(n) && !isSessionImageTool(n) && !NATIVE_DEFAULT_TOOLS.has(n))
    const shaped = [FIND_TOOLS, OPEN_CARD, ...(historyOn() ? [SEARCH_HISTORY] : []), ...attach, ...names.map((n) => cat.get(n)).filter(Boolean).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))]
    const extra = [...MC_MEMBER_TOOLS, ...(gameTurn ? [...GAME_ACTION_TOOLS] : (owner ? [...GAME_OWNER_TOOLS, ...GAME_ACTION_TOOLS] : []))]
    for (const name of extra) {
      if (shaped.some((t) => t.name === name)) continue
      const t = cat.get(name)
      if (t) shaped.push({ name: t.name, description: t.description, parameters: t.parameters })
    }
    return sanitizeToolSchemas(shaped)
  }

  async function storeOutput(roomId, name, argsText, text, signal) {
    const s = settings()
    const saved = await results.save(roomId, { tool: name, args: argsText, text })
    const cap = charsForTokens(s.resultTokens)
    let preview = previewText(text, { id: saved.id, cap })
    if (s.summaries === true && text.length > s.summaryThreshold && !saved.dedupeOf) {
      try {
        const st = await finderStatus()
        if (st.ready) preview = `（摘要）${await summarizeResult({ llm: getLlm(), provider: st.provider, model: st.model, tool: name, text, maxChars: cap, signal })}\n…[完整输出 ${text.length} 字符，可用 open_card("${saved.id}") 打开]`
      } catch {}
    }
    return { ...saved, preview }
  }

  /**
   * 发送类内置工具（send_attachment / mm_send_image / mm_send_file）也留一张卡片：标题照常通用生成，
   * 内容是发送结果；房间里另有成员带附件的消息，所以卡片不再转发 Telegram（relay: false）。
   */
  async function sendCard(roomId, name, argsText, r) {
    const text = String(r.cardText ?? r.modelText ?? '')
    const ok = !r.isError
    let saved
    try { saved = await results.save(roomId, { tool: name, args: argsText, text: ok ? text : `错误：${text}` }) } catch { return { room: null } }
    const title = cardTitle({ tool: name, args: argsText, chars: saved.chars, ok })
    const inline = ok ? inlineResult(text) : ''
    return {
      room: { tool: name, text: ok ? text : `失败：${text.replace(/\s+/g, ' ').slice(0, 100)}`, relay: false, data: { ok, resultId: saved.id, chars: saved.chars, title, ...(inline ? { inline } : {}), preview: text.slice(0, 2000), args: argsText, ...(saved.dedupeOf ? { dedupeOf: saved.dedupeOf } : {}) } },
    }
  }

  /**
   * 执行一个工具调用。返回 { modelText, isError, room: { tool, text, data } | null }。
   */
  async function run(roomId, call, { owner, seat, signal, vision = false, gameTurn = false }) {
    const s = settings()
    const name = String(call?.name || '')
    const args = parseArgs(call?.arguments)
    const argsText = typeof call?.arguments === 'string' ? call.arguments.slice(0, 2000) : JSON.stringify(call?.arguments ?? {}).slice(0, 2000)
    if (args === null) return { isError: true, modelText: `参数不是有效的 JSON：${argsText.slice(0, 200)}`, room: null }
    if (ATTACHMENT_TOOL_NAMES.has(name)) {
      if (!attachOn()) return { isError: true, modelText: '聊天室附件功能未启用。', room: null }
      if (name === WATCH_VIDEO_NAME && !videoOn()) return { isError: true, modelText: '视频理解已在聊天室设置中关闭。', room: null }
      const r = await attachTools.run(roomId, name, args, { seat, vision })
      // watch_video：普通工具卡（完成的工具结果，失败回合也保留；relay:false 不发 Telegram）
      if (name === WATCH_VIDEO_NAME) { const { cardText, ...rest } = r; return { ...rest, ...(await sendCard(roomId, name, argsText, r)) } }
      if (!SEND_TOOL_NAMES.has(name)) return { ...r, room: null }
      return { ...r, ...(await sendCard(roomId, name, argsText, r)) }
    }
    if (name === FIND_TOOLS_NAME) {
      const query = String(args.query || '').trim()
      if (!query) return { isError: true, modelText: 'find_tools 需要 query。', room: null }
      const st = await finderStatus()
      if (!st.ready) return { isError: true, modelText: `find_tools 不可用：${st.problem}`, room: { tool: FIND_TOOLS_NAME, text: `find_tools 不可用：${st.problem}`, data: { ok: false, query } } }
      const cat = catalog()
      if (!cat.length) return { isError: true, modelText: 'DSH 工具目录为空或不可读。', room: null }
      const current = await roomToolNames(roomId, cat)
      let sel
      try { sel = await selectTools({ llm: getLlm(), provider: st.provider, model: st.model, query, catalog: cat, current, max: Math.max(1, Math.min(3, s.maxPerFind)), signal }) } catch (e) {
        if (signal?.aborted || e?.aborted) throw e
        return { isError: true, modelText: `选择器调用失败：${e?.message || e}`, room: { tool: FIND_TOOLS_NAME, text: `查找工具失败：${String(e?.message || e).slice(0, 160)}`, data: { ok: false, query } } }
      }
      // 已在工具集（或默认工具）里的：报告为已可用，不重复加入；选择器什么都没选时按名称字面匹配当前工具集兜底
      const currentSet = new Set(current)
      let available = sel.tools.filter((n) => currentSet.has(n))
      if (!sel.tools.length) available = lexicalCurrentMatch(query, current.filter((n) => cat.some((t) => t.name === n)))
      if (available.length && sel.tools.every((n) => currentSet.has(n))) {
        const byName0 = new Map(cat.map((t) => [t.name, t]))
        const lines0 = available.map((n) => `- ${n}${!owner && (isOwnerOnlyTool(n) || !isOpen(n)) ? ' (owner-only: not usable in this turn)' : ''}: ${String(byName0.get(n)?.description || '').replace(/\s+/g, ' ').slice(0, 240)}`)
        return { isError: false, modelText: `Already in your toolset: ${available.join(', ')} — call it directly.\n${lines0.join('\n')}`, room: { tool: FIND_TOOLS_NAME, text: `查找「${query.slice(0, 60)}」→ 已可用：${available.join('、')}`, data: { ok: true, query, tools: [], available } } }
      }
      // 默认工具本就可用：不写入工具集、不占上限
      const builtin = sel.tools.filter(isDefaultRoomTool)
      const toAdd = sel.tools.filter((n) => !isDefaultRoomTool(n) && !currentSet.has(n))
      if (!sel.tools.length) return { isError: false, modelText: `没有找到合适的工具${sel.error ? '（' + sel.error + '）' : ''}。可换一种说法再试。`, room: { tool: FIND_TOOLS_NAME, text: `查找「${query.slice(0, 60)}」：没有合适的工具`, data: { ok: true, query, tools: [] } } }
      const r = toAdd.length ? await toolsets.add(roomId, toAdd, { max: s.toolsetMax, by: seat?.id || '' }) : { added: [], evicted: [] }
      const byName = new Map(cat.map((t) => [t.name, t]))
      const lines = sel.tools.map((n) => `- ${n}${builtin.includes(n) ? ' (built-in default, always available)' : ''}${!owner && !isOpen(n) ? '（本回合不可用：仅所有者发起的任务可用）' : ''}: ${String(byName.get(n)?.description || '').replace(/\s+/g, ' ').slice(0, 240)}`)
      const total = (await toolsets.list(roomId)).length
      const modelText = `已加入房间工具集（${total}/${s.toolsetMax}），下一步即可直接调用：\n${lines.join('\n')}${r.evicted.length ? `\n（因上限移出：${r.evicted.join('、')}）` : ''}${sel.reason ? `\n理由：${sel.reason}` : ''}${available.length ? `\nAlready in your toolset: ${available.join(', ')} — call it directly.` : ''}`
      return { isError: false, modelText, room: { tool: FIND_TOOLS_NAME, text: `查找「${query.slice(0, 60)}」→ ${sel.tools.join('、')}${r.evicted.length ? `（移出 ${r.evicted.join('、')}）` : ''}`, data: { ok: true, query, tools: sel.tools, available, evicted: r.evicted, toolsetSize: total } } }
    }
    if (name === SEARCH_HISTORY_NAME) {
      if (!historyOn()) return { isError: true, modelText: 'search_history is not available here.', room: null }
      let data
      try { data = await readRoom(roomId) } catch (e) { return { isError: true, modelText: 'Could not read this room\'s history right now.', room: null } }
      const r = searchHistory(data?.messages || [], args, { userName: String(getUserName?.() || '用户'), binned: data?.binned })
      return { isError: !!r.error, modelText: r.text, room: null }
    }
    if (OPEN_CARD_NAMES.has(name)) {
      const id = String(args.id || args.card || '').trim().replace(/^#/, '').replace(/^card\s*#?/i, '')
      const r = await results.read(roomId, id, { offset: args.offset, limit: args.limit, grep: args.grep })
      if (!r.ok) return { isError: true, modelText: `No card #${id || '?'} in this room. Card ids look like r… (from [card #r… · title] lines).`, room: null }
      const meta = r.matches !== undefined ? `Card #${r.id}: ${r.total} chars, ${r.matches} matching lines (showing ${r.shown})` : `Card #${r.id}: ${r.total} chars, offset ${r.offset}${r.next != null ? `, next page at offset ${r.next}` : ', end of card'}`
      return { isError: false, modelText: `${meta}\n${r.text}`, room: null }
    }
    // 会话专用的图片工具（Vision Router 等）不认房间附件编号；旧房间工具集里可能还留着，统一拒绝并指向 view_attachment
    if (isSessionImageTool(name)) return { isError: true, modelText: SESSION_IMAGE_TOOL_HINT(name), room: null }
    const inToolset = (await toolsets.list(roomId)).some((x) => x.name === name) || defaultsPresent().includes(name)
    const deny = denyReason(name, { owner, inToolset, gameTurn })
    if (deny) return { isError: true, modelText: deny, room: { tool: name, text: `已拒绝：${deny}`, data: { ok: false, denied: true, args: argsText } } }
    await toolsets.touch(roomId, name)
    let sessionId = ''
    try { sessionId = String(await getSessionId(roomId) || '') } catch { sessionId = '' }
    // DeepSlate 渲染：聊天室里限制输出尺寸（上游允许到 4096 像素）
    if (name.startsWith('mcp__deepslate__')) clampRenderSize(args)
    const out = await execRegistryTool(getTools?.(), name, args, {
      signal, callId: String(call?.id || ''), roomId, sessionId, owner: !!owner,
      caller: seat?.id ? { kind: 'ai', memberId: seat.id } : null,
    })
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { aborted: true })
    const full = out.ok ? out.text : `错误：${out.error}`
    const red = out.ok ? redactGameShare(name, full) : null
    const stored = red ? red.stored : full
    const saved = await storeOutput(roomId, name, argsText, stored, signal)
    const cap = charsForTokens(settings().resultTokens)
    const callerPreview = previewText(out.ok ? full : stored, { id: saved.id, cap })
    const firstLine = String(red?.shared || stored).replace(/\s+/g, ' ').trim().slice(0, 100)
    const blank = out.ok && isBlankResult(full)
    const title = cardTitle({ tool: name, args: argsText, chars: saved.chars, ok: out.ok, empty: blank })
    const inline = out.ok && !blank ? inlineResult(red?.shared ?? stored) : ''
    return {
      isError: !out.ok,
      modelText: !out.ok
        ? `Card · ${title}: this sheet came back blank (${failureKind(out.error)}). Mention it once if it matters, then carry on without it.`
        : blank
          ? `Card #${saved.id} · ${title}: this sheet came back blank.`
          : `Card #${saved.id} · ${title}${saved.dedupeOf ? ` (same as card #${saved.dedupeOf})` : ''}\n${callerPreview}`,
      room: { tool: name, text: out.ok ? (blank ? '（空）' : firstLine) : `失败：${firstLine}`, data: { ok: out.ok, resultId: saved.id, chars: saved.chars, title, ...(inline ? { inline } : {}), ...(blank ? { blank: true } : {}), preview: red?.shared || saved.preview, args: argsText, ...(red ? { redacted: true } : {}), ...(saved.dedupeOf ? { dedupeOf: saved.dedupeOf } : {}) } },
    }
  }

  return { schemas, run, finderStatus, catalog, toolsets, results, settings, attachments, defaultsPresent, roomToolNames }
}
