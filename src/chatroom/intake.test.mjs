import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  receiverFor, firstMentionedSeat, replyTargetSeat, utf16Slice,
  createDedupe, notInGroupNotice, createMemberCache, seatBotIndex,
  botNotRunningNotice, memberStateOf,
} from './intake.mjs'
import { createTelegramBots, memberFetchers } from './telegram-bots.mjs'
import { resolveSeats } from './seats.mjs'
import { classifyDestination, extractChatFromUpdate } from '../telegram/dispatch.mjs'
import { createRawHub, tokenHash } from '../telegram/raw-hub.mjs'
import { claimPollingToken, channelOwnsToken, releaseAll, resetPollingOwners } from '../telegram/polling-owners.mjs'

const seats = [
  { id: 'deepseek', name: 'DeepSeek', enabled: true, telegram: { ingest: true, username: 'kujira_deepseek_bot' } },
  { id: 'claude', name: 'Claude', enabled: true, telegram: { ingest: false, username: 'claude_bot' } },
  { id: 'gpt', name: 'GPT', enabled: true, telegram: { ingest: false, username: 'gpt_bot' } },
]
const clients = {
  deepseek: { botId: 111, username: 'kujira_deepseek_bot' },
  claude: { botId: 222, username: 'claude_bot' },
  gpt: { botId: 333, username: 'gpt_bot' },
}

test('utf16Slice handles BMP and surrogate pairs like Telegram entities', () => {
  assert.equal(utf16Slice('你好世界', 0, 2), '你好')
  assert.equal(utf16Slice('a😀b', 1, 2), '😀') // emoji = 2 UTF-16 units
})

test('receiverFor: default primary ingest; mention switches; first mention wins; non-member ignored', () => {
  const primary = receiverFor({ text: 'hello' }, seats, clients)
  assert.equal(primary.seat.id, 'deepseek')
  assert.equal(primary.via, 'primary')
  assert.equal(primary.switchRequested, false)

  const text = '请 @claude_bot 看一下'
  const at = text.indexOf('@claude_bot')
  const mentioned = receiverFor({
    text,
    entities: [{ type: 'mention', offset: at, length: '@claude_bot'.length }],
  }, seats, clients)
  assert.equal(mentioned.seat.id, 'claude')
  assert.equal(mentioned.via, 'mention')
  assert.equal(mentioned.switchRequested, true)

  const multi = '[@gpt_bot](/) then @claude_bot'
  // build with two mentions; first is gpt
  const t2 = '@gpt_bot 和 @claude_bot'
  const e2 = [
    { type: 'mention', offset: 0, length: '@gpt_bot'.length },
    { type: 'mention', offset: t2.indexOf('@claude_bot'), length: '@claude_bot'.length },
  ]
  assert.equal(receiverFor({ text: t2, entities: e2 }, seats, clients).seat.id, 'gpt')

  const stranger = 'hello @someone_else'
  const e3 = [{ type: 'mention', offset: stranger.indexOf('@'), length: '@someone_else'.length }]
  assert.equal(receiverFor({ text: stranger, entities: e3 }, seats, clients).seat.id, 'deepseek')
})

test('receiverFor: text_mention and /cmd@bot', () => {
  const msg = {
    text: 'hi',
    entities: [{ type: 'text_mention', offset: 0, length: 2, user: { id: 222, is_bot: true, username: 'claude_bot' } }],
  }
  assert.equal(receiverFor(msg, seats, clients).seat.id, 'claude')

  const cmd = '/bind@claude_bot room'
  assert.equal(receiverFor({
    text: cmd,
    entities: [{ type: 'bot_command', offset: 0, length: '/bind@claude_bot'.length }],
  }, seats, clients).seat.id, 'claude')
})

test('receiverFor: reply-to member counts as @; explicit mention wins over reply', () => {
  const replyOnly = receiverFor({
    text: '继续',
    reply_to_message: { from: { id: 222, is_bot: true, username: 'claude_bot' } },
  }, seats, clients)
  assert.equal(replyOnly.seat.id, 'claude')
  assert.equal(replyOnly.via, 'reply')

  const t = '其实找 @gpt_bot'
  const both = receiverFor({
    text: t,
    entities: [{ type: 'mention', offset: t.indexOf('@'), length: '@gpt_bot'.length }],
    reply_to_message: { from: { id: 222, is_bot: true, username: 'claude_bot' } },
  }, seats, clients)
  assert.equal(both.seat.id, 'gpt')
  assert.equal(both.via, 'mention')
})

test('dedupe and notInGroupNotice', () => {
  const d = createDedupe({ ttlMs: 60_000, max: 10 })
  assert.equal(d.seen('-1', 10), false)
  assert.equal(d.seen('-1', 10), true)
  assert.equal(d.seen('-1', 11), false)
  assert.match(notInGroupNotice('claude_bot'), /无法将接收切换到 @claude_bot/)
})

test('member cache', async () => {
  const c = createMemberCache({ ttlMs: 60_000 })
  let calls = 0
  const fetch = async () => { calls++; return { status: 'member' } }
  assert.equal(await c.isMember('-1', 222, fetch), true)
  assert.equal(await c.isMember('-1', 222, fetch), true)
  assert.equal(calls, 1)
  c.invalidate('-1', 222)
  assert.equal(await c.isMember('-1', 222, async () => { calls++; return { status: 'left' } }), false)
})

test('classifyDestination: bound > channel allowlist > discover; private → channel; chatroom off → channel', () => {
  assert.equal(classifyDestination({ chatId: '-1001001', isGroup: true }, {
    boundIds: ['-1001001'], channelGroupIds: '-1001001', chatroomEnabled: true,
  }), 'chatroom')
  assert.equal(classifyDestination({ chatId: '-1001002', isGroup: true }, {
    boundIds: [], channelGroupIds: '-1001002', chatroomEnabled: true,
  }), 'channel')
  assert.equal(classifyDestination({ chatId: '-1001003', isGroup: true }, {
    boundIds: [], channelGroupIds: '-1001002', chatroomEnabled: true,
  }), 'chatroom')
  assert.equal(classifyDestination({ chatId: '9000000001', isGroup: false }, {
    boundIds: [], channelGroupIds: '', chatroomEnabled: true,
  }), 'channel')
  assert.equal(classifyDestination({ chatId: '-1001003', isGroup: true }, {
    boundIds: ['-1001003'], channelGroupIds: '', chatroomEnabled: false,
  }), 'channel')
})

test('extractChatFromUpdate', () => {
  const g = extractChatFromUpdate({ message: { chat: { id: -1001, type: 'supergroup', title: 'T' }, text: 'x' } })
  assert.equal(g.chatId, '-1001')
  assert.equal(g.isGroup, true)
  assert.equal(extractChatFromUpdate({ update_id: 1 }), null)
})

test('raw-hub + polling-owners', async () => {
  resetPollingOwners()
  const hub = createRawHub()
  const token = '111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  assert.equal(tokenHash(token).length, 16)
  const got = []
  const off = hub.subscribe(token, { id: 't', onUpdate: (raw) => { got.push(raw.update_id) } })
  await hub.publish(token, { update_id: 7 })
  assert.deepEqual(got, [7])
  claimPollingToken(token, 'channel', 'main')
  assert.equal(channelOwnsToken(token), true)
  releaseAll('channel')
  assert.equal(channelOwnsToken(token), false)
  off()
})

test('member cache: errors are not cached and not treated as absent; fetchers tried in order', async () => {
  const c = createMemberCache({ ttlMs: 60_000 })
  let calls = 0
  const boom = async () => { calls++; throw new Error('Telegram getChatMember: Bad Request: PARTICIPANT_ID_INVALID') }
  const r1 = await c.check('-1', 222, boom)
  assert.equal(r1.state, 'error')
  assert.match(r1.error, /PARTICIPANT_ID_INVALID/)
  assert.equal(await c.isMember('-1', 222, boom), false)
  assert.equal(calls, 2) // 未缓存：每次都重新查
  // 第一个出错 → 用第二个；成功结果缓存
  const r2 = await c.check('-1', 222, [boom, async () => ({ status: 'member' })])
  assert.equal(r2.state, 'member')
  assert.equal((await c.check('-1', 222, boom)).cached, true)
  // 不在群也缓存
  const r3 = await c.check('-2', 222, async () => ({ status: 'left' }))
  assert.equal(r3.state, 'absent')
  assert.equal((await c.check('-2', 222, boom)).state, 'absent')
  // markMember
  c.markMember('-3', 222)
  assert.equal((await c.check('-3', 222, boom)).state, 'member')
  // 未知状态不算确定结果
  assert.equal((await c.check('-4', 222, async () => ({ status: 'weird' }))).state, 'error')
})

test('memberStateOf and notices', () => {
  assert.equal(memberStateOf({ status: 'administrator' }), 'member')
  assert.equal(memberStateOf({ status: 'restricted', is_member: true }), 'member')
  assert.equal(memberStateOf({ status: 'restricted', is_member: false }), 'absent')
  assert.equal(memberStateOf({ status: 'kicked' }), 'absent')
  assert.equal(memberStateOf({}), 'unknown')
  assert.match(botNotRunningNotice('@claude_bot'), /@claude_bot：该成员的机器人未启动（未保存令牌或令牌不可用）/)
  assert.match(botNotRunningNotice('claude_bot', '409'), /未启动（409）/)
  assert.doesNotMatch(botNotRunningNotice('x'), /不在本群/)
})

test('memberFetchers: target asks about itself first; 403 / not-a-member on self means absent', async () => {
  const seen = []
  const mk = (name, impl) => ({ client: { getChatMember: async (cid, uid) => { seen.push(name); return impl(cid, uid) } } })
  const target = mk('target', () => { throw Object.assign(new Error('Telegram getChatMember: Forbidden: bot is not a member of the supergroup chat'), { code: 403 }) })
  const helper = mk('helper', () => ({ status: 'member' }))
  const fs = memberFetchers(target, helper)
  assert.equal(fs.length, 2)
  assert.deepEqual(await fs[0]('-1', 222), { status: 'left' })
  assert.deepEqual(seen, ['target'])
  assert.equal(memberFetchers(target, target).length, 1)
  assert.equal(memberFetchers(null, helper).length, 1)
})

// 实际故障复现：超级群里接收机器人（DeepSeek）查另一个机器人（Claude）→ PARTICIPANT_ID_INVALID；
// 旧代码把这个错误当成「不在本群」并缓存 60 秒。
function mockBots({ tokens, chatMember, seats: seatList }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop()
    const body = init?.body ? JSON.parse(init.body) : {}
    const token = (url.match(/bot([^/]+)/) || [])[1]
    calls.push({ method, body, token })
    if (method === 'getMe') {
      const id = Number(token.split(':')[0])
      return { json: async () => ({ ok: true, result: { id, username: id === 111 ? 'ds_bot' : 'claude_bot', can_read_all_group_messages: true } }) }
    }
    if (method === 'getChatMember') {
      const r = chatMember(token, body)
      if (r instanceof Error) throw r
      return { json: async () => r }
    }
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) }
  }
  const inbound = []
  const warns = []
  const seats = resolveSeats({ chatroomSeats: seatList })
  const bots = createTelegramBots({
    resolveToken: async (r) => tokens[r], getSeats: () => seats, fetchImpl,
    onInbound: (u) => inbound.push(u), channelOwnsToken: async () => false,
    logger: { warn: (...a) => warns.push(a.join(' ')) },
  })
  bots.setBound(() => new Set(['-1001']))
  return { bots, seats, calls, inbound, warns }
}
const SEAT_LIST = [
  { id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'T1' } },
  { id: 'claude', name: 'Claude', telegram: { ingest: false, tokenRef: 'T2' } },
]
const mention = (id, t = '@claude_bot') => ({
  message: { message_id: id, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: t, entities: [{ type: 'mention', offset: 0, length: '@claude_bot'.length }] },
})
const notices = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)

test('intake @mention: ingest bot cannot see other bots (PARTICIPANT_ID_INVALID) → ask target itself, no false "not in group"', async () => {
  const { bots, seats, calls, inbound } = mockBots({
    tokens: { T1: '111:aaa', T2: '222:bbb' },
    seats: SEAT_LIST,
    chatMember: (token, body) => token.startsWith('111:')
      ? { ok: false, error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' }
      : { ok: true, result: { status: 'member', user: { id: body.user_id } } },
  })
  await bots.check(seats[0]); await bots.check(seats[1])
  await bots.handleUpdate(mention(1), { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  assert.deepEqual(notices(calls), [])
  const gcm = calls.filter((c) => c.method === 'getChatMember')
  assert.equal(gcm[0].token, '222:bbb') // 先用 Claude 自己的令牌查自己
  assert.equal(gcm[0].body.user_id, 222)
  await bots.handleUpdate(mention(1), { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  assert.deepEqual(inbound.map((u) => `${u.viaSeatId}:${u.text}`), ['claude:@claude_bot'])
})

test('intake @mention: membership lookup errors → no notice, warn, not cached; target receiving its own copy still works', async () => {
  let fail = true
  const { bots, seats, calls, inbound, warns } = mockBots({
    tokens: { T1: '111:aaa', T2: '222:bbb' },
    seats: SEAT_LIST,
    chatMember: (token, body) => fail ? new Error('fetch failed') : { ok: true, result: { status: 'left', user: { id: body.user_id } } },
  })
  await bots.check(seats[0]); await bots.check(seats[1])
  await bots.handleUpdate(mention(1), { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  assert.deepEqual(notices(calls), [])
  assert.ok(warns.some((w) => /getChatMember failed/.test(w) && /fetch failed/.test(w)))
  // Claude 自己收到这条 → 不必查询，照常进房间
  const before = calls.filter((c) => c.method === 'getChatMember').length
  await bots.handleUpdate(mention(1), { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  assert.equal(calls.filter((c) => c.method === 'getChatMember').length, before)
  assert.equal(inbound.length, 1)
  // 错误没被缓存：网络恢复后真不在群 → 才发「不在本群」
  // （markMember 已把 claude 记为在群，先清掉以模拟被移出）
  bots._test.members.clear()
  fail = false
  await bots.handleUpdate(mention(2), { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  assert.equal(notices(calls).length, 1)
  assert.match(notices(calls)[0], /无法将接收切换到 @claude_bot：该机器人不在本群/)
})

test('intake @mention: target seat has no token → "机器人未启动" instead of "不在本群"', async () => {
  const { bots, seats, calls } = mockBots({
    tokens: { T1: '111:aaa' },
    seats: [SEAT_LIST[0], { id: 'claude', name: 'Claude', telegram: { ingest: false, tokenRef: 'T2', username: 'claude_bot' } }],
    chatMember: () => ({ ok: true, result: { status: 'member' } }),
  })
  await bots.check(seats[0])
  await bots.handleUpdate(mention(1), { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  assert.equal(notices(calls).length, 1)
  assert.match(notices(calls)[0], /@claude_bot：该成员的机器人未启动/)
  assert.doesNotMatch(notices(calls)[0], /不在本群/)
})
