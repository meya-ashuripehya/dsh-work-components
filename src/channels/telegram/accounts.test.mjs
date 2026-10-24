import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_ACCOUNT, accountRouteLines, accountRouteMap, aliasPatchFromBots, botTokenRef, channelTokenRefs,
  groupPresetMap, migrateTelegramBots, normalizeBots, normalizeExtraBots, pollingRestartKey,
  prepareStartedAccounts, resolveChannelAccounts, sameAccount, syncAliasesIntoBots,
} from './accounts.mjs'
import { originFromContext } from './boards-link.mjs'
import { createTelegramFanout, stampUpdateAccount } from './fanout.mjs'
import { excludeBoundChatIds, setExcludedGroupChats } from './group-route.mjs'
import { harnessConfig, parseRouteMap } from './runtime.mjs'
import { optionsFor } from '../../../vendor/wsz987/channel-harness/lib/agent-manager.js'
import { Config as HarnessConfig } from '../../../vendor/wsz987/channel-harness/lib/config.js'
import { llmCatalogPayload, reasoningEfforts } from '../../dsh-catalog.mjs'

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
    provider: '', model: '', reasoningEffort: '',
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

test('migration folds the legacy primary fields into a main row and keeps extras', () => {
  const cfg = {
    telegramPreset: 'deepseek',
    telegramGroupPreset: 'g1',
    telegramTokenRef: 'TELEGRAM_BOT_TOKEN',
    telegramConversationRoutes: '9000000001:lingsnow',
    telegramBots: [{ id: 'claude', preset: 'sonnet', provider: 'claude', model: 'claude-haiku-5-5', reasoningEffort: 'high' }],
  }
  const bots = migrateTelegramBots(cfg)
  assert.deepEqual(bots.map((b) => b.id), ['main', 'claude'])
  assert.equal(bots[0].preset, 'deepseek')
  assert.equal(bots[0].groupPreset, 'g1')
  assert.equal(bots[0].tokenRef, 'TELEGRAM_BOT_TOKEN')
  assert.equal(bots[0].builtin, true)
  assert.equal(bots[1].provider, 'claude')
  assert.equal(bots[1].model, 'claude-haiku-5-5')
  assert.equal(bots[1].reasoningEffort, 'high')
  assert.equal(migrateTelegramBots({ ...cfg, telegramBots: bots }), null)
  const patch = aliasPatchFromBots(bots)
  assert.equal(patch.telegramPreset, 'deepseek')
  assert.equal(patch.telegramGroupPreset, 'g1')
  assert.equal(patch.telegramTokenRef, 'TELEGRAM_BOT_TOKEN')
  assert.equal(patch.telegramConversationRoutes, '')
  assert.equal(Object.hasOwn(patch, 'telegramToken'), false)
})

test('main stays editable except its id, and a saved main row wins over legacy aliases', () => {
  const bots = normalizeBots([
    { id: 'MAIN', name: 'DeepSeek', preset: 'lingsnow', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', tokenRef: 'TELEGRAM_BOT_TOKEN' },
    { id: 'chatgpt', preset: 'chatgpt', provider: 'gpt', model: 'gpt-6-sol' },
    { id: 'main', name: 'second' },
  ], { telegramPreset: 'old', telegramTokenRef: 'STALE_REF' })
  assert.equal(bots[0].id, 'main')
  assert.equal(bots[0].name, 'DeepSeek')
  assert.equal(bots[0].preset, 'lingsnow')
  assert.equal(bots[0].tokenRef, 'TELEGRAM_BOT_TOKEN')
  assert.equal(bots[0].model, 'deepseek-flash')
  assert.deepEqual(bots.map((b) => b.id), ['main', 'chatgpt'])
  const synced = syncAliasesIntoBots(bots, { telegramPreset: 'renamed', telegramTokenRef: 'OTHER_REF' })
  assert.equal(synced[0].preset, 'renamed')
  assert.equal(synced[0].tokenRef, 'OTHER_REF')
  assert.equal(synced[0].model, 'deepseek-flash')
  assert.equal(syncAliasesIntoBots(bots, { telegramProxy: 'http://127.0.0.1:7890' }), null)
})

test('account routes carry provider and model for every started bot, including main', () => {
  const accounts = resolveChannelAccounts({
    telegramBots: [
      { id: 'main', name: 'DeepSeek', preset: 'lingsnow', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', enabled: true },
      { id: 'chatgpt', preset: 'chatgpt', provider: 'gpt', model: 'gpt-6-sol', reasoningEffort: 'medium' },
      { id: 'grok', enabled: false, provider: 'xai', model: 'grok-4.3' },
    ],
  })
  assert.deepEqual(channelTokenRefs({ telegramEnabled: false, telegramBots: accounts, telegramTokenRef: 'STALE' }), [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_CHATGPT_TOKEN',
  ])
  // reservedTokens 参数保留兼容，共享令牌不再被跳过（按群分流）
  const { started, skipped } = prepareStartedAccounts(accounts, {
    TELEGRAM_BOT_TOKEN: '999:CCCCCCCCCCCCCCCCCCCC',
    TELEGRAM_BOT_CHATGPT_TOKEN: '111:AAAAAAAAAAAAAAAAAAAA',
  }, ['999:CCCCCCCCCCCCCCCCCCCC'])
  assert.deepEqual(started.map((a) => a.id), ['main', 'chatgpt'])
  assert.equal(skipped.length, 1) // grok 未启用
  assert.equal(skipped[0].id, 'grok')
  assert.deepEqual(accountRouteMap(started).chatgpt, {
    preset: 'chatgpt', provider: 'gpt', model: 'gpt-6-sol', reasoningEffort: 'medium',
  })
  assert.equal(accountRouteLines(started), 'main:lingsnow\nchatgpt:chatgpt')
})

test('harness config uses the first bot as default and ignores conversation overrides', () => {
  const account = {
    main: { preset: 'lingsnow', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    chatgpt: { preset: 'chatgpt', provider: 'gpt', model: 'gpt-6-sol' },
  }
  const cfg = harnessConfig({
    defaultRoute: account.chatgpt,
    accountRoutes: account,
    conversationRoutes: '9000000001:lingsnow',
    channelRoutes: 'telegram:room',
  })
  assert.equal(cfg.agent.default.preset, 'chatgpt')
  assert.equal(cfg.agent.default.provider, 'gpt')
  assert.equal(cfg.agent.default.model, 'gpt-6-sol')
  assert.equal(cfg.routing.overrides.conversation?.['9000000001'], undefined)
  assert.deepEqual(cfg.routing.overrides.conversation || {}, {})
  assert.equal(cfg.routing.overrides.account.main.model, 'deepseek-flash')
  assert.deepEqual(parseRouteMap('claude:sonnet'), { claude: { preset: 'sonnet' } })
  const passed = HarnessConfig({ agent: { default: account.main }, routing: { overrides: { account } } })
  assert.equal(passed.agent.default.reasoningEffort, 'high')
  assert.deepEqual(optionsFor(account.main), {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
})

test('chatroom-bound groups are left out of the channel allowlist and inbound fanout', async () => {
  assert.equal(excludeBoundChatIds('-1001, -1002\n-1003', ['-1001', '-1003']), '-1002')
  setExcludedGroupChats(['-1001'])
  const seen = []
  const adapter = {
    async start(ctx) {
      await ctx.emit({ type: 'message', conversation: { id: '-1001' }, raw: {} })
      await ctx.emit({ type: 'message', conversation: { id: '42' }, raw: {} })
    },
    async stop() {},
  }
  const fanout = createTelegramFanout([{ id: 'main', name: 'main', adapter }])
  await fanout.start({ emit: (event) => { seen.push(event.conversation.id) } })
  assert.deepEqual(seen, ['42'])
  setExcludedGroupChats([])
})

test('polling restart key changes with channel tokens and ignores token order', () => {
  const base = { seatId: 'seat-1', tokenRef: 'CHATROOM_BOT_SEAT_1_TOKEN', hasToken: true, telegramEnabled: false }
  const a = pollingRestartKey({ ...base, tokens: ['bbb', 'aaa'] })
  const b = pollingRestartKey({ ...base, tokens: ['aaa', 'bbb'] })
  const c = pollingRestartKey({ ...base, tokens: ['aaa', 'ccc'] })
  const d = pollingRestartKey({ ...base, telegramEnabled: true, tokens: ['aaa', 'bbb'] })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  assert.equal(a.includes('aaa'), false)
})

test('catalog and efforts helpers are the single implementation behind both routes', async () => {
  const fake = {
    async providers() { return { available: true, providers: [{ id: 'gpt', name: 'GPT', models: [{ id: 'gpt-6-sol', name: 'GPT' }] }] } },
    async presets() { return { available: true, presets: [{ id: 'chatgpt', name: 'ChatGPT' }], defaultId: 'chatgpt' } },
    llm() {
      return { async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } } } }
    },
  }
  const catalog = await llmCatalogPayload(fake)
  const again = await llmCatalogPayload(fake)
  assert.deepEqual(catalog, again)
  assert.equal(catalog.llm.providers[0].id, 'gpt')
  const efforts = await reasoningEfforts(fake, 'gpt', 'gpt-6-sol')
  assert.deepEqual(await reasoningEfforts(fake, 'gpt', 'gpt-6-sol'), efforts)
  assert.deepEqual(efforts, { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' })
})
