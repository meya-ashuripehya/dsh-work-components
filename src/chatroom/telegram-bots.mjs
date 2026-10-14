/**
 * 聊天室的 Telegram 机器人（每个 AI 成员一个机器人，令牌在宿主凭据里）。
 *   - 出站：AI 的回复先写进房间，再用该 AI 自己的机器人 sendMessage 到房间绑定的群；生成期间 sendChatAction typing。
 *   - 入站：只有标记为「接收群消息」的那一个机器人做 getUpdates 长轮询（避免重复接收），
 *           只收房间绑定的群；自己这批机器人发的消息忽略；无需 @。
 *   - 不与「通道 › Telegram」共用令牌：同一令牌两处 getUpdates 会 409，启动时拒绝并报告。
 * fetchImpl 可注入（测试用模拟 Bot API，不联网）。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const API = 'https://api.telegram.org'
const MAX_TEXT = 4000

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
  return {
    call,
    getMe: () => call('getMe'),
    sendMessage: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
    typing: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }),
    getUpdates: (offset, signal, timeout = 25) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'my_chat_member'] }, signal),
  }
}

/**
 * @param {{ resolveToken: (ref) => Promise<string|undefined>, getSeats: () => any[], getProxy: () => string,
 *           conflictToken?: () => Promise<string|undefined>, onInbound: (u: {chatId, fromId, fromName, text, messageId}) => any,
 *           logger?: any, fetchImpl?: Function }} deps
 */
export function createTelegramBots({ resolveToken, getSeats, getProxy = () => '', conflictToken, onInbound, onDiscover = () => {}, onCommand = () => {}, logger, fetchImpl }) {
  const clients = new Map() // seatId → { token, client, botId, username }
  const status = { ingest: null, error: '', bots: {}, polling: false, lastPollAt: '' }
  let poll = null
  let gen = 0

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

  async function botIds() {
    const ids = new Set()
    for (const s of getSeats()) { const c = await clientFor(s); if (c?.botId) ids.add(c.botId) }
    return ids
  }

  /** 生成期间每 4 秒发一次 typing；返回停止函数。 */
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

  /** 用该 AI 的机器人发到所有绑定群；没有令牌时退回接收机器人并加「[名字]」前缀。 */
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
        try { const r = await c.client.sendMessage(id, part); results.push({ chatId: id, ok: true, messageId: r?.message_id }) } catch (e) {
          results.push({ chatId: id, ok: false, error: String(e?.message || e) })
          logger?.warn?.('dsh-workbench: chatroom telegram relay failed', String(e?.message || e))
          break
        }
      }
    }
    return results
  }

  /**
   * 一条更新：my_chat_member（被拉进 / 移出群）→ 记录发现；群命令 /bind /unbind → onCommand（绑定与否都处理，命令不进房间）；
   * 未绑定群的普通消息只记发现，绝不进房间；已绑定群的普通消息 → onInbound。
   */
  let getBound = () => new Set()
  async function handleUpdate(u, { ours, botUsername }) {
    const warn = (e) => logger?.warn?.('dsh-workbench: chatroom inbound failed', String(e?.message || e))
    const cm = u.my_chat_member
    if (cm) {
      if (!isGroup(cm.chat)) return
      const st = cm.new_chat_member?.status
      const active = st === 'member' || st === 'administrator'
      try { await onDiscover({ chatId: String(cm.chat.id), title: String(cm.chat.title || ''), type: cm.chat.type, addedById: String(cm.from?.id || ''), addedBy: nameOf(cm.from), at: new Date((cm.date || 0) * 1000 || Date.now()).toISOString(), via: 'my_chat_member', active }) } catch (e) { warn(e) }
      return
    }
    const m = u.message
    if (!m || !isGroup(m.chat)) return
    const chatId = String(m.chat.id)
    const bound = getBound().has(chatId)
    if (!bound) { try { await onDiscover({ chatId, title: String(m.chat.title || ''), type: m.chat.type, at: new Date((m.date || 0) * 1000 || Date.now()).toISOString(), via: 'message', active: true }) } catch (e) { warn(e) } }
    if (typeof m.text !== 'string') return
    const cmd = parseGroupCommand(m.text, botUsername)
    if (cmd) {
      try { await onCommand({ ...cmd, chatId, title: String(m.chat.title || ''), fromId: String(m.from?.id || ''), fromName: nameOf(m.from), bound }) } catch (e) { warn(e) }
      return
    }
    if (!bound) return
    if (m.from?.is_bot && ours.has(Number(m.from.id))) return
    try { await onInbound({ chatId, fromId: String(m.from?.id || ''), fromName: nameOf(m.from), isBot: !!m.from?.is_bot, text: m.text, messageId: m.message_id }) } catch (e) { warn(e) }
  }

  async function startIngest(getBoundChatIds) {
    getBound = getBoundChatIds
    stopIngest()
    const my = ++gen
    const seat = getSeats().find((s) => s.enabled !== false && s.telegram?.ingest)
    status.ingest = seat ? seat.id : null
    status.error = ''
    if (!seat) return status
    const c = await clientFor(seat)
    if (!c) { status.error = `${seat.name} 未保存机器人令牌`; return status }
    try {
      const other = await conflictToken?.()
      if (other && other === c.token) { status.error = '接收机器人与「通道 › Telegram」使用同一令牌，会互相抢占消息（409）。请为聊天室使用单独的机器人。'; return status }
    } catch {}
    const ctl = new AbortController()
    poll = { ctl }
    void (async () => {
      let offset = 0
      const ours = await botIds()
      try { const me = await c.client.getMe(); c.username = me?.username || ''; status.username = c.username } catch {}
      status.polling = true; status.since = new Date().toISOString()
      while (my === gen && !ctl.signal.aborted) {
        try {
          const ups = await c.client.getUpdates(offset, ctl.signal)
          for (const u of ups || []) {
            offset = Math.max(offset, u.update_id + 1)
            await handleUpdate(u, { ours, botUsername: c.username, ctl })
          }
          status.error = ''; status.lastPollAt = new Date().toISOString()
        } catch (e) {
          if (ctl.signal.aborted) break
          status.error = String(e?.message || e)
          if (e?.code === 409) { status.error = '接收机器人被其他程序同时轮询（409），已停止接收'; break }
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
      if (my === gen) status.polling = false
    })()
    return status
  }

  function stopIngest() {
    gen++
    status.polling = false
    if (poll) { try { poll.ctl.abort() } catch {} poll = null }
  }

  async function check(seat) {
    const c = await clientFor(seat)
    if (!c) return { ok: false, error: '未保存令牌' }
    try { const me = await c.client.getMe(); c.username = me.username || ''; return { ok: true, username: me.username, id: me.id } } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }

  async function reply(chatId, text) {
    const ing = getSeats().find((s) => s.telegram?.ingest)
    const c = ing ? await clientFor(ing) : null
    if (!c) return false
    try { await c.client.sendMessage(chatId, text); return true } catch { return false }
  }

  return { reply, handleUpdate: (u, o = {}) => handleUpdate(u, { ours: o.ours || new Set(), botUsername: o.botUsername || '' }), setBound: (fn) => { getBound = fn }, relay, typing, startIngest, stopIngest, check, status: () => ({ ...status }), clientFor, reset: () => clients.clear() }
}
