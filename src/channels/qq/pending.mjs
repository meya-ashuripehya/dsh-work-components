/**
 * QQ 未授权私聊 + 群聊：待处理名单与设置页接口（宿主侧，打包进 lib/index.mjs）。
 *
 * 名单写在 <数据目录>/qq/pending.json：
 *   {
 *     users:  { [openid]: { userId, name, firstSeen, lastSeen, count, lastPreview, lastText?, lastMessageId?, accountId?, status, decidedAt?, replayedAt? } },
 *     groups: { [groupOpenId]: { groupId, name, firstSeen, lastSeen, count, lastPreview, lastText?, lastMessageId?, lastMentionedBot?, lastSenderId, lastSenderName, accountId?, status, decidedAt?, replayedAt? } }
 *   }
 *   status：new | ignored | authorized。每个 OpenID / group_openid 一条（多条消息合并）。
 *   lastText / lastMessageId：触发 pending 的原文，授权后回放进 harness（见 replayAuthorized）。
 *
 * 授权私聊 = 追加到 qqAllowFrom；授权群 = 追加到 qqGroupIds，若 qqGroupPolicy 为 disabled 则切到 allowlist。
 * 电脑工具闸门（qqAuthorizedIds）不受影响。授权只经本机设置页 POST；无聊天指令可写白名单。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isOpenId, parseOpenIds, PREVIEW_MAX, REPLAY_TEXT_MAX } from '../../qq/pending-discover.mjs'

export const PENDING_MAX = 200
const STATUSES = new Set(['new', 'ignored', 'authorized'])
const OPENID_PATH = '([A-Za-z0-9_-]{8,128})'

export function createQQPending(file, { max = PENDING_MAX } = {}) {
  let chain = Promise.resolve()
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }
  async function load() {
    try {
      const j = JSON.parse(await readFile(file, 'utf8'))
      const users = j && typeof j.users === 'object' && j.users && !Array.isArray(j.users) ? j.users : {}
      const groups = j && typeof j.groups === 'object' && j.groups && !Array.isArray(j.groups) ? j.groups : {}
      return { users, groups }
    } catch { return { users: {}, groups: {} } }
  }
  async function save(j) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(j, null, 2) + '\n', 'utf8')
    await rename(file + '.tmp', file)
  }
  const str = (v, n) => String(v ?? '').slice(0, n)

  /** 超出上限时先丢最早的已处理记录，再丢最早的待处理记录（users / groups 各自封顶）。 */
  function trimBucket(bucket, idKey) {
    const all = Object.values(bucket)
    if (all.length <= max) return
    const rank = (u) => (u.status === 'new' ? 1 : 0)
    all.sort((a, b) => rank(a) - rank(b) || String(a.lastSeen).localeCompare(String(b.lastSeen)))
    for (const u of all.slice(0, all.length - max)) delete bucket[u[idKey]]
  }

  function recordUser(d) {
    return serial(async () => {
      const userId = String(d?.userId ?? '')
      if (!isOpenId(userId)) return null
      const j = await load()
      const prev = j.users[userId]
      const now = new Date().toISOString()
      const reopen = !prev || prev.status === 'authorized'
      const text = str(d.text, REPLAY_TEXT_MAX) || (reopen ? '' : prev?.lastText || '')
      const messageId = str(d.messageId, 200) || (reopen ? '' : prev?.lastMessageId || '')
      const accountId = str(d.accountId, 40) || (reopen ? 'main' : prev?.accountId || 'main')
      const u = {
        userId,
        name: str(d.name, 120) || (reopen ? '' : prev?.name || ''),
        firstSeen: reopen ? now : prev.firstSeen || now,
        lastSeen: now,
        count: reopen ? 1 : (Number(prev.count) || 0) + 1,
        lastPreview: str(d.preview, PREVIEW_MAX + 10),
        ...(text ? { lastText: text } : {}),
        ...(messageId ? { lastMessageId: messageId } : {}),
        accountId,
        status: reopen ? 'new' : prev.status === 'ignored' ? 'ignored' : 'new',
        ...(!reopen && prev.decidedAt && prev.status === 'ignored' ? { decidedAt: prev.decidedAt } : {}),
      }
      j.users[userId] = u
      trimBucket(j.users, 'userId')
      await save(j)
      return { kind: 'dm', user: { ...u }, fresh: reopen }
    })
  }

  function recordGroup(d) {
    return serial(async () => {
      const groupId = String(d?.groupId ?? '')
      if (!isOpenId(groupId)) return null
      const j = await load()
      const prev = j.groups[groupId]
      const now = new Date().toISOString()
      const reopen = !prev || prev.status === 'authorized'
      const text = str(d.text, REPLAY_TEXT_MAX) || (reopen ? '' : prev?.lastText || '')
      const messageId = str(d.messageId, 200) || (reopen ? '' : prev?.lastMessageId || '')
      const accountId = str(d.accountId, 40) || (reopen ? 'main' : prev?.accountId || 'main')
      const mentioned = d.mentionedBot === false || d.mentionedBot === true
        ? d.mentionedBot
        : (reopen ? true : (prev?.lastMentionedBot !== false))
      const g = {
        groupId,
        name: str(d.name, 120) || (reopen ? '' : prev?.name || ''),
        firstSeen: reopen ? now : prev.firstSeen || now,
        lastSeen: now,
        count: reopen ? 1 : (Number(prev.count) || 0) + 1,
        lastPreview: str(d.preview, PREVIEW_MAX + 10),
        ...(text ? { lastText: text } : {}),
        ...(messageId ? { lastMessageId: messageId } : {}),
        lastMentionedBot: mentioned !== false,
        lastSenderId: str(d.lastSenderId, 128) || (reopen ? '' : prev?.lastSenderId || ''),
        lastSenderName: str(d.lastSenderName, 120) || (reopen ? '' : prev?.lastSenderName || ''),
        accountId,
        status: reopen ? 'new' : prev.status === 'ignored' ? 'ignored' : 'new',
        ...(!reopen && prev.decidedAt && prev.status === 'ignored' ? { decidedAt: prev.decidedAt } : {}),
      }
      j.groups[groupId] = g
      trimBucket(j.groups, 'groupId')
      await save(j)
      return { kind: 'group', group: { ...g }, fresh: reopen }
    })
  }

  /** info.kind === 'group' → 群；否则私聊。 */
  function record(info) {
    if (info?.kind === 'group') return recordGroup(info)
    return recordUser(info)
  }

  function markUser(userId, status) {
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

  function markGroup(groupId, status) {
    return serial(async () => {
      if (!STATUSES.has(status)) throw new Error('无效的状态')
      const j = await load()
      const g = j.groups[String(groupId)]
      if (!g) return null
      j.groups[g.groupId] = { ...g, status, decidedAt: new Date().toISOString() }
      await save(j)
      return { ...j.groups[g.groupId] }
    })
  }

  function markReplayed(kind, id) {
    return serial(async () => {
      const j = await load()
      const now = new Date().toISOString()
      if (kind === 'group') {
        const g = j.groups[String(id)]
        if (!g) return null
        j.groups[g.groupId] = { ...g, replayedAt: now }
        await save(j)
        return { ...j.groups[g.groupId] }
      }
      const u = j.users[String(id)]
      if (!u) return null
      j.users[u.userId] = { ...u, replayedAt: now }
      await save(j)
      return { ...j.users[u.userId] }
    })
  }

  function removeUser(userId) {
    return serial(async () => {
      const j = await load()
      if (!j.users[String(userId)]) return false
      delete j.users[String(userId)]
      await save(j)
      return true
    })
  }

  function removeGroup(groupId) {
    return serial(async () => {
      const j = await load()
      if (!j.groups[String(groupId)]) return false
      delete j.groups[String(groupId)]
      await save(j)
      return true
    })
  }

  async function getUser(userId) {
    const j = await load()
    const u = j.users[String(userId)]
    return u ? { ...u } : null
  }

  async function getGroup(groupId) {
    const j = await load()
    const g = j.groups[String(groupId)]
    return g ? { ...g } : null
  }

  async function list() {
    const j = await load()
    const users = Object.values(j.users).map((u) => JSON.parse(JSON.stringify(u)))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    const groups = Object.values(j.groups).map((g) => JSON.parse(JSON.stringify(g)))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    return { users, groups }
  }

  return {
    record, recordUser, recordGroup,
    markUser, markGroup, markReplayed, removeUser, removeGroup,
    getUser, getGroup, list, file,
  }
}

/** 把用户 OpenID 追加到 qqAllowFrom；已在名单（或是所有者）时返回 null。 */
export function appendAllowFrom(raw, userId, ownerId = '') {
  const id = String(userId ?? '').trim()
  if (!isOpenId(id)) throw Object.assign(new Error('用户 OpenID 无效（应为 QQ 开放平台 OpenID）'), { status: 400 })
  const ids = parseOpenIds(raw)
  if (id === String(ownerId ?? '').trim() || ids.includes(id)) return null
  return [...ids, id].join(', ')
}

/** 把群 OpenID 追加到 qqGroupIds；已在名单时返回 null。 */
export function appendGroupIds(raw, groupId) {
  const id = String(groupId ?? '').trim()
  if (!isOpenId(id)) throw Object.assign(new Error('群 OpenID 无效（应为官方 group_openid）'), { status: 400 })
  const ids = parseOpenIds(raw)
  if (ids.includes(id)) return null
  const base = String(raw ?? '')
  const sep = base.includes('\n') ? '\n' : (base.trim() ? ', ' : '')
  return (base.trim() ? base.trimEnd() + sep : '') + id
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
 *   GET  /qq/pending
 *   POST /qq/pending/dm/:userId/authorize|ignore|remove
 *   POST /qq/pending/group/:groupId/authorize|ignore|remove
 *
 * @param {{
 *   store,
 *   getConfig: () => object,
 *   saveAllowFrom: (raw: string) => Promise<void>,
 *   saveGroupAllow: (patch: { groupIds: string, groupPolicy?: string }) => Promise<void>,
 *   replayAuthorized?: (info: object) => Promise<unknown>,
 * }} deps
 */
export function createQQPendingApi({ store, getConfig, saveAllowFrom, saveGroupAllow, replayAuthorized }) {
  async function payload() {
    const cfg = getConfig() || {}
    const { users, groups } = await store.list()
    return {
      users,
      groups,
      ownerSet: !!String(cfg.qqOwnerOpenId ?? '').trim(),
      enabled: cfg.qqEnabled === true,
      allowFrom: String(cfg.qqAllowFrom ?? ''),
      groupIds: String(cfg.qqGroupIds ?? ''),
      groupPolicy: String(cfg.qqGroupPolicy ?? 'disabled'),
    }
  }

  async function maybeReplay(kind, rec) {
    if (typeof replayAuthorized !== 'function' || !rec) return
    if (rec.replayedAt) return
    const text = String(rec.lastText || rec.lastPreview || '').trim()
    if (!text) return
    const info = kind === 'group'
      ? {
          kind: 'group',
          groupId: rec.groupId,
          lastSenderId: rec.lastSenderId,
          lastSenderName: rec.lastSenderName,
          lastText: rec.lastText || rec.lastPreview,
          lastPreview: rec.lastPreview,
          lastMessageId: rec.lastMessageId,
          lastMentionedBot: rec.lastMentionedBot !== false,
          accountId: rec.accountId || 'main',
        }
      : {
          kind: 'dm',
          userId: rec.userId,
          name: rec.name,
          lastText: rec.lastText || rec.lastPreview,
          lastPreview: rec.lastPreview,
          lastMessageId: rec.lastMessageId,
          accountId: rec.accountId || 'main',
        }
    try {
      await replayAuthorized(info)
      if (typeof store.markReplayed === 'function') {
        await store.markReplayed(kind, kind === 'group' ? rec.groupId : rec.userId)
      }
    } catch {
      // 授权本身已成功；回放失败不回滚白名单
    }
  }

  async function authorizeDm(userId) {
    const u = await store.getUser(userId)
    if (!u) throw Object.assign(new Error('没有这个账号的私聊记录'), { status: 404 })
    const cfg = getConfig() || {}
    const owner = String(cfg.qqOwnerOpenId ?? '').trim()
    if (!owner) {
      throw Object.assign(new Error('请先填写「所有者 OpenID」。未填写时通道不会按本页写入私聊白名单，授权不会生效。'), { status: 409 })
    }
    if (typeof saveAllowFrom !== 'function') throw Object.assign(new Error('当前环境无法保存设置'), { status: 501 })
    const next = appendAllowFrom(cfg.qqAllowFrom, u.userId, owner)
    if (next !== null) await saveAllowFrom(next)
    const marked = await store.markUser(u.userId, 'authorized')
    await maybeReplay('dm', marked || u)
    return next === null ? String(cfg.qqAllowFrom ?? '') : next
  }

  async function authorizeGroup(groupId) {
    const g = await store.getGroup(groupId)
    if (!g) throw Object.assign(new Error('没有这个群的消息记录'), { status: 404 })
    const cfg = getConfig() || {}
    const owner = String(cfg.qqOwnerOpenId ?? '').trim()
    if (!owner) {
      throw Object.assign(new Error('请先填写「所有者 OpenID」。未填写时通道不会按本页写入群聊白名单，授权不会生效。'), { status: 409 })
    }
    if (typeof saveGroupAllow !== 'function') throw Object.assign(new Error('当前环境无法保存设置'), { status: 501 })
    const nextIds = appendGroupIds(cfg.qqGroupIds, g.groupId)
    const curPolicy = String(cfg.qqGroupPolicy ?? 'disabled')
    const nextPolicy = curPolicy === 'disabled' ? 'allowlist' : undefined
    const patch = {
      groupIds: nextIds === null ? String(cfg.qqGroupIds ?? '') : nextIds,
      ...(nextPolicy ? { groupPolicy: nextPolicy } : {}),
    }
    // 已在名单且策略已是 allowlist/open：仍标记 authorized，但可能无需写设置
    if (nextIds !== null || nextPolicy) await saveGroupAllow(patch)
    else if (curPolicy === 'open') {
      // open 下本不该进 pending；仍标记
    } else {
      // 已在 allowlist 名单：只改状态
    }
    const marked = await store.markGroup(g.groupId, 'authorized')
    await maybeReplay('group', marked || g)
    return {
      groupIds: patch.groupIds,
      groupPolicy: nextPolicy || curPolicy,
    }
  }

  async function handle(req, res, sub, { sendJson }) {
    if (sub !== '/qq/pending' && !sub.startsWith('/qq/pending/')) return false
    const fail = (status, error) => { sendJson(res, status, { ok: false, error }); return true }
    try {
      const refused = localOnlyRefusal(req)
      if (refused) return fail(403, refused)
      if (sub === '/qq/pending') {
        if (req.method !== 'GET') return fail(405, 'method not allowed')
        sendJson(res, 200, { ok: true, ...await payload() })
        return true
      }
      const dm = new RegExp(`^/qq/pending/dm/${OPENID_PATH}/(authorize|ignore|remove)$`).exec(sub)
      const grp = new RegExp(`^/qq/pending/group/${OPENID_PATH}/(authorize|ignore|remove)$`).exec(sub)
      if (!dm && !grp) return fail(404, 'not found')
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      if (dm) {
        const [, userId, action] = dm
        if (action === 'authorize') {
          const allowFrom = await authorizeDm(userId)
          sendJson(res, 200, { ok: true, ...await payload(), allowFrom })
          return true
        }
        if (action === 'ignore') {
          if (!await store.markUser(userId, 'ignored')) return fail(404, '没有这个账号的私聊记录')
        } else if (!await store.removeUser(userId)) return fail(404, '没有这个账号的私聊记录')
        sendJson(res, 200, { ok: true, ...await payload() })
        return true
      }
      const [, groupId, action] = grp
      if (action === 'authorize') {
        const got = await authorizeGroup(groupId)
        sendJson(res, 200, { ok: true, ...await payload(), groupIds: got.groupIds, groupPolicy: got.groupPolicy })
        return true
      }
      if (action === 'ignore') {
        if (!await store.markGroup(groupId, 'ignored')) return fail(404, '没有这个群的消息记录')
      } else if (!await store.removeGroup(groupId)) return fail(404, '没有这个群的消息记录')
      sendJson(res, 200, { ok: true, ...await payload() })
      return true
    } catch (error) {
      return fail(error?.status || 400, String(error?.message || error))
    }
  }

  return { handle, authorizeDm, authorizeGroup, payload }
}
