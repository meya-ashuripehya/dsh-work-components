import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detachImmersiveWrap, isImmersiveWrapped, rewriteOptions, wrapLlmForImmersive } from './wrap.mjs'
import { DOOR_NAME, FIND_TOOLS_NAME } from './policy.mjs'

const t = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const names = (tools) => tools.map((x) => x.name)
const ROLES = { persona: 'persona', owner: 'helper-owner', guest: 'helper-open' }
const roleOf = (sid) => ROLES[sid] ?? 'other'
const catalog = () => [t('fs_read'), t('pwsh'), t('mcp__x__y'), t(DOOR_NAME), t('sticker_send'), t('web_search')]

describe('immersive wrap · rewriteOptions', () => {
  it('前台角色：原地改写 tools，保住同一个 options 对象', () => {
    const options = { sessionId: 'persona', tools: catalog() }
    const out = rewriteOptions(options, { roleOf, keep: () => ['sticker_send'] })
    assert.equal(out, options)
    assert.deepEqual(names(options.tools), [DOOR_NAME, 'sticker_send'])
  })

  it('options 被冻结时改成拷贝，并重新打上 agent-loop 标记', () => {
    const options = Object.freeze({ sessionId: 'persona', tools: catalog() })
    const marked = []
    const out = rewriteOptions(options, { roleOf, keep: () => [], markAgentLoopRequest: (o) => marked.push(o) })
    assert.notEqual(out, options)
    assert.deepEqual(names(out.tools), [DOOR_NAME])
    assert.deepEqual(marked, [out])
    assert.equal(options.tools.length, 6) // 原对象不动
  })

  it('访客助手 / 所有者助手 / 其余会话各按角色收窄', () => {
    const guest = rewriteOptions({ sessionId: 'guest', tools: catalog() }, { roleOf })
    assert.deepEqual(names(guest.tools), ['sticker_send', 'web_search'])
    const owner = rewriteOptions({ sessionId: 'owner', tools: catalog() }, { roleOf })
    assert.deepEqual(names(owner.tools), ['fs_read', 'pwsh', 'mcp__x__y', 'sticker_send', 'web_search'])
    const other = rewriteOptions({ sessionId: 'desktop-1', tools: catalog() }, { roleOf })
    assert.deepEqual(names(other.tools), ['fs_read', 'pwsh', 'mcp__x__y', 'sticker_send', 'web_search'])
  })

  it('没有 sessionId 或没有 tools：原样返回；roleOf 抛错按 other 处理', () => {
    const noTools = { sessionId: 'persona' }
    assert.equal(rewriteOptions(noTools, { roleOf }), noTools)
    const noSession = { tools: catalog() }
    assert.equal(rewriteOptions(noSession, { roleOf }).tools.length, 5) // 只去掉门
    const boom = { sessionId: 'persona', tools: catalog() }
    assert.equal(rewriteOptions(boom, { roleOf: () => { throw new Error('x') } }).tools.length, 5)
  })

  it('所有者前台：带上 find_tools 和本会话钉选，不带门', () => {
    const options = { sessionId: 'persona', tools: catalog() }
    const out = rewriteOptions(options, {
      roleOf,
      keep: () => ['sticker_send'],
      directOf: () => true,
      pinsOf: () => ['pwsh', '不在清单里的'],
    })
    assert.equal(out, options)
    assert.deepEqual(names(options.tools), [FIND_TOOLS_NAME, 'pwsh', 'sticker_send'])
  })

  it('改写诊断回调的异常不影响请求', () => {
    const options = { sessionId: 'persona', tools: catalog() }
    rewriteOptions(options, { roleOf, onRewrite: () => { throw new Error('log down') } })
    assert.deepEqual(names(options.tools), [DOOR_NAME])
  })
})

describe('immersive wrap · 前台提示说明', () => {
  const sysMsg = Object.freeze({ id: 's1', role: 'system', source: { kind: 'system-prompt' }, content: Object.freeze([{ type: 'text', text: '原系统提示' }]) })
  const userMsg = Object.freeze({ id: 'u1', role: 'user', content: Object.freeze([{ type: 'text', text: '在吗' }]) })
  const textsOf = (message) => message.content.map((b) => b.text).join('')

  it('冻结的前台请求：tools 与 messages 一起改写成拷贝并重新打标记，原请求不动', () => {
    const request = Object.freeze({ sessionId: 'persona', tools: Object.freeze(catalog()), messages: Object.freeze([sysMsg, userMsg]) })
    const marked = []
    const seen = []
    const out = rewriteOptions(request, {
      roleOf, keep: () => [], hint: () => '【办事】说明',
      markAgentLoopRequest: (o) => marked.push(o), onRewrite: (info) => seen.push(info),
    })
    assert.notEqual(out, request)
    assert.deepEqual(names(out.tools), [DOOR_NAME])
    assert.match(textsOf(out.messages[0]), /原系统提示\n\n【办事】说明$/)
    assert.equal(out.messages[1], userMsg)
    assert.deepEqual(marked, [out])
    assert.equal(request.messages[0], sysMsg)
    assert.equal(seen[0].hinted, true)
  })

  it('工具已经收敛好时，只需要追加说明也会改写；说明已在时不再动', () => {
    const request = { sessionId: 'persona', tools: [t(DOOR_NAME)], messages: [sysMsg, userMsg] }
    const out = rewriteOptions(request, { roleOf, keep: () => [], hint: () => '说明' })
    assert.equal(out, request) // 可变请求原地改
    assert.match(textsOf(request.messages[0]), /说明$/)
    const again = rewriteOptions(request, { roleOf, keep: () => [], hint: () => '说明' })
    assert.equal(again.messages.length, 2)
    assert.equal((textsOf(again.messages[0]).match(/说明/g) || []).length, 1)
  })

  it('只有前台角色会被追加：后台助手 / 其余会话不动 messages；没有 hint 依赖或说明为空也不动', () => {
    for (const sessionId of ['owner', 'guest', 'desktop-1']) {
      const request = { sessionId, tools: catalog(), messages: [sysMsg, userMsg] }
      rewriteOptions(request, { roleOf, hint: () => '说明' })
      assert.equal(request.messages[0], sysMsg, sessionId)
    }
    const noDep = { sessionId: 'persona', tools: catalog(), messages: [sysMsg, userMsg] }
    rewriteOptions(noDep, { roleOf })
    assert.equal(noDep.messages[0], sysMsg)
    const empty = { sessionId: 'persona', tools: catalog(), messages: [sysMsg, userMsg] }
    rewriteOptions(empty, { roleOf, hint: () => '' })
    assert.equal(empty.messages[0], sysMsg)
    const boom = { sessionId: 'persona', tools: catalog(), messages: [sysMsg, userMsg] }
    rewriteOptions(boom, { roleOf, hint: () => { throw new Error('x') } })
    assert.equal(boom.messages[0], sysMsg)
  })
})

describe('immersive wrap · llm 包装', () => {
  function makeLlm(seen) {
    return {
      async prepareCall(config) {
        return Object.freeze({
          config,
          stream(options) {
            seen.push(['prepared.stream', names(options.tools)])
            return { async *[Symbol.asyncIterator]() {} }
          },
        })
      },
      stream(options) {
        seen.push(['stream', names(options.tools)])
        return { async *[Symbol.asyncIterator]() {} }
      },
      streamWithRegistration(options, prepared) {
        seen.push(['registration', names(options.tools)])
        return prepared?.stream ? prepared.stream(options) : this.stream(options)
      },
    }
  }

  it('prepareCall 之后的 prepared.stream、stream、streamWithRegistration 三条路径都改写', async () => {
    const seen = []
    const llm = makeLlm(seen)
    assert.equal(wrapLlmForImmersive(llm, { roleOf, keep: () => [] }), true)
    assert.equal(isImmersiveWrapped(llm), true)

    const prepared = await llm.prepareCall({ provider: 'p', model: 'm' })
    prepared.stream({ sessionId: 'persona', tools: catalog() })
    llm.stream({ sessionId: 'persona', tools: catalog() })
    llm.streamWithRegistration({ sessionId: 'persona', tools: catalog() }, null)
    assert.deepEqual(seen.map((s) => s[0]), ['prepared.stream', 'stream', 'registration', 'stream'])
    for (const [, toolNames] of seen) assert.deepEqual(toolNames, [DOOR_NAME])
  })

  it('重复安装不叠层；换 deps 立即生效；detach 后变成透传', () => {
    const seen = []
    const llm = makeLlm(seen)
    wrapLlmForImmersive(llm, { roleOf, keep: () => [] })
    const first = llm.stream
    wrapLlmForImmersive(llm, { roleOf: () => 'other', keep: () => [] })
    assert.equal(llm.stream, first)

    llm.stream({ sessionId: 'persona', tools: catalog() })
    assert.equal(seen[0][1].includes('fs_read'), true) // 新 deps：persona 被当成 other
    assert.equal(seen[0][1].includes(DOOR_NAME), false)

    detachImmersiveWrap(llm)
    const raw = catalog()
    llm.stream({ sessionId: 'persona', tools: raw })
    assert.equal(seen[1][1].length, raw.length) // 透传，门也不去掉
  })

  it('没有 stream 的对象装不上', () => {
    assert.equal(wrapLlmForImmersive({}, { roleOf }), false)
    assert.equal(wrapLlmForImmersive(null, { roleOf }), false)
  })
})
