/**
 * find_tools 的选择器：把 DSH 工具目录（名称 + 简介）交给 DSH 已配置的 DeepSeek 服务商（默认 deepseek-flash），
 * 让它以纯文本 JSON 返回最合适的至多 3 个工具名。选择器本身不需要工具调用能力。
 */
import { randomUUID } from 'node:crypto'
import { isLegacyGamebotTool } from './tool-gate.mjs'

export const FIND_TOOLS_NAME = 'find_tools'
/** 打开卡片（工具结果）的工具；旧名 read_tool_result 仍可调用（不再提供给模型）。 */
export const OPEN_CARD_NAME = 'open_card'
export const READ_RESULT_NAME = 'read_tool_result'
export const OPEN_CARD_NAMES = new Set([OPEN_CARD_NAME, READ_RESULT_NAME])

export const FIND_TOOLS = {
  name: FIND_TOOLS_NAME,
  description: 'Search the world\'s console (the DSH tool catalog) for tools that can do what you need (files, web, apps, MCP servers, etc.). Describe the capability in plain words. Up to 3 matching tools are added to the room toolset (shared by everyone in the room) and become callable from your next step. Tools already in the toolset are listed in your tools; call them directly instead of searching again. Whenever none of your currently available tools exactly matches the task, call find_tools first to check whether another suitable tool exists, before answering without a tool, guessing, or saying you can\'t do it.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What you need a tool for, e.g. "read a local text file" or "search GitHub issues".' } },
    required: ['query'],
  },
}

export const OPEN_CARD = {
  name: OPEN_CARD_NAME,
  description: 'Open a card to read what is on it. Every tool call in this room is a fetch from the world\'s console and leaves a card (an answer sheet the world handed back); the room history only shows card titles like [card #r… · title]. Cards are shared: open any card, including ones other members got, instead of fetching the same thing again. Cards swept into the recycle bin open too. Page with offset/limit (characters) or filter lines with grep (case-insensitive regex or text).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Card id shown as #r… in the room history.' },
      offset: { type: 'integer', description: 'Start character offset, default 0.' },
      limit: { type: 'integer', description: 'Max characters to return, default 4000, max 12000.' },
      grep: { type: 'string', description: 'Only return matching lines (with line numbers).' },
    },
    required: ['id'],
  },
}
/** 旧名（向后兼容）。 */
export const READ_TOOL_RESULT = OPEN_CARD

/** 不交给选择器 / 不进工具集的工具：聊天室内置的，以及依赖 DSH 会话界面的。 */
export const CATALOG_EXCLUDE = new Set([FIND_TOOLS_NAME, OPEN_CARD_NAME, READ_RESULT_NAME, 'view_attachment', 'read_attachment', 'send_attachment', 'mm_send_image', 'mm_send_file', 'cursor_handoff', 'ask_user_question', 'todo_write', 'get_goal', 'set_goal', 'update_goal'])

/**
 * 只在 DSH 会话中有效的图片工具：Vision Router 的 vision_*（只认本会话上传的图片句柄）、read_image（把图片放进 DSH 会话）。
 * mm_send_image / mm_send_file 在聊天室里是内置工具（attachment-tools.mjs，走 send_attachment 的路径），不再视为会话工具。
 * 聊天室附件不在任何 DSH 会话里，这些工具拿到房间附件编号只会报「unknown attachment」，因此不进 find_tools 目录、不交给成员；
 * 房间内看图用 view_attachment，描述由房间自己生成（index.mjs describeImage）。
 */
export const SESSION_IMAGE_TOOLS = new Set(['read_image'])
export const isSessionImageTool = (name) => typeof name === 'string' && (/^vision_/i.test(name) || SESSION_IMAGE_TOOLS.has(name))
/** 不进 find_tools 目录、也不作为房间工具交给成员的工具。 */
export const isCatalogExcluded = (name) => CATALOG_EXCLUDE.has(name) || isSessionImageTool(name) || isLegacyGamebotTool(name)

const firstLine = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

/** 宿主工具注册表 → [{ name, description, parameters }]。 */
export function listCatalog(tools) {
  let list = []
  try { const s = tools?.schemas?.(); if (Array.isArray(s)) list = s } catch {}
  if (!list.length) {
    try {
      const v = tools?.view?.()
      if (v?.visible instanceof Map) list = [...v.visible.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }))
    } catch {}
  }
  const seen = new Set()
  const out = []
  for (const s of list) {
    if (!s || typeof s.name !== 'string' || isCatalogExcluded(s.name) || seen.has(s.name)) continue
    seen.add(s.name)
    out.push({ name: s.name, description: String(s.description || ''), parameters: s.parameters && typeof s.parameters === 'object' ? s.parameters : { type: 'object', properties: {} } })
  }
  return out
}

export function selectorPrompt(query, catalog, { current = [], max = 3 } = {}) {
  const system = [
    'You pick tools for an AI assistant from a tool catalog.',
    `Return ONLY a JSON object, no prose, no code fence: {"tools": ["name1", ...], "reason": "short reason"}.`,
    `Pick at most ${max} tools, best first, using exact names from the catalog. Pick none ({"tools": []}) if nothing fits.`,
    'Prefer the smallest set that fully covers the request. If a tool already in the current toolset fits, pick it (it is reported back as already available); do not skip it just because it is already there.',
  ].join('\n')
  const lines = catalog.map((t) => `- ${t.name}: ${firstLine(t.description)}`)
  const user = `Request: ${String(query || '').slice(0, 2000)}\n\nCurrent toolset: ${current.length ? current.join(', ') : '(empty)'}\n\nCatalog:\n${lines.join('\n')}`
  return { system, user }
}

/** 解析并校验选择器输出：只保留目录中存在的名称，去重，至多 max 个。 */
export function parseSelection(text, names, max = 3) {
  const valid = names instanceof Set ? names : new Set(names || [])
  const t = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')
  let obj = null
  const start = t.indexOf('{')
  if (start >= 0) {
    let depth = 0; let inStr = false; let esc = false
    for (let i = start; i < t.length; i++) {
      const c = t[i]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) { try { obj = JSON.parse(t.slice(start, i + 1)) } catch {} break }
    }
  }
  if (!obj) {
    const arr = /\[[^\]]*\]/.exec(t)
    if (arr) { try { obj = { tools: JSON.parse(arr[0]) } } catch {} }
  }
  if (!obj || !Array.isArray(obj.tools)) return { tools: [], rejected: [], reason: '', error: '选择器没有返回有效的 JSON' }
  const tools = []
  const rejected = []
  for (const raw of obj.tools) {
    const n = typeof raw === 'string' ? raw.trim() : (raw && typeof raw.name === 'string' ? raw.name.trim() : '')
    if (!n) continue
    if (!valid.has(n)) { rejected.push(n); continue }
    if (!tools.includes(n) && tools.length < max) tools.push(n)
  }
  return { tools, rejected, reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '' }
}

async function streamText(llm, { provider, model, system, user, maxTokens, signal }) {
  let text = ''
  let usage = null
  const stream = llm.stream({
    provider, model, system, maxTokens, signal,
    messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }],
  })
  for await (const c of stream) {
    if (c.type === 'text-delta' && c.text) text += c.text
    else if (c.type === 'usage') usage = c.usage
    else if (c.type === 'finish') {
      const r = c.reason || {}
      if (r.kind === 'error') throw new Error(r.failure?.message || r.failure?.code || '选择器请求失败')
      if (r.kind === 'aborted') throw Object.assign(new Error('已停止'), { aborted: true })
      break
    }
  }
  return { text, usage }
}

/**
 * 纯函数：查询词与当前工具集名称的字面匹配（不花 token；选择器什么都没选时兜底）。
 * 名称按 _ / - / 驼峰拆词；查询词（≥3 字符）与名称词相等或互为子串（≥4 字符）即算匹配。
 */
export function lexicalCurrentMatch(query, current = [], max = 3) {
  const q = String(query || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length >= 3)
  if (!q.length) return []
  const out = []
  for (const name of current || []) {
    const words = String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== 'mcp')
    const hit = q.some((w) => words.some((x) => x === w || (w.length >= 4 && x.includes(w)) || (x.length >= 4 && w.includes(x))))
    if (hit && !out.includes(name)) out.push(name)
    if (out.length >= max) break
  }
  return out
}

/** 调用 DSH 的 DeepSeek 服务商选择工具。 */
export async function selectTools({ llm, provider, model, query, catalog, current = [], max = 3, signal }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 服务商服务不可用（ctx.llm 未就绪）')
  const { system, user } = selectorPrompt(query, catalog, { current, max })
  const r = await streamText(llm, { provider, model, system, user, maxTokens: 400, signal })
  return { ...parseSelection(r.text, catalog.map((t) => t.name), max), raw: r.text.slice(0, 500), usage: r.usage }
}

/** 可选：长输出交给同一服务商压缩成摘要（默认关闭）。 */
export async function summarizeResult({ llm, provider, model, tool, text, maxChars = 1800, signal }) {
  const system = `Summarize the output of the tool "${tool}" for a group of AIs. Keep facts, numbers, names, paths, errors. Plain text, at most ${maxChars} characters. Reply in the language of the output.`
  const input = String(text || '')
  const user = input.length > 60000 ? input.slice(0, 45000) + '\n…\n' + input.slice(-15000) : input
  const r = await streamText(llm, { provider, model, system, user, maxTokens: Math.ceil(maxChars / 2), signal })
  return r.text.trim().slice(0, maxChars)
}
