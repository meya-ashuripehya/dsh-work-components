// 工具结果卡片（「世界的答卷」）、open_card、输出上限与截断提示、调用调试日志。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardTitle, cardLabel, salientArg, inlineResult, cardLine, sizeLabel, isBlankResult, CARD_INLINE_MAX } from './tool-results.mjs'
import { createChatroomTools, failureKind } from './chatroom-tools.mjs'
import { OPEN_CARD_NAME, CATALOG_EXCLUDE } from './tool-selector.mjs'
import { createStore } from './store.mjs'
import { createModerator, truncationNote, toolStepTokens, TOOL_STEP_MIN_TOKENS } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { callEntry, createCallLog, scrubSecrets } from './call-log.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-cards-'))

test('card titles: generic label from tool name + salient arg + size; overrides; fallback to raw name', () => {
  assert.equal(cardTitle({ tool: 'read_file', args: '{"path":"S:\\\\ExampleWorkspace\\\\a.txt","limit":5}', chars: 2140 }), '读取文件 · S:\\ExampleWorkspace\\a.txt · 2.1k 字')
  assert.equal(cardTitle({ tool: 'web_search', args: { query: 'Pikafish NNUE', count: 5 }, chars: 5400 }), '网页搜索 · Pikafish NNUE · 5.4k 字')
  assert.equal(cardTitle({ tool: 'mcp__windows__FileSystem', args: { mode: 'list', path: 'S:\\ExampleWorkspace' }, chars: 812 }), '列出文件系统 · S:\\ExampleWorkspace · 812 字')
  assert.equal(cardLabel('frobnicate_xyzzy'), 'frobnicate_xyzzy')
  assert.equal(cardLabel('get_weather'), '查询天气')
  assert.equal(cardTitle({ tool: 'web_search', args: { query: 'x' }, ok: false }), '网页搜索 · x · 空')
  assert.equal(salientArg({ limit: 5, prompt: 'p', path: 'a.txt' }), 'a.txt') // 优先键顺序
  assert.equal(salientArg({ foo: 'bar' }), 'bar') // 无优先键：第一个短字符串
  assert.equal(salientArg('not json'), '')
  assert.ok(cardTitle({ tool: 't', args: { query: 'q'.repeat(200) }, chars: 1 }).includes('…'))
  assert.equal(sizeLabel(25000), '25k 字')
})

test('inline threshold: one short line is shown inline, long / multi-line are title only', () => {
  assert.equal(inlineResult('42'), '42')
  assert.equal(inlineResult('x'.repeat(CARD_INLINE_MAX)), 'x'.repeat(CARD_INLINE_MAX))
  assert.equal(inlineResult('x'.repeat(CARD_INLINE_MAX + 1)), '')
  assert.equal(inlineResult('a\nb'), '')
  assert.equal(inlineResult('   '), '')
  assert.ok(isBlankResult('') && isBlankResult(' null ') && isBlankResult('{"content":[{"type":"text","text":""}]}'))
  assert.ok(!isBlankResult('0') && !isBlankResult('{"content":[{"type":"text","text":"x"}]}') && !isBlankResult('{"a":1}'))
})

test('prompt: other members (and later turns) see only card lines; short results inline; failures are blank sheets', () => {
  const seats = resolveSeats({ chatroomSeats: [{ id: 'gm', name: 'Gemini', provider: 'google', model: 'g' }, { id: 'gk', name: 'Grok', provider: 'xai', model: 'x' }] })
  const msgs = [
    { id: 1, seq: 1, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, text: '查一下', status: 'ok' },
    { id: 2, seq: 2, kind: 'tool', tool: 'read_file', speaker: { id: 'gk', name: 'Grok' }, text: 'line1 …', status: 'ok', data: { ok: true, resultId: 'rlong01', chars: 3000, title: '读取文件 · a.txt · 3.0k 字', preview: 'SECRETPREVIEW\n' + 'x'.repeat(500), args: '{"path":"a.txt"}' } },
    { id: 3, seq: 3, kind: 'tool', tool: 'get_time', speaker: { id: 'gk', name: 'Grok' }, text: '09:41', status: 'ok', data: { ok: true, resultId: 'rshort1', chars: 5, title: '查询时间 · 5 字', inline: '09:41', preview: '09:41', args: '{}' } },
    { id: 4, seq: 4, kind: 'tool', tool: 'web_search', speaker: { id: 'gk', name: 'Grok' }, text: '失败：HTTP 502 Bad Gateway', status: 'ok', data: { ok: false, resultId: 'rfail01', chars: 20, preview: '错误：HTTP 502 Bad Gateway', args: '{"query":"news"}' } },
    { id: 5, seq: 5, kind: 'tool', tool: 'list_dir', speaker: { id: 'gk', name: 'Grok' }, text: '（空）', status: 'ok', data: { ok: true, blank: true, resultId: 'rempty1', chars: 0, title: '列出目录 · 空', preview: '', args: '{}' } },
    // 旧消息（无 title 字段）：标题现场生成
    { id: 6, seq: 6, kind: 'tool', tool: 'web_search', speaker: { id: 'gk', name: 'Grok' }, text: 'old', status: 'ok', data: { ok: true, resultId: 'rold001', chars: 1500, preview: 'OLDPREVIEW ' + 'y'.repeat(300), args: '{"query":"象棋"}' } },
    { id: 7, seq: 7, kind: 'seat', speaker: { id: 'gk', name: 'Grok' }, text: '查到了。', status: 'ok' },
  ]
  for (const seat of seats) {
    const p = buildPrompt({ seat, seats, userName: 'Shiro', messages: msgs, toolsInfo: { owner: true } })
    const text = p.messages.map((m) => m.content).join('\n')
    assert.match(text, /\[card #rlong01 by Grok · 读取文件 · a\.txt · 3\.0k 字\]/)
    assert.match(text, /\[card #rshort1 by Grok · 查询时间 · 5 字\] → 09:41/)
    assert.match(text, /\[card by Grok · 网页搜索 · news · 空\] This sheet came back blank\./)
    assert.match(text, /\[card by Grok · 列出目录 · 空\] This sheet came back blank\./)
    assert.match(text, /\[card #rold001 by Grok · 网页搜索 · 象棋 · 1\.5k 字\]/)
    assert.ok(!/SECRETPREVIEW|OLDPREVIEW|502|Bad Gateway|错误/.test(text), seat.name)
    assert.match(p.system, /answer sheet the world handed back/)
  }
  assert.equal(cardLine({ tool: 't', speaker: { name: 'A' }, data: { ok: true, resultId: 'rabcd1', chars: 2, preview: 'ok' } }), '[card #rabcd1 by A · t · 2 字] → ok')
})

function kit(dir, registry) {
  return createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id),
    getTools: () => registry,
    getLlm: () => null,
    getSettings: () => ({}),
    providers: async () => ({ available: true, providers: [] }),
  })
}
const registry = {
  schemas: () => [],
  get: (n) => ({
    execute: async (args) => {
      if (n === 'read_file') return { content: [{ type: 'text', text: 'FULL ' + 'z'.repeat(5000) }] }
      if (n === 'get_time') return { content: [{ type: 'text', text: '09:41' }] }
      if (n === 'list_dir') return { content: [{ type: 'text', text: '' }] }
      throw new Error('ENOENT: no such file C:\\secret\\path')
    },
  }),
}

test('run: caller sees the full card in its own turn; blank / failed cards hide raw errors; open_card + read_tool_result alias', async () => {
  const dir = await tmp()
  try {
    const tk = kit(dir, registry)
    await tk.toolsets.add('room1', ['read_file', 'get_time', 'list_dir', 'broken_tool'], { max: 12 })
    const seat = { id: 'gk', name: 'Grok' }
    const ok = await tk.run('room1', { id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }, { owner: true, seat })
    assert.match(ok.modelText, /^Card #r\w+ · 读取文件 · a\.txt · 5\.0k 字\nFULL z/)
    assert.equal(ok.room.data.title, '读取文件 · a.txt · 5.0k 字'); assert.equal(ok.room.data.inline, undefined)
    const short = await tk.run('room1', { id: 'c2', name: 'get_time', arguments: '{}' }, { owner: true, seat })
    assert.equal(short.room.data.inline, '09:41')
    const blank = await tk.run('room1', { id: 'c3', name: 'list_dir', arguments: '{}' }, { owner: true, seat })
    assert.match(blank.modelText, /this sheet came back blank/); assert.equal(blank.room.data.blank, true)
    const bad = await tk.run('room1', { id: 'c4', name: 'broken_tool', arguments: '{"path":"x"}' }, { owner: true, seat })
    assert.equal(bad.isError, true)
    assert.match(bad.modelText, /this sheet came back blank \(nothing there\)/)
    assert.doesNotMatch(bad.modelText, /ENOENT|secret/)
    assert.match(bad.room.text, /ENOENT/) // 界面仍显示真实原因
    const rid = ok.room.data.resultId
    const opened = await tk.run('room1', { id: 'c5', name: OPEN_CARD_NAME, arguments: JSON.stringify({ id: '#' + rid, limit: 100 }) }, { owner: true, seat })
    assert.match(opened.modelText, new RegExp(`^Card #${rid}: 5005 chars, offset 0, next page at offset 100\\nFULL z`))
    const legacy = await tk.run('room1', { id: 'c6', name: 'read_tool_result', arguments: JSON.stringify({ id: rid, grep: 'FULL' }) }, { owner: true, seat })
    assert.match(legacy.modelText, /1 matching lines/)
    const missing = await tk.run('room1', { id: 'c7', name: OPEN_CARD_NAME, arguments: '{"id":"rnope99"}' }, { owner: true, seat })
    assert.equal(missing.isError, true)
    const names = (await tk.schemas('room1', { owner: true })).map((t) => t.name)
    assert.ok(names.includes('open_card')); assert.ok(!names.includes('read_tool_result'))
    assert.ok(CATALOG_EXCLUDE.has('open_card'))
  } finally { await rm(dir, { recursive: true, force: true }) }
  assert.equal(failureKind('Request timed out after 30s'), 'it took too long')
  assert.equal(failureKind('weird'), "it didn't work this time")
})

test('output cap: tool steps get at least 4096 tokens; max-tokens tool drops leave an owner-only note', async () => {
  assert.equal(toolStepTokens({ maxTokens: 1024 }), TOOL_STEP_MIN_TOKENS)
  assert.equal(toolStepTokens({ maxTokens: 8000 }), 8000)
  assert.equal(toolStepTokens({ maxTokens: 0 }), 0)
  assert.equal(toolStepTokens({}), 0)
  assert.equal(truncationNote({ name: 'Grok' }, { finish: 'stop', text: '' }, 4096), '')
  assert.equal(truncationNote({ name: 'Grok' }, { finish: 'max-tokens', text: '说了一半' }, 4096), '')
  assert.match(truncationNote({ name: 'Grok' }, { finish: 'max-tokens', text: '说了一半', droppedToolCalls: 2 }, 4096), /^Grok 的输出达到长度上限（4096 tokens）被截断，2 个工具调用未执行/)
  assert.match(truncationNote({ name: 'Grok' }, { finish: 'max-tokens', text: '', droppedToolCalls: 1 }, 0), /服务商上限/)
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const seats = resolveSeats({ chatroomSeats: [{ id: 'gk', name: 'Grok', provider: 'xai', model: 'grok' }] })
    const toolkit = kit(dir, registry)
    const seen = []
    const logged = []
    let n = 0
    const call = async (o) => {
      seen.push(o)
      n++
      if (n === 1) return { text: '我去查', toolCalls: [], usage: { input: 10, output: 4096 }, finish: 'max-tokens', droppedToolCalls: 1 }
      return { text: '算了，直接说吧。', toolCalls: [], usage: {}, finish: 'stop' }
    }
    const cfg = { seats, userName: 'Shiro', budget: 2, maxTokens: 100, defaultMain: 'gk', tools: {} }
    const mod = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, logCall: (x) => logged.push(x) })
    const room = await store.createRoom({ title: 'r' })
    const out = await mod.post(room.id, '查一下', { owner: true, source: 'local' })
    await out.promise
    assert.ok(seen.length >= 1)
    assert.equal(seen[0].maxTokens, TOOL_STEP_MIN_TOKENS)
    const msgs = await store.readMessages(room.id)
    const note = msgs.find((m) => m.kind === 'system' && m.notice === 'truncated')
    assert.ok(note, 'owner-only truncation note'); assert.match(note.text, /Grok 的输出达到长度上限/)
    // 不进 AI 提示词
    if (seen.length > 1) assert.ok(!seen.slice(1).some((o) => JSON.stringify(o.prompt).includes('长度上限')))
    const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs })
    assert.ok(!JSON.stringify(p).includes('长度上限'))
    assert.ok(logged.length >= 1); assert.equal(logged[0].out.finish, 'max-tokens'); assert.equal(logged[0].seat.name, 'Grok')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('output cap: 0/empty means no maxTokens sent on tool turns', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const seats = resolveSeats({ chatroomSeats: [{ id: 'gk', name: 'Grok', provider: 'xai', model: 'grok' }] })
    const toolkit = kit(dir, registry)
    const seen = []
    const call = async (o) => { seen.push(o); return { text: 'ok', toolCalls: [], usage: {}, finish: 'stop' } }
    const cfg = { seats, userName: 'Shiro', budget: 2, maxTokens: 0, defaultMain: 'gk', tools: {} }
    const mod = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit })
    const room = await store.createRoom({ title: 'r' })
    const out = await mod.post(room.id, '你好', { owner: true, source: 'local' })
    await out.promise
    assert.ok(seen.length >= 1)
    assert.equal(seen[0].maxTokens, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('call log: metadata only, secrets scrubbed, failures carry code, size-rotated', async () => {
  const seat = { id: 'gk', name: 'Grok', provider: 'xai', model: 'grok-4', apiKey: 'xai-SHOULDNOTAPPEAR1234567' }
  const ok = callEntry({ roomId: 'r1', seat, step: 1, toolsOffered: 14, maxTokens: 4096, ms: 1234.4, at: 0, out: { text: 'hello', toolCalls: [{ name: 'read_file', arguments: '{"path":"secret.txt"}' }], usage: { input: 50, output: 20 }, finish: 'tool-use' } })
  assert.deepEqual(ok, { ts: '1970-01-01T00:00:00.000Z', room: 'r1', seat: 'Grok', provider: 'xai', model: 'grok-4', kind: 'turn', step: 1, toolsOffered: 14, maxTokens: 4096, ms: 1234, ok: true, stop: 'tool-use', toolCalls: 1, tools: ['read_file'], textChars: 5, inTokens: 50, outTokens: 20 })
  const err = Object.assign(new Error('Grok 请求失败：401 invalid key sk-abcdefghijklmnop1234 Bearer abcdef123456789'), { code: 'auth', status: 401 })
  const bad = callEntry({ roomId: 'r1', seat, error: err, at: 0 })
  assert.equal(bad.ok, false); assert.equal(bad.stop, 'error'); assert.equal(bad.code, 'auth'); assert.equal(bad.status, 401)
  assert.ok(!/sk-abcdef|abcdef123456789/.test(bad.error))
  assert.ok(!JSON.stringify(ok).includes('SHOULDNOTAPPEAR') && !JSON.stringify(ok).includes('secret.txt'))
  assert.equal(scrubSecrets('token=abcdefghijk'), 'token=[redacted]')
  const dir = await tmp()
  try {
    const file = join(dir, 'sub', 'calls.log')
    const log = createCallLog(file, { maxBytes: 600 })
    for (let i = 0; i < 6; i++) await log.log({ roomId: 'r', seat, step: i, at: 0, out: { text: '', toolCalls: [], finish: 'stop' } })
    const cur = await readFile(file, 'utf8')
    const old = await readFile(file + '.1', 'utf8')
    assert.ok((await stat(file)).size <= 600)
    assert.ok(cur.trim().split('\n').every((l) => JSON.parse(l).seat === 'Grok'))
    assert.ok(old.length > 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
