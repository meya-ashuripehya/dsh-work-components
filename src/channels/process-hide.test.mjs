import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installProcessHide } from './process-hide.mjs'
import { resetBridgeForTest, setHiddenPredicate } from '../immersive/bridge.mjs'

function makeRouter() {
  return class FakeReplyRouter {
    constructor() { this.seen = [] }
    replyOpts() { return { updateIntervalMs: 200, sendReasoning: true, showToolCalls: true, reasoningMaxChars: 1500 } }
    onSessionEvent(session, event) { this.seen.push({ via: 'event', id: String(session.id), type: event.type, opts: this.replyOpts() }) }
    onAssistantStream(agent, frame) { this.seen.push({ via: 'stream', id: String(agent.session.id), type: frame.type, opts: this.replyOpts() }) }
  }
}

describe('channels/process-hide', () => {
  beforeEach(() => resetBridgeForTest())

  it('沉浸前台会话：处理其事件期间工具调用 / 思考过程都不显示，其余选项不变', () => {
    const Router = makeRouter()
    installProcessHide(Router)
    setHiddenPredicate((sid) => sid === 'persona')
    const r = new Router()
    r.onSessionEvent({ id: 'persona' }, { type: 'tool/call' })
    r.onAssistantStream({ session: { id: 'persona' } }, { type: 'chunk' })
    assert.equal(r.seen[0].opts.showToolCalls, false)
    assert.equal(r.seen[0].opts.sendReasoning, false)
    assert.equal(r.seen[0].opts.updateIntervalMs, 200)
    assert.equal(r.seen[1].opts.showToolCalls, false)
    assert.equal(r.seen[1].opts.sendReasoning, false)
  })

  it('其他会话照旧；处理完后标记还原，不会泄漏给下一个会话', () => {
    const Router = makeRouter()
    installProcessHide(Router)
    setHiddenPredicate((sid) => sid === 'persona')
    const r = new Router()
    r.onSessionEvent({ id: 'persona' }, { type: 'a' })
    r.onSessionEvent({ id: 'lingsnow' }, { type: 'b' })
    assert.equal(r.seen[1].opts.showToolCalls, true)
    assert.equal(r.seen[1].opts.sendReasoning, true)
    assert.equal(r.replyOpts().showToolCalls, true) // 事件之外也不受影响
  })

  it('只装一次；没有登记判断函数 / 判断函数抛错时一律不隐藏', () => {
    const Router = makeRouter()
    installProcessHide(Router)
    const patched = Router.prototype.onSessionEvent
    installProcessHide(Router)
    assert.equal(Router.prototype.onSessionEvent, patched)

    const r = new Router()
    r.onSessionEvent({ id: 'persona' }, { type: 'a' })
    assert.equal(r.seen[0].opts.showToolCalls, true)
    setHiddenPredicate(() => { throw new Error('boom') })
    r.onSessionEvent({ id: 'persona' }, { type: 'b' })
    assert.equal(r.seen[1].opts.showToolCalls, true)
  })

  it('缺少预期方法的类（上游改名）不打补丁、不抛错', () => {
    class Odd { replyOpts() { return {} } }
    installProcessHide(Odd)
    assert.equal(Odd.prototype.__dshProcessHide, undefined)
    installProcessHide(undefined)
  })

  it('事件处理抛错时标记同样还原', () => {
    class Throwing {
      replyOpts() { return { showToolCalls: true, sendReasoning: true } }
      onSessionEvent() { throw new Error('boom') }
      onAssistantStream() {}
    }
    installProcessHide(Throwing)
    setHiddenPredicate(() => true)
    const r = new Throwing()
    assert.throws(() => r.onSessionEvent({ id: 'persona' }, { type: 'x' }), /boom/)
    assert.equal(r.replyOpts().showToolCalls, true)
  })
})
