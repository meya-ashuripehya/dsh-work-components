// 实时输出：工具卡片在工具完成时即入库 / 推界面 / 转发 Telegram（正文随后追加）；mm_send_* 在工具执行时即投递（只投一次），不等回合结束或其他成员。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore } from './attachments.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-rt-'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex')
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const registry = {
  schemas: () => [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  get: (n) => ({ execute: async (args) => ({ content: [{ type: 'text', text: `${n} output ${args.path} ` + 'x'.repeat(40) }] }) }),
}

async function setup(dir, script) {
  const store = createStore(dir)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro' }, { id: 'gk', name: 'Grok', provider: 'xai', model: 'grok' }] })
  const attachments = createAttachmentStore((id) => join(dir, 'rooms', id), { getAttachmentService: () => ({ saveImage: async ({ data, mediaType }) => ({ attachmentId: 'sha256:1', mediaType, bytes: data.length, width: 1, height: 1 }) }) })
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => registry, getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }), attachments })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const events = []
  const relays = []
  const sent = []
  const tg = {
    typing: () => () => {},
    relay: async (seat, _r, text) => { relays.push({ seat: seat?.id || null, text }); return [] },
    relayAttachments: async (seat, _r, msg) => { sent.push({ seat: seat?.id, id: msg.id, text: msg.text }); return [{ chatId: '-1001', ok: true }] },
  }
  const cfg = { seats, userName: 'Shiro', budget: 2, maxTokens: 100, defaultMain: 'ds', tools: {}, attachments: { enabled: true } }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, emit: (_, e) => events.push(e) })
  const room = await store.createRoom({ title: '中转站' })
  await toolkit.toolsets.add(room.id, ['read_file'], { max: 10, by: 'test' })
  return { store, moderator, calls, events, relays, sent, room }
}

test('realtime: tool card is stored, pushed and relayed as soon as the tool finishes; mm_send_image is delivered during the turn, once; reply text comes after', async () => {
  const dir = await tmp()
  try {
    const png = join(dir, 'chart.png'); await writeFile(png, PNG)
    let ctx
    const seen = {}
    const script = [
      { text: '', toolCalls: [tc('c1', 'read_file', { path: 'a.txt' })], usage: {} },
      async () => {
        // 第二步模型调用之前：read_file 卡片已入库、已以正式（非 pending）消息推给界面、已转发 Telegram
        const msgs = await ctx.store.readMessages(ctx.room.id)
        seen.cardStored = msgs.some((m) => m.kind === 'tool' && m.tool === 'read_file')
        seen.cardPushed = ctx.events.some((e) => e.type === 'message' && !e.pending && e.message.tool === 'read_file')
        seen.cardRelayed = ctx.relays.some((r) => /read_file/.test(r.text))
        return { text: '', toolCalls: [tc('c2', 'mm_send_image', { path: png, caption: '图表' })], usage: {} }
      },
      async (o) => {
        // 本回合尚未结束：图片已写入房间并发到 Telegram，工具结果带投递结果
        seen.sentDuringTurn = ctx.sent.length
        seen.result = o.prompt.messages.at(-1).toolResult.text
        return { text: '图已发出。', toolCalls: [], usage: {} }
      },
      { text: 'PASS', toolCalls: [], usage: {} },
    ]
    ctx = await setup(dir, script)
    const out = await ctx.moderator.post(ctx.room.id, '读一下再把图发群里', { owner: true, source: 'local' })
    await out.promise
    assert.equal(seen.cardStored, true); assert.equal(seen.cardPushed, true); assert.equal(seen.cardRelayed, true)
    assert.equal(seen.sentDuringTurn, 1)
    assert.match(seen.result, /已写入房间；Telegram：1 个群发送成功/)
    assert.equal(ctx.sent.length, 1, 'delivered exactly once (no second delivery at turn end)')
    const msgs = await ctx.store.readMessages(ctx.room.id)
    assert.equal(msgs.filter((m) => m.via === 'send_attachment').length, 1)
    assert.equal(msgs.filter((m) => m.kind === 'tool' && m.tool === 'read_file').length, 1, 'card not written twice')
    const order = msgs.filter((m) => m.speaker?.id === 'ds').map((m) => m.kind === 'tool' ? m.tool : m.via || m.text)
    assert.deepEqual(order, ['read_file', 'send_attachment', 'mm_send_image', '图已发出。'])
    assert.equal(ctx.relays.filter((r) => /read_file/.test(r.text)).length, 1)
    assert.ok(ctx.relays.findIndex((r) => /read_file/.test(r.text)) < ctx.relays.findIndex((r) => r.text === '图已发出。'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('realtime: hidden end_round / repeat-block rules unchanged — repeat-blocked cards are still staged (pending) and dropped on failure', async () => {
  const dir = await tmp()
  try {
    const call3 = tc('c1', 'read_file', { path: 'a.txt' })
    const ctx = await setup(dir, [
      { text: '', toolCalls: [call3], usage: {} },
      { text: '', toolCalls: [{ ...call3, id: 'c2' }], usage: {} },
      { text: '', toolCalls: [{ ...call3, id: 'c3' }], usage: {} },
      async () => { throw new Error('DeepSeek 请求失败：HTTP 500') },
    ])
    const out = await ctx.moderator.post(ctx.room.id, '读', { owner: true, source: 'local' })
    await out.promise
    const msgs = await ctx.store.readMessages(ctx.room.id)
    assert.ok(!msgs.some((m) => m.data?.blocked === 'repeat'))
    assert.ok(ctx.events.some((e) => e.type === 'retract'))
    assert.equal(msgs.filter((m) => m.kind === 'tool' && m.tool === 'read_file' && m.salvaged).length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})