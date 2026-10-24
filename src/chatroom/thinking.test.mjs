import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { callSeat, reasoningText } from './providers.mjs'
import { buildPrompt } from './transcript.mjs'

// 思考过程：只存 thinking.jsonl、只给本机界面；不进任何 AI 的提示词、不发 Telegram；失败 / 打断 / 停止的回合不保存

const SECRET = 'SECRET-THOUGHT'
const SEATS = [
  { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'd' },
  { id: 'gk', name: 'Grok', provider: 'xai', model: 'g' },
]
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const promptText = (o) => JSON.stringify(o.prompt)

function fakeLlm(chunks) {
  return { listProviders: () => [{ id: 'deepseek' }], async *stream() { for (const c of chunks) yield c } }
}

test('providers: reasoning-delta and reasoning blocks collected per step (summaries included); empty / whitespace-only summaries dropped', async () => {
  const seat = { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'd' }
  const prompt = { system: '', messages: [{ role: 'user', content: 'x' }] }
  const live = []
  let out = await callSeat({ seat, prompt, llm: fakeLlm([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '先想' }, { type: 'reasoning-delta', index: 0, text: '一下' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先想一下' } },
    { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: '答案' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
    { type: 'block-start', index: 2, blockType: 'reasoning' },
    { type: 'block-end', index: 2, block: { type: 'reasoning', text: '只有块，没有增量' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), onReasoning: (t) => live.push(t) })
  assert.equal(out.text, '答案')
  assert.equal(out.reasoning, '先想一下\n\n只有块，没有增量')
  assert.deepEqual(live, ['先想', '一下'])
  // 只有签名的空摘要（例如 Claude 经中转）：没有 reasoning 字段
  out = await callSeat({ seat, prompt, llm: fakeLlm([
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '  \n ' } },
    { type: 'reasoning-delta', index: 1, text: '   ' },
    { type: 'text-delta', index: 2, text: 'ok' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]) })
  assert.equal(out.text, 'ok'); assert.ok(!('reasoning' in out))
  assert.equal(reasoningText(new Map([[1, ' b '], [0, 'a'], [2, '']])), 'a\n\nb')
})

async function setup(dir, script) {
  const store = createStore(dir)
  const toolkit = createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id),
    getTools: () => ({ schemas: () => [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], get: (n) => ({ execute: async (a) => ({ content: [{ type: 'text', text: `${n} ${a.path} ` + 'x'.repeat(40) }] }) }) }),
    getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }),
  })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const events = []
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, _r, text) => { relays.push({ seat: seat?.id || null, text: String(text) }); return [] }, relayAttachments: async (_s, _r, m) => { relays.push({ text: JSON.stringify(m) }); return [] } }
  const cfg = { seats: SEATS, userName: 'Shiro', budget: 4, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {} }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, emit: (_, e) => events.push(e) })
  const room = await store.createRoom({ title: 'think' })
  await toolkit.toolsets.add(room.id, ['read_file'], { max: 10, by: 'test' })
  const thinkingFile = join(dir, 'rooms', room.id, 'thinking.jsonl')
  const sideFile = async () => { try { return await readFile(thinkingFile, 'utf8') } catch { return '' } }
  return { store, moderator, calls, events, relays, room, sideFile, messagesFile: join(dir, 'rooms', room.id, 'messages.jsonl') }
}

test('thinking: aggregated across tool steps into thinking.jsonl; message only carries a char count; never in prompts or Telegram', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-th-'))
  try {
    const f = await setup(dir, [
      (o) => { o.onReasoning?.(SECRET + '-1'); return { text: '我先读一下', reasoning: SECRET + '-1', toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} } },
      (o) => { o.onReasoning?.(SECRET + '-2'); return { text: '读完了，结论是 42。', reasoning: SECRET + '-2', toolCalls: [], usage: {} } },
      { text: '[PASS]', usage: {} },
    ])
    const out = await f.moderator.post(f.room.id, '读 a.txt', { owner: true })
    await out.promise
    const msgs = await f.store.readMessages(f.room.id)
    const reply = msgs.find((m) => m.kind === 'seat' && m.status === 'ok')
    const expected = `${SECRET}-1\n\n${SECRET}-2`
    assert.equal(reply.thinkingChars, expected.length)
    // 消息文件里没有思考内容；侧文件里有
    assert.ok(!(await readFile(f.messagesFile, 'utf8')).includes(SECRET))
    const rec = await f.store.readThinking(f.room.id, reply.id)
    assert.equal(rec.text, expected); assert.equal(rec.chars, expected.length)
    assert.ok((await f.sideFile()).includes(reply.id))
    // 实时：thinking-delta 事件只给界面
    assert.deepEqual(f.events.filter((e) => e.type === 'thinking-delta').map((e) => e.text), [SECRET + '-1', SECRET + '-2'])
    // 不发 Telegram
    assert.ok(f.relays.some((r) => /结论是 42/.test(r.text)))
    assert.ok(!f.relays.some((r) => r.text.includes(SECRET)))
    // 不进任何 AI 的提示词（第二步、后续成员）
    assert.ok(f.calls.length >= 3)
    for (const c of f.calls) assert.ok(!promptText(c).includes(SECRET))
    for (const seat of SEATS) {
      const p = buildPrompt({ seat, seats: SEATS, userName: 'Shiro', messages: msgs })
      assert.ok(!JSON.stringify(p).includes(SECRET)); assert.ok(!JSON.stringify(p).includes('thinkingChars'))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('thinking: dropped with the reply on failed, interrupted and stopped turns; pass saves nothing', async () => {
  // 失败
  let dir = await mkdtemp(join(tmpdir(), 'dsh-th-'))
  try {
    const f = await setup(dir, [
      { text: '读', reasoning: SECRET, toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} },
      async () => { throw new Error('HTTP 500 upstream') },
    ])
    await (await f.moderator.post(f.room.id, '读 a.txt', { owner: true })).promise
    assert.equal(await f.sideFile(), '')
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(msgs.some((m) => m.tool === 'read_file' && m.salvaged)) // 已完成的卡片照常保留
    assert.ok(!msgs.some((m) => m.thinkingChars))
  } finally { await rm(dir, { recursive: true, force: true }) }
  // 停止（用户「停止」）
  dir = await mkdtemp(join(tmpdir(), 'dsh-th-'))
  try {
    let release
    const f = await setup(dir, [
      (o) => { o.onReasoning?.(SECRET); return new Promise((resolve, reject) => { release = resolve; o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('已停止'), { aborted: true, partial: { text: '一半' } }))) }) },
    ])
    const out = await f.moderator.post(f.room.id, '想一想', { owner: true })
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10))
    f.moderator.stop(f.room.id)
    await out.promise
    assert.equal(await f.sideFile(), '')
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(msgs.some((m) => m.status === 'stopped')); assert.ok(!msgs.some((m) => m.thinkingChars))
  } finally { await rm(dir, { recursive: true, force: true }) }
  // 被新消息打断
  dir = await mkdtemp(join(tmpdir(), 'dsh-th-'))
  try {
    let started = false
    const f = await setup(dir, [
      (o) => { started = true; o.onReasoning?.(SECRET); return new Promise((_, reject) => { o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { aborted: true }))) }) },
      { text: '[PASS]', usage: {} },
    ])
    const first = await f.moderator.post(f.room.id, '第一句', { owner: true })
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 10))
    await f.moderator.post(f.room.id, '第二句', { owner: true })
    await first.promise
    assert.equal(await f.sideFile(), '')
    assert.ok(!(await f.store.readMessages(f.room.id)).some((m) => m.thinkingChars))
  } finally { await rm(dir, { recursive: true, force: true }) }
  // 跳过本轮（PASS）：不保存
  dir = await mkdtemp(join(tmpdir(), 'dsh-th-'))
  try {
    const f = await setup(dir, [{ text: '[PASS]', reasoning: SECRET, usage: {} }])
    await (await f.moderator.post(f.room.id, '嗯', { owner: true })).promise
    assert.equal(await f.sideFile(), '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('thinking store: side file per room, keyed by message id; clearThinking empties it; bad ids ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-th-'))
  try {
    const store = createStore(dir)
    const room = await store.createRoom({})
    const m = await store.append(room.id, { kind: 'seat', speaker: { id: 'ds', name: 'DeepSeek' }, text: 'hi' })
    assert.equal(await store.appendThinking(room.id, m.id, '   '), null)
    assert.deepEqual(await store.appendThinking(room.id, m.id, ' 想法 '), { id: m.id, chars: 2 })
    assert.equal((await store.readThinking(room.id, m.id)).text, '想法')
    assert.equal(await store.readThinking(room.id, 'msg-none-000'), null)
    assert.equal(await store.readThinking(room.id, '../meta'), null)
    assert.equal(await store.appendThinking(room.id, '../x', 'y'), null)
    assert.ok(!(await readFile(join(dir, 'rooms', room.id, 'messages.jsonl'), 'utf8')).includes('想法'))
    await store.clearThinking(room.id)
    assert.equal(await store.readThinking(room.id, m.id), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})