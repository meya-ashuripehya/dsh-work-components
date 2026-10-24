// /compact: manual context compress from the chat input / Telegram; no round, nothing AI-visible.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { parseCompactCommand } from './directives.mjs'
import { createCompressor } from './ctx-compress.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-compact-'))
const settle = () => new Promise((r) => setTimeout(r, 30))

async function setup({ summarizer = true, bot = 'ds_room_bot' } = {}) {
  const dir = await tmp()
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm', telegram: { username: bot } }] })
  const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {} }
  const calls = []
  const call = async (o) => { calls.push(o); return { text: 'hi', usage: {}, toolCalls: [] } }
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, roomId, text) => { relays.push(text); return [] } }
  const llm = { stream: async function* () { yield { type: 'text-delta', text: '滚动摘要：大家讨论了压缩。' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const compressor = createCompressor({ store, getLlm: () => llm, getSettings: () => ({ provider: summarizer ? 'deepseek' : '', model: summarizer ? 'flash' : '', window: 4, threshold: 200000, userName: 'Shiro' }) })
  const compacts = []
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, tg, compactContext: (roomId) => { compacts.push(roomId); return compressor.compress(roomId, { force: true, quiet: true }) } })
  const room = await store.createRoom({ title: 'compact' })
  for (let i = 1; i <= 10; i++) await store.append(room.id, { kind: i % 2 ? 'user' : 'seat', speaker: i % 2 ? { id: 'user', name: 'Shiro' } : { id: 'ds', name: 'DeepSeek' }, text: 'message ' + i })
  return { dir, store, seats, moderator, calls, relays, compacts, room, done: () => rm(dir, { recursive: true, force: true }) }
}

const promptText = (store, roomId, seats) => store.readMessages(roomId).then(async (msgs) => {
  const meta = await store.getRoom(roomId)
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, maxHistory: 4, contextSummary: meta.contextSummary?.text || '', contextUntilSeq: meta.contextSummary?.untilSeq || 0 })
  return p.messages.map((m) => m.content).join('\n')
})

test('parseCompactCommand: bare, args, @bot variants', () => {
  assert.deepEqual(parseCompactCommand('/compact'), { args: '' })
  assert.deepEqual(parseCompactCommand('  /COMPACT  '), { args: '' })
  assert.deepEqual(parseCompactCommand('/compact now please'), { args: 'now please' })
  assert.equal(parseCompactCommand('/compactx'), null)
  assert.equal(parseCompactCommand('please /compact'), null)
  assert.deepEqual(parseCompactCommand('/compact@ds_room_bot', ['ds_room_bot']), { args: '' })
  assert.equal(parseCompactCommand('/compact@other_bot', ['ds_room_bot']), null)
  assert.deepEqual(parseCompactCommand('/compact@any_bot', []), { args: '' })
})

test('/compact triggers compress, starts no round, stores no user message, notice hidden from AI', async () => {
  const f = await setup()
  try {
    const before = (await f.store.readMessages(f.room.id)).length
    const out = await f.moderator.post(f.room.id, '/compact', { owner: true, source: 'local' })
    await settle()
    assert.equal(out.started, false)
    assert.equal(out.message, null)
    assert.equal(out.compacted, true)
    assert.equal(f.compacts.length, 1)
    assert.equal(f.calls.length, 0, 'no AI round')
    const msgs = await f.store.readMessages(f.room.id)
    assert.equal(msgs.length, before + 1, 'only the result notice is stored')
    assert.ok(!msgs.some((m) => m.kind === 'user' && /\/compact/.test(m.text)))
    const note = msgs[msgs.length - 1]
    assert.equal(note.kind, 'system'); assert.equal(note.notice, 'compact')
    assert.match(note.text, /已压缩上下文：\d+ 条/)
    assert.equal(f.relays.length, 0, 'local command is not relayed to Telegram')
    const prompt = await promptText(f.store, f.room.id, f.seats)
    assert.match(prompt, /滚动摘要：大家讨论了压缩/, 'summary still enters the prompt')
    assert.ok(!/已压缩上下文|\/compact/.test(prompt), 'command and its notice stay out of the prompt')
  } finally { await f.done() }
})

test('/compact with arguments: usage notice, no compress, no round', async () => {
  const f = await setup()
  try {
    const out = await f.moderator.post(f.room.id, '/compact everything', { owner: true, source: 'local' })
    await settle()
    assert.equal(out.started, false); assert.equal(out.compacted, false)
    assert.equal(f.compacts.length, 0); assert.equal(f.calls.length, 0)
    const msgs = await f.store.readMessages(f.room.id)
    assert.equal(msgs[msgs.length - 1].text, '用法：/compact（不带参数）')
    assert.equal((await f.store.getRoom(f.room.id)).contextSummary, undefined)
    assert.ok(!/用法/.test(await promptText(f.store, f.room.id, f.seats)))
  } finally { await f.done() }
})

test('/compact without summarizer: 未配置 notice, hidden from AI', async () => {
  const f = await setup({ summarizer: false })
  try {
    const out = await f.moderator.post(f.room.id, '/compact', { owner: true, source: 'local' })
    assert.equal(out.compacted, false); assert.equal(f.calls.length, 0)
    const msgs = await f.store.readMessages(f.room.id)
    assert.match(msgs[msgs.length - 1].text, /自动压缩未启用：请选择摘要模型/)
    assert.ok(!/未配置/.test(await promptText(f.store, f.room.id, f.seats)))
  } finally { await f.done() }
})

test('Telegram /compact@bot from owner compresses and replies to the group; non-owner refused', async () => {
  const f = await setup()
  try {
    const out = await f.moderator.post(f.room.id, '/compact@ds_room_bot', { owner: true, source: 'telegram', fromId: '1', userName: 'Shiro' })
    await settle()
    assert.equal(out.compacted, true); assert.equal(f.calls.length, 0)
    assert.ok(f.relays.some((t) => /已压缩上下文/.test(t)), 'result goes back to the group')
    const other = await f.moderator.post(f.room.id, '/compact', { owner: false, source: 'telegram', fromId: '2', userName: 'Guest' })
    assert.equal(other.compacted, false); assert.equal(f.compacts.length, 1)
    const msgs = await f.store.readMessages(f.room.id)
    assert.match(msgs[msgs.length - 1].text, /只有 Shiro 可以压缩上下文/)
    // a command addressed to another bot is just a normal message
    const foreign = await f.moderator.post(f.room.id, '/compact@other_bot', { owner: true, source: 'telegram', fromId: '1', userName: 'Shiro', run: false })
    assert.ok(foreign.message && foreign.message.kind === 'user')
  } finally { await f.done() }
})
