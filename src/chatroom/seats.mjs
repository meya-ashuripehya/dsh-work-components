/**
 * 聊天室席位：设置里的 chatroomSeats 是一个有序数组，每个席位 =
 *   { id, name, provider, model, preset, persona, enabled }
 *   provider / model —— DSH 服务商路由与模型 id（来自宿主 ctx.llm 注册表，见 ../dsh-catalog.mjs），
 *   preset           —— 可选的 DSH 智能体预设 id（ctx.agentPresets），只取其人设（dsh-persona prefix）作系统提示，
 *   persona          —— 可选的附加人设 / 要求。
 * 本插件不保存任何 API Key：调用全部经 DSH 的服务商层（ctx.llm.stream），密钥由 DSH 凭据服务持有。
 *
 * 旧版（0.3.4 开发中）是固定四个席位 + 每席位 API Key 的扁平键；migrateLegacyChatroom() 把它们折算成数组，
 * 并给出需要从设置里清除的旧键（含密钥）。
 */

export const MAX_SEATS = 12

/** 通用表单里仍显示的标量设置键（客户端 INPUT_FIELDS 核对用）。chatroomSeats 由聊天室面板单独编辑。 */
export const CHATROOM_KEYS = ['chatroomEnabled', 'chatroomUserName', 'chatroomDefaultMain', 'chatroomTurnBudget', 'chatroomMaxHistory', 'chatroomMaxOutputTokens', 'chatroomOwnerTelegramId', 'chatroomTelegramProxy', 'chatroomCursorAgentPath', 'chatroomCursorRepo', 'chatroomCursorTimeoutSec']
/** 由聊天室面板单独保存（PUT /chatroom/config），不经通用表单：长文本经整份设置回传时曾出现「Failed to fetch」。 */
export const CHATROOM_PANEL_KEYS = ['chatroomRules']
export const DEFAULT_OWNER_TELEGRAM_ID = '6153059771'
export const DEFAULT_CURSOR_AGENT = 'C:\\Users\\10917\\AppData\\Local\\cursor-agent\\cursor-agent.cmd'
export const CHATROOM_SEATS_KEY = 'chatroomSeats'

// ── 旧版扁平键（只用于迁移） ──
const LEGACY_DEFS = [
  { id: 'deepseek', key: 'Deepseek', provider: 'deepseek', name: 'DeepSeek' },
  { id: 'claude', key: 'Claude', provider: 'anthropic', name: 'Claude' },
  { id: 'gpt', key: 'Gpt', provider: 'openai', name: 'GPT' },
  { id: 'grok', key: 'Grok', provider: 'xai', name: 'Grok' },
]
const LEGACY_FIELDS = ['Enabled', 'Name', 'Model', 'Persona', 'ApiKey', 'BaseUrl']
export const LEGACY_CHATROOM_KEYS = ['chatroomOrder', 'chatroomProxy', ...LEGACY_DEFS.flatMap((d) => LEGACY_FIELDS.map((f) => `chatroom${d.key}${f}`))]

export function chatroomSchemaShape(z) {
  return {
    chatroomEnabled: z.boolean().default(false).description('（实验性，默认关闭，设置页暂不显示）启用聊天室：多个 AI 成员与您在同一房间协作讨论。默认关闭。关闭后停止进行中的发言，记录仍保留在数据目录 chatroom/。'),
    chatroomUserName: z.string().default('Shiro').description('您在聊天室中的名字。'),
    chatroomDefaultMain: z.string().default('deepseek').description('默认主答成员（名字或编号），默认 DeepSeek。消息中 @ 某位成员时，该成员成为本任务的主答。'),
    chatroomTurnBudget: z.natural().min(1).max(100).default(10).description('每个任务所有 AI 合计的发言回合上限，默认 10。用尽后由主答汇报进度，您回复「批准 +N」即可追加。'),
    chatroomAutoRounds: z.natural().min(1).max(10).default(1).description('（旧版设置，已由回合预算取代。）'),
    chatroomMaxHistory: z.natural().min(0).max(2000).default(60).description('每次调用最多带上的历史消息条数；0 为不限。默认 60。'),
    chatroomMaxOutputTokens: z.natural().min(64).max(32000).default(1024).description('每次发言的最大输出 token 数，默认 1024。'),
    chatroomRules: z.string().default('').description('追加的房间规则（所有成员共用）。在聊天室面板中单独保存。'),
    chatroomOwnerTelegramId: z.string().default(DEFAULT_OWNER_TELEGRAM_ID).description('所有者的 Telegram 数字用户 ID。只有该用户（或本机桌面端）可以批准追加回合与执行 Cursor 任务。'),
    chatroomTelegramProxy: z.string().default('').description('聊天室机器人访问 Telegram Bot API 的 HTTP 代理，例如 http://127.0.0.1:7890；留空时沿用 Telegram 通道的代理设置。'),
    chatroomCursorAgentPath: z.string().default(DEFAULT_CURSOR_AGENT).description('cursor-agent 命令的完整路径（headless 模式）。'),
    chatroomCursorRepo: z.string().default('').description('Cursor 任务默认的目标仓库目录。任务书未指定目录时使用。'),
    chatroomCursorTimeoutSec: z.natural().min(60).max(14400).default(1800).description('单次 Cursor 任务的超时时间（秒），超时后结束整个进程树。默认 1800。'),
    chatroomSeats: z.array(z.any()).default([]).description('成员列表（有序）：{ id, name, provider, model, preset, reasoningEffort, talents, prefer, rarely, never, leader, persona, enabled, telegram: { tokenRef, ingest, username } }。机器人令牌保存在宿主凭据中，这里只有引用名。'),
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** 席位的 Telegram 机器人：令牌只存宿主凭据（tokenRef 为引用名），这里不收令牌本身。 */
export function botTokenRef(seatId) {
  return 'CHATROOM_BOT_' + String(seatId).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN'
}
function normalizeBot(raw, seatId) {
  const b = raw && typeof raw === 'object' ? raw : {}
  const ref = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(b.tokenRef || '')) ? String(b.tokenRef) : botTokenRef(seatId)
  return { tokenRef: ref, ingest: b.ingest === true, username: str(b.username, 64).replace(/^@/, '') }
}

/** 把任意输入整理成合法席位数组（去重 id、截断、补默认值）。 */
export function normalizeSeats(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  const ids = new Set()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || out.length >= MAX_SEATS) continue
    let id = str(raw.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!id || ids.has(id)) { let n = out.length + 1; while (ids.has(`seat-${n}`)) n++; id = `seat-${n}` }
    ids.add(id)
    const provider = str(raw.provider, 80)
    const model = str(raw.model, 160)
    out.push({
      id,
      name: str(raw.name, 40) || model || `席位 ${out.length + 1}`,
      provider,
      model,
      preset: str(raw.preset, 80),
      reasoningEffort: str(raw.reasoningEffort, 40),
      talents: str(raw.talents, 400),
      prefer: str(raw.prefer, 400),
      rarely: str(raw.rarely, 400),
      never: str(raw.never, 400),
      leader: raw.leader === true,
      aliases: (Array.isArray(raw.aliases) ? raw.aliases : String(raw.aliases || '').split(/[,，\s]+/)).map((a) => str(String(a), 40)).filter(Boolean).slice(0, 8),
      telegram: normalizeBot(raw.telegram, id),
      persona: typeof raw.persona === 'string' ? raw.persona.slice(0, 8000) : '',
      enabled: raw.enabled !== false,
    })
  }
  // 只允许一个负责接收群消息的机器人（避免重复接收）
  let seen = false
  for (const s of out) { if (s.telegram.ingest) { if (seen) s.telegram.ingest = false; seen = true } }
  return out
}

/** 设置 → 有序席位（含未启用的）。 */
export function resolveSeats(cfg = {}) {
  return normalizeSeats(cfg[CHATROOM_SEATS_KEY])
}

/**
 * 旧版扁平键 → 席位数组。返回 { present: string[] 出现过的旧键, seats: 迁移出的席位（已有新数组时为 null） }。
 * 旧 API Key / 接口地址不迁移（DSH 服务商设置是唯一来源），只由调用方从设置中清除。
 */
export function migrateLegacyChatroom(value = {}) {
  const present = LEGACY_CHATROOM_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(value, k))
  if (!present.length) return { present, seats: null }
  if (Array.isArray(value[CHATROOM_SEATS_KEY]) && value[CHATROOM_SEATS_KEY].length) return { present, seats: null }
  const order = String(value.chatroomOrder || '').split(/[\s,，]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const ids = [...new Set([...order, ...LEGACY_DEFS.map((d) => d.id)])].filter((id) => LEGACY_DEFS.some((d) => d.id === id))
  const seats = []
  for (const id of ids) {
    const d = LEGACY_DEFS.find((x) => x.id === id)
    const get = (f) => value[`chatroom${d.key}${f}`]
    const touched = LEGACY_FIELDS.some((f) => f !== 'ApiKey' && f !== 'BaseUrl' && get(f) !== undefined && get(f) !== '' && get(f) !== false)
    if (!touched) continue
    seats.push({ id: d.id, name: str(get('Name')) || d.name, provider: d.provider, model: str(get('Model')), preset: '', persona: typeof get('Persona') === 'string' ? get('Persona') : '', enabled: get('Enabled') === true })
  }
  return { present, seats: normalizeSeats(seats) }
}
