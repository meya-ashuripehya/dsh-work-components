/**
 * 沉浸模式（door + 后台助手）的纯逻辑：谁是前台角色、谁是后台助手、各自能看到 / 能调哪些工具、
 * 差事怎么交代、办不成时说什么。不碰宿主服务，便于单测。
 *
 * 设计要点（与工具清单解耦）：
 *   - 前台角色（persona）= 预设命中 immersivePresets 的会话。
 *     所有者这一轮不走慢的后台助手：请求里给 find_tools，再加上本会话已经钉选的功能
 *     （find_tools 找到后钉上，下一步就能直接调用），以及设置里点名保留的少数工具。
 *     不是所有者的回合仍只看到「门」errand，由访客助手去办。
 *   - 后台助手（helper）= 本功能自己建的隐藏会话，分「所有者」「访客」两种。所有者助手拿全部工具
 *     （含用户以后自己装的任何 MCP）；访客助手只放行 OPEN_TOOLS 里的只读/无副作用工具，
 *     其余（含新装的 MCP）一律拒绝——判断依据是 owner-gate 的 isOpenTool，而不是任何点名清单。
 *   - 其余会话（桌面里的普通对话等）：只把门从工具清单里去掉，行为不变。
 */
import { isOpenTool } from '../channels/telegram/owner-gate.mjs'

export const DOOR_NAME = 'errand'
export const FIND_TOOLS_NAME = 'find_tools'
export const ASK_USER_TOOL = 'ask_user_question'

/** 前台角色默认额外保留的工具（设置 immersiveKeepTools 留空时的取值）。 */
export const DEFAULT_KEEP_TOOLS = Object.freeze(['sticker_search', 'sticker_send'])

const DOOR_WHAT_DESC = '要办的事，一两句话说清楚、写具体（办事的人看不到你们之前的聊天，所以要带上必要的细节）。'

/**
 * 门的工具说明：给前台角色（模型）看的，不是给对方看的。
 * 上一版写成「需要你亲自去办……才用」，模型把它读成剧情里的动作（“我有手有脚，我去办”），根本没当成函数去调；
 * 所以这一版明说「这是一次真正的调用，不是剧情里出门」，并把触发条件写成主动的：自己不知道 / 做不了就用。
 * 仍不出现「工具 / MCP / JSON」这类词。同时作为 llm 请求里的兜底 schema（门没出现在请求里时补进去）。
 */
export const DOOR_SCHEMA = Object.freeze({
  name: DOOR_NAME,
  description:
    '把一件需要现查、或需要动手的现实事务交办出去，等结果回来：上网查资料、看新闻天气时间、翻你记着的笔记、读写文件、跑程序、操作电脑、发消息，'
    + '凡是你自己不知道、记不准或做不到的，都用它。这不是你在剧情里出门去办，而是真的发出一次调用；不调用就没有结果，不要凭印象编，也不要只在剧情里假装办了。'
    + '在 what 里用一两句话写清要办的事，带上必要的细节（办事的人看不到你们的聊天）。会等一会儿，结果以一段话还给你，用你自己的口吻告诉对方；办不成也会如实告诉你。'
    + '纯闲聊、想事情、回忆过去不用它。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      what: Object.freeze({ type: 'string', description: DOOR_WHAT_DESC }),
    }),
    required: Object.freeze(['what']),
  }),
})
export const DOOR_WHAT_DESCRIPTION = DOOR_WHAT_DESC

/**
 * 给所有者前台看的 find_tools。宿主里注册的那把说明是给 Google 发现模式的英文文案；
 * 这里换成白话，并写明「这一步只是去找，下一步必须接着调用」。
 */
export const PERSONA_FIND_TOOLS = Object.freeze({
  name: FIND_TOOLS_NAME,
  description:
    '手头没有能办这件事的功能时先调用它。用白话写清要办的事：查资料、看时间天气、翻笔记、读写文件、跑程序、操作电脑、发消息。'
    + '它会把能用的功能准备好，你的下一步清单里就能直接调用。这一步只是去找，找到后必须接着调用，不要只把名字说出来，也不要凭印象编结果。'
    + '对方看不到这次调用。纯闲聊不用。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      query: Object.freeze({ type: 'string', description: '要办的事，用白话写具体。' }),
    }),
    required: Object.freeze(['query']),
  }),
})

/**
 * 追加到前台角色系统提示末尾的说明（对方看不到）。纯对话预设不带任何工具使用指引。
 * 设置 immersiveHint 留空 = 按回合用内置说明（所有者用 find_tools 这段，其他人用门那段）；
 * 填 none = 不追加；填别的 = 两种回合都用自己的文字。
 */
export const DEFAULT_PERSONA_HINT = [
  '【办事】你可以直接调用功能，对方看不到调用过程。',
  '需要现查或动手，而清单里还没有能办这件事的功能时，先调用 find_tools，用白话写清要办的事。',
  '下一步清单里出现对应功能后，立刻调用它，不要停下来解释，也不要凭印象编。',
  '结果用你自己的口吻告诉对方；办不成就如实说。',
  '不要向对方提到 find_tools、功能名、调用或后台。纯闲聊不用。',
].join('')

/** 不是所有者的前台回合仍走门，等后台助手。说明沿用「真的调用、不要演」。 */
export const ERRAND_PERSONA_HINT = [
  `【办事】你手边有一个叫 ${DOOR_NAME} 的真实功能，是你和现实世界打交道的唯一办法。`,
  '凡是你不知道、记不准、需要现查，或者需要动手的事（上网查资料、看新闻天气时间、翻笔记、读写文件、跑程序、操作电脑、发消息等），',
  `不要凭印象编，也不要只在剧情里假装做了，而要真的调用 ${DOOR_NAME}，在 what 里把要办的事写具体（办事的人看不到你们的聊天，必要的细节要带上）。`,
  '结果回来后，用你自己的口吻自然地告诉对方；办不成就如实说。',
  `这段说明对方看不到：不要提 ${DOOR_NAME}、功能、调用、后台这类词，也不要说“我去找人帮忙”，就当是你自己查到的、想起来的。`,
].join('')

const HINT_OFF = /^(none|无|off|-)$/i
const MAX_HINT_CHARS = 2000

/**
 * 把设置里的 immersiveHint 解析成要追加的文字。
 * direct：所有者回合，留空时用 find_tools 说明；否则留空时用门的说明。空串表示不追加。
 */
export function personaHint(raw, { direct = false } = {}) {
  const text = String(raw ?? '').trim()
  if (!text) return direct ? DEFAULT_PERSONA_HINT : ERRAND_PERSONA_HINT
  if (HINT_OFF.test(text)) return ''
  return text.slice(0, MAX_HINT_CHARS)
}

/** 设置页和旧调用：留空按所有者回合的内置说明。 */
export function resolveHint(raw) {
  return personaHint(raw, { direct: true })
}

function messageTextOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
}

/**
 * 把说明追加进请求 messages 的系统提示消息（没有就在最前面补一条）。返回 { messages, changed }。
 * 请求里的 messages 是深冻结的，所以一律拷贝；已经带有这段说明时原样返回（幂等）。
 */
export function injectHintIntoMessages(messages, hint) {
  const text = String(hint ?? '').trim()
  if (!Array.isArray(messages) || !text) return { messages, changed: false }
  if (messages.some((m) => (m?.role === 'system' || m?.role === 'developer') && messageTextOf(m).includes(text))) {
    return { messages, changed: false }
  }
  let at = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'system') { at = i; break }
  }
  if (at < 0) {
    const created = { id: 'immersive-hint', role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }
    return { messages: [created, ...messages], changed: true }
  }
  const base = messages[at]
  const blocks = Array.isArray(base.content)
    ? [...base.content]
    : (typeof base.content === 'string' && base.content ? [{ type: 'text', text: base.content }] : [])
  const glue = blocks.length > 0 ? '\n\n' : ''
  blocks.push({ type: 'text', text: glue + text })
  const next = messages.slice()
  next[at] = { ...base, content: blocks }
  return { messages: next, changed: true }
}

/** 办不成时给前台角色的话：中性、不带技术词，由角色自己用口吻转述。 */
export const SOFT_FAIL = Object.freeze({
  timeout: '等了很久也没办成，先放一放吧。',
  failed: '这事没办成。',
  unavailable: '现在办不了这件事。',
  empty: '没说清要办什么事。',
  denied: '这件事现在办不了。',
})

export function softFailText(reason) {
  if (reason === 'timeout') return SOFT_FAIL.timeout
  if (reason === 'unavailable') return SOFT_FAIL.unavailable
  if (reason === 'empty') return SOFT_FAIL.empty
  return SOFT_FAIL.failed
}

/** 访客助手额外拒绝的工具：即使在 OPEN_TOOLS 里，也不能让陌生人借助手翻别的会话记录。 */
export const OPEN_HELPER_DENY = Object.freeze(new Set([
  DOOR_NAME,
  ASK_USER_TOOL,
  'search_history',
  'search_pre_compaction',
]))

const OPEN_HELPER_DENY_PREFIXES = Object.freeze(['cross_session_'])

/** 助手里没有人能回答追问，也不允许套娃再开一道门。 */
const HELPER_ALWAYS_DENY = Object.freeze(new Set([DOOR_NAME, ASK_USER_TOOL]))

export function parseNameList(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))]
}

export function toolNameOf(tool) {
  return String(tool?.name ?? tool?.function?.name ?? '')
}

/** 访客助手是否放行此工具：只认 owner-gate 的开放集合，未知（含任何 MCP）一律不放行。 */
export function openHelperAllows(name) {
  const n = String(name ?? '')
  if (!n || OPEN_HELPER_DENY.has(n)) return false
  if (OPEN_HELPER_DENY_PREFIXES.some((p) => n.startsWith(p))) return false
  return isOpenTool(n)
}

/**
 * @param {{ sessionId: string, preset?: string, helperKind?: (id: string) => string, presets: Set<string> }} p
 * @returns {'persona'|'helper-owner'|'helper-open'|'other'}
 */
export function classifyRole({ sessionId, preset, helperKind, presets }) {
  const kind = typeof helperKind === 'function' ? helperKind(sessionId) : ''
  if (kind === 'owner') return 'helper-owner'
  if (kind === 'open') return 'helper-open'
  const p = String(preset ?? '').trim()
  if (p && presets?.has(p)) return 'persona'
  return 'other'
}

function selectPersonaErrand(tools, keep) {
  const next = tools.filter((t) => {
    const n = toolNameOf(t)
    return n === DOOR_NAME || keep.has(n)
  })
  // 门没出现在请求里（例如未经本插件注册）时补一份可变的副本，避免下游改动冻结对象。
  if (!next.some((t) => toolNameOf(t) === DOOR_NAME)) next.unshift(JSON.parse(JSON.stringify(DOOR_SCHEMA)))
  const changed = next.length !== tools.length || next.some((t, i) => t !== tools[i])
  return { tools: changed ? next : tools, changed }
}

/** 所有者前台：find_tools + 本会话已钉选的功能 + 点名保留。不放门，避免再去等后台助手。 */
function selectPersonaDirect(tools, keep, pins) {
  const next = []
  const seen = new Set()
  const push = (tool) => {
    const n = toolNameOf(tool)
    if (!n || seen.has(n) || n === DOOR_NAME) return
    seen.add(n)
    next.push(tool)
  }
  const found = tools.find((t) => toolNameOf(t) === FIND_TOOLS_NAME)
  const finder = found
    ? { ...found, description: PERSONA_FIND_TOOLS.description }
    : JSON.parse(JSON.stringify(PERSONA_FIND_TOOLS))
  push(finder)
  for (const tool of tools) {
    const n = toolNameOf(tool)
    if (keep.has(n) || pins.has(n)) push(tool)
  }
  const changed = next.length !== tools.length || next.some((tool, i) => tool !== tools[i])
  return { tools: changed ? next : tools, changed }
}

/**
 * 按角色改写一次请求里的工具清单。返回 { tools, changed }；没改动时 tools 与入参同一个数组。
 * @param {'persona'|'helper-owner'|'helper-open'|'other'} role
 * @param {any[]} tools
 * @param {{ keep?: Iterable<string>, direct?: boolean, pins?: Iterable<string> }} [opts]
 */
export function selectToolsForRole(role, tools, opts = {}) {
  if (!Array.isArray(tools)) return { tools, changed: false }
  if (role === 'persona') {
    const keep = new Set(opts.keep ?? [])
    if (opts.direct) return selectPersonaDirect(tools, keep, new Set(opts.pins ?? []))
    return selectPersonaErrand(tools, keep)
  }
  let drop
  if (role === 'helper-open') drop = (n) => !openHelperAllows(n)
  else if (role === 'helper-owner') drop = (n) => HELPER_ALWAYS_DENY.has(n)
  else drop = (n) => n === DOOR_NAME
  const next = tools.filter((t) => !drop(toolNameOf(t)))
  return next.length === tools.length ? { tools, changed: false } : { tools: next, changed: true }
}

const DIRECT_DOOR_DENY = '不要交办。先调用 find_tools，用白话写清要办的事；下一步清单里出现的功能，直接调用。'

/** tools.guard 用。direct 时只放行 find_tools、已钉选的功能、点名保留的工具；门改口让它去找。 */
export function personaDenyReason(name, keep, opts = {}) {
  const n = String(name ?? '')
  if (!opts.direct) {
    if (n === DOOR_NAME) return undefined
    if (keep?.has?.(n)) return undefined
    return SOFT_FAIL.denied
  }
  if (n === FIND_TOOLS_NAME) return undefined
  if (keep?.has?.(n)) return undefined
  if (opts.pins?.has?.(n)) return undefined
  if (n === DOOR_NAME) return DIRECT_DOOR_DENY
  return SOFT_FAIL.denied
}

/** tools.guard 用：后台助手的闸门。返回字符串即拒绝。 */
export function helperDenyReason(kind, name) {
  const n = String(name ?? '')
  if (HELPER_ALWAYS_DENY.has(n)) return n === DOOR_NAME ? '这里不能再委托别人。' : '没有人可以回答追问，请自行判断；办不了就直接说明。'
  if (kind === 'open' && !openHelperAllows(n)) return '委托人不是所有者，这件事不能做。请直接回复“这事办不了”。'
  return undefined
}

/** 其余会话里不允许出现门（清单里已去掉，这里是兜底）。 */
export function otherDenyReason(name) {
  return String(name ?? '') === DOOR_NAME ? SOFT_FAIL.denied : undefined
}

const MAX_WHAT_CHARS = 4000

/** 给后台助手的差事说明：它不是聊天角色，办完用简短中文口语汇报。 */
export function buildErrandPrompt({ what, owner }) {
  const text = String(what ?? '').trim().slice(0, MAX_WHAT_CHARS)
  const who = owner
    ? '委托人是所有者：你手上所有能力都可以用（包括读写本机文件、运行程序、操作桌面）。'
    : '委托人不是所有者：只做联网查资料、查时间天气、发表情包这类不碰这台电脑的事；读写本机文件、运行程序、操作桌面、代发消息、翻看其他聊天记录或记忆之类的事一律不做，直接回一句“这事办不了”。'
  return [
    '【差事】你是替人跑腿的后台助手，不是聊天角色。下面这件事请独立办完；没有人能回答你的追问，信息不够就按最合理的理解去办，实在办不了就直说原因。',
    who,
    '汇报要求：只用中文，口语化，1～4 句话讲清结果；不要 Markdown 标题、列表、表格、代码块；不要提“工具”“调用”“接口”这类技术词；网址、数字、文件路径等关键信息要保留。',
    `事项：${text}`,
  ].join('\n')
}

/** 助手一条 assistant/message 里的文字（只取 text 块）。 */
export function assistantTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let out = ''
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') out += b.text
  return out
}

/** tool/result 消息里的图片附件引用（同 channel-harness 的 collectToolResultImages 口径）。 */
export function imageRefsOf(message) {
  if (!message || message.isError === true || !Array.isArray(message.content)) return []
  const refs = []
  for (const b of message.content) {
    const ref = b && b.type === 'image' ? b.attachment : undefined
    if (ref && typeof ref.attachmentId === 'string' && typeof ref.mediaType === 'string') refs.push(ref)
  }
  return refs
}
