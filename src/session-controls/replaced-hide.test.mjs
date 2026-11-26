// 会话控制的替换隐藏计划：压缩检查点只改变模型上下文，页面仍显示原文。
// 纯函数从 lib/client.js 的 <sc-replaced-helpers> 截取执行，夹具是脱敏构造，不含真实会话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '..', '..')
const RETRACT = '已撤回此回合及之后的内容。'
const REGENERATE = '已丢弃此前的回答，准备重新生成。'
const SECRET = 'secret-body-TOKEN'
const IMAGE = 'asset://local/pic-token'

function helpers() {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const a = src.indexOf('// <sc-replaced-helpers>')
  const b = src.indexOf('// </sc-replaced-helpers>')
  assert.ok(a >= 0 && b > a, 'lib/client.js lacks the <sc-replaced-helpers> block')
  const ctx = {}
  vm.runInNewContext(src.slice(a, b) + `
this.api = {
  scPlanFromEvents, scPlanForSession, scNodeHidden, scSeqHidden,
  scGroupShouldHide, scKeyHidden, SC_COMPACT_KIND
};`, ctx)
  return ctx.api
}

function user(seq, text, surfaceOp = 'append', extra = {}) {
  return {
    type: 'user/message',
    seq,
    surfaceOp,
    data: {
      role: 'user',
      id: 'u' + seq,
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      ...extra,
    },
  }
}

function assistant(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    surfaceOp: 'append',
    data: {
      message: {
        id: 'a' + seq,
        role: 'assistant',
        content: [{ type: 'text', text: text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  }
}

function imageUser(seq, text) {
  return {
    type: 'user/message',
    seq,
    surfaceOp: 'append',
    data: {
      role: 'user',
      id: 'img' + seq,
      content: [
        { type: 'image', url: IMAGE + '-' + seq },
        { type: 'text', text },
      ],
      source: { kind: 'user' },
    },
  }
}

function checkpoint(seq, startSeq, endSeq, text = 'summary') {
  return {
    type: 'user/message',
    seq,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    data: {
      role: 'user',
      id: 'cp' + seq,
      source: { kind: 'compact-checkpoint', compactionId: 'c' + seq },
      content: [{ type: 'text', text }],
    },
  }
}

function carrier(seq, text, startSeq, endSeq, source) {
  return {
    type: 'user/message',
    seq,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    data: {
      role: 'user',
      id: 'c' + seq,
      content: [{ type: 'text', text }],
      ...(source ? { source } : {}),
    },
  }
}

function hiddenSeqs(api, plan, from, to) {
  const out = []
  for (let seq = from; seq <= to; seq++) if (api.scSeqHidden(seq, plan)) out.push(seq)
  return out
}

function node(seq, kind, extra = {}) {
  return { key: 'k' + seq, kind, anchorSeq: seq, ...extra }
}

test('compact checkpoint leaves originals and the kept tail visible', () => {
  const api = helpers()
  const events = [
    user(1, SECRET),
    assistant(2, 'reply'),
    imageUser(3, 'caption'),
    user(4, 'recent'),
    assistant(5, 'recent-reply'),
    checkpoint(8, 1, 3, 'summary-TOKEN'),
    user(9, 'after'),
  ]
  const plan = api.scPlanFromEvents(events)
  assert.deepEqual(hiddenSeqs(api, plan, 1, 9), [])
  assert.equal(api.scNodeHidden(node(1, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(3, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(4, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(8, 'user', { data: { source: { kind: 'compact-checkpoint' } } }), plan), false)
  const dumped = JSON.stringify(plan.diagnostics)
  assert.equal(dumped.includes(SECRET), false)
  assert.equal(dumped.includes(IMAGE), false)
  assert.equal(dumped.includes('summary-TOKEN'), false)
  assert.equal(dumped.includes('caption'), false)
  assert.match(dumped, /compact-checkpoint/)
  assert.match(dumped, /"decision":"show"/)
})

test('50 rounds and 100 messages stay visible after one compact, including 17 image placeholders', () => {
  const api = helpers()
  const events = []
  const imageSeqs = []
  for (let seq = 1; seq <= 100; seq++) {
    if (seq % 2) {
      if (imageSeqs.length < 17) {
        events.push(imageUser(seq, 'round'))
        imageSeqs.push(seq)
      } else {
        events.push(user(seq, 'round'))
      }
    } else {
      events.push(assistant(seq, 'reply'))
    }
  }
  assert.equal(imageSeqs.length, 17)
  events.push(checkpoint(101, 1, 80))
  const plan = api.scPlanFromEvents(events)
  assert.deepEqual(hiddenSeqs(api, plan, 1, 101), [])
  for (const seq of imageSeqs) assert.equal(api.scNodeHidden(node(seq, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(81, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(101, 'user'), plan), false)
  const again = api.scPlanFromEvents(events)
  assert.deepEqual(hiddenSeqs(api, again, 1, 101), [])
})

test('a later compact does not hide, and a following retract hides only its closed interval', () => {
  const api = helpers()
  const events = []
  for (let seq = 1; seq <= 10; seq++) events.push(seq % 2 ? user(seq, 'm') : assistant(seq, 'm'))
  events.push(checkpoint(11, 1, 6))
  events.push(user(12, 'tail'))
  events.push(assistant(13, 'tail-reply'))
  events.push(checkpoint(14, 7, 13))
  events.push({ seq: 15, type: 'turn/end', data: { turn: 8 } })
  events.push(carrier(16, RETRACT, 12, 13))
  const plan = api.scPlanFromEvents(events)
  assert.deepEqual(hiddenSeqs(api, plan, 1, 16), [12, 13])
  assert.equal(api.scSeqHidden(15, plan), false)
  assert.equal(api.scNodeHidden(node(16, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(6, 'assistant'), plan), false)
})

test('retract and regenerate stop at endSeq; regenerate still hides output before startSeq', () => {
  const api = helpers()
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    user(1, 'question'),
    { seq: 2, type: 'tool/call', data: { callId: 'call-1', name: 'demo' } },
    assistant(3, 'old'),
    { seq: 4, type: 'turn/end', data: { turn: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    user(6, 'later'),
    assistant(7, 'later-answer'),
    { seq: 8, type: 'turn/end', data: { turn: 2 } },
    carrier(9, REGENERATE, 3, 7),
  ]
  const plan = api.scPlanFromEvents(events)
  assert.deepEqual(hiddenSeqs(api, plan, 0, 9), [2, 3, 4, 5, 6, 7])
  assert.equal(api.scNodeHidden(node(1, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(7, 'assistant'), plan), true)
  assert.equal(api.scNodeHidden(node(8, 'turn'), plan), false)
  assert.equal(api.scNodeHidden(node(9, 'user'), plan), false)

  const retract = api.scPlanFromEvents([
    user(2, 'question'),
    assistant(3, 'old'),
    { seq: 4, type: 'turn/end', data: {} },
    carrier(5, RETRACT, 2, 3),
  ])
  assert.deepEqual(hiddenSeqs(api, retract, 1, 5), [2, 3])
  assert.equal(api.scNodeHidden(node(3, 'assistant'), retract), true)
})

test('missing or unrecognized replace sources stay inside the closed interval', () => {
  const api = helpers()
  const missing = api.scPlanFromEvents([
    user(1, SECRET),
    assistant(2, 'a'),
    assistant(3, 'b'),
    user(4, 'kept'),
    carrier(10, 'something else', 2, 3),
  ])
  assert.deepEqual(hiddenSeqs(api, missing, 1, 10), [2, 3])
  assert.match(JSON.stringify(missing.diagnostics), /missing-source/)
  assert.equal(JSON.stringify(missing.diagnostics).includes(SECRET), false)

  const unknown = api.scPlanFromEvents([
    carrier(20, 'other', 4, 6, { kind: 'model', provider: 'p', model: 'm' }),
  ])
  assert.deepEqual(hiddenSeqs(api, unknown, 1, 20), [4, 5, 6])
  assert.match(JSON.stringify(unknown.diagnostics), /unrecognized-source/)

  const broken = api.scPlanFromEvents([
    {
      type: 'user/message',
      seq: 3,
      surfaceOp: { op: 'replace', startSeq: 1 },
      data: { content: [{ type: 'text', text: SECRET }] },
    },
  ])
  assert.deepEqual(hiddenSeqs(api, broken, 1, 3), [])
  assert.match(JSON.stringify(broken.diagnostics), /no-bounds/)

  const inverted = api.scPlanFromEvents([
    carrier(8, RETRACT, 5, 2),
  ])
  assert.deepEqual(hiddenSeqs(api, inverted, 1, 8), [])
  assert.match(JSON.stringify(inverted.diagnostics), /inverted-bounds/)
})

test('compact kind wins over a carrier-shaped summary, and a system replace stays out of the plan', () => {
  const api = helpers()
  const events = [
    user(1, 'keep'),
    {
      type: 'system/message',
      seq: 6,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
      data: { message: { content: [{ type: 'text', text: 'prompt' }] } },
    },
    checkpoint(7, 1, 1, RETRACT),
  ]
  const plan = api.scPlanFromEvents(events)
  assert.deepEqual(hiddenSeqs(api, plan, 1, 7), [])
  assert.equal(api.SC_COMPACT_KIND, 'compact-checkpoint')
})

test('a live note does not widen a replace already in the log, and other sessions stay isolated', () => {
  const api = helpers()
  const events = [
    user(1, 'question'),
    { seq: 2, type: 'tool/call', data: { callId: 'c' } },
    assistant(3, 'old'),
    { seq: 4, type: 'turn/end', data: {} },
    carrier(9, REGENERATE, 3, 3),
  ]
  const notes = [
    { sessionId: 'ses-a', from: 1, until: 9, exclusive: true, messageId: 'follow-1' },
    { sessionId: 'ses-b', from: 1, until: 9, exclusive: true, messageId: 'other-follow' },
  ]
  const plan = api.scPlanForSession('ses-a', events, notes)
  assert.deepEqual(hiddenSeqs(api, plan, 1, 9), [2, 3])
  assert.match(JSON.stringify(plan.diagnostics), /log-replace-already-bounded/)
  assert.equal(api.scNodeHidden({ key: 'f', kind: 'user', anchorSeq: 9, id: 'follow-1' }, plan), true)
  assert.equal(api.scNodeHidden({ key: 'o', kind: 'user', anchorSeq: 9, id: 'other-follow' }, plan), false)
  assert.equal(api.scNodeHidden(node(4, 'turn'), plan), false)

  const early = api.scPlanForSession('ses-a', events.slice(0, 4), notes)
  assert.equal(api.scSeqHidden(4, early), true)
  assert.equal(api.scSeqHidden(8, early), true)
  assert.equal(api.scSeqHidden(9, early), false)
})

test('dsw-regenerate followup stays hidden and a system-less append is not a regenerate boundary', () => {
  const api = helpers()
  const events = [
    user(1, 'question'),
    assistant(2, 'old'),
    carrier(4, REGENERATE, 2, 2),
    {
      type: 'user/message',
      seq: 5,
      surfaceOp: 'append',
      data: {
        id: 'follow-9',
        content: [{ type: 'text', text: 'question' }],
        source: { kind: 'dsw-regenerate' },
      },
    },
    assistant(6, 'new'),
  ]
  const plan = api.scPlanFromEvents(events)
  assert.equal(api.scSeqHidden(2, plan), true)
  assert.equal(api.scNodeHidden(node(1, 'user'), plan), false)
  assert.equal(api.scNodeHidden(node(6, 'assistant'), plan), false)
  assert.equal(api.scNodeHidden({ key: 'f', kind: 'user', anchorSeq: 5, data: { source: { kind: 'dsw-regenerate' } } }, plan), true)
})

test('class reconciliation drops keys that are no longer hidden, including orphans and parent groups', () => {
  const api = helpers()
  const hidden = new Set(['old'])
  const known = new Set(['old', 'kept'])
  assert.equal(api.scKeyHidden('old', hidden), true)
  assert.equal(api.scKeyHidden('kept', hidden), false)
  assert.equal(api.scKeyHidden('orphan', hidden), false)
  assert.equal(api.scKeyHidden(null, hidden), false)
  assert.equal(api.scGroupShouldHide(null, new Set(), ['old', 'kept'], known, hidden), false)
  assert.equal(api.scGroupShouldHide(null, new Set(), ['old'], known, hidden), true)
  assert.equal(api.scGroupShouldHide(null, new Set(), ['orphan'], known, hidden), false)
  assert.equal(api.scGroupShouldHide('turn-1', new Set(['turn-1']), ['kept'], known, hidden), true)
})

test('host wiring clears classes on teardown and does not replay history into the model', () => {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const hostStart = src.indexOf('function ReplacedOutputHost')
  const hostEnd = src.indexOf('function AssistantSessionActions')
  assert.ok(hostStart >= 0 && hostEnd > hostStart)
  const host = src.slice(hostStart, hostEnd)
  assert.ok(host.includes('clearScHideNotes()'))
  assert.ok(host.includes('retainScHideNotes(sessionId)'))
  assert.ok(host.includes('applyReplacedHide(null, { ranges: [], ids: [], seqs: [] })'))
  assert.equal(host.includes('settleSession'), false)
  assert.equal(host.includes('fetch('), false)
  assert.equal(host.includes('search_pre_compaction'), false)
  assert.equal(src.includes('until: ev.seq'), false)
  assert.ok(src.includes('.dsw-sc-replaced{display:none !important}'))
  assert.ok(src.includes('scKeyHidden(key, hidden)'))
})
