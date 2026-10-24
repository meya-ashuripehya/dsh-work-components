import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator, newTurnControl, untilAborted } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { attachmentLine } from './attachments.mjs'
import { PASS_TOKEN } from './directives.mjs'

// 熔断：用户（任何人）的新消息立即中止进行中的 AI 请求 / 工具循环；被打断的回合按失败回滚但不提示失败，随后为新消息开新一轮。

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-int-'))
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const until = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 5)) } }
const settle = () => new Promise((r) => setTimeout(r, 20))
/** 一直挂起，直到 signal 中止（模拟进行中的模型请求）。 */
const hang = (o) => new Promise((_, rej) => {
  const f = () => rej(Object.assign(new Error('已停止'), { aborted: true }))
  if (o.signal?.aborted) f(); else o.signal?.addEventListener('abort', f, { once: true })
})
const resultFiles = async (d) => { try { return (await readdir(d)).filter((f) => f.endsWith('.txt')) } catch { return [] } }

async function setup(dir, script, { toolExec } = {}) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro' }] })
  const log = []
  const registry = {
    schemas: () => [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    get: (n) => ({ execute: async (args) => { log.push([n, args]); if (toolExec) return toolExec(args); return { content: [{ type: 'text', text: `${n} output` }] } } }),
  }
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => registry, getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }) })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const events = []
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, roomId, text) => { relays.push(text); return [] } }
  const cfg = { seats, userName: 'Shiro', budget: 3, maxTokens: 100, ownerId: '9000000001', defaultMain: 'ds', tools: {} }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, emit: (_, e) => events.push(e) })
  const room = await store.createRoom({ title: '熔断' })
  await toolkit.toolsets.add(room.id, ['read_file'], { max: 10, by: 'test' })
  return { store, moderator, calls, events, relays, room, log, resultsDir: join(dir, 'rooms', room.id, 'tool-results') }
}
const lastUserText = (o) => JSON.stringify(o.prompt.messages)

test('new owner message aborts the in-flight model call immediately; interrupted turn leaves no trace and a fresh round answers the new message', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, calls, events, relays, room } = await setup(dir, [hang, { text: '回答第二条', usage: {} }, { text: PASS_TOKEN, usage: {} }])
    const first = await moderator.post(room.id, '第一条消息', { owner: true, source: 'local', userName: 'Shiro' })
    assert.ok(await until(() => calls.length >= 1))
    const t0 = Date.now()
    const second = await moderator.post(room.id, '第二条，打断一下', { owner: true, source: 'local', userName: 'Shiro' })
    assert.equal(second.interrupted, true)
    assert.equal(calls[0].signal.aborted, true) // 同步中止，不等回复
    await first.promise
    await settle()
    assert.ok(Date.now() - t0 < 2000)
    assert.ok(calls.length >= 2)
    assert.match(lastUserText(calls[1]), /第二条，打断一下/)
    const msgs = await store.readMessages(room.id)
    const seatMsgs = msgs.filter((m) => m.kind === 'seat')
    // 被打断的回合不入库（连 dropped / stopped 也没有）；新一轮的回答正常入库
    assert.deepEqual(seatMsgs.map((m) => `${m.status}:${m.text}`).filter((x) => !x.startsWith('pass')), ['ok:回答第二条'])
    assert.ok(!msgs.some((m) => m.kind === 'system' && /停止|失败/.test(m.text)))
    // 界面：一个 turn-interrupted；没有 turn-failed；Telegram 没有失败说明
    assert.equal(events.filter((e) => e.type === 'turn-interrupted').length, 1)
    assert.equal(events.filter((e) => e.type === 'turn-failed').length, 0)
    assert.ok(!relays.some((t) => /本轮回复失败|已停止|已打断/.test(t)))
    // 新任务基于第二条消息
    const tasks = events.filter((e) => e.type === 'task' && e.task).map((e) => e.task.id)
    assert.ok(tasks.some((id) => id.endsWith(`-${msgs.find((m) => m.text === '第二条，打断一下').seq}`)))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('non-owner human message also interrupts (any human message counts)', async () => {
  const dir = await tmp()
  try {
    const { moderator, calls, events, room } = await setup(dir, [hang, { text: '好的', usage: {} }, { text: PASS_TOKEN, usage: {} }])
    const first = await moderator.post(room.id, '开始', { owner: true, source: 'local', userName: 'Shiro' })
    assert.ok(await until(() => calls.length >= 1))
    const r = await moderator.post(room.id, '我也说一句', { owner: false, source: 'telegram', fromId: '42', userName: 'Guest' })
    assert.equal(r.interrupted, true)
    await first.promise
    assert.equal(events.filter((e) => e.type === 'turn-interrupted').length, 1)
    assert.match(lastUserText(calls[1]), /我也说一句/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('interrupt during a slow tool: does not wait for the tool; the in-flight call leaves no card and no result file', async () => {
  const dir = await tmp()
  try {
    let release
    const slow = new Promise((r) => { release = r })
    const { store, moderator, calls, events, room, log, resultsDir } = await setup(dir, [
      { text: '', toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} },
      { text: '换个话题', usage: {} },
      { text: PASS_TOKEN, usage: {} },
    ], { toolExec: async () => { await slow; return { content: [{ type: 'text', text: 'late' }] } } })
    const first = await moderator.post(room.id, '读 a.txt', { owner: true, source: 'local', userName: 'Shiro' })
    assert.ok(await until(() => log.length >= 1)) // 工具正在执行（且不理会 signal）
    await moderator.post(room.id, '算了，别读了', { owner: true, source: 'local', userName: 'Shiro' })
    await first.promise
    release()
    await settle()
    const msgs = await store.readMessages(room.id)
    assert.ok(!msgs.some((m) => m.kind === 'tool'))
    assert.deepEqual(await resultFiles(resultsDir), [])
    assert.equal(events.filter((e) => e.type === 'turn-interrupted').length, 1)
    assert.match(lastUserText(calls[1]), /算了，别读了/)
    assert.deepEqual(msgs.filter((m) => m.kind === 'seat' && m.status === 'ok').map((m) => m.text), ['换个话题'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('「停止」 still stops (status stopped, no new round, no turn-interrupted)', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, calls, events, room } = await setup(dir, [hang])
    const first = await moderator.post(room.id, '开始', { owner: true, source: 'local', userName: 'Shiro' })
    assert.ok(await until(() => calls.length >= 1))
    const s = await moderator.post(room.id, '停止', { owner: true, source: 'local', userName: 'Shiro' })
    assert.equal(s.stopped, true)
    assert.equal(await first.promise, 'stopped')
    const msgs = await store.readMessages(room.id)
    assert.ok(msgs.some((m) => m.kind === 'seat' && m.status === 'stopped'))
    assert.equal(calls.length, 1)
    assert.equal(events.filter((e) => e.type === 'turn-interrupted').length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('newTurnControl: game turns are not interruptible; parent abort (stop / game step timeout) propagates', () => {
  const parent = new AbortController()
  const g = newTurnControl(parent, { gameTurn: true })
  assert.equal(g.interrupt(), false)
  assert.equal(g.ctl.signal.aborted, false)
  const t = newTurnControl(parent)
  parent.abort()
  assert.equal(g.ctl.signal.aborted, true)
  assert.equal(t.ctl.signal.aborted, true)
  assert.equal(t.interrupted, false)
  const p2 = new AbortController()
  const t2 = newTurnControl(p2)
  assert.equal(t2.interrupt(), true)
  assert.equal(t2.interrupted, true)
  assert.equal(p2.signal.aborted, false) // 打断只中止本回合，不停整个房间
  assert.equal(t2.interrupt(), false)
  t.dispose(); t2.dispose(); g.dispose()
})

test('untilAborted rejects as soon as the signal aborts, even if the work ignores it', async () => {
  const c = new AbortController()
  const never = new Promise(() => {})
  const p = untilAborted(never, c.signal)
  c.abort()
  await assert.rejects(p, (e) => e.aborted === true)
  assert.equal(await untilAborted(Promise.resolve(7), new AbortController().signal), 7)
})

test('text-only member waits for an in-flight image description before its prompt is built', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const seats = resolveSeats({ chatroomSeats: [{ id: 'cl', name: 'Claude', provider: 'claude', model: 'claude-sonnet-5-5' }] })
    const meta = { a1: { id: 'a1', kind: 'image', name: 'shot.jpg', width: 10, height: 20 } }
    let done
    const pending = new Promise((r) => { done = r })
    setTimeout(() => { meta.a1 = { ...meta.a1, description: 'A banned-account notice: "你的账号已被封禁"', describedBy: 'deepseek' }; done() }, 60)
    const calls = []
    const call = async (o) => { calls.push(o); return { text: calls.length === 1 ? '看到描述了' : PASS_TOKEN, usage: {} } }
    const toolkit = { schemas: async () => [], run: async () => ({}), attachments: { list: async () => meta } }
    const cfg = { seats, userName: 'Shiro', budget: 2, maxTokens: 100, ownerId: '1', defaultMain: 'cl', tools: {} }
    const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, isVision: async () => false, pendingDescriptions: () => (meta.a1.description ? [] : [pending]) })
    const room = await store.createRoom({ title: 'desc' })
    const r = await moderator.post(room.id, '', { owner: true, source: 'local', userName: 'Shiro', attachments: [{ id: 'a1', kind: 'image', name: 'shot.jpg', width: 10, height: 20 }] })
    await r.promise
    assert.match(JSON.stringify(calls[0].prompt.messages), /你的账号已被封禁/)
    assert.doesNotMatch(JSON.stringify(calls[0].prompt.messages), /no description yet/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('attachment line keeps long descriptions (up to 600 chars) for text-only members', () => {
  const desc = 'x'.repeat(320) + ' END-MARKER'
  const line = attachmentLine({ id: 'a1', kind: 'image', name: 's.jpg', description: desc, describedBy: 'deepseek' }, { mode: 'stub', vision: false })
  assert.match(line, /END-MARKER/)
})

test('interrupt after a tool completed: the completed card is kept (streamed live, relayed once), the reply is dropped, a fresh round sees it', async () => {
  const dir = await tmp()
  try {
    let fresh
    const { store, moderator, calls, events, relays, room, resultsDir } = await setup(dir, [
      { text: '查一下', toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} },
      hang,
      (o) => { fresh = o.prompt; return { text: '好的，换个方向。', toolCalls: [], usage: {} } },
    ])
    const first = await moderator.post(room.id, '读 a', { owner: true, source: 'local', userName: 'Shiro' })
    await until(() => calls.length >= 2)
    const second = await moderator.post(room.id, '等一下，换个方向', { owner: true, source: 'local', userName: 'Shiro' })
    assert.equal(second.interrupted, true)
    await first.promise.catch(() => {}); await second.promise; await settle()
    const msgs = await store.readMessages(room.id)
    const card = msgs.find((m) => m.kind === 'tool')
    assert.ok(card && card.salvaged && card.speaker.name === 'DeepSeek')
    assert.equal((await resultFiles(resultsDir)).length, 1)
    assert.ok(!msgs.some((m) => m.kind === 'seat' && /查一下/.test(m.text)))
    assert.equal(events.filter((e) => e.type === 'retract').length, 0)
    assert.equal(events.filter((e) => e.type === 'turn-interrupted').length, 1)
    assert.ok(relays.filter((r) => /read_file/.test(JSON.stringify(r))).length <= 1)
    assert.ok(JSON.stringify(fresh.messages).includes('#' + card.data.resultId))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
