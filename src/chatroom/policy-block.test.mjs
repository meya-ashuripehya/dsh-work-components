// 「发送图片：仅最新消息」与内容政策拦截回退：带图请求被服务商按政策拦截时，本轮改用文字描述重试一次，并暂停发送真图 45 分钟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore, planImageWindow } from './attachments.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { normalizeSeats, resolveSeats, seatsRevision } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { createStore } from './store.mjs'
import { createModerator, isPolicyBlock, imagePolicyBlock, POLICY_PAUSE_MS, POLICY_FALLBACK_NOTICE } from './moderator.mjs'
import { callEntry } from './call-log.mjs'
import { ProviderError } from './providers.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-pb-'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex')
const fakeImages = () => { const saved = []; return { saved, saveImage: async ({ data, mediaType, name }) => { saved.push(name); return { attachmentId: 'sha256:' + saved.length, mediaType, bytes: data.length, width: 1, height: 1 } } } }
const until = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 20)) } }
const BLOCK = "Claude 请求失败：This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com"
const img = (i) => ({ id: 'a' + String(i).padStart(12, '0'), kind: 'image', name: 'p' + i + '.png', mediaType: 'image/png', bytes: 10, ref: { attachmentId: 'sha256:' + i, mediaType: 'image/png', bytes: 10, width: 1, height: 1 } })
const userImg = (seq, i, text = '图') => ({ seq, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, status: 'ok', ts: '2026-10-15T01:00:00Z', text, attachments: [img(i)] })
const seatMsg = (seq, name, text, attachments) => ({ seq, kind: 'seat', speaker: { id: name.toLowerCase(), name }, status: 'ok', ts: '2026-10-15T01:00:00Z', text, ...(attachments ? { attachments } : {}) })

test('seat imageWindow: recent9 by default, latest kept; revision changes with seats', () => {
  const [a, b, c] = normalizeSeats([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', imageWindow: 'latest' }, { id: 'c', name: 'C', imageWindow: 'all' }])
  assert.equal(a.imageWindow, 'recent9')
  assert.equal(b.imageWindow, 'latest')
  assert.equal(c.imageWindow, 'recent9')
  const r1 = seatsRevision([a, b])
  assert.equal(r1, seatsRevision(normalizeSeats([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', imageWindow: 'latest' }])))
  assert.notEqual(r1, seatsRevision([a, { ...b, provider: 'claude' }]))
})

test('latest: only the newest user message carries real images; older ones become lines; rules say so', () => {
  const msgs = [userImg(1, 1), userImg(2, 2), seatMsg(3, 'Grok', '看到了', [img(9)]), userImg(4, 3, '第三张'), seatMsg(5, 'DeepSeek', '嗯')]
  assert.deepEqual([...planImageWindow(msgs, { latest: true })], ['a000000000003'])
  assert.deepEqual([...planImageWindow(msgs)], ['a000000000001', 'a000000000002', 'a000000000009', 'a000000000003'])
  // 最新用户消息不带图：没有真图
  assert.equal(planImageWindow([...msgs, { seq: 6, kind: 'user', speaker: { name: 'Shiro' }, status: 'ok', text: '没图' }], { latest: true }).size, 0)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'claude', name: 'Claude', provider: 'claude', model: 'm', imageWindow: 'latest' }, { id: 'grok', name: 'Grok', provider: 'x', model: 'g' }] })
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, vision: true, toolsInfo: { owner: true, attachments: true } })
  assert.deepEqual(p.realImages, ['a000000000003'])
  assert.equal(p.messages.flatMap((m) => m.images || []).length, 1)
  const text = p.messages.map((m) => m.content).join('\n')
  assert.match(text, /\[image #a000000000001 p1\.png.*older image, not attached; call view_attachment\("a000000000001"\)/)
  assert.match(p.system, /You can see the pictures in the newest message/)
  const p9 = buildPrompt({ seat: seats[1], seats, userName: 'Shiro', messages: msgs, vision: true })
  assert.equal(p9.realImages.length, 3) // Grok's own picture stays text for Grok
  assert.match(p9.system, /You can see the recent pictures/)
})

test('isPolicyBlock / imagePolicyBlock: Anthropic ToS block and similar refusals; only counts as image block when the request had images', () => {
  assert.equal(isPolicyBlock(new Error(BLOCK)), true)
  for (const m of ['Request blocked by content policy', 'Your request was flagged: usage policies', 'content_policy_violation', 'Output blocked by safety filter', 'data_inspection_failed: Input data may contain inappropriate content']) assert.equal(isPolicyBlock(new Error(m)), true, m)
  for (const m of ['429 rate limit', 'boom', 'context length exceeded', 'does not support image input']) assert.equal(isPolicyBlock(new Error(m)), false, m)
  assert.equal(isPolicyBlock({ aborted: true, message: BLOCK }), false)
  assert.equal(imagePolicyBlock(new Error(BLOCK)), false)
  assert.equal(imagePolicyBlock(Object.assign(new Error(BLOCK), { hadImages: true })), true)
  assert.equal(POLICY_PAUSE_MS, 45 * 60000)
})

test('call log: image count and policy-fallback entries', () => {
  const ok = callEntry({ roomId: 'r', seat: { name: 'Claude', provider: 'claude', model: 'm' }, out: { text: 'x' }, ms: 5, images: 2 })
  assert.equal(ok.images, 2)
  const fb = callEntry({ roomId: 'r', seat: { name: 'Claude', provider: 'claude', model: 'm' }, kind: 'policy-fallback', fallback: 'request with images blocked', error: new ProviderError(BLOCK, { code: 'PI_AI_ERROR' }), ms: 0 })
  assert.equal(fb.ok, false); assert.equal(fb.stop, 'fallback'); assert.equal(fb.kind, 'policy-fallback'); assert.equal(fb.code, 'PI_AI_ERROR')
  assert.match(fb.note, /blocked/)
  const plain = callEntry({ roomId: 'r', seat: { name: 'A' }, out: { text: 'x' }, ms: 1 })
  assert.equal(plain.images, undefined)
})

async function fixture({ blockWhen, seatExtra = {}, toolsEnabled = false }) {
  const dir = await tmp()
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'claude', name: 'Claude', provider: 'claude-vision', model: 'claude-sonnet-5-5', ...seatExtra }] })
  const st = createAttachmentStore((id) => join(dir, 'rooms', id), { getAttachmentService: () => fakeImages() })
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null, getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }), attachments: st })
  const calls = []
  const rejected = []
  const logged = []
  const events = []
  const relays = []
  let override = null
  const call = async (o) => {
    calls.push(o)
    if (override) return override(o)
    if (blockWhen(o)) throw new ProviderError(BLOCK, { code: 'PI_AI_ERROR' })
    return { text: '按描述来看，是一张图。', toolCalls: [], usage: {} }
  }
  const cfg = { seats, userName: 'Shiro', budget: 2, maxTokens: 100, ownerId: '9000000001', defaultMain: 'claude', tools: { enabled: toolsEnabled }, attachments: { enabled: true } }
  const tg = { typing: () => () => {}, relay: async (seat, roomId, text) => { relays.push(text); return [] } }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, emit: (_, e) => events.push(e), logCall: (x) => logged.push(x), isVision: async () => true, onVisionRejected: (s, e, o) => rejected.push([s.id, !!o?.policy]) })
  const room = await store.createRoom({ title: 't' })
  const a = await st.save(room.id, { data: PNG, name: 'p.png', mediaType: 'image/png' })
  const att = [{ id: a.id, kind: 'image', name: a.name, mediaType: a.mediaType, bytes: a.bytes, ref: a.ref }]
  return { dir, store, room, moderator, calls, rejected, logged, events, relays, att, setCall: (fn) => { override = fn } }
}

for (const toolsEnabled of [false, true]) {
  test('policy block on a request with images: retried once with descriptions only, user sees a brief note, AIs do not (tools ' + (toolsEnabled ? 'on' : 'off') + ')', async () => {
    const f = await fixture({ toolsEnabled, blockWhen: (o) => o.prompt.messages.some((m) => m.images?.length) })
    try {
      await f.moderator.post(f.room.id, '看看这张', { run: true, owner: true, attachments: f.att })
      await until(async () => (await f.store.readMessages(f.room.id)).some((m) => m.kind === 'seat' && m.status === 'ok'))
      const msgs = await f.store.readMessages(f.room.id)
      assert.equal(msgs.filter((m) => m.kind === 'seat' && m.status === 'ok').pop()?.text, '按描述来看，是一张图。')
      assert.deepEqual(f.rejected, [['claude', true]])
      assert.equal(f.calls.length, 2)
      assert.ok(f.calls[0].prompt.messages.some((m) => m.images?.length))
      assert.ok(!f.calls[1].prompt.messages.some((m) => m.images?.length))
      // 用户提示：系统消息，不转发 Telegram，不进 AI 上下文
      const notes = msgs.filter((m) => m.kind === 'system' && m.text === POLICY_FALLBACK_NOTICE)
      assert.equal(notes.length, 1)
      assert.ok(!f.relays.some((t) => t.includes(POLICY_FALLBACK_NOTICE)))
      assert.ok(!msgs.some((m) => m.kind === 'system' && /失败/.test(m.text)))
      assert.equal(f.events.filter((e) => e.type === 'turn-failed').length, 0)
      assert.equal(f.events.filter((e) => e.type === 'vision-blocked').length, 1)
      const again = buildPrompt({ seat: { ...resolveSeats({ chatroomSeats: [{ id: 'claude', name: 'Claude', provider: 'claude-vision', model: 'm' }] })[0] }, seats: [], userName: 'Shiro', messages: msgs, vision: false })
      assert.ok(!JSON.stringify(again).includes(POLICY_FALLBACK_NOTICE))
      // calls.log：失败那次带图片数，另有一条 policy-fallback
      const failed = f.logged.find((x) => x.error && x.kind !== 'policy-fallback')
      assert.equal(failed.images, 1)
      const fb = f.logged.filter((x) => x.kind === 'policy-fallback')
      assert.equal(fb.length, 1)
      assert.equal(callEntry(fb[0]).stop, 'fallback')
    } finally { await rm(f.dir, { recursive: true, force: true }) }
  })
}

test('policy block on a request without images: normal failure handling (no retry, no note)', async () => {
  const f = await fixture({ blockWhen: () => true })
  try {
    await f.moderator.post(f.room.id, '只是文字', { run: true, owner: true })
    await until(() => f.events.some((e) => e.type === 'turn-failed'))
    const msgs = await f.store.readMessages(f.room.id)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.rejected, [])
    assert.ok(!msgs.some((m) => m.kind === 'system' && m.text === POLICY_FALLBACK_NOTICE))
    assert.equal(f.logged.filter((x) => x.kind === 'policy-fallback').length, 0)
    assert.ok(f.events.some((e) => e.type === 'turn-failed'))
  } finally { await rm(f.dir, { recursive: true, force: true }) }
})

test('latest seat: only the newest image is real; view_attachment of an older image gets text, not pixels', async () => {
  const f = await fixture({ toolsEnabled: true, seatExtra: { imageWindow: 'latest' }, blockWhen: () => false })
  try {
    const st = createAttachmentStore((id) => join(f.dir, 'rooms', id), { getAttachmentService: () => fakeImages() })
    const b = await st.save(f.room.id, { data: Buffer.concat([PNG, Buffer.from([0])]), name: 'q.png', mediaType: 'image/png' })
    assert.notEqual(b.id, f.att[0].id)
    let n = 0
    f.calls.length = 0
    const script = [
      { text: '', toolCalls: [{ id: 'v1', name: 'view_attachment', arguments: JSON.stringify({ id: f.att[0].id }) }], usage: {} },
      { text: '看过了', toolCalls: [], usage: {} },
    ]
    f.setCall((o) => script[Math.min(n++, script.length - 1)])
    await f.moderator.post(f.room.id, '旧图', { run: false, owner: true, attachments: f.att })
    await f.moderator.post(f.room.id, '新图', { run: true, owner: true, attachments: [{ id: b.id, kind: 'image', name: b.name, mediaType: b.mediaType, bytes: b.bytes, ref: b.ref }] })
    await until(async () => (await f.store.readMessages(f.room.id)).some((m) => m.kind === 'seat' && m.status === 'ok'))
    const imgs = f.calls[0].prompt.messages.flatMap((m) => m.images || [])
    assert.deepEqual(imgs.map((x) => x.id), [b.id])
    const tr = f.calls[1].prompt.messages.find((m) => m.toolResult)?.toolResult
    assert.ok(tr, 'tool result present')
    assert.ok(!tr.images?.length)
    assert.match(tr.text, /a\w{12}|description|pictures/i)
    assert.ok(!tr.isError, tr.text)
  } finally { await rm(f.dir, { recursive: true, force: true }) }
})