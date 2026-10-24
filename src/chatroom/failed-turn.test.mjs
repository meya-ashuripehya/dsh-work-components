import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator, failureReason } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { toLlmMessages } from './providers.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-ft-'))
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const registry = (log) => ({
  schemas: () => [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  get: (n) => ({ execute: async (args) => { log.push([n, args]); return { content: [{ type: 'text', text: `${n} output ${args.path} ` + 'x'.repeat(50) }] } } }),
})

async function setup(dir, script) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro' }] })
  const log = []
  const toolkit = createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id),
    getTools: () => registry(log),
    getLlm: () => null,
    getSettings: () => ({}),
    providers: async () => ({ available: true, providers: [] }),
  })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const events = []
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, roomId, text, o) => { relays.push({ seat: seat?.id || null, text, prefix: o?.prefixName }); return [] } }
  const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '9000000001', defaultMain: 'ds', tools: {} }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, emit: (_, e) => events.push(e) })
  const room = await store.createRoom({ title: '中转站' })
  await toolkit.toolsets.add(room.id, ['read_file'], { max: 10, by: 'test' })
  return { store, moderator, calls, events, relays, toolkit, room, seats, log, resultsDir: join(dir, 'rooms', room.id, 'tool-results') }
}
const resultFiles = async (d) => { try { return (await readdir(d)).filter((f) => f.endsWith('.txt')) } catch { return [] } }
const settle = () => new Promise((r) => setTimeout(r, 20))

test('failed turn: completed tool cards are kept (streamed live: same id, member-attributed, relayed when they ran); the reply is dropped; failure announced, not stored', async () => {
  const dir = await tmp()
  try {
    let retryPrompt
    const { store, moderator, calls, events, relays, room, seats, log, resultsDir, toolkit } = await setup(dir, [
      { text: '我先读一下', toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} },
      async () => { throw new Error('DeepSeek 请求失败：HTTP 500 upstream error') },
      (o) => { retryPrompt = o.prompt; return { text: '读过了，内容在卡片里。', toolCalls: [], usage: {} } },
    ])
    const out = await moderator.post(room.id, '读一下 a.txt', { owner: true, source: 'telegram', fromId: '9000000001', userName: 'Shiro' })
    await out.promise
    await settle()
    assert.deepEqual(log.map((x) => x[0]), ['read_file'])
    assert.ok(calls.length >= 2)
    let msgs = await store.readMessages(room.id)
    // 用户消息 + 保留的工具卡片；没有成员正文、没有出错记录
    assert.deepEqual(msgs.filter((m) => m.kind !== 'system').map((m) => `${m.kind}:${m.status}`), ['user:ok', 'tool:ok'])
    const card = msgs.find((m) => m.kind === 'tool')
    assert.equal(card.tool, 'read_file'); assert.equal(card.speaker.name, 'DeepSeek'); assert.equal(card.salvaged, true)
    assert.ok(!msgs.some((m) => m.status === 'error' || m.kind === 'seat'))
    assert.equal((await resultFiles(resultsDir)).length, 1)
    // 界面：完成的卡片实时入库（不经 pending），失败后只补记 salvaged（message-update），没有撤回；收到 turn-failed
    const pending = events.filter((e) => e.type === 'message' && e.pending).map((e) => e.message.id)
    assert.deepEqual(pending, [])
    assert.ok(events.some((e) => e.type === 'message-update' && e.message.id === card.id && e.message.salvaged))
    assert.equal(events.filter((e) => e.type === 'retract').length, 0)
    assert.ok(events.some((e) => e.type === 'message' && !e.pending && e.message.id === card.id))
    const failed = events.filter((e) => e.type === 'turn-failed')
    assert.equal(failed[0].name, 'DeepSeek'); assert.match(failed[0].reason, /HTTP 500/)
    // Telegram：卡片在工具完成时已实时转发（一次）；正文不转发；另有一条不入库的失败说明
    const tgFail = relays.filter((r) => /本轮回复失败/.test(r.text))
    assert.ok(tgFail.length >= 1); assert.equal(tgFail[0].seat, null); assert.equal(tgFail[0].prefix, '聊天室')
    assert.equal(relays.filter((r) => /read_file/.test(r.text)).length, 1)
    assert.ok(!relays.some((r) => /我先读一下/.test(r.text)))
    // 提示词：卡片以标题行出现，正文不出现；open_card 能打开
    const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs })
    const text = JSON.stringify(p.messages)
    assert.ok(text.includes('#' + card.data.resultId)); assert.ok(!text.includes('我先读一下'))
    const opened = await toolkit.run(room.id, tc('o1', 'open_card', { id: card.data.resultId }), { owner: true, seat: seats[0] })
    assert.match(opened.modelText, /read_file output a\.txt/)
    // 同一成员的重试看到这张卡片（标题行）
    const again = await moderator.post(room.id, '@DeepSeek 再说一下', { owner: true, source: 'local', userName: 'Shiro' }) // @ 点名让其主答重试（失败后席位本身仍可用）
    await again.promise
    assert.ok(JSON.stringify(retryPrompt.messages).includes('#' + card.data.resultId))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failed turn: deferred effects are still undone (bin sweep, room control) and their cards dropped; blank results kept; repeat-blocked dropped', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, events, room, resultsDir } = await setup(dir, [
      { text: '', toolCalls: [tc('c0', 'read_file', { path: 'old.txt' })], usage: {} },
      { text: '旧的读完了', toolCalls: [], usage: {} },
      { text: '', toolCalls: [tc('c1', 'read_file', { path: 'new.txt' }), tc('c2', 'sweep_cards', {}), tc('c3', 'set_main_answerer', { member: 'DeepSeek' }), tc('c4', 'no_such_tool', {})], usage: {} },
      async () => { throw new Error('DeepSeek 请求失败：DeepSeek Messages transport failed') },
    ])
    await (await moderator.post(room.id, '读 old', { owner: true, source: 'local' })).promise
    const before = (await resultFiles(resultsDir)).length
    await (await moderator.post(room.id, '读 new 顺便收拾', { owner: true, source: 'local' })).promise
    await settle()
    const msgs = await store.readMessages(room.id)
    const tools = msgs.filter((m) => m.kind === 'tool')
    assert.ok(tools.some((m) => m.data?.title && /new\.txt/.test(JSON.stringify(m.data)) && m.salvaged))
    assert.ok(!tools.some((m) => m.tool === 'sweep_cards'))
    assert.deepEqual((await store.getRoom(room.id)).cardBin || {}, {})
    assert.ok(!msgs.some((m) => m.notice === 'card-bin'))
    // 不存在的工具 = 空白卡片，同样保留
    const blank = tools.find((m) => m.tool === 'no_such_tool')
    if (blank) assert.equal(blank.salvaged, true)
    assert.ok((await resultFiles(resultsDir)).length >= before + 1)
    const retracted = events.filter((e) => e.type === 'retract').flatMap((e) => e.ids)
    const binPending = events.find((e) => e.type === 'message' && e.pending && e.message.tool === 'sweep_cards')
    if (binPending) assert.ok(retracted.includes(binPending.message.id))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('successful turn: tool records are written and relayed live (before the reply text); tool role / reasoning passback unchanged', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, calls, events, relays, room, resultsDir } = await setup(dir, [
      { text: '', blocks: [{ type: 'reasoning', text: '想一想', signature: 'sig' }, { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }], toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], replayState: { reasoning: 'opaque' }, usage: {} },
      (o) => {
        const [asst, result] = o.prompt.messages.slice(-2)
        assert.equal(asst.role, 'assistant'); assert.deepEqual(asst.replayState, { reasoning: 'opaque' })
        const llm = toLlmMessages({ provider: 'deepseek', model: 'deepseek-v4-pro' }, o.prompt.messages)
        const a = llm.at(-2); const t = llm.at(-1)
        assert.equal(a.role, 'assistant'); assert.deepEqual(a.source.replayState, { reasoning: 'opaque' }); assert.equal(a.content[0].type, 'reasoning')
        assert.equal(t.role, 'tool'); assert.equal(t.toolCallId, 'c1'); assert.equal(result.toolResult.toolCallId, 'c1')
        return { text: '读完了。', toolCalls: [], usage: {} }
      },
    ])
    const out = await moderator.post(room.id, '读一下 a.txt', { owner: true, source: 'local' })
    await out.promise
    await settle()
    assert.equal(calls.length, 2)
    const msgs = await store.readMessages(room.id)
    assert.deepEqual(msgs.map((m) => `${m.kind}:${m.status}`), ['user:ok', 'tool:ok', 'seat:ok'])
    const pendingIds = events.filter((e) => e.type === 'message' && e.pending).map((e) => e.message.id)
    assert.deepEqual(pendingIds, [])
    assert.equal(events.filter((e) => e.type === 'retract' || e.type === 'turn-failed').length, 0)
    assert.equal((await resultFiles(resultsDir)).length, 1)
    assert.ok(relays.some((r) => r.seat === 'ds' && /read_file/.test(r.text)))
    assert.ok(relays.some((r) => r.seat === 'ds' && r.text === '读完了。'))
    assert.ok(relays.findIndex((r) => /read_file/.test(r.text)) < relays.findIndex((r) => r.text === '读完了。'), 'card relayed before the reply')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('user stop keeps what was produced (tool record + partial text, status stopped); queued sends are not delivered', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, calls, events, room } = await setup(dir, [
      { text: '', toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} },
      (o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('已停止'), { aborted: true, partial: { text: '写到一半' } })))),
    ])
    const out = await moderator.post(room.id, '读一下 a.txt', { owner: true, source: 'local' })
    for (let i = 0; i < 200 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(moderator.stop(room.id), true)
    await out.promise
    const msgs = await store.readMessages(room.id)
    assert.deepEqual(msgs.map((m) => `${m.kind}:${m.status}:${m.kind === 'seat' ? m.text : ''}`), ['user:ok:', 'tool:ok:', 'seat:stopped:写到一半'])
    assert.equal(msgs[1].salvaged, true)
    assert.equal(events.filter((e) => e.type === 'turn-failed' || e.type === 'retract').length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an abort that the user did not ask for (provider timeout) counts as a failure', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, events, room } = await setup(dir, [
      async () => { throw Object.assign(new Error('已停止'), { aborted: true, partial: { text: '半句' } }) },
    ])
    const out = await moderator.post(room.id, '你好', { owner: true, source: 'local' })
    await out.promise
    const msgs = await store.readMessages(room.id)
    assert.deepEqual(msgs.filter((m) => m.kind !== 'system').map((m) => m.kind), ['user'])
    const f = events.find((e) => e.type === 'turn-failed')
    assert.match(f.reason, /请求被中断（不是用户停止）/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failureReason is short and single-line', () => {
  assert.equal(failureReason(new Error('a\n  b')), 'a b')
  assert.equal(failureReason(new Error('x'.repeat(500))).length, 300)
  assert.equal(failureReason(null), '未知错误')
})

test('tool results store: remove deletes the file and its dedupe entry', async () => {
  const dir = await tmp()
  try {
    const { toolkit, room, resultsDir } = await setup(dir, [{ text: 'ok', usage: {} }])
    const a = await toolkit.results.save(room.id, { tool: 't', args: '{}', text: 'hello' })
    assert.equal(await toolkit.results.remove(room.id, a.id), true)
    assert.deepEqual(await resultFiles(resultsDir), [])
    const b = await toolkit.results.save(room.id, { tool: 't', args: '{}', text: 'hello' })
    assert.equal(b.dedupeOf, undefined)
    assert.equal(await toolkit.results.remove(room.id, 'bad id'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
