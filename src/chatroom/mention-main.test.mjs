// 点名主答：用户消息里第一个提到的成员（@名字 或直接写名字，按出现位置）做本任务的主答，只管这一个任务；
// 失败后不再「暂时离开」；点名仍可指定本任务主答。未启用的成员不参与；只有用户消息触发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { resolveSeats } from './seats.mjs'
import { firstNamedSeat, seatNames } from './directives.mjs'

const SEATS = resolveSeats({ chatroomSeats: [
  { id: 'seat-1', name: 'deepseek', provider: 'deepseek', model: 'm', preset: 'lingsnow' },
  { id: 'seat-2', name: 'grok', provider: 'xai', model: 'm', preset: 'grok' },
  { id: 'seat-3', name: 'GPT', provider: 'openai', model: 'm', preset: 'chatgpt', leader: true },
  { id: 'seat-4', name: 'Claude', provider: 'claude', model: 'm', preset: 'claude', aliases: ['克劳德'] },
  { id: 'seat-5', name: 'Gemini', provider: 'google', model: 'm', preset: 'gemini' },
  { id: 'seat-6', name: 'Mistral', provider: 'mistral', model: 'm', enabled: false },
] })
const named = (text, opts) => firstNamedSeat(text, SEATS, opts)?.id || null

test('firstNamedSeat: the name that appears first in the text wins, not member-list order', () => {
  assert.equal(named('Gemini 你先说，然后 deepseek 补充'), 'seat-5')
  assert.equal(named('deepseek 你先说，然后 Gemini 补充'), 'seat-1')
  assert.equal(named('刚才 Claude 和 GPT 都说了'), 'seat-4')
  assert.equal(named('请 @Gemini 看看，Claude 也听着'), 'seat-5')
  assert.equal(named('Claude 先，@Gemini 后'), 'seat-4') // @ 不比直接写名字优先：按位置
  assert.equal(named('没有提到任何人'), null)
  assert.equal(named(''), null)
})

test('firstNamedSeat: case-insensitive; @Name; Chinese neighbours; aliases, ids, preset ids and preset display names', () => {
  assert.equal(named('CLAUDE 在吗'), 'seat-4')
  assert.equal(named('gemini来一下'), 'seat-5')
  assert.equal(named('让gPt回答'), 'seat-3')
  assert.equal(named('@grok 你来'), 'seat-2')
  assert.equal(named('请 @claude_bot 来'), 'seat-4') // 机器人用户名里的名字：下划线不算字母数字
  assert.equal(named('克劳德你看看'), 'seat-4') // 别名
  assert.equal(named('seat-5 你说'), 'seat-5') // 编号
  assert.equal(named('ChatGPT 你怎么看'), 'seat-3') // 预设编号
  assert.equal(named('灵雪你来答', { presetNames: { lingsnow: '灵雪' } }), 'seat-1') // 预设显示名
  assert.equal(named('灵雪你来答'), null)
  assert.deepEqual(seatNames(SEATS[0], { lingsnow: '灵雪' }), ['deepseek', 'seat-1', 'lingsnow', '灵雪'])
  assert.deepEqual(seatNames({ id: 'x', name: 'GPT', aliases: ['g', 'gpt'] }), ['GPT']) // 单个 ASCII 字符与重复不收
})

test('firstNamedSeat: Latin names must not sit inside longer words; URLs and e-mail addresses are ignored', () => {
  assert.equal(named('Claudette 来了'), null)
  assert.equal(named('MyGPT 和 gpt4 都不是'), null)
  assert.equal(named('geminis grokking'), null)
  assert.equal(named('GPT-5 怎么样'), 'seat-3') // 连字符不是字母数字
  assert.equal(named('Claudette 和 Claude'), 'seat-4') // 跳过误中，取后面真正的点名
  assert.equal(named('看 https://deepseek.com/docs 和 gpt@example.com'), null)
  assert.equal(named('看 https://grok.x.ai 之后 Gemini 说说'), 'seat-5')
  assert.equal(named('邮件 a@b.com'), null)
})

test('firstNamedSeat: disabled members are ignored (the next named enabled member wins)', () => {
  assert.equal(named('Mistral 在吗'), null)
  assert.equal(named('Mistral 不在的话，Claude 来'), 'seat-4')
  const off = SEATS.map((s) => (s.id === 'seat-4' ? { ...s, enabled: false } : s))
  assert.equal(firstNamedSeat('Claude 和 Gemini', off)?.id, 'seat-5')
})

async function fixture({ script = {}, budget = 6, presetNames, toolkit: withTools = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-named-'))
  const store = createStore(dir)
  const room = await store.createRoom({})
  const seen = []; const events = []
  const fail = new Set()
  const call = async ({ seat, tools }) => {
    seen.push({ seat: seat.id, tools: (tools || []).map((t) => t.name) })
    if (fail.has(seat.id)) { fail.delete(seat.id); throw new Error('missing credentials') }
    const step = script[seat.id]?.shift?.() ?? '[PASS]'
    return { usage: {}, toolCalls: [], ...(typeof step === 'string' ? { text: step } : step) }
  }
  const toolkit = withTools ? createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null, getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }) }) : null
  const mod = createModerator({
    store, call, toolkit, presetNames, saveRoomControl: async () => ({}), emit: (_r, e) => events.push(e),
    getRoomConfig: () => ({ seats: SEATS, userName: 'Shiro', maxTokens: 100, budget, defaultMain: 'deepseek', tools: { enabled: false }, attachments: { enabled: false } }),
  })
  const say = async (text) => { seen.length = 0; const r = await mod.post(room.id, text, { owner: true, source: 'local', userName: 'Shiro' }); await r.promise; return mod.status(room.id).task }
  return { store, room, mod, seen, events, fail, say, done: () => rm(dir, { recursive: true, force: true }) }
}

test('moderator: a bare name makes that member main for this task only; the next task goes back to the default', async () => {
  const f = await fixture()
  try {
    let t = await f.say('Gemini，你先说说，然后 Claude 补充')
    assert.equal(t.main, 'seat-5')
    assert.equal(f.seen[0].seat, 'seat-5')
    t = await f.say('大家继续')
    assert.equal(t.main, 'seat-1')
    assert.equal(f.seen[0].seat, 'seat-1')
  } finally { await f.done() }
})

test('moderator: after a failure the seat stays available on the next round; naming still sets main for that task', async () => {
  const f = await fixture()
  try {
    f.fail.add('seat-4')
    await f.say('你好')
    const failed = f.events.find((e) => e.type === 'turn-failed' && e.seatId === 'seat-4')
    assert.ok(failed)
    assert.equal(failed.awayMinutes, undefined)
    await f.say('再聊聊')
    assert.ok(f.seen.some((x) => x.seat === 'seat-4')) // 失败后不禁用：下一轮照常安排
    f.seen.length = 0
    const t = await f.say('claude 你回来了吗？顺便 GPT 也看看') // 直接写名字，不用 @；Claude 在前
    assert.equal(t.main, 'seat-4')
    assert.equal(f.seen[0].seat, 'seat-4')
    const t2 = await f.say('好的，大家继续')
    assert.equal(t2.main, 'seat-1') // 主答恢复默认
    assert.ok(f.seen.some((x) => x.seat === 'seat-4'))
  } finally { await f.done() }
})

test('moderator: only the first named member becomes main; failed seats are still scheduled later in the round', async () => {
  const f = await fixture()
  try {
    f.fail.add('seat-4'); f.fail.add('seat-5')
    await f.say('你好')
    f.seen.length = 0
    const t = await f.say('Gemini 和 Claude 都在吗')
    assert.equal(t.main, 'seat-5')
    assert.equal(f.seen[0].seat, 'seat-5')
    // 失败后不禁用：席位仍在轮转中（主答为 Gemini 已断言）；不再要求 Claude 被跳过
  } finally { await f.done() }
})

test('moderator: disabled members are ignored; AI replies naming someone do not change the main answerer', async () => {
  const f = await fixture({ script: { 'seat-1': ['我觉得 Gemini 说得对，Claude 你怎么看？'] } })
  try {
    let t = await f.say('Mistral 在吗？')
    assert.equal(t.main, 'seat-1')
    assert.ok(!f.seen.some((x) => x.seat === 'seat-6'))
    assert.deepEqual(f.seen.map((x) => x.seat).slice(0, 2), ['seat-1', 'seat-2']) // AI 回复里的名字不改主答、不插队
  } finally { await f.done() }
})

test('moderator: preset display names count (via presetNames), refreshed per user message', async () => {
  let calls = 0
  const f = await fixture({ presetNames: async () => { calls++; return { lingsnow: '灵雪', claude: 'Claude 助手' } } })
  try {
    let t = await f.say('Gemini 先别说，灵雪你来')
    assert.equal(t.main, 'seat-5') // 仍按位置：Gemini 在前
    t = await f.say('灵雪你来')
    assert.equal(t.main, 'seat-1')
    assert.ok(calls >= 2)
  } finally { await f.done() }
})

test('moderator: the named main answerer gets end_round for that task; the regular default does not keep it', async () => {
  const f = await fixture({ toolkit: true })
  try {
    await f.say('Gemini 你来主答')
    const g = f.seen.find((x) => x.seat === 'seat-5')
    assert.ok(g.tools.includes('end_round'))
    assert.ok(!f.seen.find((x) => x.seat === 'seat-1').tools.includes('end_round')) // 本任务 DeepSeek 不是主答
    assert.ok(f.seen.find((x) => x.seat === 'seat-3').tools.includes('end_round')) // 领队照旧
    await f.say('继续讨论')
    assert.ok(f.seen.find((x) => x.seat === 'seat-1').tools.includes('end_round'))
    assert.ok(!f.seen.find((x) => x.seat === 'seat-5').tools.includes('end_round'))
  } finally { await f.done() }
})