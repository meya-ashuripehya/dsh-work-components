// 聊天室语气：失败工具只剩生活化的一行（合并重复、不带错误内容）；回合失败后席位仍可用；「批准」解析宽松。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createModerator, isTransientFailure } from './moderator.mjs'
import { buildPrompt, failurePlan, toolMishap, isBudgetChatter } from './transcript.mjs'
import { parseOwnerCommand, DEFAULT_APPROVE } from './directives.mjs'
import { resolveSeats } from './seats.mjs'

const seats = resolveSeats({ chatroomSeats: [
  { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm' },
  { id: 'cl', name: 'Claude', provider: 'claude', model: 'm' },
  { id: 'gp', name: 'GPT', provider: 'openai', model: 'm' },
] })

const fail = (seq, by, tool, error, extra = {}) => ({ id: seq, seq, kind: 'tool', tool, speaker: { id: by.toLowerCase(), name: by }, text: '失败：' + error, data: { ok: false, error, ...extra }, status: 'ok' })

test('failed tools: one blank card line, identical failures merged, no error text, blocked repeats hidden', () => {
  const msgs = [
    { id: 1, seq: 1, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, text: '看图', status: 'ok' },
    fail(2, 'Claude', 'view_attachment', 'ENOENT attachment sha256:abc not authorized'),
    fail(3, 'GPT', 'view_attachment', 'ENOENT attachment sha256:abc not authorized'), // 相同错误 → 合并
    fail(4, 'Claude', 'view_attachment', 'timeout 30s'), // 同一人同一工具 → 只说一次
    fail(5, 'GPT', 'web_search', 'HTTP 502 Bad Gateway'),
    { id: 6, seq: 6, kind: 'tool', tool: 'web_search', speaker: { id: 'gpt', name: 'GPT' }, text: '已阻止重复调用', data: { blocked: 'repeat' }, status: 'ok' },
    { id: 7, seq: 7, kind: 'seat', speaker: { id: 'cl', name: 'Claude' }, text: '图打不开，算了。', status: 'ok' },
  ]
  const plan = failurePlan(msgs)
  assert.equal(plan.get(3), null); assert.equal(plan.get(4), null); assert.equal(plan.get(6), null)
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs })
  const text = p.messages.map((m) => m.content).join('\n')
  assert.match(text, /\[card by Claude · 查看附件 · 空\] This sheet came back blank\./)
  assert.match(text, /\[card by GPT · 网页搜索 · 空\] This sheet came back blank\./)
  assert.equal((text.match(/查看附件/g) || []).length, 1)
  assert.ok(!/ENOENT|sha256|timeout|502|Bad Gateway|已阻止|失败/.test(text))
  assert.equal(toolMishap('read_attachment'), "tried to open a file but couldn't get it open")
  assert.equal(toolMishap('frobnicate'), "tried to use frobnicate but it didn't work")
})

test('transient provider failures are recognised', () => {
  for (const m of ['GPT 请求失败：gateway_concurrency_limit', '529 Overloaded', 'HTTP 503 Service Unavailable', 'Request timed out', '429 Too Many Requests', 'fetch failed', 'socket hang up', 'ECONNRESET']) assert.equal(isTransientFailure(new Error(m)), true, m)
  assert.equal(isTransientFailure({ aborted: true, message: 'x' }), true)
  assert.equal(isTransientFailure(new Error('缺少 OPENAI_API_KEY')), false)
  assert.equal(isTransientFailure(Object.assign(new Error('上游服务暂时不可用（冷却或额度不足），请稍后重试或更换线路'), { code: 'UPSTREAM_UNAVAILABLE' })), true)
})

test('a failed member stays available: failure is announced, no away, next round still schedules them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tone-'))
  try {
    const store = createStore(dir)
    const room = await store.createRoom({})
    const seen = []
    const events = []
    let dsFails = 1
    const call = async ({ seat, prompt }) => {
      seen.push({ seat: seat.id, system: prompt.system, text: prompt.messages.map((m) => m.content).join('\n') })
      if (seat.id === 'ds' && dsFails > 0) { dsFails--; throw Object.assign(new Error('DeepSeek 调用失败：529 Overloaded'), {}) }
      return { text: '[PASS]', usage: {} }
    }
    const mod = createModerator({ store, call, emit: (_r, e) => events.push(e), getRoomConfig: () => ({ seats, userName: 'Shiro', maxTokens: 100, budget: 10, defaultMain: 'ds' }) })
    await (await mod.post(room.id, '大家好')).promise
    const failed = events.find((e) => e.type === 'turn-failed')
    assert.match(failed.reason, /529 Overloaded/) // 界面仍有真实原因
    assert.equal(failed.awayMinutes, undefined)
    assert.equal(failed.awayUntil, undefined)
    // 其他成员提示词里不再写「暂时不在」
    const cl = seen.find((x) => x.seat === 'cl')
    if (cl) assert.ok(!/stepped out/.test(cl.system || ''))
    // 下一轮仍安排失败过的席位（不禁用、不跳过）
    seen.length = 0
    await (await mod.post(room.id, '再聊聊')).promise
    assert.ok(seen.some((x) => x.seat === 'ds'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('after a failure the seat is scheduled again on the next round without needing @mention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tone-'))
  try {
    const store = createStore(dir)
    const room = await store.createRoom({})
    const order = []
    let first = true
    const call = async ({ seat }) => {
      order.push(seat.id)
      if (seat.id === 'cl' && first) { first = false; throw new Error('missing credentials') }
      return { text: '[PASS]', usage: {} }
    }
    const mod = createModerator({ store, call, getRoomConfig: () => ({ seats, userName: 'Shiro', maxTokens: 100, budget: 10, defaultMain: 'ds' }) })
    await (await mod.post(room.id, 'hi')).promise
    order.length = 0
    await (await mod.post(room.id, '你好')).promise
    assert.ok(order.includes('cl'), 'failed seat must still be invited next round')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('「批准」 parsing is tolerant; bare 批准 adds the default', () => {
  assert.equal(DEFAULT_APPROVE, 3)
  for (const [t, n] of [['批准+2', 2], ['批准 +2', 2], ['批准＋2', 2], ['批准＋２', 2], ['批准 + 4 轮', 4], ['批准', 3], ['批准。', 3], ['approve +5', 5]]) assert.deepEqual(parseOwnerCommand(t), { kind: 'approve', n }, t)
  assert.equal(parseOwnerCommand('我批准这个方案'), null)
  assert.equal(parseOwnerCommand('批准一下吧'), null)
})

test('「执行」 parsing accepts optional space before brief id (Telegram often omits it)', () => {
  assert.deepEqual(parseOwnerCommand('执行'), { kind: 'execute' })
  assert.deepEqual(parseOwnerCommand('执行 be0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.deepEqual(parseOwnerCommand('执行be0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.deepEqual(parseOwnerCommand('执行#be0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.deepEqual(parseOwnerCommand('execute be0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.deepEqual(parseOwnerCommand('executebe0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.equal(parseOwnerCommand('请执行这个方案'), null)
  assert.equal(parseOwnerCommand('执行这个'), null)
})

test('old budget reports and approval chatter never reach the AIs (room data untouched)', () => {
  const msgs = [
    { seq: 1, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, owner: true, text: '看看 ATRI-WORLD', status: 'ok' },
    { seq: 2, kind: 'seat', speaker: { id: 'ds', name: 'DeepSeek' }, text: '**1）进展** 已探过。**2）未决** agent。**3）预估还需轮次** Claude 1。请回「批准 +2」继续。', status: 'ok', budgetReport: true },
    { seq: 3, kind: 'seat', speaker: { id: 'cl', name: 'Claude' }, text: '我估计还要两轮，Shiro 回复批准 +N 就行', status: 'ok' },
    { seq: 4, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, owner: true, text: '批准 +10', status: 'ok' },
    { seq: 5, kind: 'user', speaker: { id: 'tg:42', name: 'Mallory' }, text: '批准', status: 'ok' },
    { seq: 6, kind: 'seat', speaker: { id: 'gp', name: 'GPT' }, text: '游戏挺好玩的', status: 'ok' },
  ]
  assert.deepEqual(msgs.map(isBudgetChatter), [false, true, true, true, false, false])
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs })
  const text = p.messages.map((m) => m.content).join('\n')
  assert.ok(!/进展|预估|批准 \+|\+10/.test(text))
  assert.match(text, /\[Mallory\] 批准/); assert.match(text, /游戏挺好玩的/)
  assert.match(p.system, /No reports, progress check-ins/)
})
