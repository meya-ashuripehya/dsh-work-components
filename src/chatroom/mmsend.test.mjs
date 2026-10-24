// 「多模态」发送工具（mm_send_image / mm_send_file）在聊天室里内置：走 send_attachment 的路径，工具执行时立即发送（只发一次），结果留卡片。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore } from './attachments.mjs'
import { createAttachmentTools, MM_SEND_IMAGE_NAME, MM_SEND_FILE_NAME, SEND_TOOL_NAMES } from './attachment-tools.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { listCatalog, isSessionImageTool, isCatalogExcluded } from './tool-selector.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-mm-'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex')
const fakeImages = () => ({ saveImage: async ({ data, mediaType }) => ({ attachmentId: 'sha256:1', mediaType, bytes: data.length, width: 1, height: 1 }) })
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })

function setup(dir, { script, tg }) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'gk', name: 'Grok', provider: 'xai', model: 'grok' }] })
  const attachments = createAttachmentStore((id) => join(dir, 'rooms', id), { getAttachmentService: () => fakeImages() })
  const toolkit = createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null,
    getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }), attachments,
  })
  let i = 0
  const calls = []
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const cfg = { seats, userName: 'Shiro', budget: 3, maxTokens: 100, defaultMain: 'gk', tools: { enabled: false }, attachments: { enabled: true } }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg })
  return { store, moderator, calls, attachments, seats }
}

test('mm_send_* are built-in room tools, not session-only, never in the finder catalog', () => {
  assert.equal(isSessionImageTool('mm_send_image'), false); assert.equal(isSessionImageTool('read_image'), true)
  assert.ok(isCatalogExcluded('mm_send_image') && isCatalogExcluded('mm_send_file'))
  const tools = { schemas: () => ['mm_send_image', 'mm_send_file', 'web_search'].map((name) => ({ name, description: name, parameters: { type: 'object' } })) }
  assert.deepEqual(listCatalog(tools).map((t) => t.name), ['web_search'])
  assert.deepEqual([...SEND_TOOL_NAMES].sort(), ['mm_send_file', 'mm_send_image', 'send_attachment'])
})

test('mm_send_image / mm_send_file: same path as send_attachment; non-images rejected by mm_send_image before saving', async () => {
  const dir = await tmp()
  try {
    const store = createAttachmentStore((id) => join(dir, 'rooms', id), { getAttachmentService: () => fakeImages() })
    const tools = createAttachmentTools({ store })
    const png = join(dir, 'cat.png'); await writeFile(png, PNG)
    const txt = join(dir, 'notes.txt'); await writeFile(txt, 'hello')
    const img = await tools.run('r', MM_SEND_IMAGE_NAME, { path: png, title: '小猫' }, { seat: { name: 'Grok' } })
    assert.equal(img.isError, false); assert.equal(img.post.text, '小猫'); assert.equal(img.post.attachments[0].kind, 'image')
    const notImg = await tools.run('r', MM_SEND_IMAGE_NAME, { path: txt }, { seat: { name: 'Grok' } })
    assert.equal(notImg.isError, true); assert.match(notImg.modelText, /不是图片.*mm_send_file/)
    assert.equal(Object.values(await store.list('r')).length, 1)
    const file = await tools.run('r', MM_SEND_FILE_NAME, { path: txt, caption: '笔记' }, { seat: { name: 'Grok' } })
    assert.equal(file.isError, false); assert.equal(file.post.attachments[0].name, 'notes.txt'); assert.equal(file.post.text, '笔记')
    assert.equal((await tools.run('r', MM_SEND_FILE_NAME, { path: 'https://x/y.png' }, {})).isError, true)
    assert.equal((await tools.run('r', MM_SEND_FILE_NAME, {}, {})).isError, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('outbound: mm_send_image in a non-owner Telegram turn is offered without find_tools, delivered when the tool runs, leaves a card', async () => {
  const dir = await tmp()
  try {
    const relayed = []
    const lines = []
    const tg = { typing: () => () => {}, relay: async (_s, _r, text) => { lines.push(text); return [] }, relayAttachments: async (seat, _r, msg) => { relayed.push(`${seat?.id}:${msg.text}:${msg.attachments.map((a) => a.name).join(',')}`); return [{ chatId: '-1001', ok: true }] } }
    const png = join(dir, 'chart.png'); await writeFile(png, PNG)
    const { store, moderator, seats } = setup(dir, {
      tg,
      script: [
        (o) => { const names = o.tools.map((t) => t.name); assert.ok(names.includes('mm_send_image') && names.includes('mm_send_file') && names.includes('send_attachment')); assert.ok(!names.includes('find_tools')); return { text: '', toolCalls: [tc('c1', 'mm_send_image', { path: png, caption: '图表' })], usage: {} } },
        (o) => { assert.match(o.prompt.messages.at(-1).toolResult.text, /已发送 #a[0-9a-f]{12} chart\.png[\s\S]*已写入房间/); assert.equal(relayed.length, 1); return { text: '发好了。', toolCalls: [], usage: {} } },
      ],
    })
    const room = await store.createRoom({ title: '中转站' })
    const out = await moderator.post(room.id, '把图表发群里', { owner: false, source: 'telegram', fromId: '5', userName: 'X' })
    await out.promise
    const msgs = await store.readMessages(room.id)
    const sent = msgs.find((m) => m.via === 'send_attachment')
    assert.equal(sent.kind, 'seat'); assert.equal(sent.text, '图表'); assert.equal(sent.attachments[0].name, 'chart.png')
    assert.deepEqual(relayed, ['gk:图表:chart.png'])
    const card = msgs.find((m) => m.kind === 'tool' && m.tool === 'mm_send_image')
    assert.ok(card?.data?.resultId); assert.match(card.data.title, /^发送图片 · .*chart\.png · \d+ 字$/)
    assert.ok(!lines.some((l) => /mm_send_image/.test(String(l))), 'card summary is not relayed to Telegram')
    const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs })
    assert.match(p.messages.map((m) => m.content).join('\n'), /\[card #r\w+ by Grok · 发送图片 · .*chart\.png · \d+ 字\] → 已发送 #a/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failed turn: an mm_send_file that already ran stays delivered exactly once and its card is kept (salvaged)', async () => {
  const dir = await tmp()
  try {
    const relayed = []
    const tg = { typing: () => () => {}, relay: async () => [], relayAttachments: async () => { relayed.push(1); return [] } }
    const f = join(dir, 'a.txt'); await writeFile(f, 'x')
    const { store, moderator } = setup(dir, {
      tg,
      script: [
        { text: '', toolCalls: [tc('c1', 'mm_send_file', { path: f })], usage: {} },
        async () => { throw Object.assign(new Error('Grok 请求失败：500'), { status: 500 }) },
      ],
    })
    const room = await store.createRoom({ title: 'r' })
    const out = await moderator.post(room.id, '发一下', { owner: true, source: 'local' })
    await out.promise
    const msgs = await store.readMessages(room.id)
    assert.equal(relayed.length, 1)
    assert.equal(msgs.filter((m) => m.via === 'send_attachment').length, 1)
    const card = msgs.find((m) => m.kind === 'tool' && m.tool === 'mm_send_file')
    assert.ok(card && card.salvaged)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
