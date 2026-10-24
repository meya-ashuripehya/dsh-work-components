/**
 * 聊天室的 Telegram 机器人（每个 AI 成员一个机器人，令牌在宿主凭据里）。
 *   - 出站：AI 的回复先写进房间，再用该 AI 自己的机器人 sendMessage 到房间绑定的群；生成期间 sendChatAction typing。
 *   - 入站：默认只有「接收群消息」席位处理；@ / 回复成员 bot 时临时切换接收者（见 ./intake.mjs）。
 *   - 同一令牌全进程只一处 getUpdates：若通道已在轮询该令牌，则订阅 raw-hub，不再自拉；否则本模块长轮询。
 *   - 附件：入站的图片 / 文件 / 语音 / 音频 / 视频（见 ./attachments.mjs telegramFilesOf）随 onInbound 交出文件描述和
 *     download(fileId, maxBytes)（用收到这条 update 的机器人下载：file_id 只对该机器人有效）；
 *     出站 sendAttachments：成员自己的机器人在群里时用它发（图片 sendPhoto，其余 sendDocument），否则由接收机器人代发并加 [名字] 前缀。
 * fetchImpl 可注入（测试用模拟 Bot API，不联网）。
 */
// FormData 必须来自同一个 undici：npm 版 undici 的 fetch 不认 Node 全局 FormData，会把它当成 "[object FormData]" 文本发出（图片 / 文件发送全部失败）
import { ProxyAgent, fetch as undiciFetch, FormData as UndiciFormData } from 'undici'
import { rawHub } from '../telegram/raw-hub.mjs'
import { receiverFor, createDedupe, createMemberCache, notInGroupNotice, botNotRunningNotice } from './intake.mjs'
import { telegramFilesOf, ATTACH_MAX_BYTES } from './attachments.mjs'
import { registerCardDm } from '../cards/dm.mjs'

const API = 'https://api.telegram.org'
const MAX_TEXT = 4000
const MAX_CAPTION = 1024
const PHOTO_MAX_BYTES = 10 * 1024 * 1024
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
/** getMe 失败后的退避间隔（毫秒）；用完后按最后一项继续重试，直到成功或本代接收被替换。 */
export const ME_RETRY_MS = [2000, 5000, 10000, 30000, 60000]

export function splitForTelegram(text, max = MAX_TEXT) {
  const t = String(text || '')
  if (t.length <= max) return t ? [t] : []
  const out = []
  let rest = t
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** 群内命令：/bind [房间名]、/unbind；可带 @机器人名。返回 { cmd, arg } 或 null。 */
export function parseGroupCommand(text, botUsername = '') {
  const m = /^\/(bind|unbind)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim())
  if (!m) return null
  if (m[2] && botUsername && m[2].toLowerCase() !== String(botUsername).toLowerCase()) return null
  return { cmd: m[1].toLowerCase(), arg: String(m[3] || '').trim() }
}

/** 机器人查询「自己」时，这些错误说明它不在该群（被移出 / 看不到这个群）。 */
const selfAbsentError = (e) => e?.code === 403 || /bot is not a member|bot was kicked|chat not found/i.test(String(e?.message || ''))

/**
 * 查某个成员机器人是否在群：先用它自己的令牌查自己（机器人通常查不到别的机器人，
 * 超级群里会报 PARTICIPANT_ID_INVALID），失败再用 helper（接收机器人）查。
 */
export function memberFetchers(target, helper) {
  const out = []
  if (target?.client) {
    out.push(async (cid, uid) => {
      try { return await target.client.getChatMember(cid, uid) } catch (e) {
        if (selfAbsentError(e)) return { status: 'left' }
        throw e
      }
    })
  }
  if (helper?.client && helper !== target) out.push((cid, uid) => helper.client.getChatMember(cid, uid))
  return out
}

const isGroup = (chat) => chat && (chat.type === 'group' || chat.type === 'supergroup')
const nameOf = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || String(u?.id || '')

export function createBotClient(token, { proxy, fetchImpl } = {}) {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
  const f = fetchImpl || ((url, init) => undiciFetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) }))
  async function call(method, body, signal) {
    const res = await f(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal })
    let j
    try { j = await res.json() } catch { j = { ok: false, description: `HTTP ${res.status}` } }
    if (!j.ok) throw Object.assign(new Error(`Telegram ${method}: ${j.description || res.status}`), { code: j.error_code })
    return j.result
  }
  async function callForm(method, form, signal) {
    const res = await f(`${API}/bot${token}/${method}`, { method: 'POST', body: form, signal })
    let j
    try { j = await res.json() } catch { j = { ok: false, description: `HTTP ${res.status}` } }
    if (!j.ok) throw Object.assign(new Error(`Telegram ${method}: ${j.description || res.status}`), { code: j.error_code })
    return j.result
  }
  /** 上传一个文件（multipart）。field：photo / document。 */
  function sendFile(method, field, chatId, file, caption = '') {
    const form = new UndiciFormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', String(caption).slice(0, MAX_CAPTION))
    form.append(field, new Blob([file.data], { type: file.mediaType || 'application/octet-stream' }), file.name || 'file')
    return callForm(method, form)
  }
  /** getFile + 下载。超过 maxBytes 时抛 { code: 'TOO_LARGE' }；Bot API 自身只允许下载 20 MB 以内的文件。 */
  async function download(fileId, maxBytes = ATTACH_MAX_BYTES) {
    const info = await call('getFile', { file_id: fileId })
    if (Number(info?.file_size) > maxBytes) throw Object.assign(new Error('file too large'), { code: 'TOO_LARGE', size: Number(info.file_size) })
    if (!info?.file_path) throw new Error('Telegram getFile 未返回文件路径')
    const res = await f(`${API}/file/bot${token}/${info.file_path}`, { method: 'GET' })
    if (!res.ok) throw new Error(`Telegram 文件下载失败：HTTP ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length > maxBytes) throw Object.assign(new Error('file too large'), { code: 'TOO_LARGE', size: data.length })
    return { data, filePath: String(info.file_path) }
  }
  return {
    call,
    callForm,
    sendFile,
    download,
    getMe: () => call('getMe'),
    getChatMember: (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId }),
    sendMessage: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
    typing: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }),
    getUpdates: (offset, signal, timeout = 25) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'edited_message', 'my_chat_member'] }, signal),
  }
}

/**
 * @param {{ resolveToken: (ref) => Promise<string|undefined>, getSeats: () => any[], getProxy: () => string,
 *           channelOwnsToken?: (token: string) => Promise<boolean>|boolean,
 *           onInbound: (u) => any, onDiscover?: Function, onCommand?: Function,
 *           logger?: any, fetchImpl?: Function, hub?: typeof rawHub }} deps
 */
export function createTelegramBots({
  resolveToken, getSeats, getProxy = () => '', channelOwnsToken, sharedChannelToken,
  onInbound, onDiscover = () => {}, onCommand = () => {}, onPrivate = () => {},
  logger, fetchImpl, hub = rawHub,
  meRetryMs = ME_RETRY_MS,
}) {
  const clients = new Map() // seatId → { token, client, botId, username }
  // bots：其它成员机器人的接收状态 seatId → { mode: 'self'|'delegated', alive, error, username }
  const status = { ingest: null, error: '', bots: {}, polling: false, lastPollAt: '', mode: 'off' }
  let poll = null
  let gen = 0
  let unsubHub = null
  let extraPolls = [] // 其它成员独立令牌的自拉（通道未占用时）
  let extraGen = -1 // 本代已启动过其它成员的接收：409 回退路径会再调一次，避免同一令牌起两个 getUpdates 互相 409
  let getBound = () => new Set()
  const dedupe = createDedupe()
  const members = createMemberCache()

  async function clientFor(seat) {
    const ref = seat?.telegram?.tokenRef
    if (!ref) return null
    let token
    try { token = await resolveToken(ref) } catch { token = undefined }
    if (!token) { clients.delete(seat.id); return null }
    const hit = clients.get(seat.id)
    if (hit && hit.token === token) return hit
    const c = { token, client: createBotClient(token, { proxy: getProxy(), fetchImpl }), botId: Number(String(token).split(':')[0]) || 0, username: '' }
    clients.set(seat.id, c)
    return c
  }

  /**
   * getMe 带退避重试：DSH 刚启动时代理 / 网络常有瞬断（fetch failed），一次失败不应让状态永久停在「连通性异常」、
   * 也不应让 username 一直为空（/bind@bot、@ 识别依赖它）。本代接收被替换（gen 变化）即停止。不阻塞调用方。
   */
  function retryGetMe(c, my, { onOk, onFail } = {}, { immediate = true } = {}) {
    const delays = Array.isArray(meRetryMs) && meRetryMs.length ? meRetryMs : ME_RETRY_MS
    let attempt = 0
    const schedule = (ms) => { const t = setTimeout(run, ms); t.unref?.() }
    async function run() {
      if (my !== gen) return
      try {
        const me = await c.client.getMe()
        if (my !== gen) return
        c.username = me?.username || ''
        try { onOk?.(me) } catch {}
      } catch (e) {
        if (my !== gen) return
        const delay = delays[Math.min(attempt, delays.length - 1)]
        attempt++
        try { onFail?.(e, attempt, delay) } catch {}
        logger?.warn?.('dsh-workbench: chatroom telegram getMe failed, retrying', { attempt, delayMs: delay, error: String(e?.message || e) })
        schedule(delay)
      }
    }
    if (immediate) return run()
    schedule(delays[0])
    return Promise.resolve()
  }

  async function clientsBySeat() {
    const out = {}
    for (const s of getSeats()) {
      const c = await clientFor(s)
      if (c) out[s.id] = c
    }
    return out
  }

  async function botIds() {
    const ids = new Set()
    for (const s of getSeats()) { const c = await clientFor(s); if (c?.botId) ids.add(c.botId) }
    return ids
  }

  function typing(seat, chatIds) {
    if (!chatIds?.length) return () => {}
    let stopped = false
    let timer = null
    const tick = async () => {
      if (stopped) return
      const c = await clientFor(seat)
      if (c) for (const id of chatIds) c.client.typing(id).catch(() => {})
      if (!stopped) { timer = setTimeout(tick, 4000); timer.unref?.() }
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }

  async function relay(seat, chatIds, text, { prefixName } = {}) {
    const results = []
    if (!chatIds?.length || !String(text || '').trim()) return results
    let c = seat ? await clientFor(seat) : null
    let body = String(text)
    if (!c) {
      const ing = getSeats().find((s) => s.telegram?.ingest)
      c = ing ? await clientFor(ing) : null
      if (!c) return results
      if (prefixName) body = `[${prefixName}] ${body}`
    }
    for (const id of chatIds) {
      for (const part of splitForTelegram(body)) {
        try {
          const r = await c.client.sendMessage(id, part)
          results.push({ chatId: id, ok: true, messageId: r?.message_id })
        } catch (e) {
          results.push({ chatId: id, ok: false, error: String(e?.message || e) })
          logger?.warn?.('dsh-workbench: chatroom telegram relay failed', String(e?.message || e))
          break
        }
      }
    }
    return results
  }

  /** 发送一个文件：图片（≤10 MB 的 jpeg/png/webp）走 sendPhoto，失败或其他类型走 sendDocument。 */
  async function sendOneFile(client, chatId, file, caption) {
    if (file.kind === 'image' && PHOTO_TYPES.has(String(file.mediaType || '').toLowerCase()) && file.data.length <= PHOTO_MAX_BYTES) {
      try { return await client.sendFile('sendPhoto', 'photo', chatId, file, caption) } catch (e) {
        logger?.warn?.('dsh-workbench: chatroom sendPhoto failed, retry as document', String(e?.message || e))
      }
    }
    return client.sendFile('sendDocument', 'document', chatId, file, caption)
  }

  /**
   * 把附件发到绑定群。seat 的机器人在群里时用它发；否则（或 seat 为空）由接收机器人代发，说明文字加 [prefixName] 前缀。
   * @param {{ data: Buffer, name: string, mediaType: string, kind: string }[]} files
   * @returns {Promise<{ chatId: string, ok: boolean, via?: 'own'|'intake', error?: string }[]>}
   */
  async function sendAttachments(seat, chatIds, files, { caption = '', prefixName } = {}) {
    const results = []
    if (!chatIds?.length || !files?.length) return results
    const own = seat ? await clientFor(seat) : null
    const ing = getSeats().find((s) => s.enabled !== false && s.telegram?.ingest) || null
    const ingClient = ing ? await clientFor(ing) : null
    for (const chatId of chatIds) {
      let c = null
      let via = 'own'
      if (own) {
        if (ing && seat && ing.id === seat.id) c = own
        else if (await members.isMember(chatId, own.botId, memberFetchers(own, ingClient))) c = own
      }
      if (!c) { c = ingClient; via = 'intake' }
      if (!c) { results.push({ chatId, ok: false, error: '没有可用的机器人（未保存令牌）' }); continue }
      let cap = String(caption || '').trim()
      if (via === 'intake' && prefixName) cap = `[${prefixName}]${cap ? ' ' + cap : ''}`
      try {
        if (cap.length > MAX_CAPTION) { for (const part of splitForTelegram(cap)) await c.client.sendMessage(chatId, part); cap = '' }
        for (let i = 0; i < files.length; i++) await sendOneFile(c.client, chatId, files[i], i === 0 ? cap : '')
        results.push({ chatId, ok: true, via })
      } catch (e) {
        results.push({ chatId, ok: false, via, error: String(e?.message || e) })
        logger?.warn?.('dsh-workbench: chatroom telegram attachment failed', String(e?.message || e))
      }
    }
    return results
  }

  async function sendAs(seatOrClient, chatId, text) {
    const c = seatOrClient?.client ? seatOrClient : await clientFor(seatOrClient)
    if (!c) return false
    try { await c.client.sendMessage(chatId, text); return true } catch { return false }
  }

  /**
   * @param raw Telegram update
   * @param {{ ours?: Set<number>, botUsername?: string, receivingSeatId?: string, receivingBotId?: number }} opts
   *   receivingSeatId/BotId：这条 update 是哪个 bot 的 getUpdates 收到的（通道转发时带上 account 对应席位或 botId）
   */
  async function handleUpdate(u, opts = {}) {
    const warn = (e) => logger?.warn?.('dsh-workbench: chatroom inbound failed', String(e?.message || e))
    const ours = opts.ours || await botIds()
    const bySeat = await clientsBySeat()
    const seats = getSeats()
    const ingestSeat = seats.find((s) => s.enabled !== false && s.telegram?.ingest) || null
    const ingestClient = ingestSeat ? bySeat[ingestSeat.id] : null

    // 确定「当前这份 update 的接收 bot」对应哪个席位
    let receivingSeat = null
    if (opts.receivingSeatId) receivingSeat = seats.find((s) => s.id === opts.receivingSeatId) || null
    if (!receivingSeat && opts.receivingBotId) {
      receivingSeat = seats.find((s) => bySeat[s.id]?.botId === Number(opts.receivingBotId)) || null
    }
    if (!receivingSeat && opts.botUsername) {
      const u = String(opts.botUsername).toLowerCase()
      receivingSeat = seats.find((s) => String(bySeat[s.id]?.username || '').toLowerCase() === u) || null
    }
    // 自拉轮询时默认就是主接收席位
    if (!receivingSeat) receivingSeat = ingestSeat

    const cm = u.my_chat_member
    if (cm) {
      if (!isGroup(cm.chat)) return
      const st = cm.new_chat_member?.status
      const active = st === 'member' || st === 'administrator'
      const chatId = String(cm.chat.id)
      members.invalidate(chatId, cm.new_chat_member?.user?.id)
      try {
        await onDiscover({
          chatId, title: String(cm.chat.title || ''), type: cm.chat.type,
          addedById: String(cm.from?.id || ''), addedBy: nameOf(cm.from),
          at: new Date((cm.date || 0) * 1000 || Date.now()).toISOString(),
          via: 'my_chat_member', active,
        })
      } catch (e) { warn(e) }
      return
    }

    const m = u.message || u.edited_message
    if (!m) return
    if (!isGroup(m.chat)) {
      if (m.chat?.type !== 'private') return
      if (!ingestSeat || receivingSeat?.id !== ingestSeat.id) return
      const fromId = String(m.from?.id || '')
      const text = typeof m.text === 'string' ? m.text.trim() : ''
      if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
        registerCardDm(fromId, String(m.chat.id))
        if (ingestClient) await sendAs(ingestClient, m.chat.id, '已登记。牌局中的手牌会发到这里。在群里回复「入座」后即可出牌。')
      } else {
        try { await onPrivate({ fromId, chatId: String(m.chat.id), text }) } catch (e) { warn(e) }
      }
      return
    }
    const chatId = String(m.chat.id)
    const bound = getBound().has(chatId)

    if (!bound) {
      try {
        await onDiscover({
          chatId, title: String(m.chat.title || ''), type: m.chat.type,
          at: new Date((m.date || 0) * 1000 || Date.now()).toISOString(),
          via: 'message', active: true,
        })
      } catch (e) { warn(e) }
    }

    const files = telegramFilesOf(m)
    if (typeof m.text !== 'string' && typeof m.caption !== 'string' && !files.length) return
    const text = typeof m.text === 'string' ? m.text : String(m.caption || '')

    const cmd = typeof m.text === 'string' ? parseGroupCommand(text, opts.botUsername || receivingSeat && bySeat[receivingSeat.id]?.username || '') : null
    if (cmd) {
      // 保险去重：未绑定群可能被多个 bot 同时收到 /bind
      if (m.message_id != null && dedupe.seen(chatId, m.message_id, m.edit_date)) return
      try { await onCommand({ ...cmd, chatId, title: String(m.chat.title || ''), fromId: String(m.from?.id || ''), fromName: nameOf(m.from), bound }) } catch (e) { warn(e) }
      return
    }

    if (!bound) return
    if (m.from?.is_bot && ours.has(Number(m.from.id))) return
    if (opts.foreignBot) return

    // 已绑定群：只认主接收，或 @/回复临时切换（先判定再去重，避免主接收丢弃时占掉被 @ 者的名额）
    const pick = receiverFor(m, seats, bySeat)
    if (!pick.seat) return

    if (pick.switchRequested) {
      const target = pick.seat
      const targetClient = bySeat[target.id]
      const targetBotId = targetClient?.botId
      const isIngestCopy = receivingSeat?.id === ingestSeat?.id
      if (!targetBotId) {
        // 没有令牌 → 本模块根本没有这个机器人的客户端，和「不在本群」是两回事
        if (isIngestCopy && ingestClient) {
          if (m.message_id != null && dedupe.seen(chatId, m.message_id, m.edit_date)) return
          await sendAs(ingestClient, chatId, botNotRunningNotice(pick.label))
        }
        return
      }
      if (receivingSeat?.id === target.id) {
        // 目标机器人自己从这个群收到了这条消息 → 它必然在群里，不用再查
        members.markMember(chatId, targetBotId)
      } else {
        const r = await members.check(chatId, targetBotId, memberFetchers(targetClient, ingestClient))
        if (r.state === 'error') {
          // 查询失败 ≠ 不在群：不发「不在本群」，交给目标机器人自己的轮询接收
          logger?.warn?.('dsh-workbench: chatroom getChatMember failed', `@${pick.label}`, r.error)
          return
        }
        if (isIngestCopy && ingestClient) {
          const poller = status.bots[target.id]
          const notice = r.state === 'absent' ? notInGroupNotice(pick.label)
            : poller && poller.alive === false ? botNotRunningNotice(pick.label, poller.error || '它的消息接收已停止')
              : ''
          if (notice) {
            if (m.message_id != null && dedupe.seen(chatId, m.message_id, m.edit_date)) return
            await sendAs(ingestClient, chatId, notice)
          }
        }
        return
      }
    } else {
      if (receivingSeat?.id !== ingestSeat?.id) return
    }

    if (m.message_id != null && dedupe.seen(chatId, m.message_id, m.edit_date)) return
    // 编辑过的消息不重复接收附件（只更新文字的编辑照旧进房间）
    const inFiles = u.edited_message ? [] : files
    if (!text.trim() && !inFiles.length) return
    const dl = (receivingSeat && bySeat[receivingSeat.id]) || ingestClient
    try {
      await onInbound({
        chatId, fromId: String(m.from?.id || ''), fromName: nameOf(m.from),
        isBot: !!m.from?.is_bot, text, messageId: m.message_id,
        viaSeatId: pick.seat.id, via: pick.via,
        files: inFiles,
        ...(m.media_group_id ? { mediaGroupId: String(m.media_group_id) } : {}),
        download: (fileId, maxBytes) => {
          if (!dl) return Promise.reject(new Error('没有可下载文件的机器人'))
          return dl.client.download(fileId, maxBytes)
        },
      })
    } catch (e) { warn(e) }
  }


  /** 其它成员若有独立令牌且通道未轮询，则自拉，以便 @ 临时切换能收到。 */
  async function ensureExtraSeatPollers(my) {
    if (extraGen === my) return
    extraGen = my
    for (const s of getSeats()) {
      if (s.enabled === false || s.telegram?.ingest) continue
      const oc = await clientFor(s)
      if (!oc) continue
      let owned = false
      try { owned = !!(await channelOwnsToken?.(oc.token)) } catch { owned = false }
      if (owned) {
        // 通道在拉：订阅 hub
        const dst = { mode: 'delegated', alive: true, error: '', username: oc.username || '' }
        status.bots[s.id] = dst
        if (!oc.username) {
          void retryGetMe(oc, my, {
            onOk: () => { dst.username = oc.username; dst.error = '' },
            onFail: (e) => { dst.error = 'getMe 失败：' + String(e?.message || e) },
          })
        }
        const off = hub.subscribe(oc.token, {
          id: `chatroom-seat-${s.id}`,
          onUpdate: async (raw) => {
            if (my !== gen) return
            await handleUpdate(raw, {
              ours: await botIds(), botUsername: oc.username,
              receivingSeatId: s.id, receivingBotId: oc.botId,
            })
          },
        })
        extraPolls.push({ stop: off })
        continue
      }
      // 自拉
      const pst = { mode: 'self', alive: true, error: '', username: oc.username || '' }
      status.bots[s.id] = pst
      try { const me = await oc.client.getMe(); oc.username = me?.username || ''; pst.username = oc.username } catch (e) {
        pst.error = 'getMe 失败：' + String(e?.message || e)
        void retryGetMe(oc, my, { onOk: () => { pst.username = oc.username } }, { immediate: false })
      }
      const ctl = new AbortController()
      extraPolls.push({ stop: () => { try { ctl.abort() } catch {} } })
      void (async () => {
        let offset = 0
        while (my === gen && !ctl.signal.aborted) {
          try {
            const ups = await oc.client.getUpdates(offset, ctl.signal)
            pst.error = ''
            for (const u of ups || []) {
              offset = Math.max(offset, u.update_id + 1)
              await handleUpdate(u, { ours: await botIds(), botUsername: oc.username, receivingSeatId: s.id, receivingBotId: oc.botId })
            }
          } catch (e) {
            if (ctl.signal.aborted) break
            pst.error = String(e?.message || e)
            if (e?.code === 409) { pst.error = '该令牌被其他程序同时轮询（409），已停止接收'; break }
            await new Promise((r) => setTimeout(r, 5000))
          }
        }
        if (my === gen && !ctl.signal.aborted) pst.alive = false
      })()
    }
  }

  async function startIngest(getBoundChatIds) {
    getBound = getBoundChatIds
    stopIngest()
    const my = ++gen
    const seat = getSeats().find((s) => s.enabled !== false && s.telegram?.ingest)
    status.ingest = seat ? seat.id : null
    status.error = ''
    status.mode = 'off'
    status.meChecked = false
    if (!seat) return status
    const c = await clientFor(seat)
    if (!c) { status.error = `${seat.name} 未保存机器人令牌`; return status }

    // 通道已 claim 同一令牌，或该令牌出现在通道令牌表中 → 只订 hub，绝不自拉（避免 409 / 竞态）
    let owned = false
    try { owned = !!(await channelOwnsToken?.(c.token)) } catch { owned = false }
    const sharedWithChannel = typeof sharedChannelToken === 'function' ? !!sharedChannelToken(c.token) : false
    if (owned || sharedWithChannel) {
      status.mode = 'delegated'
      status.polling = false
      status.username = c.username
      // 先订阅再 getMe：getMe 经坏代理会长时间挂起，此前若已有 getUpdates 会 delivered=false → 发现失败
      try {
        unsubHub = hub.subscribe(c.token, {
          id: 'chatroom-ingest',
          onUpdate: async (raw, meta) => {
            if (my !== gen) return
            const ours = await botIds()
            const botId = Number(String(c.token).split(':')[0]) || 0
            await handleUpdate(raw, {
              ours, botUsername: c.username,
              receivingSeatId: seat.id, receivingBotId: botId,
              foreignBot: meta?.foreignBot === true,
            })
            status.lastPollAt = new Date().toISOString()
          },
        })
      } catch (e) {
        status.error = '共享轮询交接失败：' + String(e?.message || e)
        status.mode = 'off'
        return status
      }
      // 订阅已生效；网络错误只反映到状态，不拆掉 hub，并退避重试直到恢复
      void retryGetMe(c, my, {
        onOk: () => {
          status.username = c.username
          status.error = ''
          status.meChecked = true
        },
        onFail: (e, n, delay) => {
          status.meChecked = true
          status.error = 'Telegram 连通性异常：' + String(e?.message || e) + `（第 ${n} 次，${Math.round(delay / 1000)} 秒后自动重试）`
        },
      })
      void ensureExtraSeatPollers(my)
      return status
    }

    // 本模块长轮询
    status.mode = 'polling'
    const ctl = new AbortController()
    poll = { ctl }
    void (async () => {
      let offset = 0
      const ours = await botIds()
      try {
        const me = await c.client.getMe()
        c.username = me?.username || ''
        status.username = c.username
      } catch {
        void retryGetMe(c, my, { onOk: () => { status.username = c.username } }, { immediate: false })
      }
      status.polling = true
      status.meChecked = true
      status.since = new Date().toISOString()
      while (my === gen && !ctl.signal.aborted) {
        try {
          const ups = await c.client.getUpdates(offset, ctl.signal)
          for (const u of ups || []) {
            offset = Math.max(offset, u.update_id + 1)
            await handleUpdate(u, { ours, botUsername: c.username, receivingSeatId: seat.id, receivingBotId: c.botId })
          }
          status.error = ''
          status.lastPollAt = new Date().toISOString()
        } catch (e) {
          if (ctl.signal.aborted) break
          status.error = String(e?.message || e)
          if (e?.code === 409) {
            // 通道已占用同令牌：改走 hub 委托，而不是永久停收
            let owned = false
            try { owned = !!(await channelOwnsToken?.(c.token)) } catch { owned = false }
            if (owned && my === gen) {
              status.error = ''
              status.mode = 'delegated'
              status.polling = false
              unsubHub = hub.subscribe(c.token, {
                id: 'chatroom-ingest',
                onUpdate: async (raw, meta) => {
                  if (my !== gen) return
                  await handleUpdate(raw, {
                    ours: await botIds(), botUsername: c.username,
                    receivingSeatId: seat.id, receivingBotId: c.botId,
                    foreignBot: meta?.foreignBot === true,
                  })
                  status.lastPollAt = new Date().toISOString()
                },
              })
              void ensureExtraSeatPollers(my)
              break
            }
            status.error = '接收机器人被其他程序同时轮询（409），已停止接收'
            break
          }
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
      if (my === gen) status.polling = false
    })()
    void ensureExtraSeatPollers(my)
    return status
  }

  function stopIngest() {
    gen++
    status.bots = {}
    status.polling = false
    status.mode = 'off'
    status.meChecked = false
    if (poll) { try { poll.ctl.abort() } catch {}; poll = null }
    if (unsubHub) { try { unsubHub() } catch {}; unsubHub = null }
    for (const p of extraPolls) { try { p.stop?.() } catch {} }
    extraPolls = []
  }

  async function check(seat) {
    const c = await clientFor(seat)
    if (!c) return { ok: false, error: '未保存令牌' }
    try {
      const me = await c.client.getMe()
      c.username = me.username || ''
      return { ok: true, username: me.username, id: me.id, canReadAllGroupMessages: me.can_read_all_group_messages === true }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }

  async function reply(chatId, text) {
    const ing = getSeats().find((s) => s.telegram?.ingest)
    const c = ing ? await clientFor(ing) : null
    if (!c) return false
    try { await c.client.sendMessage(chatId, text); return true } catch { return false }
  }

  function describeStatus() {
    const out = { ...status, bots: { ...status.bots } }
    if (status.error) {
      out.ready = false
      out.phase = 'error'
      out.detail = status.error
    } else if (status.mode === 'delegated' && status.meChecked) {
      out.ready = true
      out.phase = 'ready'
      out.detail = '经通道共享轮询接收中'
    } else if (status.mode === 'polling' && status.polling) {
      out.ready = true
      out.phase = 'ready'
      out.detail = '长轮询接收中'
    } else if (status.mode === 'delegated' || status.mode === 'polling' || status.ingest) {
      out.ready = false
      out.phase = 'waiting'
      out.detail = 'Telegram 接收尚未就绪'
    } else {
      out.ready = false
      out.phase = 'off'
      out.detail = status.ingest ? '' : '未指定接收群消息的机器人'
    }
    return out
  }

  return {
    reply,
    handleUpdate: (u, o = {}) => handleUpdate(u, o),
    setBound: (fn) => { getBound = fn },
    relay, sendAttachments, typing, startIngest, stopIngest, check,
    sendDm: async (chatId, text) => {
      const ing = getSeats().find((s) => s.enabled !== false && s.telegram?.ingest) || null
      if (!ing) return false
      return sendAs(ing, chatId, text)
    },
    status: () => describeStatus(),
    setStatusError: (msg) => { status.error = String(msg || ''); if (!status.mode || status.mode === 'off') status.mode = 'off' },
    clearStatusError: () => { status.error = '' },
    clientFor, reset: () => clients.clear(),
    _test: { dedupe, members, receiverFor },
  }
}
