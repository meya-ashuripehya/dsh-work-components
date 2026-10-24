/**
 * 未授权私聊：待处理名单与设置页接口（宿主侧，打包进 lib/index.mjs）。
 *
 * 名单写在 <数据目录>/telegram/dm-pending.json：
 *   { users: { [userId]: { userId, username, name, firstSeen, lastSeen, count, lastPreview, lastBotId, lastBotName, botIds, status, decidedAt? } } }
 *   status：new（待处理）| ignored（已忽略）| authorized（已授权）。每个用户 ID 只有一条（多条消息、多个机器人合并）。
 *
 * 授权 = 把用户 ID 追加到设置「允许的其他用户 ID」（telegramAllowFrom），通道重启时按卡片写入访问策略的 allowFrom。
 * 这只放开私聊；能否使用会更改电脑的工具仍由「授权用户 ID」（telegramAuthorizedIds，留空 = 所有者）按发送者 ID 决定，不受影响。
 * 授权只经本机设置页的 POST 接口完成；通道与聊天室都没有任何能写白名单的聊天指令。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isUserId, parseUserIds, PREVIEW_MAX } from '../../telegram/dm-discover.mjs'

export const DM_PENDING_MAX = 200
const STATUSES = new Set(['new', 'ignored', 'authorized'])

export function createDmPending(file, { max = DM_PENDING_MAX } = {}) {
  let chain = Promise.resolve()
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }
  async function load() {
    try {
      const j = JSON.parse(await readFile(file, 'utf8'))
      return j && typeof j.users === 'object' && j.users && !Array.isArray(j.users) ? j : { users: {} }
    } catch { return { users: {} } }
  }
  async function save(j) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(j, null, 2) + '\n', 'utf8')
    await rename(file + '.tmp', file)
  }
  const str = (v, n) => String(v ?? '').slice(0, n)

  /** 超出上限时先丢最早的已处理记录，再丢最早的待处理记录。 */
  function trim(j) {
    const all = Object.values(j.users)
    if (all.length <= max) return
    const rank = (u) => (u.status === 'new' ? 1 : 0)
    all.sort((a, b) => rank(a) - rank(b) || String(a.lastSeen).localeCompare(String(b.lastSeen)))
    for (const u of all.slice(0, all.length - max)) delete j.users[u.userId]
  }

  /**
   * 记一条未授权私聊。返回 { user, fresh }：fresh 为 true 表示这是新出现（或授权被撤销后再次出现）的账号，应当通知。
   * 已忽略的账号继续计数，但保持忽略。
   */
  function record(d) {
    return serial(async () => {
      const userId = String(d?.userId ?? '')
      if (!isUserId(userId)) return null
      const j = await load()
      const prev = j.users[userId]
      const now = new Date().toISOString()
      const reopen = !prev || prev.status === 'authorized'
      const botId = str(d.accountId, 40)
      const botIds = [...new Set([...(reopen ? [] : (prev?.botIds || [])), ...(botId ? [botId] : [])])].slice(0, 20)
      const u = {
        userId,
        username: str(d.username, 64) || (reopen ? '' : prev?.username || ''),
        name: str(d.name, 120) || (reopen ? '' : prev?.name || ''),
        firstSeen: reopen ? now : prev.firstSeen || now,
        lastSeen: now,
        count: reopen ? 1 : (Number(prev.count) || 0) + 1,
        lastPreview: str(d.preview, PREVIEW_MAX + 10),
        lastBotId: botId,
        lastBotName: str(d.botName, 80),
        botIds,
        status: reopen ? 'new' : prev.status === 'ignored' ? 'ignored' : 'new',
        ...(!reopen && prev.decidedAt && prev.status === 'ignored' ? { decidedAt: prev.decidedAt } : {}),
      }
      j.users[userId] = u
      trim(j)
      await save(j)
      return { user: { ...u }, fresh: reopen }
    })
  }

  function mark(userId, status) {
    return serial(async () => {
      if (!STATUSES.has(status)) throw new Error('无效的状态')
      const j = await load()
      const u = j.users[String(userId)]
      if (!u) return null
      j.users[u.userId] = { ...u, status, decidedAt: new Date().toISOString() }
      await save(j)
      return { ...j.users[u.userId] }
    })
  }

  function remove(userId) {
    return serial(async () => {
      const j = await load()
      if (!j.users[String(userId)]) return false
      delete j.users[String(userId)]
      await save(j)
      return true
    })
  }

  async function get(userId) {
    const j = await load()
    const u = j.users[String(userId)]
    return u ? { ...u } : null
  }

  /** 最近在前。 */
  async function list() {
    const j = await load()
    return Object.values(j.users)
      .map((u) => JSON.parse(JSON.stringify(u)))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
  }

  return { record, mark, remove, get, list, file }
}

/** 把用户 ID 追加到「允许的其他用户 ID」原文；已在名单（或是所有者）时返回 null。 */
export function appendAllowFrom(raw, userId, ownerId = '') {
  const id = String(userId ?? '').trim()
  if (!isUserId(id)) throw Object.assign(new Error('用户 ID 不是 Telegram 数字用户 ID'), { status: 400 })
  const ids = parseUserIds(raw)
  if (id === String(ownerId ?? '').trim() || ids.includes(id)) return null
  return [...ids, id].join(', ')
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 只接受本机设置页的请求：拒绝跨站 / 同站其他来源（Sec-Fetch-Site），以及非回环地址。
 * 返回拒绝原因；允许时返回 null。
 */
export function localOnlyRefusal(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') return 'cross-site request refused'
  const addr = req?.socket?.remoteAddress
  if (addr && !LOOPBACK.has(String(addr))) return '只能在本机的设置页操作'
  return null
}

/**
 * 设置页接口：
 *   GET  /telegram/dm-pending                     名单
 *   POST /telegram/dm-pending/:userId/authorize   授权（写入「允许的其他用户 ID」）
 *   POST /telegram/dm-pending/:userId/ignore      忽略
 *   POST /telegram/dm-pending/:userId/remove      删除记录（以后再私聊会重新出现）
 * @param {{ store, getConfig: () => object, saveAllowFrom: (raw: string) => Promise<void>, botLabels?: () => Promise<Record<string,string>> }} deps
 */
export function createDmPendingApi({ store, getConfig, saveAllowFrom, botLabels }) {
  async function payload() {
    const cfg = getConfig() || {}
    let labels = {}
    try { labels = (await botLabels?.()) || {} } catch { labels = {} }
    const users = (await store.list()).map((u) => ({ ...u, lastBotLabel: labels[u.lastBotId] || u.lastBotName || u.lastBotId || '' }))
    return {
      users,
      ownerSet: !!String(cfg.telegramOwnerId ?? '').trim(),
      enabled: cfg.telegramEnabled === true,
      allowFrom: String(cfg.telegramAllowFrom ?? ''),
    }
  }

  async function authorize(userId) {
    const u = await store.get(userId)
    if (!u) throw Object.assign(new Error('没有这个账号的私聊记录'), { status: 404 })
    const cfg = getConfig() || {}
    const owner = String(cfg.telegramOwnerId ?? '').trim()
    if (!owner) throw Object.assign(new Error('请先填写「所有者用户 ID」。未填写时通道不会按本页写入私聊白名单，授权不会生效。'), { status: 409 })
    if (typeof saveAllowFrom !== 'function') throw Object.assign(new Error('当前环境无法保存设置'), { status: 501 })
    const next = appendAllowFrom(cfg.telegramAllowFrom, u.userId, owner)
    if (next !== null) await saveAllowFrom(next)
    await store.mark(u.userId, 'authorized')
    return next === null ? String(cfg.telegramAllowFrom ?? '') : next
  }

  async function handle(req, res, sub, { sendJson }) {
    if (sub !== '/telegram/dm-pending' && !sub.startsWith('/telegram/dm-pending/')) return false
    const fail = (status, error) => { sendJson(res, status, { ok: false, error }); return true }
    try {
      const refused = localOnlyRefusal(req)
      if (refused) return fail(403, refused)
      if (sub === '/telegram/dm-pending') {
        if (req.method !== 'GET') return fail(405, 'method not allowed')
        sendJson(res, 200, { ok: true, ...await payload() })
        return true
      }
      const m = /^\/telegram\/dm-pending\/(\d{1,20})\/(authorize|ignore|remove)$/.exec(sub)
      if (!m) return fail(404, 'not found')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      const [, userId, action] = m
      if (action === 'authorize') {
        const allowFrom = await authorize(userId)
        sendJson(res, 200, { ok: true, ...await payload(), allowFrom })
        return true
      }
      if (action === 'ignore') {
        if (!await store.mark(userId, 'ignored')) return fail(404, '没有这个账号的私聊记录')
      } else if (!await store.remove(userId)) return fail(404, '没有这个账号的私聊记录')
      sendJson(res, 200, { ok: true, ...await payload() })
      return true
    } catch (error) {
      return fail(error?.status || 400, String(error?.message || error))
    }
  }

  return { handle, authorize, payload }
}
