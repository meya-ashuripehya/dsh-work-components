import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_ACCOUNT, accountRouteLines, botTokenRef, channelTokenRefs, groupPresetMap,
  normalizeExtraBots, prepareStartedAccounts, resolveChannelAccounts, sameAccount,
} from './accounts.mjs'
import { originFromContext } from './boards-link.mjs'
import { createTelegramFanout, stampUpdateAccount } from './fanout.mjs'

test('extra bots keep a stable account id and their own credential ref', () => {
  const bots = normalizeExtraBots([
    { id: 'Claude', name: 'Claude', preset: 'sonnet', groupPreset: 'haiku' },
    { id: 'main', name: 'nope' },
    { id: 'claude', name: 'dup' },
    { id: 'Bad ID', preset: 'x' },
    { name: 'missing' },
  ])
  assert.deepEqual(bots, [{
    id: 'claude', name: 'Claude', tokenRef: 'TELEGRAM_BOT_CLAUDE_TOKEN',
    preset: 'sonnet', groupPreset: 'haiku', enabled: true, builtin: false,
  }])
  assert.equal(botTokenRef('claude'), 'TELEGRAM_BOT_CLAUDE_TOKEN')
})

test('resolve keeps the primary bot and lists every token ref', () => {
  const cfg = {
    telegramTokenRef: 'TELEGRAM_BOT_TOKEN',
    telegramPreset: 'deepseek',
    telegramGroupPreset: '',
    telegramBots: [{ id: 'claude', name: 'Claude', preset: 'sonnet' }],
  }
  const accounts = resolveChannelAccounts(cfg)
  assert.deepEqual(accounts.map((a) => a.id), ['main', 'claude'])
  assert.equal(accounts[0].preset, 'deepseek')
  assert.equal(accounts[0].builtin, true)
  assert.deepEqual(channelTokenRefs(cfg), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_CLAUDE_TOKEN'])
})

test('prepare drops missing, disabled, and duplicate tokens', () => {
  const accounts = resolveChannelAccounts({
    telegramPreset: 'deepseek',
    telegramBots: [
      { id: 'claude', preset: 'sonnet', enabled: true },
      { id: 'grok', preset: 'grok', enabled: false },
      { id: 'echo', preset: 'echo' },
    ],
  })
  const { started, skipped } = prepareStartedAccounts(accounts, {
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_CLAUDE_TOKEN: '111:AAA',
    TELEGRAM_BOT_GROK_TOKEN: '222:BBB',
    TELEGRAM_BOT_ECHO_TOKEN: '111:AAA',
  })
  assert.deepEqual(started.map((a) => a.id), ['claude'])
  assert.equal(started[0].token, '111:AAA')
  assert.deepEqual(skipped.map((s) => s.reason), ['未保存令牌', '未启用', '与「claude」使用了同一个令牌'])
  assert.equal(accountRouteLines(started), 'claude:sonnet')
  assert.deepEqual(groupPresetMap([{ id: 'main', groupPreset: 'g1' }, { id: 'claude', groupPreset: '' }]), { main: 'g1' })
})

test('same account treats a missing id as the primary bot', () => {
  assert.equal(sameAccount(undefined, 'main'), true)
  assert.equal(sameAccount('', undefined), true)
  assert.equal(sameAccount(undefined, 'claude'), false)
  assert.equal(sameAccount('claude', 'claude'), true)
  assert.equal(MAIN_ACCOUNT, 'main')
})

test('fanout sends and replies through the bot that owns the account', async () => {
  const calls = []
  const fake = (id) => ({
    id,
    capabilities: { text: true },
    async start(ctx) { calls.push(['start', id]); await ctx.emit({ raw: { update_id: 1 } }) },
    async stop() { calls.push(['stop', id]) },
    send(target, message) { calls.push(['send', id, target.accountId, message]); return { ok: id } },
    createReply(target) { calls.push(['reply', id, target.accountId]); return { id } },
    resolveStreamingMode() { return 'edit' },
    async getHealth() { return { status: 'ok', authenticated: true } },
    botIdentity: { username: id },
  })
  const seen = []
  const fanout = createTelegramFanout([
    { id: 'main', name: '主机器人', adapter: fake('main') },
    { id: 'claude', name: 'Claude', adapter: fake('claude') },
  ])
  await fanout.start({ emit: (event) => { seen.push(event.raw.__dshAccountId) } })
  assert.deepEqual(seen, ['main', 'claude'])
  assert.equal((await fanout.send({ accountId: 'claude' }, { text: 'hi' })).ok, 'claude')
  await fanout.createReply({ accountId: 'main' })
  assert.deepEqual(calls.filter((c) => c[0] === 'send'), [['send', 'claude', 'claude', { text: 'hi' }]])
  assert.deepEqual(calls.filter((c) => c[0] === 'reply'), [['reply', 'main', 'main']])
  const described = await fanout.describe()
  assert.equal(described.health.status, 'ok')
  assert.deepEqual(described.bots.map((b) => b.username), ['main', 'claude'])
  assert.equal(fanout.markConflict('claude'), false)
  assert.equal(fanout.markConflict('main'), true)
  assert.deepEqual(calls.filter((c) => c[0] === 'stop').map((c) => c[1]).sort(), ['claude', 'main'])
})

test('stamped updates carry the account into the board origin', () => {
  const raw = stampUpdateAccount({ message: { chat: { id: 42 } } }, 'claude')
  const origin = originFromContext({ raw, senderId: '7', conversationType: 'dm' })
  assert.equal(origin.accountId, 'claude')
  assert.equal(origin.chatId, '42')
  const primary = originFromContext({ raw: stampUpdateAccount({ message: { chat: { id: 42 } } }, 'main'), senderId: '7', conversationType: 'dm' })
  assert.equal(primary.accountId, undefined)
})
