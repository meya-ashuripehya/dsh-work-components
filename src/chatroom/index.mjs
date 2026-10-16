/**
 * 聊天室（默认关闭）：同源接口 + 事件流，房间核心在 store / moderator / providers / transcript。
 * 席位的服务商 / 模型 / 预设全部来自 DSH（../dsh-catalog.mjs），调用经 ctx.llm.stream；本插件不保存密钥。
 *   GET  /chatroom                         席位概况（含是否可用与原因）+ 房间列表
 *   GET  /chatroom/catalog                 DSH 服务商（含模型）、未启用的可配置服务商、智能体预设
 *   PUT  /chatroom/seats {seats}           保存席位列表（增删、排序、启用）
 *   POST /chatroom/rooms {title}           新建房间；PUT /chatroom/rooms/:id {title} 改名
 *   GET  /chatroom/rooms/:id               房间元数据 + 全部消息 + 是否在发言
 *   POST /chatroom/rooms/:id/messages {text, run?, rounds?}   用户发言（默认随后开始一段发言）
 *   POST /chatroom/rooms/:id/run {rounds?, seatIds?}          继续 / 指定席位发言
 *   POST /chatroom/rooms/:id/stop                             停止（取消进行中的请求）
 *   GET  /chatroom/rooms/:id/events        text/event-stream：message / delta / turn / run / error
 *   GET  /chatroom/sessions                会话编号 → 房间编号（客户端据此在右侧停靠窗打开房间）
 *   POST /chatroom/rooms/:id/session       创建或恢复该房间的 DSH 会话（房间会话，见 ./room-sessions.mjs）
 * 读接口在关闭时仍可用（查看记录）；发言类接口在关闭时返回 409。
 */
import { join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { createDshCatalog } from '../dsh-catalog.mjs'
import { createStore, ChatroomError } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { callSeat } from './providers.mjs'
import { resolveSeats, normalizeSeats, CHATROOM_SEATS_KEY, DEFAULT_OWNER_TELEGRAM_ID, DEFAULT_CURSOR_AGENT } from './seats.mjs'
import { channelTokenRefs } from '../channels/telegram/accounts.mjs'
import { createTelegramBots } from './telegram-bots.mjs'
import { runCursorAgent, cursorDeeplink, resolveCursorAgent } from './cursor.mjs'
import { createDiscovered } from './discovered.mjs'
import { createRoomSessions } from './room-sessions.mjs'

export { CHATROOM_PANEL_KEYS, botTokenRef } from './seats.mjs'
export { chatroomSchemaShape, CHATROOM_KEYS, CHATROOM_SEATS_KEY, LEGACY_CHATROOM_KEYS, migrateLegacyChatroom, normalizeSeats, resolveSeats } from './seats.mjs'

export function chatroomDir() {
  return join(dataDir(), 'chatroom')
}

/**
 * @param ctx Cordis ctx（llm / agentPresets 按需 ctx.get）
 * @param getConfig 当前插件设置
 * @param {{ dir?: string, llm?: any, presets?: any, catalog?: any, saveSeats?: (seats) => Promise<void> }} [options]
 *   saveSeats 由宿主半边提供（走插件设置的持久化）；llm / presets 测试注入
 */
export function createChatroomFeature(ctx, getConfig, options = {}) {
  const store = createStore(options.dir || chatroomDir())
  const subscribers = new Map() // roomId → Set<res>
  const catalog = options.catalog || createDshCatalog(ctx, { llm: options.llm, presets: options.presets })

  function roomConfig() {
    const cfg = getConfig() || {}
    return {
      seats: resolveSeats(cfg),
      userName: String(cfg.chatroomUserName || '').trim() || '用户',
      rules: cfg.chatroomRules || '',
      maxHistory: Number(cfg.chatroomMaxHistory) || 0,
      maxTokens: Number(cfg.chatroomMaxOutputTokens) || 1024,
      autoRounds: Number(cfg.chatroomAutoRounds) || 1,
      defaultMain: String(cfg.chatroomDefaultMain || 'deepseek'),
      budget: Number(cfg.chatroomTurnBudget) || 10,
      ownerId: String(cfg.chatroomOwnerTelegramId || DEFAULT_OWNER_TELEGRAM_ID).trim(),
      cursorRepo: String(cfg.chatroomCursorRepo || '').trim(),
      cursorAgent: String(cfg.chatroomCursorAgentPath || DEFAULT_CURSOR_AGENT).trim(),
      cursorTimeoutMs: (Number(cfg.chatroomCursorTimeoutSec) || 1800) * 1000,
    }
  }

  function credentials() {
    if (options.credentials !== undefined) return options.credentials
    try { return ctx?.get?.('credentials') ?? null } catch { return null }
  }
  async function resolveToken(ref) {
    const c = credentials()
    if (!c || typeof c.resolve !== 'function') return undefined
    try { const got = await c.resolve(ref); return typeof got === 'string' ? got : got?.value || undefined } catch { return undefined }
  }

  // 绑定群 → 房间（每个群只属于一个房间）
  let chatMap = new Map()
  async function refreshChatMap() {
    const m = new Map()
    for (const r of await store.listRooms()) for (const c of r.telegramChatIds || []) if (!m.has(c)) m.set(c, r.id)
    chatMap = m
    return m
  }
  async function chatIdsOf(roomId) {
    try { return (await store.getRoom(roomId)).telegramChatIds || [] } catch { return [] }
  }

  const discovered = createDiscovered(join(options.dir || chatroomDir(), 'discovered.json'))

  /** 群内 /bind [房间名]、/unbind：只认所有者；非所有者静默忽略。 */
  async function groupCommand({ cmd, arg, chatId, title, fromId }) {
    const cfg = roomConfig()
    if (!cfg.ownerId || fromId !== cfg.ownerId) return { ignored: true }
    const rooms = await store.listRooms()
    if (cmd === 'unbind') {
      const r = rooms.find((x) => (x.telegramChatIds || []).includes(chatId))
      if (!r) { await bots.reply(chatId, '本群尚未绑定任何聊天室房间。'); return { ok: false } }
      await store.setTelegramChats(r.id, r.telegramChatIds.filter((c) => c !== chatId))
      await syncTelegram(true)
      await bots.reply(chatId, `已解除本群与房间「${r.title}」的绑定。`)
      return { ok: true, roomId: r.id }
    }
    let room = null
    if (arg) room = rooms.find((r) => r.title === arg) || rooms.find((r) => r.title.includes(arg))
    else if (rooms.length === 1) room = rooms[0]
    if (!room) {
      await bots.reply(chatId, rooms.length ? `请指定房间：/bind 房间名。现有房间：${rooms.map((r) => r.title).join('、')}` : '尚无聊天室房间，请先在 DSH 设置页「聊天室」中新建房间。')
      return { ok: false }
    }
    try { await bindChat(chatId, room.id) } catch (e) { await bots.reply(chatId, String(e?.message || e)); return { ok: false } }
    await bots.reply(chatId, `已将本群${title ? '「' + title + '」' : ''}绑定到房间「${room.title}」。此后群内消息将进入该房间。`)
    return { ok: true, roomId: room.id }
  }

  /** 绑定一个群到房间（一个群只属于一个房间：先从其他房间移除）。 */
  async function bindChat(chatId, roomId) {
    const room = await store.getRoom(roomId)
    for (const r of await store.listRooms()) if (r.id !== roomId && (r.telegramChatIds || []).includes(chatId)) await store.setTelegramChats(r.id, r.telegramChatIds.filter((c) => c !== chatId))
    const ids = [...new Set([...(room.telegramChatIds || []), chatId])]
    const out = await store.setTelegramChats(roomId, ids)
    if (!out.telegramChatIds.includes(chatId)) throw new Error('群聊 ID 无效或已达上限（每个房间最多 8 个群）')
    await discovered.mark(chatId, { status: 'bound', roomId })
    await syncTelegram(true)
    return out
  }

  const bots = options.bots || createTelegramBots({
    resolveToken,
    getSeats: () => roomConfig().seats,
    getProxy: () => { const c = getConfig() || {}; return String(c.chatroomTelegramProxy || c.telegramProxy || '').trim() },
    conflictToken: async () => {
      const c = getConfig() || {}
      if (c.telegramEnabled !== true) return []
      const out = []
      for (const ref of channelTokenRefs(c)) {
        const value = await resolveToken(ref)
        if (value) out.push(value)
      }
      return out
    },
    fetchImpl: options.telegramFetch,
    logger: ctx?.logger,
    onDiscover: async (d) => { if (!chatMap.has(d.chatId)) await discovered.record(d) },
    onCommand: (c) => groupCommand(c),
    onInbound: async ({ chatId, fromId, fromName, isBot, text }) => {
      if (!enabled() || isBot) return
      const roomId = chatMap.get(chatId)
      if (!roomId) return
      const cfg = roomConfig()
      const owner = !!cfg.ownerId && fromId === cfg.ownerId
      await moderator.post(roomId, text, { userName: owner ? cfg.userName : fromName, owner, source: 'telegram', fromId })
    },
  })

  const tg = {
    typing: (seat, roomId) => {
      let stop = () => {}
      let dead = false
      void chatIdsOf(roomId).then((ids) => { if (!dead) stop = bots.typing(seat, ids) })
      return () => { dead = true; stop() }
    },
    relay: async (seat, roomId, text, o) => bots.relay(seat, await chatIdsOf(roomId), text, o),
  }

  function emit(roomId, event) {
    const set = subscribers.get(roomId)
    if (!set) return
    const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    for (const res of set) { try { res.write(line) } catch {} }
  }

  const moderator = createModerator({
    store,
    getRoomConfig: roomConfig,
    resolvePersona: (seat) => catalog.presetPersona(seat.preset),
    emit,
    call: options.call || ((o) => callSeat({ ...o, llm: catalog.llm() })),
    tg,
    runCursor: options.runCursor || ((handoff, o) => { const c = roomConfig(); return runCursorAgent({ agentPath: c.cursorAgent, handoff, timeoutMs: c.cursorTimeoutMs, ...o }) }),
  })

  const enabled = () => (getConfig() || {}).chatroomEnabled === true

  // 房间会话：左侧会话列表中的对应会话；在其普通输入框里写的文字以用户身份进入聊天室。
  const roomSessions = options.roomSessions || createRoomSessions({
    ctx,
    store,
    cwd: options.sessionCwd || join(options.dir || chatroomDir(), 'workspace'),
    logger: ctx?.logger,
    onUserText: async (roomId, text) => { if (enabled()) await moderator.post(roomId, text, { run: true, owner: true }) },
  })
  async function ensureRoomSession(roomId) {
    try { return { ...(await roomSessions.ensure(roomId)) } } catch (e) { return { sessionError: String(e?.message || e) } }
  }

  /** 每个席位是否可用（服务商已启用、模型在列表里、预设存在），不发起模型调用。 */
  async function overview() {
    const cfg = roomConfig()
    const [prov, pre] = await Promise.all([catalog.providers(), catalog.presets()])
    const seats = cfg.seats.map((s) => {
      const p = prov.providers.find((x) => x.id === s.provider)
      const m = p?.models.find((x) => x.id === s.model)
      const preset = s.preset ? pre.presets.find((x) => x.id === s.preset) : null
      let problem = ''
      if (!prov.available) problem = 'DSH 服务商服务不可用'
      else if (!s.provider || !s.model) problem = '未选择服务商与模型'
      else if (!p) problem = `服务商 ${s.provider} 未在 DSH 中启用`
      else if (p.models.length && !m) problem = `模型 ${s.model} 不在该服务商的模型列表中`
      if (!problem && s.preset) {
        if (!pre.available) problem = 'DSH 预设服务不可用'
        else if (!preset) problem = `预设 ${s.preset} 不存在`
        else if (preset.broken) problem = `预设 ${s.preset} 不可用`
      }
      return { ...s, providerName: p?.name || s.provider, modelName: m?.name || s.model, presetName: preset?.name || s.preset, ready: !problem, problem }
    })
    for (const s of seats) s.telegram = { ...s.telegram, hasToken: !!(await resolveToken(s.telegram.tokenRef)) }
    return { enabled: enabled(), userName: cfg.userName, defaultMain: cfg.defaultMain, budget: cfg.budget, ownerId: cfg.ownerId, rules: cfg.rules, cursorRepo: cfg.cursorRepo, cursorAgent: resolveCursorAgent(cfg.cursorAgent), seats, rooms: await store.listRooms(), telegram: bots.status() }
  }

  let ingestKey = ''
  async function syncTelegram(force = false) {
    if (!enabled()) { bots.stopIngest(); ingestKey = ''; return }
    await refreshChatMap()
    const seat = roomConfig().seats.find((s) => s.enabled !== false && s.telegram?.ingest)
    const key = seat ? `${seat.id}|${seat.telegram.tokenRef}|${(await resolveToken(seat.telegram.tokenRef)) ? 1 : 0}` : ''
    if (!force && key === ingestKey) return
    ingestKey = key
    bots.reset?.()
    await bots.startIngest(() => new Set(chatMap.keys()))
  }

  async function sync() {
    void roomSessions.start({ resume: enabled() })
    if (!enabled()) await moderator.stopAll()
    try { await syncTelegram() } catch (e) { ctx?.logger?.warn?.('dsh-workbench: chatroom telegram sync failed', String(e?.message || e)) }
  }

  async function dispose() {
    bots.stopIngest()
    await moderator.stopAll()
    try { await roomSessions.dispose() } catch {}
    for (const set of subscribers.values()) for (const res of set) { try { res.end() } catch {} }
    subscribers.clear()
  }

  function openEvents(req, res, roomId) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', ...moderator.status(roomId) })}\n\n`)
    let set = subscribers.get(roomId)
    if (!set) subscribers.set(roomId, set = new Set())
    set.add(res)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25000)
    ping.unref?.()
    const off = () => { clearInterval(ping); set.delete(res); if (!set.size) subscribers.delete(roomId) }
    req.on?.('close', off)
    res.on?.('close', off)
  }

  /** @returns {Promise<boolean>} 是否已处理 */
  async function handleApi(req, res, sub, { sendJson, readBody }) {
    if (sub !== '/chatroom' && !sub.startsWith('/chatroom/')) return false
    const body = async () => JSON.parse(await readBody(req) || '{}')
    try {
      if (req.method !== 'GET' && req.headers?.['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { ok: false, error: 'cross-site request refused' }); return true }
      if (sub === '/chatroom' && req.method === 'GET') { sendJson(res, 200, { ok: true, ...await overview() }); return true }
      if (sub === '/chatroom/catalog' && req.method === 'GET') {
        const [prov, pre] = await Promise.all([catalog.providers(), catalog.presets()])
        sendJson(res, 200, { ok: true, llm: prov, presets: pre }); return true
      }
      if (sub === '/chatroom/seats' && req.method === 'PUT') {
        if (typeof options.saveSeats !== 'function') throw new ChatroomError('当前环境无法保存设置', 501)
        const b = await body()
        if (!Array.isArray(b.seats)) throw new ChatroomError('seats 必须是数组', 400)
        await options.saveSeats(normalizeSeats(b.seats))
        await syncTelegram(true)
        sendJson(res, 200, { ok: true, ...await overview() }); return true
      }
      if (sub === '/chatroom/config' && req.method === 'PUT') {
        // 附加房间规则等长文本单独保存，不随整份设置回传（避免大请求体导致「Failed to fetch」）。
        if (typeof options.savePatch !== 'function') throw new ChatroomError('当前环境无法保存设置', 501)
        const b = await body()
        const patch = {}
        if (typeof b.rules === 'string') patch.chatroomRules = b.rules.slice(0, 20000)
        if (typeof b.defaultMain === 'string') patch.chatroomDefaultMain = b.defaultMain.trim().slice(0, 40)
        if (b.budget !== undefined) { const n = Math.round(Number(b.budget)); if (!(n >= 1 && n <= 100)) throw new ChatroomError('回合上限须为 1–100', 400); patch.chatroomTurnBudget = n }
        if (typeof b.cursorRepo === 'string') patch.chatroomCursorRepo = b.cursorRepo.trim().slice(0, 400)
        await options.savePatch(patch)
        sendJson(res, 200, { ok: true, ...await overview() }); return true
      }
      if (sub === '/chatroom/efforts' && req.method === 'GET') {
        const q = new URL(req.url || '/', 'http://x').searchParams
        const l = catalog.llm()
        let efforts = []; let defaultEffort = ''
        try {
          const info = await (l?.resolveModelInfo?.(q.get('provider') || '', q.get('model') || '') ?? l?.resolveModel?.(q.get('provider') || '', q.get('model') || ''))
          efforts = (info?.reasoning?.efforts || []).map((e) => ({ id: String(e.id), name: e.name || String(e.id), ...(e.description ? { description: e.description } : {}) }))
          defaultEffort = String(info?.reasoning?.defaultEffort || '')
        } catch {}
        sendJson(res, 200, { ok: true, efforts, defaultEffort }); return true
      }
      const sm = /^\/chatroom\/seats\/([a-z0-9-]+)\/(token|check)$/.exec(sub)
      if (sm) {
        const seat = roomConfig().seats.find((x) => x.id === sm[1])
        if (!seat) throw new ChatroomError('成员不存在', 404)
        if (sm[2] === 'token' && req.method === 'PUT') {
          const c = credentials()
          if (!c || typeof c.set !== 'function') throw new ChatroomError('宿主未提供凭据服务（credentials），无法保存机器人令牌', 409)
          const token = String((await body()).token || '').trim()
          if (token && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new ChatroomError('令牌格式不正确（应为 数字:字母数字串）', 400)
          if (token) await c.set(seat.telegram.tokenRef, token)
          else if (typeof c.delete === 'function') await c.delete(seat.telegram.tokenRef)
          else await c.set(seat.telegram.tokenRef, '')
          await syncTelegram(true)
          sendJson(res, 200, { ok: true, hasToken: !!token }); return true
        }
        if (sm[2] === 'check' && req.method === 'POST') { sendJson(res, 200, { ok: true, ...await bots.check(seat) }); return true }
      }
      if (sub === '/chatroom/telegram' && req.method === 'GET') { sendJson(res, 200, { ok: true, ...bots.status() }); return true }
      if (sub === '/chatroom/discovered' && req.method === 'GET') { sendJson(res, 200, { ok: true, groups: await discovered.list({ bound: new Set(chatMap.keys()) }) }); return true }
      const dm = /^\/chatroom\/discovered\/(-\d{5,20})\/(bind|ignore)$/.exec(sub)
      if (dm && req.method === 'POST') {
        if (dm[2] === 'ignore') { await discovered.mark(dm[1], { status: 'ignored' }); sendJson(res, 200, { ok: true, groups: await discovered.list({ bound: new Set(chatMap.keys()) }) }); return true }
        const roomId = String((await body()).roomId || '')
        const room = await bindChat(dm[1], roomId)
        sendJson(res, 200, { ok: true, room, groups: await discovered.list({ bound: new Set(chatMap.keys()) }) }); return true
      }
      const needOn = () => { if (!enabled()) throw new ChatroomError('聊天室未启用', 409) }
      if (sub === '/chatroom/rooms' && req.method === 'POST') {
        needOn()
        const room = await store.createRoom(await body())
        const s = await ensureRoomSession(room.id)
        sendJson(res, 200, { ok: true, room: await store.getRoom(room.id), ...s }); return true
      }
      if (sub === '/chatroom/sessions' && req.method === 'GET') { sendJson(res, 200, { ok: true, sessions: roomSessions.list() }); return true }
      const bm = /^\/chatroom\/rooms\/([a-z0-9-]+)\/briefs\/([a-z0-9]+)\/(execute|cancel|deeplink)$/.exec(sub)
      if (bm && req.method === 'POST') {
        needOn()
        const meta = await store.getRoom(bm[1])
        const brief = meta.briefs?.[bm[2]]
        if (!brief) throw new ChatroomError('任务书不存在', 404)
        if (bm[3] === 'deeplink') { sendJson(res, 200, { ok: true, url: cursorDeeplink(brief.brief) }); return true }
        if (bm[3] === 'cancel') { sendJson(res, 200, { ok: true, cancelled: await moderator.cancelBrief(bm[1]) }); return true }
        // 本机桌面端 = 所有者
        void moderator.post(bm[1], '执行 ' + bm[2], { owner: true })
        sendJson(res, 200, { ok: true, started: true }); return true
      }
      const m = /^\/chatroom\/rooms\/([a-z0-9-]+)(\/[a-z]+)?$/.exec(sub)
      if (!m) { sendJson(res, 404, { ok: false, error: 'not found' }); return true }
      const id = m[1]
      const verb = m[2] || ''
      if (verb === '' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, room: await store.getRoom(id), messages: await store.readMessages(id), ...moderator.status(id) }); return true
      }
      if (verb === '' && req.method === 'PUT') {
        const b = await body()
        let room = await store.getRoom(id)
        if (typeof b.title === 'string') { room = await store.renameRoom(id, b.title); await roomSessions.retitle(id) }
        if (b.telegramChatIds !== undefined) {
          room = await store.setTelegramChats(id, b.telegramChatIds)
          const taken = []
          for (const r of await store.listRooms()) if (r.id !== id) for (const c of r.telegramChatIds || []) if (room.telegramChatIds.includes(c)) taken.push(c)
          if (taken.length) { room = await store.setTelegramChats(id, room.telegramChatIds.filter((c) => !taken.includes(c))); throw new ChatroomError(`群 ${taken.join('、')} 已绑定到其他房间`, 409) }
          await syncTelegram(true)
        }
        sendJson(res, 200, { ok: true, room }); return true
      }
      if (verb === '/session' && req.method === 'POST') {
        needOn()
        await store.getRoom(id)
        const s = await ensureRoomSession(id)
        sendJson(res, s.sessionError ? 409 : 200, s.sessionError ? { ok: false, error: s.sessionError } : { ok: true, ...s }); return true
      }
      if (verb === '/events' && req.method === 'GET') { await store.getRoom(id); openEvents(req, res, id); return true }
      if (verb === '/messages' && req.method === 'POST') {
        needOn()
        const b = await body()
        await store.getRoom(id)
        const out = await moderator.post(id, b.text, { run: b.run !== false, owner: true, source: 'local' })
        sendJson(res, 200, { ok: true, message: out.message, started: out.started }); return true
      }
      if (verb === '/run' && req.method === 'POST') {
        needOn()
        const b = await body()
        await store.getRoom(id)
        const started = moderator.start(id, { rounds: b.rounds, seatIds: Array.isArray(b.seatIds) ? b.seatIds : undefined })
        sendJson(res, started ? 200 : 409, started ? { ok: true } : { ok: false, error: '该房间正在发言，请先停止' }); return true
      }
      if (verb === '/stop' && req.method === 'POST') { sendJson(res, 200, { ok: true, stopped: moderator.stop(id) }); return true }
      sendJson(res, 404, { ok: false, error: 'not found' }); return true
    } catch (e) {
      sendJson(res, e?.status || 400, { ok: false, error: String(e?.message || e) }); return true
    }
  }

  return { discovered, groupCommand, bindChat, bots, sync, dispose, handleApi, store, moderator, overview, catalog, roomSessions }
}
