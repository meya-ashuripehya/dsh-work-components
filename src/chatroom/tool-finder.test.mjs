import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSelection, selectorPrompt, listCatalog, selectTools, FIND_TOOLS_NAME } from './tool-selector.mjs'
import { addLru, createToolsets } from './toolset.mjs'
import { isOwnerMessage, allowedNames, denyReason, DENY_MESSAGE } from './tool-gate.mjs'
import { previewText, pageText, createToolResults } from './tool-results.mjs'
import { createChatroomTools, resolveFinder } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { toLlmMessages } from './providers.mjs'
import { toolSummaryLine } from './cursor.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-tf-'))

test('selector: parses JSON, drops unknown names, caps at 3, tolerates fences / prose', () => {
  const names = ['read_file', 'web_search', 'a', 'b', 'c']
  assert.deepEqual(parseSelection('{"tools":["read_file","nope","web_search"],"reason":"x"}', names).tools, ['read_file', 'web_search'])
  assert.deepEqual(parseSelection('{"tools":["read_file","nope"]}', names).rejected, ['nope'])
  assert.deepEqual(parseSelection('```json\n{"tools":["a","b","c","read_file"]}\n```', names).tools, ['a', 'b', 'c'])
  assert.deepEqual(parseSelection('Sure! {"tools": [{"name":"a"}, "a"], "reason": "has } brace"} done', names).tools, ['a'])
  assert.deepEqual(parseSelection('["b"]', names).tools, ['b'])
  const bad = parseSelection('no json here', names)
  assert.deepEqual(bad.tools, []); assert.ok(bad.error)
  const p = selectorPrompt('read a file', [{ name: 'read_file', description: 'Read\na file' }], { current: ['x'] })
  assert.match(p.user, /- read_file: Read a file/); assert.match(p.user, /Current toolset: x/)
})

test('catalog excludes room-internal and session-bound tools', () => {
  const tools = { schemas: () => [{ name: 'find_tools' }, { name: 'read_file', description: 'r', parameters: { type: 'object' } }, { name: 'ask_user_question' }, { name: 'read_file' }, { name: 'mcp__gamebot-minecraft__gamebot_connect', description: 'legacy' }, { name: 'mc_connect', description: 'npc', parameters: { type: 'object' } }] }
  assert.deepEqual(listCatalog(tools).map((t) => t.name), ['read_file', 'mc_connect'])
})

test('member turns always see mc_* and never the legacy gamebot bridge', async () => {
  const dir = await tmp()
  try {
    const tk = createChatroomTools({
      roomDir: (id) => join(dir, id),
      getTools: () => ({
        schemas: () => [
          { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } },
          { name: 'mcp__gamebot-minecraft__gamebot_connect', description: 'legacy', parameters: { type: 'object', properties: {} } },
          { name: 'mc_connect', description: 'connect your npc', parameters: { type: 'object', properties: {} } },
          { name: 'run_shell', description: 'shell', parameters: { type: 'object', properties: {} } },
        ],
      }),
      getLlm: () => null,
      getSettings: () => ({ enabled: true }),
    })
    await tk.toolsets.add('room', ['mcp__gamebot-minecraft__gamebot_connect', 'run_shell', 'web_search'], { max: 12 })
    const member = (await tk.schemas('room', { owner: false })).map((t) => t.name)
    assert.ok(member.includes('mc_connect'))
    assert.ok(member.includes('web_search'))
    assert.ok(!member.includes('run_shell'))
    assert.ok(!member.some((name) => name.startsWith('mcp__gamebot')))
    const owner = (await tk.schemas('room', { owner: true })).map((t) => t.name)
    assert.ok(owner.includes('mc_connect'))
    assert.ok(owner.includes('run_shell'))
    assert.ok(!owner.some((name) => name.startsWith('mcp__gamebot')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('selectTools uses llm.stream text (no tool calling) with the configured provider/model', async () => {
  let req
  const llm = { stream: (r) => { req = r; return (async function* () { yield { type: 'text-delta', text: '{"tools":["web_search"]}' }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
  const r = await selectTools({ llm, provider: 'deepseek', model: 'deepseek-flash', query: 'search', catalog: [{ name: 'web_search', description: 'w' }] })
  assert.deepEqual(r.tools, ['web_search'])
  assert.equal(req.provider, 'deepseek'); assert.equal(req.model, 'deepseek-flash'); assert.equal(req.tools, undefined)
})

test('toolset LRU: refresh existing, evict least recently used, keep fresh additions', async () => {
  let list = []
  list = addLru(list, ['a', 'b'], { max: 3, now: 1 }).list
  list = addLru(list, ['c'], { max: 3, now: 2 }).list
  list = addLru(list, ['a'], { max: 3, now: 3 }).list // a refreshed
  const r = addLru(list, ['d', 'e'], { max: 3, now: 4 })
  assert.deepEqual(r.evicted.sort(), ['b', 'c'])
  assert.deepEqual(r.list.map((x) => x.name).sort(), ['a', 'd', 'e'])
  assert.deepEqual(r.added, ['d', 'e'])
  const dir = await tmp()
  try {
    const ts = createToolsets((id) => join(dir, id))
    await ts.add('r1', ['x', 'y'], { max: 12 })
    assert.equal((await ts.list('r1')).length, 2)
    assert.equal(await ts.remove('r1', 'x'), true)
    assert.equal(await ts.clear('r1'), 1)
    assert.deepEqual(await ts.list('r1'), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('gate: local = owner, telegram only the owner id; non-owner only gets OPEN_TOOLS', () => {
  assert.equal(isOwnerMessage({ kind: 'user', source: 'local' }, '9000000001'), true)
  assert.equal(isOwnerMessage({ kind: 'user', source: 'telegram', owner: true, speaker: { id: 'tg:9000000001' } }, '9000000001'), true)
  assert.equal(isOwnerMessage({ kind: 'user', source: 'telegram', owner: false, speaker: { id: 'tg:42' } }, '9000000001'), false)
  assert.equal(isOwnerMessage({ kind: 'user', source: 'telegram', owner: true, speaker: { id: 'tg:42' } }, '9000000001'), false)
  assert.deepEqual(allowedNames(['web_search', 'run_shell'], false), ['web_search'])
  assert.deepEqual(allowedNames(['web_search', 'run_shell'], true), ['web_search', 'run_shell'])
  assert.equal(denyReason('run_shell', { owner: false, inToolset: true }), DENY_MESSAGE)
  assert.equal(denyReason('run_shell', { owner: true, inToolset: true }), null)
  assert.match(denyReason('run_shell', { owner: true, inToolset: false }), /find_tools/)
  assert.match(denyReason('mcp__gamebot-minecraft__gamebot_connect', { owner: true, inToolset: true }), /mc_/)
  assert.equal(denyReason('mc_act', { owner: false, inToolset: false, gameTurn: false }), null)
  assert.deepEqual(allowedNames(['web_search', 'mcp__gamebot-minecraft__gamebot_observe', 'run_shell'], true), ['web_search', 'run_shell'])
})

test('results: preview head+tail, paging, grep, dedupe, aging plan', async () => {
  const long = 'A'.repeat(1500) + 'MIDDLE' + 'Z'.repeat(1500)
  const pv = previewText(long, { id: 'rabc123' })
  assert.ok(pv.startsWith('A'.repeat(1200))); assert.ok(pv.endsWith('Z'.repeat(400))); assert.match(pv, /open_card\("rabc123"/)
  assert.equal(previewText('short'), 'short')
  assert.ok(previewText(long, { cap: 400 }).length < 600)
  const pg = pageText('0123456789', { offset: 2, limit: 100 })
  assert.equal(pg.text, '23456789'); assert.equal(pg.next, null)
  const g = pageText('alpha\nbeta\nAlphabet', { grep: 'alpha' })
  assert.equal(g.matches, 2); assert.match(g.text, /^1: alpha/)
  const dir = await tmp()
  try {
    const res = createToolResults((id) => join(dir, id))
    const a = await res.save('r1', { tool: 't', args: '{}', text: long })
    const b = await res.save('r1', { tool: 't', args: '{}', text: long })
    assert.equal(b.dedupeOf, a.id)
    const c = await res.save('r1', { tool: 't', args: '{"x":1}', text: long })
    assert.notEqual(c.id, a.id)
    const r = await res.read('r1', a.id, { offset: 1500, limit: 100 })
    assert.ok(r.text.startsWith('MIDDLEZ'))
    assert.equal((await res.read('r1', '../etc')).ok, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('prompt renders tool results as card titles (no preview) and adds the card rule', () => {
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm' }] })
  const messages = [
    { id: 1, seq: 1, kind: 'user', text: 'hi', speaker: { name: 'Shiro' } },
    { id: 2, seq: 2, kind: 'tool', tool: 'web_search', speaker: { name: 'DeepSeek' }, text: 'found', data: { resultId: 'rabc001', args: '{"query":"pikafish"}', preview: 'PREVIEWTEXT\n' + 'p'.repeat(200), chars: 2400 } },
  ]
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages, toolsInfo: { owner: true } })
  assert.match(p.messages[0].content, /\[card #rabc001 by DeepSeek · 网页搜索 · pikafish · 2\.4k 字\]/)
  assert.doesNotMatch(p.messages[0].content, /PREVIEWTEXT/)
  assert.match(p.system, /Use tools when they'd actually help/); assert.match(p.system, /answer sheet the world handed back/); assert.match(p.system, /open_card/)
  assert.doesNotMatch(p.system, /Tools are optional helpers/)
})

test('providers: tool results are role "tool" messages (DSH createToolResultMessage shape); replayState rides the assistant source', () => {
  const seat = { provider: 'deepseek', model: 'm' }
  const [a, u, plain] = toLlmMessages(seat, [
    { role: 'assistant', blocks: [{ type: 'reasoning', text: 'r' }, { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }], replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'm' }, blocks: [{ type: 'reasoning', signature: 's' }, { type: 'tool-call' }] } },
    { role: 'user', toolResult: { toolCallId: 'c1', text: 'out', isError: true } },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(a.content[1].type, 'tool-call'); assert.equal(a.source.kind, 'model'); assert.equal(a.source.replayState.blocks[0].signature, 's')
  assert.equal(u.role, 'tool'); assert.equal(u.toolCallId, 'c1'); assert.equal(u.isError, true)
  assert.deepEqual(u.content, [{ type: 'text', text: 'out' }]); assert.deepEqual(u.source, { kind: 'tool', callId: 'c1' })
  assert.ok(!u.content.some((b) => b.type === 'tool-result'))
  assert.equal(plain.role, 'user'); assert.equal(plain.source.replayState, undefined)
})

// 按 DSH 适配器的序列化规则检查（摘自 dsh-llm-deepseek serialize 与 dsh-llm-pi-ai 的 role 'tool' 分支）
function deepseekWire(messages) {
  const out = []
  for (const m of messages) {
    let content
    if (m.role === 'assistant') content = m.content.map((b) => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'reasoning' ? { type: 'thinking', thinking: b.text } : b.type === 'tool-call' ? { type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(b.arguments || '{}') } : (() => { throw new Error('cannot represent assistant ' + b.type) })())
    else if (m.role === 'tool') content = [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
    else content = m.content.map((b) => { if (b.type !== 'text') throw new Error('DeepSeek Messages cannot represent user/tool-result content ' + b.type); return b })
    const role = m.role === 'tool' ? 'user' : m.role
    const prev = out.at(-1)
    if (prev?.role === role) prev.content.push(...content); else out.push({ role, content })
  }
  let pending = new Set()
  for (const m of out) {
    if (m.role === 'assistant') pending = new Set(m.content.filter((b) => b.type === 'tool_use').map((b) => b.id))
    else { for (const r of m.content.filter((b) => b.type === 'tool_result')) if (!pending.delete(r.tool_use_id)) throw new Error('no matching call'); if (pending.size) throw new Error('need immediate results') }
  }
  return out
}
function piAiWire(messages) {
  const names = new Map()
  return messages.map((m) => {
    if (m.role === 'assistant') { for (const b of m.content) if (b.type === 'tool-call') names.set(b.id, b.name); return { role: 'assistant' } }
    if (m.role === 'tool') return { role: 'toolResult', toolCallId: m.toolCallId, toolName: names.get(m.toolCallId) ?? 'unknown', isError: m.isError }
    if (m.content.some((b) => b.type === 'tool-result')) throw new Error('pi-ai: tool-result inside user content is not a tool result')
    return { role: 'user' }
  })
}

for (const provider of ['deepseek', 'anthropic', 'openai', 'google', 'xai']) {
  test(`providers (${provider}): multi-step loop history serializes with the adapter rules`, () => {
    const seat = { provider, model: 'm' }
    const msgs = toLlmMessages(seat, [
      { role: 'user', content: '[Shiro] 读文件' },
      { role: 'assistant', blocks: [{ type: 'reasoning', text: 'think' }, { type: 'tool-call', id: 'a', name: 'find_tools', arguments: '{"query":"x"}' }, { type: 'tool-call', id: 'b', name: 'read_tool_result', arguments: '{"id":"r1"}' }] },
      { role: 'user', toolResult: { toolCallId: 'a', text: 'added' } },
      { role: 'user', toolResult: { toolCallId: 'b', text: 'page', isError: true } },
      { role: 'assistant', blocks: [{ type: 'tool-call', id: 'c', name: 'read_file', arguments: '{}' }] },
      { role: 'user', toolResult: { toolCallId: 'c', text: 'content' } },
    ])
    if (provider === 'deepseek') {
      const wire = deepseekWire(msgs)
      assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'])
      assert.deepEqual(wire[2].content.map((b) => b.tool_use_id), ['a', 'b'])
    } else {
      const wire = piAiWire(msgs)
      assert.deepEqual(wire.filter((m) => m.role === 'toolResult').map((m) => m.toolName), ['find_tools', 'read_tool_result', 'read_file'])
    }
  })
}

test('callSeat: collects blocks by index and the finish replayState; drops replay and tool calls on max-tokens', async () => {
  const { callSeat } = await import('./providers.mjs')
  const mk = (finish) => ({ listProviders: () => [{ id: 'deepseek' }], stream: () => (async function* () {
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 't1', name: 'x', arguments: '{}' } }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'r' } }
    yield { type: 'finish', reason: { kind: finish }, replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'm' }, blocks: [{ type: 'reasoning', signature: 's' }, { type: 'tool-call' }] } }
  })() })
  const seat = { name: 'DS', provider: 'deepseek', model: 'm' }
  const ok = await callSeat({ seat, prompt: { system: '', messages: [{ role: 'user', content: 'x' }] }, llm: mk('tool-calls'), tools: [{ name: 'x', description: '', parameters: {} }] })
  assert.deepEqual(ok.blocks.map((b) => b.type), ['reasoning', 'tool-call'])
  assert.equal(ok.replayState.blocks[0].signature, 's'); assert.equal(ok.toolCalls.length, 1)
  const cut = await callSeat({ seat, prompt: { system: '', messages: [{ role: 'user', content: 'x' }] }, llm: mk('max-tokens') })
  assert.equal(cut.replayState, undefined); assert.deepEqual(cut.toolCalls, [])
})

test('telegram summary line for generic tools', () => {
  assert.match(toolSummaryLine({ tool: 'web_search', speaker: { name: 'DeepSeek' }, text: 'ok', data: { ok: true, resultId: 'r1abcd' } }), /DeepSeek 调用 web_search #r1abcd/)
  assert.match(toolSummaryLine({ tool: 'find_tools', speaker: { name: 'GPT' }, text: '查找 → a' }), /🔎 GPT 查找工具/)
})

// ── 端到端：moderator 工具循环 + 真实 toolkit（假 LLM / 假注册表） ──
function setup(dir, { script, registry, finderText = '{"tools":["read_file","run_shell"]}' }) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm' }] })
  const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: finderText }; yield { type: 'finish', reason: { kind: 'stop' } } })() }
  const toolkit = createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id),
    getTools: () => registry,
    getLlm: () => llm,
    getSettings: () => ({}),
    providers: async () => ({ available: true, providers: [{ id: 'deepseek', models: [{ id: 'deepseek-flash' }] }] }),
  })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '9000000001', defaultMain: 'ds', tools: {} }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit })
  return { store, moderator, calls, toolkit, cfg }
}
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const reg = (log) => ({
  schemas: () => [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'run_shell', description: 'Run a command', parameters: { type: 'object' } },
    { name: 'web_search', description: 'Search', parameters: { type: 'object' } },
  ],
  get: (n) => ({ execute: async (args) => { log.push([n, args]); return { content: [{ type: 'text', text: `${n} output ` + 'x'.repeat(3000) }] } } }),
})

test('loop: find_tools → call found tool → final answer; results shared in room with preview', async () => {
  const dir = await tmp()
  try {
    const log = []
    const { store, moderator, calls } = setup(dir, {
      registry: reg(log),
      script: [
        { text: '', toolCalls: [tc('c1', 'find_tools', { query: 'read a file' })], usage: { input: 1, output: 1 } },
        (o) => { assert.ok(o.tools.some((t) => t.name === 'read_file')); return { text: '', toolCalls: [tc('c2', 'read_file', { path: 'a.txt' })], usage: {} } },
        (o) => { const last = o.prompt.messages[o.prompt.messages.length - 1]; assert.equal(last.toolResult.toolCallId, 'c2'); assert.match(last.toolResult.text, /^Card #r\w+ · 读取文件 · a\.txt · \d/); assert.match(last.toolResult.text, /open_card/); return { text: '文件内容已读完。', toolCalls: [], usage: {} } },
      ],
    })
    const room = await store.createRoom({ title: '中转站' })
    const out = await moderator.post(room.id, '读一下 a.txt', { owner: true, source: 'local' })
    await out.promise
    assert.deepEqual(log.map((x) => x[0]), ['read_file'])
    assert.equal(calls.length, 3)
    const msgs = await store.readMessages(room.id)
    const tools = msgs.filter((m) => m.kind === 'tool')
    assert.deepEqual(tools.map((m) => m.tool), ['find_tools', 'read_file'])
    assert.ok(tools[1].data.resultId); assert.ok(tools[1].data.preview.length < 2000)
    assert.equal(msgs.filter((m) => m.kind === 'seat' && m.status === 'ok').pop().text, '文件内容已读完。')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('loop: non-owner telegram task only sees / runs read-only tools', async () => {
  const dir = await tmp()
  try {
    const log = []
    const { store, moderator, toolkit } = setup(dir, {
      registry: reg(log),
      script: [
        (o) => { assert.ok(!o.tools.some((t) => t.name === 'run_shell')); assert.ok(o.tools.some((t) => t.name === 'web_search')); return { text: '', toolCalls: [tc('c1', 'run_shell', { cmd: 'del' })], usage: {} } },
        (o) => { assert.equal(o.prompt.messages.at(-1).toolResult.text, '该请求来自非授权用户，无法使用会更改电脑的工具。'); return { text: '无法执行。', toolCalls: [], usage: {} } },
      ],
    })
    const room = await store.createRoom({ title: 'r' })
    await toolkit.toolsets.add(room.id, ['run_shell', 'web_search'], { max: 12 })
    const out = await moderator.post(room.id, '删掉文件', { owner: false, source: 'telegram', fromId: 42, userName: 'X' })
    await out.promise
    assert.deepEqual(log, [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('loop guard: identical call blocked on 3rd try, then forced to finish', async () => {
  const dir = await tmp()
  try {
    const log = []
    const same = { text: '', toolCalls: [tc('c', 'web_search', { q: 'x' })], usage: {} }
    const { store, moderator, calls, toolkit } = setup(dir, {
      registry: reg(log),
      script: [same, same, same, (o) => { assert.match(o.prompt.messages.at(-1).content, /repeated tool calls were skipped/); return { text: '结论', toolCalls: [], usage: {} } }],
    })
    const room = await store.createRoom({ title: 'r' })
    await toolkit.toolsets.add(room.id, ['web_search'], { max: 12 })
    const out = await moderator.post(room.id, '搜', { owner: true })
    await out.promise
    assert.equal(log.length, 2)
    assert.equal(calls.length, 4)
    assert.ok((await store.readMessages(room.id)).some((m) => m.kind === 'tool' && m.data?.blocked === 'repeat'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('/tools clear is owner-only; 停止 is owner-only', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, toolkit } = setup(dir, { registry: reg([]), script: [{ text: 'ok', toolCalls: [], usage: {} }] })
    const room = await store.createRoom({ title: 'r' })
    await toolkit.toolsets.add(room.id, ['web_search'], { max: 12 })
    await moderator.post(room.id, '/tools clear', { owner: false, source: 'telegram', fromId: 42 })
    assert.equal((await toolkit.toolsets.list(room.id)).length, 1)
    await moderator.post(room.id, '/tools clear', { owner: true })
    assert.equal((await toolkit.toolsets.list(room.id)).length, 0)
    const r = await moderator.post(room.id, '停止', { owner: false, source: 'telegram', fromId: 42 })
    assert.equal(r.started, false)
    const sys = (await store.readMessages(room.id)).filter((m) => m.kind === 'system').map((m) => m.text)
    assert.ok(sys.some((t) => /只有 Shiro 可以管理工具集/.test(t)))
    assert.ok(sys.some((t) => /已清空房间工具集/.test(t)))
    assert.ok(sys.some((t) => /只有 Shiro 可以停止/.test(t)))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('find_tools reports missing DeepSeek provider', async () => {
  const dir = await tmp()
  try {
    const toolkit = createChatroomTools({ roomDir: (id) => join(dir, id), getTools: () => reg([]), getLlm: () => ({ stream() {} }), getSettings: () => ({}), providers: async () => ({ available: true, providers: [{ id: 'openai', models: [] }] }) })
    const st = await toolkit.finderStatus()
    assert.equal(st.ready, false); assert.match(st.problem, /DeepSeek/)
    const r = await toolkit.run('r1', tc('c', FIND_TOOLS_NAME, { query: 'x' }), { owner: true })
    assert.equal(r.isError, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('resolveFinder follows the DeepSeek seat when the configured provider id is not registered; never fails on an unreadable list', () => {
  const seats = [{ id: 'deepseek', name: 'DeepSeek', provider: 'ds-official', model: 'deepseek-flash' }, { id: 'gpt', name: 'GPT', provider: 'openai', model: 'g' }]
  const catalog = { available: true, providers: [{ id: 'openai', models: [{ id: 'g' }] }, { id: 'ds-official', name: 'DeepSeek 官方', models: [{ id: 'deepseek-pro' }, { id: 'deepseek-flash' }] }] }
  const r = resolveFinder({ settings: { finderProvider: 'deepseek', finderModel: 'deepseek-flash' }, catalog, seats, defaultMain: 'deepseek' })
  assert.equal(r.ready, true); assert.equal(r.provider, 'ds-official'); assert.equal(r.model, 'deepseek-flash'); assert.equal(r.via, 'seat')
  // no seat: match by name
  const r2 = resolveFinder({ settings: { finderProvider: 'deepseek' }, catalog, seats: [] })
  assert.equal(r2.provider, 'ds-official'); assert.equal(r2.model, 'deepseek-flash')
  // configured & registered wins
  assert.equal(resolveFinder({ settings: { finderProvider: 'openai', finderModel: 'g' }, catalog, seats }).provider, 'openai')
  // list unavailable / empty → try seat route directly
  const r3 = resolveFinder({ settings: { finderProvider: '' }, catalog: { available: true, providers: [] }, seats })
  assert.equal(r3.ready, true); assert.equal(r3.provider, 'ds-official')
  assert.equal(resolveFinder({ settings: { finderProvider: 'deepseek' }, catalog: { available: false, providers: [] }, seats: [] }).ready, true)
})

test('finderStatus is resolved at call time (provider registered after startup)', async () => {
  let live = []
  const toolkit = createChatroomTools({ roomDir: (id) => id, getTools: () => ({}), getLlm: () => ({ stream() {} }), getSettings: () => ({}), providers: async () => ({ available: true, providers: live }), getSeats: () => [], getDefaultMain: () => '' })
  live = [{ id: 'openai', models: [] }]
  assert.equal((await toolkit.finderStatus()).ready, false)
  live = [{ id: 'deepseek-x', models: [{ id: 'deepseek-flash' }] }]
  const st = await toolkit.finderStatus()
  assert.equal(st.ready, true); assert.equal(st.provider, 'deepseek-x')
})

test('room default tools: web_search/web_fetch always present when in catalog, not stored, not duplicated, survive clear', async () => {
  const { DEFAULT_ROOM_TOOLS, effectiveToolNames } = await import('./chatroom-tools.mjs')
  const { FIND_TOOLS } = await import('./tool-selector.mjs')
  assert.deepEqual([...DEFAULT_ROOM_TOOLS], ['web_search', 'web_fetch', 'search_history'])
  assert.deepEqual(effectiveToolNames(['web_search', 'read_file'], ['web_search', 'web_fetch', 'read_file']), ['web_search', 'web_fetch', 'search_history', 'read_file'])
  assert.deepEqual(effectiveToolNames([], ['read_file']), ['search_history']) // room-native default, independent of the DSH catalog
  assert.match(FIND_TOOLS.description, /none of your currently available tools exactly matches/)
  const dir = await tmp()
  const sch = (names) => names.map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
  let catNames = ['web_search', 'web_fetch', 'run_shell', 'mc_connect', 'mcp__gamebot-minecraft__gamebot_connect']
  let enabled = true
  try {
    const tk = createChatroomTools({ roomDir: (id) => join(dir, id), getTools: () => ({ schemas: () => sch(catNames), get: () => null }), getLlm: () => null, getSettings: () => ({ enabled }) })
    const member = (await tk.schemas('new-room', { owner: false })).map((t) => t.name)
    assert.ok(member.includes('web_search') && member.includes('web_fetch'))
    assert.ok(!member.some((n) => n.startsWith('mcp__gamebot')))
    assert.equal((await tk.toolsets.list('new-room')).length, 0)
    await tk.toolsets.add('new-room', ['web_search'], { max: 12 })
    const owner = (await tk.schemas('new-room', { owner: true })).map((t) => t.name)
    assert.equal(owner.filter((n) => n === 'web_search').length, 1)
    await tk.toolsets.clear('new-room')
    assert.ok((await tk.schemas('new-room', { owner: false })).some((t) => t.name === 'web_fetch'))
    assert.equal(denyReason('web_fetch', { owner: false, inToolset: tk.defaultsPresent().includes('web_fetch') }), null)
    const r = await tk.run('new-room', { id: 'c1', name: 'web_fetch', arguments: '{"url":"https://x"}' }, { owner: false, seat: { id: 's' } })
    assert.ok(!(r.room?.data?.denied), 'default tool must not be denied as not-in-toolset')
    enabled = false
    assert.ok(!(await tk.schemas('new-room', { owner: true })).some((t) => t.name === 'web_search'))
    enabled = true
    catNames = ['run_shell']
    assert.ok(!(await tk.schemas('new-room', { owner: true })).some((t) => t.name === 'web_search' || t.name === 'web_fetch'))
    assert.deepEqual(tk.defaultsPresent(), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('find_tools: tools already in the toolset are reported as available (selector pick or lexical fallback)', async () => {
  const { lexicalCurrentMatch } = await import('./tool-selector.mjs')
  assert.deepEqual(lexicalCurrentMatch('powershell run command', ['mcp__windows__PowerShell', 'mcp__chrome__click']), ['mcp__windows__PowerShell'])
  assert.deepEqual(lexicalCurrentMatch('xyz', ['mcp__windows__PowerShell']), [])
  assert.match(selectorPrompt('q', [], { current: ['a'] }).system, /already available/)
  const dir = await tmp()
  const names = ['web_search', 'mcp__windows__PowerShell', 'read_file', 'write_file']
  const sch = names.map((name) => ({ name, description: 'desc ' + name, parameters: { type: 'object', properties: {} } }))
  let reply = '{"tools": []}'
  const llm = { stream: async function* () { yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  try {
    const tk = createChatroomTools({ roomDir: (id) => join(dir, id), getTools: () => ({ schemas: () => sch, get: () => null }), getLlm: () => llm, getSettings: () => ({}) })
    await tk.toolsets.add('r', ['mcp__windows__PowerShell'], { max: 12 })
    const call = (q) => tk.run('r', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query: q }) }, { owner: true, seat: { id: 's' } })
    // selector returns nothing → lexical fallback over current toolset
    let r = await call('powershell run command')
    assert.match(r.modelText, /^Already in your toolset: mcp__windows__PowerShell — call it directly\./)
    assert.deepEqual(r.room.data.available, ['mcp__windows__PowerShell'])
    assert.match(r.room.text, /已可用：mcp__windows__PowerShell/)
    // selector picks the current tool → same, nothing re-added
    reply = '{"tools": ["mcp__windows__PowerShell"]}'
    r = await call('run a shell command')
    assert.deepEqual(r.room.data.available, ['mcp__windows__PowerShell'])
    assert.equal((await tk.toolsets.list('r')).length, 1)
    // mixed: new tool added, current one reported as available
    reply = '{"tools": ["read_file", "mcp__windows__PowerShell"]}'
    r = await call('read a file then run it')
    assert.deepEqual(r.room.data.available, ['mcp__windows__PowerShell'])
    assert.match(r.modelText, /Already in your toolset: mcp__windows__PowerShell/)
    assert.deepEqual((await tk.toolsets.list('r')).map((x) => x.name).sort(), ['mcp__windows__PowerShell', 'read_file'])
    // truly nothing
    reply = '{"tools": []}'
    r = await call('zzzz qqqq')
    assert.match(r.room.text, /没有合适的工具/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('owner gate: mcp__windows__* is owner-only regardless of OPEN_TOOLS; owner unaffected', async () => {
  const { isOwnerOnlyTool, isOpenTool, OPEN_TOOLS } = await import('../channels/telegram/owner-gate.mjs')
  assert.equal(isOwnerOnlyTool('mcp__windows__PowerShell'), true)
  OPEN_TOOLS.add('mcp__windows__PowerShell')
  try {
    assert.equal(isOpenTool('mcp__windows__PowerShell'), false)
    assert.equal(denyReason('mcp__windows__PowerShell', { owner: false, inToolset: true }), DENY_MESSAGE)
  } finally { OPEN_TOOLS.delete('mcp__windows__PowerShell') }
  assert.equal(denyReason('mcp__windows__PowerShell', { owner: true, inToolset: true }), null)
  assert.ok(allowedNames(['mcp__windows__PowerShell', 'web_search'], true).includes('mcp__windows__PowerShell'))
  assert.ok(!allowedNames(['mcp__windows__PowerShell', 'web_search'], false).includes('mcp__windows__PowerShell'))
})