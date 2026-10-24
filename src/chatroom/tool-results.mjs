/**
 * 聊天室工具结果的上下文控制：
 *   - 完整输出存文件 rooms/<id>/tool-results/<rid>.txt，房间消息只带预览（前 1200 + 后 400 字符）。
 *   - open_card(id, offset, limit, grep)（旧名 read_tool_result）分页 / 检索完整输出。
 *   - 相同工具 + 参数 + 输出去重（复用已有编号）。
 *   - 卡片：提示词里每次调用只剩一行标题（cardLine），见文件末尾。agingTurns / promptTokens 设置已不再使用（保留以兼容旧配置）。
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const TOOL_DEFAULTS = Object.freeze({
  enabled: true,
  finderProvider: 'deepseek',
  finderModel: 'deepseek-flash',
  toolsetMax: 12,
  agingTurns: 3,
  resultTokens: 600,
  summaries: false,
  summaryThreshold: 20000,
  maxPerFind: 3,
  promptTokens: 6000,
  wallClockMin: 15,
})

/** 中英混排粗略按 1 token ≈ 3 字符估算。 */
export const charsForTokens = (t) => Math.max(200, Math.round(Number(t) * 3))

export const PREVIEW_HEAD = 1200
export const PREVIEW_TAIL = 400

/** 长文本 → 头 + 省略说明 + 尾。cap 为单条结果在历史里的上限（字符）。 */
export function previewText(text, { id = '', head = PREVIEW_HEAD, tail = PREVIEW_TAIL, cap } = {}) {
  const t = String(text ?? '')
  if (cap && cap < head + tail) { const r = cap / (head + tail); head = Math.floor(head * r); tail = Math.floor(tail * r) }
  if (t.length <= head + tail + 80) return t
  const omitted = t.length - head - tail
  return `${t.slice(0, head)}\n…[省略 ${omitted} 字符；完整输出共 ${t.length} 字符${id ? `，可用 open_card("${id}", offset, limit, grep) 打开` : ''}]…\n${t.slice(-tail)}`
}

export const RESULT_ID_RE = /^r[a-z0-9]{4,20}$/

export function hashCall(tool, args, text) {
  return createHash('sha1').update(String(tool)).update('\0').update(typeof args === 'string' ? args : JSON.stringify(args ?? null)).update('\0').update(String(text ?? '')).digest('hex').slice(0, 16)
}

/** 从完整输出中取一页：offset/limit 按字符；grep 时按行匹配（不区分大小写），返回带行号的匹配行。 */
export function pageText(text, { offset = 0, limit = 4000, grep } = {}) {
  const t = String(text ?? '')
  const lim = Math.max(100, Math.min(12000, Math.round(Number(limit) || 4000)))
  if (grep && String(grep).trim()) {
    const g = String(grep)
    let re = null
    try { re = new RegExp(g, 'i') } catch { re = null }
    const needle = g.toLowerCase()
    const out = []
    let used = 0
    let matches = 0
    const lines = t.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle)
      if (!hit) continue
      matches++
      const line = `${i + 1}: ${lines[i].slice(0, 500)}`
      if (used + line.length > lim) continue
      out.push(line); used += line.length + 1
    }
    return { total: t.length, matches, shown: out.length, text: out.join('\n') || '(无匹配行)' }
  }
  const off = Math.max(0, Math.min(t.length, Math.round(Number(offset) || 0)))
  const part = t.slice(off, off + lim)
  return { total: t.length, offset: off, next: off + part.length < t.length ? off + part.length : null, text: part }
}

/**
 * @param {(roomId: string) => string} roomDir
 */
export function createToolResults(roomDir, { now = () => Date.now() } = {}) {
  const dirOf = (roomId) => join(roomDir(roomId), 'tool-results')
  const locks = new Map()
  async function readIndex(roomId) {
    try { const j = JSON.parse(await readFile(join(dirOf(roomId), 'index.json'), 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
  }
  async function withLock(roomId, fn) {
    const prev = locks.get(roomId) || Promise.resolve()
    const p = prev.then(fn, fn)
    locks.set(roomId, p.catch(() => {}))
    return p
  }
  /** 保存一次结果。返回 { id, chars, dedupeOf? }。 */
  function save(roomId, { tool, args, text }) {
    return withLock(roomId, async () => {
      const dir = dirOf(roomId)
      await mkdir(dir, { recursive: true })
      const idx = await readIndex(roomId)
      const h = hashCall(tool, args, text)
      const prior = idx.byHash?.[h]
      if (prior && RESULT_ID_RE.test(prior)) {
        try { await readFile(join(dir, prior + '.txt'), 'utf8'); return { id: prior, chars: String(text ?? '').length, dedupeOf: prior } } catch {}
      }
      const id = 'r' + now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5)
      await writeFile(join(dir, id + '.txt'), String(text ?? ''), 'utf8')
      idx.byHash = { ...(idx.byHash || {}), [h]: id }
      await writeFile(join(dir, 'index.json'), JSON.stringify(idx), 'utf8')
      return { id, chars: String(text ?? '').length }
    })
  }
  async function read(roomId, id, opts = {}) {
    if (!RESULT_ID_RE.test(String(id || ''))) return { ok: false, error: `无效的结果编号：${id}` }
    let text
    try { text = await readFile(join(dirOf(roomId), id + '.txt'), 'utf8') } catch { return { ok: false, error: `结果 ${id} 不存在` } }
    return { ok: true, id, ...pageText(text, opts) }
  }
  /** 删除一次结果（失败回合回滚用）：删文件，并去掉指向它的去重索引。不存在时返回 false。 */
  function remove(roomId, id) {
    if (!RESULT_ID_RE.test(String(id || ''))) return Promise.resolve(false)
    return withLock(roomId, async () => {
      const dir = dirOf(roomId)
      let removed = true
      try { await unlink(join(dir, id + '.txt')) } catch { removed = false }
      const idx = await readIndex(roomId)
      if (idx.byHash && Object.values(idx.byHash).includes(id)) {
        idx.byHash = Object.fromEntries(Object.entries(idx.byHash).filter(([, v]) => v !== id))
        await writeFile(join(dir, 'index.json'), JSON.stringify(idx), 'utf8')
      }
      return removed
    })
  }
  return { save, read, remove, dirOf }
}

// ── 卡片：每次工具调用 = 一张「世界的答卷」。其他成员（及之后的回合）只看到卡片标题与编号，
//    需要细节时用 open_card 打开；调用者本回合仍在工具循环里看到完整结果。标题由程序通用生成，新工具无需改动。──

/** 结果很短（单行且不超过该字符数）时直接写在卡片标题后面。 */
export const CARD_INLINE_MAX = 80

/** 可选的按工具覆盖的动作名（新工具不需要加在这里）。 */
export const CARD_LABEL_OVERRIDES = Object.freeze({
  web_search: '网页搜索',
  web_fetch: '读取网页',
  image_generate: '生成图片',
  find_tools: '查找工具',
  get_time: '查询时间',
  get_weather: '查询天气',
  cursor_handoff: 'Cursor 交接',
})

/** 工具名里的英文词 → 中文（动词 / 名词各一份；找不到的词保留原样）。 */
const VERB_WORDS = {
  read: '读取', write: '写入', list: '列出', ls: '列出', search: '搜索', find: '查找', fetch: '获取', get: '获取', open: '打开',
  look: '查看', view: '查看', show: '查看', run: '运行', exec: '执行', execute: '执行', query: '查询', send: '发送', post: '发送',
  create: '创建', make: '创建', new: '新建', add: '添加', update: '更新', edit: '编辑', set: '设置', delete: '删除', remove: '删除',
  download: '下载', upload: '上传', generate: '生成', gen: '生成', play: '执行', move: '移动', copy: '复制', check: '检查',
  analyze: '分析', analyse: '分析', describe: '描述', translate: '翻译', convert: '转换', calc: '计算', calculate: '计算',
  capture: '截取', take: '获取', present: '展示', load: '加载', save: '保存', install: '安装', close: '关闭', reset: '重置',
  hint: '分析', summarize: '总结', scan: '扫描', ping: '检测', lookup: '查询',
}
const NOUN_WORDS = {
  file: '文件', files: '文件', filesystem: '文件系统', fs: '文件', dir: '目录', directory: '目录', folder: '文件夹', path: '路径',
  web: '网页', page: '网页', url: '网页', site: '网站', image: '图片', images: '图片', img: '图片', photo: '照片', picture: '图片',
  screenshot: '截图', screen: '屏幕', text: '文本', doc: '文档', docs: '文档', document: '文档', pdf: 'PDF', sheet: '表格',
  excel: 'Excel', word: 'Word', board: '棋局', card: '牌局', cards: '牌局', game: '游戏', weather: '天气', time: '时间',
  calendar: '日历', event: '日程', events: '日程', note: '笔记', notes: '笔记', memory: '记忆', balance: '余额', map: '地图',
  mail: '邮件', email: '邮件', message: '消息', messages: '消息', issue: 'Issue', issues: 'Issue', repo: '仓库', repository: '仓库',
  code: '代码', commit: '提交', branch: '分支', news: '新闻', price: '价格', stock: '股票', music: '音乐', video: '视频',
  audio: '音频', voice: '语音', process: '进程', window: '窗口', windows: 'Windows', clipboard: '剪贴板', shell: '命令',
  command: '命令', powershell: 'PowerShell', bash: 'Bash', workspace: '工作区', dependencies: '依赖', dependency: '依赖',
  goal: '目标', todo: '待办', result: '结果', results: '结果', tool: '工具', tools: '工具', user: '用户', users: '用户',
  system: '系统', attachment: '附件', attachments: '附件', post: '帖子', posts: '帖子', trend: '趋势', trends: '趋势', db: '数据库', database: '数据库', table: '表', record: '记录',
}

function nameWords(tool) {
  const base = String(tool || '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^mcp__/, '')
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter(Boolean)
}

/** 工具名里没有动词时，参数 mode / action / operation 的值（如 list、read）可充当动词。 */
function modeVerb(args) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return '' } }
  if (!a || typeof a !== 'object') return ''
  for (const k of ['mode', 'action', 'operation', 'op', 'method']) {
    const v = typeof a[k] === 'string' ? a[k].trim().toLowerCase() : ''
    if (v && VERB_WORDS[v]) return VERB_WORDS[v]
  }
  return ''
}

/** 由工具名得出中文动作名：覆盖表 → 「动词 + 名词」→ 原名。 */
export function cardLabel(tool, args) {
  const name = String(tool || '').trim()
  if (!name) return '工具'
  if (CARD_LABEL_OVERRIDES[name]) return CARD_LABEL_OVERRIDES[name]
  const words = nameWords(name)
  const verb = words.map((w) => VERB_WORDS[w]).find(Boolean) || modeVerb(args)
  const nouns = []
  for (const w of words) if (NOUN_WORDS[w] && !nouns.includes(NOUN_WORDS[w])) nouns.push(NOUN_WORDS[w])
  const label = verb + nouns.slice(0, 2).join('')
  return label || name
}

/** 参数里最能说明这次调用的一项（按优先键；否则第一个短字符串值）。 */
export const CARD_ARG_KEYS = ['path', 'file', 'filename', 'file_path', 'filepath', 'dir', 'directory', 'query', 'q', 'url', 'name', 'title', 'id', 'prompt', 'text', 'game', 'move', 'action', 'command', 'location', 'city', 'keyword', 'keywords', 'search', 'topic']
export function salientArg(args) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return '' } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ''
  const lower = new Map(Object.keys(a).map((k) => [k.toLowerCase(), k]))
  const pick = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).replace(/\s+/g, ' ').trim() : ''
  for (const k of CARD_ARG_KEYS) { const real = lower.get(k); if (real !== undefined) { const v = pick(a[real]); if (v) return v } }
  for (const v of Object.values(a)) { const s = pick(v); if (s && s.length <= 200) return s }
  return ''
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
export function sizeLabel(chars) {
  const n = Number(chars)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1000) return `${n} 字`
  if (n < 10000) return `${(n / 1000).toFixed(1)}k 字`
  return `${Math.round(n / 1000)}k 字`
}

/** 卡片标题：动作名 · 关键参数 · 结果大小（失败 / 空：「空」）。 */
export function cardTitle({ tool, args, chars, ok = true, empty = false } = {}) {
  const parts = [cardLabel(tool, args)]
  const arg = salientArg(args)
  if (arg) parts.push(/[\\/]/.test(arg) && arg.length > 48 ? '…' + arg.slice(-47) : clip(arg, 48)) // 路径保留结尾（文件名）
  parts.push(!ok || empty ? '空' : sizeLabel(chars))
  return parts.filter(Boolean).join(' · ')
}

/** 很短的结果（单行、≤ CARD_INLINE_MAX 字符）直接内联。 */
export function inlineResult(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > CARD_INLINE_MAX || /[\r\n]/.test(t)) return ''
  return t
}

/** 结果是否算「空」：成功但没有内容（含 null / [] / {} 与只有空文本块的 MCP content）。 */
export function isBlankResult(text) {
  const t = String(text ?? '').trim()
  if (!t || t === 'null' || t === '[]' || t === '{}' || t === '""' || t === 'undefined') return true
  if (t[0] !== '{' || t.length > 2000) return false
  try {
    const v = JSON.parse(t)
    const c = Array.isArray(v?.content) ? v.content : null
    return !!c && Object.keys(v).every((k) => k === 'content' || k === 'isError' || k === 'details') && c.every((p) => p?.type === 'text' && !String(p.text ?? '').trim())
  } catch { return false }
}

/** 一张卡片在其他成员 / 之后回合提示词中的样子。 */
export function cardLine(m) {
  const d = m.data || {}
  const title = d.title || cardTitle({ tool: m.tool, args: d.args, chars: d.chars, ok: d.ok !== false })
  const who = m.speaker?.name || '?'
  if (d.ok === false || d.blank) return `[card by ${who} · ${title}] This sheet came back blank.`
  const inline = d.inline ?? inlineResult(d.preview && Number(d.chars) <= CARD_INLINE_MAX ? d.preview : '')
  if (inline) return `[card #${d.resultId} by ${who} · ${title}] → ${inline}`
  return `[card #${d.resultId} by ${who} · ${title}]`
}
