import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolveCompanionInstruction,
  isCompanionCompactionEnabled,
  rewriteCompactionMessages,
  applyCompanionCompactionOptions,
  looksLikeOfficialCompactionInstruction,
  createCompanionCompactionFeature,
  companionStatusBadge,
  setCompanionCompactionDebugSink,
} from './companion-compaction.mjs'
import { COMPANION_COMPACTION_INSTRUCTION } from './companion-instruction.mjs'

const OFFICIAL = 'AI coding assistant\n## Primary Request and Intent'

function officialMessages(prefix) {
  const messages = []
  if (prefix) messages.push(prefix)
  messages.push({ role: 'user', content: [{ type: 'text', text: OFFICIAL }] })
  return messages
}

function lastText(messages) {
  const user = [...(messages || [])].reverse().find((m) => m?.role === 'user')
  const block = user?.content?.[0]
  return typeof block?.text === 'string' ? block.text : ''
}

function fakeLlm() {
  const calls = []
  const llm = {
    async stream(options) {
      calls.push(options)
      return { done: true }
    },
  }
  return { llm, calls, original: llm.stream }
}

function fakeEngine(llm, summarize) {
  const engine = {
    ctx: { llm },
    async summarize() {
      return this.ctx.llm.stream({ purpose: 'compaction', messages: officialMessages() })
    },
  }
  if (summarize) engine.summarize = summarize
  return { engine, originalSummarize: engine.summarize }
}

function host({ llm, engine, late = false } = {}) {
  const services = {}
  if (llm) services.llm = llm
  if (engine) services.compaction = engine
  const pending = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return services[name] ?? null },
    inject(_names, cb) {
      const fork = { disposed: false, dispose() { fork.disposed = true } }
      if (late) pending.push(cb)
      else cb(ctx)
      return fork
    },
  }
  return { ctx, services, pending }
}

async function withLogs(run) {
  const lines = []
  setCompanionCompactionDebugSink((line) => lines.push(line))
  try {
    return await run(lines)
  } finally {
    setCompanionCompactionDebugSink(null)
  }
}

test('resolveCompanionInstruction uses built-in when empty', () => {
  assert.equal(resolveCompanionInstruction({}), COMPANION_COMPACTION_INSTRUCTION)
  assert.equal(resolveCompanionInstruction({ companionCompactionInstruction: '  ' }), COMPANION_COMPACTION_INSTRUCTION)
})

test('custom instruction from getter wins when non-empty', () => {
  assert.equal(resolveCompanionInstruction({ companionCompactionInstruction: 'CUSTOM' }), 'CUSTOM')
})

test('isCompanionCompactionEnabled defaults on', () => {
  assert.equal(isCompanionCompactionEnabled({}), true)
  assert.equal(isCompanionCompactionEnabled({ companionCompactionEnabled: true }), true)
  assert.equal(isCompanionCompactionEnabled({ companionCompactionEnabled: false }), false)
})

test('rewriteCompactionMessages replaces last user only', () => {
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'old' }] },
  ]
  const next = rewriteCompactionMessages(msgs, 'NEW')
  assert.equal(msgs[1].content[0].text, 'old')
  assert.equal(next[1].content[0].text, 'NEW')
  assert.equal(next[0].role, 'system')
})

test('looksLikeOfficialCompactionInstruction', () => {
  assert.equal(looksLikeOfficialCompactionInstruction('AI coding assistant'), true)
  assert.equal(looksLikeOfficialCompactionInstruction('## Primary Request and Intent'), true)
  assert.equal(looksLikeOfficialCompactionInstruction('hello'), false)
})

test('applyCompanionCompactionOptions only for compaction purpose', () => {
  const opts = {
    purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'AI coding assistant ## Primary Request and Intent' }] }],
  }
  const next = applyCompanionCompactionOptions(opts, 'COMPANION')
  assert.notEqual(next, opts)
  assert.equal(next.messages[0].content[0].text, 'COMPANION')
})

test('applyCompanionCompactionOptions still replaces when last user lacks official markers', () => {
  const opts = {
    purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'random' }] }],
  }
  const next = applyCompanionCompactionOptions(opts, 'COMPANION')
  assert.equal(next.messages[0].content[0].text, 'COMPANION')
})

test('applyCompanionCompactionOptions skips non-compaction without markers', () => {
  const opts = {
    purpose: 'chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  assert.equal(applyCompanionCompactionOptions(opts, 'X'), opts)
})

test('applyCompanionCompactionOptions replaces on official markers without purpose', () => {
  const opts = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'You are now acting as a compaction engine for this AI coding assistant.' }] }],
  }
  const next = applyCompanionCompactionOptions(opts, 'COMPANION')
  assert.equal(next.messages[0].content[0].text, 'COMPANION')
})

test('badge names phase and instruction source, not the instruction body', () => {
  assert.equal(companionStatusBadge({ phase: 'idle', detail: '未安装' }, {}).text, '未安装')
  assert.equal(companionStatusBadge({ phase: 'pending', detail: '等待 compaction/llm 就绪' }, {}).text, '等待压缩引擎')
  assert.equal(companionStatusBadge({ phase: 'installed', instructionSource: 'default', detail: '已安装 · 内置指令' }, {}).text, '已安装 · 内置指令')
  assert.equal(companionStatusBadge({ phase: 'hit', instructionSource: 'custom', detail: '已命中 · 自定义指令' }, {}).text, '已命中 · 自定义指令')
  assert.equal(companionStatusBadge({ phase: 'miss', detail: '已安装但未命中' }, {}).cls, 'error')
  assert.equal(companionStatusBadge({ phase: 'hit', instructionSource: 'custom' }, { companionCompactionEnabled: false }).text, '未启用')
  assert.equal(JSON.stringify(companionStatusBadge({ phase: 'hit', instructionSource: 'custom', detail: '已命中 · 自定义指令' }, {})).includes('关系'), false)
})

test('cold start installs companion compaction and, separately, pre-compaction history', () => {
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const start = src.indexOf('// ── 工作组件：各自 fork')
  const end = src.indexOf('await telegram.sync()', start)
  const slice = src.slice(start, end)
  assert.match(slice, /void companionCompaction\.sync\(\)/)
  assert.match(slice, /void preCompactionHistory\.sync\(\)/)
  assert.equal(slice.includes('await telegram.sync()'), false)
})

test('empty and whitespace instructions mount the built-in text; custom replaces it; off leaves the official text', async () => {
  await withLogs(async () => {
    for (const instruction of ['', ' \n\t ']) {
      const { llm, calls } = fakeLlm()
      const { engine } = fakeEngine(llm)
      const cfg = { companionCompactionInstruction: instruction }
      const feature = createCompanionCompactionFeature(host({ llm, engine }).ctx, () => cfg)
      await feature.sync()
      await llm.stream({ purpose: 'compaction', messages: officialMessages() })
      assert.equal(lastText(calls[0].messages), resolveCompanionInstruction(cfg))
      assert.notEqual(lastText(calls[0].messages), OFFICIAL)
      assert.equal(feature.state().instructionSource, 'default')
      assert.equal(feature.state().phase, 'hit')
      await feature.dispose()
    }
    const custom = { companionCompactionInstruction: 'CUSTOM-SECRET' }
    const { llm, calls } = fakeLlm()
    const { engine } = fakeEngine(llm)
    const feature = createCompanionCompactionFeature(host({ llm, engine }).ctx, () => custom)
    await feature.sync()
    await llm.stream({ purpose: 'compaction', messages: officialMessages() })
    assert.equal(lastText(calls[0].messages), 'CUSTOM-SECRET')
    assert.equal(feature.state().instructionSource, 'custom')
    await feature.dispose()

    const off = { companionCompactionEnabled: false, companionCompactionInstruction: '' }
    const offLlm = fakeLlm()
    const offEngine = fakeEngine(offLlm.llm)
    const offFeature = createCompanionCompactionFeature(host({ llm: offLlm.llm, engine: offEngine.engine }).ctx, () => off)
    await offFeature.sync()
    await offLlm.llm.stream({ purpose: 'compaction', messages: officialMessages() })
    assert.equal(lastText(offLlm.calls[0].messages), OFFICIAL)
    assert.equal(offFeature.state().phase, 'off')
    assert.equal(offFeature.state().mounted, false)
    await offFeature.dispose()
  })
})

test('repeated sync does not stack wrappers, and disable or dispose restores the original functions', async () => {
  await withLogs(async () => {
    const { llm, calls, original } = fakeLlm()
    const { engine, originalSummarize } = fakeEngine(llm)
    const box = { cfg: {} }
    const feature = createCompanionCompactionFeature(host({ llm, engine }).ctx, () => box.cfg)
    await feature.sync()
    const wrapped = llm.stream
    const wrappedSummarize = engine.summarize
    await feature.sync()
    assert.equal(llm.stream, wrapped)
    assert.equal(engine.summarize, wrappedSummarize)
    await llm.stream({ purpose: 'compaction', messages: officialMessages() })
    assert.equal(calls.length, 1)
    assert.equal(lastText(calls[0].messages), resolveCompanionInstruction(box.cfg))

    box.cfg = { companionCompactionEnabled: false }
    await feature.sync()
    assert.equal(llm.stream, original)
    assert.equal(engine.summarize, originalSummarize)
    assert.equal(feature.state().phase, 'off')

    box.cfg = {}
    await feature.sync()
    assert.equal(llm.stream.__dshCompanionCompaction, true)
    await llm.stream({ purpose: 'compaction', messages: officialMessages() })
    assert.equal(calls.length, 2)
    await feature.dispose()
    assert.equal(llm.stream, original)
    assert.equal(engine.summarize, originalSummarize)
    assert.equal(feature.state().phase, 'idle')
    assert.equal(feature.state().detail, '已卸载')
  })
})

test('late compaction and llm services install once, then a compaction call hits', async () => {
  await withLogs(async () => {
    const { llm, calls } = fakeLlm()
    const { engine } = fakeEngine(llm)
    const h = host({ late: true })
    const feature = createCompanionCompactionFeature(h.ctx, () => ({}))
    assert.equal(feature.state().phase, 'idle')
    assert.equal(feature.state().detail, '未安装')
    await feature.sync()
    assert.equal(feature.state().phase, 'pending')
    assert.equal(feature.state().mounted, false)
    h.services.llm = llm
    h.services.compaction = engine
    assert.equal(h.pending.length, 1)
    h.pending[0](h.ctx)
    assert.equal(feature.state().mounted, true)
    assert.equal(feature.state().phase, 'installed')
    assert.equal(llm.stream.__dshCompanionCompaction, true)
    await llm.stream({ purpose: 'compaction', messages: officialMessages() })
    assert.equal(calls.length, 1)
    assert.equal(feature.state().phase, 'hit')
    assert.equal(feature.state().hits, 1)
    assert.equal(feature.state().instructionSource, 'default')
    await feature.dispose()
  })
})

test('summarize through this.ctx.llm.stream rewrites once; a closed-over stream is a miss', async () => {
  await withLogs(async () => {
    const { llm, calls } = fakeLlm()
    const { engine } = fakeEngine(llm)
    const feature = createCompanionCompactionFeature(host({ llm, engine }).ctx, () => ({}))
    await feature.sync()
    const wrapped = llm.stream
    await engine.summarize()
    assert.equal(calls.length, 1)
    assert.equal(lastText(calls[0].messages), resolveCompanionInstruction({}))
    assert.equal(feature.state().phase, 'hit')
    assert.equal(feature.state().hits, 1)
    assert.equal(llm.stream, wrapped)
    await feature.dispose()

    const visible = fakeLlm()
    const closed = fakeLlm()
    const closedStream = closed.llm.stream.bind(closed.llm)
    const missed = fakeEngine(visible.llm, async function () {
      return closedStream({ purpose: 'compaction', messages: officialMessages() })
    })
    const missFeature = createCompanionCompactionFeature(host({ llm: visible.llm, engine: missed.engine }).ctx, () => ({}))
    await missFeature.sync()
    await missed.engine.summarize()
    assert.equal(visible.calls.length, 0)
    assert.equal(lastText(closed.calls[0].messages), OFFICIAL)
    assert.equal(missFeature.state().phase, 'miss')
    assert.equal(missFeature.state().mounted, true)
    assert.equal(missFeature.state().misses, 1)
    await missFeature.dispose()
  })
})

test('ordinary chat stays unchanged, marker text without purpose is rewritten, and a memory corpus is kept', async () => {
  await withLogs(async () => {
    const { llm, calls } = fakeLlm()
    const { engine } = fakeEngine(llm)
    const feature = createCompanionCompactionFeature(host({ llm, engine }).ctx, () => ({}))
    await feature.sync()
    const chat = { purpose: 'chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
    await llm.stream(chat)
    assert.equal(calls[0], chat)
    assert.equal(feature.state().phase, 'installed')
    assert.equal(feature.state().hits, 0)

    await llm.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'AI coding assistant' }] }] })
    assert.equal(lastText(calls[1].messages), resolveCompanionInstruction({}))
    assert.equal(feature.state().phase, 'hit')

    const corpus = { role: 'user', content: [{ type: 'text', text: 'CORPUS-KEEP' }] }
    await llm.stream({ purpose: 'compaction', messages: officialMessages(corpus) })
    assert.equal(calls[2].messages[0].content[0].text, 'CORPUS-KEEP')
    assert.equal(lastText(calls[2].messages), resolveCompanionInstruction({}))
    assert.equal(corpus.content[0].text, 'CORPUS-KEEP')
    await feature.dispose()
  })
})

test('debug lines record phase and source category without instruction or transcript text', async () => {
  await withLogs(async (lines) => {
    const { llm } = fakeLlm()
    const { engine } = fakeEngine(llm)
    const cfg = { companionCompactionInstruction: 'CUSTOM-SECRET' }
    const feature = createCompanionCompactionFeature(host({ llm, engine }).ctx, () => cfg)
    await feature.sync()
    await llm.stream({ purpose: 'compaction', messages: officialMessages() })
    const text = lines.join('\n')
    assert.match(text, /phase=hit/)
    assert.match(text, /source=custom/)
    assert.equal(text.includes('CUSTOM-SECRET'), false)
    assert.equal(text.includes(OFFICIAL), false)
    assert.equal(text.includes('关系与人物'), false)
    await feature.dispose()
  })
})
