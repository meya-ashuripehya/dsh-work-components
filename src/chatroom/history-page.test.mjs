// 聊天室面板的聊天记录分页：服务端 pageMessages / GET /chatroom/rooms/:id?limit= / GET …/messages?before=&limit=，
// 以及 lib/client.js 中 <cr-history-helpers> 段的纯函数。只影响面板显示：不改存储、不改成员看到的上下文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { pageMessages, historyLimit, HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX } from './store.mjs'
import { createChatroomFeature } from './index.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-histpage-'))
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ id: 'msg-' + (i + 1), seq: i + 1, text: 't' + (i + 1) }))

test('pageMessages: latest page by default, before=<seq> pages backwards, older counts what is left', () => {
  const all = msgs(120)
  let p = pageMessages(all, { limit: 50 })
  assert.equal(p.total, 120); assert.equal(p.older, 70)
  assert.deepEqual(p.messages.map((m) => m.seq), Array.from({ length: 50 }, (_, i) => 71 + i))
  p = pageMessages(all, { before: 71, limit: 50 })
  assert.equal(p.messages[0].seq, 21); assert.equal(p.messages.at(-1).seq, 70); assert.equal(p.older, 20)
  p = pageMessages(all, { before: 21, limit: 50 })
  assert.deepEqual(p.messages.map((m) => m.seq), Array.from({ length: 20 }, (_, i) => i + 1)); assert.equal(p.older, 0)
  assert.deepEqual(pageMessages(all, { before: 1, limit: 50 }).messages, [])
  // 无效 before 当作「从最新往前」；无效 limit 用默认值；上限 500
  assert.equal(pageMessages(all, { before: 'abc', limit: 10 }).messages.at(-1).seq, 120)
  assert.equal(pageMessages(all, { limit: 'x' }).messages.length, HISTORY_PAGE_DEFAULT)
  assert.equal(historyLimit(0), HISTORY_PAGE_DEFAULT); assert.equal(historyLimit(-3), HISTORY_PAGE_DEFAULT)
  assert.equal(historyLimit(9999), HISTORY_PAGE_MAX); assert.equal(historyLimit('7.9'), 7)
  assert.deepEqual(pageMessages(null, {}), { messages: [], total: 0, older: 0 })
  // 不修改原数组
  assert.equal(all.length, 120)
})

test('pageMessages: messages without seq (legacy) count as oldest; order preserved', () => {
  const all = [{ id: 'a' }, ...msgs(3)]
  assert.deepEqual(pageMessages(all, { before: 3, limit: 10 }).messages.map((m) => m.id), ['a', 'msg-1', 'msg-2'])
  assert.deepEqual(pageMessages(all, { limit: 2 }).messages.map((m) => m.id), ['msg-2', 'msg-3'])
})

test('API: GET room with ?limit= returns the latest page + history; without params returns everything (backward compatible); GET /messages pages older', async () => {
  const dir = await tmp()
  const feat = createChatroomFeature(null, () => ({ chatroomEnabled: false }), { dir })
  try {
    const st = feat.store
    const room = await st.createRoom({ title: '分页' })
    for (let i = 0; i < 130; i++) await st.append(room.id, { kind: i % 3 ? 'seat' : 'user', speaker: { id: 'u', name: 'U' }, text: 'm' + (i + 1) })
    const before = await readFile(join(dir, 'rooms', room.id, 'messages.jsonl'), 'utf8')
    const call = async (sub) => {
      let status = 0, out = null
      const req = { method: 'GET', url: sub, headers: {}, on() {} }
      await feat.handleApi(req, { writeHead() {} }, sub.split('?')[0], { sendJson: (_r, s, b) => { status = s; out = b }, readBody: async () => '' })
      return { status, body: out }
    }
    let r = await call(`/chatroom/rooms/${room.id}`)
    assert.equal(r.status, 200); assert.equal(r.body.messages.length, 130); assert.equal(r.body.history, undefined)
    assert.equal(r.body.room.id, room.id)
    r = await call(`/chatroom/rooms/${room.id}?limit=50`)
    assert.equal(r.status, 200); assert.equal(r.body.messages.length, 50)
    assert.deepEqual(r.body.history, { total: 130, older: 80, limit: 50 })
    assert.equal(r.body.messages[0].seq, 81); assert.equal(r.body.messages.at(-1).seq, 130)
    assert.equal(typeof r.body.running, 'boolean')
    let oldest = r.body.messages[0].seq
    const seen = r.body.messages.map((m) => m.seq)
    for (;;) {
      r = await call(`/chatroom/rooms/${room.id}/messages?before=${oldest}&limit=50`)
      assert.equal(r.status, 200); assert.equal(r.body.total, 130)
      if (!r.body.messages.length) break
      assert.ok(r.body.messages.every((m) => m.seq < oldest))
      seen.unshift(...r.body.messages.map((m) => m.seq))
      oldest = r.body.messages[0].seq
      if (!r.body.older) break
    }
    assert.deepEqual(seen, Array.from({ length: 130 }, (_, i) => i + 1))
    // limit 上限、坏房间编号、不存在的房间
    assert.equal((await call(`/chatroom/rooms/${room.id}/messages?limit=100000`)).body.limit, HISTORY_PAGE_MAX)
    assert.equal((await call('/chatroom/rooms/room-nope-000000/messages?limit=5')).status, 404)
    // 只读：存储未被改动
    assert.equal(await readFile(join(dir, 'rooms', room.id, 'messages.jsonl'), 'utf8'), before)
  } finally {
    try { await feat.dispose?.() } catch {}
    await rm(dir, { recursive: true, force: true })
  }
})

function clientHelpers() {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const a = src.indexOf('// <cr-history-helpers>'), b = src.indexOf('// </cr-history-helpers>')
  assert.ok(a >= 0 && b > a, 'lib/client.js lacks the <cr-history-helpers> block')
  const ctx = {}
  vm.runInNewContext(src.slice(a, b) + '\nthis.h = { CR_HISTORY_PAGE, crHiddenCount, crOlderLabel, crMergeOlder, crOldestSeq, crMsgSig, crTrimShown, crFoldSplit, crFoldLabel, CR_INITIAL_STICK_MS, crInitialStickActive };', ctx)
  return ctx.h
}

test('client helpers: hidden count, formal label, merge/dedupe, oldest seq, render signature, window trim', () => {
  const h = clientHelpers()
  assert.equal(h.CR_HISTORY_PAGE, 50)
  assert.equal(h.crHiddenCount(50, 50, 575), 575)
  assert.equal(h.crHiddenCount(625, 50, 0), 575)
  assert.equal(h.crHiddenCount(30, 50, 0), 0)
  assert.equal(h.crHiddenCount(120, 70, 10), 60)
  assert.equal(h.crOlderLabel(575, 50), '显示更早的 50 条消息（共 575 条未显示）')
  assert.equal(h.crOlderLabel(12, 50), '显示更早的 12 条消息')
  const cur = [{ id: 'c', seq: 5 }, { id: 'd', seq: 6 }, { id: 'p' }]
  const merged = h.crMergeOlder([{ id: 'a', seq: 3 }, { id: 'b', seq: 4 }, { id: 'c', seq: 5 }], cur)
  assert.deepEqual(Array.from(merged, (m) => m.id), ['a', 'b', 'c', 'd', 'p'])
  assert.equal(h.crOldestSeq(cur), 5); assert.equal(h.crOldestSeq([{ id: 'p' }]), 0); assert.equal(h.crOldestSeq([]), 0)
  const m = { id: 'x', seq: 1, text: 'hi', status: 'ok' }
  assert.equal(h.crMsgSig(m, false), h.crMsgSig({ ...m }, false))
  assert.notEqual(h.crMsgSig(m, false), h.crMsgSig(m, true))
  assert.notEqual(h.crMsgSig(m, false), h.crMsgSig({ ...m, text: 'hi!' }, false))
  assert.equal(h.crTrimShown(101, true, 50), 50)
  assert.equal(h.crTrimShown(101, false, 50), 101)
  assert.equal(h.crTrimShown(100, true, 50), 100)
})

test('client wiring: first screen requests one page, older pages via before=&limit=, media lazy, no full re-render on stream', () => {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(src.includes('"?limit=" + CR_HISTORY_PAGE'))
  assert.ok(src.includes('"/messages?before=" + before + "&limit=" + CR_HISTORY_PAGE'))
  assert.ok(src.includes('img.loading = "lazy"') && src.includes('img.decoding = "async"'))
  assert.ok(src.includes('au.preload = "none"'))
  assert.ok(!src.includes('t.textContent += d.text'), 'stream deltas must not rewrite the whole text node')
  assert.ok(!/messages\[at\] = m; renderLog\(\)/.test(src), 'finalizing a pending card must not re-render the whole log')
})

test('client helpers: fold split at summary cutoff and formal fold labels', () => {
  const h = clientHelpers()
  const list = [{ seq: 1 }, { seq: 5 }, { seq: 6 }, { id: 'failed-x' }, { seq: 9 }]
  const sp = h.crFoldSplit(list, 5)
  assert.equal(JSON.stringify(sp.folded.map((m) => m.seq)), '[1,5]')
  assert.equal(sp.rest.length, 3)
  assert.equal(h.crFoldSplit(list, 0).folded.length, 0)
  assert.equal(h.crFoldLabel(12, false), '已收起 12 条已压缩的消息，点击展开')
  assert.equal(h.crFoldLabel(12, true), '收起已压缩的 12 条消息')
})

test('client: compress live view and summary collapse are wired to the room event stream', () => {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const ev of ['compress-start', 'compress-delta', 'compress-thinking', 'compress-end', 'context-summary']) assert.ok(src.includes('on("' + ev + '"'), ev)
  assert.ok(src.includes('setCtxSummary(b.room && b.room.contextSummary)'), 'collapse on page load')
  assert.ok(src.includes('"上下文压缩"'), 'sender label')
})

test('client helpers: initial stick-to-bottom window ends on timeout or user scroll', () => {
  const h = clientHelpers()
  assert.ok(h.CR_INITIAL_STICK_MS >= 3000)
  assert.equal(h.crInitialStickActive(1000, 5000, false), true)
  assert.equal(h.crInitialStickActive(6000, 5000, false), false)
  assert.equal(h.crInitialStickActive(1000, 5000, true), false)
  assert.equal(h.crInitialStickActive(1000, 0, false), false)
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(src, /openEvents\(\);\r?\n\s*startInitialStick\(\);/)
  assert.match(src, /function showOlder\(\) \{\r?\n.*\r?\n\s*stopInitialStick\(\);/)
})
