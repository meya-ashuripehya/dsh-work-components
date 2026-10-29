/**
 * 「通道」分组 › QQ（仓库自带，默认关闭；v1 = 官方 QQ 机器人 OpenAPI + @wsz987/channel-qq）。
 *
 * 宿主半边：设置键、AppSecret 经 ctx.credentials 保存、冲突检测、按开关启停、状态汇总。
 * 真正的通道逻辑在 lib/channel-qq.mjs（源码 ./runtime.mjs），只有打开「启用」才会 import。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SECRET_REF, secretRefOf } from './accounts.mjs'
import {
  effectiveDmAllow,
  effectiveGroupDiscover,
  setPendingDiscoverHandler,
} from '../../qq/pending-discover.mjs'
import { createQQPending, createQQPendingApi } from './pending.mjs'

export const QQ_ID = 'qq'
export const QQ_LABEL = 'QQ'
export const QQ_SECRET_KEY = 'qqAppSecret'
export const QQ_APP_SECRET_REF_DEFAULT = DEFAULT_SECRET_REF

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const AGGREGATE = '@wsz987/dsh-channels'

/** 变更后需要重启通道的设置键（AppSecret 另由 secretRev 触发）。 */
export const QQ_KEYS = [
  'qqEnabled', 'qqAppId', 'qqAppSecretRef', 'qqOwnerOpenId', 'qqAllowFrom',
  'qqGroupPolicy', 'qqGroupIds', 'qqGroupRequireMention',
  'qqAuthorizedIds', 'qqPreset', 'qqChannelRoutes', 'qqRoutingMode',
  'qqIncludeMetadataPrefix', 'qqMarkdownSupport', 'qqStreamEnabled', 'qqDebugTrace',
]

export const QQ_LEGACY_KEYS = []

/** SettingsSchema 片段。qqAppSecret 只是表单占位：值写进宿主凭据，设置里恒为空。 */
export function qqSchemaShape(z) {
  return {
    qqEnabled: z.boolean().default(false).description('启用 QQ 通道（默认关闭）。'),
    qqAppId: z.string().default('').description('QQ 开放平台机器人 AppId（非机密）。'),
    qqAppSecret: z.string().role('secret').default('').description('QQ 机器人 AppSecret；保存时写入宿主凭据引用，不写入本插件设置。'),
    qqAppSecretRef: z.string().default(DEFAULT_SECRET_REF).description('保存 AppSecret 的凭据引用名，默认 QQBOT_APP_SECRET。'),
    qqOwnerOpenId: z.string().default('').description('所有者的 QQ OpenID。填写后启动时按卡片写入私聊与群聊策略；留空时不改已保存的策略。'),
    qqAllowFrom: z.string().default('').description('另外允许私聊的 QQ OpenID，以逗号或空格分隔。'),
    qqGroupPolicy: z.union(['disabled', 'allowlist', 'open']).default('disabled').description('群聊：关闭、只接收指定群，或接收机器人所在的所有群。默认关闭。'),
    qqGroupIds: z.string().default('').description('指定群的 group_openid（官方 API，不是传统 QQ 群号），逗号、空格或换行分隔。仅「指定群」时使用。'),
    qqGroupRequireMention: z.boolean().default(true).description('群内需要 @ 唤醒。官方网关默认推送 AT 事件；默认开启。'),
    qqAuthorizedIds: z.string().default('').description('授权用户 OpenID：只有这些用户触发的回合可以使用会更改电脑的工具。留空时使用所有者 OpenID；两者都空时任何人都不能使用。'),
    qqPreset: z.string().default('').description('账号 main 的私聊预设 ID。留空沿用全局默认。'),
    qqChannelRoutes: z.string().default('').description('通道级预设覆盖，形如 qq:预设名（routing.overrides.channel）。留空不覆盖。'),
    qqRoutingMode: z.union(['global', 'channel', 'account', 'conversation']).default('conversation').description('路由模式：按全局 / 通道 / 账号 / 会话选择智能体预设。'),
    qqIncludeMetadataPrefix: z.boolean().default(true).description('入站消息前附加通道元数据前缀（includeMetadataPrefix）。'),
    qqMarkdownSupport: z.boolean().default(false).description('是否启用适配器 markdownSupport。'),
    qqStreamEnabled: z.boolean().default(true).description('私聊 C2C 原生流式（群聊仍缓冲一次发送）。'),
    qqDebugTrace: z.boolean().default(false).description('排查日志：写到 ~/.dsh/dsh-channels/qq-inbound.log。默认关闭。'),
  }
}

function readProfileManifest(ctx) {
  let dir
  try { dir = ctx.get?.('profileContext')?.dir } catch { dir = undefined }
  if (!dir) return null
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 返回冲突说明；无冲突返回 null。ownServices：本通道自己 fork 提供的服务不算冲突。 */
export function detectConflict(ctx, { ownServices = false } = {}) {
  const manifest = readProfileManifest(ctx)
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = { ...(manifest?.dependencies || {}) }
  if (bundles.includes(AGGREGATE) || Object.prototype.hasOwnProperty.call(deps, AGGREGATE)) {
    return `已由 ${AGGREGATE} 接管 QQ，请先移除该插件`
  }
  if (!ownServices) {
    const has = (n) => { try { return ctx.get?.(n) != null } catch { return false } }
    // Telegram 与 QQ 各自 fork.isolate('channels') 后可并存：根 ctx 上 has('channels') 可能为真，
    // 但不能当作冲突（否则后启的一侧永远起不来）。只拦根上的 channelControl（聚合控制面）。
    if (has('channelControl')) return '宿主已加载通道控制面（channelControl），为避免通道被重复接管，未启动'
  }
  return null
}

const IDLE_INSTALL = { state: 'idle', step: '', log: [], live: '', error: null, startedAt: null, finishedAt: null, dependsOn: null, cancelling: false, percent: null }

/**
 * @param ctx 本插件的 Cordis ctx
 * @param getConfig 返回当前设置
 * @param options.loadRuntime 可选：覆盖运行时加载（冒烟用）
 */
export function createQQChannel(ctx, getConfig, options = {}) {
  const log = ctx.logger ?? console
  const s = { key: null, gen: 0, status: 'off', detail: '未启用', handle: null, startedAt: 0, error: null, secretRev: 0, conflictLine: null, policy: null }
  let disposed = false
  let runtimeModule = null

  // 未授权私聊 / 群聊：通道运行时经 globalThis 桥记入待处理名单（见 ./pending.mjs）。
  const pendingStore = options.pendingFile ? createQQPending(options.pendingFile) : null
  const offPendingDiscover = pendingStore
    ? setPendingDiscoverHandler(async (info) => {
      const cfg = getConfig() || {}
      if (info?.kind === 'group') {
        const g = effectiveGroupDiscover(cfg)
        if (g.policy === 'open') return
        if (g.policy === 'allowlist' && g.ids.includes(String(info?.groupId ?? ''))) return
        await pendingStore.record(info)
        return
      }
      // 刚在设置页授权、通道尚未按新名单重启时到达的消息不再记录。
      const allow = effectiveDmAllow(cfg, null)
      if (allow && allow.includes(String(info?.userId ?? ''))) return
      await pendingStore.record(info)
    })
    : () => {}
  async function replayAuthorizedPending(info) {
    // saveAllow* 已 await sync()；通道可能仍在挂载，等 emitInbound 就绪再回放触发消息。
    const deadline = Date.now() + 15000
    while (!disposed && Date.now() < deadline) {
      const h = s.handle
      if (h && typeof h.replayPending === 'function') {
        try {
          return await h.replayPending(info)
        } catch (error) {
          log.warn?.('dsh-workbench: qq pending replay failed', error)
          return { ok: false, error: String(error?.message || error) }
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    log.warn?.('dsh-workbench: qq pending replay skipped (channel not ready)')
    return { ok: false, reason: 'channel-not-ready' }
  }

  const pendingApi = pendingStore
    ? createQQPendingApi({
      store: pendingStore,
      getConfig,
      saveAllowFrom: typeof options.saveAllowFrom === 'function'
        ? async (raw) => { await options.saveAllowFrom(raw); await sync() }
        : null,
      saveGroupAllow: typeof options.saveGroupAllow === 'function'
        ? async (patch) => { await options.saveGroupAllow(patch); await sync() }
        : null,
      replayAuthorized: replayAuthorizedPending,
    })
    : null

  async function loadRuntime() {
    if (runtimeModule) return runtimeModule
    if (options.loadRuntime) runtimeModule = await options.loadRuntime()
    else runtimeModule = await import(new URL('./channel-qq.mjs', import.meta.url).href)
    return runtimeModule
  }

  function credentials() {
    try { return ctx.get?.('credentials') ?? null } catch { return null }
  }

  async function secretPresent(cfg = getConfig()) {
    const cred = credentials()
    if (!cred) return false
    try {
      const got = await cred.resolve(secretRefOf(cfg))
      return !!(got && typeof got.value === 'string' && got.value)
    } catch {
      return false
    }
  }

  async function resolveSecret(cfg) {
    const cred = credentials()
    if (!cred) return ''
    try {
      const value = (await cred.resolve(secretRefOf(cfg)))?.value
      return typeof value === 'string' ? value : ''
    } catch { return '' }
  }

  async function stopHandle() {
    const h = s.handle
    s.handle = null
    if (h) { try { await h.dispose() } catch (error) { log.warn?.('dsh-workbench: qq stop failed', error) } }
  }

  async function start(cfg, gen) {
    const conflict = detectConflict(ctx)
    if (conflict) { s.status = 'disconnected'; s.detail = conflict; return }
    if (typeof ctx.plugin !== 'function') { s.status = 'error'; s.detail = '宿主不支持挂载子插件（ctx.plugin），无法启动通道'; return }
    const cred = credentials()
    if (!cred) { s.status = 'disconnected'; s.detail = '宿主未提供凭据服务（credentials），无法读取 AppSecret'; return }
    const appId = String(cfg.qqAppId || '').trim()
    if (!appId) { s.status = 'disconnected'; s.detail = '请填写 AppID（QQ 开放平台机器人 AppId）'; return }
    const appSecret = await resolveSecret(cfg)
    if (gen !== s.gen) return
    if (!appSecret) {
      s.status = 'disconnected'
      s.detail = `未保存 AppSecret：请在卡片填写 AppSecret（写入凭据 ${secretRefOf(cfg)}）`
      return
    }
    let rt
    try { rt = await loadRuntime() } catch (error) {
      s.status = 'error'; s.detail = '通道组件加载失败：' + String(error?.message ?? error); log.warn?.('dsh-workbench: qq runtime load failed', error); return
    }
    if (gen !== s.gen) return
    try {
      s.policy = await rt.applyAccessPolicy(cfg.qqOwnerOpenId, cfg.qqAllowFrom, {
        policy: cfg.qqGroupPolicy || 'disabled',
        chatIds: cfg.qqGroupIds || '',
        requireMention: cfg.qqGroupRequireMention !== false,
      }, ['main'])
    } catch (error) {
      s.status = 'error'; s.detail = String(error?.message ?? error); return
    }
    if (gen !== s.gen) return
    try {
      s.status = 'connecting'
      s.detail = '正在连接 QQ 开放平台网关'
      s.startedAt = Date.now()
      s.conflictLine = null
      // 私聊白名单 + 群发现策略（与刚写入的访问策略一致）；不按白名单时 dmAllow 为 null。
      let dmAllow = null
      let groupDiscover = effectiveGroupDiscover(cfg)
      try {
        dmAllow = effectiveDmAllow(cfg, String(cfg.qqOwnerOpenId ?? '').trim() ? null : await rt.readAccessPolicy())
      } catch { dmAllow = null }
      if (gen !== s.gen) return
      s.handle = rt.startQQ(ctx, {
        appId,
        appSecret,
        appSecretRef: secretRefOf(cfg),
        preset: cfg.qqPreset,
        inboundPreempt: true,
        authorizedIds: rt.resolveAuthorizedIds(cfg.qqAuthorizedIds, cfg.qqOwnerOpenId),
        debugTrace: cfg.qqDebugTrace === true,
        includeMetadataPrefix: cfg.qqIncludeMetadataPrefix !== false,
        routingMode: cfg.qqRoutingMode || 'conversation',
        channelRoutes: cfg.qqChannelRoutes,
        markdownSupport: cfg.qqMarkdownSupport === true,
        streamEnabled: cfg.qqStreamEnabled !== false,
        dmAllow,
        groupDiscover,
      })
    } catch (error) {
      s.status = 'error'
      s.detail = String(error?.message ?? error)
      log.warn?.('dsh-workbench: qq start failed', error)
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig()
    const key = JSON.stringify([s.secretRev, ...QQ_KEYS.map((k) => cfg[k])])
    if (key === s.key) return
    s.key = key
    const gen = ++s.gen
    await stopHandle()
    if (gen !== s.gen) return
    if (cfg.qqEnabled !== true) {
      s.status = 'off'
      s.detail = detectConflict(ctx) || '未启用'
      return
    }
    await start(cfg, gen)
  }

  async function liveState() {
    if (!s.handle) return { status: s.status, detail: s.detail, connection: null }
    let snap = null
    try { snap = await s.handle.snapshot() } catch { snap = null }
    if (!snap) return { status: s.status, detail: s.detail, connection: null }
    const since = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
    const errLine = snap.lastError ? `最近错误（${since(snap.lastErrorAt)}）：${snap.lastError}` : ''
    if (!snap.mounted) {
      const waiting = snap.missing?.length ? `正在等待宿主服务：${snap.missing.join('、')}` : '正在挂载通道服务'
      return { status: 'connecting', detail: waiting, connection: { state: 'connecting', detail: errLine || waiting, checkedAt: Date.now() } }
    }
    if (snap.health?.status === 'ok') {
      const detail = '已连接 QQ 开放平台网关' + (snap.bot ? `（${snap.bot}）` : '')
      return { status: 'connected', detail, connection: { state: 'connected', detail: errLine || detail, checkedAt: Date.now() } }
    }
    if (snap.auth === 'failed') {
      return { status: 'disconnected', detail: 'AppId / AppSecret 校验失败，正在重试', connection: { state: 'disconnected', detail: errLine || '凭据校验失败', checkedAt: Date.now() } }
    }
    if (snap.connection === 'disconnected' || snap.connection === 'closed') {
      return { status: 'disconnected', detail: '连接中断，正在重连', connection: { state: 'disconnected', detail: errLine || '连接中断', checkedAt: Date.now() } }
    }
    return { status: 'connecting', detail: '正在连接 QQ 开放平台网关', connection: { state: 'connecting', detail: errLine || '正在连接', checkedAt: Date.now() } }
  }

  const api = {
    sync,
    resync() { if (s.handle) return Promise.resolve(); s.key = null; return sync() },
    detectConflict: () => detectConflict(ctx),

    async item() {
      const cfg = getConfig()
      const live = await liveState()
      const policy = s.policy === 'written' ? '已按卡片写入访问策略' : null
      return {
        id: QQ_ID,
        label: QQ_LABEL,
        url: 'https://q.qq.com/qqbot/openclaw/',
        kind: 'component',
        group: '通道',
        summary: '经 QQ 开放平台官方机器人 OpenAPI，把 C2C 私聊和已允许的群聊接到 DSH 会话。',
        serverName: null,
        moduleSource: 'bundled',
        moduleDir: null,
        enabled: cfg.qqEnabled === true,
        installed: true,
        builtin: true,
        needsInstall: false,
        launchBlocked: null,
        status: live.status,
        source: null,
        detail: live.detail,
        command: null,
        connection: live.connection,
        version: '0.5.1',
        note: policy,
        install: { ...IDLE_INSTALL },
      }
    },

    async decorateSettings(value, mask) {
      const out = { ...(value || {}) }
      out[QQ_SECRET_KEY] = (await secretPresent(out)) ? mask : ''
      return out
    },

    async absorbSecretPatch(patch, mask) {
      const out = { ...(patch || {}) }
      if (!Object.prototype.hasOwnProperty.call(out, QQ_SECRET_KEY)) return out
      const raw = out[QQ_SECRET_KEY]
      delete out[QQ_SECRET_KEY]
      if (typeof raw !== 'string' || raw === '' || raw === mask) return out
      const value = raw.trim()
      if (value.length < 8) throw Object.assign(new Error('AppSecret 过短，请粘贴 QQ 开放平台签发的完整 AppSecret'), { status: 400 })
      const cred = credentials()
      if (!cred || typeof cred.set !== 'function') throw Object.assign(new Error('宿主未提供凭据服务（credentials），无法保存 AppSecret'), { status: 409 })
      const ref = secretRefOf({ ...getConfig(), ...out })
      await cred.set(ref, value)
      s.secretRev++
      return out
    },

    /** GET /qq/pending，POST /qq/pending/dm|group/:id/authorize|ignore|remove（仅本机设置页）。 */
    async handlePendingApi(req, res, sub, helpers) {
      if (!pendingApi) return false
      return pendingApi.handle(req, res, sub, helpers)
    },

    async dispose() {
      disposed = true
      s.gen++
      offPendingDiscover()
      await stopHandle()
    },
  }
  return api
}
