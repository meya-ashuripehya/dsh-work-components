// 识图修复：会话专用图片工具不进房间、席位「识图」覆盖、看不到图片的成员只得到明确标注的文字描述、服务商拒收图片时回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore, attachmentLine } from './attachments.mjs'
import { createAttachmentTools } from './attachment-tools.mjs'
import { createChatroomTools, SESSION_IMAGE_TOOL_HINT } from './chatroom-tools.mjs'
import { listCatalog, isSessionImageTool } from './tool-selector.mjs'
import { normalizeSeats, resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { createStore } from './store.mjs'
import { createModerator, isImageRejection } from './moderator.mjs'
import { ProviderError } from './providers.mjs'
import { createChatroomFeature } from './index.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-vis-'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex')
const fakeImages = () => {
  const saved = []
  return { saved, saveImage: async ({ data, mediaType, name }) => { saved.push(name); return { attachmentId: `sha256:${saved.length}`, mediaType, bytes: data.length, width: 1, height: 1 } } }
}
const imgMsg = (i, extra = {}) => ({
  seq: i, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, status: 'ok', ts: '2026-10-15T01:00:00Z', text: `图 ${i}`,
  attachments: [{ id: `a${String(i).padStart(12, '0')}`, kind: 'image', name: `p${i}.png`, mediaType: 'image/png', bytes: 10, ref: { attachmentId: `sha256:${i}`, mediaType: 'image/png', bytes: 10, width: 1, height: 1 }, ...extra }],
})
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const until = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 20)) } }

test('session-bound image tools never reach the find_tools catalog', () => {
  for (const n of ['vision_describe', 'vision_ocr', 'vision_activate', 'vision_bootstrap', 'vision_present', 'vision_materialize', 'read_image']) assert.equal(isSessionImageTool(n), true, n)
  for (const n of ['web_search', 'image_generate', 'view_attachment']) assert.equal(isSessionImageTool(n), false, n)
  const tools = { schemas: () => ['vision_describe', 'vision_ocr', 'vision_activate', 'mm_send_image', 'read_image', 'image_generate', 'web_search'].map((name) => ({ name, description: name, parameters: { type: 'object' } })) }
  assert.deepEqual(listCatalog(tools).map((t) => t.name), ['image_generate', 'web_search'])
})

test('room toolset: vision_* left over in an old toolset is neither offered nor executed', async () => {
  const dir = await tmp()
  try {
    const executed = []
    const registry = {
      schemas: () => ['vision_describe', 'web_search'].map((name) => ({ name, description: name, parameters: { type: 'object' } })),
      get: (name) => ({ name, execute: async () => { executed.push(name); return { content: [{ type: 'text', text: 'ran' }] } } }),
    }
    const tk = createChatroomTools({ roomDir: (id) => join(dir, id), getTools: () => registry, getLlm: () => null, getSettings: () => ({ enabled: true }), providers: async () => ({ available: false, providers: [] }) })
    await tk.toolsets.add('r', ['vision_describe', 'web_search'], { max: 12 })
    const names = (await tk.schemas('r', { owner: true })).map((t) => t.name)
    assert.ok(!names.includes('vision_describe'))
    assert.ok(names.includes('web_search'))
    const r = await tk.run('r', tc('c1', 'vision_describe', { attachmentIds: ['a80ebd5275b5a'] }), { owner: true })
    assert.equal(r.isError, true); assert.equal(r.room, null)
    assert.equal(r.modelText, SESSION_IMAGE_TOOL_HINT('vision_describe'))
    assert.match(r.modelText, /view_attachment/)
    assert.deepEqual(executed, [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('seat 识图 setting: auto by default, on / off kept, junk falls back to auto', () => {
  const s = normalizeSeats([{ id: 'a', provider: 'p', model: 'm' }, { id: 'b', provider: 'p', model: 'm', vision: 'on' }, { id: 'c', provider: 'p', model: 'm', vision: 'off' }, { id: 'd', provider: 'p', model: 'm', vision: true }])
  assert.deepEqual(s.map((x) => x.vision), ['auto', 'on', 'off', 'auto'])
})

test('non-vision stubs say plainly that the member cannot see the image and offer a description path', () => {
  const a = { id: 'a000000000001', kind: 'image', name: 'p.png', width: 2, height: 3, ref: { attachmentId: 'sha256:1' } }
  const none = attachmentLine(a, { vision: false })
  assert.match(none, /no description yet\] \(you can't see it; view_attachment\("a000000000001"\) can fetch a description\)/)
  const withDesc = attachmentLine({ ...a, description: 'a cat', describedBy: 'Gemini' }, { vision: false })
  assert.match(withDesc, /description by Gemini: a cat\] \(you can't see it; that's their description\)/)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'x', model: 'y' }] })
  const np = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: [imgMsg(1)], vision: false, toolsInfo: { owner: true, attachments: true } })
  assert.match(np.system, /Pictures don't reach you here\. If one has a description, it's someone else's/)
  assert.ok(!/\bnever\b(?! reuse a gesture)|CANNOT|vision_describe/i.test(np.system)) // tone rule's "never reuse a gesture" is not about pictures
  assert.ok(!np.messages.some((m) => m.images))
  const vp = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: [imgMsg(1)], vision: true, toolsInfo: { owner: true, attachments: true } })
  assert.match(vp.system, /You can see the recent pictures/)
  // 没有图片的上下文里不提图片
  assert.ok(!/picture|image/i.test(buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: [{ seq: 1, kind: 'user', speaker: { name: 'Shiro' }, text: 'hi', status: 'ok' }], vision: true, toolsInfo: { owner: true, attachments: true } }).system))
  assert.equal(vp.messages.flatMap((m) => m.images || []).length, 1)
  // 描述者署名经附件索引合并进来
  const mp = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: [imgMsg(1)], vision: false, attachmentMeta: { a000000000001: { description: 'two cats', describedBy: 'grok' } } })
  assert.match(mp.messages.map((m) => m.content).join('\n'), /description by grok: two cats/)
})

test('view_attachment for a non-vision member: description generated on demand and labelled as someone else\'s', async () => {
  const dir = await tmp()
  try {
    const st = createAttachmentStore((id) => join(dir, id), { getAttachmentService: () => fakeImages() })
    const asked = []
    const tools = createAttachmentTools({ store: st, describe: async (roomId, meta) => { asked.push(meta.id); await st.update(roomId, meta.id, { description: 'a red square', describedBy: 'Gemini' }); return { text: 'a red square', by: 'Gemini' } } })
    const img = await st.save('r', { data: PNG, name: 'p.png', mediaType: 'image/png' })
    const nv = await tools.run('r', 'view_attachment', { id: img.id }, { vision: false })
    assert.equal(nv.images, undefined)
    assert.match(nv.modelText, /pictures don't reach you/)
    assert.match(nv.modelText, /Text description \(written by Gemini\): a red square/)
    assert.match(nv.modelText, /their description, not something you saw yourself/)
    assert.deepEqual(asked, [img.id])
    // 已有描述时不再生成；视觉成员拿到真图并附上描述
    await tools.run('r', 'view_attachment', { id: img.id }, { vision: false })
    assert.equal(asked.length, 1)
    const v = await tools.run('r', 'view_attachment', { id: img.id }, { vision: true })
    assert.equal(v.images.length, 1); assert.match(v.modelText, /written by Gemini/)
    // 生成失败：明确说明没有描述，不许猜
    const img2 = await st.save('r', { data: Buffer.concat([PNG, Buffer.from([0])]), name: 'q.png', mediaType: 'image/png' })
    const failing = createAttachmentTools({ store: st, describe: async () => ({ error: '没有能识图的成员' }) })
    const f = await failing.run('r', 'view_attachment', { id: img2.id }, { vision: false })
    assert.match(f.modelText, /No description yet \(没有能识图的成员\)\. Just say you can't see it/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('provider rejects image input: the turn is retried with text stubs and the route is reported', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const seats = resolveSeats({ chatroomSeats: [{ id: 'claude', name: 'Claude', provider: 'claude', model: 'claude-sonnet-5-5', vision: 'on' }] })
    const st = createAttachmentStore((id) => join(dir, 'rooms', id), { getAttachmentService: () => fakeImages() })
    const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null, getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }), attachments: st })
    const calls = []
    const rejected = []
    const call = async (o) => {
      calls.push(o)
      if (o.prompt.messages.some((m) => m.images?.length)) throw new ProviderError('Claude 请求失败：pi-ai model "claude-sonnet-5-5" does not support image input', { code: 'UNSUPPORTED_CONTENT' })
      return { text: '我看不到图片，只能根据描述回答。', toolCalls: [], usage: {} }
    }
    const cfg = { seats, userName: 'Shiro', budget: 2, maxTokens: 100, ownerId: '9000000001', defaultMain: 'claude', tools: { enabled: false }, attachments: { enabled: true } }
    const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, isVision: async () => true, onVisionRejected: (s) => rejected.push(s.id) })
    const room = await store.createRoom({ title: 't' })
    const a = await st.save(room.id, { data: PNG, name: 'p.png', mediaType: 'image/png' })
    await moderator.post(room.id, '看看这张', { run: true, owner: true, attachments: [{ id: a.id, kind: 'image', name: a.name, mediaType: a.mediaType, bytes: a.bytes, ref: a.ref }] })
    await until(async () => (await store.readMessages(room.id)).some((m) => m.kind === 'seat' && m.status === 'ok'))
    const msgs = await store.readMessages(room.id)
    assert.equal(msgs.filter((m) => m.kind === 'seat' && m.status === 'ok').pop()?.text, '我看不到图片，只能根据描述回答。')
    assert.deepEqual(rejected, ['claude'])
    assert.ok(calls.length >= 2)
    const retry = calls.at(-1)
    assert.ok(!retry.prompt.messages.some((m) => m.images?.length))
    assert.match(retry.prompt.system, /Pictures don't reach you here/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('isImageRejection recognises adapter errors but not ordinary failures or stops', () => {
  assert.equal(isImageRejection({ code: 'UNSUPPORTED_CONTENT', message: 'x' }), true)
  assert.equal(isImageRejection(new Error('DeepSeek Messages image input requires a vision model and attachment service')), true)
  assert.equal(isImageRejection(new Error('429 rate limit')), false)
  assert.equal(isImageRejection({ aborted: true, code: 'UNSUPPORTED_CONTENT' }), false)
})

test('feature: 识图 override beats model info, and descriptions come from a vision-capable member', async () => {
  const dir = await tmp()
  const infoCalls = []
  const llm = {
    listProviders: () => [{ id: 'claude' }, { id: 'google' }, { id: 'gpt-vision' }],
    resolveModelInfo: async (p, m) => { infoCalls.push(p); if (p === 'nomods') return { provider: p, id: m }; return { provider: p, id: m, inputModalities: p === 'google' || p === 'gpt-vision' ? ['text', 'image'] : ['text'] } },
    stream: () => { throw new Error('not used') },
  }
  const described = []
  const cfg = {
    chatroomEnabled: true, chatroomOwnerTelegramId: '9000000001',
    chatroomSeats: [
      { id: 'claude', name: 'Claude', provider: 'claude', model: 'claude-sonnet-5-5' },
      { id: 'gpt', name: 'GPT', provider: 'gpt-vision', model: 'gpt-6.1-sol' },
      { id: 'gem', name: 'Gemini', provider: 'google', model: 'gemini-3.8-flash' },
    ],
  }
  const feat = createChatroomFeature(null, () => cfg, {
    dir, llm, presets: null, attachmentService: fakeImages(),
    tools: { schemas: () => [], get: () => undefined },
    call: async (o) => { described.push({ seat: o.seat.name, images: o.prompt.messages.flatMap((m) => m.images || []).length, effort: o.seat.reasoningEffort }); return { text: 'A tiny red square on white.', usage: {} } },
  })
  try {
    const seats = resolveSeats(cfg)
    assert.equal(await feat.isVision(seats[0]), false) // 自动：模型信息只有 text
    assert.equal(await feat.isVision(seats[2]), true)
    // 「识图：开」纠正缺失的模型信息；模型信息明确只收文字时 DSH 会在发出前把图换成文字，开也没用，按看不到处理
    assert.equal(await feat.isVision({ ...seats[0], vision: 'on' }), false)
    assert.equal(await feat.isVision({ ...seats[0], provider: 'nomods', vision: 'on' }), true)
    assert.equal(await feat.isVision({ ...seats[2], vision: 'off' }), false)
    const room = await feat.store.createRoom({ title: '中转站' })
    const meta = await feat.attachments.save(room.id, { data: PNG, name: 'p.png', mediaType: 'image/png' })
    const r = await feat.toolkit.run(room.id, tc('c1', 'view_attachment', { id: meta.id }), { owner: true, seat: seats[0], vision: false })
    assert.match(r.modelText, /Text description \(written by Gemini\): A tiny red square on white\./)
    // 原生识图成员优先于 Vision Router 的「-vision」孪生路由；描述请求带真图、不带推理强度
    assert.deepEqual(described, [{ seat: 'Gemini', images: 1, effort: '' }])
    const saved = await feat.attachments.get(room.id, meta.id)
    assert.equal(saved.description, 'A tiny red square on white.'); assert.equal(saved.describedBy, 'Gemini')
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true }) }
})
