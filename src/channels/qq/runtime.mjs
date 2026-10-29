/**
 * QQ 通道运行时（单独打包为 lib/channel-qq.mjs，只在「通道 › QQ」启用时才被动态 import）。
 *
 * 复用 @wsz987/channel-core / channel-harness / channel-qq 0.5.1：
 *   - channel-core → 数据目录 resolveChannelDataDirectory()（~/.dsh/dsh-channels），
 *     与旧 dsh-channels / Telegram 共用 bindings.json 与 access policy，保证 qq:main:<openid>
 *     绑定可重挂旧会话（如 ch-0d68ce84-…）。
 *   - channel-harness → 入站路由 / 回复管线。
 *   - channel-qq → 官方腾讯 SDK 网关（C2C 流式 + 群缓冲）。
 *
 * 挂载在本插件 ctx.plugin() 的 fork 下；关闭「启用」或卸载时整棵 dispose。
 * v1 不做聊天室互斥、棋牌出站（见 docs/qq-channel-component.md）。未授权私聊/群聊发现：pending-discover（本文件 observe → notePendingDiscover）。
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
import { Config as QQConfig, QQAdapter } from '@wsz987/channel-qq'
import { join } from 'node:path'
import { DENY_MESSAGE, createOwnerGate, installOwnerGate, setActiveGate, clearActiveGate, resolveAuthorizedIds } from './owner-gate.mjs'
import { installPersonMemoryInject } from '../person-memory-inject.mjs'
import { MAIN_ACCOUNT, accountRouteOf } from './accounts.mjs'
import { buildReplayEvent, notePendingDiscover, pendingInfoOfEvent } from '../../qq/pending-discover.mjs'
import { installQqLingChatOutbound } from './lingchat-segments.mjs'

installOwnerGate(harness.ReplyContextStore)
installPersonMemoryInject(harness.ChannelHarnessBridge)

export { DENY_MESSAGE, createOwnerGate, resolveAuthorizedIds }

/** channel-harness 需要的宿主服务（与它自己的 inject 相同，去掉本 fork 提供的 channels）。 */
export const HOST_SERVICES = harness.inject.filter((n) => n !== 'channels')
/** 必须为 'qq'：与 ~/.dsh/dsh-channels/bindings.json 里既有 qq:main:* 键一致。 */
export const CHANNEL_ID = 'qq'
/** 必须为 'main'：与既有 binding accountId / owner-openid/main / access/policy/v1/qq/main 一致。 */
export const ACCOUNT_ID = 'main'

/** 冒烟 / 检查用：产物里至少要带上这些标记。 */
export const PATCH_MARKERS = {
  ownerGate: harness.ReplyContextStore?.prototype?.__dshOwnerGate === true,
  harnessPreempt: Object.prototype.hasOwnProperty.call(harness.Config({}), 'inboundPreempt'),
  harnessSegments: typeof harness.ReplyRouter?.prototype?.flushProcess === 'function',
  channelIdQQ: CHANNEL_ID === 'qq',
  accountIdMain: ACCOUNT_ID === 'main',
}

const SECRET_LIKE = /\b[A-Za-z0-9]{16,}\b/g

/** 日志行脱敏：压成一行并截断。只取消息文字。 */
export function sanitizeLogLine(parts) {
  const list = Array.isArray(parts) ? parts : [parts]
  const text = list
    .map((p) => (p instanceof Error ? p.message : p && typeof p === 'object' && p.error instanceof Error ? p.error.message : p))
    .filter((p) => typeof p === 'string')
    .join(' ')
    .replace(/AppSecret[=:]\s*\S+/gi, 'AppSecret=<redacted>')
    .replace(SECRET_LIKE, (m) => (m.length >= 24 ? '<secret>' : m))
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 200 ? text.slice(0, 197) + '…' : text
}

export function parseIdList(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))]
}

/** QQ OpenID / group_openid：官方 API 给出的不透明字符串（常见为 32 位十六进制）。 */
export function isOpenId(id) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(String(id || ''))
}

function groupRule(requireMention) {
  return {
    enabled: true,
    senderPolicy: 'open',
    allowFrom: [],
    requireMention: requireMention !== false,
  }
}

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
  if (policy === 'open') return { groupPolicy: 'open', groups: {}, defaultGroupRule: groupRule(group.requireMention) }
  const ids = parseIdList(group.chatIds)
  for (const id of ids) {
    if (!isOpenId(id)) throw new Error(`群 OpenID「${id}」无效（应为官方 group_openid，不是传统 QQ 群号）`)
  }
  const groups = {}
  for (const id of ids) groups[id] = groupRule(group.requireMention)
  return { groupPolicy: 'allowlist', groups }
}

/**
 * 由卡片里的所有者、私聊白名单和群聊设置生成访问策略。
 * ownerId 为空时返回 null：不改动已存策略（保留 ~/.dsh/dsh-channels 里旧 QQ 会话绑定所用的策略）。
 */
export function buildAccessPolicy(existing, ownerId, allowFromRaw, group) {
  const owner = String(ownerId ?? '').trim()
  if (!owner) return null
  if (!isOpenId(owner)) throw new Error('所有者 OpenID 无效（应为 QQ 开放平台 OpenID）')
  const extra = parseIdList(allowFromRaw).filter((id) => id !== owner)
  for (const id of extra) if (!isOpenId(id)) throw new Error(`允许的用户 OpenID「${id}」无效`)
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
  // 与 Telegram / 旧 dsh-channels 共用 ~/.dsh/dsh-channels/storage
  return new FileStorage({ directory: join(resolveChannelDataDirectory(), 'storage') })
}

/** 读已存访问策略（只返回摘要）。 */
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

/** 写访问策略。owner 空 → 'kept'（不碰既有 qq/main 策略与绑定）。 */
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

export function qqAdapterConfig({
  appId,
  appSecretRef = 'QQBOT_APP_SECRET',
  accountId = ACCOUNT_ID,
  markdownSupport = false,
  streamEnabled = true,
} = {}) {
  const account = String(accountId || ACCOUNT_ID).trim() || ACCOUNT_ID
  return QQConfig({
    enabled: true,
    accountId: account,
    appId: String(appId || '').trim(),
    appSecretRef: String(appSecretRef || 'QQBOT_APP_SECRET').trim() || 'QQBOT_APP_SECRET',
    markdownSupport: markdownSupport === true,
    streaming: { enabled: streamEnabled !== false, throttleMs: 500 },
    dedup: { enabled: true, windowMs: 5000 },
    startupTimeoutMs: 15000,
  })
}

export function harnessConfig({
  inboundPreempt = true,
  preset = '',
  includeMetadataPrefix = true,
  routingMode = 'conversation',
  channelRoutes = '',
  defaultRoute = null,
} = {}) {
  const p = String(preset ?? '').trim()
  const fallback = routeOf(defaultRoute) || (p ? { preset: p } : null)
  const mode = ['global', 'channel', 'account', 'conversation'].includes(String(routingMode || '').trim())
    ? String(routingMode).trim()
    : 'conversation'
  const channel = parseRouteMap(channelRoutes)
  return harness.Config({
    inboundPreempt: inboundPreempt !== false,
    includeMetadataPrefix: includeMetadataPrefix !== false,
    ...(fallback ? { agent: { default: fallback } } : {}),
    routing: {
      mode,
      overrides: {
        ...(Object.keys(channel).length ? { channel } : {}),
      },
    },
    reply: {
      updateIntervalMs: 200,
      sendReasoning: false,
      showToolCalls: true,
      reasoningMaxChars: 1500,
    },
  })
}

/**
 * 启动 QQ 通道。appSecret 由调用方经 ctx.credentials 解析后传入（不落盘、不记日志）。
 * channelId/accountId 固定 qq/main，以便重挂 ~/.dsh/dsh-channels 既有绑定。
 * @returns {{ dispose: () => Promise<void>, snapshot: () => Promise<object> }}
 */
export function startQQ(ctx, options) {
  const {
    appId,
    appSecret,
    appSecretRef = 'QQBOT_APP_SECRET',
    preset = '',
    inboundPreempt = true,
    authorizedIds = [],
    debugTrace = false,
    includeMetadataPrefix = true,
    routingMode = 'conversation',
    channelRoutes = '',
    markdownSupport = false,
    streamEnabled = true,
    dmAllow = null,
    groupDiscover = null,
  } = options
  if (!String(appId || '').trim()) throw new Error('缺少 AppId')
  if (!appSecret) throw new Error('缺少 AppSecret')
  if (debugTrace === true) process.env.DSH_QQ_TRACE = '1'
  else delete process.env.DSH_QQ_TRACE

  const lead = accountRouteOf({ qqPreset: preset })
  const hConfig = harnessConfig({
    inboundPreempt,
    defaultRoute: lead,
    preset: lead?.preset || String(preset || ''),
    includeMetadataPrefix,
    routingMode,
    channelRoutes,
  })
  const qqConfig = qqAdapterConfig({
    appId,
    appSecretRef,
    accountId: ACCOUNT_ID,
    markdownSupport,
    streamEnabled,
  })
  const adapter = installQqLingChatOutbound(new QQAdapter(qqConfig, { appSecret }), { gapMs: 350, enabled: true })

  const state = {
    startedAt: Date.now(),
    mounted: false,
    auth: 'unknown',
    connection: 'idle',
    lastError: null,
    lastErrorAt: 0,
    disposed: false,
  }

  let emitInboundLive = null

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function waitMounted(ms = 12000) {
    const t0 = Date.now()
    while (!state.disposed && Date.now() - t0 < ms) {
      if (state.mounted && typeof emitInboundLive === 'function') return true
      await sleep(40)
    }
    return !!(state.mounted && typeof emitInboundLive === 'function')
  }

  async function emitInbound(event) {
    if (!event || typeof event !== 'object') return null
    if (!(await waitMounted())) throw new Error('QQ channel not mounted for inbound replay')
    return emitInboundLive(event)
  }

  async function replayPending(info) {
    const event = buildReplayEvent(info, { channel: CHANNEL_ID })
    if (!event) return { ok: false, reason: 'no-replayable-payload' }
    await emitInbound(event)
    return { ok: true, messageId: event.message?.id, conversationId: event.conversation?.id }
  }

  const record = (level, args) => {
    const line = sanitizeLogLine(args)
    if (!line) return
    if (level === 'error' || level === 'warn') {
      state.lastError = line
      state.lastErrorAt = Date.now()
    }
  }
  const wrapLogger = (logger) => new Proxy(logger, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if ((prop === 'warn' || prop === 'error') && typeof value === 'function') {
        return (...args) => { record(prop, args); return value.apply(target, args) }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const observe = (event) => {
    if (!event || typeof event !== 'object') return
    if (event.type === 'auth.changed') state.auth = event.state
    else if (event.type === 'connection.changed') state.connection = event.state
    // 未授权私聊/群聊：在 harness 丢弃前经 emit 包一层记下（denied 也看得见）。
    try {
      const info = pendingInfoOfEvent(event, { dmAllow, groupDiscover })
      if (info) void notePendingDiscover(info)
    } catch { /* never break inbound */ }
  }

  const fork = ctx.plugin({
    name: 'dsh-workbench-qq',
    apply(sub) {
      // Isolate channels so Telegram+QQ can each provide ChannelService without sharing
      // one bus (shared bus ⇒ dual harness listeners ⇒ /stop already registered notice).
      // Bindings/storage still share ~/.dsh/dsh-channels via resolveChannelDataDirectory().
      const scoped = typeof sub.isolate === 'function' ? sub.isolate('channels') : sub
      // ① ChannelService：数据目录同 Telegram / 旧 QQ（~/.dsh/dsh-channels），会话绑定与访问策略沿用。
      scoped.plugin({ name: 'channel-core', apply: applyChannelCore })
      // ② Harness 桥
      scoped.plugin({ name: 'channel-harness', inject: harness.inject, apply: (c) => harness.apply(c, hConfig) })
      // ③ QQ 适配器
      scoped.plugin({
        name: 'channel-qq',
        inject: ['channels', 'tools', ...HOST_SERVICES],
        apply(c) {
          const gate = createOwnerGate({
            authorized: authorizedIds,
            getAgent: (sessionId) => { try { return c.agents?.get?.(sessionId) } catch { return undefined } },
          })
          setActiveGate(gate)
          const offGuard = c.tools.guard((exec) => gate.check(exec))
          c.effect?.(() => () => { try { offGuard?.() } catch { /* ignore */ } clearActiveGate(gate) })

          const baseCreate = (signal) => c.channels.createAdapterContext({ channelId: CHANNEL_ID, signal })
          mountChannelAdapter(c, adapter, (signal) => {
            const base = baseCreate(signal)
            const emit = (event) => { observe(event); return base.emit(event) }
            emitInboundLive = emit
            return {
              ...base,
              logger: wrapLogger(base.logger),
              emit,
            }
          })
          state.mounted = true
          c.effect?.(() => () => {
            state.mounted = false
            emitInboundLive = null
          })
        },
      })
    },
  })

  return {
    async dispose() {
      if (state.disposed) return
      state.disposed = true
      emitInboundLive = null
      try { await fork?.dispose?.() } catch { /* ignore */ }
    },
    emitInbound,
    replayPending,
    async snapshot() {
      let health = null
      let bot = null
      if (adapter && state.mounted) {
        try {
          health = await adapter.getHealth?.()
          const desc = typeof adapter.describe === 'function' ? await adapter.describe() : null
          bot = desc?.username || desc?.bot || desc?.appId || qqConfig.appId || null
        } catch { /* ignore */ }
      }
      const missing = HOST_SERVICES.filter((n) => { try { return ctx.get(n) == null } catch { return true } })
      const ok = health?.status === 'ok' || state.connection === 'connected' || state.auth === 'authenticated'
      return {
        ...state,
        health: health || (ok ? { status: 'ok' } : { status: state.mounted ? 'connecting' : 'idle' }),
        auth: state.auth === 'authenticated' || health?.authenticated ? 'authenticated' : state.auth,
        bot: bot ? String(bot) : null,
        missing,
      }
    },
  }
}
