import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dmSenderOf, effectiveDmAllow, isUnauthorizedDm, noteDmDiscover, previewOf, setDmDiscoverHandler,
} from '../../telegram/dm-discover.mjs'
import { appendAllowFrom, createDmPending, createDmPendingApi, localOnlyRefusal } from './dm-pending.mjs'
import { createTelegramChannel } from './index.mjs'
import { buildAccessPolicy } from './runtime.mjs'
import { createOwnerGate, resolveAuthorizedIds } from './owner-gate.mjs'
import { InboundAccessController } from '../../../vendor/wsz987/channel-harness/lib/access/controller.js'
import { parseGroupCommand } from '../../chatroom/telegram-bots.mjs'

const OWNER = '9000000001'
const STRANGER = '7000000001'
const here = dirname(fileURLToPath(import.meta.url))

function dm(from, text, extra = {}) {
  return { update_id: 1, message: { message_id: 5, date: 1760000000, chat: { id: from.id, type: 'private' }, from, text, ...extra } }
}
const stranger = { id: Number(STRANGER), is_bot: false, first_name: '张', last_name: '三', username: 'zhangsan' }

async function tmpFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dm-pending-'))
  return { dir, file: join(dir, 'telegram', 'dm-pending.json') }
}

function fakeRes() {
  const out = { status: 0, body: null }
  return { out, sendJson: (_res, status, body) => { out.status = status; out.body = body } }
}
function req(method, extra = {}) {
  return { method, headers: { 'sec-fetch-site': 'same-origin', ...(extra.headers || {}) }, socket: { remoteAddress: extra.addr ?? '127.0.0.1' } }
}

test('dmSenderOf: private messages only, skips bots and groups; preview truncated', () => {
  const s = dmSenderOf(dm(stranger, '你好'.repeat(60)))
  assert.equal(s.userId, STRANGER)
  assert.equal(s.username, 'zhangsan')
  assert.equal(s.name, '张 三')
  assert.ok(s.preview.length <= 80 && s.preview.endsWith('…'))
  assert.equal(dmSenderOf({ message: { chat: { id: -100123, type: 'supergroup' }, from: stranger, text: 'x' } }), null)
  assert.equal(dmSenderOf(dm({ id: 42, is_bot: true, first_name: 'bot' }, 'x')), null)
  assert.equal(dmSenderOf({ callback_query: { from: stranger } }), null)
  assert.equal(previewOf({ photo: [{}], caption: '看图' }), '[图片] 看图')
  assert.equal(previewOf({ sticker: {} }), '[贴纸]')
  assert.equal(previewOf({}), '[其他消息]')
})

test('effectiveDmAllow / isUnauthorizedDm follow the card (owner + allowFrom) or the stored allowlist policy', () => {
  assert.deepEqual(effectiveDmAllow({ telegramOwnerId: OWNER, telegramAllowFrom: '1, 2 1' }), [OWNER, '1', '2'])
  assert.deepEqual(effectiveDmAllow({ telegramOwnerId: '' }, { state: 'ok', dmPolicy: 'allowlist', allowFrom: ['9'] }), ['9'])
  assert.equal(effectiveDmAllow({ telegramOwnerId: '' }, { state: 'ok', dmPolicy: 'open', allowFrom: [] }), null)
  assert.equal(effectiveDmAllow({}, { state: 'missing' }), null)
  assert.equal(isUnauthorizedDm({ userId: STRANGER }, [OWNER]), true)
  assert.equal(isUnauthorizedDm({ userId: OWNER }, [OWNER]), false)
  assert.equal(isUnauthorizedDm({ userId: STRANGER }, null), false) // 不按白名单时不做发现
})

test('store: one record per user id, counts messages, merges bots; fresh only on first sight', async () => {
  const { dir, file } = await tmpFile()
  try {
    const st = createDmPending(file)
    const a = await st.record({ ...dmSenderOf(dm(stranger, '第一条')), accountId: 'main', botName: '主机器人' })
    assert.equal(a.fresh, true)
    const b = await st.record({ ...dmSenderOf(dm(stranger, '第二条')), accountId: 'chatgpt', botName: 'GPT' })
    assert.equal(b.fresh, false)
    const list = await st.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].count, 2)
    assert.equal(list[0].status, 'new')
    assert.equal(list[0].lastPreview, '第二条')
    assert.equal(list[0].lastBotName, 'GPT')
    assert.deepEqual(list[0].botIds.sort(), ['chatgpt', 'main'])
    // 持久化：新实例读到同一份
    assert.equal((await createDmPending(file).list())[0].userId, STRANGER)
    assert.ok(JSON.parse(await readFile(file, 'utf8')).users[STRANGER])
    assert.deepEqual((await readdir(dirname(file))).sort(), ['dm-pending.json']) // 无残留 .tmp
    // 非法 ID 不记录
    assert.equal(await st.record({ userId: 'abc' }), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('store: ignored stays ignored on new messages; an authorized user seen again (allowlist edited) is reopened', async () => {
  const { dir, file } = await tmpFile()
  try {
    const st = createDmPending(file)
    await st.record({ userId: STRANGER, preview: 'a', accountId: 'main' })
    await st.mark(STRANGER, 'ignored')
    const again = await st.record({ userId: STRANGER, preview: 'b', accountId: 'main' })
    assert.equal(again.fresh, false)
    assert.equal(again.user.status, 'ignored')
    assert.equal(again.user.count, 2)
    await st.mark(STRANGER, 'authorized')
    const back = await st.record({ userId: STRANGER, preview: 'c', accountId: 'main' })
    assert.equal(back.fresh, true)
    assert.equal(back.user.status, 'new')
    assert.equal(back.user.count, 1)
    assert.equal(await st.remove(STRANGER), true)
    assert.deepEqual(await st.list(), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('store: capped, dropping handled records before pending ones', async () => {
  const { dir, file } = await tmpFile()
  try {
    const st = createDmPending(file, { max: 3 })
    await st.record({ userId: '101' }); await st.mark('101', 'ignored')
    await st.record({ userId: '102' })
    await st.record({ userId: '103' })
    await st.record({ userId: '104' })
    const ids = (await st.list()).map((u) => u.userId).sort()
    assert.deepEqual(ids, ['102', '103', '104'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('appendAllowFrom: appends once, never duplicates the owner', () => {
  assert.equal(appendAllowFrom('', STRANGER, OWNER), STRANGER)
  assert.equal(appendAllowFrom('1，2', STRANGER, OWNER), `1, 2, ${STRANGER}`)
  assert.equal(appendAllowFrom(`1 ${STRANGER}`, STRANGER, OWNER), null)
  assert.equal(appendAllowFrom('', OWNER, OWNER), null)
  assert.throws(() => appendAllowFrom('', '-100123', OWNER))
})

function apiFixture(file, cfg) {
  const st = createDmPending(file)
  const saved = []
  const api = createDmPendingApi({
    store: st,
    getConfig: () => cfg,
    saveAllowFrom: async (raw) => { saved.push(raw); cfg.telegramAllowFrom = raw },
    botLabels: async () => ({ main: '主机器人（@ds_bot）' }),
  })
  return { st, saved, api, cfg }
}

test('API: authorize adds the user to the same allowlist the access policy is built from; ignore and remove', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, saved, api, cfg } = apiFixture(file, { telegramOwnerId: OWNER, telegramAllowFrom: '123', telegramEnabled: true })
    await st.record({ userId: STRANGER, username: 'zhangsan', accountId: 'main', botName: '主机器人' })
    await st.record({ userId: '7000000002', accountId: 'main' })
    let r = fakeRes()
    await api.handle(req('GET'), null, '/telegram/dm-pending', r)
    assert.equal(r.out.status, 200)
    assert.equal(r.out.body.users.length, 2)
    assert.equal(r.out.body.users.find((u) => u.userId === STRANGER).lastBotLabel, '主机器人（@ds_bot）')
    assert.equal(r.out.body.ownerSet, true)

    r = fakeRes()
    await api.handle(req('POST'), null, `/telegram/dm-pending/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 200, JSON.stringify(r.out.body))
    assert.deepEqual(saved, [`123, ${STRANGER}`])
    assert.equal(r.out.body.allowFrom, `123, ${STRANGER}`)
    assert.equal((await st.get(STRANGER)).status, 'authorized')
    // 访问策略按卡片生成：该用户的私聊被放行
    const policy = buildAccessPolicy(null, cfg.telegramOwnerId, cfg.telegramAllowFrom, { policy: 'disabled' })
    assert.ok(policy.allowFrom.includes(STRANGER))
    const ac = new InboundAccessController()
    assert.equal(ac.authorize({ conversationType: 'dm', senderId: STRANGER, conversationId: STRANGER, policy }).authorized, true)
    assert.equal(ac.authorize({ conversationType: 'dm', senderId: '7000000002', conversationId: '7000000002', policy }).reason, 'user_not_allowed')
    // 再授权一次不重复写
    r = fakeRes()
    await api.handle(req('POST'), null, `/telegram/dm-pending/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 200)
    assert.equal(saved.length, 1)

    r = fakeRes()
    await api.handle(req('POST'), null, '/telegram/dm-pending/7000000002/ignore', r)
    assert.equal(r.out.status, 200)
    assert.equal((await st.get('7000000002')).status, 'ignored')
    assert.equal(saved.length, 1) // 忽略不改白名单

    r = fakeRes()
    await api.handle(req('POST'), null, '/telegram/dm-pending/7000000002/remove', r)
    assert.equal(r.out.status, 200)
    assert.equal(await st.get('7000000002'), null)

    r = fakeRes()
    await api.handle(req('POST'), null, '/telegram/dm-pending/7999999999/authorize', r)
    assert.equal(r.out.status, 404) // 只能授权名单里出现过的账号
    assert.equal(saved.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: authorizing never grants computer-changing tools (owner gate is by sender id, separate list)', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, api, cfg } = apiFixture(file, { telegramOwnerId: OWNER, telegramAllowFrom: '', telegramAuthorizedIds: '' })
    await st.record({ userId: STRANGER, accountId: 'main' })
    const r = fakeRes()
    await api.handle(req('POST'), null, `/telegram/dm-pending/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 200)
    assert.equal(cfg.telegramAuthorizedIds, '')
    const ids = resolveAuthorizedIds(cfg.telegramAuthorizedIds, cfg.telegramOwnerId)
    assert.deepEqual(ids, [OWNER])
    const gate = createOwnerGate({ authorized: ids })
    gate.noteTurn('s1', STRANGER)
    assert.ok(gate.check({ agent: { id: 's1' }, name: 'run_command' }))
    gate.noteTurn('s2', OWNER)
    assert.equal(gate.check({ agent: { id: 's2' }, name: 'run_command' }), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: local-only (cross-site / same-site / non-loopback refused) and owner required', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, saved, api } = apiFixture(file, { telegramOwnerId: '', telegramAllowFrom: '' })
    await st.record({ userId: STRANGER, accountId: 'main' })
    for (const bad of [req('POST', { headers: { 'sec-fetch-site': 'cross-site' } }), req('POST', { headers: { 'sec-fetch-site': 'same-site' } }), req('POST', { addr: '192.168.1.20' }), req('GET', { addr: '10.0.0.2' })]) {
      const r = fakeRes()
      await api.handle(bad, null, `/telegram/dm-pending/${STRANGER}/authorize`, r)
      assert.equal(r.out.status, 403)
    }
    assert.equal(localOnlyRefusal(req('POST', { addr: '::ffff:127.0.0.1' })), null)
    assert.equal(localOnlyRefusal({ method: 'POST', headers: {} }), null)
    const r = fakeRes()
    await api.handle(req('POST'), null, `/telegram/dm-pending/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 409) // 未填所有者：白名单不会写入策略，拒绝
    assert.equal(saved.length, 0)
    const g = fakeRes()
    await api.handle(req('GET'), null, `/telegram/dm-pending/${STRANGER}/authorize`, g)
    assert.equal(g.out.status, 405)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('channel bridge: unauthorized DM recorded via globalThis handler; allowed users skipped; a chat command cannot authorize', async () => {
  const { dir, file } = await tmpFile()
  const cfg = { telegramEnabled: false, telegramOwnerId: OWNER, telegramAllowFrom: '', telegramBots: [] }
  const saved = []
  const ch = createTelegramChannel({ logger: { warn() {}, info() {} } }, () => cfg, {
    dmPendingFile: file,
    saveAllowFrom: async (raw) => { saved.push(raw); cfg.telegramAllowFrom = raw },
  })
  try {
    // 通道运行时只调用 noteDmDiscover（另一个打包里），这里模拟它
    for (const text of ['/auth', '/allow ' + STRANGER, '/start', '/bind abc confirm']) {
      const s = dmSenderOf(dm(stranger, text))
      assert.equal(isUnauthorizedDm(s, effectiveDmAllow(cfg)), true)
      assert.equal(await noteDmDiscover({ ...s, accountId: 'main', botName: '主机器人' }), true)
    }
    assert.equal(await noteDmDiscover({ ...dmSenderOf(dm({ id: Number(OWNER), first_name: 'Shiro' }, 'hi')), accountId: 'main' }), true)
    const r = fakeRes()
    await ch.handleDmApi(req('GET'), null, '/telegram/dm-pending', r)
    assert.equal(r.out.status, 200)
    assert.deepEqual(r.out.body.users.map((u) => u.userId), [STRANGER]) // 所有者不记录
    assert.equal(r.out.body.users[0].count, 4) // 每条消息计数，但只有一条记录
    assert.equal(r.out.body.users[0].status, 'new')
    assert.deepEqual(saved, []) // 任何聊天指令都没有改白名单
    assert.equal(cfg.telegramAllowFrom, '')
    // 只有设置页接口能授权
    const a = fakeRes()
    await ch.handleDmApi(req('POST'), null, `/telegram/dm-pending/${STRANGER}/authorize`, a)
    assert.equal(a.out.status, 200, JSON.stringify(a.out.body))
    assert.deepEqual(saved, [STRANGER])
    // 授权后、通道重启前到达的消息不再记录
    await noteDmDiscover({ userId: STRANGER, accountId: 'main' })
    const b = fakeRes()
    await ch.handleDmApi(req('GET'), null, '/telegram/dm-pending', b)
    assert.equal(b.out.body.users[0].status, 'authorized')
  } finally {
    await ch.dispose()
    assert.equal(await noteDmDiscover({ userId: STRANGER }), false) // dispose 注销桥
    await rm(dir, { recursive: true, force: true })
  }
})

test('no command-based authorize path: channel commands and chatroom group commands have nothing that touches the allowlist', async () => {
  // vendor 通道指令（全部在访问闸门之后，未授权账号根本到不了）
  const cmdDir = join(here, '../../../vendor/wsz987/channel-harness/lib/commands')
  const names = []
  for (const f of await readdir(cmdDir)) {
    if (!f.endsWith('.js')) continue
    const src = await readFile(join(cmdDir, f), 'utf8')
    for (const m of src.matchAll(/\bname:\s*'([a-z-]+)'/g)) names.push(m[1])
    assert.doesNotMatch(src, /allowFrom|accessPolicy|telegramAllowFrom|dm-pending/, `${f} must not touch the allowlist`)
  }
  assert.deepEqual(names.sort(), ['bind', 'help', 'mirror', 'model', 'models', 'new', 'status', 'stop', 'version'])
  for (const n of names) assert.doesNotMatch(n, /auth|allow|approve|grant|pair|whitelist|trust/)
  // 聊天室群内指令只有 /bind /unbind
  for (const t of ['/auth', '/allow 1', '/authorize', '/approve 1', '/grant', '/whitelist 1']) assert.equal(parseGroupCommand(t), null)
  assert.equal(parseGroupCommand('/bind').cmd, 'bind')
  // 只有设置页接口会调用 saveAllowFrom；仓库源码里没有别处写「允许的其他用户 ID」
  const srcRoot = join(here, '../..')
  const writers = []
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'components' && e.name !== 'node_modules') await walk(p); continue }
      if (!e.name.endsWith('.mjs') || e.name.endsWith('.test.mjs')) continue
      const src = await readFile(p, 'utf8')
      if (/telegramAllowFrom\s*:/.test(src) || /saveAllowFrom\s*\(/.test(src)) writers.push(p.slice(srcRoot.length + 1).replace(/\\/g, '/'))
    }
  }
  await walk(srcRoot)
  assert.deepEqual(writers.sort(), ['channels/qq/index.mjs', 'channels/qq/pending.mjs', 'channels/telegram/dm-pending.mjs', 'channels/telegram/index.mjs', 'index.mjs'])
  const idx = await readFile(join(srcRoot, 'index.mjs'), 'utf8')
  assert.equal((idx.match(/telegramAllowFrom\s*:/g) || []).length, 1) // telegramSave.allowFrom（仅供设置页接口）
})

test('bridge handler registration is exclusive and unregisters only itself', async () => {
  const seen = []
  const off1 = setDmDiscoverHandler((i) => { seen.push(['a', i.userId]) })
  const off2 = setDmDiscoverHandler((i) => { seen.push(['b', i.userId]) })
  off1() // 不是当前处理函数，不注销
  assert.equal(await noteDmDiscover({ userId: '1' }), true)
  off2()
  assert.equal(await noteDmDiscover({ userId: '2' }), false)
  assert.deepEqual(seen, [['b', '1']])
})
