// 聊天室连续工具卡叠：lib/client.js 中 <cr-chat-tool-stack-helpers> 纯函数 + 接线断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

function helpers() {
  const a = src.indexOf('// <cr-chat-tool-stack-helpers>'), b = src.indexOf('// </cr-chat-tool-stack-helpers>')
  assert.ok(a >= 0 && b > a, 'lib/client.js lacks <cr-chat-tool-stack-helpers>')
  // also need crCmSummary from cm helpers for toItem? not required for grouping tests
  const ctx = {}
  vm.runInNewContext(src.slice(a, b) + '\nthis.h = { crChatToolStackable, crChatToolSpeakerKey, crChatGroupToolStacks, crChatToolStatus, crChatToolToItem };', ctx)
  return ctx.h
}

test('chat tool stacks: consecutive same-seat tools form one stack; reply breaks', () => {
  const h = helpers()
  const msgs = [
    { id: 't1', kind: 'tool', tool: 'a', speaker: { id: 'ds', name: 'deepseek' }, data: { resultId: 'r1', title: 'x' } },
    { id: 't2', kind: 'tool', tool: 'b', speaker: { id: 'ds', name: 'deepseek' }, data: { resultId: 'r2', title: 'y' } },
    { id: 't3', kind: 'tool', tool: 'end_round', speaker: { id: 'ds', name: 'deepseek' }, data: { endRound: true } },
    { id: 's1', kind: 'seat', speaker: { id: 'ds', name: 'deepseek' }, text: 'ok' },
    { id: 't4', kind: 'tool', tool: 'c', speaker: { id: 'g', name: 'grok' }, data: { resultId: 'r3' } },
    { id: 't5', kind: 'tool', tool: 'd', speaker: { id: 'g', name: 'grok' }, data: { resultId: 'r4' } },
    { id: 's2', kind: 'seat', speaker: { id: 'g', name: 'grok' }, text: 'hi' },
  ]
  const u = h.crChatGroupToolStacks(msgs)
  assert.equal(u.length, 4)
  assert.equal(u[0].kind, 'stack')
  assert.deepEqual(Array.from(u[0].items, (x) => x.id), ['t1', 't2', 't3'])
  assert.match(u[0].label, /deepseek/)
  assert.equal(u[1].kind, 'single')
  assert.equal(u[1].msg.id, 's1')
  assert.equal(u[2].kind, 'stack')
  assert.deepEqual(Array.from(u[2].items, (x) => x.id), ['t4', 't5'])
  assert.equal(u[3].msg.id, 's2')
})

test('chat tool stacks: speaker change or non-tool breaks; singles stay single; binOp skipped as non-stackable break', () => {
  const h = helpers()
  assert.equal(h.crChatToolStackable({ kind: 'tool', data: { binOp: 'sweep' } }), false)
  assert.equal(h.crChatToolStackable({ kind: 'tool', data: {} }), true)
  const one = h.crChatGroupToolStacks([
    { id: 'a', kind: 'tool', speaker: { id: 'x' }, data: {} },
  ])
  assert.equal(one.length, 1)
  assert.equal(one[0].kind, 'single')
  const split = h.crChatGroupToolStacks([
    { id: 'a', kind: 'tool', speaker: { id: 'x' }, data: {} },
    { id: 'b', kind: 'tool', speaker: { id: 'y' }, data: {} },
  ])
  assert.equal(split.length, 2)
  assert.equal(split[0].kind, 'single')
  assert.equal(split[1].kind, 'single')
})

test('chat tool stacks wiring: renderLog groups, fan reuse, no category buckets', () => {
  assert.ok(src.includes('crChatGroupToolStacks(visible)'))
  assert.ok(src.includes('function chatToolStackEl'))
  assert.ok(src.includes('cr-chat-stack'))
  assert.ok(src.includes('cmFanTransform(depth)'))
  assert.ok(src.includes('张卡片'))
})
