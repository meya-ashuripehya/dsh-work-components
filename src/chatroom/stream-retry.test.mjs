import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator, isTransientFailure, isGatewayBogusInvalidRequest, STREAM_DROP_RETRIES, GATEWAY_INVALID_RETRIES } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { ProviderError, isConnectFailure, isStreamDropFailure, hasStreamed, callSeatWithWait } from './providers.mjs'
import { callEntry } from './call-log.mjs'

// DSH 的 DeepSeek 适配器把 fetch / 读流时的底层异常（经代理时多为 undici「terminated ← other side closed」）统一包成这一句
const dsDrop = (partial) => Object.assign(new ProviderError('deepseek 请求失败：DeepSeek Messages transport failed', { code: 'TRANSPORT' }), partial ? { partial } : {})
const gatewayInvalid = () => Object.assign(new Error('Claude 请求失败：400 {"error":{"type":"<nil>","message":"Invalid request. Please check the format and content of your request. (request_id: aaa) (request id: 20261024012638xxx)"},"type":"error"}'), { code: 'INVALID_REQUEST', status: 400 })

test('stream drop: DeepSeek "transport failed" is a connect failure only before any output', () => {
  assert.equal(isConnectFailure(dsDrop()), true)
  assert.equal(isConnectFailure(dsDrop({ text: '部分' })), false)
  assert.equal(isConnectFailure(dsDrop({ thoughts: new Map([[0, '想']]) })), false)
})

test('stream drop: per-seat wait now retries DeepSeek transport failures before output', async () => {
  let n = 0
  const out = await callSeatWithWait(async () => { n++; if (n === 1) throw dsDrop(); return { text: '好' } }, { seat: { timeoutSec: 20 } }, { now: () => 0, sleep: async () => {} })
  assert.equal(out.text, '好'); assert.equal(n, 2)
})

test('stream drop: classification', () => {
  for (const e of [dsDrop(), dsDrop({ text: 'x' }), new ProviderError('grok 请求失败：terminated', { code: 'TRANSPORT' }), new ProviderError('GPT 请求失败：Connection error.', { code: 'TRANSPORT' }), new Error('调用失败：other side closed'), new ProviderError('GPT 请求失败：Request timed out.', { code: 'TIMEOUT' })]) assert.equal(isStreamDropFailure(e), true, e.message)
  for (const e of [
    new ProviderError('已停止', { aborted: true }),
    new ProviderError('DeepSeek Messages stream idle timeout', { code: 'TIMEOUT' }),
    new ProviderError('deepseek 请求失败：Authentication Fails', { code: 'AUTH' }),
    new ProviderError('deepseek 请求失败：HTTP 500 upstream error', { code: 'SERVER' }),
    new ProviderError('deepseek 请求失败：Rate limit reached', { code: 'RATE_LIMIT' }),
    Object.assign(new ProviderError('GPT 请求失败：Request timed out.', { code: 'TIMEOUT' }), { partial: { text: 'x' } }),
    new Error('DeepSeek 请求失败：HTTP 500 upstream error'),
    null,
  ]) assert.equal(isStreamDropFailure(e), false, String(e?.message))
  assert.equal(hasStreamed({ text: '' }), false); assert.equal(hasStreamed({ toolCalls: [{}] }), true)
})

test('stream drop: counted as a transient failure (classification only; no longer marks away)', () => {
  assert.equal(isTransientFailure(dsDrop()), true)
  assert.equal(isTransientFailure(new Error('grok 请求失败：terminated')), true)
  assert.equal(isTransientFailure(new Error('缺少 OPENAI_API_KEY')), false)
})

test('call log: failed entries record how much had streamed and whether a retry follows', () => {
  const e = callEntry({ roomId: 'r', seat: { name: 'deepseek', provider: 'deepseek-official', model: 'deepseek-v4-pro' }, error: dsDrop({ text: 'abc', thoughts: new Map([[0, '想一想']]), usage: { output: 0 } }), ms: 33000, attempt: 1, retrying: true })
  assert.equal(e.code, 'TRANSPORT'); assert.equal(e.partialChars, 3); assert.equal(e.partialThinkChars, 3); assert.equal(e.retrying, true); assert.equal(e.attempt, undefined)
  const ok = callEntry({ roomId: 'r', seat: { name: 'deepseek' }, out: { text: '好', toolCalls: [] }, ms: 10, attempt: 2 })
  assert.equal(ok.attempt, 2); assert.equal(ok.ok, true)
})

const registry = () => ({ schemas: () => [], get: () => null })
async function setup(dir, script, { streamRetryMs = 0 } = {}) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'deepseek', provider: 'deepseek-official', model: 'deepseek-v4-pro' }] })
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => registry(), getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }) })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const events = []
  const logs = []
  const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {} }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, emit: (_, e) => events.push(e), logCall: (x) => logs.push(x), streamRetryMs })
  const room = await store.createRoom({ title: '中转站' })
  return { store, moderator, calls, events, logs, room }
}
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-sr-'))
const settle = () => new Promise((r) => setTimeout(r, 20))

test('stream drop: a step cut mid-stream is re-requested once; the live row is reset and only the retry is stored', async () => {
  const dir = await tmp()
  try {
    const { store, moderator, calls, events, logs, room } = await setup(dir, [
      async (o) => { o.onReasoning?.('想'); o.onDelta?.('说到一半'); throw dsDrop({ text: '说到一半', thoughts: new Map([[0, '想']]) }) },
      async (o) => { o.onDelta?.('完整的回复'); return { text: '完整的回复', toolCalls: [], usage: {} } },
    ])
    await (await moderator.post(room.id, '你好', { owner: true, source: 'local' })).promise
    await settle()
    assert.equal(STREAM_DROP_RETRIES, 1)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].prompt, calls[0].prompt) // 同一步、同一提示词
    const msgs = await store.readMessages(room.id)
    const seatMsgs = msgs.filter((m) => m.kind === 'seat')
    assert.equal(seatMsgs.length, 1); assert.equal(seatMsgs[0].text, '完整的回复'); assert.equal(seatMsgs[0].status, 'ok')
    assert.ok(!msgs.some((m) => /说到一半/.test(m.text || '')))
    assert.equal(events.filter((e) => e.type === 'turn-failed').length, 0)
    const turns = events.filter((e) => e.type === 'turn' && e.seatId === 'ds')
    assert.equal(turns.length, 2); assert.equal(turns[1].retry, 1) // 第二个 turn 事件：界面清掉半截临时行
    assert.equal(logs[0].retrying, true); assert.equal(logs[0].attempt, 1); assert.ok(logs[0].error)
    assert.equal(logs[1].out.text, '完整的回复')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('stream drop: a drop before any output retries without resetting the row; a second drop fails the turn as transient', async () => {
  const dir = await tmp()
  try {
    const { moderator, calls, events, logs, room } = await setup(dir, [async () => { throw dsDrop() }])
    await (await moderator.post(room.id, '你好', { owner: true, source: 'local' })).promise
    await settle()
    assert.equal(calls.length, 2)
    assert.equal(events.filter((e) => e.type === 'turn' && e.retry).length, 0)
    const failed = events.filter((e) => e.type === 'turn-failed')
    assert.equal(failed.length, 1); assert.match(failed[0].reason, /transport failed/); assert.equal(failed[0].awayMinutes, undefined)
    assert.deepEqual(logs.map((l) => [l.attempt, l.retrying]), [[1, true], [2, false]])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('stream drop: provider errors (HTTP 500, auth) are not re-requested', async () => {
  const dir = await tmp()
  try {
    const { moderator, calls, events, room } = await setup(dir, [async () => { throw new ProviderError('deepseek 请求失败：HTTP 500 upstream error', { code: 'SERVER' }) }])
    await (await moderator.post(room.id, '你好', { owner: true, source: 'local' })).promise
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(events.filter((e) => e.type === 'turn-failed').length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('stream drop: stopping during the retry pause does not re-request', async () => {
  const dir = await tmp()
  try {
    let mod
    let rid
    const { moderator, calls, room } = await setup(dir, [async () => { setTimeout(() => mod.stop(rid), 5); throw dsDrop() }], { streamRetryMs: 2000 })
    mod = moderator; rid = room.id
    const t0 = Date.now()
    await (await moderator.post(room.id, '你好', { owner: true, source: 'local' })).promise
    await settle()
    assert.equal(calls.length, 1)
    assert.ok(Date.now() - t0 < 1500)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('gateway Invalid request: classified as bogus gateway 400 and retry budget set', () => {
  assert.equal(isGatewayBogusInvalidRequest(gatewayInvalid()), true)
  assert.equal(isGatewayBogusInvalidRequest(new Error('Claude 请求失败：400 messages.0.content: empty')), false)
  assert.equal(GATEWAY_INVALID_RETRIES, 2)
})

test('gateway Invalid request: re-requested up to GATEWAY_INVALID_RETRIES; success on last attempt is stored', async () => {
  const dir = await tmp()
  try {
    let n = 0
    const { store, moderator, calls, events, logs, room } = await setup(dir, [
      async () => { n++; throw gatewayInvalid() },
      async () => { n++; throw gatewayInvalid() },
      async (o) => { n++; o.onDelta?.('好了'); return { text: '好了', toolCalls: [], usage: {} } },
    ], { streamRetryMs: 0 })
    await (await moderator.post(room.id, '你好', { owner: true, source: 'local' })).promise
    await settle()
    assert.equal(n, 3)
    assert.equal(calls.length, 3)
    const msgs = await store.readMessages(room.id)
    assert.equal(msgs.filter((m) => m.kind === 'seat').at(-1)?.text, '好了')
    assert.equal(events.filter((e) => e.type === 'turn-failed').length, 0)
    assert.equal(logs.filter((l) => l.retrying).length, 2)
    assert.ok(logs.at(-1).out)
    assert.equal(logs.at(-1).error, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('gateway Invalid request: exhausted retries surface as upstream-unavailable, not raw 400', async () => {
  const dir = await tmp()
  try {
    const { moderator, calls, events, room } = await setup(dir, [async () => { throw gatewayInvalid() }], { streamRetryMs: 0 })
    await (await moderator.post(room.id, '你好', { owner: true, source: 'local' })).promise
    await settle()
    assert.equal(calls.length, 1 + GATEWAY_INVALID_RETRIES)
    const failed = events.filter((e) => e.type === 'turn-failed')
    assert.equal(failed.length, 1)
    assert.match(failed[0].reason, /上游服务暂时不可用/)
    assert.ok(!/Invalid request\. Please check/.test(failed[0].reason))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

