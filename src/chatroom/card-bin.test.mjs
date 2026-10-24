// 卡片回收站：收进 / 列出 / 取回、提示词中隐藏、回合失败与打断时撤销、用户在界面移出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { CARD_BIN_TOOLS, planSweep, planRestore, listBinText, binnedSet, cardRef, hiddenFromAi, isCardMsg, listCards, binNoteNames, binNoteText } from './card-bin.mjs'
import { staleness } from './scheduler.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-bin-'))
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const settle = () => new Promise((r) => setTimeout(r, 20))
const registry = () => ({
  schemas: () => [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  get: (n) => ({ execute: async (args) => ({ content: [{ type: 'text', text: `${n} output ${args.path} ` + 'x'.repeat(200) }] }) }),
})
const results = (o) => o.prompt.messages.filter((m) => m.toolResult).map((m) => m.toolResult)

async function setup(dir, script) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro' }] })
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => registry(), getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }) })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; const out = typeof step === 'function' ? await step(o) : step; return { usage: {}, toolCalls: [], ...out } }
  const events = []
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, roomId, text, o) => { relays.push({ text, prefix: o?.prefixName }); return [] } }
  const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {} }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, emit: (_, e) => events.push(e) })
  const room = await store.createRoom({ title: '回收站' })
  await toolkit.toolsets.add(room.id, ['read_file'], { max: 10, by: 'test' })
  const say = async (text) => { const out = await moderator.post(room.id, text, { owner: true, source: 'local', userName: 'Shiro' }); await out.promise; await settle(); return out }
  return { store, moderator, calls, events, relays, toolkit, room, seats, say }
}

const card = (seq, rid, extra = {}) => ({ id: 'm' + seq, seq, kind: 'tool', tool: 'read_file', speaker: { id: 'ds', name: 'DeepSeek' }, data: { resultId: rid, title: 'read ' + rid, ok: true }, ...extra })

test('tools: three, English, world\'s console framing', () => {
  assert.deepEqual(CARD_BIN_TOOLS.map((t) => t.name), ['sweep_cards', 'list_bin', 'restore_card'])
  for (const t of CARD_BIN_TOOLS) { assert.match(t.description, /^[\x20-\x7e]+$/); assert.match(t.description, /recycle bin under the world's console/) }
})

test('planSweep: default = before the current round; ids; before; current-turn and already-binned cards stay', () => {
  const msgs = [card(1, 'raaaa1'), { id: 'm2', seq: 2, kind: 'user', text: 'hi' }, card(3, 'rbbbb1'), card(4, 'rcccc1', { data: { title: 'no id' } }), { id: 'm5', seq: 5, kind: 'user', text: 'next' }, card(6, 'rdddd1')]
  assert.deepEqual(planSweep(msgs, {}, { roundSeq: 5 }).ids, ['m1', 'm3', 'm4'])
  assert.deepEqual(planSweep(msgs, { m1: { by: 'x' } }, { roundSeq: 5 }).ids, ['m3', 'm4'])
  assert.deepEqual(planSweep(msgs, {}, {}).ids, ['m1', 'm3', 'm4', 'm6'])
  assert.deepEqual(planSweep(msgs, {}, { before: 'rbbbb1' }).ids, ['m1'])
  assert.deepEqual(planSweep(msgs, {}, { before: '#s4' }).ids, ['m1', 'm3'])
  const p = planSweep(msgs, { m1: {} }, { ids: ['#raaaa1', 'rdddd1', 'rzzzz9', 'rnew01'], turnRefs: new Set(['rnew01']) })
  assert.deepEqual(p.ids, ['m6']); assert.deepEqual(p.unknown, ['rzzzz9']); assert.deepEqual(p.current, ['rnew01']); assert.equal(p.already, 1)
  assert.equal(cardRef(msgs[2]), 'rbbbb1'); assert.equal(cardRef(msgs[3]), 's4'); assert.equal(cardRef({ seq: 9, data: {} }), 's9')
  assert.deepEqual(planRestore(msgs, { m1: {} }, { ids: ['raaaa1', 'rbbbb1'] }), { ids: ['m1'], unknown: [], notBinned: ['rbbbb1'] })
  // 指向已不存在消息的条目不算
  assert.deepEqual([...binnedSet(msgs, { m1: {}, gone: {} })], ['m1'])
})

test('list_bin: newest first, keyword filter, paging', () => {
  const msgs = Array.from({ length: 30 }, (_, k) => card(k + 1, 'r' + String(k + 1).padStart(5, '0')))
  const bin = Object.fromEntries(msgs.map((m) => [m.id, { by: 'GPT' }]))
  const t = listBinText(msgs, bin, {})
  assert.match(t, /Recycle bin: 30 cards, showing 1-20/); assert.match(t.split('\n')[1], /#r00030/); assert.match(t, /offset 20/)
  assert.match(listBinText(msgs, bin, { offset: 20 }), /showing 21-30/)
  assert.match(listBinText(msgs, bin, { query: 'r00007' }), /1 matching card of 30/)
  assert.match(listBinText(msgs, {}, {}), /empty/)
})

test('prompt: binned cards vanish entirely; one bin line; an old stored sweep card is hidden from AIs', () => {
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'x' }] })
  const msgs = [{ id: 'u1', seq: 1, kind: 'user', text: 'hi' }, card(2, 'raaaa1'), card(3, 'rbbbb1'),
    { id: 'm4', seq: 4, kind: 'tool', tool: 'sweep_cards', speaker: { id: 'ds', name: 'DeepSeek' }, text: '收进回收站 · 1 张卡片', data: { ok: true, binOp: 'sweep', count: 1, title: 'swept 1 card into the recycle bin' } }]
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, toolsInfo: { owner: true, finder: true }, binned: new Set(['m2']) })
  const all = p.messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
  assert.ok(!all.includes('raaaa1')); assert.ok(all.includes('rbbbb1'))
  assert.ok(!all.includes('swept')); assert.ok(!all.includes('binOp')); assert.ok(!all.includes('收进回收站'))
  assert.match(p.system, /1 older card sits in the recycle bin under the console/)
  const none = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, toolsInfo: { owner: true, finder: true } })
  assert.ok(!/recycle bin/.test(none.system))
})

test('sweep on commit: older cards binned (current-turn card stays), persisted, UI note not relayed; open_card/list_bin/restore_card work', async () => {
  const dir = await tmp()
  let aRid
  const seen = {}
  try {
    const f = await setup(dir, [
      { toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })] },
      { text: '读完了' },
      { toolCalls: [tc('c2', 'read_file', { path: 'b.txt' }), tc('c3', 'sweep_cards', {})] },
      (o) => { seen.sweep = results(o).map((r) => r.text); return { text: '收拾好了' } },
      (o) => { seen.prompt = o.prompt; return { toolCalls: [tc('c4', 'list_bin', {}), tc('c5', 'open_card', { id: aRid })] } },
      (o) => { seen.after = results(o).map((r) => r.text); return { toolCalls: [tc('c6', 'restore_card', { ids: [aRid] })] } },
      (o) => { seen.restore = results(o).slice(-1)[0].text; return { text: '放回去了' } },
    ])
    await f.say('读 a')
    aRid = (await f.store.readMessages(f.room.id)).find((m) => m.kind === 'tool').data.resultId
    await f.say('读 b 顺便收拾一下')
    let msgs = await f.store.readMessages(f.room.id)
    const aCard = msgs.find((m) => m.data?.resultId === aRid)
    const bCard = msgs.find((m) => m.kind === 'tool' && m.data?.resultId && m.data.resultId !== aRid)
    let meta = await f.store.getRoom(f.room.id)
    assert.deepEqual(Object.keys(meta.cardBin), [aCard.id])
    assert.equal(meta.cardBin[aCard.id].by, 'DeepSeek')
    assert.match(seen.sweep[1], /OK: 1 card goes into the recycle bin/)
    // 收进回收站不产生卡片（也没有「进行中」的暂存卡片），只有一行写明卡片名的界面提示
    assert.ok(!msgs.some((m) => m.tool === 'sweep_cards'))
    assert.ok(!f.events.some((e) => e.type === 'message' && e.message?.tool === 'sweep_cards'))
    const notes = msgs.filter((m) => m.kind === 'system' && m.notice === 'card-bin')
    assert.equal(notes.length, 1)
    const note = notes[0]
    assert.equal(note.text, 'DeepSeek 把 1 张卡片收进了回收站（read_file）'); assert.equal(note.relay, false)
    assert.ok(!f.relays.some((r) => /回收站/.test(r.text)))
    assert.ok(f.events.some((e) => e.type === 'card-bin' && e.bin[aCard.id]))
    assert.ok(bCard && !meta.cardBin[bCard.id])
    // 下一轮：提示词里没有 a 卡片，有回收站一行
    await f.say('还在吗')
    const text = seen.prompt.messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
    assert.ok(!text.includes(aRid)); assert.ok(text.includes(bCard.data.resultId))
    assert.match(seen.prompt.system, /1 older card sits in the recycle bin/)
    assert.match(seen.after[0], /Recycle bin: 1 card[\s\S]*#/ ); assert.ok(seen.after[0].includes(aRid))
    assert.match(seen.after[1], /read_file output a\.txt/)
    assert.match(seen.restore, /OK: 1 card goes back on the table/)
    meta = await f.store.getRoom(f.room.id)
    assert.deepEqual(meta.cardBin, {})
    msgs = await f.store.readMessages(f.room.id)
    assert.ok(msgs.some((m) => m.kind === 'system' && m.text === 'DeepSeek 从回收站取回了 1 张卡片（read_file）'))
    assert.ok(!msgs.some((m) => m.tool === 'restore_card'))
    // 重启后（新的 store / moderator）状态仍在
    const store2 = createStore(dir)
    assert.deepEqual((await store2.getRoom(f.room.id)).cardBin, {})
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failed turn: a sweep made in that turn is undone', async () => {
  const dir = await tmp()
  try {
    const f = await setup(dir, [
      { toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })] },
      { text: '读完了' },
      { toolCalls: [tc('c2', 'sweep_cards', {}), tc('c3', 'read_file', { path: 'b.txt' })] },
      async () => { throw new Error('DeepSeek 请求失败：HTTP 500 upstream error') },
    ])
    await f.say('读 a')
    await f.say('收拾一下')
    const meta = await f.store.getRoom(f.room.id)
    assert.deepEqual(meta.cardBin || {}, {})
    const msgs = await f.store.readMessages(f.room.id)
    // 同一失败回合里已完成的 read_file 卡片保留，sweep 的卡片撤回
    assert.ok(msgs.some((m) => m.kind === 'tool' && m.tool === 'read_file' && m.salvaged))
    assert.ok(!msgs.some((m) => m.tool === 'sweep_cards' || m.notice === 'card-bin'))
    assert.ok(!f.events.some((e) => e.type === 'card-bin'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('interrupt: a sweep made in the interrupted turn is undone', async () => {
  const dir = await tmp()
  try {
    const f = await setup(dir, [
      { toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })] },
      { text: '读完了' },
      { toolCalls: [tc('c2', 'sweep_cards', {})] },
      (o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('已停止'), { aborted: true })))),
      { text: '新消息的回答' },
    ])
    await f.say('读 a')
    const first = await f.moderator.post(f.room.id, '收拾一下', { owner: true, source: 'local', userName: 'Shiro' })
    for (let k = 0; k < 50 && f.calls.length < 4; k++) await settle()
    const second = await f.moderator.post(f.room.id, '等等，先别收', { owner: true, source: 'local', userName: 'Shiro' })
    assert.equal(second.interrupted, true)
    await first.promise.catch(() => {}); await second.promise; await settle()
    assert.deepEqual((await f.store.getRoom(f.room.id)).cardBin || {}, {})
    assert.ok(!(await f.store.readMessages(f.room.id)).some((m) => m.tool === 'sweep_cards'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('user restore from the panel (POST /bin backend): immediate, noted, emits card-bin; stale entries pruned', async () => {
  const dir = await tmp()
  try {
    const f = await setup(dir, [{ toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })] }, { text: '好' }])
    await f.say('读 a')
    const a = (await f.store.readMessages(f.room.id)).find((m) => m.kind === 'tool')
    await f.store.patchMeta(f.room.id, (m) => { m.cardBin = { [a.id]: { by: 'GPT' }, gone: { by: 'GPT' } }; return m })
    const r = await f.moderator.restoreCards(f.room.id, [a.id])
    assert.equal(r.restored, 1); assert.deepEqual(r.bin, {})
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(msgs.some((m) => m.kind === 'system' && m.text === '您从回收站取回了 1 张卡片（read_file）' && m.relay === false))
    assert.ok(f.events.some((e) => e.type === 'card-bin'))
    assert.equal((await f.moderator.restoreCards(f.room.id, [a.id])).restored, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('bin note text: names the cards, merges same tool, truncates after 3 kinds', () => {
  assert.equal(binNoteText({ op: 'sweep', who: 'grok ', tools: ['mcp_windows__PowerShell'] }), 'grok 把 1 张卡片收进了回收站（mcp_windows__PowerShell）')
  assert.equal(binNoteText({ op: 'restore', who: '您', tools: ['read_file', 'read_file'] }), '您从回收站取回了 2 张卡片（read_file ×2）')
  assert.equal(binNoteNames(['a', 'b', 'a', 'c', 'd', 'e']), 'a ×2、b、c 等 6 张')
  assert.equal(binNoteNames(['a', 'b', 'c']), 'a、b、c')
})

test('old stored bin-op cards: hidden from AIs, not cards (listCards / planSweep / list_bin / staleness)', () => {
  const old = { id: 'm4', seq: 4, kind: 'tool', tool: 'sweep_cards', speaker: { id: 'gk', name: 'grok' }, status: 'ok', text: '收进回收站 · 1 张卡片', data: { ok: true, binOp: 'sweep', count: 1, title: 'swept 1 card into the recycle bin' } }
  const msgs = [card(1, 'raaaa1'), { id: 'u2', seq: 2, kind: 'user', text: 'hi' }, card(3, 'rbbbb1'), old]
  assert.equal(hiddenFromAi(old), true); assert.equal(isCardMsg(old), false)
  assert.equal(listCards(msgs, {}).total, 2)
  assert.deepEqual(planSweep(msgs, {}, {}).ids, ['m1', 'm3'])
  assert.deepEqual(planSweep(msgs, {}, { ids: ['s4'] }).unknown, ['s4'])
  assert.deepEqual([...binnedSet(msgs, { m4: { by: 'x' } })], [])
  assert.match(listBinText(msgs, { m4: { by: 'x' } }), /empty/)
  // 其他成员看来：旧回收站卡片与回收站提示都不算新消息
  const note = { id: 'n5', seq: 5, kind: 'system', notice: 'card-bin', relay: false, text: 'grok 把 1 张卡片收进了回收站（read_file）' }
  assert.equal(staleness(3, [...msgs, note], 'ds').verdict, 'fresh')
})

test('prompt: bin notices never reach AIs and take no history slots', () => {
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'x' }] })
  const msgs = [{ id: 'u1', seq: 1, kind: 'user', text: 'first' }, { id: 'u2', seq: 2, kind: 'user', text: 'second' },
    { id: 'n3', seq: 3, kind: 'system', notice: 'card-bin', relay: false, text: 'grok 把 1 张卡片收进了回收站（read_file）' },
    { id: 't4', seq: 4, kind: 'tool', tool: 'sweep_cards', speaker: { id: 'gk', name: 'grok' }, status: 'ok', text: '收进回收站 · 1 张卡片', data: { ok: true, binOp: 'sweep', count: 1 } }]
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, maxHistory: 2 })
  const all = p.messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
  assert.ok(all.includes('first') && all.includes('second')) // 两条历史名额都给了真实消息
  assert.ok(!all.includes('回收站'))
})

test('two sweeps in one turn → one merged note; consecutive panel sweeps by the same person merge in place', async () => {
  const dir = await tmp()
  try {
    let ids = []
    const f = await setup(dir, [
      { toolCalls: [tc('c1', 'read_file', { path: 'a.txt' }), tc('c2', 'read_file', { path: 'b.txt' })] },
      { text: '读完了' },
      () => ({ toolCalls: [tc('c3', 'sweep_cards', { ids: [ids[0]] }), tc('c4', 'sweep_cards', { ids: [ids[1]] })] }),
      { text: '收拾好了' },
    ])
    await f.say('读 a b')
    let msgs = await f.store.readMessages(f.room.id)
    ids = msgs.filter((m) => m.kind === 'tool').map((m) => m.data.resultId)
    await f.say('收拾')
    msgs = await f.store.readMessages(f.room.id)
    let notes = msgs.filter((m) => m.notice === 'card-bin')
    assert.deepEqual(notes.map((m) => m.text), ['DeepSeek 把 2 张卡片收进了回收站（read_file ×2）'])
    assert.equal(Object.keys((await f.store.getRoom(f.room.id)).cardBin).length, 2)
    // 界面里连续两次移出（中间没有别的消息）→ 同一行改写
    const cardIds = msgs.filter((m) => m.kind === 'tool' && m.data?.resultId).map((m) => m.id)
    await f.moderator.restoreCards(f.room.id, [cardIds[0]])
    await f.moderator.restoreCards(f.room.id, [cardIds[1]])
    msgs = await f.store.readMessages(f.room.id)
    notes = msgs.filter((m) => m.notice === 'card-bin')
    assert.deepEqual(notes.map((m) => m.text), ['DeepSeek 把 2 张卡片收进了回收站（read_file ×2）', '您从回收站取回了 2 张卡片（read_file ×2）'])
    assert.ok(f.events.some((e) => e.type === 'message-update' && e.message?.notice === 'card-bin'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
