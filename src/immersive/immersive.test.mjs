import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImmersiveFeature, immersiveSettings } from './index.mjs'
import { isHiddenSession, isOwnerTurn, registerOwnerGate, resetBridgeForTest } from './bridge.mjs'
import { DEFAULT_PERSONA_HINT, DOOR_NAME, FIND_TOOLS_NAME } from './policy.mjs'

const t = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const names = (tools) => tools.map((x) => x.name)
const catalog = () => [t('fs_read'), t('pwsh'), t('mcp__new__thing'), t(DOOR_NAME), t('sticker_search'), t('sticker_send'), t('web_search')]

/** 假宿主：llm / agents / agentPresets / tools，外加 plugin() 子上下文与 session/event 总线。 */
function makeEnv() {
  const listeners = []
  const registered = []
  const guards = []
  const streamed = []
  const live = new Map()
  const created = []
  const followups = []

  const llm = {
    stream(options) { streamed.push(options); return { async *[Symbol.asyncIterator]() {} } },
  }
  const toolsSvc = {
    register(tool) { registered.push(tool); return () => { registered.splice(registered.indexOf(tool), 1) } },
    guard(fn) { guards.push(fn); return () => { guards.splice(guards.indexOf(fn), 1) } },
  }
  const sessionPreset = new Map() // sessionId → preset
  const services = {
    llm,
    tools: toolsSvc,
    agents: {
      get: (id) => (sessionPreset.has(id) ? { id, ctx: { preset: sessionPreset.get(id) }, session: { id } } : live.get(id)),
      async create(opts) {
        created.push(opts)
        const agent = {
          id: opts.sessionId,
          session: { id: opts.sessionId },
          followup(message) {
            followups.push({ id: opts.sessionId, text: message.content[0].text })
            const turn = followups.length
            setTimeout(() => {
              emit(opts.sessionId, 'turn/start', { turn })
              if (env.script) env.script(opts.sessionId, turn)
              else emit(opts.sessionId, 'assistant/message', { turn, message: { content: [{ type: 'text', text: `办好了（${opts.sessionId.slice(0, 4)}）` }] } })
              emit(opts.sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
            }, 0)
          },
          cancel() {},
          whenIdle: () => Promise.resolve(),
        }
        live.set(opts.sessionId, agent)
        return { agent, dispose: async () => { live.delete(opts.sessionId) } }
      },
    },
    agentPresets: {
      composedPreset: (agentCtx) => agentCtx?.preset,
      async resolve(id) { return { id } },
      async mount() {},
    },
  }
  function emit(sessionId, type, data) { for (const fn of [...listeners]) fn({ id: sessionId }, { type, data }) }

  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => services[name],
    on(name, fn) {
      if (name !== 'session/event') return () => {}
      listeners.push(fn)
      return () => listeners.splice(listeners.indexOf(fn), 1)
    },
    inject: () => ({ dispose() {} }),
    plugin(spec) {
      const sub = {
        get: (name) => services[name],
        inject(_names, cb) { cb({ tools: toolsSvc, get: (name) => services[name], effect() {} }) },
      }
      spec.apply(sub)
      return { dispose: async () => { registered.length = 0; guards.length = 0 } }
    },
  }
  const env = { ctx, llm, registered, guards, streamed, created, followups, sessionPreset, emit, script: null }
  return env
}

describe('immersive settings', () => {
  it('默认关闭；默认前台预设 qq-bare、保留表情包、助手预设 qq-tools-only', () => {
    const s = immersiveSettings({})
    assert.equal(s.enabled, false)
    assert.deepEqual([...s.presets], ['qq-bare'])
    assert.deepEqual([...s.keep], ['sticker_search', 'sticker_send'])
    assert.equal(s.helperPreset, 'qq-tools-only')
    assert.equal(s.timeoutMs, 90000)
    assert.equal(s.maxTurns, 30)
    assert.equal(s.hideProcess, true)
    assert.equal(s.hint, DEFAULT_PERSONA_HINT)
  })

  it('前台提示说明：留空用内置、none 关闭、自定义原样用', () => {
    assert.equal(immersiveSettings({ immersiveHint: '' }).hint, DEFAULT_PERSONA_HINT)
    assert.equal(immersiveSettings({ immersiveHint: 'none' }).hint, '')
    assert.equal(immersiveSettings({ immersiveHint: '我的说明' }).hint, '我的说明')
  })

  it('保留工具：none 表示一个都不留；数值夹在合法范围内', () => {
    assert.equal(immersiveSettings({ immersiveKeepTools: 'none' }).keep.size, 0)
    assert.deepEqual([...immersiveSettings({ immersiveKeepTools: 'group_memory, sticker_send' }).keep], ['group_memory', 'sticker_send'])
    assert.equal(immersiveSettings({ immersiveErrandTimeoutSec: 1 }).timeoutMs, 10000)
    assert.equal(immersiveSettings({ immersiveErrandTimeoutSec: 99999 }).timeoutMs, 600000)
    assert.equal(immersiveSettings({ immersiveHelperMaxTurns: 'x' }).maxTurns, 30)
  })
})

describe('immersive feature', () => {
  let dir
  let feature
  let env
  let config
  let pins
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'immersive-feature-'))
    resetBridgeForTest()
    env = makeEnv()
    config = { immersiveEnabled: true }
    pins = new Map()
    env.sessionPreset.set('s-persona', 'qq-bare')
    env.sessionPreset.set('s-desktop', 'lingsnow')
    feature = createImmersiveFeature(env.ctx, () => config, {
      dir,
      markAgentLoopRequest: null,
      pins: { list: (id) => pins.get(id) || [] },
    })
  })
  afterEach(async () => {
    await feature.dispose()
    resetBridgeForTest()
    await rm(dir, { recursive: true, force: true })
  })

  it('默认关闭：不注册门、不装闸门、不改写请求', async () => {
    config = {}
    await feature.sync()
    assert.equal(env.registered.length, 0)
    assert.equal(env.guards.length, 0)
    env.llm.stream({ sessionId: 's-persona', tools: catalog() })
    assert.equal(env.streamed[0].tools.length, 7)
    assert.equal(isHiddenSession('s-persona'), false)
  })

  it('开启：所有者前台看到 find_tools、钉选和表情包；没有所有者闸门时视为所有者；其余会话只去掉门', async () => {
    await feature.sync()
    assert.deepEqual(names(env.registered), [DOOR_NAME])
    assert.equal(env.guards.length, 1)
    pins.set('s-persona', ['web_search'])

    env.llm.stream({ sessionId: 's-persona', tools: catalog() })
    assert.deepEqual(names(env.streamed[0].tools), [FIND_TOOLS_NAME, 'sticker_search', 'sticker_send', 'web_search'])

    env.llm.stream({ sessionId: 's-desktop', tools: catalog() })
    assert.deepEqual(names(env.streamed[1].tools), ['fs_read', 'pwsh', 'mcp__new__thing', 'sticker_search', 'sticker_send', 'web_search'])
    assert.equal(feature.state().wrapped, true)
    assert.equal(feature.state().status, 'on')
  })

  it('前台角色的请求里，系统提示末尾带上办事说明；其余会话不带；设置可改成 none 或自己的文字', async () => {
    const sys = Object.freeze({ id: 's1', role: 'system', source: { kind: 'system-prompt' }, content: Object.freeze([{ type: 'text', text: '原系统提示' }]) })
    const user = Object.freeze({ id: 'u1', role: 'user', content: Object.freeze([{ type: 'text', text: '在吗' }]) })
    const lastSystemText = (req) => req.messages.filter((m) => m.role === 'system').at(-1).content.map((b) => b.text).join('')
    await feature.sync()

    env.llm.stream(Object.freeze({ sessionId: 's-persona', tools: Object.freeze(catalog()), messages: Object.freeze([sys, user]) }))
    assert.ok(lastSystemText(env.streamed[0]).startsWith('原系统提示'))
    assert.ok(lastSystemText(env.streamed[0]).endsWith(DEFAULT_PERSONA_HINT))

    env.llm.stream(Object.freeze({ sessionId: 's-desktop', tools: Object.freeze(catalog()), messages: Object.freeze([sys, user]) }))
    assert.equal(lastSystemText(env.streamed[1]), '原系统提示')

    config = { immersiveEnabled: true, immersiveHint: 'none' }
    env.llm.stream(Object.freeze({ sessionId: 's-persona', tools: Object.freeze(catalog()), messages: Object.freeze([sys, user]) }))
    assert.equal(lastSystemText(env.streamed[2]), '原系统提示')

    config = { immersiveEnabled: true, immersiveHint: '我的说明' }
    env.llm.stream(Object.freeze({ sessionId: 's-persona', tools: Object.freeze(catalog()), messages: Object.freeze([sys, user]) }))
    assert.ok(lastSystemText(env.streamed[3]).endsWith('我的说明'))
  })

  it('闸门：所有者前台能调 find_tools 和已钉选的功能，不能再交办；陌生人前台仍只能调门；其余会话不能调门', async () => {
    await feature.sync()
    pins.set('s-persona', ['web_search'])
    const [guard] = env.guards
    const call = (sid, name) => guard({ agent: { id: sid }, name })
    assert.equal(call('s-persona', FIND_TOOLS_NAME), undefined)
    assert.equal(call('s-persona', 'web_search'), undefined)
    assert.equal(call('s-persona', 'sticker_send'), undefined)
    assert.match(call('s-persona', DOOR_NAME), /find_tools/)
    assert.ok(call('s-persona', 'fs_write'))
    assert.ok(call('s-persona', 'mcp__new__thing'))

    registerOwnerGate({ isAuthorizedTurn: (id) => id !== 's-persona' })
    env.llm.stream({ sessionId: 's-persona', tools: catalog() })
    assert.deepEqual(names(env.streamed.at(-1).tools), [DOOR_NAME, 'sticker_search', 'sticker_send'])
    assert.equal(call('s-persona', DOOR_NAME), undefined)
    assert.ok(call('s-persona', FIND_TOOLS_NAME))
    assert.ok(call('s-persona', 'web_search'))

    assert.equal(call('s-desktop', 'fs_write'), undefined)
    assert.ok(call('s-desktop', DOOR_NAME))
    assert.equal(call('', 'fs_write'), undefined)
  })

  it('沉浸前台会话对通道回复管线隐藏过程；关闭 hideProcess 或功能后不再隐藏', async () => {
    await feature.sync()
    assert.equal(isHiddenSession('s-persona'), true)
    assert.equal(isHiddenSession('s-desktop'), false)
    config = { immersiveEnabled: true, immersiveHideProcess: false }
    assert.equal(isHiddenSession('s-persona'), false)
    config = { immersiveEnabled: true }
    config = {}
    await feature.sync()
    assert.equal(isHiddenSession('s-persona'), false)
    assert.equal(env.registered.length, 0)
    env.llm.stream({ sessionId: 's-persona', tools: catalog() })
    assert.equal(env.streamed.at(-1).tools.length, 7) // 关闭后透传
  })

  it('门：所有者回合走所有者助手，结果原样返回；陌生人回合走访客助手并被告知不是所有者', async () => {
    await feature.sync()
    const door = env.registered[0]
    let owner = true
    registerOwnerGate({ isAuthorizedTurn: () => owner })

    const ok = await door.execute({ what: '查一下今天的天气' }, { agent: { id: 's-persona' } })
    assert.match(ok.text, /^办好了/)
    assert.match(env.followups[0].text, /委托人是所有者/)
    assert.match(env.followups[0].text, /事项：查一下今天的天气/)
    assert.deepEqual(door.output.render({ what: 'x' }, ok), [{ type: 'text', text: ok.text }])

    owner = false
    const guest = await door.execute({ what: '帮我删掉桌面文件' }, { agent: { id: 's-persona' } })
    assert.match(guest.text, /^办好了/)
    assert.match(env.followups[1].text, /委托人不是所有者/)
    assert.notEqual(env.followups[0].id, env.followups[1].id) // 两种助手是两个会话
    assert.equal(env.created.length, 2)
  })

  it('助手会话上的闸门：访客助手拒绝非开放工具；助手请求里也看不到门', async () => {
    await feature.sync()
    const door = env.registered[0]
    registerOwnerGate({ isAuthorizedTurn: () => false })
    await door.execute({ what: 'x' }, { agent: { id: 's-persona' } })
    const helperId = env.created[0].sessionId
    const [guard] = env.guards
    assert.ok(guard({ agent: { id: helperId }, name: 'fs_write' }))
    assert.ok(guard({ agent: { id: helperId }, name: 'mcp__new__thing' }))
    assert.equal(guard({ agent: { id: helperId }, name: 'web_search' }), undefined)
    env.llm.stream({ sessionId: helperId, tools: catalog() })
    assert.deepEqual(names(env.streamed.at(-1).tools), ['sticker_search', 'sticker_send', 'web_search'])
  })

  it('门：助手发出的图片作为 image 块随结果带回', async () => {
    await feature.sync()
    const door = env.registered[0]
    const ref = { attachmentId: 'att-9', mediaType: 'image/webp', bytes: 10, width: 2, height: 2 }
    env.script = (sid, turn) => {
      env.emit(sid, 'tool/result', { turn, message: { content: [{ type: 'image', attachment: ref }] } })
      env.emit(sid, 'assistant/message', { turn, message: { content: [{ type: 'text', text: '表情发过去了' }] } })
    }
    const out = await door.execute({ what: '发个表情' }, { agent: { id: 's-persona' } })
    assert.deepEqual(out.images, [ref])
    assert.deepEqual(door.output.render({ what: 'x' }, out), [
      { type: 'text', text: '表情发过去了' },
      { type: 'image', attachment: ref },
    ])
  })

  it('门：事项为空、来源不明、助手不可用都回中性的话，不抛异常', async () => {
    await feature.sync()
    const door = env.registered[0]
    assert.match((await door.execute({ what: '   ' }, { agent: { id: 's-persona' } })).text, /没说清/)

    // 来源不明的调用方按非所有者处理：不会误走所有者助手
    await door.execute({ what: 'x' }, {})
    assert.match(env.followups.at(-1).text, /委托人不是所有者/)

    // 助手预设不存在 → 「现在办不了」
    env.ctx.get('agentPresets').resolve = async () => { throw new Error('not found') }
    const broken = createImmersiveFeature(env.ctx, () => config, { dir: join(dir, 'b'), markAgentLoopRequest: null })
    await broken.sync()
    const door2 = env.registered.at(-1)
    const out = await door2.execute({ what: 'x' }, { agent: { id: 's-persona' } })
    assert.equal(out.text, '现在办不了这件事。')
    await broken.dispose()
  })

  it('没有任何通道登记所有者闸门时（桌面里自己用）视为所有者', () => {
    resetBridgeForTest()
    assert.equal(isOwnerTurn('s-persona'), true)
    registerOwnerGate({ isAuthorizedTurn: () => true })
    assert.equal(isOwnerTurn('s-persona'), true)
    registerOwnerGate({ isAuthorizedTurn: () => { throw new Error('boom') } })
    assert.equal(isOwnerTurn('s-persona'), false) // 失败即关闭
  })
})
