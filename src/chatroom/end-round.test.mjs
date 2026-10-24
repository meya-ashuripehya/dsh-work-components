// end_round：世界控制台的「暂停」键——只给本轮主答与领队；回合成功才生效（失败 / 停止时撤销，卡片一并撤回）；
// 生效后本轮立即结束（不再请其他成员、不写预算提示）；「×× 结束了这一轮」只在界面显示，不转发、不进提示词；新消息照常开新一轮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { createTask, staleness } from './scheduler.mjs'
import { hiddenFromAi, isCardMsg, listCards, listBinText, planSweep, findCards } from './card-bin.mjs'
import { canEndRound, endRoundNotice, endRoundTool, END_ROUND_NAME, ROOM_CONTROL_NAMES, ROOM_CONTROL_TOOLS } from './room-control.mjs'

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const SEAT_LIST = [
  { id: 'seat-1', name: 'deepseek', provider: 'deepseek', model: 'deepseek-flash' },
  { id: 'seat-3', name: 'GPT', provider: 'openai', model: 'gpt-x', leader: true },
  { id: 'seat-5', name: 'Gemini', provider: 'google', model: 'gemini-x' },
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fixture({ script, budget = 6 }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-er-'))
  const store = createStore(dir)
  const room = await store.createRoom({})
  const seats = resolveSeats({ chatroomSeats: SEAT_LIST })
  const events = []; const relayed = []; const seen = []
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null, getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }) })
  const call = async ({ seat, prompt, tools, signal }) => {
    seen.push({ seat: seat.id, tools: (tools || []).map((t) => t.name), prompt })
    const step = script[seat.id]?.shift?.() ?? { text: '[PASS]' }
    const out = typeof step === 'function' ? await step({ prompt, signal }) : step
    return { usage: {}, toolCalls: [], ...out }
  }
  const tg = { typing: () => () => {}, relay: async (_s, _r, text) => { relayed.push(text); return [] } }
  const mod = createModerator({ store, call, tg, toolkit, saveRoomControl: async () => ({}), emit: (_r, e) => events.push(e), getRoomConfig: () => ({ seats, userName: 'Shiro', maxTokens: 100, budget, defaultMain: 'deepseek', tools: { enabled: false }, attachments: { enabled: false } }) })
  return { dir, store, room, mod, events, relayed, seen, seats, done: () => rm(dir, { recursive: true, force: true }) }
}
const promptText = (p) => [p.system, ...p.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m.toolResult ?? '')))].join('\n')

test('end_round: pure parts — eligibility (main / leader, not game turns), notice, English description', () => {
  const task = createTask({ id: 't', seats: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], mainId: 'a' })
  assert.equal(canEndRound({ id: 'a' }, task), true)
  assert.equal(canEndRound({ id: 'b', leader: true }, task), true)
  assert.equal(canEndRound({ id: 'c' }, task), false)
  assert.equal(canEndRound({ id: 'a' }, { ...task, gameTurn: true }), false)
  assert.equal(canEndRound({ id: 'a' }, { ...task, state: 'ended' }), false)
  assert.equal(canEndRound({ id: 'a' }, null), false)
  assert.ok(ROOM_CONTROL_NAMES.has(END_ROUND_NAME)); assert.ok(!ROOM_CONTROL_TOOLS.some((t) => t.name === END_ROUND_NAME)) // 不是人人都有
  assert.equal(endRoundNotice('GPT'), 'GPT 结束了这一轮')
  assert.equal(endRoundNotice('GPT', '  等 Shiro\n决定 '), 'GPT 结束了这一轮（理由：等 Shiro 决定）')
  const d = endRoundTool('Shiro').description
  assert.match(d, /world's console and press pause/); assert.match(d, /waiting on Shiro/); assert.match(d, /real point pending/)
  assert.ok(!/budget|turns? (?:left|used)/i.test(d))
  assert.equal(endRoundTool().parameters.required, undefined) // reason 可选
})

test('end_round: offered only to the main answerer and the leader; the rule appears only for them; others are refused', async () => {
  const f = await fixture({ script: {
    'seat-1': [{ text: '主答先说。' }],
    'seat-3': [{ text: '领队补充。' }],
    'seat-5': [{ toolCalls: [tc('x', 'end_round', {})] }, ({ prompt }) => { const r = prompt.messages.filter((m) => m.toolResult).pop().toolResult; assert.equal(r.isError, true); assert.match(r.text, /Only the main answerer and the leader/); return { text: 'Gemini 也说一句。' } }],
  } })
  try {
    const { promise } = await f.mod.post(f.room.id, '大家看看')
    await promise
    const by = (id) => f.seen.find((x) => x.seat === id)
    assert.ok(by('seat-1').tools.includes('end_round')); assert.ok(by('seat-3').tools.includes('end_round')); assert.ok(!by('seat-5').tools.includes('end_round'))
    assert.match(by('seat-1').prompt.system, /press pause \(end_round\)/); assert.match(by('seat-3').prompt.system, /press pause \(end_round\)/); assert.ok(!/end_round/.test(by('seat-5').prompt.system))
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(!msgs.some((m) => m.tool === 'end_round')); assert.ok(!msgs.some((m) => /结束了这一轮/.test(m.text || '')))
    assert.ok(msgs.some((m) => m.text === 'Gemini 也说一句。'))
  } finally { await f.done() }
})

test('end_round: applied after a successful turn — round stops at once, card + panel-only notice, no budget notice / wrap-up, nothing to Telegram or prompts; a new message starts a fresh round', async () => {
  const f = await fixture({ script: {
    'seat-1': [
      { toolCalls: [tc('e1', 'end_round', { reason: '等 Shiro 决定 SECRETWHY' })] },
      ({ prompt }) => { assert.match(prompt.messages.filter((m) => m.toolResult).pop().toolResult.text, /^OK: the round ends right after your turn/); return { text: '好，等你决定。' } },
      { text: '新一轮主答。' },
    ],
    'seat-3': [{ text: '不该出现' }, { text: '新一轮领队。' }],
    'seat-5': [{ text: '不该出现' }, { text: '新一轮 Gemini。' }],
  } })
  try {
    const { promise } = await f.mod.post(f.room.id, '这个方案怎么样')
    assert.equal(await promise, 'ended')
    assert.deepEqual(f.seen.map((x) => x.seat), ['seat-1', 'seat-1'])
    let msgs = await f.store.readMessages(f.room.id)
    const iCard = msgs.findIndex((m) => m.kind === 'tool' && m.tool === 'end_round')
    const iText = msgs.findIndex((m) => m.text === '好，等你决定。')
    const iNote = msgs.findIndex((m) => m.notice === 'end-round')
    assert.ok(iCard >= 0 && iCard < iText && iText < iNote, `${iCard} ${iText} ${iNote}`)
    const card = msgs[iCard]
    assert.equal(card.text, '结束本轮'); assert.equal(card.data.endRound, true); assert.equal(card.speaker.name, 'deepseek')
    // 卡片只给界面：存为 hidden（同失败回合），AI 侧一律看不到
    assert.equal(card.status, 'hidden'); assert.equal(hiddenFromAi(card), true); assert.equal(isCardMsg(card), false)
    assert.ok(!JSON.stringify(listCards(msgs, {})).includes('end_round'))
    assert.ok(!listBinText(msgs, { [card.id]: { by: 'x' } }).includes('结束本轮'))
    { const sw = planSweep(msgs, {}, { ids: ['s' + card.seq] }); assert.deepEqual(sw.ids, []); assert.deepEqual(sw.unknown, ['s' + card.seq]) }
    assert.ok(!planSweep(msgs, {}).ids.includes(card.id))
    assert.deepEqual(findCards(msgs, 's' + card.seq), [])
    assert.equal(staleness(msgs[iText].seq, msgs.slice(0, iText + 1).concat([{ ...card, seq: 9e9 }]), 'seat-3').verdict, 'fresh')
    assert.equal(msgs[iNote].text, 'deepseek 结束了这一轮（理由：等 Shiro 决定 SECRETWHY）'); assert.equal(msgs[iNote].relay, false)
    assert.ok(!msgs.some((m) => /回合上限/.test(m.text || '')))
    assert.equal(f.mod.status(f.room.id).task.state, 'ended')
    assert.ok(f.events.some((e) => e.type === 'run' && e.running === false && e.reason === 'ended'))
    // Telegram：有正文，没有卡片和通知
    assert.ok(f.relayed.some((t) => t === '好，等你决定。'))
    assert.ok(!f.relayed.some((t) => /结束|end_round|SECRETWHY/.test(t)))
    // 提示词：通知、理由、卡片都不在（不留「按了暂停」之类的痕迹）
    const p = promptText(buildPrompt({ seat: f.seats[2], seats: f.seats, userName: 'Shiro', messages: msgs }))
    assert.ok(!p.includes('结束了这一轮')); assert.ok(!p.includes('SECRETWHY')); assert.ok(!p.includes('结束本轮')); assert.ok(!/pressed pause|ended the round/.test(p))
    assert.ok(p.includes('好，等你决定。'))
    // 新消息：照常开新一轮
    const r2 = await f.mod.post(f.room.id, '那就这样定了')
    await r2.promise
    const after = f.seen.slice(2).map((x) => x.seat)
    assert.equal(after[0], 'seat-1'); assert.ok(after.includes('seat-3') && after.includes('seat-5'))
    for (const x of f.seen.slice(2)) { const t = promptText(x.prompt); assert.ok(!t.includes('SECRETWHY')); assert.ok(!t.includes('结束本轮')); assert.ok(!/pressed pause|ended the round/.test(t)) }
    msgs = await f.store.readMessages(f.room.id)
    assert.equal(msgs.filter((m) => m.notice === 'end-round').length, 1)
  } finally { await f.done() }
})

test('end_round: rolled back with a failed turn (no card, no notice, the round goes on) and with a stopped turn', async () => {
  const f = await fixture({ script: {
    'seat-1': [{ toolCalls: [tc('e1', 'end_round', { reason: 'r' })] }, () => { throw new Error('upstream 500') }],
    'seat-3': [{ text: '领队继续。' }],
    'seat-5': [{ text: 'Gemini 继续。' }],
  } })
  try {
    const { promise } = await f.mod.post(f.room.id, '开始')
    await promise
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(!msgs.some((m) => m.tool === 'end_round')); assert.ok(!msgs.some((m) => m.notice === 'end-round'))
    assert.ok(msgs.some((m) => m.text === '领队继续。')); assert.ok(msgs.some((m) => m.text === 'Gemini 继续。'))
    assert.notEqual(f.mod.status(f.room.id).task.state, 'ended')
  } finally { await f.done() }
  let release
  const g = await fixture({ script: {
    'seat-1': [{ toolCalls: [tc('e1', 'end_round', {})] }, ({ signal }) => new Promise((_, rej) => { release = () => rej(Object.assign(new Error('aborted'), { aborted: true })); signal?.addEventListener('abort', () => release()) })],
  } })
  try {
    const { promise } = await g.mod.post(g.room.id, '开始')
    for (let i = 0; i < 200 && !release; i++) await sleep(5)
    g.mod.stop(g.room.id)
    assert.equal(await promise, 'stopped')
    const msgs = await g.store.readMessages(g.room.id)
    assert.ok(!msgs.some((m) => m.tool === 'end_round')); assert.ok(!msgs.some((m) => m.notice === 'end-round'))
    assert.notEqual(g.mod.status(g.room.id).task.state, 'ended')
  } finally { await g.done() }
})
test('end_round: cards stored by older versions (status ok) are hidden from AIs too; other cards unchanged', () => {
  const seats = [{ id: 'seat-1', name: 'DeepSeek' }, { id: 'seat-3', name: 'GPT' }]
  const legacy = { id: 'm1', seq: 3, kind: 'tool', tool: 'end_round', text: '结束本轮', data: { ok: true, endRound: true, title: '结束本轮' }, speaker: { id: 'seat-3', name: 'GPT' }, status: 'ok' }
  const other = { id: 'm2', seq: 4, kind: 'tool', tool: 'web_search', text: '搜索', data: { ok: true, resultId: 'rabc', title: 'web_search: x' }, speaker: { id: 'seat-1', name: 'DeepSeek' }, status: 'ok' }
  const msgs = [{ id: 'm0', seq: 2, kind: 'user', text: '开始', speaker: { id: 'user', name: 'Shiro' }, status: 'ok' }, legacy, other]
  assert.equal(hiddenFromAi(legacy), true); assert.equal(hiddenFromAi(other), false)
  const p = promptText(buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs }))
  assert.ok(!/pressed pause|ended the round|结束本轮/.test(p)); assert.match(p, /rabc/)
  const lc = listCards(msgs, {})
  assert.equal(lc.counts.all, 1); assert.ok(!JSON.stringify(lc).includes('end_round'))
})
