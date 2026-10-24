/**
 * Telegram 通道上的多个机器人，彼此对等。
 * 持久化的 telegramBots 含全部机器人，其中 id 为 main 的那一行对应既有会话键
 * telegram:main:<聊天>，标识不能改、不能删。
 * 顶层 telegramPreset / telegramGroupPreset / telegramTokenRef 只是 main 行的兼容别名。
 */
import { createHash } from 'node:crypto'

export const MAIN_ACCOUNT = 'main'
export const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
export const TELEGRAM_BOTS_KEY = 'telegramBots'
export const MAX_EXTRA_BOTS = 7
/** 写在入站更新上的账号标记，供棋牌出图认出是哪个机器人收到的。 */
export const UPDATE_ACCOUNT_KEY = '__dshAccountId'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/
const ALIAS_KEYS = ['telegramPreset', 'telegramGroupPreset', 'telegramTokenRef']

const clip = (value, max = 80) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

export function tokenRefOf(cfg) {
  const ref = clip(cfg?.telegramTokenRef, 80)
  return REF_PATTERN.test(ref) ? ref : DEFAULT_TOKEN_REF
}

/** 额外机器人的凭据引用名。main 默认不用这个。 */
export function botTokenRef(id) {
  return 'TELEGRAM_BOT_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN'
}

export function sameAccount(bound, incoming) {
  const a = clip(bound, 40) || MAIN_ACCOUNT
  const b = clip(incoming, 40) || MAIN_ACCOUNT
  return a === b
}

function modelFields(raw) {
  return {
    provider: clip(raw?.provider, 80),
    model: clip(raw?.model, 120),
    reasoningEffort: clip(raw?.reasoningEffort, 40),
  }
}

function mainFromLegacy(cfg = {}) {
  return {
    id: MAIN_ACCOUNT,
    name: '主机器人',
    tokenRef: tokenRefOf(cfg),
    preset: clip(cfg.telegramPreset, 80),
    groupPreset: clip(cfg.telegramGroupPreset, 80),
    enabled: true,
    builtin: true,
    provider: '',
    model: '',
    reasoningEffort: '',
  }
}

function normalizeMain(raw, cfg) {
  const legacy = mainFromLegacy(cfg)
  const ref = REF_PATTERN.test(clip(raw?.tokenRef, 80)) ? clip(raw.tokenRef, 80) : legacy.tokenRef
  return {
    id: MAIN_ACCOUNT,
    name: clip(raw?.name, 40) || legacy.name,
    tokenRef: ref,
    preset: clip(raw?.preset, 80),
    groupPreset: clip(raw?.groupPreset, 80),
    enabled: raw?.enabled !== false,
    builtin: true,
    ...modelFields(raw),
  }
}

/** 整理额外机器人（不含 main）。非法项跳过，id 去重，最多 7 个。 */
export function normalizeExtraBots(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  const ids = new Set()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || out.length >= MAX_EXTRA_BOTS) continue
    const id = clip(raw.id, 24).toLowerCase()
    if (!ID_PATTERN.test(id) || id === MAIN_ACCOUNT || ids.has(id)) continue
    ids.add(id)
    const ref = REF_PATTERN.test(clip(raw.tokenRef, 80)) ? clip(raw.tokenRef, 80) : botTokenRef(id)
    out.push({
      id,
      name: clip(raw.name, 40) || id,
      tokenRef: ref,
      preset: clip(raw.preset, 80),
      groupPreset: clip(raw.groupPreset, 80),
      enabled: raw.enabled !== false,
      builtin: false,
      ...modelFields(raw),
    })
  }
  return out
}

export function botsIncludeMain(list) {
  return Array.isArray(list) && list.some((b) => clip(b?.id, 24).toLowerCase() === MAIN_ACCOUNT)
}

/**
 * 统一列表：始终有且只有一行 main（id 不可改），其余沿用额外机器人的规则。
 * 输入里没有 main 时，用顶层旧字段合成一行。
 */
export function normalizeBots(input, cfg = {}) {
  const list = Array.isArray(input) ? input : []
  let mainRaw = null
  const extras = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    if (clip(raw.id, 24).toLowerCase() === MAIN_ACCOUNT) {
      if (!mainRaw) mainRaw = raw
      continue
    }
    extras.push(raw)
  }
  const main = mainRaw ? normalizeMain(mainRaw, cfg) : mainFromLegacy(cfg)
  return [main, ...normalizeExtraBots(extras)]
}

/** 数组里还没有 main 时返回迁移后的完整列表；已经有则返回 null。 */
export function migrateTelegramBots(cfg = {}) {
  if (botsIncludeMain(cfg[TELEGRAM_BOTS_KEY])) return null
  return normalizeBots(cfg[TELEGRAM_BOTS_KEY], cfg)
}

/** 把 main 行写回顶层别名，并清掉会压过各机器人预设的会话级覆盖。 */
export function aliasPatchFromBots(bots) {
  const main = (bots || []).find((b) => b && b.id === MAIN_ACCOUNT)
  const patch = { telegramConversationRoutes: '' }
  if (!main) return patch
  patch.telegramPreset = main.preset || ''
  patch.telegramGroupPreset = main.groupPreset || ''
  patch.telegramTokenRef = main.tokenRef || DEFAULT_TOKEN_REF
  return patch
}

/**
 * 设置里如果还写了顶层别名，折进 main 行。
 * 没有碰到这些键时返回 null，避免每次保存都重写机器人列表。
 */
export function syncAliasesIntoBots(stored, patch = {}) {
  if (!ALIAS_KEYS.some((k) => Object.prototype.hasOwnProperty.call(patch, k))) return null
  const bots = normalizeBots(stored, patch)
  const main = bots.find((b) => b.id === MAIN_ACCOUNT)
  if (Object.prototype.hasOwnProperty.call(patch, 'telegramPreset')) main.preset = clip(patch.telegramPreset, 80)
  if (Object.prototype.hasOwnProperty.call(patch, 'telegramGroupPreset')) main.groupPreset = clip(patch.telegramGroupPreset, 80)
  if (Object.prototype.hasOwnProperty.call(patch, 'telegramTokenRef')) {
    const ref = clip(patch.telegramTokenRef, 80)
    if (REF_PATTERN.test(ref)) main.tokenRef = ref
  }
  return bots
}

/** main 在前。没有单独的 main 行时由旧字段合成。 */
export function resolveChannelAccounts(cfg = {}) {
  return normalizeBots(cfg[TELEGRAM_BOTS_KEY], cfg)
}

/** 已启用机器人的凭据引用（含 main）。未启用的不参与轮询，也不参与冲突比较。 */
export function channelTokenRefs(cfg = {}) {
  return [...new Set(resolveChannelAccounts(cfg).filter((a) => a.enabled !== false).map((a) => a.tokenRef))]
}

/** 聊天室里负责收群消息的那个席位。 */
export function ingestSeat(cfg = {}) {
  const seats = Array.isArray(cfg.chatroomSeats) ? cfg.chatroomSeats : []
  return seats.find((s) => s && s.enabled !== false && s.telegram?.ingest === true) || null
}

/** 通道各机器人 + 聊天室接收机器人的凭据引用。 */
export function pollingTokenRefs(cfg = {}) {
  const refs = channelTokenRefs(cfg)
  const ref = clip(ingestSeat(cfg)?.telegram?.tokenRef, 80)
  if (ref) refs.push(ref)
  return [...new Set(refs)]
}

export async function collectTokenValues(refs, resolve) {
  const out = []
  for (const ref of refs || []) {
    let value = ''
    try { value = await resolve?.(ref) } catch { value = '' }
    if (typeof value === 'object' && value) value = value.value
    if (typeof value === 'string' && value) out.push(value)
  }
  return out
}

/**
 * 配上已解析的令牌，去掉未启用、没令牌、与前面机器人重复的项。
 * 同一令牌可与聊天室共享（按群分流，全进程只一处 getUpdates）；reservedTokens 参数保留兼容，不再用于跳过。
 * 返回值里的 started 含 token，调用方不得记日志。
 */
export function prepareStartedAccounts(accounts, tokensByRef = {}, _reservedTokens = []) {
  const started = []
  const skipped = []
  const seen = new Map()
  for (const account of accounts || []) {
    if (account.enabled === false) {
      skipped.push({ id: account.id, name: account.name, reason: '未启用' })
      continue
    }
    const token = String(tokensByRef[account.tokenRef] || '')
    if (!token) {
      skipped.push({ id: account.id, name: account.name, reason: '未保存令牌' })
      continue
    }
    const previous = seen.get(token)
    if (previous) {
      skipped.push({ id: account.id, name: account.name, reason: `与「${previous}」使用了同一个令牌` })
      continue
    }
    seen.set(token, account.name)
    started.push({ ...account, token })
  }
  return { started, skipped }
}

/** 一个账号要写进 harness 的路由。空字段不写，避免把预设或模型清成空串。 */
export function accountRouteOf(account) {
  if (!account) return null
  const route = {}
  if (account.preset) route.preset = account.preset
  if (account.provider) route.provider = account.provider
  if (account.model) route.model = account.model
  if (account.reasoningEffort) route.reasoningEffort = account.reasoningEffort
  return Object.keys(route).length ? route : null
}

/** 每个已启动账号一条路由，含 main。值为 { preset?, provider?, model?, reasoningEffort? }。 */
export function accountRouteMap(started) {
  const out = {}
  for (const account of started || []) {
    const route = accountRouteOf(account)
    if (route) out[account.id] = route
  }
  return out
}

/** 旧的「id:预设」文本。有预设的账号都写出，含 main。 */
export function accountRouteLines(started) {
  return (started || [])
    .filter((a) => a.preset)
    .map((a) => `${a.id}:${a.preset}`)
    .join('\n')
}

/** 各账号的群聊预设。留空的不写入，群聊就沿用该账号的私聊预设。 */
export function groupPresetMap(started) {
  const out = {}
  for (const account of started || []) {
    if (account.groupPreset) out[account.id] = account.groupPreset
  }
  return out
}

/**
 * 聊天室接收循环的重启键。通道令牌只取哈希，不把明文放进键里。
 * 令牌集合或通道启用状态变化时键会变，从而重新做冲突检查。
 */
export function pollingRestartKey({ seatId = '', tokenRef = '', hasToken = false, telegramEnabled = false, tokens = [], channelOwned = false } = {}) {
  const hash = createHash('sha256').update((tokens || []).filter(Boolean).sort().join('\0')).digest('hex').slice(0, 12)
  return [seatId, tokenRef, hasToken ? '1' : '0', telegramEnabled ? '1' : '0', channelOwned ? '1' : '0', hash].join('|')
}
