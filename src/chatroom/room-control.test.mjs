// 房间控制工具：切换主答 / 领队（没有预算工具：预算对 AI 不可见）——校验、上限、回合成功才生效、失败回滚、通知与持久化。
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
import { createTask } from './scheduler.mjs'
import { resolveMember, checkSwitch, controlState, controlNotice, ROOM_CONTROL_TOOLS, ROOM_CONTROL_NAMES, MAX_SWITCHES_PER_TASK } from './room-control.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-rc-'))
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const SEAT_LIST = [
  { id: 'seat-1', name: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', preset: 'lingsnow' },
  { id: 'seat-3', name: 'GPT', provider: 'openai', model: 'gpt-x', leader: true },
  { id: 'seat-5', name: 'Gemini', provider: 'google', model: 'gemini-x', aliases: ['双子'] },
  { id: 'seat-6', name: 'Grok', provider: 'xai', model: 'grok-x', enabled: false },
]

test('member names resolve case-insensitively (name, id, alias, preset); disabled and unknown members are refused', () => {
  const seats = resolveSeats({ chatroomSeats: SEAT_LIST })
  assert.equal(resolveMember(seats, 'gemini').seat.id, 'seat-5')
  assert.equal(resolveMember(seats, '@GEMINI').seat.id, 'seat-5')
  assert.equal(resolveMember(seats, 'Seat-3').seat.id, 'seat-3')
  assert.equal(resolveMember(seats, '双子').seat.id, 'seat-5')
  assert.equal(resolveMember(seats, 'LingSnow').seat.id, 'seat-1')
  assert.match(resolveMember(seats, 'grok').error, /not taking part/)
  assert.match(resolveMember(seats, 'Claude').error, /No member named "Claude"\. Members: deepseek, GPT, Gemini\./)
  assert.match(resolveMember(seats, '').error, /required/)
})

test('limits: switch caps, no switching back, notices in formal Chinese; no budget tool', () => {
  const task = createTask({ id: 't', seats: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], mainId: 'a' })
  assert.equal(MAX_SWITCHES_PER_TASK, 2)
  assert.deepEqual(ROOM_CONTROL_TOOLS.map((t) => t.name), ['set_main_answerer', 'set_leader'])
  assert.ok(!ROOM_CONTROL_NAMES.has('add_turn_budget'))
  const A = { id: 'a', name: 'A' }; const B = { id: 'b', name: 'B' }
  assert.match(checkSwitch(task, 'main', A, 'a'), /already the main answerer/)
  assert.equal(checkSwitch(task, 'main', B, 'a'), null)
  controlState(task).mainHistory.push('a')
  assert.match(checkSwitch(task, 'main', A, 'b'), /switching back is refused/)
  controlState(task).mainSwitches = 2
  assert.match(checkSwitch(task, 'main', { id: 'c', name: 'C' }, 'b'), /already switched 2 times/)
  assert.equal(controlNotice('main', { by: 'Claude', target: 'Gemini' }), 'Claude 将主答切换为 Gemini')
  assert.equal(controlNotice('leader', { by: 'Claude', target: 'GPT', reason: '实现细节最熟' }), 'Claude 将领队切换为 GPT（理由：实现细节最熟）')
  for (const t of ROOM_CONTROL_TOOLS) { assert.match(t.description, /^[\x20-\x7e]+$/); assert.ok(!/budget|turns? (?:left|used)|批准/i.test(t.description)) } // 英文说明，不提预算
})

function fixture({ script, budget = 4, save = true }) {
  return (async () => {
    const dir = await tmp()
    const store = createStore(dir)
    const room = await store.createRoom({})
    let cfgSeats = resolveSeats({ chatroomSeats: SEAT_LIST })
    let defaultMain = 'deepseek'
    const saved = []
    const events = []
    const relayed = []
    const seen = []
    const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null, getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }) })
    const call = async ({ seat, prompt, tools }) => {
      seen.push({ seat: seat.id, tools: (tools || []).map((t) => t.name), prompt })
      const step = script[seat.id]?.shift?.() ?? { text: '[PASS]' }
      const out = typeof step === 'function' ? await step({ prompt }) : step
      return { usage: {}, toolCalls: [], ...out }
    }
    const saveRoomControl = save ? async (change) => {
      saved.push(change)
      const patch = {}
      if (change.defaultMain) { defaultMain = change.defaultMain; patch.chatroomDefaultMain = change.defaultMain }
      if (change.leader) { cfgSeats = cfgSeats.map((s) => ({ ...s, leader: s.id === change.leader })); patch.chatroomSeats = cfgSeats }
      return patch
    } : null
    const tg = { typing: () => () => {}, relay: async (seat, _r, text, o) => { relayed.push({ text, prefix: o?.prefixName }); return [] } }
    const mod = createModerator({ store, call, tg, toolkit, saveRoomControl, emit: (_r, e) => events.push(e), getRoomConfig: () => ({ seats: cfgSeats, userName: 'Shiro', maxTokens: 100, budget, defaultMain, tools: { enabled: false }, attachments: { enabled: false } }) })
    return { dir, store, room, mod, saved, events, relayed, seen, cfg: () => ({ seats: cfgSeats, defaultMain }), done: () => rm(dir, { recursive: true, force: true }) }
  })()
}

test('main answerer switch: applied when the turn ends, saved, announced, relayed, and the new main speaks next', async () => {
  let midTurn
  const f = await fixture({
    script: {
      'seat-1': [
        { toolCalls: [tc('c1', 'set_main_answerer', { member: 'gemini', reason: '图像相关' })] },
        ({ prompt }) => {
          const results = prompt.messages.filter((m) => m.toolResult).map((m) => m.toolResult)
          assert.match(results[0].text, /OK: after your turn Gemini answers first/)
          midTurn = { saved: 0 }
          return { text: '交给 Gemini 主答。' }
        },
      ],
      'seat-5': [{ text: 'Gemini 主答内容' }],
    },
  })
  try {
    f.saved.length = 0
    const { promise } = await f.mod.post(f.room.id, '看看这个设计')
    await promise
    assert.ok(midTurn)
    assert.deepEqual(f.seen[0].tools.slice(0, 2), ['set_main_answerer', 'set_leader'])
    assert.ok(!f.seen[0].tools.includes('add_turn_budget'))
    assert.deepEqual(f.saved, [{ defaultMain: 'Gemini' }])
    assert.equal(f.cfg().defaultMain, 'Gemini')
    const order = f.seen.map((x) => x.seat)
    assert.deepEqual(order.slice(0, 3), ['seat-1', 'seat-1', 'seat-5'])
    const msgs = await f.store.readMessages(f.room.id)
    const sys = msgs.filter((m) => m.kind === 'system').map((m) => m.text)
    assert.ok(sys.includes('deepseek 将主答切换为 Gemini（理由：图像相关）'))
    // 通知在 deepseek 正文之前（回合内发生），并转发 Telegram
    const idxNotice = msgs.findIndex((m) => m.kind === 'system' && /主答切换/.test(m.text))
    const idxText = msgs.findIndex((m) => m.kind === 'seat' && m.text === '交给 Gemini 主答。')
    assert.ok(idxNotice >= 0 && idxNotice < idxText)
    assert.ok(f.relayed.some((r) => r.prefix === '聊天室' && /将主答切换为 Gemini/.test(r.text)))
    assert.ok(f.events.some((e) => e.type === 'room-config' && e.patch.chatroomDefaultMain === 'Gemini'))
    const status = f.mod.status(f.room.id).task
    assert.equal(status.main, 'seat-5'); assert.equal(status.budget, 4)
  } finally { await f.done() }
})

test('leader switch: saved to the seats; switching back in the same task and repeating in one turn are refused', async () => {
  const f = await fixture({
    script: {
      'seat-1': [
        { toolCalls: [tc('c1', 'set_leader', { member: 'Gemini' }), tc('c2', 'set_leader', { member: 'deepseek' })] },
        ({ prompt }) => {
          const r = prompt.messages.filter((m) => m.toolResult).map((m) => m.toolResult)
          assert.equal(r[0].isError, false); assert.equal(r[1].isError, true); assert.match(r[1].text, /already called in this turn/)
          return { text: '领队换成 Gemini。' }
        },
      ],
      'seat-3': [
        { toolCalls: [tc('c3', 'set_leader', { member: 'gpt' }), tc('c4', 'set_main_answerer', { member: 'grok' })] },
        ({ prompt }) => {
          const r = prompt.messages.filter((m) => m.toolResult).map((m) => m.toolResult)
          assert.match(r[0].text, /switching back is refused/)
          assert.match(r[1].text, /Grok is not taking part/)
          return { text: '[PASS]' }
        },
      ],
    },
  })
  try {
    const { promise } = await f.mod.post(f.room.id, '谁来领队？')
    await promise
    assert.deepEqual(f.saved, [{ leader: 'seat-5' }])
    assert.deepEqual(f.cfg().seats.filter((s) => s.leader).map((s) => s.id), ['seat-5'])
    const sys = (await f.store.readMessages(f.room.id)).filter((m) => m.kind === 'system').map((m) => m.text)
    assert.deepEqual(sys.filter((t) => /领队/.test(t)), ['deepseek 将领队切换为 Gemini'])
    // 新领队的提示词里是领队
    const p = buildPrompt({ seat: f.cfg().seats[2], seats: f.cfg().seats, userName: 'Shiro', messages: [], toolsInfo: { owner: true } })
    assert.match(p.system, /You also write the Cursor task briefs/)
    assert.ok(!/budget/i.test(p.system))
  } finally { await f.done() }
})

test('failed turn: reserved switches are dropped — nothing saved, no notice, counters released', async () => {
  const f = await fixture({
    script: {
      'seat-1': [
        { toolCalls: [tc('c1', 'set_main_answerer', { member: 'GPT' })] },
        () => { throw new Error('upstream 500') },
      ],
      'seat-3': [{ toolCalls: [tc('c4', 'set_main_answerer', { member: 'GPT' })] }, { text: 'GPT 补充' }],
    },
  })
  try {
    const { promise } = await f.mod.post(f.room.id, '开始')
    await promise
    const msgs = await f.store.readMessages(f.room.id)
    // deepseek 回合失败：没有它的通知；GPT 的切换（本任务名额未被失败回合占用）生效
    const sys = msgs.filter((m) => m.kind === 'system').map((m) => m.text)
    assert.ok(!sys.some((t) => /^deepseek /.test(t)))
    assert.ok(sys.includes('GPT 将主答切换为 GPT'))
    assert.deepEqual(f.saved, [{ defaultMain: 'GPT' }])
    assert.ok(f.events.some((e) => e.type === 'turn-failed' && e.seatId === 'seat-1'))
  } finally { await f.done() }
})

test('without a settings writer, switches are refused', async () => {
  const f = await fixture({
    save: false,
    script: {
      'seat-1': [
        { toolCalls: [tc('c1', 'set_main_answerer', { member: 'Gemini' })] },
        ({ prompt }) => {
          const r = prompt.messages.filter((m) => m.toolResult).map((m) => m.toolResult)
          assert.match(r[0].text, /cannot be saved/)
          return { text: '好。' }
        },
      ],
    },
  })
  try {
    const { promise } = await f.mod.post(f.room.id, 'hi')
    await promise
    assert.equal(f.mod.status(f.room.id).task.main, 'seat-1')
    assert.equal(f.mod.status(f.room.id).task.budget, 4)
  } finally { await f.done() }
})
