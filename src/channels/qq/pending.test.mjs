import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  buildReplayEvent, effectiveDmAllow, effectiveGroupDiscover, isOpenId, isUnauthorizedDm, isUnauthorizedGroup,
  notePendingDiscover, parseOpenIds, pendingInfoOfEvent, previewOfEvent, setPendingDiscoverHandler, textOfEvent,
} from '../../qq/pending-discover.mjs'
import {
  appendAllowFrom, appendGroupIds, createQQPending, createQQPendingApi, localOnlyRefusal,
} from './pending.mjs'

const OWNER = 'a1b2c3d4e5f6789012345678abcdef01'
const STRANGER = 'f1e2d3c4b5a69876543210fedcba0987'
const GROUP_A = '11223344556677889900aabbccddeeff'
const GROUP_B = 'ffeeddccbbaa00998877665544332211'

async function tmpFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-pending-'))
  return { dir, file: join(dir, 'qq', 'pending.json') }
}

function fakeRes() {
  const out = { status: 0, body: null }
  return { out, sendJson: (_res, status, body) => { out.status = status; out.body = body } }
}
function req(method, extra = {}) {
  return {
    method,
    headers: { 'sec-fetch-site': 'same-origin', ...(extra.headers || {}) },
    socket: { remoteAddress: extra.addr ?? '127.0.0.1' },
  }
}

function dmEvent(senderId, text, name = '') {
  return {
    type: 'message.received',
    accountId: 'main',
    conversation: { id: senderId, type: 'dm' },
    sender: { id: senderId, name },
    message: { content: [{ type: 'text', text }] },
  }
}
function groupEvent(groupId, senderId, text, name = '') {
  return {
    type: 'message.received',
    accountId: 'main',
    conversation: { id: groupId, type: 'group' },
    sender: { id: senderId, name },
    message: { content: [{ type: 'text', text }] },
  }
}

test('isOpenId / parseOpenIds: QQ opaque OpenIDs, not Telegram numeric IDs', () => {
  assert.equal(isOpenId(OWNER), true)
  assert.equal(isOpenId(GROUP_A), true)
  assert.equal(isOpenId('short'), false)
  assert.equal(isOpenId('7000000001'), true) // length ok but we do not require hex-only
  assert.equal(isOpenId('bad id!'), false)
  assert.equal(isOpenId(''), false)
  assert.deepEqual(parseOpenIds(` ${OWNER}，${STRANGER}; ${OWNER} `), [OWNER, STRANGER])
})

test('effectiveDmAllow / isUnauthorizedDm follow owner + allowFrom or stored allowlist', () => {
  assert.deepEqual(
    effectiveDmAllow({ qqOwnerOpenId: OWNER, qqAllowFrom: `${STRANGER}, ${OWNER}` }),
    [OWNER, STRANGER],
  )
  assert.deepEqual(
    effectiveDmAllow({ qqOwnerOpenId: '' }, { state: 'ok', dmPolicy: 'allowlist', allowFrom: ['x'] }),
    ['x'],
  )
  assert.equal(effectiveDmAllow({ qqOwnerOpenId: '' }, { state: 'ok', dmPolicy: 'open', allowFrom: [] }), null)
  assert.equal(isUnauthorizedDm(STRANGER, [OWNER]), true)
  assert.equal(isUnauthorizedDm(OWNER, [OWNER]), false)
  assert.equal(isUnauthorizedDm(STRANGER, null), false)
})

test('effectiveGroupDiscover / isUnauthorizedGroup: disabled still discovers; open does not', () => {
  assert.deepEqual(effectiveGroupDiscover({ qqGroupPolicy: 'disabled' }), { policy: 'disabled', ids: [] })
  assert.deepEqual(
    effectiveGroupDiscover({ qqGroupPolicy: 'allowlist', qqGroupIds: GROUP_A }),
    { policy: 'allowlist', ids: [GROUP_A] },
  )
  assert.equal(isUnauthorizedGroup(GROUP_B, { policy: 'open', ids: [] }), false)
  assert.equal(isUnauthorizedGroup(GROUP_B, { policy: 'disabled', ids: [] }), true)
  assert.equal(isUnauthorizedGroup(GROUP_A, { policy: 'allowlist', ids: [GROUP_A] }), false)
  assert.equal(isUnauthorizedGroup(GROUP_B, { policy: 'allowlist', ids: [GROUP_A] }), true)
  assert.equal(isUnauthorizedGroup('bad', { policy: 'disabled', ids: [] }), false)
})

test('pendingInfoOfEvent + previewOfEvent for dm and group', () => {
  const dmAllow = [OWNER]
  const groupDiscover = { policy: 'allowlist', ids: [GROUP_A] }
  const dm = pendingInfoOfEvent(dmEvent(STRANGER, '你好'.repeat(60), '张三'), { dmAllow, groupDiscover })
  assert.equal(dm.kind, 'dm')
  assert.equal(dm.userId, STRANGER)
  assert.equal(dm.name, '张三')
  assert.ok(dm.preview.length <= 80 && dm.preview.endsWith('…'))
  assert.equal(pendingInfoOfEvent(dmEvent(OWNER, 'hi'), { dmAllow, groupDiscover }), null)

  const g = pendingInfoOfEvent(groupEvent(GROUP_B, STRANGER, '群消息', '李四'), { dmAllow, groupDiscover })
  assert.equal(g.kind, 'group')
  assert.equal(g.groupId, GROUP_B)
  assert.equal(g.lastSenderId, STRANGER)
  assert.equal(g.lastSenderName, '李四')
  assert.equal(g.text, '群消息')
  assert.equal(g.messageId, '')
  assert.equal(g.mentionedBot, false)
  assert.equal(pendingInfoOfEvent(groupEvent(GROUP_A, STRANGER, 'x'), { dmAllow, groupDiscover }), null)

  assert.equal(previewOfEvent({ message: { content: [{ type: 'image' }] } }), '[图片]')
  assert.equal(previewOfEvent({ message: { content: [] } }), '[其他消息]')
  assert.equal(textOfEvent({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb')
})

test('discover bridge: notePendingDiscover calls registered handler; never throws', async () => {
  const seen = []
  const off = setPendingDiscoverHandler(async (info) => { seen.push(info) })
  assert.equal(await notePendingDiscover({ kind: 'dm', userId: STRANGER }), true)
  assert.equal(seen.length, 1)
  off()
  assert.equal(await notePendingDiscover({ kind: 'dm', userId: STRANGER }), false)
  setPendingDiscoverHandler(async () => { throw new Error('boom') })
  assert.equal(await notePendingDiscover({ kind: 'dm', userId: STRANGER }), false)
  setPendingDiscoverHandler(null)
})

test('store: one record per OpenID; count merges; fresh only on first / re-open', async () => {
  const { dir, file } = await tmpFile()
  try {
    const st = createQQPending(file)
    const a = await st.record({ kind: 'dm', userId: STRANGER, name: '张三', preview: '第一条' })
    assert.equal(a.fresh, true)
    assert.equal(a.kind, 'dm')
    const b = await st.record({ kind: 'dm', userId: STRANGER, preview: '第二条' })
    assert.equal(b.fresh, false)
    assert.equal(b.user.count, 2)
    assert.equal(b.user.lastPreview, '第二条')
    const list = await st.list()
    assert.equal(list.users.length, 1)
    assert.equal(list.groups.length, 0)
    assert.ok(JSON.parse(await readFile(file, 'utf8')).users[STRANGER])
    assert.deepEqual((await readdir(dirname(file))).sort(), ['pending.json'])
    assert.equal(await st.record({ kind: 'dm', userId: 'bad!' }), null)

    const g = await st.record({
      kind: 'group', groupId: GROUP_A, preview: '群一', lastSenderId: STRANGER, lastSenderName: '张三',
    })
    assert.equal(g.fresh, true)
    assert.equal(g.kind, 'group')
    assert.equal((await st.list()).groups.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('store: ignored stays ignored; authorized reopens; remove works for dm and group', async () => {
  const { dir, file } = await tmpFile()
  try {
    const st = createQQPending(file)
    await st.record({ kind: 'dm', userId: STRANGER, preview: 'a' })
    await st.markUser(STRANGER, 'ignored')
    const again = await st.record({ kind: 'dm', userId: STRANGER, preview: 'b' })
    assert.equal(again.fresh, false)
    assert.equal(again.user.status, 'ignored')
    await st.markUser(STRANGER, 'authorized')
    const back = await st.record({ kind: 'dm', userId: STRANGER, preview: 'c' })
    assert.equal(back.fresh, true)
    assert.equal(back.user.status, 'new')
    assert.equal(await st.removeUser(STRANGER), true)

    await st.record({ kind: 'group', groupId: GROUP_A, preview: 'g' })
    await st.markGroup(GROUP_A, 'ignored')
    const g2 = await st.record({ kind: 'group', groupId: GROUP_A, preview: 'g2' })
    assert.equal(g2.group.status, 'ignored')
    assert.equal(await st.removeGroup(GROUP_A), true)
    assert.deepEqual(await st.list(), { users: [], groups: [] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('store: trim drops handled before pending (users and groups separately)', async () => {
  const { dir, file } = await tmpFile()
  try {
    const st = createQQPending(file, { max: 3 })
    const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']
    await st.record({ kind: 'dm', userId: ids[0] }); await st.markUser(ids[0], 'ignored')
    await st.record({ kind: 'dm', userId: ids[1] })
    await st.record({ kind: 'dm', userId: ids[2] })
    await st.record({ kind: 'dm', userId: ids[3] })
    assert.deepEqual((await st.list()).users.map((u) => u.userId).sort(), [ids[1], ids[2], ids[3]].sort())

    const gids = ['g0000001', 'g0000002', 'g0000003', 'g0000004']
    await st.record({ kind: 'group', groupId: gids[0] }); await st.markGroup(gids[0], 'ignored')
    await st.record({ kind: 'group', groupId: gids[1] })
    await st.record({ kind: 'group', groupId: gids[2] })
    await st.record({ kind: 'group', groupId: gids[3] })
    assert.deepEqual((await st.list()).groups.map((g) => g.groupId).sort(), [gids[1], gids[2], gids[3]].sort())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('appendAllowFrom / appendGroupIds: append once; reject bad OpenID', () => {
  assert.equal(appendAllowFrom('', STRANGER, OWNER), STRANGER)
  assert.equal(appendAllowFrom(`${OWNER.slice(0, 8)}xx`, STRANGER, OWNER), `${OWNER.slice(0, 8)}xx, ${STRANGER}`)
  // Need valid openids of length >= 8 — use full
  assert.equal(appendAllowFrom('abcdefgh', STRANGER, OWNER), `abcdefgh, ${STRANGER}`)
  assert.equal(appendAllowFrom(`abcdefgh ${STRANGER}`, STRANGER, OWNER), null)
  assert.equal(appendAllowFrom('', OWNER, OWNER), null)
  assert.throws(() => appendAllowFrom('', 'bad!', OWNER))

  assert.equal(appendGroupIds('', GROUP_A), GROUP_A)
  assert.equal(appendGroupIds(GROUP_A, GROUP_A), null)
  assert.equal(appendGroupIds(`${GROUP_A}\n`, GROUP_B), `${GROUP_A}\n${GROUP_B}`)
  assert.throws(() => appendGroupIds('', '!!'))
})

function apiFixture(file, cfg) {
  const st = createQQPending(file)
  const savedAllow = []
  const savedGroup = []
  const api = createQQPendingApi({
    store: st,
    getConfig: () => cfg,
    saveAllowFrom: async (raw) => { savedAllow.push(raw); cfg.qqAllowFrom = raw },
    saveGroupAllow: async (patch) => {
      savedGroup.push(patch)
      if (typeof patch.groupIds === 'string') cfg.qqGroupIds = patch.groupIds
      if (typeof patch.groupPolicy === 'string') cfg.qqGroupPolicy = patch.groupPolicy
    },
  })
  return { st, savedAllow, savedGroup, api, cfg }
}

test('API: authorize DM appends qqAllowFrom; ignore/remove; owner required (409)', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, savedAllow, api, cfg } = apiFixture(file, {
      qqOwnerOpenId: OWNER, qqAllowFrom: 'abcdefgh', qqEnabled: true, qqGroupPolicy: 'disabled', qqGroupIds: '',
    })
    await st.record({ kind: 'dm', userId: STRANGER, name: '张三' })
    await st.record({ kind: 'dm', userId: 'bbbbbbbbccccccccddddddddeeeeeeee' })

    let r = fakeRes()
    await api.handle(req('GET'), null, '/qq/pending', r)
    assert.equal(r.out.status, 200)
    assert.equal(r.out.body.users.length, 2)
    assert.equal(r.out.body.ownerSet, true)
    assert.equal(r.out.body.groupPolicy, 'disabled')

    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/dm/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 200, JSON.stringify(r.out.body))
    assert.deepEqual(savedAllow, [`abcdefgh, ${STRANGER}`])
    assert.equal(r.out.body.allowFrom, `abcdefgh, ${STRANGER}`)
    assert.equal((await st.getUser(STRANGER)).status, 'authorized')

    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/dm/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 200)
    assert.equal(savedAllow.length, 1)

    r = fakeRes()
    await api.handle(req('POST'), null, '/qq/pending/dm/bbbbbbbbccccccccddddddddeeeeeeee/ignore', r)
    assert.equal(r.out.status, 200)
    assert.equal((await st.getUser('bbbbbbbbccccccccddddddddeeeeeeee')).status, 'ignored')
    assert.equal(savedAllow.length, 1)

    r = fakeRes()
    await api.handle(req('POST'), null, '/qq/pending/dm/bbbbbbbbccccccccddddddddeeeeeeee/remove', r)
    assert.equal(r.out.status, 200)
    assert.equal(await st.getUser('bbbbbbbbccccccccddddddddeeeeeeee'), null)

    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/dm/${'c'.repeat(32)}/authorize`, r)
    assert.equal(r.out.status, 404)

    // owner missing → 409
    cfg.qqOwnerOpenId = ''
    await st.record({ kind: 'dm', userId: STRANGER })
    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/dm/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 409)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: authorize group appends qqGroupIds and flips disabled → allowlist', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, savedGroup, api, cfg } = apiFixture(file, {
      qqOwnerOpenId: OWNER, qqAllowFrom: '', qqEnabled: true, qqGroupPolicy: 'disabled', qqGroupIds: '',
    })
    await st.record({ kind: 'group', groupId: GROUP_A, preview: 'hi', lastSenderId: STRANGER })

    let r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/group/${GROUP_A}/authorize`, r)
    assert.equal(r.out.status, 200, JSON.stringify(r.out.body))
    assert.equal(savedGroup.length, 1)
    assert.equal(savedGroup[0].groupIds, GROUP_A)
    assert.equal(savedGroup[0].groupPolicy, 'allowlist')
    assert.equal(cfg.qqGroupPolicy, 'allowlist')
    assert.equal(cfg.qqGroupIds, GROUP_A)
    assert.equal(r.out.body.groupPolicy, 'allowlist')
    assert.equal((await st.getGroup(GROUP_A)).status, 'authorized')

    // second authorize while already on allowlist: no duplicate write if already in list
    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/group/${GROUP_A}/authorize`, r)
    assert.equal(r.out.status, 200)
    assert.equal(savedGroup.length, 1)

    await st.record({ kind: 'group', groupId: GROUP_B, preview: 'other' })
    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/group/${GROUP_B}/ignore`, r)
    assert.equal(r.out.status, 200)
    assert.equal((await st.getGroup(GROUP_B)).status, 'ignored')
    assert.equal(savedGroup.length, 1)

    r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/group/${GROUP_B}/remove`, r)
    assert.equal(r.out.status, 200)
    assert.equal(await st.getGroup(GROUP_B), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: authorize group when already allowlist only appends id (no policy flip)', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, savedGroup, api } = apiFixture(file, {
      qqOwnerOpenId: OWNER, qqGroupPolicy: 'allowlist', qqGroupIds: GROUP_A,
    })
    await st.record({ kind: 'group', groupId: GROUP_B, preview: 'x' })
    const r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/group/${GROUP_B}/authorize`, r)
    assert.equal(r.out.status, 200)
    assert.equal(savedGroup[0].groupIds.includes(GROUP_B), true)
    assert.equal(savedGroup[0].groupPolicy, undefined)
    assert.equal(r.out.body.groupPolicy, 'allowlist')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: authorizing DM does not touch qqAuthorizedIds (computer-tool gate stays separate)', async () => {
  const { dir, file } = await tmpFile()
  try {
    const { st, api, cfg } = apiFixture(file, {
      qqOwnerOpenId: OWNER, qqAllowFrom: '', qqAuthorizedIds: '',
    })
    await st.record({ kind: 'dm', userId: STRANGER })
    const r = fakeRes()
    await api.handle(req('POST'), null, `/qq/pending/dm/${STRANGER}/authorize`, r)
    assert.equal(r.out.status, 200)
    assert.equal(cfg.qqAuthorizedIds, '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: localOnlyRefusal blocks cross-site and non-loopback', async () => {
  assert.equal(localOnlyRefusal(req('GET')), null)
  assert.equal(localOnlyRefusal(req('GET', { headers: { 'sec-fetch-site': 'cross-site' } })), 'cross-site request refused')
  assert.equal(localOnlyRefusal(req('GET', { addr: '8.8.8.8' })), '只能在本机的设置页操作')

  const { dir, file } = await tmpFile()
  try {
    const { api } = apiFixture(file, { qqOwnerOpenId: OWNER })
    const r = fakeRes()
    await api.handle(req('GET', { headers: { 'sec-fetch-site': 'cross-site' } }), null, '/qq/pending', r)
    assert.equal(r.out.status, 403)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('textOfEvent / buildReplayEvent: group AT message becomes harness event', () => {
  const info = {
    kind: 'group',
    groupId: GROUP_A,
    lastSenderId: STRANGER,
    lastSenderName: '李四',
    lastText: 'deepsleep',
    lastMessageId: 'msg-1',
    lastMentionedBot: true,
    accountId: 'main',
  }
  const ev = buildReplayEvent(info)
  assert.equal(ev.type, 'message.received')
  assert.equal(ev.channel, 'qq')
  assert.equal(ev.conversation.type, 'group')
  assert.equal(ev.conversation.id, GROUP_A)
  assert.equal(ev.sender.id, STRANGER)
  assert.equal(ev.message.id, 'msg-1')
  assert.equal(ev.message.content[0].text, 'deepsleep')
  assert.equal(ev.message.activation.mentionedBot, true)
  assert.equal(buildReplayEvent({ kind: 'group', groupId: GROUP_A }), null) // no sender/text
})

test('store: persists lastText/lastMessageId for authorize replay', async () => {
  const { dir, file } = await tmpFile()
  try {
    const store = createQQPending(file)
    await store.record({
      kind: 'group', groupId: GROUP_A, preview: 'deepsleep', text: 'deepsleep hello',
      messageId: 'm9', mentionedBot: true, lastSenderId: STRANGER, lastSenderName: 'Shiro', accountId: 'main',
    })
    const g = await store.getGroup(GROUP_A)
    assert.equal(g.lastText, 'deepsleep hello')
    assert.equal(g.lastMessageId, 'm9')
    assert.equal(g.lastMentionedBot, true)
    assert.equal(g.lastSenderId, STRANGER)
    await store.markGroup(GROUP_A, 'authorized')
    await store.markReplayed('group', GROUP_A)
    const g2 = await store.getGroup(GROUP_A)
    assert.ok(g2.replayedAt)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API: authorize group calls replayAuthorized with stored text after save', async () => {
  const { dir, file } = await tmpFile()
  try {
    const store = createQQPending(file)
    await store.record({
      kind: 'group', groupId: GROUP_A, preview: 'hi', text: 'hi @bot',
      messageId: 'mx', mentionedBot: true, lastSenderId: STRANGER, lastSenderName: 'A',
    })
    const seen = []
    let cfg = {
      qqOwnerOpenId: OWNER, qqEnabled: true, qqAllowFrom: '',
      qqGroupIds: '', qqGroupPolicy: 'disabled',
    }
    const api = createQQPendingApi({
      store,
      getConfig: () => cfg,
      saveAllowFrom: async () => {},
      saveGroupAllow: async (patch) => {
        cfg = { ...cfg, qqGroupIds: patch.groupIds, ...(patch.groupPolicy ? { qqGroupPolicy: patch.groupPolicy } : {}) }
      },
      replayAuthorized: async (info) => { seen.push(info) },
    })
    const { out, sendJson } = fakeRes()
    await api.handle(req('POST'), {}, `/qq/pending/group/${GROUP_A}/authorize`, { sendJson })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].kind, 'group')
    assert.equal(seen[0].groupId, GROUP_A)
    assert.equal(seen[0].lastText, 'hi @bot')
    assert.equal(seen[0].lastMessageId, 'mx')
    const g = await store.getGroup(GROUP_A)
    assert.equal(g.status, 'authorized')
    assert.ok(g.replayedAt)
    // second authorize: no double replay
    seen.length = 0
    await api.handle(req('POST'), {}, `/qq/pending/group/${GROUP_A}/authorize`, { sendJson })
    assert.equal(seen.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
