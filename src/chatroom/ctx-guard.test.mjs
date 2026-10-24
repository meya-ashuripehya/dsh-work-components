/**
 * In-turn tool loop caps (step cap, accumulated tool-result size cap), per-request context check,
 * upstream cooldown / long-context error mapping, and the summarizer model picker in the settings UI.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator, capToolResults, normalizeUpstreamError, longContextFailure, isTransientFailure, isGatewayBogusInvalidRequest, UPSTREAM_UNAVAILABLE_TEXT } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const settle = () => new Promise((r) => setTimeout(r, 20))
const COOLDOWN = 'Extra usage is required for long context requests. Downstream session is cooling down.'

test('capToolResults: shrinks older results oldest-first, keeps the current step, reports still-over', () => {
  const big = (id) => ({ role: 'user', toolResult: { toolCallId: id, text: 'first line ' + id + '\n' + 'x'.repeat(40000) } })
  const extra = [{ role: 'assistant', blocks: [] }, big('a'), big('b'), { role: 'assistant', blocks: [] }, big('c')]
  const names = new Map([['a', 'web_fetch'], ['b', 'read_file'], ['c', 'web_fetch']])
  const r = capToolResults(extra, { cap: 15000, names, keepFrom: 4 })
  assert.equal(r.shrunk, 2)
  assert.match(extra[1].toolResult.text, /^\[web_fetch\] first line a\n\(Older tool result shortened/)
  assert.match(extra[2].toolResult.text, /^\[read_file\] first line b/)
  assert.ok(extra[4].toolResult.text.length > 40000, 'current step untouched')
  assert.equal(r.over, false)
  const r2 = capToolResults(extra, { cap: 5000, names, keepFrom: extra.length + 0 - 1 })
  assert.equal(r2.shrunk, 0, 'already shortened results are not shortened again')
  assert.equal(r2.over, true)
  assert.equal(capToolResults([], { cap: 10 }).over, false)
})

test('normalizeUpstreamError: cooldown / quota and misreported long-context map to a Chinese message, original kept', () => {
  const e = Object.assign(new Error(COOLDOWN), { status: 400 })
  const n = normalizeUpstreamError(e, { estimate: 30000 })
  assert.equal(n.message, UPSTREAM_UNAVAILABLE_TEXT)
  assert.equal(n.detail, COOLDOWN)
  assert.equal(n.cause, e); assert.equal(n.status, 400)
  assert.equal(isTransientFailure(n), true)
  assert.equal(normalizeUpstreamError(new Error('Extra usage is required for long context requests.'), { estimate: 50000 }).message, UPSTREAM_UNAVAILABLE_TEXT)
  assert.equal(normalizeUpstreamError(new Error('You exceeded your current quota')).message, UPSTREAM_UNAVAILABLE_TEXT)
  const plain = new Error('invalid api key')
  assert.equal(normalizeUpstreamError(plain), plain)
  // really over the long-context limit: original error, flagged for compress + retry
  const big = new Error('Extra usage is required for long context requests.')
  const k = normalizeUpstreamError(big, { estimate: 210000 })
  assert.equal(k, big); assert.equal(k.longContext, true); assert.equal(k.requestTokens, 210000)
  const f = longContextFailure(k)
  assert.match(f.message, /请求上下文过长（约 210k tokens）/); assert.equal(f.detail, big.message)
})


test('normalizeUpstreamError: gateway bogus Invalid request 400 maps to upstream-unavailable; real Anthropic field errors do not', () => {
  const gw = 'Claude 请求失败：400 {"error":{"type":"<nil>","message":"Invalid request. Please check the format and content of your request. (request_id: 2c8fee47-33cb-4241-b88e-dcb96e89ae8c) (request id: 202610240126388586493148268d9d6eVYU52qU)"},"type":"error"}'
  const e = Object.assign(new Error(gw), { code: 'INVALID_REQUEST', status: 400 })
  assert.equal(isGatewayBogusInvalidRequest(e), true)
  const n = normalizeUpstreamError(e)
  assert.equal(n.message, UPSTREAM_UNAVAILABLE_TEXT)
  assert.equal(n.code, 'UPSTREAM_UNAVAILABLE')
  assert.match(n.detail, /Invalid request\. Please check the format/)
  assert.equal(isTransientFailure(n), true)
  // Anthropic-style field path: keep original (do not wrap / retry as gateway)
  const real = Object.assign(new Error('Claude 请求失败：400 messages.0.content: text content blocks must contain non-whitespace text'), { code: 'INVALID_REQUEST', status: 400 })
  assert.equal(isGatewayBogusInvalidRequest(real), false)
  assert.equal(normalizeUpstreamError(real), real)
})

async function setup({ tool = 'web_fetch', resultText = (n) => 'result #' + n, call, cfgExtra = {}, modExtra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ctxguard-'))
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'cl', name: 'Claude', provider: 'anthropic', model: 'c' }] })
  let executed = 0
  const registry = () => ({
    schemas: () => [{ name: tool, description: 'fetch', parameters: { type: 'object', properties: { n: { type: 'number' } } } }],
    get: () => ({ execute: async () => { executed++; return { content: [{ type: 'text', text: resultText(executed) }] } } }),
  })
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => registry(), getLlm: () => null, getSettings: () => ({ resultTokens: 8000 }), providers: async () => ({ available: true, providers: [] }) })
  const events = []
  const cfg = { seats, userName: 'Shiro', budget: 1, maxTokens: 100, ownerId: '1', defaultMain: 'cl', tools: {}, ...cfgExtra }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg: { typing: () => () => {}, relay: async () => [] }, emit: (_r, ev) => events.push(ev), ...modExtra })
  const room = await store.createRoom({ title: 't' })
  await toolkit.toolsets.add(room.id, [tool], { max: 10, by: 'test' })
  return {
    store, room, events, executed: () => executed,
    async post(text = '查一下') { const out = await moderator.post(room.id, text, { owner: true, source: 'local', userName: 'Shiro' }); await out.promise; await settle(); return store.readMessages(room.id) },
    done: () => rm(dir, { recursive: true, force: true }),
  }
}

test('tool loop: step cap (cfg.tools.maxSteps) makes the member wrap up; no more tools run', async () => {
  const prompts = []
  let i = 0
  const call = async (o) => { i++; prompts.push(o.prompt.messages); return { usage: {}, toolCalls: [tc('c' + i, 'web_fetch', { n: i })], text: i > 4 ? '收尾了' : '' } }
  const f = await setup({ call, cfgExtra: { tools: { maxSteps: 4 } } })
  try {
    const msgs = await f.post()
    assert.equal(f.executed(), 4)
    assert.equal(i, 5, 'one final call after the cap')
    const last = prompts[prompts.length - 1]
    assert.match(String(last[last.length - 1].content), /used 4 tool steps/)
    assert.ok(msgs.some((m) => m.kind === 'system' && /已达 4 步上限/.test(m.text)))
    assert.ok(msgs.some((m) => m.kind === 'seat' && m.text === '收尾了'))
  } finally { await f.done() }
})

test('tool loop: accumulated tool-result cap shortens older results, then asks to wrap up', async () => {
  const prompts = []
  let i = 0
  const call = async (o) => {
    i++
    prompts.push(o.prompt.messages.map((m) => (m.toolResult ? { tr: m.toolResult.text } : { c: String(m.content || '') })))
    if (i <= 6) return { usage: {}, toolCalls: [tc('c' + i, 'web_fetch', { n: i })] }
    return { usage: {}, toolCalls: [], text: '好了' }
  }
  // in-turn previews are ~1600 chars (CJK ≈ 1 token each); cap 2500 → older results shortened from the 2nd result on
  const f = await setup({ call, resultText: (n) => '第' + n + '页\n' + '内'.repeat(4000), cfgExtra: { tools: { turnResultTokens: 2500 } } })
  try {
    await f.post()
    const third = prompts[2]
    const trs = third.filter((m) => m.tr !== undefined)
    assert.equal(trs.length, 2)
    assert.match(trs[0].tr, /Older tool result shortened/)
    assert.ok(trs[1].tr.length > 1000, 'latest result kept in full')
    for (const p of prompts) {
      const sum = p.filter((m) => m.tr !== undefined).reduce((n, m) => n + m.tr.length, 0)
      assert.ok(sum < 4000, 'in-turn tool results stay bounded: ' + sum)
    }
  } finally { await f.done() }
})

test('tool loop: still over the cap after shortening → wrap-up message, no more tools', async () => {
  let i = 0
  const prompts = []
  const call = async (o) => { i++; prompts.push(o.prompt.messages); return i === 1 ? { usage: {}, toolCalls: [tc('c1', 'web_fetch', { n: 1 })] } : { usage: {}, toolCalls: [tc('c' + i, 'web_fetch', { n: i })], text: '先这样' } }
  const f = await setup({ call, resultText: () => '巨'.repeat(9000), cfgExtra: { tools: { turnResultTokens: 1000 } } })
  try {
    const msgs = await f.post()
    assert.equal(f.executed(), 1)
    assert.equal(i, 2)
    const last = prompts[1]
    assert.match(String(last[last.length - 1].content), /reached the context budget/)
    assert.ok(msgs.some((m) => m.kind === 'system' && /工具结果已达上限/.test(m.text)))
  } finally { await f.done() }
})

test('per-request context check: rules + schemas + messages estimated; threshold = min(setting, 75% of window)', async () => {
  const seen = []
  const call = async () => ({ usage: {}, toolCalls: [], text: '嗯' })
  const f = await setup({
    call,
    cfgExtra: { rules: '规'.repeat(80000), contextTokenThreshold: 150000 },
    modExtra: { ensureContext: async (_id, o) => { seen.push(o); return { ok: true, skipped: true } }, contextWindowOf: async () => 100000 },
  })
  try {
    await f.post()
    assert.equal(seen.length, 1)
    assert.equal(seen[0].threshold, 75000)
    assert.ok(seen[0].requestTokens >= 80000, String(seen[0].requestTokens))
  } finally { await f.done() }
})

test('per-request context check: small request does not call the compressor', async () => {
  let n = 0
  const f = await setup({ call: async () => ({ usage: {}, toolCalls: [], text: '嗯' }), modExtra: { ensureContext: async () => { n++; return { ok: true, skipped: true } } } })
  try { await f.post(); assert.equal(n, 0) } finally { await f.done() }
})

test('cooldown relay error: member failure shows the Chinese message, original kept in detail', async () => {
  const call = async () => { throw Object.assign(new Error(COOLDOWN), { status: 400 }) }
  const f = await setup({ call })
  try {
    await f.post()
    const ev = f.events.find((e) => e.type === 'turn-failed')
    assert.ok(ev, 'turn-failed emitted')
    assert.equal(ev.reason, UPSTREAM_UNAVAILABLE_TEXT)
    assert.equal(ev.detail, COOLDOWN)
  } finally { await f.done() }
})

test('long-context error with a really large request: compress once and retry the step', async () => {
  let i = 0
  let compacted = 0
  const call = async () => { i++; if (i === 1) throw new Error('Extra usage is required for long context requests.'); return { usage: {}, toolCalls: [], text: '压缩后回答' } }
  const f = await setup({ call, cfgExtra: { rules: '长'.repeat(200000) }, modExtra: { compactContext: async () => { compacted++; return { ok: true, skipped: false } } } })
  try {
    const msgs = await f.post()
    assert.equal(compacted, 1); assert.equal(i, 2)
    assert.ok(msgs.some((m) => m.kind === 'seat' && m.text === '压缩后回答'))
  } finally { await f.done() }
})

test('long-context error, compress unavailable: clear Chinese reason, no endless retry', async () => {
  let i = 0
  const call = async () => { i++; throw new Error('Extra usage is required for long context requests.') }
  const f = await setup({ call, cfgExtra: { rules: '长'.repeat(200000) }, modExtra: { compactContext: async () => ({ ok: false, skipped: true, reason: 'unconfigured' }) } })
  try {
    await f.post()
    assert.equal(i, 1)
    const ev = f.events.find((e) => e.type === 'turn-failed')
    assert.match(ev.reason, /请求上下文过长/)
    assert.match(ev.detail, /Extra usage is required/)
  } finally { await f.done() }
})

test('settings UI: summarizer is a provider/model picker with 不启用 and an unset status', async () => {
  const src = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /key: "chatroomSummarizerProvider", label: "摘要模型", type: "summaryroute", modelKey: "chatroomSummarizerModel"/)
  assert.match(src, /key: "chatroomSummarizerModel"[^\n]*hidden: true/)
  assert.match(src, /function buildSummaryRouteField\(f\)[\s\S]{0,800}label: "不启用"/)
  assert.match(src, /buildSummaryRouteField[\s\S]{0,4000}modelRouteOptions\(cat, null\)/)
  assert.ok((src.match(/自动压缩未启用：请选择摘要模型/g) || []).length >= 3)
})
