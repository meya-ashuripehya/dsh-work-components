import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChannelMessage } from './outbound-file.mjs'
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

const GEMINI_BOTS = [
  { id: 'main', enabled: true, preset: 'lingsnow', groupPreset: 'room' },
  { id: 'chatgpt', enabled: true, preset: 'chatgpt' },
  { id: 'gemini', enabled: true, preset: 'gemini', groupPreset: 'gemini-group' },
]

test('telegram: target bound to main+chatgpt+gemini sends via the session preset', async () => {
  const out = recorder()
  const rows = bindingsOf([
    tgRow('main', TG_USER, 'dm'),
    tgRow('chatgpt', TG_USER, 'dm'),
    tgRow('gemini', TG_USER, 'dm'),
  ])
  const resolved = resolveTelegramAccount(rows, TG_USER, { presetId: 'gemini', bots: GEMINI_BOTS })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.accountId, 'gemini')
  assert.equal(resolved.conversationType, 'dm')
  const tool = createTelegramProactiveTool({
    getConfig: () => ({
      telegramProactiveSendEnabled: true,
      telegramProactiveSendAllowlist: TG_USER,
      telegramBots: GEMINI_BOTS,
    }),
    loadBindings: () => rows,
    send: out.send,
    sessionPreset: () => 'gemini',
  })
  const result = await tool.execute({ target_id: TG_USER, text: 'from gemini' }, { agent: { id: 's-gemini' } })
  assert.equal(result.ok, true)
  assert.equal(result.delivered, true)
  assert.equal(result.accountId, 'gemini')
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].accountId, 'gemini')
  assert.equal(out.calls[0].conversationId, TG_USER)
  assert.equal(out.calls[0].text, 'from gemini')
  assert.equal(result.error, undefined)
})

test('telegram: no preset match refuses instead of using main', async () => {
  const out = recorder()
  const rows = bindingsOf([
    tgRow('main', TG_USER, 'dm'),
    tgRow('chatgpt', TG_USER, 'dm'),
    tgRow('gemini', TG_USER, 'dm'),
  ])
  const resolved = resolveTelegramAccount(rows, TG_USER, { presetId: 'claude', bots: GEMINI_BOTS })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.code, 'preset-mismatch')
  assert.match(resolved.error, /claude/)
  assert.match(resolved.error, /main/)
  const onlyMain = resolveTelegramAccount(bindingsOf([tgRow('main', TG_USER, 'dm')]), TG_USER, {
    presetId: 'gemini',
    bots: GEMINI_BOTS,
  })
  assert.equal(onlyMain.ok, false)
  assert.equal(onlyMain.code, 'preset-mismatch')
  const tool = createTelegramProactiveTool({
    getConfig: () => ({
      telegramProactiveSendEnabled: true,
      telegramProactiveSendAllowlist: TG_USER,
      telegramBots: GEMINI_BOTS,
    }),
    loadBindings: () => rows,
    send: out.send,
    sessionPreset: () => 'claude',
  })
  const result = await tool.execute({ target_id: TG_USER, text: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有与当前预设/)
  assert.equal(out.calls.length, 0)
})

test('telegram: group target matches groupPreset; two accounts with the same preset stay ambiguous', () => {
  const rows = bindingsOf([
    tgRow('main', TG_GROUP, 'group'),
    tgRow('gemini', TG_GROUP, 'group'),
  ])
  const hit = resolveTelegramAccount(rows, TG_GROUP, { presetId: 'gemini-group', bots: GEMINI_BOTS })
  assert.equal(hit.ok, true)
  assert.equal(hit.accountId, 'gemini')
  const privatePreset = resolveTelegramAccount(rows, TG_GROUP, { presetId: 'gemini', bots: GEMINI_BOTS })
  assert.equal(privatePreset.ok, false)
  assert.equal(privatePreset.code, 'preset-mismatch')
  const room = resolveTelegramAccount(rows, TG_GROUP, { presetId: 'room', bots: GEMINI_BOTS })
  assert.equal(room.ok, true)
  assert.equal(room.accountId, 'main')

  const twins = [
    { id: 'gemini', enabled: true, preset: 'gemini' },
    { id: 'gemini-b', enabled: true, preset: 'gemini' },
  ]
  const ambiguous = resolveTelegramAccount(bindingsOf([
    tgRow('gemini', TG_USER, 'dm'),
    tgRow('gemini-b', TG_USER, 'dm'),
  ]), TG_USER, { presetId: 'gemini', bots: twins })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, 'ambiguous')
  assert.match(ambiguous.error, /多个 Telegram 账号/)

  const disabled = resolveTelegramAccount(bindingsOf([
    tgRow('main', TG_USER, 'dm'),
    tgRow('gemini', TG_USER, 'dm'),
  ]), TG_USER, {
    presetId: 'gemini',
    bots: GEMINI_BOTS.map((bot) => bot.id === 'gemini' ? { ...bot, enabled: false } : bot),
  })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.code, 'preset-mismatch')
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

test('feature execute uses the calling session preset when several accounts bind the target', async () => {
  const out = recorder()
  const rows = bindingsOf([
    tgRow('main', TG_USER, 'dm'),
    tgRow('chatgpt', TG_USER, 'dm'),
    tgRow('gemini', TG_USER, 'dm'),
  ])
  let registered = null
  const agent = { id: 's-gemini', ctx: { presetId: 'gemini' } }
  agent.ctx.inject = (_n, cb) => cb({
    tools: {
      register(tool) {
        if (tool.name === TELEGRAM_PROACTIVE_TOOL) registered = tool
        return () => {}
      },
    },
  })
  const feature = createProactiveSendFeature({
    logger: { warn() {} },
    get(name) {
      if (name === 'agentPresets') return { composedPreset: (agentCtx) => agentCtx?.presetId || '' }
      if (name === 'agents') return { get: (id) => id === agent.id ? agent : null }
      return null
    },
    on() { return () => {} },
    inject() {},
  }, () => ({
    telegramProactiveSendEnabled: true,
    telegramBots: GEMINI_BOTS,
    telegramProactiveSendAllowlist: TG_USER,
    qqProactiveSendEnabled: false,
  }), {
    loadBindings: () => rows,
    sendTelegram: out.send,
  })
  assert.deepEqual(feature.consider(agent), [TELEGRAM_PROACTIVE_TOOL])
  const result = await registered.execute({ target_id: TG_USER, text: 'via feature' }, { agent: { id: 's-gemini' } })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'gemini')
  assert.equal(out.calls[0].accountId, 'gemini')
  assert.equal(out.calls[0].text, 'via feature')
  await feature.dispose()
})

test('proactive file send reuses the mm_send_file document part for Telegram and QQ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proactive-file-'))
  const path = join(dir, 'note.txt')
  await writeFile(path, 'hello file')
  try {
    const tg = recorder()
    let loads = 0
    const blocked = createTelegramProactiveTool({
      getConfig: () => ({ telegramProactiveSendEnabled: true, telegramProactiveSendAllowlist: '111' }),
      loadBindings: () => bindingsOf([tgRow('gemini', TG_USER, 'dm')]),
      send: tg.send,
      sessionPreset: () => 'gemini',
      loadFile: () => { loads += 1; throw new Error('should not read') },
    })
    const denied = await blocked.execute({ target_id: TG_USER, path, text: 'nope' })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /白名单/)
    assert.equal(loads, 0)
    assert.equal(tg.calls.length, 0)

    const rows = bindingsOf([
      tgRow('main', TG_USER, 'dm'),
      tgRow('chatgpt', TG_USER, 'dm'),
      tgRow('gemini', TG_USER, 'dm'),
    ])
    const tool = createTelegramProactiveTool({
      getConfig: () => ({
        telegramProactiveSendEnabled: true,
        telegramProactiveSendAllowlist: TG_USER,
        telegramBots: GEMINI_BOTS,
      }),
      loadBindings: () => rows,
      send: tg.send,
      sessionPreset: () => 'gemini',
    })
    const sent = await tool.execute({ target_id: TG_USER, path, caption: 'see attached' })
    assert.equal(sent.ok, true)
    assert.equal(sent.accountId, 'gemini')
    assert.equal(sent.fileName, 'note.txt')
    const call = tg.calls[0]
    assert.equal(call.accountId, 'gemini')
    assert.equal(call.text, 'see attached')
    assert.equal(call.file.name, 'note.txt')
    assert.equal(call.file.mimeType, 'text/plain')
    assert.equal(Buffer.from(call.file.localData).toString(), 'hello file')
    const message = buildChannelMessage(call)
    assert.equal(message.text, 'see attached')
    assert.deepEqual(message.parts.map((part) => ({ type: part.type, name: part.name, mimeType: part.mimeType })), [
      { type: 'file', name: 'note.txt', mimeType: 'text/plain' },
    ])
    assert.equal(Buffer.from(message.parts[0].localData).toString(), 'hello file')

    const remote = await tool.execute({ target_id: TG_USER, path: 'https://example.com/a.pdf', text: 'x' })
    assert.equal(remote.ok, false)
    assert.match(remote.error, /remote URLs/i)
    assert.equal(tg.calls.length, 1)

    const empty = await tool.execute({ target_id: TG_USER })
    assert.equal(empty.ok, false)
    assert.match(empty.error, /消息正文为空/)

    const qq = recorder()
    const qqTool = createQqProactiveTool({
      getConfig: () => ({ qqProactiveSendEnabled: true, qqProactiveSendAllowlist: `${QQ_USER}\n${QQ_GROUP}` }),
      loadBindings: () => ({}),
      send: qq.send,
    })
    const qqSent = await qqTool.execute({ target_id: QQ_USER, path, conversation_type: 'dm' })
    assert.equal(qqSent.ok, true)
    assert.equal(qqSent.accountId, 'main')
    assert.equal(qqSent.fileName, 'note.txt')
    assert.equal(qq.calls[0].conversationType, 'dm')
    assert.equal(qq.calls[0].text, undefined)
    assert.equal(Buffer.from(qq.calls[0].file.localData).toString(), 'hello file')
    const qqMessage = buildChannelMessage(qq.calls[0])
    assert.equal(qqMessage.text, undefined)
    assert.equal(qqMessage.parts[0].type, 'file')
    assert.equal(qqMessage.parts[0].mimeType, 'text/plain')

    const qqGroup = await qqTool.execute({ target_id: QQ_GROUP, path, text: '群文件', conversation_type: 'group' })
    assert.equal(qqGroup.ok, true)
    assert.equal(qq.calls[1].conversationType, 'group')
    assert.equal(qq.calls[1].text, '群文件')
    assert.equal(qq.calls[1].file.name, 'note.txt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('fanout proactive send forwards a document part to the named account', async () => {
  const calls = []
  const fanout = createTelegramFanout([{
    id: 'gemini',
    adapter: {
      async send(target, message) {
        calls.push({ accountId: target.accountId, message })
        return { delivered: true, messageId: 'doc-1' }
      },
    },
  }, {
    id: 'main',
    adapter: { async send() { throw new Error('main must not send') } },
  }])
  const message = buildChannelMessage({
    text: 'caption',
    file: { name: 'note.txt', mimeType: 'text/plain', localData: Buffer.from('hello file') },
  })
  const sent = await fanout.sendProactive('gemini', { conversationId: TG_USER, conversationType: 'dm' }, message)
  assert.equal(sent.messageId, 'doc-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].accountId, 'gemini')
  assert.equal(calls[0].message.parts[0].type, 'file')
  assert.equal(calls[0].message.parts[0].name, 'note.txt')
  assert.equal(Buffer.from(calls[0].message.parts[0].localData).toString(), 'hello file')
})

test('channel runtimes build proactive files with the shared document message', () => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const telegram = readFileSync(join(root, 'telegram', 'runtime.mjs'), 'utf8')
  const qq = readFileSync(join(root, 'qq', 'runtime.mjs'), 'utf8')
  assert.match(telegram, /buildChannelMessage\(payload\)/)
  assert.match(qq, /buildChannelMessage\(payload\)/)
  assert.match(telegram, /outbound-file\.mjs/)
  assert.match(qq, /outbound-file\.mjs/)
})
