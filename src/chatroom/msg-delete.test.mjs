/**
 * 聊天室消息多选删除：store.deleteMessages（原子重写 messages/thinking、清理 cardBin、序号高水位）
 * 与 DELETE /chatroom/rooms/:id/messages {ids}（assertLocal + SSE retract）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore } from './store.mjs'
import { createChatroomFeature } from './index.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-msgdel-'))

test('store.deleteMessages: removes messages + thinking, cleans cardBin, keeps seq high-water', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: '删测' })
    const a = await store.append(room.id, { kind: 'user', speaker: { id: 'u', name: 'U' }, text: '一' })
    const b = await store.append(room.id, { kind: 'seat', speaker: { id: 's', name: 'S' }, text: '二' })
    const c = await store.append(room.id, { kind: 'user', speaker: { id: 'u', name: 'U' }, text: '三' })
    await store.appendThinking(room.id, b.id, '思考内容B')
    await store.appendThinking(room.id, c.id, '思考内容C')
    await store.patchMeta(room.id, (m) => {
      m.cardBin = { [b.id]: { by: 'owner', at: new Date().toISOString(), ref: 'x' }, [c.id]: { by: 'owner', at: new Date().toISOString(), ref: 'y' } }
      return m
    })
    const out = await store.deleteMessages(room.id, [a.id, b.id, 'msg-not-exist', 'bad', a.id])
    assert.deepEqual(out.deleted.sort(), [a.id, b.id].sort())
    assert.equal(out.remaining, 1)
    const left = await store.readMessages(room.id)
    assert.deepEqual(left.map((m) => m.id), [c.id])
    assert.equal(left[0].seq, 3)
    assert.equal(out.meta.messages, 3)
    assert.equal(out.meta.cardBin[b.id], undefined)
    assert.ok(out.meta.cardBin[c.id])
    const think = await readFile(join(dir, 'rooms', room.id, 'thinking.jsonl'), 'utf8')
    assert.doesNotMatch(think, new RegExp(a.id))
    assert.doesNotMatch(think, new RegExp(b.id))
    assert.match(think, new RegExp(c.id))
    const d = await store.append(room.id, { kind: 'user', speaker: { id: 'u', name: 'U' }, text: '四' })
    assert.equal(d.seq, 4)
    assert.equal((await store.getRoom(room.id)).messages, 4)
    const empty = await store.deleteMessages(room.id, [])
    assert.deepEqual(empty.deleted, [])
    assert.equal(empty.remaining, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('API DELETE /messages: local-only, emits retract, rewrites files safely', async () => {
  const dir = await tmp()
  const feat = createChatroomFeature(null, () => ({ chatroomEnabled: true }), { dir })
  try {
    const room = await feat.store.createRoom({ title: '接口删' })
    const m1 = await feat.store.append(room.id, { kind: 'user', speaker: { id: 'u', name: 'U' }, text: 'A' })
    const m2 = await feat.store.append(room.id, { kind: 'seat', speaker: { id: 's', name: 'S' }, text: 'B' })
    const m3 = await feat.store.append(room.id, { kind: 'user', speaker: { id: 'u', name: 'U' }, text: 'C' })
    await feat.store.appendThinking(room.id, m2.id, 'think-B')

    const chunks = []
    await feat.handleApi(
      { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' }, on() {}, url: '/chatroom/rooms/' + room.id + '/events' },
      { writeHead() {}, write: (s) => chunks.push(s), end() {}, on() {} },
      '/chatroom/rooms/' + room.id + '/events',
      { sendJson() {}, readBody: async () => '' },
    )

    const call = async (method, body, opts = {}) => {
      let status = 0, out = null
      const req = {
        method,
        url: '/chatroom/rooms/' + room.id + '/messages',
        headers: opts.site ? { 'sec-fetch-site': opts.site } : {},
        socket: { remoteAddress: opts.addr || '127.0.0.1' },
        on() {},
      }
      await feat.handleApi(req, { writeHead() {} }, '/chatroom/rooms/' + room.id + '/messages', {
        sendJson: (_r, s, b) => { status = s; out = b },
        readBody: async () => JSON.stringify(body || {}),
      })
      return { status, body: out }
    }

    assert.equal((await call('DELETE', { ids: [m1.id, m2.id] }, { addr: '10.0.0.8' })).status, 403)
    assert.equal((await call('DELETE', { ids: [m1.id] }, { site: 'cross-site' })).status, 403)
    assert.equal((await call('DELETE', { ids: [] })).status, 400)

    const r = await call('DELETE', { ids: [m1.id, m2.id, m2.id] })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(r.body.deleted.sort(), [m1.id, m2.id].sort())
    assert.equal(r.body.remaining, 1)
    assert.equal(r.body.room.messages, 3)

    const left = await feat.store.readMessages(room.id)
    assert.deepEqual(left.map((x) => x.id), [m3.id])
    const think = await readFile(join(dir, 'rooms', room.id, 'thinking.jsonl'), 'utf8')
    assert.doesNotMatch(think, /think-B/)

    const blob = chunks.join('')
    assert.match(blob, /event: retract/)
    assert.match(blob, new RegExp(m1.id))
    assert.match(blob, new RegExp(m2.id))
  } finally {
    try { await feat.dispose?.() } catch {}
    await rm(dir, { recursive: true, force: true })
  }
})

test('client wiring: select mode + DELETE /messages + formal Chinese labels', () => {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(src, /选择聊天记录中的消息并删除/)
  assert.match(src, /setMsgSelectMode/)
  assert.match(src, /deleteSelectedMessages/)
  assert.match(src, /method:\s*"DELETE"/)
  assert.match(src, /确定删除所选的/)
  assert.match(src, /将从本房间聊天记录中永久删除所选消息/)
  assert.match(src, /cr-msg-sel/)
  assert.match(src, /已选 /)
  assert.match(src, /function crMsgSig\(m, binned, selectMode, selected\)/)
})
