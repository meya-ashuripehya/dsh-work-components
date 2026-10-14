/**
 * Telegram 通道上的多个机器人。
 * 主机器人仍是账号 main（令牌引用默认 TELEGRAM_BOT_TOKEN，预设用卡片上的原字段），
 * 已有会话键 telegram:main:<聊天> 保持不变。
 * telegramBots 是额外机器人：各自的账号标识、令牌引用和预设。会话键带账号，
 * 同一个人私聊不同机器人会落到不同的 DSH 会话。
 */

export const MAIN_ACCOUNT = 'main'
export const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
export const TELEGRAM_BOTS_KEY = 'telegramBots'
export const MAX_EXTRA_BOTS = 7
/** 写在入站更新上的账号标记，供棋牌出图认出是哪个机器人收到的。 */
export const UPDATE_ACCOUNT_KEY = '__dshAccountId'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/

const clip = (value, max = 80) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

export function tokenRefOf(cfg) {
  const ref = clip(cfg?.telegramTokenRef, 80)
  return REF_PATTERN.test(ref) ? ref : DEFAULT_TOKEN_REF
}

/** 额外机器人的凭据引用名。主机器人不用这个。 */
export function botTokenRef(id) {
  return 'TELEGRAM_BOT_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_TOKEN'
}

export function sameAccount(bound, incoming) {
  const a = clip(bound, 40) || MAIN_ACCOUNT
  const b = clip(incoming, 40) || MAIN_ACCOUNT
  return a === b
}

/** 整理额外机器人（不含 main）。非法项跳过，id 去重。 */
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
    })
  }
  return out
}

/** 主机器人（卡片原字段）在前，额外机器人在后。主机器人始终参与解析；没令牌时由准备阶段跳过。 */
export function resolveChannelAccounts(cfg = {}) {
  const main = {
    id: MAIN_ACCOUNT,
    name: '主机器人',
    tokenRef: tokenRefOf(cfg),
    preset: clip(cfg.telegramPreset, 80),
    groupPreset: clip(cfg.telegramGroupPreset, 80),
    enabled: true,
    builtin: true,
  }
  return [main, ...normalizeExtraBots(cfg[TELEGRAM_BOTS_KEY])]
}

export function channelTokenRefs(cfg = {}) {
  return [...new Set(resolveChannelAccounts(cfg).map((a) => a.tokenRef))]
}

/**
 * 配上已解析的令牌，去掉未启用、没令牌、以及和前面机器人重复令牌的项。
 * tokensByRef 的值是令牌字符串；空串视为没有。返回值里的 started 含 token，调用方不得记日志。
 */
export function prepareStartedAccounts(accounts, tokensByRef = {}) {
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

/** 非主机器人、且填了预设的账号覆盖。主机器人的预设走 agent.default。 */
export function accountRouteLines(started) {
  return (started || [])
    .filter((a) => a.id !== MAIN_ACCOUNT && a.preset)
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
