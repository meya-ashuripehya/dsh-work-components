import { normalizeSeatWait } from './providers.mjs'
import { createHash } from 'node:crypto'
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
/** 席位「识图」：auto 按 DSH 模型信息（inputModalities）判断；on 始终发送真图；off 只给文字描述。 */
export const VISION_MODES = ['auto', 'on', 'off']
/** 席位「发送图片」：recent9 = 最近 9 张图片发送原图（默认）；latest = 只发送触发本轮的最新一条用户消息中的图片，较早的图片只给说明行。 */
export const IMAGE_WINDOW_MODES = ['recent9', 'latest']
/** 成员列表的版本号（设置页保存时校验，避免用旧快照覆盖其他位置的更改）。 */
export function seatsRevision(seats) {
  return createHash('sha1').update(JSON.stringify(seats || [])).digest('hex').slice(0, 16)
}

/** 通用表单里仍显示的标量设置键（客户端 INPUT_FIELDS 核对用）。chatroomSeats 由聊天室面板单独编辑。 */
export const CHATROOM_KEYS = ['chatroomEnabled', 'chatroomUserName', 'chatroomDefaultMain', 'chatroomTurnBudget', 'chatroomGameAiStreak', 'chatroomMaxHistory', 'chatroomContextTokenThreshold', 'chatroomSummarizerProvider', 'chatroomSummarizerModel', 'chatroomMaxOutputTokens', 'chatroomOwnerTelegramId', 'chatroomTelegramProxy', 'chatroomCursorAgentPath', 'chatroomCursorRepo', 'chatroomCursorTimeoutSec', 'chatroomHeartbeatEnabled', 'chatroomHeartbeatIntervalMin', 'chatroomHeartbeatSessionId']
/** 由聊天室面板单独保存（PUT /chatroom/config），不经通用表单：长文本经整份设置回传时曾出现「Failed to fetch」。 */
export const CHATROOM_PANEL_KEYS = ['chatroomRules']
/** 聊天室面板「工具」分组单独保存（PUT /chatroom/config {tools}）。 */
export const CHATROOM_TOOL_KEYS = ['chatroomToolsEnabled', 'chatroomToolFinderProvider', 'chatroomToolFinderModel', 'chatroomToolsetMax', 'chatroomToolAgingTurns', 'chatroomToolResultTokens', 'chatroomToolSummaries', 'chatroomToolSummaryThreshold', 'chatroomToolPromptTokens', 'chatroomToolWallClockMin']
/** 聊天室面板「附件与语音」分组单独保存（PUT /chatroom/config {attach}）。转写密钥不在设置里：存宿主凭据 CHATROOM_GEMINI_TRANSCRIBE_KEY。 */
export const CHATROOM_ATTACH_KEYS = ['chatroomAttachEnabled', 'chatroomAttachDescribe', 'chatroomTranscribeEnabled', 'chatroomTranscribeModel', 'chatroomTranscribeMode', 'chatroomTranscribeLanguages']
/** 所有者 Telegram ID 与 cursor-agent 路径都没有内置默认值：所有者留空时 Telegram 上的所有者操作一律拒绝；路径留空时自动查找（cursor.mjs resolveCursorAgent）。 */
export const DEFAULT_OWNER_TELEGRAM_ID = ''
export const DEFAULT_CURSOR_AGENT = ''

/** 单次输出上限：0 / 空 / 未设置 = 不向服务商发送 maxTokens（仅受服务商自身上限约束）。 */
export function outputTokenLimit(value) {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(32000, Math.round(n))
}
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
    chatroomUserName: z.string().default('').description('您在聊天室中的名字。留空时显示为「用户」。'),
    chatroomDefaultMain: z.string().default('').description('主答成员（从成员列表中选择，无默认值）。未选择时不可保存房间设置。加入第一位成员时自动设为该成员；该成员被删除后清空。消息中提到某位成员（@名字 或直接写名字，多位取最先出现的）时，该成员成为本任务的主答。'),
    chatroomTurnBudget: z.natural().min(1).max(100).default(10).description('每个任务所有 AI 合计的发言回合上限，默认 10。成员看不到该上限；用尽后暂停并提示您，回复「批准 +N」（或「批准」，追加 3 个回合）即可继续。'),
    chatroomGameAiStreak: z.natural().min(0).max(10000).default(60).description('同一局棋牌中，连续由 AI 行动达到该步数时自动暂停，界面与绑定群提示后，所有者回复「继续」恢复。回复「停止」立即暂停且不结束对局。0 表示不限制。默认 60。对局行动不占用讨论回合。'),
    chatroomAutoRounds: z.natural().min(1).max(10).default(1).description('（旧版设置，已由回合预算取代。）'),
    chatroomMaxHistory: z.natural().min(0).max(200).default(24).description('提示词中保留的最近可见消息条数（滚动摘要窗口）。压缩后更早的消息对 AI 隐藏但仍在界面与磁盘中。0 为不限制窗口（仍可按 token 阈值压缩）。默认 24。'),
    chatroomContextTokenThreshold: z.natural().min(10000).max(2000000).default(150000).description('估计某成员本次请求（系统提示、房间规则、工具定义与消息）达到该 token 数时自动滚动摘要；模型上下文窗口已知时取其 75% 与该值中的较小者。中文约每字 1 token，其他文字约 4 字符 1 token。默认 150000。未选择摘要模型时不自动压缩。'),
    chatroomSummarizerProvider: z.string().default('').description('滚动摘要所用的独立小模型：DSH 服务商编号（在设置页从已配置密钥的服务商中选择）。留空则不启用自动压缩。密钥由 DSH 凭据保管。'),
    chatroomSummarizerModel: z.string().default('').description('滚动摘要所用模型 id。须与上方服务商一并填写。'),
    chatroomMaxOutputTokens: z.natural().min(0).max(32000).default(0).description('每次发言的最大输出 token 数。0 或不填表示不设上限（不向服务商发送 maxTokens，仅受该模型自身输出上限约束）。设置正数时，提供工具的步骤至少按 4096 计，避免工具调用因截断被丢弃。'),
    chatroomRules: z.string().default('').description('追加的房间规则（所有成员共用）。在聊天室面板中单独保存。'),
    chatroomOwnerTelegramId: z.string().default(DEFAULT_OWNER_TELEGRAM_ID).description('所有者的 Telegram 数字用户 ID。只有该用户（或本机桌面端）可以批准追加回合与执行 Cursor 任务。留空时 Telegram 上的这些所有者操作一律拒绝（本机桌面端仍视为所有者）。'),
    chatroomTelegramProxy: z.string().default('').description('聊天室机器人访问 Telegram Bot API 的 HTTP 代理，例如 http://127.0.0.1:7890；留空时沿用 Telegram 通道的代理设置。'),
    chatroomCursorAgentPath: z.string().default(DEFAULT_CURSOR_AGENT).description('cursor-agent 命令的完整路径（headless 模式）。留空时自动在 PATH 和常见安装位置查找。'),
    chatroomCursorRepo: z.string().default('').description('Cursor 任务默认的目标仓库目录。任务书未指定目录时使用。'),
    chatroomCursorTimeoutSec: z.natural().min(60).max(14400).default(1800).description('单次 Cursor 任务的超时时间（秒），超时后结束整个进程树。默认 1800。'),
    chatroomToolsEnabled: z.boolean().default(true).description('聊天室工具：启用后各成员可用 find_tools 查找工具（经 DSH 的 DeepSeek 服务商挑选），找到的工具加入房间工具集，所有成员共享。在聊天室面板「工具」中设置。'),
    chatroomToolFinderProvider: z.string().default('deepseek').description('find_tools 选择器所用的 DSH 服务商编号，默认 deepseek。'),
    chatroomToolFinderModel: z.string().default('deepseek-flash').description('find_tools 选择器所用的模型，默认 deepseek-flash。'),
    chatroomToolsetMax: z.natural().min(1).max(50).default(12).description('房间工具集上限，超出时移出最久未用的工具。默认 12。'),
    chatroomToolAgingTurns: z.natural().min(0).max(50).default(3).description('工具结果之后经过多少个 AI 回合即在提示词中折叠为一行。0 为不折叠。默认 3。'),
    chatroomToolResultTokens: z.natural().min(100).max(8000).default(600).description('单条工具结果在历史中的预览上限（tokens）。默认 600。'),
    chatroomToolSummaries: z.boolean().default(false).description('超长工具结果是否由选择器模型生成摘要。默认关闭。'),
    chatroomToolSummaryThreshold: z.natural().min(2000).max(500000).default(20000).description('生成摘要的结果长度阈值（字符）。默认 20000。'),
    chatroomToolPromptTokens: z.natural().min(500).max(64000).default(6000).description('每次调用中工具结果预览合计的上限（tokens），超出的较早结果折叠。默认 6000。'),
    chatroomToolWallClockMin: z.natural().min(1).max(120).default(15).description('单个成员一次发言中工具循环的时间上限（分钟），到时要求收尾。默认 15。'),
    chatroomAttachEnabled: z.boolean().default(true).description('聊天室附件：接收桌面端与绑定 Telegram 群的图片、文件、语音（单个 25 MB 以内，永久保存在房间目录 attachments/），成员可查看、读取并发送附件。在聊天室面板「附件与语音」中设置。'),
    chatroomAttachDescribe: z.boolean().default(true).description('为看不到图片的成员生成图片描述：由房间中能识图的成员所用模型生成（经 DSH 服务商层），没有能识图的成员时改用 Vision Router 插件。'),
    chatroomTranscribeEnabled: z.boolean().default(true).description('语音 / 音频消息经 Google Gemini（gemini-3.5-transcribe）转写为文字，原始音频保留为附件。'),
    chatroomTranscribeModel: z.string().default('gemini-3.5-transcribe').description('转写模型，默认 gemini-3.5-transcribe。'),
  chatroomVideoEnabled: z.boolean().default(true).description('（旧键）视频理解开关，已移到「多模态 › 视频理解」（videoEnabled）；启动时自动迁移，仅为兼容保留。'),
  chatroomVideoModel: z.string().default('gemini-3.8-flash').description('（旧键）视频理解模型，已移到「多模态 › 视频理解」（videoModel）；启动时自动迁移，仅为兼容保留。'),
    chatroomTranscribeMode: z.string().default('SMART').description('转写模式：SMART（去除口头语并整理格式，默认）或 VERBATIM（逐字）。'),
    chatroomTranscribeLanguages: z.string().default('').description('转写语言提示（BCP-47，逗号分隔，如 cmn-Hans-CN, ja-JP）；留空为自动识别。'),
    chatroomHeartbeatEnabled: z.boolean().default(false).description('聊天室心跳：回合正常结束（done / ended）后，经 DSH 宿主日程向所选会话投递一次提醒。默认关闭。勿将「聊天室：…」房间会话设为目标（访客模式、不跑模型）。'),
    chatroomHeartbeatIntervalMin: z.natural().min(1).max(1440).default(30).description('心跳间隔（分钟）。回合结束后等待该时长再向目标会话投递；有新一轮发言时取消并在再次结束时重新计时。默认 30。'),
    chatroomHeartbeatSessionId: z.string().default('').description('心跳目标 DSH 会话编号（须为普通智能体会话）。设置页下拉列出本机会话元数据中的可读标题（GET /chatroom/heartbeat → sessions，含冷会话）；勿选标题为「聊天室：…」的房间会话。'),
    chatroomSeats: z.array(z.any()).default([]).description('成员列表（有序）：{ id, name, provider, model, preset, reasoningEffort, vision（识图：auto / on / off）, imageWindow（发送图片：recent9 / latest）, video（视频输入：仅原生 Gemini 成员可开启）, timeoutSec（请求等待秒数：连接失败时在该时长内自动重试，0 为不重试）, talents, prefer, rarely, never, leader, persona, enabled, telegram: { tokenRef, ingest, username } }。机器人令牌保存在宿主凭据中，这里只有引用名。'),
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

/** 主答匹配键：名字 / 编号 / 别名（去空白、不区分大小写）。 */
function seatMatchKey(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
}

/** 在席位列表中按名字 / 编号 / 别名查找。 */
export function matchSeat(seats, name) {
  const n = seatMatchKey(name)
  if (!n) return null
  const list = Array.isArray(seats) ? seats : []
  return list.find((s) => seatMatchKey(s.id) === n || seatMatchKey(s.name) === n || (s.aliases || []).some((a) => seatMatchKey(a) === n)) || null
}

/**
 * 主答与成员列表对齐：
 * - 当前主答仍对应某位成员 → 保留为其 id
 * - 主答对应成员已删除或名单为空 → 清空（即使仍有其他成员）
 * - 原先无成员、现恰好一位（刚加入第一位）→ 设为该成员 id
 * @param {string} currentMain
 * @param {any[]} seats 新成员列表
 * @param {any[]} [prevSeats] 保存前的成员列表（用于区分「加入第一位」与「删除主答后剩一位」）
 */
export function syncDefaultMain(currentMain, seats, prevSeats) {
  const list = Array.isArray(seats) ? seats : []
  const hit = matchSeat(list, currentMain)
  if (hit) return hit.id
  const prev = Array.isArray(prevSeats) ? prevSeats : []
  if (prev.length === 0 && list.length === 1) return list[0].id
  return ''
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
      vision: VISION_MODES.includes(raw.vision) ? raw.vision : 'auto',
      imageWindow: IMAGE_WINDOW_MODES.includes(raw.imageWindow) ? raw.imageWindow : 'recent9',
      // 视频输入（多模态）：只对原生 Gemini 服务商生效（见 gemini-seat.isNativeGeminiSeat），其余成员保持「内容描述 + watch_video」
      video: raw.video === true && /^(google|gemini|google-ai|google-gemini|google-generative-ai)$/i.test(provider),
      // 请求等待（秒）：连接阶段失败时在该时长内自动重试；0 = 不额外等待（见 providers.callSeatWithWait）
      timeoutSec: normalizeSeatWait(raw.timeoutSec),
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
