import test from 'node:test'
import assert from 'node:assert/strict'
import { createTelegramFanout } from './telegram/fanout.mjs'
import { OPEN_TOOLS } from './telegram/owner-gate.mjs'
import {
  QQ_PROACTIVE_TOOL,
  TELEGRAM_PROACTIVE_TOOL,
  createProactiveSendFeature,
  createQqProactiveTool,
  createTelegramProactiveTool,
  resolveTelegramAccount,
  visibleProactiveTools,
} from './proactive-send.mjs'

const TG_USER = '6153059771'
const TG_GROUP = '-1003435238151'
const QQ_USER = 'B4C6E62A8A0919E62678494F20F30530'
const QQ_GROUP = 'C0FFEE00C0FFEE00C0FFEE00C0FFEE00'

function tgRow(accountId, conversationId, conversationType, extra = {}) {
  return [`telegram:${accountId}:${conversationId}${extra.threadId ? ':' + extra.threadId : ''}`, {
    channelId: 'telegram',
    accountId,
    conversationId,
    conversationType,
    sessionId: `ch-${accountId}`,
    ...extra,
  }]
}

function bindingsOf(rows) {
  return Object.fromEntries(rows)
}

function recorder() {
  const calls = []
  return {
    calls,
    async send(payload) {
      calls.push(payload)
      return { delivered: true, messageId: 'm-' + calls.length }
    },
  }
}

test('proactive tools stay outside the open computer-tool list', () => {
  assert.equal(OPEN_TOOLS.has(TELEGRAM_PROACTIVE_TOOL), false)
  assert.equal(OPEN_TOOLS.has(QQ_PROACTIVE_TOOL), false)
})

test('telegram: disabled tool refuses and does not send', async () => {
  const out = recorder()
  const tool = createTelegramProactiveTool({
    getConfig: () => ({ telegramProactiveSendEnabled: false, telegramProactiveSendAllowlist: TG_USER }),
    loadBindings: () => bindingsOf([tgRow('alt', TG_USER, 'dm')]),
    send: out.send,
  })
  const result = await tool.execute({ target_id: TG_USER, text: 'hi', conversation_type: 'dm' })
  assert.equal(result.ok, false)
  assert.match(result.error, /未启用/)
  assert.equal(out.calls.length, 0)
})

test('telegram: id not on the allowlist is refused', async () => {
  const out = recorder()
  const tool = createTelegramProactiveTool({
    getConfig: () => ({ telegramProactiveSendEnabled: true, telegramProactiveSendAllowlist: '111' }),
    loadBindings: () => bindingsOf([tgRow('alt', TG_USER, 'dm')]),
    send: out.send,
  })
  const result = await tool.execute({ target_id: TG_USER, text: 'hi' })
  assert.equal(result.ok, false)
  assert.match(result.error, /白名单/)
  assert.equal(out.calls.length, 0)
})

test('telegram: allowlisted user send uses the bound account, not main', async () => {
  const out = recorder()
  const tool = createTelegramProactiveTool({
    getConfig: () => ({ telegramProactiveSendEnabled: true, telegramProactiveSendAllowlist: `${TG_USER}, ${TG_GROUP}` }),
    loadBindings: () => bindingsOf([
      tgRow('main', '999', 'dm'),
      tgRow('alt', TG_USER, 'dm'),
    ]),
    send: out.send,
  })
  const result = await tool.execute({ target_id: TG_USER, text: 'hello user' })
  assert.equal(result.ok, true)
  assert.equal(result.delivered, true)
  assert.equal(result.accountId, 'alt')
  assert.equal(result.conversationType, 'dm')
  assert.deepEqual(out.calls, [{
    accountId: 'alt',
    conversationId: TG_USER,
    conversationType: 'dm',
    text: 'hello user',
  }])
})

test('telegram: allowlisted group send uses the bound account', async () => {
  const out = recorder()
  const tool = createTelegramProactiveTool({
    getConfig: () => ({ telegramProactiveSendEnabled: true, telegramProactiveSendAllowlist: TG_GROUP }),
    loadBindings: () => bindingsOf([tgRow('alt', TG_GROUP, 'group')]),
    send: out.send,
  })
  const result = await tool.execute({ target_id: TG_GROUP, text: 'hello group', conversation_type: 'group' })
  assert.equal(result.ok, true)
  assert.equal(result.conversationType, 'group')
  assert.equal(out.calls[0].accountId, 'alt')
  assert.equal(out.calls[0].conversationId, TG_GROUP)
  assert.equal(out.calls[0].conversationType, 'group')
  assert.equal(out.calls[0].text, 'hello group')
})

test('telegram: unbound chat is refused and does not fall back to main', async () => {
  const out = recorder()
  const resolved = resolveTelegramAccount(bindingsOf([tgRow('main', '999', 'dm')]), TG_USER)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.code, 'unbound')
  const tool = createTelegramProactiveTool({
    getConfig: () => ({ telegramProactiveSendEnabled: true, telegramProactiveSendAllowlist: TG_USER }),
    loadBindings: () => bindingsOf([tgRow('main', '999', 'dm')]),
    send: out.send,
  })
  const result = await tool.execute({ target_id: TG_USER, text: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有已绑定/)
  assert.equal(out.calls.length, 0)
})

test('telegram: two accounts bound to the same chat is ambiguous', async () => {
  const out = recorder()
  const rows = bindingsOf([
    tgRow('main', TG_GROUP, 'group'),
    tgRow('alt', TG_GROUP, 'group'),
  ])
  const resolved = resolveTelegramAccount(rows, TG_GROUP)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.code, 'ambiguous')
  const tool = createTelegramProactiveTool({
    getConfig: () => ({ telegramProactiveSendEnabled: true, telegramProactiveSendAllowlist: TG_GROUP }),
    loadBindings: () => rows,
    send: out.send,
  })
  const result = await tool.execute({ target_id: TG_GROUP, text: 'nope', conversation_type: 'group' })
  assert.equal(result.ok, false)
  assert.match(result.error, /多个 Telegram 账号/)
  assert.equal(out.calls.length, 0)
})

test('telegram: a thread binding on the same account is not ambiguous', () => {
  const resolved = resolveTelegramAccount(bindingsOf([
    tgRow('alt', TG_GROUP, 'group'),
    tgRow('alt', TG_GROUP, 'group', { threadId: '40' }),
  ]), TG_GROUP)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.accountId, 'alt')
  assert.equal(resolved.conversationType, 'group')
})

test('telegram: key-only binding still resolves the account', () => {
  const resolved = resolveTelegramAccount({
    'telegram:side:-1009': { channelId: 'telegram', sessionId: 'ch-side' },
  }, '-1009')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.accountId, 'side')
})

test('fanout proactive send refuses a missing account instead of using main', async () => {
  const calls = []
  const fake = (id) => ({
    async send(target, message) {
      calls.push([id, target.accountId, target.conversationId, message.text])
      return { delivered: true, messageId: id }
    },
  })
  const fanout = createTelegramFanout([
    { id: 'main', adapter: fake('main') },
    { id: 'alt', adapter: fake('alt') },
  ])
  await assert.rejects(async () => fanout.sendProactive('missing', { conversationId: TG_USER }, { text: 'x' }), /不会改用其他机器人/)
  await assert.rejects(async () => fanout.sendProactive('', { conversationId: TG_USER }, { text: 'x' }), /未解析到/)
  assert.equal(calls.length, 0)
  const sent = await fanout.sendProactive('alt', { conversationId: TG_GROUP, conversationType: 'group' }, { text: 'group' })
  assert.equal(sent.messageId, 'alt')
  assert.deepEqual(calls, [['alt', 'alt', TG_GROUP, 'group']])
  // 回复路径仍可按原规则在未点名账号时落到 main；主动发送不走这条。
  await fanout.send({ conversationId: '1' }, { text: 'reply' })
  assert.equal(calls.at(-1)[0], 'main')
})

test('qq: disabled, not allowlisted, allowlisted user, allowlisted group', async () => {
  const out = recorder()
  const allow = `${QQ_USER}\n${QQ_GROUP}`
  const disabled = createQqProactiveTool({
    getConfig: () => ({ qqProactiveSendEnabled: false, qqProactiveSendAllowlist: allow }),
    loadBindings: () => ({}),
    send: out.send,
  })
  const off = await disabled.execute({ target_id: QQ_USER, text: 'hi', conversation_type: 'dm' })
  assert.equal(off.ok, false)
  assert.match(off.error, /未启用/)
  assert.equal(out.calls.length, 0)

  const blocked = createQqProactiveTool({
    getConfig: () => ({ qqProactiveSendEnabled: true, qqProactiveSendAllowlist: QQ_USER }),
    loadBindings: () => ({}),
    send: out.send,
  })
  const denied = await blocked.execute({ target_id: QQ_GROUP, text: 'hi', conversation_type: 'group' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /白名单/)
  assert.equal(out.calls.length, 0)

  const live = createQqProactiveTool({
    getConfig: () => ({ qqProactiveSendEnabled: true, qqProactiveSendAllowlist: allow }),
    loadBindings: () => ({}),
    send: out.send,
  })
  const user = await live.execute({ target_id: QQ_USER, text: 'user body', conversation_type: 'dm' })
  assert.equal(user.ok, true)
  assert.equal(user.accountId, 'main')
  assert.equal(user.conversationType, 'dm')
  const group = await live.execute({ target_id: QQ_GROUP, text: 'group body', conversation_type: 'group' })
  assert.equal(group.ok, true)
  assert.equal(group.conversationType, 'group')
  assert.deepEqual(out.calls, [
    { accountId: 'main', conversationId: QQ_USER, conversationType: 'dm', text: 'user body' },
    { accountId: 'main', conversationId: QQ_GROUP, conversationType: 'group', text: 'group body' },
  ])
})

test('qq: group type can be inferred from the binding; missing type without a binding is refused', async () => {
  const out = recorder()
  const tool = createQqProactiveTool({
    getConfig: () => ({ qqProactiveSendEnabled: true, qqProactiveSendAllowlist: QQ_GROUP }),
    loadBindings: () => ({
      [`qq:main:${QQ_GROUP}`]: {
        channelId: 'qq', accountId: 'main', conversationId: QQ_GROUP, conversationType: 'group', sessionId: 'ch-qq',
      },
    }),
    send: out.send,
  })
  const sent = await tool.execute({ target_id: QQ_GROUP, text: 'from binding' })
  assert.equal(sent.ok, true)
  assert.equal(out.calls[0].conversationType, 'group')
  assert.equal(out.calls[0].accountId, 'main')

  const bare = createQqProactiveTool({
    getConfig: () => ({ qqProactiveSendEnabled: true, qqProactiveSendAllowlist: QQ_USER }),
    loadBindings: () => ({}),
    send: out.send,
  })
  const refused = await bare.execute({ target_id: QQ_USER, text: 'needs kind' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /conversation_type/)
  assert.equal(out.calls.length, 1)
})

test('visibility follows telegram preset and groupPreset, and qq preset when set', () => {
  const cfg = {
    telegramProactiveSendEnabled: true,
    telegramBots: [
      { id: 'main', enabled: true, preset: 'lingsnow', groupPreset: 'room' },
      { id: 'claude', enabled: false, preset: 'claude' },
      { id: 'chatgpt', enabled: true, preset: 'chatgpt' },
    ],
    qqProactiveSendEnabled: true,
    qqPreset: 'lingsnow',
  }
  assert.deepEqual(visibleProactiveTools(cfg, 'lingsnow').sort(), [QQ_PROACTIVE_TOOL, TELEGRAM_PROACTIVE_TOOL].sort())
  // 群预设与私聊预设不同：跑在 groupPreset 上的会话也能看到 Telegram 工具，但看不到只认 qqPreset 的 QQ 工具。
  assert.deepEqual(visibleProactiveTools(cfg, 'room'), [TELEGRAM_PROACTIVE_TOOL])
  assert.deepEqual(visibleProactiveTools(cfg, 'chatgpt'), [TELEGRAM_PROACTIVE_TOOL])
  assert.deepEqual(visibleProactiveTools(cfg, 'claude'), [])
  assert.deepEqual(visibleProactiveTools(cfg, 'guest'), [])
  assert.deepEqual(visibleProactiveTools({ ...cfg, telegramProactiveSendEnabled: false }, 'lingsnow'), [QQ_PROACTIVE_TOOL])
  assert.deepEqual(visibleProactiveTools({ ...cfg, qqProactiveSendEnabled: false }, 'lingsnow'), [TELEGRAM_PROACTIVE_TOOL])
  // QQ 没填预设：没有可对照的账号预设，开关打开即对会话提供工具。
  assert.deepEqual(visibleProactiveTools({ qqProactiveSendEnabled: true, qqPreset: '' }, 'guest'), [QQ_PROACTIVE_TOOL])
  assert.deepEqual(visibleProactiveTools({ qqProactiveSendEnabled: true, qqPreset: 'lingsnow' }, 'guest'), [])
  assert.deepEqual(visibleProactiveTools({ telegramProactiveSendEnabled: false, qqProactiveSendEnabled: false }, 'lingsnow'), [])
})

test('feature offers a tool only on a matching preset and removes it when disabled', async () => {
  let cfg = {
    telegramProactiveSendEnabled: true,
    telegramBots: [{ id: 'main', enabled: true, preset: 'lingsnow', groupPreset: 'room' }],
    qqProactiveSendEnabled: true,
    qqPreset: 'lingsnow',
  }
  const registered = []
  function toolApi(agent) {
    return {
      tools: {
        register(tool) {
          registered.push({ id: agent.id, name: tool.name })
          return () => {
            const i = registered.findIndex((row) => row.id === agent.id && row.name === tool.name)
            if (i >= 0) registered.splice(i, 1)
          }
        },
      },
    }
  }
  const agents = {
    async create(opts = {}) {
      const agent = { id: opts.sessionId, ctx: { presetId: opts.presetId || '' } }
      agent.ctx.inject = (_need, cb) => cb(toolApi(agent))
      if (opts.setup) await opts.setup(agent.ctx, agent)
      return agent
    },
  }
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'agents') return agents
      if (name === 'agentPresets') return { composedPreset: (agentCtx) => agentCtx?.presetId || '' }
      return null
    },
    on(name, fn) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
    inject(names, cb) { if (names[0] === 'agents') cb({ agents }) },
  }
  const feature = createProactiveSendFeature(ctx, () => cfg, {
    loadBindings: () => ({}),
    sendTelegram: async () => ({ delivered: true }),
    sendQq: async () => ({ delivered: true }),
  })
  const matched = {
    id: 's-match',
    ctx: { presetId: 'lingsnow', inject: (_n, cb) => cb(toolApi({ id: 's-match' })) },
  }
  const other = {
    id: 's-other',
    ctx: { presetId: 'guest', inject: (_n, cb) => cb(toolApi({ id: 's-other' })) },
  }
  assert.deepEqual(feature.consider(matched).sort(), [QQ_PROACTIVE_TOOL, TELEGRAM_PROACTIVE_TOOL].sort())
  assert.deepEqual(feature.consider(other), [])
  assert.deepEqual(registered.map((row) => row.name).sort(), [QQ_PROACTIVE_TOOL, TELEGRAM_PROACTIVE_TOOL].sort())
  assert.equal(registered.every((row) => row.id === 's-match'), true)

  matched.ctx.presetId = 'guest'
  listeners.get('agent-preset/selected')('s-match', 'guest')
  assert.deepEqual(feature.mountedNames('s-match'), [])
  assert.equal(registered.some((row) => row.id === 's-match'), false)
  matched.ctx.presetId = 'lingsnow'
  listeners.get('agent-preset/selected')('s-match', 'lingsnow')
  assert.deepEqual(feature.mountedNames('s-match').sort(), [QQ_PROACTIVE_TOOL, TELEGRAM_PROACTIVE_TOOL].sort())

  cfg = { ...cfg, telegramProactiveSendEnabled: false, qqProactiveSendEnabled: false }
  feature.sync()
  assert.deepEqual(feature.mountedNames('s-match'), [])
  assert.deepEqual(registered, [])

  cfg = { ...cfg, qqProactiveSendEnabled: true }
  feature.sync()
  assert.deepEqual(feature.mountedNames('s-match'), [QQ_PROACTIVE_TOOL])

  cfg = { ...cfg, telegramProactiveSendEnabled: true }
  const created = await agents.create({
    sessionId: 's-room',
    presetId: 'room',
    setup: async (agentCtx) => { agentCtx.presetId = 'room' },
  })
  assert.equal(created.id, 's-room')
  assert.deepEqual(feature.mountedNames('s-room'), [TELEGRAM_PROACTIVE_TOOL])
  await feature.dispose()
  assert.deepEqual(feature.mountedNames('s-room'), [])
  assert.equal(registered.some((row) => row.id === 's-room'), false)
})
