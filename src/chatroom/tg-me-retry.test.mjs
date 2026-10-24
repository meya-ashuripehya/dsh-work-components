import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTelegramBots, ME_RETRY_MS } from './telegram-bots.mjs'
import { resolveSeats } from './seats.mjs'
import { createRawHub } from '../telegram/raw-hub.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cfg = {
  chatroomSeats: [
    { id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'T1' } },
    { id: 'gpt', name: 'GPT', telegram: { ingest: false, tokenRef: 'T2' } },
  ],
}
const tokens = { T1: '111:aaaaaaaaaaaaaaaaaaaaaaaa', T2: '222:bbbbbbbbbbbbbbbbbbbbbbbb' }

/** 模拟 Bot API：前 failFirst 次 getMe 抛 fetch failed（与 undici 网络错误一致），之后成功。 */
function fakeApi(failFirst) {
  const calls = { getMe: 0 }
  const fetchImpl = async (url, init) => {
    const parts = url.split('/')
    const method = parts.pop()
    const id = parts.pop().replace(/^bot/, '').split(':')[0]
    if (method === 'getMe') {
      calls.getMe++
      if (calls.getMe <= failFirst) throw new TypeError('fetch failed')
      return { json: async () => ({ ok: true, result: { id: Number(id), username: id === '111' ? 'ds_bot' : 'gpt_bot' } }) }
    }
    if (method === 'getUpdates') await new Promise((r, j) => init.signal?.addEventListener('abort', () => j(new Error('aborted'))))
    return { json: async () => ({ ok: true, result: [] }) }
  }
  return { calls, fetchImpl }
}

test('ME_RETRY_MS: backoff schedule is increasing and capped at one minute', () => {
  assert.ok(ME_RETRY_MS.length >= 3)
  for (let i = 1; i < ME_RETRY_MS.length; i++) assert.ok(ME_RETRY_MS[i] > ME_RETRY_MS[i - 1])
  assert.ok(ME_RETRY_MS.at(-1) <= 60000)
})

test('delegated ingest: startup getMe "fetch failed" is retried with backoff and the error clears once Telegram is reachable', async () => {
  const { calls, fetchImpl } = fakeApi(4) // 主机器人前 2 次 + 委托成员前若干次都会失败
  const hub = typeof createRawHub === 'function' ? createRawHub() : undefined
  const bots = createTelegramBots({
    resolveToken: async (r) => tokens[r],
    getSeats: () => resolveSeats(cfg),
    channelOwnsToken: async () => true, // 两个令牌都由通道轮询 → 委托
    fetchImpl,
    ...(hub ? { hub } : {}),
    meRetryMs: [15, 15],
    onInbound: () => {},
  })
  await bots.startIngest(() => new Set())
  await sleep(5)
  let st = bots.status()
  assert.equal(st.mode, 'delegated')
  assert.match(st.error, /Telegram 连通性异常：fetch failed（第 \d+ 次/)
  assert.equal(st.phase, 'error')
  await sleep(200)
  st = bots.status()
  assert.equal(st.error, '')
  assert.equal(st.phase, 'ready')
  assert.equal(st.username, 'ds_bot')
  assert.equal(st.bots.gpt.mode, 'delegated')
  assert.equal(st.bots.gpt.username, 'gpt_bot')
  assert.equal(st.bots.gpt.error, '')
  const n = calls.getMe
  await sleep(60)
  assert.equal(calls.getMe, n, 'no more getMe after success')
  bots.stopIngest()
})

test('retries stop when ingest is stopped (no timers leak across generations)', async () => {
  const { calls, fetchImpl } = fakeApi(Infinity)
  const hub = typeof createRawHub === 'function' ? createRawHub() : undefined
  const bots = createTelegramBots({
    resolveToken: async (r) => tokens[r],
    getSeats: () => resolveSeats({ chatroomSeats: [cfg.chatroomSeats[0]] }),
    channelOwnsToken: async () => true,
    fetchImpl,
    ...(hub ? { hub } : {}),
    meRetryMs: [10],
    onInbound: () => {},
  })
  await bots.startIngest(() => new Set())
  await sleep(50)
  assert.ok(calls.getMe >= 2)
  bots.stopIngest()
  await sleep(15)
  const n = calls.getMe
  await sleep(60)
  assert.equal(calls.getMe, n)
})
