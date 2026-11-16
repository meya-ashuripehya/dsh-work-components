import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelperPool } from './helper.mjs'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假宿主：agents / agentPresets / sessionTitle + session/event 总线。 */
function makeHost({ presetOk = true, script } = {}) {
  const listeners = []
  const live = new Map()
  const log = { created: [], resumed: [], disposed: [], cancelled: [], followups: [], renamed: [] }
  let turnCounter = 0

  const ctx = {
    logger: { warn() {}, info() {} },
    on(name, fn) {
      if (name !== 'session/event') return () => {}
      listeners.push(fn)
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
    },
    emit(sessionId, type, data) { for (const fn of [...listeners]) fn({ id: sessionId }, { type, data }) },
    get(name) { return services[name] },
  }

  function makeAgent(id) {
    return {
      id,
      session: { id },
      followup(message) {
        log.followups.push({ id, message })
        const turn = ++turnCounter
        const run = script ?? (async ({ emit }) => {
          emit('turn/start', { turn })
          emit('assistant/message', { turn, message: { content: [{ type: 'text', text: '好的，我去看看' }] } })
          emit('assistant/message', { turn, message: { content: [{ type: 'text', text: '查到了：今天晴。' }] } })
          emit('turn/end', { turn, reason: { kind: 'completed' } })
        })
        setTimeout(() => {
          void run({ turn, message, emit: (type, data) => ctx.emit(id, type, data), agentId: id })
        }, 0)
      },
      cancel(reason, opts) {
        log.cancelled.push({ id, reason, opts })
        setTimeout(() => ctx.emit(id, 'turn/end', { turn: turnCounter, reason: { kind: 'interrupted' } }), 0)
      },
      whenIdle: () => Promise.resolve(),
    }
  }

  const services = {
    agents: {
      async create(opts) {
        const agent = makeAgent(opts.sessionId)
        live.set(opts.sessionId, agent)
        log.created.push(opts)
        return { agent, dispose: async () => { log.disposed.push(opts.sessionId); live.delete(opts.sessionId) } }
      },
      async resume(opts) {
        const agent = makeAgent(opts.resumeSessionId)
        live.set(opts.resumeSessionId, agent)
        log.resumed.push(opts)
        return { agent, dispose: async () => { log.disposed.push(opts.resumeSessionId); live.delete(opts.resumeSessionId) } }
      },
      get(id) { return live.get(id) },
    },
    agentPresets: {
      async resolve(id) { if (!presetOk) throw new Error('not found'); return { id } },
      async mount() {},
    },
    sessionTitle: { rename(_session, title) { log.renamed.push(title) } },
  }
  return { ctx, log, live, services }
}

describe('immersive helper pool', () => {
  let dir
  let pool
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'immersive-')) })
  afterEach(async () => {
    try { await pool?.dispose() } catch {}
    await rm(dir, { recursive: true, force: true })
  })

  const settings = (extra = {}) => () => ({ helperPreset: 'qq-tools-only', maxTurns: 30, ...extra })

  it('新建助手会话：指定预设、cwd、seed、可见标题；返回最后一段文字', async () => {
    const host = makeHost()
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const out = await pool.ask('owner', '【差事】查天气', { timeoutMs: 2000 })
    assert.equal(out.ok, true)
    assert.equal(out.text, '查到了：今天晴。')
    assert.equal(host.log.created.length, 1)
    const created = host.log.created[0]
    assert.equal(created.meta.agentPreset, 'qq-tools-only')
    assert.ok(created.meta.cwd.endsWith('workspace'))
    assert.equal(created.seed.length, 2)
    assert.equal(typeof created.setup, 'function')
    assert.deepEqual(host.log.renamed, ['后台助手（所有者）'])
    assert.equal(pool.kindOf(created.sessionId), 'owner')
    assert.equal(pool.kindOf('other-session'), '')
    // 差事原文原样交给助手，且是普通用户消息
    const sent = host.log.followups[0].message
    assert.equal(sent.role, 'user')
    assert.equal(sent.content[0].text, '【差事】查天气')
    assert.ok(sent.id)
    assert.deepEqual(sent.source, { kind: 'user' })
  })

  it('所有者 / 访客各自一个会话，互不混用', async () => {
    const host = makeHost()
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    await pool.ask('owner', 'a', { timeoutMs: 2000 })
    await pool.ask('open', 'b', { timeoutMs: 2000 })
    await pool.ask('owner', 'c', { timeoutMs: 2000 })
    assert.equal(host.log.created.length, 2)
    const [first, second] = host.log.created
    assert.equal(pool.kindOf(first.sessionId), 'owner')
    assert.equal(pool.kindOf(second.sessionId), 'open')
    assert.deepEqual(host.log.followups.map((f) => f.id), [first.sessionId, second.sessionId, first.sessionId])
  })

  it('收集工具结果里的图片（去重）并随结果带回', async () => {
    const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
    const host = makeHost({
      script: async ({ turn, emit }) => {
        emit('turn/start', { turn })
        emit('tool/result', { turn, message: { content: [{ type: 'text', text: 'sent' }, { type: 'image', attachment: ref }] } })
        emit('tool/result', { turn, message: { content: [{ type: 'image', attachment: ref }] } })
        emit('tool/result', { turn, message: { isError: true, content: [{ type: 'image', attachment: { attachmentId: 'bad', mediaType: 'image/png' } }] } })
        emit('assistant/message', { turn, message: { content: [{ type: 'text', text: '发给你了' }] } })
        emit('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const out = await pool.ask('owner', 'x', { timeoutMs: 2000 })
    assert.equal(out.ok, true)
    assert.deepEqual(out.images, [ref])
  })

  it('同一种助手的差事排队：前一件办完才开始下一件', async () => {
    const order = []
    const host = makeHost({
      script: async ({ turn, message, emit }) => {
        const text = message.content[0].text
        order.push(`start:${text}`)
        emit('turn/start', { turn })
        await tick(20)
        emit('assistant/message', { turn, message: { content: [{ type: 'text', text: `done ${text}` }] } })
        order.push(`end:${text}`)
        emit('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const [a, b] = await Promise.all([
      pool.ask('owner', 'A', { timeoutMs: 3000 }),
      pool.ask('owner', 'B', { timeoutMs: 3000 }),
    ])
    assert.equal(a.text, 'done A')
    assert.equal(b.text, 'done B')
    assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('超时：返回 timeout 并取消那一轮；迟到的 turn/end 不会误结束下一件差事', async () => {
    let n = 0
    const host = makeHost({
      script: async ({ turn, emit }) => {
        n += 1
        if (n === 1) return // 第一件永远不回
        emit('turn/start', { turn })
        await tick(30)
        emit('assistant/message', { turn, message: { content: [{ type: 'text', text: '第二件办好了' }] } })
        emit('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const first = await pool.ask('owner', 'slow', { timeoutMs: 250 })
    assert.equal(first.ok, false)
    assert.equal(first.reason, 'timeout')
    assert.equal(host.log.cancelled.length, 1)
    // 取消触发的 interrupted turn/end 会稍后到达；第二件差事必须等到自己的结果
    const second = await pool.ask('owner', 'fast', { timeoutMs: 2000 })
    assert.equal(second.ok, true)
    assert.equal(second.text, '第二件办好了')
  })

  it('轮次被中断且没有文字 → 失败，不把半截旁白当结果', async () => {
    const host = makeHost({
      script: async ({ turn, emit }) => {
        emit('turn/start', { turn })
        emit('assistant/message', { turn, message: { content: [{ type: 'text', text: '我先试试' }] } })
        emit('turn/end', { turn, reason: { kind: 'interrupted' } })
      },
    })
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const out = await pool.ask('open', 'x', { timeoutMs: 2000 })
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'failed')
  })

  it('助手预设不存在 → unavailable，不抛异常', async () => {
    const host = makeHost({ presetOk: false })
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const out = await pool.ask('owner', 'x', { timeoutMs: 2000 })
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'unavailable')
    assert.equal(host.log.created.length, 0)
  })

  it('满 maxTurns 后换新会话；旧会话仍认得是助手', async () => {
    const host = makeHost()
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings({ maxTurns: 5 }), idleWaitMs: 5 })
    for (let i = 0; i < 6; i += 1) await pool.ask('owner', `q${i}`, { timeoutMs: 2000 })
    assert.equal(host.log.created.length, 2)
    const [old, fresh] = host.log.created
    assert.notEqual(old.sessionId, fresh.sessionId)
    assert.deepEqual(host.log.disposed, [old.sessionId])
    assert.equal(pool.kindOf(old.sessionId), 'owner')
    assert.equal(pool.kindOf(fresh.sessionId), 'owner')
  })

  it('重启后：helpers.json 让助手在被 resume 之前就能被认出，并 resume 原会话', async () => {
    const host = makeHost()
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    await pool.ask('open', 'a', { timeoutMs: 2000 })
    const sessionId = host.log.created[0].sessionId
    await pool.dispose()
    const saved = JSON.parse(await readFile(join(dir, 'helpers.json'), 'utf8'))
    assert.equal(saved.current.open.sessionId, sessionId)
    assert.equal(saved.current.open.turns, 1)

    const host2 = makeHost()
    pool = createHelperPool({ ctx: host2.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    assert.equal(pool.kindOf(sessionId), 'open') // 还没 resume 就已能分类
    const out = await pool.ask('open', 'b', { timeoutMs: 2000 })
    assert.equal(out.ok, true)
    assert.equal(host2.log.created.length, 0)
    assert.equal(host2.log.resumed.length, 1)
    assert.equal(host2.log.resumed[0].resumeSessionId, sessionId)
  })

  it('resume 失败时退回新建，而不是让差事失败', async () => {
    const host = makeHost()
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    await pool.ask('owner', 'a', { timeoutMs: 2000 })
    await pool.dispose()

    const host2 = makeHost()
    host2.services.agents.resume = async () => { throw new Error('session not found') }
    pool = createHelperPool({ ctx: host2.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    const out = await pool.ask('owner', 'b', { timeoutMs: 2000 })
    assert.equal(out.ok, true)
    assert.equal(host2.log.created.length, 1)
  })

  it('dispose 后 ask 直接返回 unavailable，且移除事件监听', async () => {
    const host = makeHost()
    pool = createHelperPool({ ctx: host.ctx, dir, getSettings: settings(), idleWaitMs: 5 })
    await pool.dispose()
    const out = await pool.ask('owner', 'x', { timeoutMs: 2000 })
    assert.equal(out.reason, 'unavailable')
  })
})
