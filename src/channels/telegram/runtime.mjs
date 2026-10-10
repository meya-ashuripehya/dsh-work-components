/**
 * Telegram 通道运行时（单独打包为 lib/channel-telegram.mjs，只在「通道 › Telegram」启用时才被动态 import）。
 *
 * 复用 @wsz987/channel-core / channel-harness / channel-telegram 0.5.1（vendor/wsz987/ 下的打补丁副本，
 * 补丁见 vendor/wsz987/patches/）：
 *   - channel-telegram：getMe / deleteWebhook / 接收循环失败可无限退避重试、接收看门狗、单条更新处理预算；
 *   - channel-harness：流式工具循环正文去重、inboundPreempt 入站插队、工具结果图片（mm_send_image 等）转发为 Telegram 图片。
 *     地图标点（kind place）不转发预览图，改由本模块调用 sendVenue（坐标须已是 WGS-84）。
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

installMapPlaceDelivery(harness.ReplyRouter)

/** channel-harness 需要的宿主服务（与它自己的 inject 相同，去掉本 fork 提供的 channels）。 */
export const HOST_SERVICES = harness.inject.filter((n) => n !== 'channels')
export const CHANNEL_ID = 'telegram'
export const ACCOUNT_ID = 'main'

/** 打补丁标记（冒烟 / 检查用）：产物里必须同时含有这三类补丁。 */
export const PATCH_MARKERS = {
  telegramStall: typeof TelegramAdapter.prototype.runSupervisor === 'function' && typeof TelegramAdapter.prototype.startWatchdog === 'function',
  harnessImages: typeof harness.ReplyRouter?.prototype?.deliverTurnImages === 'function',
  mapPlace: harness.ReplyRouter?.prototype?.__dshMapPlace === true,
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

/**
 * 由卡片里的「所有者 / 允许的用户」生成访问策略（仅私聊；群组规则沿用已存策略）。
 * ownerId 为空时返回 null：不改动已存策略。
 */
export function buildAccessPolicy(existing, ownerId, allowFromRaw) {
  const owner = String(ownerId ?? '').trim()
  if (!owner) return null
  if (!/^-?\d{1,20}$/.test(owner)) throw new Error('所有者 ID 必须是 Telegram 数字用户 ID')
  const extra = parseIdList(allowFromRaw).filter((id) => id !== owner)
  for (const id of extra) if (!/^-?\d{1,20}$/.test(id)) throw new Error(`允许的用户 ID「${id}」不是 Telegram 数字用户 ID`)
  const groupPolicy = existing?.groupPolicy ?? 'disabled'
  const policy = {
    version: 1,
    preset: extra.length ? 'allowlist' : 'owner-only',
    ownerId: owner,
    dmPolicy: 'allowlist',
    allowFrom: [owner, ...extra],
    groupPolicy,
    groups: groupPolicy === 'open' ? {} : (existing?.groups ?? {}),
    ...(groupPolicy === 'open' && existing?.defaultGroupRule ? { defaultGroupRule: existing.defaultGroupRule } : {}),
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

/** 写访问策略（与已存相同时不写）。返回 'unchanged' | 'written' | 'kept'。 */
export async function applyAccessPolicy(ownerId, allowFromRaw) {
  const current = await readAccessPolicy()
  const next = buildAccessPolicy(current.state === 'ok' ? current.policy : null, ownerId, allowFromRaw)
  if (!next) return 'kept'
  if (current.state === 'ok' && JSON.stringify(current.policy) === JSON.stringify(next)) return 'unchanged'
  await policyStorage().set(accessPolicyStorageKey(CHANNEL_ID, ACCOUNT_ID), JSON.stringify(next))
  return 'written'
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

/** 解析「键:预设」列表（逗号或换行分隔）。非法行跳过。 */
export function parseRouteMap(raw) {
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

export function telegramAdapterConfig({ format = 'html', streamMode = 'auto' } = {}) {
  const mode = FORMAT_MODES.has(String(format || '').trim()) ? String(format).trim() : 'html'
  const sm = ['auto', 'draft', 'edit'].includes(String(streamMode || '').trim()) ? String(streamMode).trim() : 'auto'
  return TelegramConfig({
    enabled: true,
    accountId: ACCOUNT_ID,
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
  conversationRoutes = '',
  sendReasoning = false,
  showToolCalls = true,
  reasoningMaxChars = 1500,
} = {}) {
  const p = String(preset ?? '').trim()
  const mode = ['global', 'channel', 'account', 'conversation'].includes(String(routingMode || '').trim())
    ? String(routingMode).trim()
    : 'conversation'
  const channel = parseRouteMap(channelRoutes)
  const conversation = parseRouteMap(conversationRoutes)
  const maxChars = Math.max(200, Number(reasoningMaxChars) || 1500)
  return harness.Config({
    inboundPreempt: inboundPreempt !== false,
    includeMetadataPrefix: includeMetadataPrefix !== false,
    ...(p ? { agent: { default: { preset: p } } } : {}),
    routing: {
      mode,
      overrides: {
        ...(Object.keys(channel).length ? { channel } : {}),
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

/**
 * 启动 Telegram 通道。token 由调用方经 ctx.credentials 解析后传入（不落盘、不记日志）。
 * @returns {{ dispose: () => Promise<void>, snapshot: () => Promise<object> }}
 */
export function startTelegram(ctx, options) {
  const {
    token, proxy, inboundPreempt, preset, onConflict,
    includeMetadataPrefix, routingMode, channelRoutes, conversationRoutes, format,
    streamMode, sendReasoning, showToolCalls, reasoningMaxChars,
  } = options
  const proxyUrl = validateProxy(proxy)
  const tgConfig = telegramAdapterConfig({ format, streamMode })
  const hConfig = harnessConfig({
    inboundPreempt, preset, includeMetadataPrefix, routingMode, channelRoutes, conversationRoutes,
    sendReasoning, showToolCalls, reasoningMaxChars,
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
  let adapter = null

  const record = (level, args) => {
    const line = sanitizeLogLine(args)
    if (!line) return
    if (level === 'error' || level === 'warn') {
      state.lastError = line
      state.lastErrorAt = Date.now()
    }
    if (!state.conflict && isPollingConflict(line)) {
      state.conflict = true
      try { onConflict?.(line) } catch { /* ignore */ }
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
  }

  const fork = ctx.plugin({
    name: 'dsh-workbench-telegram',
    apply(sub) {
      // ① ChannelService（ctx.channels）：数据目录同 dsh-telegram-temp（~/.dsh/dsh-channels），会话绑定与访问策略沿用。
      sub.plugin({ name: 'channel-core', apply: applyChannelCore })
      // ② Harness 桥：入站 → agent.followup；session/event → 回复管线（含工具结果图片转发补丁）。
      sub.plugin({ name: 'channel-harness', inject: harness.inject, apply: (c) => harness.apply(c, hConfig) })
      // ③ Telegram 适配器：等 channels 与宿主服务都就绪后再开始长轮询，避免 harness 未就绪时吞掉消息。
      sub.plugin({
        name: 'channel-telegram',
        inject: ['channels', ...HOST_SERVICES],
        apply(c) {
          adapter = new TelegramAdapter(tgConfig, {
            token,
            transport: new FetchTransport(tgConfig.baseUrl, { timeoutMs: tgConfig.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) }),
          })
          mountChannelAdapter(c, adapter, (signal) => {
            const base = c.channels.createAdapterContext({ channelId: CHANNEL_ID, signal })
            return {
              ...base,
              logger: wrapLogger(base.logger),
              emit: (event) => { observe(event); return base.emit(event) },
            }
          })
          state.mounted = true
          c.effect?.(() => () => { state.mounted = false })
        },
      })
    },
  })

  return {
    async dispose() {
      if (state.disposed) return
      state.disposed = true
      try { await fork?.dispose?.() } catch { /* ignore */ }
      if (dispatcher) { try { await dispatcher.close() } catch { /* ignore */ } }
    },
    async snapshot() {
      let health = null
      if (adapter && state.mounted) {
        try { health = await adapter.getHealth() } catch { health = null }
      }
      const missing = HOST_SERVICES.filter((n) => { try { return ctx.get(n) == null } catch { return true } })
      return {
        ...state,
        health,
        bot: adapter?.botIdentity?.username ? '@' + adapter.botIdentity.username : null,
        missing,
        proxy: proxyUrl ? 'custom' : 'host',
      }
    },
  }
}
