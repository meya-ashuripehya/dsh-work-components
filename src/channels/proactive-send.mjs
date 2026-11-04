/**
 * 主动出站：QQ / Telegram 在入站回合之外，按目标 ID 发文本和/或一个本地文件。
 * 文件走与 mm_send_file 相同的文档出站（adapter parts type:file），见 outbound-file.mjs。
 *
 * 工具（默认都不挂到全局，只挂到符合预设规则的智能体自己的 tools 层）：
 *   - telegram_proactive_send
 *   - qq_proactive_send
 * 与 harness 的 send_channel_message 不同：那个工具没有目标参数，只回当前会话绑定的那一个聊天。
 *
 * 设置（各通道独立，默认关）：
 *   - *ProactiveSendEnabled：总开关。关则不向任何会话提供对应工具，调用也拒绝。
 *   - *ProactiveSendAllowlist：允许作为目标的 ID。不在名单里一律拒绝。
 *     与入站白名单、授权用户（可改电脑的工具）不是同一份名单，这里不改那些名单。
 *
 * Telegram 用哪个机器人（扩展点 = resolveTelegramAccount）：
 *   会话键 telegram:<accountId>:<chat>[:thread]。目标聊天必须已经有绑定。
 *   不要求调用方传 accountId，也不在没有绑定时退回 main。
 *   零个账号 → 未绑定。多个 accountId 时，先按当前会话预设过滤：
 *   私聊比对该账号的 preset，群聊在填写了 groupPreset 时用 groupPreset，否则沿用 preset
 *   （见 group-route.mjs）。过滤后剩一个就用它；仍多个 → 有歧义；一个都不符 → 拒绝，不改用 main。
 *   调用方没有预设上下文时，多个账号仍直接拒绝（与旧行为一致）。
 *   可见性同时认 preset 与 groupPreset。未启用的机器人不参与匹配。
 *
 * QQ：只有账号 main，没有 groupPreset。填了 qqPreset 时，只有同一预设的会话能看到工具
 * （群也走这份预设）。qqPreset 留空时没有可对照的预设，只看开关和白名单。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { loadBindings as loadChannelBindings } from './cross-session-memory.mjs'
import { resolveChannelAccounts } from './telegram/accounts.mjs'
import { isGroupConversationId } from './telegram/group-route.mjs'
import { loadLocalFile } from './telegram/files.mjs'
import { OPEN_TOOLS } from './telegram/owner-gate.mjs'

export const TELEGRAM_PROACTIVE_TOOL = 'telegram_proactive_send'
export const QQ_PROACTIVE_TOOL = 'qq_proactive_send'
export const PROACTIVE_TOOL_NAMES = Object.freeze([TELEGRAM_PROACTIVE_TOOL, QQ_PROACTIVE_TOOL])

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      delivered: { type: 'boolean' },
      messageId: { type: 'string' },
      accountId: { type: 'string' },
      targetId: { type: 'string' },
      conversationType: { type: 'string' },
      fileName: { type: 'string' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: value?.ok && value?.delivered !== false
      ? `Sent to ${value.targetId} (${value.conversationType || 'dm'}${value.accountId ? `, account ${value.accountId}` : ''}${value.fileName ? `, file ${value.fileName}` : ''}${value.messageId ? `, message ${value.messageId}` : ''}).`
      : String(value?.error || 'Send refused.'),
  }],
}

export function parseIdList(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))]
}

function refused(error, extra = {}) {
  return { ok: false, delivered: false, error, ...extra }
}

function accepted(result, extra) {
  const messageId = result?.messageId != null && result.messageId !== '' ? String(result.messageId) : ''
  return {
    ok: true,
    delivered: result?.delivered !== false && result?.skipped !== true,
    ...(messageId ? { messageId } : {}),
    ...extra,
  }
}

/** dm | group | ''（无法判断）。 */
export function normalizeConversationType(value) {
  const t = String(value ?? '').trim().toLowerCase()
  if (!t) return ''
  if (t === 'dm' || t === 'user' || t === 'private' || t === 'c2c' || t === 'person') return 'dm'
  if (t === 'group' || t === 'supergroup' || t === 'channel') return 'group'
  return ''
}

function typeOfRow(row) {
  return normalizeConversationType(row?.conversationType)
}

function telegramParts(key) {
  const parts = String(key || '').split(':')
  // channel:account:conversation[:thread] — thread is not part of the chat id.
  if (parts[0] !== 'telegram' || parts.length < 3 || !parts[1] || !parts[2]) return null
  return { accountId: parts[1], conversationId: parts[2] }
}

function accountRecords(hits) {
  const map = new Map()
  for (const hit of hits) {
    let row = map.get(hit.accountId)
    if (!row) {
      row = { accountId: hit.accountId, types: new Set() }
      map.set(hit.accountId, row)
    }
    if (hit.conversationType) row.types.add(hit.conversationType)
  }
  return [...map.values()]
}

/** 群 ID 用 groupPreset（留空则回落到 preset）；其余目标用 preset。未启用的机器人没有可匹配的预设。 */
export function telegramAccountPreset(bot, kind) {
  if (!bot || bot.enabled === false) return ''
  if (kind === 'group') {
    const groupPreset = String(bot.groupPreset || '').trim()
    if (groupPreset) return groupPreset
  }
  return String(bot.preset || '').trim()
}

function targetKind(targetId, records) {
  if (isGroupConversationId(targetId)) return 'group'
  if (/^\d{1,20}$/.test(String(targetId || ''))) return 'dm'
  const types = new Set()
  for (const row of records) for (const kind of row.types) types.add(kind)
  if (types.size === 1) return [...types][0]
  return ''
}

function recordType(row) {
  return row.types.size === 1 ? [...row.types][0] : ''
}

/**
 * 扩展点：决定 Telegram 主动发送走哪个已启用机器人。
 * 只认现有通道绑定，不猜测 main。
 * options.presetId 有值时，先留下预设相符的账号（群看 groupPreset，否则看 preset）。
 * @returns {{ ok: true, accountId: string, conversationType: string } | { ok: false, code: string, error: string }}
 */
export function resolveTelegramAccount(bindings, targetId, options = {}) {
  const id = String(targetId ?? '').trim()
  if (!id) return { ok: false, code: 'invalid', error: '缺少目标 ID' }
  const hits = []
  for (const [key, row] of Object.entries(bindings || {})) {
    if (!row || typeof row !== 'object') continue
    const channel = String(row.channelId || String(key).split(':')[0] || '').toLowerCase()
    if (channel !== 'telegram') continue
    const parsed = telegramParts(key)
    const conversationId = String(row.conversationId || parsed?.conversationId || '').trim()
    if (conversationId !== id) continue
    const accountId = String(row.accountId || parsed?.accountId || '').trim()
    if (!accountId) continue
    hits.push({ accountId, conversationType: typeOfRow(row) })
  }
  const records = accountRecords(hits)
  if (records.length === 0) {
    return {
      ok: false,
      code: 'unbound',
      error: `没有已绑定的 Telegram 会话（telegram:<账号>:${id}），已拒绝发送`,
    }
  }
  const presetId = String(options.presetId ?? '').trim()
  let chosen = records
  if (presetId) {
    const kind = targetKind(id, records)
    const bots = Array.isArray(options.bots) ? options.bots : []
    const byId = new Map(bots.map((bot) => [String(bot?.id || '').trim(), bot]))
    chosen = records.filter((row) => telegramAccountPreset(byId.get(row.accountId), kind) === presetId)
    if (chosen.length === 0) {
      const names = records.map((row) => row.accountId).join('、')
      return {
        ok: false,
        code: 'preset-mismatch',
        error: `目标 ${id} 没有与当前预设「${presetId}」匹配的 Telegram 账号（已绑定 ${names}），已拒绝发送`,
      }
    }
  }
  if (chosen.length > 1) {
    const names = chosen.map((row) => row.accountId).join('、')
    const error = presetId
      ? `目标 ${id} 在当前预设「${presetId}」下仍绑定了多个 Telegram 账号（${names}），已拒绝发送`
      : `目标 ${id} 绑定了多个 Telegram 账号（${names}），已拒绝发送`
    return { ok: false, code: 'ambiguous', error }
  }
  return { ok: true, accountId: chosen[0].accountId, conversationType: recordType(chosen[0]) }
}

/** QQ 绑定只用来推断 dm/group；没有绑定时不阻止发送（账号始终是 main）。 */
export function resolveQqConversationType(bindings, targetId) {
  const id = String(targetId ?? '').trim()
  if (!id) return ''
  const types = new Set()
  for (const [key, row] of Object.entries(bindings || {})) {
    if (!row || typeof row !== 'object') continue
    const channel = String(row.channelId || String(key).split(':')[0] || '').toLowerCase()
    if (channel !== 'qq') continue
    const conversationId = String(row.conversationId || '').trim()
    if (conversationId !== id) continue
    const kind = typeOfRow(row)
    if (kind) types.add(kind)
  }
  if (types.size === 1) return [...types][0]
  return ''
}

/** 已启用机器人的私聊预设与群预设。空字符串不计入。未启用的机器人不计入。 */
export function telegramProactivePresets(cfg) {
  const set = new Set()
  for (const bot of resolveChannelAccounts(cfg || {})) {
    if (bot.enabled === false) continue
    const preset = String(bot.preset || '').trim()
    const groupPreset = String(bot.groupPreset || '').trim()
    if (preset) set.add(preset)
    if (groupPreset) set.add(groupPreset)
  }
  return set
}

export function telegramProactiveVisibility(cfg, presetId) {
  if (cfg?.telegramProactiveSendEnabled !== true) return false
  const id = String(presetId || '').trim()
  if (!id) return false
  return telegramProactivePresets(cfg).has(id)
}

/**
 * qqPreset 非空：只有该预设能看到工具（群没有单独预设，也走 qqPreset）。
 * qqPreset 为空：没有可对照的账号预设，只看开关。
 */
export function qqProactiveVisibility(cfg, presetId) {
  if (cfg?.qqProactiveSendEnabled !== true) return false
  const bound = String(cfg?.qqPreset || '').trim()
  if (!bound) return true
  return String(presetId || '').trim() === bound
}

export function visibleProactiveTools(cfg, presetId) {
  const names = []
  if (telegramProactiveVisibility(cfg, presetId)) names.push(TELEGRAM_PROACTIVE_TOOL)
  if (qqProactiveVisibility(cfg, presetId)) names.push(QQ_PROACTIVE_TOOL)
  return names
}

function readBindings(deps) {
  if (typeof deps.loadBindings === 'function') return deps.loadBindings() || {}
  return loadChannelBindings(deps.bindingsFile)
}

function allowlistHas(raw, targetId) {
  return parseIdList(raw).includes(targetId)
}

function sessionPresetId(deps, exec) {
  if (typeof deps.sessionPreset !== 'function') return ''
  try { return String(deps.sessionPreset(exec) || '').trim() } catch { return '' }
}

/** 有文件时 text / caption 都是说明；没有文件时二者都可当正文。保留调用方原来的空白。 */
function messageBody(args, hasFile) {
  const text = String(args?.text ?? '')
  const caption = String(args?.caption ?? '')
  if (hasFile) {
    if (caption.trim()) return caption
    if (text.trim()) return text
    return ''
  }
  if (text.trim()) return text
  if (caption.trim()) return caption
  return ''
}

/**
 * 白名单通过之后才读文件。path 为空表示只发文本。
 * 读文件用 mm_send_file 的 loadLocalFile（本地路径、50MB、拒绝网址）。
 */
async function readOutbound(args, deps) {
  const path = String(args?.path ?? '').trim()
  if (!path) {
    const text = messageBody(args, false)
    if (!text.trim()) return { error: '消息正文为空' }
    return { text, file: null }
  }
  const load = typeof deps.loadFile === 'function' ? deps.loadFile : loadLocalFile
  let loaded
  try { loaded = await load(path) } catch (error) { return { error: String(error?.message || error) } }
  if (!loaded || loaded.data == null || !loaded.name) return { error: '无法读取本地文件' }
  const file = {
    name: String(loaded.name),
    mimeType: String(loaded.mimeType || 'application/octet-stream'),
    localData: loaded.data,
    bytes: Number(loaded.bytes ?? loaded.data?.byteLength ?? loaded.data?.length ?? 0),
  }
  return { text: messageBody(args, true), file }
}

function outboundPayload(base, text, file) {
  const payload = { ...base }
  if (text) payload.text = text
  if (file) payload.file = file
  return payload
}

export async function deliverTelegramProactive(args, deps, exec) {
  const cfg = (typeof deps.getConfig === 'function' ? deps.getConfig() : {}) || {}
  if (cfg.telegramProactiveSendEnabled !== true) return refused('Telegram 主动发送未启用')
  const targetId = String(args?.target_id ?? args?.targetId ?? '').trim()
  if (!targetId) return refused('缺少目标 ID')
  if (!allowlistHas(cfg.telegramProactiveSendAllowlist, targetId)) {
    return refused(`目标 ${targetId} 不在主动发送白名单中，已拒绝`, { targetId })
  }
  let bindings
  try {
    bindings = readBindings(deps)
  } catch {
    return refused('无法读取通道会话绑定，已拒绝发送', { targetId })
  }
  const resolved = resolveTelegramAccount(bindings, targetId, {
    presetId: sessionPresetId(deps, exec),
    bots: resolveChannelAccounts(cfg),
  })
  if (!resolved.ok) return refused(resolved.error, { targetId })
  const explicit = args?.conversation_type != null && String(args.conversation_type).trim() !== ''
  const requested = normalizeConversationType(args?.conversation_type)
  if (explicit && !requested) return refused('conversation_type 只能是 dm 或 group', { targetId })
  if (requested && resolved.conversationType && requested !== resolved.conversationType) {
    const label = resolved.conversationType === 'group' ? '群聊' : '私聊'
    return refused(`目标 ${targetId} 的已绑定会话是${label}，与 conversation_type 不符，已拒绝`, { targetId })
  }
  const conversationType = requested || resolved.conversationType || (isGroupConversationId(targetId) ? 'group' : 'dm')
  const outbound = await readOutbound(args, deps)
  if (outbound.error) return refused(outbound.error, { targetId })
  if (typeof deps.send !== 'function') return refused('Telegram 通道未连接，无法主动发送', { targetId })
  try {
    const result = await deps.send(outboundPayload({
      accountId: resolved.accountId,
      conversationId: targetId,
      conversationType,
    }, outbound.text, outbound.file))
    return accepted(result, {
      accountId: resolved.accountId,
      targetId,
      conversationType,
      ...(outbound.file ? { fileName: outbound.file.name } : {}),
    })
  } catch (error) {
    return refused(String(error?.message || error), { targetId })
  }
}

export async function deliverQqProactive(args, deps) {
  const cfg = (typeof deps.getConfig === 'function' ? deps.getConfig() : {}) || {}
  if (cfg.qqProactiveSendEnabled !== true) return refused('QQ 主动发送未启用')
  const targetId = String(args?.target_id ?? args?.targetId ?? '').trim()
  if (!targetId) return refused('缺少目标 ID')
  if (!allowlistHas(cfg.qqProactiveSendAllowlist, targetId)) {
    return refused(`目标 ${targetId} 不在主动发送白名单中，已拒绝`, { targetId })
  }
  const explicit = args?.conversation_type != null && String(args.conversation_type).trim() !== ''
  const requested = normalizeConversationType(args?.conversation_type)
  if (explicit && !requested) return refused('conversation_type 只能是 dm 或 group', { targetId })
  let bound = ''
  try {
    bound = resolveQqConversationType(readBindings(deps), targetId)
  } catch {
    if (!requested) return refused('无法读取通道会话绑定，已拒绝发送', { targetId })
  }
  if (requested && bound && requested !== bound) {
    const label = bound === 'group' ? '群聊' : '私聊'
    return refused(`目标 ${targetId} 的已绑定会话是${label}，与 conversation_type 不符，已拒绝`, { targetId })
  }
  const conversationType = requested || bound
  if (!conversationType) {
    return refused('QQ 目标需指定 conversation_type：dm（用户 OpenID）或 group（群 group_openid）', { targetId })
  }
  if (typeof deps.send !== 'function') return refused('QQ 通道未连接，无法主动发送', { targetId })
  const outbound = await readOutbound(args, deps)
  if (outbound.error) return refused(outbound.error, { targetId })
  try {
    const result = await deps.send(outboundPayload({
      accountId: 'main',
      conversationId: targetId,
      conversationType,
    }, outbound.text, outbound.file))
    return accepted(result, {
      accountId: 'main',
      targetId,
      conversationType,
      ...(outbound.file ? { fileName: outbound.file.name } : {}),
    })
  } catch (error) {
    return refused(String(error?.message || error), { targetId })
  }
}

const TELEGRAM_DESCRIPTION = 'Send a text message and/or a local file to a Telegram user or group without waiting for an inbound reply. '
  + 'target_id is the numeric user id or chat id (groups are negative; supergroups start with -100). '
  + 'Pass text, or path (a local file, same document send as mm_send_file, up to 50MB). text or caption is the file caption. Remote URLs are refused. '
  + 'The sending bot is the one already bound to that chat (session key telegram:<accountId>:<chat>). '
  + 'If several accounts are bound, the account whose preset matches this session is used (groupPreset for a group target, otherwise preset). '
  + 'Unbound chats, no preset match, and more than one remaining match are refused. Do not pass an account id. Do not assume main. '
  + 'Only ids on the proactive-send allowlist are accepted. This does not grant computer-changing tools.'

const QQ_DESCRIPTION = 'Send a text message and/or a local file to a QQ user (OpenID, C2C) or group (group_openid) without waiting for an inbound reply. '
  + 'QQ has a single account, main. Pass conversation_type dm or group — OpenIDs do not encode which. '
  + 'Pass text, or path (a local file, same file send as mm_send_file, up to 50MB). text or caption is the file caption. Remote URLs are refused. '
  + 'Only ids on the proactive-send allowlist are accepted. '
  + 'This does not grant computer-changing tools and does not change who may use them.'

function toolParameters(extra) {
  return {
    target_id: {
      type: 'string',
      required: true,
      description: extra.target,
    },
    text: {
      type: 'string',
      description: 'Plain text to send. When path is set this is the file caption and may be empty. When path is omitted, empty text is refused.',
    },
    path: {
      type: 'string',
      description: 'Optional local file path (absolute or workspace-relative), sent as a document the same way as mm_send_file. Not a remote URL. Maximum 50MB.',
    },
    caption: {
      type: 'string',
      description: 'Optional file caption. Used when path is set; overrides text as the caption. Without path, used as the message text if text is empty.',
    },
    conversation_type: {
      type: 'string',
      enum: ['dm', 'group'],
      description: extra.kind,
    },
  }
}

export function createTelegramProactiveTool(deps) {
  return defineTool({
    name: TELEGRAM_PROACTIVE_TOOL,
    description: TELEGRAM_DESCRIPTION,
    parameters: toolParameters({
      target: 'Telegram user id or group chat id. Must be on the proactive-send allowlist.',
      kind: 'Optional. dm or group. Omit to use the bound session type. A mismatch with the binding is refused.',
    }),
    output: OUTPUT,
    async execute(args, exec) {
      return deliverTelegramProactive(args, deps, exec)
    },
  })
}

export function createQqProactiveTool(deps) {
  return defineTool({
    name: QQ_PROACTIVE_TOOL,
    description: QQ_DESCRIPTION,
    parameters: toolParameters({
      target: 'QQ user OpenID or group_openid. Must be on the proactive-send allowlist.',
      kind: 'dm for a user OpenID, group for a group_openid. Required when this id has no QQ session binding.',
    }),
    output: OUTPUT,
    async execute(args) {
      return deliverQqProactive(args, deps)
    },
  })
}

function asAgent(value, id) {
  if (!value || typeof value !== 'object') return null
  if (value.ctx && (value.id || id)) return value.id ? value : { ...value, id }
  if (value.agent?.ctx) {
    const agent = value.agent
    return agent.id ? agent : { ...agent, id: id || agent.id }
  }
  return null
}

/**
 * 按当前会话预设把工具挂到该智能体自己的 tools 上。关开关或预设不再匹配时卸下。
 * 不调用插件根上的 tools.register，避免所有会话都看到工具。
 */
export function createProactiveSendFeature(ctx, getConfig, options = {}) {
  const log = ctx?.logger ?? console
  const seen = new Map()
  const tracked = new Map()
  const offs = []
  let disposed = false
  const depsFor = (send) => ({
    getConfig,
    loadBindings: options.loadBindings,
    bindingsFile: options.bindingsFile,
    loadFile: options.loadFile,
    send,
    sessionPreset: (exec) => sessionPresetOf(exec),
  })
  const toolByName = new Map([
    [TELEGRAM_PROACTIVE_TOOL, createTelegramProactiveTool(depsFor(options.sendTelegram))],
    [QQ_PROACTIVE_TOOL, createQqProactiveTool(depsFor(options.sendQq))],
  ])

  function presetOf(agent) {
    if (typeof options.presetOf === 'function') return String(options.presetOf(agent) || '').trim()
    try {
      const presets = ctx?.get?.('agentPresets')
      const id = presets?.composedPreset?.(agent?.ctx)
      if (id) return String(id).trim()
    } catch { /* 宿主没有预设服务时再看会话头 */ }
    const header = agent?.session?.header?.agentPreset ?? agent?.session?.meta?.agentPreset
    return String(header || '').trim()
  }

  function sessionPresetOf(exec) {
    if (typeof options.sessionPreset === 'function') {
      try { return String(options.sessionPreset(exec) || '').trim() } catch { return '' }
    }
    const id = String(exec?.agent?.id || exec?.sessionId || '').trim()
    const stored = id ? seen.get(id) : null
    const live = stored || !id ? null : findLive(id)
    return presetOf(stored || live || exec?.agent || null)
  }

  function safeConfig() {
    try { return (typeof getConfig === 'function' ? getConfig() : {}) || {} } catch { return {} }
  }

  function registerScoped(agent, names) {
    const agentCtx = agent?.ctx
    if (!agentCtx) return null
    let cancelled = false
    const disposers = []
    const tools = names.map((name) => toolByName.get(name)).filter(Boolean)
    const apply = (toolCtx) => {
      if (cancelled) return
      const registry = toolCtx?.tools
      if (!registry || typeof registry.register !== 'function') return
      for (const tool of tools) {
        try {
          const off = registry.register(tool)
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          log.warn?.('dsh-workbench: proactive send register failed', error?.message || error)
        }
      }
    }
    try {
      if (typeof agentCtx.inject === 'function') agentCtx.inject(['tools'], apply)
      else apply(agentCtx)
    } catch (error) {
      log.warn?.('dsh-workbench: proactive send mount failed', error?.message || error)
      return null
    }
    return () => {
      cancelled = true
      for (const off of disposers) {
        try { off() } catch { /* 卸工具失败不挡住其余 */ }
      }
      disposers.length = 0
    }
  }

  function consider(agent) {
    if (disposed) return []
    const id = String(agent?.id || agent?.session?.id || '').trim()
    if (!id) return []
    const stored = agent?.ctx ? agent : (seen.get(id)?.ctx ? seen.get(id) : agent)
    if (stored?.ctx) seen.set(id, stored)
    const names = visibleProactiveTools(safeConfig(), presetOf(stored))
    const sig = names.join(',')
    const prev = tracked.get(id)
    if (prev && prev.sig === sig) return [...prev.names]
    prev?.dispose?.()
    if (!names.length) {
      tracked.delete(id)
      return []
    }
    const dispose = registerScoped(stored, names)
    if (!dispose) {
      tracked.delete(id)
      return []
    }
    tracked.set(id, { dispose, sig, names: [...names] })
    return [...names]
  }

  function findLive(id) {
    try {
      const agents = ctx?.get?.('agents')
      return asAgent(agents?.get?.(id), id)
    } catch {
      return null
    }
  }

  function listLive() {
    try {
      const agents = ctx?.get?.('agents')
      if (!agents) return []
      if (typeof agents.list === 'function') {
        const rows = agents.list()
        if (Array.isArray(rows)) return rows.map((row) => asAgent(row)).filter(Boolean)
      }
      if (agents.agents instanceof Map) return [...agents.agents.values()].map((row) => asAgent(row)).filter(Boolean)
    } catch { /* 没有枚举接口时只刷新已经见过的会话 */ }
    return []
  }

  function sync() {
    if (disposed) return
    const visited = new Set()
    for (const agent of listLive()) {
      const id = String(agent?.id || '')
      if (id) visited.add(id)
      consider(agent)
    }
    for (const agent of [...seen.values()]) {
      const id = String(agent?.id || '')
      if (id && visited.has(id)) continue
      consider(agent)
    }
  }

  function wrapAgents(agents) {
    if (!agents || agents.__dshProactiveWrapped) return
    const wrapSetup = (opts, idKey) => {
      const userSetup = opts?.setup
      return async function proactiveSetup(agentCtx, agent) {
        const result = await userSetup?.(agentCtx, agent)
        try {
          const id = agent?.id || opts?.[idKey] || opts?.sessionId
          consider(agent?.ctx ? agent : { id, ctx: agentCtx, session: agent?.session })
        } catch { /* 工具挂载失败不能打断建会话 */ }
        return result
      }
    }
    try {
      if (typeof agents.create === 'function') {
        const orig = agents.create
        agents.create = function proactiveCreate(opts = {}) {
          return orig.call(this, { ...opts, setup: wrapSetup(opts, 'sessionId') })
        }
      }
      if (typeof agents.resume === 'function') {
        const orig = agents.resume
        agents.resume = function proactiveResume(opts = {}) {
          return orig.call(this, { ...opts, setup: wrapSetup(opts, 'resumeSessionId') })
        }
      }
      Object.defineProperty(agents, '__dshProactiveWrapped', { value: true })
    } catch (error) {
      log.warn?.('dsh-workbench: proactive send could not wrap agents', error?.message || error)
    }
  }

  if (ctx && typeof ctx.on === 'function') {
    try {
      const offCreated = ctx.on('agent/created', (payload) => {
        const agent = asAgent(payload?.agent || payload)
        if (agent) consider(agent)
      })
      if (typeof offCreated === 'function') offs.push(offCreated)
    } catch { /* 宿主没有该事件时仍靠 create/resume 包装 */ }
    try {
      const offPreset = ctx.on('agent-preset/selected', (sessionId) => {
        const id = String(sessionId || '').trim()
        consider(seen.get(id) || findLive(id) || { id })
      })
      if (typeof offPreset === 'function') offs.push(offPreset)
    } catch { /* 同上 */ }
  }
  try { wrapAgents(ctx?.get?.('agents')) } catch { /* agents 可能还没挂上 */ }
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['agents'], (agentCtx) => {
        wrapAgents(agentCtx.agents || agentCtx.get?.('agents'))
      })
    } catch { /* 测试里的假 ctx 可以没有 inject 队列 */ }
  }

  // 主动发送不是「谁都能用」的工具：不放进 OPEN_TOOLS，通道回合里仍走所有者闸门。
  if (OPEN_TOOLS.has(TELEGRAM_PROACTIVE_TOOL) || OPEN_TOOLS.has(QQ_PROACTIVE_TOOL)) {
    log.warn?.('dsh-workbench: proactive send tools must stay out of OPEN_TOOLS')
  }

  return {
    sync,
    consider,
    mountedNames(id) {
      return [...(tracked.get(String(id || ''))?.names || [])]
    },
    async dispose() {
      disposed = true
      for (const rec of tracked.values()) rec.dispose?.()
      tracked.clear()
      seen.clear()
      for (const off of offs) {
        try { off() } catch { /* ignore */ }
      }
      offs.length = 0
    },
  }
}
