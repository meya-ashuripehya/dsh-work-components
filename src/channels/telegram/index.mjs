/**
 * 「通道」分组 › Telegram（仓库自带、已验证，默认关闭）。
 *
 * 宿主半边只做：设置键、令牌经 ctx.credentials 保存、冲突检测、按开关启停、状态汇总。
 * 真正的通道逻辑在单独打包的 lib/channel-telegram.mjs（源码 ./runtime.mjs），只有打开「启用」才会 import，
 * 关闭时不加载任何通道代码。挂载在本插件 ctx 下的一个 fork 里，关闭开关 / 插件卸载时随 fork 一起清理。
 *
 * 冲突保护（避免同一 Bot 被两处 getUpdates → 409）：
 *   - profile 的 bundles 里有 dsh-telegram-temp 或 @wsz987/dsh-channels → 不启动，状态给出处理办法；
 *   - 宿主里已有别人提供的 channels / channelControl 服务 → 不启动；
 *   - 运行中日志出现 409 / Conflict → 立即停止轮询，等用户处理后关闭再打开「启用」。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TELEGRAM_ID = 'telegram'
export const TELEGRAM_LABEL = 'Telegram'
const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/
const TEMP_PLUGIN = 'dsh-telegram-temp'
const AGGREGATE = '@wsz987/dsh-channels'

/** 变更后需要重启通道的设置键（令牌另由 tokenRev 触发）。 */
export const TELEGRAM_KEYS = [
  'telegramEnabled', 'telegramTokenRef', 'telegramProxy', 'telegramOwnerId', 'telegramAllowFrom',
  'telegramPreset', 'telegramChannelRoutes', 'telegramConversationRoutes', 'telegramRoutingMode',
  'telegramIncludeMetadataPrefix', 'telegramFormat', 'telegramInboundPreempt',
  'telegramSendReasoning', 'telegramShowToolCalls', 'telegramReasoningMaxChars', 'telegramStreamMode',
]
export const TELEGRAM_SECRET_KEY = 'telegramToken'

/** SettingsSchema 片段。telegramToken 只是表单占位：值写进宿主凭据（credentials 引用），设置里恒为空。 */
export function telegramSchemaShape(z) {
  return {
    telegramEnabled: z.boolean().default(false).description('启用 Telegram 通道（默认关闭）。'),
    telegramToken: z.string().role('secret').default('').description('BotFather 签发的机器人令牌；保存时写入宿主凭据引用，不写入本插件设置。'),
    telegramTokenRef: z.string().default(DEFAULT_TOKEN_REF).description('保存机器人令牌的凭据引用名，默认 TELEGRAM_BOT_TOKEN（与 dsh-telegram-temp 相同）。'),
    telegramProxy: z.string().default('').description('访问 Telegram Bot API 的 HTTP 代理，例如 http://127.0.0.1:7890；留空时沿用宿主 / 环境变量的代理设置。'),
    telegramOwnerId: z.string().default('').description('所有者的 Telegram 数字用户 ID；留空时沿用已保存的访问策略。'),
    telegramAllowFrom: z.string().default('').description('另外允许私聊的 Telegram 数字用户 ID，以逗号或空格分隔。'),
    telegramPreset: z.string().default('lingsnow').description('默认智能体预设（agent.default.preset）。留空时使用宿主默认；已绑定的会话不受影响。'),
    telegramChannelRoutes: z.string().default('telegram:guest, qq:guest, weixin:guest').description('通道级预设覆盖，形如 telegram:guest, qq:guest（routing.overrides.channel）。'),
    telegramConversationRoutes: z.string().default('').description('会话级预设覆盖，每行或逗号分隔：会话ID:预设（routing.overrides.conversation）。'),
    telegramRoutingMode: z.union(['global', 'channel', 'account', 'conversation']).default('conversation').description('路由模式：按全局 / 通道 / 账号 / 会话选择智能体预设。'),
    telegramIncludeMetadataPrefix: z.boolean().default(true).description('入站消息前附加通道元数据前缀（includeMetadataPrefix）。'),
    telegramFormat: z.union(['auto', 'html', 'rich-markdown', 'markdown-v2', 'plain']).default('html').description('出站正文格式：auto / html / rich-markdown / markdown-v2 / plain。'),
    telegramInboundPreempt: z.boolean().default(true).description('新消息到达时中止正在进行的回合并优先处理。'),
    telegramSendReasoning: z.boolean().default(false).description('是否把模型思考过程发到 Telegram（折叠引用块）；默认关闭。'),
    telegramShowToolCalls: z.boolean().default(true).description('是否在折叠块中显示工具调用摘要（名称与状态）；默认开启。'),
    telegramReasoningMaxChars: z.natural().default(1500).description('思考过程保留的最大字符数（超出时保留末尾）。'),
    telegramStreamMode: z.union(['auto', 'draft', 'edit']).default('auto').description('流式方式：自动（编辑同一条消息）、强制草稿（私聊 ephemeral 预览，结束时再发正式消息）、强制编辑。'),
  }
}

function tokenRefOf(cfg) {
  const ref = String(cfg?.telegramTokenRef || DEFAULT_TOKEN_REF).trim()
  return REF_PATTERN.test(ref) ? ref : DEFAULT_TOKEN_REF
}

function readProfileManifest(ctx) {
  let dir
  try { dir = ctx.get?.('profileContext')?.dir } catch { dir = undefined }
  if (!dir) return null
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 返回冲突说明（正式书面语），无冲突返回 null。ownServices：本通道自己 fork 提供的服务在运行时不算冲突。 */
export function detectConflict(ctx, { ownServices = false } = {}) {
  const manifest = readProfileManifest(ctx)
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = { ...(manifest?.dependencies || {}) }
  if (bundles.includes(TEMP_PLUGIN)) return `已由独立插件 ${TEMP_PLUGIN} 接管，请先移除该插件`
  if (bundles.includes(AGGREGATE) || Object.prototype.hasOwnProperty.call(deps, AGGREGATE)) return `已由 ${AGGREGATE} 接管 Telegram，请先移除该插件`
  if (!ownServices) {
    const has = (n) => { try { return ctx.get?.(n) != null } catch { return false } }
    if (has('channelControl')) return '宿主已加载通道控制面（channelControl），为避免同一机器人被重复轮询，未启动'
    if (has('channels')) return '其他插件已提供通道服务（channels），为避免同一机器人被重复轮询，未启动'
  }
  return null
}

const IDLE_INSTALL = { state: 'idle', step: '', log: [], live: '', error: null, startedAt: null, finishedAt: null, dependsOn: null, cancelling: false, percent: null }

/**
 * @param ctx 本插件的 Cordis ctx（需要 ctx.plugin；credentials / profileContext 按需 ctx.get）
 * @param getConfig 返回当前设置
 * @param options.loadRuntime 可选：覆盖运行时加载（冒烟用）；默认 import lib/channel-telegram.mjs
 */
export function createTelegramChannel(ctx, getConfig, options = {}) {
  const log = ctx.logger ?? console
  const s = { key: null, gen: 0, status: 'off', detail: '未启用', handle: null, startedAt: 0, error: null, tokenRev: 0, conflictLine: null, policy: null }
  let disposed = false
  let runtimeModule = null

  async function loadRuntime() {
    if (runtimeModule) return runtimeModule
    if (options.loadRuntime) runtimeModule = await options.loadRuntime()
    else runtimeModule = await import(new URL('./channel-telegram.mjs', import.meta.url).href)
    return runtimeModule
  }

  function credentials() {
    try { return ctx.get?.('credentials') ?? null } catch { return null }
  }

  async function tokenPresent(cfg = getConfig()) {
    const cred = credentials()
    if (!cred) return false
    try {
      const got = await cred.resolve(tokenRefOf(cfg))
      return !!(got && typeof got.value === 'string' && got.value)
    } catch {
      return false
    }
  }

  async function stopHandle() {
    const h = s.handle
    s.handle = null
    if (h) { try { await h.dispose() } catch (error) { log.warn?.('dsh-workbench: telegram stop failed', error) } }
  }

  async function start(cfg, gen) {
    const conflict = detectConflict(ctx)
    if (conflict) { s.status = 'disconnected'; s.detail = conflict; return }
    if (typeof ctx.plugin !== 'function') { s.status = 'error'; s.detail = '宿主不支持挂载子插件（ctx.plugin），无法启动通道'; return }
    const cred = credentials()
    if (!cred) { s.status = 'disconnected'; s.detail = '宿主未提供凭据服务（credentials），无法读取机器人令牌'; return }
    let token
    try { token = (await cred.resolve(tokenRefOf(cfg)))?.value } catch { token = undefined }
    if (gen !== s.gen) return
    if (!token) { s.status = 'disconnected'; s.detail = `未配置机器人令牌：请在下方填写并保存（凭据引用 ${tokenRefOf(cfg)}）`; return }
    let rt
    try { rt = await loadRuntime() } catch (error) {
      s.status = 'error'; s.detail = '通道组件加载失败：' + String(error?.message ?? error); log.warn?.('dsh-workbench: telegram runtime load failed', error); return
    }
    if (gen !== s.gen) return
    try {
      s.policy = await rt.applyAccessPolicy(cfg.telegramOwnerId, cfg.telegramAllowFrom)
    } catch (error) {
      s.status = 'error'; s.detail = String(error?.message ?? error); return
    }
    if (gen !== s.gen) return
    try {
      s.status = 'connecting'
      s.detail = '正在连接 Telegram Bot API'
      s.startedAt = Date.now()
      s.conflictLine = null
      s.handle = rt.startTelegram(ctx, {
        token,
        proxy: cfg.telegramProxy,
        inboundPreempt: cfg.telegramInboundPreempt !== false,
        preset: cfg.telegramPreset,
        includeMetadataPrefix: cfg.telegramIncludeMetadataPrefix !== false,
        routingMode: cfg.telegramRoutingMode || 'conversation',
        channelRoutes: cfg.telegramChannelRoutes,
        conversationRoutes: cfg.telegramConversationRoutes,
        format: cfg.telegramFormat || 'html',
        streamMode: cfg.telegramStreamMode || 'auto',
        sendReasoning: cfg.telegramSendReasoning === true,
        showToolCalls: cfg.telegramShowToolCalls !== false,
        reasoningMaxChars: cfg.telegramReasoningMaxChars ?? 1500,
        onConflict: (line) => {
          if (gen !== s.gen) return
          s.conflictLine = line
          log.warn?.('dsh-workbench: telegram polling conflict (409); polling stopped')
          void stopHandle().then(() => {
            if (gen !== s.gen) return
            s.status = 'error'
            s.detail = '同一机器人正被其他程序轮询（Telegram 409 冲突），已停止轮询；请确认只保留一处后，关闭再打开「启用」'
          })
        },
      })
    } catch (error) {
      s.status = 'error'
      s.detail = String(error?.message ?? error)
      log.warn?.('dsh-workbench: telegram start failed', error)
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig()
    const key = JSON.stringify([s.tokenRev, ...TELEGRAM_KEYS.map((k) => cfg[k])])
    if (key === s.key) return
    s.key = key
    const gen = ++s.gen
    await stopHandle()
    if (gen !== s.gen) return
    if (cfg.telegramEnabled !== true) {
      s.status = 'off'
      // 关闭时也提示接管情况，便于切换前确认。
      s.detail = detectConflict(ctx) || '未启用'
      return
    }
    await start(cfg, gen)
  }

  /** 由运行时快照得出 未连接 / 正在连接 / 已连接 + 实时行。 */
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
    const via = snap.proxy === 'custom' ? '经自定义代理' : '经宿主网络设置'
    if (snap.health?.status === 'ok') {
      const who = snap.bot ? `${snap.bot} · ` : ''
      return { status: 'connected', detail: `${who}长轮询中（${via}）`, connection: { state: 'connected', detail: errLine || `${who}长轮询正常`, checkedAt: Date.now() } }
    }
    if (snap.auth === 'failed') {
      return { status: 'disconnected', detail: '机器人令牌校验失败，正在重试', connection: { state: 'disconnected', detail: errLine || '机器人令牌校验失败', checkedAt: Date.now() } }
    }
    if (snap.connection === 'disconnected' || snap.connection === 'closed') {
      return { status: 'disconnected', detail: `连接中断，正在重连（${via}）`, connection: { state: 'disconnected', detail: errLine || '连接中断', checkedAt: Date.now() } }
    }
    return { status: 'connecting', detail: `正在连接 Telegram Bot API（${via}）`, connection: { state: 'connecting', detail: errLine || '正在连接', checkedAt: Date.now() } }
  }

  return {
    sync,
    /** 强制重新同步（如凭据服务刚就绪）。 */
    resync() { if (s.handle) return Promise.resolve(); s.key = null; return sync() },
    detectConflict: () => detectConflict(ctx),

    /** /components 列表项（与工作组件同形，builtin、无需安装）。 */
    async item() {
      const cfg = getConfig()
      const live = await liveState()
      const policy = s.policy === 'written' ? '已按卡片写入访问策略' : null
      return {
        id: TELEGRAM_ID,
        label: TELEGRAM_LABEL,
        url: 'https://core.telegram.org/bots/api',
        kind: 'component',
        group: '通道',
        summary: '经 Telegram Bot API 长轮询，把机器人私聊接到 DSH 会话（文字、图片、工具结果图片）。',
        serverName: null,
        moduleSource: 'bundled',
        moduleDir: null,
        enabled: cfg.telegramEnabled === true,
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

    /** GET /settings：令牌只回传占位值（已保存）或空串。 */
    async decorateSettings(value, mask) {
      const out = { ...(value || {}) }
      out[TELEGRAM_SECRET_KEY] = (await tokenPresent(out)) ? mask : ''
      return out
    },

    /**
     * POST /settings：把令牌从补丁里取出写进宿主凭据（不落进插件设置）。
     * 占位值 / 空串 = 不改动已保存的令牌。返回新的补丁；令牌格式不对时抛带 status 的错误。
     */
    async absorbSecretPatch(patch, mask) {
      const out = { ...(patch || {}) }
      if (!Object.prototype.hasOwnProperty.call(out, TELEGRAM_SECRET_KEY)) return out
      const raw = out[TELEGRAM_SECRET_KEY]
      delete out[TELEGRAM_SECRET_KEY]
      if (typeof raw !== 'string' || raw === '' || raw === mask) return out
      const value = raw.trim()
      if (!TOKEN_PATTERN.test(value)) throw Object.assign(new Error('机器人令牌格式不正确，应形如 123456789:AA…（从 BotFather 获取）'), { status: 400 })
      const cred = credentials()
      if (!cred || typeof cred.set !== 'function') throw Object.assign(new Error('宿主未提供凭据服务（credentials），无法保存机器人令牌'), { status: 409 })
      const ref = tokenRefOf({ ...getConfig(), ...out })
      await cred.set(ref, value)
      s.tokenRev++
      return out
    },

    async dispose() {
      disposed = true
      s.gen++
      await stopHandle()
    },
  }
}
