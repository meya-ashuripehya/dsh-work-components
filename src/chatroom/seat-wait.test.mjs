import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callSeatWithWait, isConnectFailure, normalizeSeatWait, ProviderError } from './providers.mjs'
import { normalizeSeats } from './seats.mjs'

const timedOut = () => new ProviderError('GPT 请求失败：Request timed out.', { code: 'TIMEOUT' })
const connErr = () => new ProviderError('GPT 请求失败：Connection error.', { code: 'TRANSPORT' })
/** 假时钟：每次调用推进 step 毫秒（模拟 DSH 的 10 秒连接上限）。 */
function clock(step) { let t = 0; return { now: () => t, advance: (ms) => { t += ms } } }

test('seat wait: normalized per seat; default 0 keeps the old behaviour', () => {
  assert.equal(normalizeSeatWait(undefined), 0)
  assert.equal(normalizeSeatWait('20'), 20)
  assert.equal(normalizeSeatWait(-5), 0)
  assert.equal(normalizeSeatWait(999), 120)
  assert.equal(normalizeSeatWait(2), 5)
  const seats = normalizeSeats([{ id: 'gpt', name: 'GPT', provider: 'gpt-vision', model: 'gpt-6.1-sol', timeoutSec: 20 }, { id: 'ds', name: 'DS', provider: 'deepseek', model: 'v4' }])
  assert.equal(seats[0].timeoutSec, 20); assert.equal(seats[1].timeoutSec, 0)
})

test('seat wait: connect failures are retried within the seat budget, then the last error is thrown', async () => {
  const c = clock()
  let calls = 0
  const retries = []
  const call = async () => { calls++; c.advance(10500); throw timedOut() }
  await assert.rejects(callSeatWithWait(call, { seat: { name: 'GPT', timeoutSec: 20 } }, { now: c.now, sleep: async (ms) => c.advance(ms), onRetry: (e, n, ms) => retries.push([n, ms]) }), /Request timed out/)
  assert.equal(calls, 2) // 10.5 s 失败 → 重试；21.5 s 失败 → 超出 20 秒，不再重试
  assert.deepEqual(retries, [[1, 10500]])
})

test('seat wait: a retry that connects returns normally; budget 0 never retries', async () => {
  const c = clock()
  let calls = 0
  const call = async (o) => { calls++; if (calls === 1) { c.advance(10500); throw timedOut() } o.onDelta?.('好'); return { text: '好' } }
  const deltas = []
  const out = await callSeatWithWait(call, { seat: { timeoutSec: 20 }, onDelta: (t) => deltas.push(t) }, { now: c.now, sleep: async () => {} })
  assert.equal(out.text, '好'); assert.equal(calls, 2); assert.deepEqual(deltas, ['好'])
  let n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; throw timedOut() }, { seat: { timeoutSec: 0 } }), /timed out/)
  assert.equal(n, 1)
})

test('seat wait: no retry after output, on stop, on non-connect errors; at most 3 attempts', async () => {
  const fast = { now: () => 0, sleep: async () => {} }
  let n = 0
  await assert.rejects(callSeatWithWait(async (o) => { n++; o.onDelta('部分'); throw timedOut() }, { seat: { timeoutSec: 20 }, onDelta: () => {} }, fast)); assert.equal(n, 1)
  n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; const e = timedOut(); e.partial = { text: 'x' }; throw e }, { seat: { timeoutSec: 20 } }, fast)); assert.equal(n, 1)
  n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; throw new ProviderError('已停止', { aborted: true }) }, { seat: { timeoutSec: 20 } }, fast)); assert.equal(n, 1)
  n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; throw new ProviderError('GPT 请求失败：401 invalid api key', { code: 'AUTH' }) }, { seat: { timeoutSec: 20 } }, fast)); assert.equal(n, 1)
  n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; throw new ProviderError('grok 请求失败：terminated', { code: 'TRANSPORT' }) }, { seat: { timeoutSec: 20 } }, fast)); assert.equal(n, 1)
  const ac = new AbortController()
  n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; ac.abort(); throw connErr() }, { seat: { timeoutSec: 20 }, signal: ac.signal }, fast)); assert.equal(n, 1)
  n = 0
  await assert.rejects(callSeatWithWait(async () => { n++; throw connErr() }, { seat: { timeoutSec: 20 } }, fast)); assert.equal(n, 3)
  assert.equal(isConnectFailure(connErr()), true); assert.equal(isConnectFailure(timedOut()), true)
  assert.equal(isConnectFailure(new ProviderError('pi-ai stream idle timeout after 300000ms', { code: 'TIMEOUT' })), false)
})