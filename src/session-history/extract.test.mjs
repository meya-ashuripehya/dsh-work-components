import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectPreCompactionCorpus,
  searchPreCompaction,
  isCompactCheckpointEvent,
} from './extract.mjs'

function msg(seq, type, text, surfaceOp = 'append', extra = {}) {
  if (type === 'user/message') {
    return {
      type, seq, surfaceOp,
      data: { role: 'user', content: [{ type: 'text', text }], ...extra },
    }
  }
  return {
    type, seq, surfaceOp,
    data: { message: { role: type.startsWith('assistant') ? 'assistant' : 'tool', content: [{ type: 'text', text }] }, ...extra },
  }
}

test('isCompactCheckpointEvent recognizes replace checkpoint', () => {
  const ev = {
    type: 'user/message',
    seq: 100,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 50 },
    data: { source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: 'summary' }] },
  }
  assert.equal(isCompactCheckpointEvent(ev), true)
  assert.equal(isCompactCheckpointEvent(msg(1, 'user/message', 'hi')), false)
})

test('collectPreCompactionCorpus recovers shadowed append turns', () => {
  const events = [
    msg(0, 'system/message', 'sys'),
    msg(1, 'user/message', 'hello secret-code-AAA'),
    msg(2, 'assistant/message', 'reply mentioning AAA'),
    msg(3, 'tool/result', 'tool output BBB'),
    {
      type: 'compaction/summary',
      seq: 4,
      data: {
        compactionId: 'c1',
        summary: 'User said hello; assistant replied.',
        shadowedRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      },
    },
    {
      type: 'user/message',
      seq: 5,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
      data: {
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
        content: [{ type: 'text', text: 'Earlier: hello and reply.' }],
      },
    },
    msg(6, 'user/message', 'new question after compact'),
  ]
  const { checkpoints, entries } = collectPreCompactionCorpus(events)
  assert.equal(checkpoints.length, 1)
  assert.equal(checkpoints[0].startSeq, 1)
  assert.equal(checkpoints[0].endSeq, 3)
  assert.ok(entries.some((e) => e.body.includes('secret-code-AAA')))
  assert.ok(entries.some((e) => e.body.includes('BBB')))
  assert.ok(!entries.some((e) => e.body.includes('new question after compact')))
})

test('searchPreCompaction listCheckpoints and query', () => {
  const events = [
    msg(1, 'user/message', 'remember peach-pie-42'),
    msg(2, 'assistant/message', 'got it'),
    {
      type: 'compaction/summary',
      seq: 3,
      data: { compactionId: 'c9', summary: 'discussed dessert', shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2] },
    },
    {
      type: 'user/message',
      seq: 4,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      data: {
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'c9' },
        content: [{ type: 'text', text: 'summary' }],
      },
    },
  ]
  const listed = searchPreCompaction(events, { listCheckpoints: true })
  assert.match(listed.text, /c9/)
  assert.match(listed.text, /discussed dessert/)
  const hit = searchPreCompaction(events, { query: 'peach-pie' })
  assert.equal(hit.total, 1)
  assert.match(hit.text, /peach-pie-42/)
  const miss = searchPreCompaction(events, { query: 'no-such-token-zzz' })
  assert.equal(miss.total, 0)
})

test('searchPreCompaction errors without query/filters when corpus exists', () => {
  const events = [
    msg(1, 'user/message', 'old'),
    {
      type: 'user/message',
      seq: 2,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      data: {
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
        content: [{ type: 'text', text: 'sum' }],
      },
    },
  ]
  const r = searchPreCompaction(events, {})
  assert.equal(r.error, true)
  assert.match(r.text, /needs a query/)
})
