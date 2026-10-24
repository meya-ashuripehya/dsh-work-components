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
import { createBotClient } from '../../chatroom/telegram-bots.mjs'
import {
  TELEGRAM_BOTS_KEY, channelTokenRefs, ingestSeat, normalizeBots, prepareStartedAccounts, resolveChannelAccounts,
} from './accounts.mjs'
import { excludeBoundChatIds } from './group-route.mjs'
import { releaseAll } from '../../telegram/polling-owners.mjs'
import { effectiveDmAllow, setDmDiscoverHandler } from '../../telegram/dm-discover.mjs'
import { createDmPending, createDmPendingApi } from './dm-pending.mjs'

export { TELEGRAM_BOTS_KEY, channelTokenRefs }

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
  'telegramGroupPolicy', 'telegramGroupIds', 'telegramGroupRequireMention', 'telegramGroupSenderPolicy',
  'telegramPreset', 'telegramGroupPreset', 'telegramAuthorizedIds', 'telegramDebugTrace', 'telegramChannelRoutes', 'telegramConversationRoutes', 'telegramRoutingMode',
  'telegramIncludeMetadataPrefix', 'telegramFormat', 'telegramInboundPreempt',
  'telegramSendReasoning', 'telegramShowToolCalls', 'telegramReasoningMaxChars', 'telegramStreamMode',
]
export const TELEGRAM_SECRET_KEY = 'telegramToken'

/**
 * 已停用的旧键：Schema 里保留以兼容老配置，但不再有独立的表单字段。
 * - telegramPreset / telegramGroupPreset：已并入「每个机器人」账号卡（preset / groupPreset），
 *   读取时由 accounts.mjs 的 ALIAS_KEYS 兼容旧值。
 * - telegramConversationRoutes：Schema 中标注「已停用」，会话级路由改由账号卡配置。
 * - telegramToken：令牌改在账号卡里填写，保存为凭据引用 telegramTokenRef。
 * check.mjs 跳过这些键，不要求 lib/client.js 有对应的 INPUT_FIELDS 条目。
 */
export const TELEGRAM_LEGACY_KEYS = [
  'telegramPreset',
  'telegramGroupPreset',
  'telegramConversationRoutes',
  'telegramToken',
]

/** SettingsSchema 片段。telegramToken 只是表单占位：值写进宿主凭据（credentials 引用），设置里恒为空。 */
export function telegramSchemaShape(z) {
  return {
    telegramEnabled: z.boolean().default(false).description('启用 Telegram 通道（默认关闭）。'),
    telegramToken: z.string().role('secret').default('').description('BotFather 签发的机器人令牌；保存时写入宿主凭据引用，不写入本插件设置。'),
    telegramTokenRef: z.string().default(DEFAULT_TOKEN_REF).description('保存机器人令牌的凭据引用名，默认 TELEGRAM_BOT_TOKEN（与 dsh-telegram-temp 相同）。'),
    telegramProxy: z.string().default('').description('访问 Telegram Bot API 的 HTTP 代理，例如 http://127.0.0.1:7890；留空时沿用宿主 / 环境变量的代理设置。'),
    telegramOwnerId: z.string().default('').description('所有者的 Telegram 数字用户 ID。填写后启动时按卡片写入私聊与群聊策略；留空时不改已保存的策略。'),
    telegramAllowFrom: z.string().default('').description('另外允许私聊的 Telegram 数字用户 ID，以逗号或空格分隔。群内发言人设为白名单时，同一份名单也用于群。'),
    telegramGroupPolicy: z.union(['disabled', 'allowlist', 'open']).default('disabled').description('群聊：关闭、只接收指定群，或接收机器人所在的所有群。默认关闭。'),
    telegramGroupIds: z.string().default('').description('指定群的数字聊天 ID（负数，超级群以 -100 开头），逗号、空格或换行分隔。仅「指定群」时使用。'),
    telegramGroupRequireMention: z.boolean().default(false).description('可选。关闭时，允许的群里每条普通消息都会唤醒会话。开启时，只有 @ 机器人、回复它，或 /命令@机器人 才会唤醒。默认关闭。'),
    telegramGroupSenderPolicy: z.union(['open', 'allowlist']).default('open').description('允许的群里谁可以触发：所有成员，或仅所有者与私聊白名单。'),
    telegramPreset: z.string().default('').description('兼容别名：账号 main 的私聊预设。请在机器人列表里修改；保存机器人时会写回这里。'),
    telegramGroupPreset: z.string().default('').description('兼容别名：账号 main 的群聊预设。请在机器人列表里修改；保存机器人时会写回这里。'),
    telegramBots: z.array(z.any()).default([]).description('全部 Telegram 机器人（含 id 为 main 的一行）：{ id, name, tokenRef, preset, groupPreset, enabled, provider, model, reasoningEffort }。令牌在宿主凭据里，每个机器人有自己的 DSH 会话。'),
    telegramAuthorizedIds: z.string().default('').description('授权用户 ID：只有这些 Telegram 用户触发的回合可以使用会更改电脑的工具。留空时使用所有者用户 ID；两者都空时任何人都不能使用。'),
    telegramDebugTrace: z.boolean().default(false).description('排查日志：把入站更新与准入 / 建会话阶段写到 ~/.dsh/dsh-channels/telegram-inbound.log。默认关闭。'),
    telegramChannelRoutes: z.string().default('').description('通道级预设覆盖，形如 telegram:预设名（routing.overrides.channel）。留空不覆盖。'),
    telegramConversationRoutes: z.string().default('').description('已停用。会话级覆盖会压过每个机器人自己的预设，启动时忽略，保存机器人时清空。'),
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

  // 未授权私聊：通道运行时经 globalThis 桥把发送者交给这里记入待处理名单（见 ./dm-pending.mjs）。
  const dmStore = options.dmPendingFile ? createDmPending(options.dmPendingFile) : null
  const offDmDiscover = dmStore
    ? setDmDiscoverHandler(async (info) => {
      // 刚在设置页授权、通道尚未按新名单重启时到达的消息不再记录。
      const allow = effectiveDmAllow(getConfig() || {}, null)
      if (allow && allow.includes(String(info?.userId ?? ''))) return
      await dmStore.record(info)
    })
    : () => {}
  const dmApi = dmStore
    ? createDmPendingApi({
      store: dmStore,
      getConfig,
      saveAllowFrom: typeof options.saveAllowFrom === 'function'
        ? async (raw) => { await options.saveAllowFrom(raw); await sync() }
        : null,
      botLabels: async () => {
        const out = {}
        for (const b of await listBotsSafe()) out[b.id] = (b.name || b.id) + (b.username ? `（@${b.username}）` : '')
        return out
      },
    })
    : null
  async function listBotsSafe() {
    try { return await api.listBots() } catch { return [] }
  }

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
    releaseAll('channel')
    const h = s.handle
    s.handle = null
    if (h) { try { await h.dispose() } catch (error) { log.warn?.('dsh-workbench: telegram stop failed', error) } }
  }

  async function tokensByRef(cfg) {
    const cred = credentials()
    const out = {}
    if (!cred) return out
    for (const ref of [...new Set(resolveChannelAccounts(cfg).map((a) => a.tokenRef))]) {
      try {
        const value = (await cred.resolve(ref))?.value
        out[ref] = typeof value === 'string' ? value : ''
      } catch { out[ref] = '' }
    }
    return out
  }

  async function reservedIngestTokens(cfg) {
    const seat = ingestSeat(cfg)
    const ref = seat?.telegram?.tokenRef
    if (!ref) return []
    const cred = credentials()
    if (!cred) return []
    try {
      const value = (await cred.resolve(ref))?.value
      return typeof value === 'string' && value ? [value] : []
    } catch { return [] }
  }

  async function start(cfg, gen, boundChats = []) {
    const conflict = detectConflict(ctx)
    if (conflict) { s.status = 'disconnected'; s.detail = conflict; return }
    if (typeof ctx.plugin !== 'function') { s.status = 'error'; s.detail = '宿主不支持挂载子插件（ctx.plugin），无法启动通道'; return }
    const cred = credentials()
    if (!cred) { s.status = 'disconnected'; s.detail = '宿主未提供凭据服务（credentials），无法读取机器人令牌'; return }
    const prepared = prepareStartedAccounts(resolveChannelAccounts(cfg), await tokensByRef(cfg), [])
    if (gen !== s.gen) return
    if (!prepared.started.length) {
      s.status = 'disconnected'
      s.detail = '没有可连接的机器人：' + (prepared.skipped.length
        ? prepared.skipped.map((item) => `${item.name}（${item.reason}）`).join('、')
        : '请在下方表格中选择机器人并保存令牌')
      return
    }
    let rt
    try { rt = await loadRuntime() } catch (error) {
      s.status = 'error'; s.detail = '通道组件加载失败：' + String(error?.message ?? error); log.warn?.('dsh-workbench: telegram runtime load failed', error); return
    }
    if (gen !== s.gen) return
    try {
      s.policy = await rt.applyAccessPolicy(cfg.telegramOwnerId, cfg.telegramAllowFrom, {
        policy: cfg.telegramGroupPolicy || 'disabled',
        chatIds: excludeBoundChatIds(cfg.telegramGroupIds || '', boundChats),
        requireMention: cfg.telegramGroupRequireMention === true,
        senderPolicy: cfg.telegramGroupSenderPolicy || 'open',
      }, prepared.started.map((a) => a.id))
    } catch (error) {
      s.status = 'error'; s.detail = String(error?.message ?? error); return
    }
    if (gen !== s.gen) return
    // 私聊白名单（与刚写入的访问策略一致）；不按白名单时为 null，不做未授权私聊发现。
    let dmAllow = null
    try {
      dmAllow = effectiveDmAllow(cfg, String(cfg.telegramOwnerId ?? '').trim() ? null : await rt.readAccessPolicy())
    } catch { dmAllow = null }
    if (gen !== s.gen) return
    try {
      s.status = 'connecting'
      s.detail = prepared.started.length > 1 ? `正在连接 ${prepared.started.length} 个机器人` : '正在连接 Telegram Bot API'
      s.startedAt = Date.now()
      s.conflictLine = null
      s.handle = rt.startTelegram(ctx, {
        accounts: prepared.started,
        skipped: prepared.skipped,
        preset: cfg.telegramPreset,
        proxy: cfg.telegramProxy,
        inboundPreempt: cfg.telegramInboundPreempt !== false,
        authorizedIds: rt.resolveAuthorizedIds(cfg.telegramAuthorizedIds, cfg.telegramOwnerId),
        debugTrace: cfg.telegramDebugTrace === true,
        includeMetadataPrefix: cfg.telegramIncludeMetadataPrefix !== false,
        routingMode: cfg.telegramRoutingMode || 'conversation',
        channelRoutes: cfg.telegramChannelRoutes,
        excludedGroupChats: boundChats,
        channelGroupIds: cfg.telegramGroupIds || '',
        dmAllow,
        chatroomEnabled: cfg.chatroomEnabled === true,
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
            s.detail = '机器人正被其他程序轮询（Telegram 409 冲突），已停止轮询；请确认没有外部程序占用该令牌后，关闭再打开「启用」'
          })
        },
      })
      try { options.onPollingReady?.() } catch { /* 聊天室重订阅 */ }
    } catch (error) {
      s.status = 'error'
      s.detail = String(error?.message ?? error)
      log.warn?.('dsh-workbench: telegram start failed', error)
    }
  }

  async function boundChats() {
    try { return (await options.boundChatIds?.()) || [] } catch { return [] }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig()
    const bound = await boundChats()
    const key = JSON.stringify([s.tokenRev, ...TELEGRAM_KEYS.map((k) => cfg[k]), cfg[TELEGRAM_BOTS_KEY], bound])
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
    await start(cfg, gen, bound)
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
    const skippedLine = snap.skipped?.length ? `未启动：${snap.skipped.map((item) => `${item.name}（${item.reason}）`).join('、')}` : ''
    const conflicted = (snap.bots || []).filter((b) => b.conflict).map((b) => (b.username ? '@' + b.username : b.name))
    const conflictLine = conflicted.length ? `${conflicted.join('、')} 与其他程序抢轮询，已停止该机器人` : ''
    const aside = [conflictLine, skippedLine].filter(Boolean).join('；')
    if (snap.health?.status === 'ok') {
      const who = snap.bot ? `${snap.bot} · ` : ''
      const detail = `${who}长轮询中（${via}）` + (aside ? `。${aside}` : '')
      return { status: 'connected', detail, connection: { state: 'connected', detail: errLine || detail, checkedAt: Date.now() } }
    }
    if (snap.auth === 'failed') {
      return { status: 'disconnected', detail: '机器人令牌校验失败，正在重试', connection: { state: 'disconnected', detail: errLine || '机器人令牌校验失败', checkedAt: Date.now() } }
    }
    if (snap.connection === 'disconnected' || snap.connection === 'closed') {
      return { status: 'disconnected', detail: `连接中断，正在重连（${via}）`, connection: { state: 'disconnected', detail: errLine || '连接中断', checkedAt: Date.now() } }
    }
    return { status: 'connecting', detail: `正在连接 Telegram Bot API（${via}）`, connection: { state: 'connecting', detail: errLine || '正在连接', checkedAt: Date.now() } }
  }

  const api = {
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
        summary: '经 Telegram Bot API 长轮询，把机器人私聊和已允许的群聊接到 DSH 会话（文字、图片、工具结果图片）。',
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

    async listBots() {
      const cfg = getConfig()
      const tokens = await tokensByRef(cfg)
      let snap = null
      try { snap = await s.handle?.snapshot?.() } catch { snap = null }
      const live = new Map((snap?.bots || []).map((b) => [b.id, b]))
      return resolveChannelAccounts(cfg).map((a) => ({
        id: a.id,
        name: a.name,
        preset: a.preset,
        groupPreset: a.groupPreset,
        provider: a.provider || '',
        model: a.model || '',
        reasoningEffort: a.reasoningEffort || '',
        enabled: a.enabled !== false,
        tokenRef: a.tokenRef,
        builtin: !!a.builtin,
        hasToken: !!tokens[a.tokenRef],
        username: live.get(a.id)?.username || '',
        conflict: !!live.get(a.id)?.conflict,
      }))
    },

    /**
     * GET/PUT /telegram/bots，PUT/POST /telegram/bots/:id/token|check。
     * 额外机器人不走通用设置表单，避免整份设置回传时用旧列表覆盖。
     */
    async handleApi(req, res, sub, { sendJson, readBody }) {
      if (sub !== '/telegram/bots' && !sub.startsWith('/telegram/bots/')) return false
      const fail = (status, error) => { sendJson(res, status, { ok: false, error }); return true }
      try {
        if (req.method !== 'GET' && req.headers?.['sec-fetch-site'] === 'cross-site') return fail(403, 'cross-site request refused')
        const body = async () => JSON.parse(await readBody(req) || '{}')
        if (sub === '/telegram/bots' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, bots: await this.listBots() })
          return true
        }
        if (sub === '/telegram/bots' && req.method === 'PUT') {
          if (typeof options.persistBots !== 'function') return fail(501, '当前环境无法保存设置')
          const parsed = await body()
          if (!Array.isArray(parsed.bots)) return fail(400, 'bots 必须是数组')
          await options.persistBots(normalizeBots(parsed.bots, getConfig()))
          await sync()
          sendJson(res, 200, { ok: true, bots: await this.listBots() })
          return true
        }
        const match = /^\/telegram\/bots\/([a-z0-9-]+)\/(token|check)$/.exec(sub)
        if (!match) return fail(404, 'not found')
        const id = match[1]
        const account = resolveChannelAccounts(getConfig()).find((a) => a.id === id)
        if (!account) return fail(404, '机器人不存在')
        if (match[2] === 'token' && req.method === 'PUT') {
          const cred = credentials()
          if (!cred || typeof cred.set !== 'function') return fail(409, '宿主未提供凭据服务（credentials），无法保存机器人令牌')
          const token = String((await body()).token || '').trim()
          if (token && token !== '-' && !TOKEN_PATTERN.test(token)) return fail(400, '机器人令牌格式不正确，应形如 123456789:AA…（从 BotFather 获取）')
          if (token && token !== '-') {
            const cfg = getConfig()
            const others = await tokensByRef(cfg)
            for (const [ref, value] of Object.entries(others)) {
              if (ref !== account.tokenRef && value && value === token) return fail(400, '这个令牌已经用于另一个机器人。同一个令牌不能两处轮询。')
            }
            await cred.set(account.tokenRef, token)
          } else if (typeof cred.delete === 'function') await cred.delete(account.tokenRef)
          else await cred.set(account.tokenRef, '')
          s.tokenRev++
          await sync()
          sendJson(res, 200, { ok: true, hasToken: !!(token && token !== '-') })
          return true
        }
        if (match[2] === 'check' && req.method === 'POST') {
          const token = (await tokensByRef(getConfig()))[account.tokenRef]
          if (!token) return fail(400, '未保存令牌')
          try {
            const me = await createBotClient(token, { proxy: String(getConfig()?.telegramProxy || '').trim() }).getMe()
            sendJson(res, 200, { ok: true, username: me?.username || '', id: me?.id })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String(error?.message || error) })
          }
          return true
        }
        return fail(405, 'method not allowed')
      } catch (error) {
        return fail(error?.status || 400, String(error?.message || error))
      }
    },

    /** GET /telegram/dm-pending，POST /telegram/dm-pending/:userId/authorize|ignore|remove（仅本机设置页）。 */
    async handleDmApi(req, res, sub, helpers) {
      if (!dmApi) return false
      return dmApi.handle(req, res, sub, helpers)
    },

    async dispose() {
      disposed = true
      s.gen++
      offDmDiscover()
      await stopHandle()
    },
  }
  return api
}
