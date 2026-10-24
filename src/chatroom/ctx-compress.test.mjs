/**
 * Rolling context summary (滚动摘要): threshold estimate, hide-from-ai, prompt shape,
 * skip when summarizer unset, no double compress.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { buildPrompt } from './transcript.mjs'
import {
  estimateTokens,
  estimateHistoryTokens,
  planCompress,
  summarizerConfigured,
  createCompressor,
  DEFAULT_HISTORY_WINDOW,
  DEFAULT_TOKEN_THRESHOLD,
  isPromptCandidate,
  estimateRequestTokens,
  effectiveThreshold,
  IMAGE_TOKENS,
  streamSummary,
  SUMMARY_MAX_TOKENS,
  SUMMARY_EMPTY_ERROR,
} from './ctx-compress.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-ctx-'))
const seat = { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm', enabled: true }
const seats = [seat]

function msg(seq, kind, text, extra = {}) {
  return {
    id: 'msg-' + seq,
    seq,
    ts: new Date().toISOString(),
    kind,
    status: 'ok',
    speaker: kind === 'user' ? { id: 'user', name: 'Shiro' } : { id: 'ds', name: 'DeepSeek' },
    text,
    ...extra,
  }
}

function fillMessages(n, charsEach = 40) {
  const out = []
  for (let i = 1; i <= n; i++) {
    const kind = i % 2 === 1 ? 'user' : 'seat'
    out.push(msg(i, kind, ('话' + i + '-').padEnd(charsEach, 'x')))
  }
  return out
}

test('estimateTokens: CJK ~1 token per char, other text chars/4', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('你好abcd'), 3)
  assert.equal(estimateTokens('，。！'), 3)
})

test('estimateRequestTokens: system + messages (incl. tool results / tool-call args) + images + tool schemas', () => {
  const base = estimateRequestTokens({ system: 'a'.repeat(400) })
  assert.equal(base, 100)
  const withMsgs = estimateRequestTokens({
    system: 'a'.repeat(400),
    messages: [
      { role: 'user', content: '中'.repeat(100) },
      { role: 'assistant', blocks: [{ type: 'tool-call', id: 'x', name: 'web', arguments: 'b'.repeat(40) }] },
      { role: 'user', toolResult: { toolCallId: 'x', text: 'c'.repeat(400), images: [{ id: 'i1', data: 'Z'.repeat(100000) }] } },
    ],
  })
  // 100 + 100 CJK + ~10 args + 100 result + one fixed image; base64 data is not counted as text
  assert.ok(withMsgs >= 100 + 100 + 10 + 100 + IMAGE_TOKENS, String(withMsgs))
  assert.ok(withMsgs < 100 + 100 + 10 + 100 + IMAGE_TOKENS + 100, String(withMsgs))
  const tools = [{ name: 't', description: 'd'.repeat(4000), parameters: { type: 'object' } }]
  assert.ok(estimateRequestTokens({ tools }) >= 1000)
})

test('estimateRequestTokens counts what buildPrompt sends: non-card tool JSON, persona, rules, summary', () => {
  const big = { a: 'x'.repeat(40000) }
  const messages = [msg(1, 'user', 'hi'), msg(2, 'tool', 'ran', { tool: 'web', data: big })]
  const p = buildPrompt({ seat: { ...seat, presetPersona: 'P'.repeat(800) }, seats, userName: 'Shiro', rules: 'R'.repeat(800), messages, contextSummary: '摘'.repeat(500) })
  const n = estimateRequestTokens(p)
  // tool JSON is capped at 12,000 chars in the prompt (~3000 tokens) + persona/rules (~400) + summary (500)
  assert.ok(n > 3000 + 400 + 500, String(n))
  assert.ok(n < 12000, String(n))
  // history estimate now also counts non-card tool JSON (was title-only)
  assert.ok(estimateHistoryTokens(messages, { userName: 'Shiro' }) > 2900)
})

test('effectiveThreshold: min(setting or 150k default, 75% of known context window)', () => {
  assert.equal(DEFAULT_TOKEN_THRESHOLD, 150000)
  assert.equal(effectiveThreshold(undefined, 0), 150000)
  assert.equal(effectiveThreshold(150000, 128000), 96000)
  assert.equal(effectiveThreshold(150000, 1000000), 150000)
  assert.equal(effectiveThreshold(50000, 1000000), 50000)
})

test('compress uses the caller request estimate (requestTokens) against the given threshold', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'req' })
    for (const m of fillMessages(12, 20)) await store.append(room.id, m)
    let calls = 0
    const llm = { stream: async function* () { calls++; yield { type: 'text-delta', text: '摘要' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const compressor = createCompressor({ store, getLlm: () => llm, getSettings: () => ({ provider: 'p', model: 'm', window: 4, threshold: 150000, userName: 'Shiro' }) })
    const under = await compressor.maybeAutoCompress(room.id, {})
    assert.equal(under.reason, 'under-threshold')
    const over = await compressor.maybeAutoCompress(room.id, { requestTokens: 120000, threshold: 96000 })
    assert.equal(over.ok, true); assert.equal(over.skipped, false); assert.equal(calls, 1)
    assert.equal(over.tokens, 120000); assert.equal(over.threshold, 96000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('estimateTokens: chars/4', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
})

test('threshold trigger estimate: history tokens reach default 200k', () => {
  // ~200k tokens ≈ 800k chars (estimate uses full text, not summarizer 800-char lines)
  const big = fillMessages(20, 40000) // 20 * 40k = 800k chars → ~200k tokens
  const tokens = estimateHistoryTokens(big, { userName: 'Shiro' })
  assert.ok(tokens >= DEFAULT_TOKEN_THRESHOLD, 'expected >= ' + DEFAULT_TOKEN_THRESHOLD + ', got ' + tokens)
  const small = fillMessages(10, 100)
  assert.ok(estimateHistoryTokens(small, { userName: 'Shiro' }) < DEFAULT_TOKEN_THRESHOLD)
})

test('planCompress: keeps recent window, folds the rest', () => {
  const messages = fillMessages(40, 20)
  const plan = planCompress(messages, { window: 24, untilSeq: 0 })
  assert.equal(plan.empty, false)
  assert.equal(plan.keep.length, 24)
  assert.equal(plan.falling.length, 16)
  assert.equal(plan.untilSeq, 16)
  assert.ok(plan.keep.every((m) => m.seq > 16))
})

test('hide-from-ai after compress: contextHidden / untilSeq skipped in buildPrompt', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'ctx' })
    const messages = fillMessages(30, 30)
    for (const m of messages) {
      await store.append(room.id, {
        kind: m.kind,
        speaker: m.speaker,
        text: m.text,
        status: 'ok',
      })
    }
    let all = await store.readMessages(room.id)
    const plan = planCompress(all, { window: 8, untilSeq: 0 })
    await store.patchMeta(room.id, (meta) => {
      meta.contextSummary = { text: '先前讨论了窗口与压缩。', untilSeq: plan.untilSeq, at: new Date().toISOString() }
    })
    await store.markContextHidden(room.id, plan.untilSeq)
    all = await store.readMessages(room.id)
    const hidden = all.filter((m) => m.contextHidden)
    assert.ok(hidden.length >= plan.falling.length)
    assert.ok(hidden.every((m) => m.seq <= plan.untilSeq))

    const meta = await store.getRoom(room.id)
    const p = buildPrompt({
      seat,
      seats,
      userName: 'Shiro',
      messages: all,
      maxHistory: 8,
      contextSummary: meta.contextSummary.text,
      contextUntilSeq: meta.contextSummary.untilSeq,
    })
    const blob = p.messages.map((m) => m.content).join('\n')
    assert.match(blob, /earlier conversation summary/)
    assert.match(blob, /先前讨论了窗口与压缩/)
    // Folded early text should not appear as raw lines beyond the window.
    for (const m of plan.falling) {
      assert.equal(isPromptCandidate(m, plan.untilSeq), false)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prompt shape: one summary + recent window only', () => {
  const messages = fillMessages(40, 20)
  const until = 16
  const marked = messages.map((m) => (m.seq <= until ? { ...m, contextHidden: true } : m))
  const p = buildPrompt({
    seat,
    seats,
    userName: 'Shiro',
    messages: marked,
    maxHistory: 24,
    contextSummary: '总摘要：大家约好了压缩策略。',
    contextUntilSeq: until,
  })
  const joined = p.messages.map((m) => m.content).join('\n\n---\n\n')
  const summaryHits = (joined.match(/earlier conversation summary/g) || []).length
  assert.equal(summaryHits, 1)
  assert.match(joined, /总摘要：大家约好了压缩策略/)
  // Visible recent messages use seq > 16; at most 24 of them (+ synthetic start if needed)
  const visible = marked.filter((m) => isPromptCandidate(m, until))
  assert.ok(visible.length <= 24)
  assert.ok(visible.every((m) => m.seq > until))
})

test('skip when summarizer unset: auto and manual', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'unset' })
    for (const m of fillMessages(30, 50)) {
      await store.append(room.id, { kind: m.kind, speaker: m.speaker, text: m.text })
    }
    assert.equal(summarizerConfigured({}), false)
    assert.equal(summarizerConfigured({ provider: 'deepseek', model: '' }), false)
    const compressor = createCompressor({
      store,
      getLlm: () => null,
      getSettings: () => ({ provider: '', model: '', window: 8, threshold: 100, userName: 'Shiro' }),
    })
    const auto = await compressor.maybeAutoCompress(room.id)
    assert.equal(auto.skipped, true)
    assert.equal(auto.reason, 'unconfigured')
    const manual = await compressor.compress(room.id, { force: true })
    assert.equal(manual.ok, false)
    assert.equal(manual.reason, 'unconfigured')
    assert.match(manual.notice, /自动压缩未启用：请选择摘要模型/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no double compress: concurrent lock', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'lock' })
    for (const m of fillMessages(30, 80)) {
      await store.append(room.id, { kind: m.kind, speaker: m.speaker, text: m.text })
    }
    let resolveStream
    const gate = new Promise((r) => { resolveStream = r })
    const llm = {
      stream: async function* () {
        await gate
        yield { type: 'text-delta', text: '合并后的滚动摘要。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const compressor = createCompressor({
      store,
      getLlm: () => llm,
      getSettings: () => ({ provider: 'deepseek', model: 'flash', window: 8, threshold: 10, userName: 'Shiro' }),
    })
    const first = compressor.compress(room.id, { force: true })
    // Let first acquire the lock
    await new Promise((r) => setTimeout(r, 20))
    const second = await compressor.compress(room.id, { force: true })
    assert.equal(second.skipped, true)
    assert.equal(second.reason, 'busy')
    resolveStream()
    const done = await first
    assert.equal(done.ok, true)
    assert.equal(done.skipped, false)
    const meta = await store.getRoom(room.id)
    assert.match(String(meta.contextSummary?.text || ''), /滚动摘要/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DEFAULT_HISTORY_WINDOW is ~24', () => {
  assert.equal(DEFAULT_HISTORY_WINDOW, 24)
})

test('streamSummary: maxTokens sent = text cap + reasoning allowance; text capped locally', async () => {
  let req
  const llm = {
    stream: async function* (r) {
      req = r
      yield { type: 'reasoning-delta', text: '思考'.repeat(5000) }
      for (let i = 0; i < 5000; i++) {
        if (r.signal?.aborted) return
        yield { type: 'text-delta', text: '摘' }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const out = await streamSummary(llm, { provider: 'p', model: 'm', system: 's', user: 'u' })
  assert.ok(req.maxTokens > SUMMARY_MAX_TOKENS + 1000, 'reasoning allowance added')
  assert.equal(out.length, SUMMARY_MAX_TOKENS)
})

test('streamSummary: reasoning only, no text -> clear error', async () => {
  const llm = { stream: async function* () { yield { type: 'reasoning-delta', text: '想了很久' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  await assert.rejects(streamSummary(llm, { provider: 'p', model: 'm', system: 's', user: 'u' }), (e) => e.message.startsWith(SUMMARY_EMPTY_ERROR) && /推理/.test(e.message))
})

test('compress failure returns error field (no reasoning-only empty fallback)', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'empty' })
    for (const m of fillMessages(30, 40)) await store.append(room.id, { kind: m.kind, speaker: m.speaker, text: m.text })
    const llm = { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } }
    const c = createCompressor({ store, getLlm: () => llm, getSettings: () => ({ provider: 'p', model: 'm', window: 8, threshold: 10, userName: 'Shiro' }) })
    const out = await c.compress(room.id, { force: true })
    assert.equal(out.ok, false)
    assert.ok(String(out.error || '').startsWith(SUMMARY_EMPTY_ERROR))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ctx-compress notices stay out of AI prompts', () => {
  const messages = fillMessages(6, 20)
  messages.push(msg(7, 'system', '上下文压缩失败，已保留原窗口。', { speaker: { id: 'system', name: '聊天室' }, notice: 'ctx-compress' }))
  assert.equal(isPromptCandidate(messages[6], 0), false)
  const p = buildPrompt({ seat, seats, userName: 'Shiro', messages, maxHistory: 24 })
  assert.doesNotMatch(p.messages.map((m) => m.content).join('\n'), /上下文压缩失败/)
})
test('compress streams summarizer reasoning/text as ephemeral events; nothing extra persisted', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'live' })
    for (const m of fillMessages(30, 40)) await store.append(room.id, { kind: m.kind, speaker: m.speaker, text: m.text })
    const before = (await store.readMessages(room.id)).length
    const events = []
    const llm = { stream: async function* () {
      yield { type: 'reasoning-delta', text: '先梳理要点' }
      yield { type: 'text-delta', text: '滚动' }
      yield { type: 'text-delta', text: '摘要正文' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const c = createCompressor({ store, getLlm: () => llm, emit: (rid, ev) => events.push(ev), getSettings: () => ({ provider: 'p', model: 'm', window: 8, threshold: 10, userName: 'Shiro' }) })
    const out = await c.compress(room.id, { force: true, quiet: true })
    assert.equal(out.ok, true)
    const types = events.map((e) => e.type)
    assert.deepEqual(types, ['compress-start', 'compress-thinking', 'compress-delta', 'compress-delta', 'compress-end', 'context-summary'])
    const id = events[0].id
    assert.ok(id && events.slice(0, 5).every((e) => e.id === id))
    assert.equal(events[4].ok, true)
    assert.equal(events[5].summary.untilSeq, out.summary.untilSeq)
    const after = await store.readMessages(room.id)
    assert.equal(after.length, before, 'no live/streamed message persisted (quiet: no notice either)')
    assert.ok(!JSON.stringify(after).includes('先梳理要点'))
    const meta = await store.getRoom(room.id)
    assert.ok(!JSON.stringify(meta).includes('先梳理要点'), 'reasoning not stored in room meta')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compress failure ends the live view with the error', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'livefail' })
    for (const m of fillMessages(30, 40)) await store.append(room.id, { kind: m.kind, speaker: m.speaker, text: m.text })
    const events = []
    const llm = { stream: async function* () { yield { type: 'reasoning-delta', text: '想' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    const c = createCompressor({ store, getLlm: () => llm, emit: (rid, ev) => events.push(ev), getSettings: () => ({ provider: 'p', model: 'm', window: 8, threshold: 10, userName: 'Shiro' }) })
    await c.compress(room.id, { force: true, quiet: true })
    const end = events.find((e) => e.type === 'compress-end')
    assert.equal(end.ok, false)
    assert.ok(end.error.startsWith(SUMMARY_EMPTY_ERROR))
    assert.ok(!events.some((e) => e.type === 'context-summary'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
