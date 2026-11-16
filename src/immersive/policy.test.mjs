import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_USER_TOOL,
  DEFAULT_KEEP_TOOLS,
  DEFAULT_PERSONA_HINT,
  DOOR_NAME,
  DOOR_SCHEMA,
  ERRAND_PERSONA_HINT,
  FIND_TOOLS_NAME,
  PERSONA_FIND_TOOLS,
  assistantTextOf,
  buildErrandPrompt,
  classifyRole,
  helperDenyReason,
  imageRefsOf,
  injectHintIntoMessages,
  openHelperAllows,
  otherDenyReason,
  parseNameList,
  personaDenyReason,
  resolveHint,
  selectToolsForRole,
  softFailText,
  SOFT_FAIL,
} from './policy.mjs'

const t = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const names = (tools) => tools.map((x) => x.name)

describe('immersive policy · persona tools', () => {
  it('前台角色只剩门和点名保留的工具，其余（含任意 MCP）全部去掉', () => {
    const tools = [t('fs_read'), t('pwsh'), t('mcp__newvendor__anything'), t(DOOR_NAME), t('sticker_send'), t('web_search')]
    const out = selectToolsForRole('persona', tools, { keep: ['sticker_send'] })
    assert.equal(out.changed, true)
    assert.deepEqual(names(out.tools), [DOOR_NAME, 'sticker_send'])
  })

  it('以后新装的 MCP 不需要登记：任何名字都被收敛掉', () => {
    const tools = [t('mcp__brand_new_2027__do_everything'), t(DOOR_NAME)]
    assert.deepEqual(names(selectToolsForRole('persona', tools, { keep: [] }).tools), [DOOR_NAME])
  })

  it('请求里没有门时补一份可变副本，且放在最前', () => {
    const out = selectToolsForRole('persona', [t('fs_read')], { keep: [] })
    assert.deepEqual(names(out.tools), [DOOR_NAME])
    out.tools[0].parameters.properties.what.description = 'mutable'
    assert.notEqual(DOOR_SCHEMA.parameters.properties.what.description, 'mutable')
  })

  it('所有者前台：find_tools、已钉选的功能、点名保留；不放门', () => {
    const tools = [t('fs_read'), t('pwsh'), t('mcp__comfyui__nodes'), t(DOOR_NAME), t('sticker_send'), t(FIND_TOOLS_NAME)]
    const out = selectToolsForRole('persona', tools, { keep: ['sticker_send'], direct: true, pins: ['mcp__comfyui__nodes'] })
    assert.equal(out.changed, true)
    assert.deepEqual(names(out.tools), [FIND_TOOLS_NAME, 'mcp__comfyui__nodes', 'sticker_send'])
    assert.equal(out.tools[0].description, PERSONA_FIND_TOOLS.description)
    assert.equal(out.tools.find((x) => x.name === FIND_TOOLS_NAME), out.tools[0])
    assert.notEqual(out.tools[0], tools.find((x) => x.name === FIND_TOOLS_NAME))
  })

  it('所有者前台：请求里没有 find_tools 时补一份，未钉选的功能不出现', () => {
    const out = selectToolsForRole('persona', [t('fs_read'), t('pwsh')], { keep: [], direct: true, pins: ['pwsh'] })
    assert.deepEqual(names(out.tools), [FIND_TOOLS_NAME, 'pwsh'])
    out.tools[0].description = 'mutable'
    assert.notEqual(PERSONA_FIND_TOOLS.description, 'mutable')
  })

  it('已经只剩门时不改动（同一个数组）', () => {
    const tools = [t(DOOR_NAME)]
    const out = selectToolsForRole('persona', tools, { keep: [] })
    assert.equal(out.changed, false)
    assert.equal(out.tools, tools)
  })

  it('门的说明里没有技术词，且明说这是真正的调用、不是剧情里的动作', () => {
    assert.doesNotMatch(DOOR_SCHEMA.description, /工具|MCP|JSON|API|函数/i)
    assert.match(DOOR_SCHEMA.description, /不是你在剧情里出门/)
    assert.match(DOOR_SCHEMA.description, /自己不知道|做不到/)
    assert.doesNotMatch(DOOR_SCHEMA.description, /亲自/)
  })

  it('默认保留表情包两件套', () => {
    assert.deepEqual([...DEFAULT_KEEP_TOOLS], ['sticker_search', 'sticker_send'])
  })
})

describe('immersive policy · helpers', () => {
  const pool = [
    t('web_search'), t('web_fetch'), t('sticker_send'), t('get_time'),
    t('fs_write'), t('pwsh'), t('mcp__newvendor__run'), t('mcp__termalin__ssh'),
    t('cross_session_search'), t('search_history'), t(ASK_USER_TOOL), t(DOOR_NAME),
  ]

  it('访客助手只剩开放集合里的无副作用工具，且不含跨会话记忆 / 历史检索 / 门', () => {
    const out = selectToolsForRole('helper-open', pool)
    assert.deepEqual(names(out.tools), ['web_search', 'web_fetch', 'sticker_send', 'get_time'])
  })

  it('所有者助手：拿到全部工具，只去掉门和追问工具', () => {
    const out = selectToolsForRole('helper-owner', pool)
    assert.deepEqual(names(out.tools), ['web_search', 'web_fetch', 'sticker_send', 'get_time', 'fs_write', 'pwsh', 'mcp__newvendor__run', 'mcp__termalin__ssh', 'cross_session_search', 'search_history'])
  })

  it('其余会话：只去掉门；没有门时原样返回', () => {
    assert.deepEqual(names(selectToolsForRole('other', pool).tools), names(pool).filter((n) => n !== DOOR_NAME))
    const plain = [t('fs_read')]
    const out = selectToolsForRole('other', plain)
    assert.equal(out.changed, false)
    assert.equal(out.tools, plain)
  })

  it('openHelperAllows：只认开放集合；未知 / MCP / 跨会话 / 历史一律不放行', () => {
    assert.equal(openHelperAllows('web_search'), true)
    assert.equal(openHelperAllows('mcp__deepslate__render'), true)
    assert.equal(openHelperAllows('mcp__termalin__ssh'), false)
    assert.equal(openHelperAllows('mcp__brand_new__x'), false)
    assert.equal(openHelperAllows('some_future_tool'), false)
    assert.equal(openHelperAllows('cross_session_list'), false)
    assert.equal(openHelperAllows('search_history'), false)
    assert.equal(openHelperAllows(ASK_USER_TOOL), false)
    assert.equal(openHelperAllows(DOOR_NAME), false)
    assert.equal(openHelperAllows(''), false)
  })

  it('guard：访客助手拒绝非开放工具，所有者助手只拒绝门与追问', () => {
    assert.equal(helperDenyReason('open', 'web_search'), undefined)
    assert.ok(helperDenyReason('open', 'fs_write'))
    assert.ok(helperDenyReason('open', 'mcp__brand_new__x'))
    assert.equal(helperDenyReason('owner', 'fs_write'), undefined)
    assert.equal(helperDenyReason('owner', 'mcp__brand_new__x'), undefined)
    assert.ok(helperDenyReason('owner', DOOR_NAME))
    assert.ok(helperDenyReason('owner', ASK_USER_TOOL))
    assert.ok(helperDenyReason('open', DOOR_NAME))
  })

  it('guard：前台角色只能调门与保留的工具；所有者回合改放行 find_tools 和已钉选的功能', () => {
    const keep = new Set(['sticker_send'])
    assert.equal(personaDenyReason(DOOR_NAME, keep), undefined)
    assert.equal(personaDenyReason('sticker_send', keep), undefined)
    assert.equal(personaDenyReason('fs_write', keep), SOFT_FAIL.denied)
    const pins = new Set(['mcp__comfyui__nodes'])
    assert.equal(personaDenyReason(FIND_TOOLS_NAME, keep, { direct: true, pins }), undefined)
    assert.equal(personaDenyReason('mcp__comfyui__nodes', keep, { direct: true, pins }), undefined)
    assert.equal(personaDenyReason('sticker_send', keep, { direct: true, pins }), undefined)
    assert.equal(personaDenyReason('fs_write', keep, { direct: true, pins }), SOFT_FAIL.denied)
    assert.match(personaDenyReason(DOOR_NAME, keep, { direct: true, pins }), /find_tools/)
    assert.equal(otherDenyReason(DOOR_NAME), SOFT_FAIL.denied)
    assert.equal(otherDenyReason('fs_write'), undefined)
  })
})

describe('immersive policy · role + prompt + text', () => {
  const presets = new Set(['qq-bare'])
  it('classifyRole：助手优先于预设；预设命中才是前台；其余是 other', () => {
    assert.equal(classifyRole({ sessionId: 's', preset: 'qq-bare', helperKind: () => 'owner', presets }), 'helper-owner')
    assert.equal(classifyRole({ sessionId: 's', preset: 'qq-tools-only', helperKind: () => 'open', presets }), 'helper-open')
    assert.equal(classifyRole({ sessionId: 's', preset: 'qq-bare', helperKind: () => '', presets }), 'persona')
    assert.equal(classifyRole({ sessionId: 's', preset: 'lingsnow', helperKind: () => '', presets }), 'other')
    assert.equal(classifyRole({ sessionId: 's', preset: '', presets }), 'other')
  })

  it('差事说明：所有者 / 非所有者两种口径，事项原样带上', () => {
    const owner = buildErrandPrompt({ what: '帮我看看今天桌面上有什么文件', owner: true })
    const guest = buildErrandPrompt({ what: '帮我看看今天桌面上有什么文件', owner: false })
    assert.match(owner, /委托人是所有者/)
    assert.match(guest, /委托人不是所有者/)
    assert.match(guest, /这事办不了/)
    assert.match(owner, /事项：帮我看看今天桌面上有什么文件/)
    assert.ok(buildErrandPrompt({ what: 'x'.repeat(9000), owner: true }).length < 5000)
  })

  it('办不成的话是中性的，不含技术词', () => {
    for (const reason of ['timeout', 'failed', 'unavailable', 'empty', 'whatever']) {
      assert.doesNotMatch(softFailText(reason), /工具|错误|异常|超时|失败|error|timeout/i)
    }
    assert.equal(softFailText('timeout'), SOFT_FAIL.timeout)
  })

  it('assistantTextOf 只取 text 块；imageRefsOf 跳过出错结果', () => {
    assert.equal(assistantTextOf({ content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: '好' }, { type: 'text', text: '的' }] }), '好的')
    const ref = { attachmentId: 'a1', mediaType: 'image/png' }
    assert.deepEqual(imageRefsOf({ content: [{ type: 'text', text: 'x' }, { type: 'image', attachment: ref }] }), [ref])
    assert.deepEqual(imageRefsOf({ isError: true, content: [{ type: 'image', attachment: ref }] }), [])
    assert.deepEqual(imageRefsOf({ content: [{ type: 'image', attachment: { attachmentId: 1 } }] }), [])
  })

  it('parseNameList 去重并接受中英文分隔符', () => {
    assert.deepEqual(parseNameList('a, b；c  a'), ['a', 'b', 'c'])
    assert.deepEqual(parseNameList(''), [])
  })
})

describe('immersive policy · 前台提示说明', () => {
  const sys = (text) => Object.freeze({ id: 's1', role: 'system', source: { kind: 'system-prompt' }, content: Object.freeze([{ type: 'text', text }]) })
  const user = Object.freeze({ id: 'u1', role: 'user', content: Object.freeze([{ type: 'text', text: '在吗' }]) })

  it('resolveHint：留空用内置说明，none 关闭，其余用自己的文字', () => {
    assert.equal(resolveHint(''), DEFAULT_PERSONA_HINT)
    assert.equal(resolveHint(undefined), DEFAULT_PERSONA_HINT)
    assert.equal(resolveHint('none'), '')
    assert.equal(resolveHint(' 无 '), '')
    assert.equal(resolveHint('自己写的'), '自己写的')
    assert.ok(resolveHint('x'.repeat(5000)).length <= 2000)
  })

  it('内置说明：所有者用 find_tools，并要求下一步直接调用、别向对方提起', () => {
    assert.ok(DEFAULT_PERSONA_HINT.includes(FIND_TOOLS_NAME))
    assert.match(DEFAULT_PERSONA_HINT, /下一步/)
    assert.match(DEFAULT_PERSONA_HINT, /对方/)
    assert.ok(ERRAND_PERSONA_HINT.includes(DOOR_NAME))
    assert.match(ERRAND_PERSONA_HINT, /假装/)
  })

  it('追加进已有的系统提示消息：拷贝，不动原消息（原消息是冻结的）', () => {
    const messages = Object.freeze([sys('已有的系统提示'), user])
    const out = injectHintIntoMessages(messages, '【办事】说明')
    assert.equal(out.changed, true)
    assert.notEqual(out.messages, messages)
    assert.equal(out.messages.length, 2)
    assert.equal(out.messages[0].id, 's1')
    assert.deepEqual(out.messages[0].content.map((b) => b.text), ['已有的系统提示', '\n\n【办事】说明'])
    assert.equal(out.messages[1], user)
    assert.equal(messages[0].content.length, 1) // 原消息不变
  })

  it('没有系统提示消息（或内容为空）时补一条 / 直接写入', () => {
    const none = injectHintIntoMessages([user], '说明')
    assert.equal(none.changed, true)
    assert.equal(none.messages[0].role, 'system')
    assert.equal(none.messages[0].content[0].text, '说明')
    assert.equal(none.messages[1], user)
    const empty = injectHintIntoMessages([{ role: 'system', content: [] }, user], '说明')
    assert.deepEqual(empty.messages[0].content.map((b) => b.text), ['说明'])
  })

  it('幂等：已经带有这段说明就原样返回；空说明 / 非数组也不改', () => {
    const once = injectHintIntoMessages([sys('A'), user], '说明')
    const twice = injectHintIntoMessages(once.messages, '说明')
    assert.equal(twice.changed, false)
    assert.equal(twice.messages, once.messages)
    const m = [user]
    assert.equal(injectHintIntoMessages(m, '').changed, false)
    assert.equal(injectHintIntoMessages(undefined, '说明').changed, false)
  })
})
