/**
 * Telegram 通道运行时（单独打包为 lib/channel-telegram.mjs，只在「通道 › Telegram」启用时才被动态 import）。
 *
 * 复用 @wsz987/channel-core / channel-harness / channel-telegram 0.5.1（vendor/wsz987/ 下的打补丁副本，
 * 补丁见 vendor/wsz987/patches/）：
 *   - channel-telegram：getMe / deleteWebhook / 接收循环失败可无限退避重试、接收看门狗、单条更新处理预算；
 *   - channel-harness：流式工具循环正文去重、inboundPreempt 入站插队、工具结果图片（mm_send_image 等）转发为 Telegram 图片，工具结果文件（mm_send_file）转发为 Telegram 文档。
 *     地图标点（kind place）不转发预览图，改由本模块调用 sendVenue（坐标须已是 WGS-84）。
 *     日历（kind calendar）另发一条 HTML 月历，天气用表情符号。
 *
 * 挂载方式与 dsh-telegram-temp 的 cordis.patch.yml 一致（channel-core → channel-harness → telegram 适配器），
 * 但全部挂在本插件 ctx.plugin() 的一个 fork 下：关闭「启用」或插件卸载时整棵 fork 一起 dispose
 * （适配器 stop：停止长轮询；harness 的 ctx.effect 清理回复管线）。本模块从不直接写会话日志。
 */
import { apply as applyChannelCore } from '@wsz987/channel-core/plugin'
import {
  FileStorage,
  accessPolicyStorageKey,
  channelAccessPolicySchema,
  mountChannelAdapter,
  resolveChannelDataDirectory,
} from '@wsz987/channel-core'
import * as harness from '@wsz987/channel-harness'
import { Config as TelegramConfig, FetchTransport, TelegramAdapter } from '@wsz987/channel-telegram'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { join } from 'node:path'
import { installMapPlaceDelivery } from './place.mjs'
import { installCalendarDelivery } from './calendar.mjs'
import { installFileDelivery } from './files.mjs'
import { DENY_MESSAGE, createOwnerGate, installOwnerGate, setActiveGate, clearActiveGate, resolveAuthorizedIds } from './owner-gate.mjs'
import { installGroupRoute, setExcludedGroupChats, setGroupPreset, setGroupPresets } from './group-route.mjs'
import { MAIN_ACCOUNT, accountRouteMap, accountRouteOf, groupPresetMap } from './accounts.mjs'
import { createTelegramFanout } from './fanout.mjs'
import { rawHub, noteDiscover } from '../../telegram/raw-hub.mjs'
import { classifyDestination, extractChatFromUpdate } from '../../telegram/dispatch.mjs'
import { claimPollingToken, releaseAll } from '../../telegram/polling-owners.mjs'
import { dmSenderOf, isUnauthorizedDm, noteDmDiscover } from '../../telegram/dm-discover.mjs'
import { installBoardsLink, mountBoardsBridge } from './boards-link.mjs'
import { installCardsLink } from './cards-link.mjs'
import { installPersonMemoryInject } from '../person-memory-inject.mjs'

installMapPlaceDelivery(harness.ReplyRouter)
installCalendarDelivery(harness.ReplyRouter)
installFileDelivery(harness.ReplyRouter)
installOwnerGate(harness.ReplyContextStore)
installGroupRoute(harness.AgentRouter)
installBoardsLink(harness.ReplyContextStore, harness.ChannelHarnessBridge)
installCardsLink(harness.ChannelHarnessBridge)
installPersonMemoryInject(harness.ChannelHarnessBridge)

export { DENY_MESSAGE, createOwnerGate, resolveAuthorizedIds, setGroupPreset }

/** channel-harness 需要的宿主服务（与它自己的 inject 相同，去掉本 fork 提供的 channels）。 */
export const HOST_SERVICES = harness.inject.filter((n) => n !== 'channels')
export const CHANNEL_ID = 'telegram'
export const ACCOUNT_ID = 'main'

/** 打补丁标记（冒烟 / 检查用）：产物里必须同时含有这三类补丁。 */
export const PATCH_MARKERS = {
  telegramStall: typeof TelegramAdapter.prototype.runSupervisor === 'function' && typeof TelegramAdapter.prototype.startWatchdog === 'function',
  harnessImages: typeof harness.ReplyRouter?.prototype?.deliverTurnImages === 'function',
  mapPlace: harness.ReplyRouter?.prototype?.__dshMapPlace === true,
  calendarDelivery: harness.ReplyRouter?.prototype?.__dshCalendar === true,
  ownerGate: harness.ReplyContextStore?.prototype?.__dshOwnerGate === true,
  groupRoute: harness.AgentRouter?.prototype?.__dshGroupRoute === true,
  boardsLink: harness.ReplyContextStore?.prototype?.__dshBoardsLink === true && harness.ChannelHarnessBridge?.prototype?.__dshBoardsInbound === true,
  cardsLink: harness.ChannelHarnessBridge?.prototype?.__dshCardsInbound === true,
  harnessPreempt: Object.prototype.hasOwnProperty.call(harness.Config({}), 'inboundPreempt'),
  harnessSegments: typeof harness.ReplyRouter?.prototype?.flushProcess === 'function',
  telegramDraftStream: typeof TelegramAdapter.prototype.resolveStreamingMode === 'function',
}

const TOKEN_LIKE = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g
/** 日志行脱敏：去掉形如 Bot 令牌的片段，压成一行并截断。只取消息文字，不带附加对象（不含会话内容）。 */
export function sanitizeLogLine(parts) {
  const list = Array.isArray(parts) ? parts : [parts]
  const text = list
    .map((p) => (p instanceof Error ? p.message : p && typeof p === 'object' && p.error instanceof Error ? p.error.message : p))
    .filter((p) => typeof p === 'string')
    .join(' ')
    .replace(TOKEN_LIKE, '<token>')
    .replace(/\/bot[^/\s]+/g, '/bot<token>')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 200 ? text.slice(0, 197) + '…' : text
}

/** getUpdates 409：同一机器人正被别处长轮询（或设置了 webhook）。 */
export function isPollingConflict(line) {
  return /terminated by other getUpdates/i.test(line) || (/\b409\b/.test(line) && /conflict|getUpdates/i.test(line))
}

export function parseIdList(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))]
}

function groupRule(senderPolicy, allowFrom, requireMention) {
  const sender = senderPolicy === 'allowlist' ? 'allowlist' : 'open'
  return {
    enabled: true,
    senderPolicy: sender,
    allowFrom: sender === 'allowlist' ? [...allowFrom] : [],
    requireMention: requireMention !== false,
  }
}

/**
 * group 省略时沿用已存群规则。传入时以卡片为准：
 * disabled 清空群；allowlist 为每个群 ID 写一条规则；open 只写 defaultGroupRule。
 */
function groupSection(existing, allowFrom, group) {
  if (group == null) {
    const groupPolicy = existing?.groupPolicy ?? 'disabled'
    return {
      groupPolicy,
      groups: groupPolicy === 'open' ? {} : { ...(existing?.groups ?? {}) },
      ...(groupPolicy === 'open' && existing?.defaultGroupRule ? { defaultGroupRule: existing.defaultGroupRule } : {}),
    }
  }
  const policy = String(group.policy || 'disabled')
  if (policy !== 'disabled' && policy !== 'allowlist' && policy !== 'open') {
    throw new Error('群聊策略必须是关闭、指定群或所有群')
  }
  if (policy === 'disabled') return { groupPolicy: 'disabled', groups: {} }
  if (policy === 'open') return { groupPolicy: 'open', groups: {}, defaultGroupRule: groupRule(group.senderPolicy, allowFrom, group.requireMention) }
  const ids = parseIdList(group.chatIds)
  for (const id of ids) {
    if (!/^-?\d{1,20}$/.test(id)) throw new Error(`群 ID「${id}」不是 Telegram 数字聊天 ID`)
  }
  const groups = {}
  for (const id of ids) groups[id] = groupRule(group.senderPolicy, allowFrom, group.requireMention)
  return { groupPolicy: 'allowlist', groups }
}

/**
 * 由卡片里的所有者、私聊白名单和群聊设置生成访问策略。
 * ownerId 为空时返回 null：不改动已存策略（群聊设置同样不写入）。
 * group 省略时群规则保持原样，供未带群聊参数的调用方使用。
 */
export function buildAccessPolicy(existing, ownerId, allowFromRaw, group) {
  const owner = String(ownerId ?? '').trim()
  if (!owner) return null
  if (!/^-?\d{1,20}$/.test(owner)) throw new Error('所有者 ID 必须是 Telegram 数字用户 ID')
  const extra = parseIdList(allowFromRaw).filter((id) => id !== owner)
  for (const id of extra) if (!/^-?\d{1,20}$/.test(id)) throw new Error(`允许的用户 ID「${id}」不是 Telegram 数字用户 ID`)
  const allowFrom = [owner, ...extra]
  const policy = {
    version: 1,
    preset: extra.length ? 'allowlist' : 'owner-only',
    ownerId: owner,
    dmPolicy: 'allowlist',
    allowFrom,
    ...groupSection(existing, allowFrom, group),
  }
  const parsed = channelAccessPolicySchema.safeParse(policy)
  if (!parsed.success) throw new Error('访问策略无效：' + parsed.error.message)
  return parsed.data
}

function policyStorage() {
  return new FileStorage({ directory: join(resolveChannelDataDirectory(), 'storage') })
}

/** 读已存访问策略（只返回摘要，不含会话数据）。 */
export async function readAccessPolicy() {
  try {
    const raw = await policyStorage().get(accessPolicyStorageKey(CHANNEL_ID, ACCOUNT_ID))
    if (raw === undefined) return { state: 'missing' }
    const parsed = channelAccessPolicySchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return { state: 'invalid' }
    const p = parsed.data
    return { state: 'ok', preset: p.preset, ownerId: p.ownerId ?? null, allowFrom: p.allowFrom, dmPolicy: p.dmPolicy, groupPolicy: p.groupPolicy, policy: p }
  } catch {
    return { state: 'invalid' }
  }
}

/** 写访问策略（与已存相同时不写）。返回 'unchanged' | 'written' | 'kept'。group 见 buildAccessPolicy。accountIds 里的每个账号各写一份，缺了策略的机器人会把消息全部丢掉。 */
export async function applyAccessPolicy(ownerId, allowFromRaw, group, accountIds) {
  const ids = [...new Set((accountIds?.length ? accountIds : [ACCOUNT_ID]).map((id) => String(id || '').trim()).filter(Boolean))]
  const current = await readAccessPolicy()
  const next = buildAccessPolicy(current.state === 'ok' ? current.policy : null, ownerId, allowFromRaw, group)
  if (!next) return 'kept'
  const body = JSON.stringify(next)
  const storage = policyStorage()
  let wrote = false
  for (const id of ids) {
    const key = accessPolicyStorageKey(CHANNEL_ID, id)
    let same = false
    try { same = await storage.get(key) === body } catch { same = false }
    if (same) continue
    await storage.set(key, body)
    wrote = true
  }
  return wrote ? 'written' : 'unchanged'
}

export function validateProxy(proxy) {
  const p = String(proxy ?? '').trim()
  if (!p) return ''
  let u
  try { u = new URL(p) } catch { throw new Error('代理地址无效，应形如 http://127.0.0.1:7890') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('代理只支持 http:// 或 https://')
  return p
}

/** 与 dsh-telegram-temp 的 cordis.patch.yml 相同的适配器配置（其余用 0.5.1 + 补丁的默认值）。 */
const FORMAT_MODES = new Set(['auto', 'rich-markdown', 'html', 'markdown-v2', 'plain'])

const ROUTE_FIELDS = ['preset', 'provider', 'model', 'reasoningEffort']

function routeOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const route = {}
  for (const key of ROUTE_FIELDS) {
    const text = typeof value[key] === 'string' ? value[key].trim() : ''
    if (text) route[key] = text
  }
  if (value.maxTokens !== undefined && value.maxTokens !== '') route.maxTokens = value.maxTokens
  return Object.keys(route).length ? route : null
}

/**
 * 解析路由表。对象按账号 id 展开为完整路由（预设、服务商、模型、推理强度）；
 * 字符串仍是「键:预设」，逗号或换行分隔，非法行跳过。
 */
export function parseRouteMap(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      const id = String(key || '').trim()
      const route = typeof value === 'string' ? (value.trim() ? { preset: value.trim() } : null) : routeOf(value)
      if (id && route) out[id] = route
    }
    return out
  }
  const out = {}
  for (const part of String(raw ?? '').split(/[\n,]+/)) {
    const t = part.trim()
    if (!t) continue
    const m = t.match(/^([^:\s]+)\s*:\s*(\S+)$/)
    if (!m) continue
    out[m[1]] = { preset: m[2] }
  }
  return out
}

export function telegramAdapterConfig({ format = 'html', streamMode = 'auto', accountId = ACCOUNT_ID } = {}) {
  const mode = FORMAT_MODES.has(String(format || '').trim()) ? String(format).trim() : 'html'
  const sm = ['auto', 'draft', 'edit'].includes(String(streamMode || '').trim()) ? String(streamMode).trim() : 'auto'
  const account = String(accountId || ACCOUNT_ID).trim() || ACCOUNT_ID
  return TelegramConfig({
    enabled: true,
    accountId: account,
    baseUrl: 'https://api.telegram.org',
    tokenRef: 'TELEGRAM_BOT_TOKEN',
    timeoutMs: 30000,
    longPollTimeoutMs: 25000,
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30000, maxRetries: 10 },
    dedup: { enabled: true, windowMs: 5000 },
    streaming: { enabled: true, placeholder: '…', mode: sm },
    typing: { enabled: true, refreshMs: 4000 },
    formatting: { mode, fallback: 'plain' },
    maxDownloadBytes: 20 * 1024 * 1024,
  })
}

export function harnessConfig({
  inboundPreempt = true,
  preset = '',
  includeMetadataPrefix = true,
  routingMode = 'conversation',
  channelRoutes = '',
  accountRoutes = '',
  defaultRoute = null,
  sendReasoning = false,
  showToolCalls = true,
  reasoningMaxChars = 1500,
} = {}) {
  const p = String(preset ?? '').trim()
  const fallback = routeOf(defaultRoute) || (p ? { preset: p } : null)
  const mode = ['global', 'channel', 'account', 'conversation'].includes(String(routingMode || '').trim())
    ? String(routingMode).trim()
    : 'conversation'
  const channel = parseRouteMap(channelRoutes)
  // 会话级覆盖按 Telegram 用户压过每个机器人自己的预设，这里固定不用。
  const conversation = {}
  const account = parseRouteMap(accountRoutes)
  const maxChars = Math.max(200, Number(reasoningMaxChars) || 1500)
  return harness.Config({
    inboundPreempt: inboundPreempt !== false,
    includeMetadataPrefix: includeMetadataPrefix !== false,
    ...(fallback ? { agent: { default: fallback } } : {}),
    routing: {
      mode,
      overrides: {
        ...(Object.keys(channel).length ? { channel } : {}),
        ...(Object.keys(account).length ? { account } : {}),
        ...(Object.keys(conversation).length ? { conversation } : {}),
      },
    },
    reply: {
      updateIntervalMs: 200,
      sendReasoning: sendReasoning === true,
      showToolCalls: showToolCalls !== false,
      reasoningMaxChars: maxChars,
    },
  })
}

function botsToStart(options) {
  if (Array.isArray(options.accounts) && options.accounts.length) {
    return options.accounts.filter((a) => a?.token).map((a) => ({
      id: String(a.id || MAIN_ACCOUNT).trim() || MAIN_ACCOUNT,
      name: String(a.name || a.id || MAIN_ACCOUNT),
      token: a.token,
      preset: String(a.preset || ''),
      groupPreset: String(a.groupPreset || ''),
      provider: String(a.provider || ''),
      model: String(a.model || ''),
      reasoningEffort: String(a.reasoningEffort || ''),
    }))
  }
  if (options.token) {
    return [{ id: MAIN_ACCOUNT, name: '主机器人', token: options.token, preset: String(options.preset || ''), groupPreset: String(options.groupPreset || ''), provider: '', model: '', reasoningEffort: '' }]
  }
  return []
}

/**
 * 启动 Telegram 通道。每个机器人的 token 由调用方经 ctx.credentials 解析后传入（不落盘、不记日志）。
 * 多个机器人共用一个通道桥，按账号把消息送进各自的 DSH 会话。
 * @returns {{ dispose: () => Promise<void>, snapshot: () => Promise<object> }}
 */
export function startTelegram(ctx, options) {
  const {
    proxy, inboundPreempt, onConflict,
    includeMetadataPrefix, routingMode, channelRoutes, format,
    streamMode, sendReasoning, showToolCalls, reasoningMaxChars,
    authorizedIds = [], debugTrace = false, skipped = [],
    excludedGroupChats = [],
    channelGroupIds = '',
    chatroomEnabled = false,
    dmAllow = null,
  } = options
  const bots = botsToStart(options)
  if (!bots.length) throw new Error('没有可启动的机器人')
  const botNames = new Map(bots.map((b) => [b.id, b.name]))
  const lead = accountRouteOf(bots[0])
  // 入站排查日志（~/.dsh/dsh-channels/telegram-inbound.log）只在卡片「排查日志」打开时写。
  if (debugTrace === true) process.env.DSH_TELEGRAM_TRACE = '1'
  else delete process.env.DSH_TELEGRAM_TRACE
  setGroupPresets(groupPresetMap(bots))
  setExcludedGroupChats(excludedGroupChats)
  const proxyUrl = validateProxy(proxy)
  const hConfig = harnessConfig({
    inboundPreempt,
    defaultRoute: lead,
    preset: lead?.preset || '',
    includeMetadataPrefix,
    routingMode,
    channelRoutes,
    conversationRoutes: '',
    accountRoutes: accountRouteMap(bots),
    sendReasoning,
    showToolCalls,
    reasoningMaxChars,
  })
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null
  const fetchImpl = dispatcher ? (url, init) => undiciFetch(url, { ...init, dispatcher }) : undefined
  const state = {
    startedAt: Date.now(),
    mounted: false,
    auth: 'unknown',
    connection: 'idle',
    lastError: null,
    lastErrorAt: 0,
    conflict: false,
    disposed: false,
  }
  let fanout = null

  const record = (accountId, level, args) => {
    const line = sanitizeLogLine(args)
    if (!line) return
    if (level === 'error' || level === 'warn') {
      state.lastError = line
      state.lastErrorAt = Date.now()
    }
    if (isPollingConflict(line) && fanout?.markConflict(accountId)) {
      state.conflict = true
      try { onConflict?.(line) } catch { /* ignore */ }
    }
  }
  const wrapLogger = (logger, accountId) => new Proxy(logger, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if ((prop === 'warn' || prop === 'error') && typeof value === 'function') {
        return (...args) => { record(accountId, prop, args); return value.apply(target, args) }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const observe = (event) => {
    if (!event || typeof event !== 'object') return
    if (event.type === 'auth.changed') state.auth = event.state
    else if (event.type === 'connection.changed') state.connection = event.state
  }
  releaseAll('channel')
  for (const bot of bots) claimPollingToken(bot.token, 'channel', bot.id)
  const entries = bots.map((bot) => {
    const tgConfig = telegramAdapterConfig({ format, streamMode, accountId: bot.id })
    return {
      id: bot.id,
      name: bot.name,
      token: bot.token,
      adapter: new TelegramAdapter(tgConfig, {
        token: bot.token,
        transport: new FetchTransport(tgConfig.baseUrl, { timeoutMs: tgConfig.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) }),
      }),
    }
  })
  fanout = createTelegramFanout(entries, {
    decorateContext(base, accountId) {
      return {
        ...base,
        logger: wrapLogger(base.logger, accountId),
        emit: (event) => { observe(event); return base.emit(event) },
      }
    },
    // 在 vendor inbound / group_not_allowed 之前截获：包 upstream.getUpdates（见 fanout.mjs）。
    async onRawUpdate(raw, { accountId, token }) {
      // 未授权私聊：记入设置页的待处理名单（宿主经 globalThis 桥接收），然后照常交给通道——
      // 访问闸门按 user_not_allowed 静默丢弃，不回复、不提示如何授权。授权只能在本机设置页完成。
      const dmSender = dmAllow ? dmSenderOf(raw) : null
      if (dmSender && isUnauthorizedDm(dmSender, dmAllow)) {
        void noteDmDiscover({ ...dmSender, accountId, botName: botNames.get(accountId) || accountId })
        return 'pass'
      }
      const chat = extractChatFromUpdate(raw)
      if (!chat) return 'pass'
      const dest = classifyDestination(chat, {
        boundIds: excludedGroupChats,
        channelGroupIds,
        chatroomEnabled: chatroomEnabled === true,
      })
      if (dest !== 'chatroom') return 'pass'
      // 发现旁路：即使 hub 尚无订阅，也写入 discovered，设置页可一键绑定（不依赖 /bind 入站）。
      let noted = false
      try {
        const msg = chat.message
        noted = !!(await noteDiscover({
          chatId: chat.chatId,
          title: chat.title || '',
          type: chat.type || 'group',
          via: msg ? 'message' : 'channel-raw',
          addedBy: msg?.from?.username || msg?.from?.first_name || '',
          addedById: msg?.from?.id != null ? String(msg.from.id) : '',
        }))
      } catch { noted = false }
      // 仅当聊天室已订阅该令牌时才吞掉；否则放行给通道（会 group_not_allowed 并写排查日志），避免启动竞态时消息进黑洞。
      let delivered = false
      try { delivered = !!(await rawHub.publish(token, raw, { accountId })) } catch { delivered = false }
      if (process.env.DSH_TELEGRAM_TRACE === '1') {
        try {
          const { appendFileSync } = await import('node:fs')
          const { join } = await import('node:path')
          const { homedir } = await import('node:os')
          appendFileSync(join(homedir(), '.dsh', 'dsh-channels', 'chatroom-dispatch.log'),
            JSON.stringify({ t: new Date().toISOString(), chatId: chat.chatId, isGroup: chat.isGroup, delivered, noted, accountId, title: chat.title || '' }) + '\n')
        } catch { /* ignore */ }
      }
      // 已发现或已投递 → 消费，避免 group_not_allowed 误伤；/bind 仍走 hub 订阅方。
      return (delivered || noted) ? 'consumed' : 'pass'
    },
  })

  const fork = ctx.plugin({
    name: 'dsh-workbench-telegram',
    apply(sub) {
      // Isolate channels so Telegram+QQ each own a ChannelService (see qq/runtime.mjs).
      const scoped = typeof sub.isolate === 'function' ? sub.isolate('channels') : sub
      // ① ChannelService（ctx.channels）：数据目录同 dsh-telegram-temp（~/.dsh/dsh-channels），会话绑定与访问策略沿用。
      scoped.plugin({ name: 'channel-core', apply: applyChannelCore })
      // ② Harness 桥：入站 → agent.followup；session/event → 回复管线（含工具结果图片转发补丁）。
      scoped.plugin({ name: 'channel-harness', inject: harness.inject, apply: (c) => harness.apply(c, hConfig) })
      // ③ Telegram 适配器：等 channels 与宿主服务都就绪后再开始长轮询，避免 harness 未就绪时吞掉消息。
      scoped.plugin({
        name: 'channel-telegram',
        // 'tools'：授权用户闸门必须先于长轮询就位；宿主没有 tools 服务时不开始接收（失败即关闭）。
        inject: ['channels', 'tools', ...HOST_SERVICES],
        apply(c) {
          const gate = createOwnerGate({
            authorized: authorizedIds,
            getAgent: (sessionId) => { try { return c.agents?.get?.(sessionId) } catch { return undefined } },
          })
          setActiveGate(gate)
          const offGuard = c.tools.guard((exec) => gate.check(exec))
          c.effect?.(() => () => { try { offGuard?.() } catch { /* ignore */ } clearActiveGate(gate) })
          // 棋类 / 牌类：按收到消息的机器人把图片发回去。
          const upstreams = new Map(entries.map((e) => [e.id, e.adapter.upstream]))
          const offBoards = mountBoardsBridge(upstreams)
          c.effect?.(() => () => { try { offBoards() } catch { /* ignore */ } })
          mountChannelAdapter(c, fanout, (signal) => c.channels.createAdapterContext({ channelId: CHANNEL_ID, signal }))
          state.mounted = true
          c.effect?.(() => () => { state.mounted = false })
        },
      })
    },
  })

  return {
    async dispose() {
      if (state.disposed) return
      releaseAll('channel')
    state.disposed = true
      try { await fork?.dispose?.() } catch { /* ignore */ }
      if (dispatcher) { try { await dispatcher.close() } catch { /* ignore */ } }
    },
    async snapshot() {
      let described = null
      if (fanout && state.mounted) {
        try { described = await fanout.describe() } catch { described = null }
      }
      const botsLive = described?.bots || []
      const names = botsLive.filter((b) => b.health?.status === 'ok' && b.username).map((b) => '@' + b.username)
      const missing = HOST_SERVICES.filter((n) => { try { return ctx.get(n) == null } catch { return true } })
      return {
        ...state,
        health: described?.health || null,
        auth: botsLive.some((b) => b.health?.authenticated) ? 'authenticated' : state.auth,
        bot: names.length ? names.join('、') : null,
        bots: botsLive,
        skipped,
        missing,
        proxy: proxyUrl ? 'custom' : 'host',
      }
    },
  }
}
