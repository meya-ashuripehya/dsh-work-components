// Vision Router「-vision」转接成员（真图可能被换成 vision_describe 文字标记）、view_attachment 提问、「世界的控制台」措辞。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore } from './attachments.mjs'
import { createAttachmentTools } from './attachment-tools.mjs'
import { OPEN_CARD, FIND_TOOLS } from './tool-selector.mjs'
import { buildPrompt } from './transcript.mjs'
import { resolveSeats } from './seats.mjs'
import { createChatroomFeature } from './index.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-vr-'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex')
const fakeImages = () => { let n = 0; return { saveImage: async ({ data, mediaType }) => ({ attachmentId: `sha256:${++n}`, mediaType, bytes: data.length, width: 1, height: 1 }) } }
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const seats = resolveSeats({ chatroomSeats: [{ id: 'cl', name: 'Claude', provider: 'claude-vision', model: 'claude-sonnet-5-5' }, { id: 'ds', name: 'deepseek', provider: 'deepseek', model: 'deepseek-flash' }] })
const imgMsg = { seq: 1, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, status: 'ok', ts: '2026-10-15T08:40:45Z', text: 'Claude整的活多着呢', attachments: [{ id: 'a94d9e77d04e4', kind: 'image', name: 'photo-257.jpg', mediaType: 'image/jpeg', bytes: 10, width: 1280, height: 968, ref: { attachmentId: 'sha256:1', mediaType: 'image/jpeg', bytes: 10, width: 1280, height: 968 } }] }
const meta = { a94d9e77d04e4: { id: 'a94d9e77d04e4', kind: 'image', description: 'A chat screenshot ending in a red notice "你的账号已被封禁".', describedBy: 'deepseek' } }

test('relay (-vision twin) member: real image still attached, but its line carries the description and the rules explain the text-marker case', () => {
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: [imgMsg], vision: true, visionRelay: true, attachmentMeta: meta })
  const txt = JSON.stringify(p.messages)
  assert.deepEqual(p.realImages, ['a94d9e77d04e4'])
  assert.match(txt, /attached below; in case it reaches you only as a text marker, description by deepseek: A chat screenshot/)
  assert.match(p.system, /only as a text marker/)
  assert.match(p.system, /view_attachment\("a…", question\)/)
  // 原生识图成员不变
  const n = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: [imgMsg], vision: true, attachmentMeta: meta })
  assert.doesNotMatch(JSON.stringify(n.messages), /text marker/)
  assert.match(n.system, /You can see the recent pictures/)
})

test('view_attachment: relay member gets image + description + answer to its question; text-only member can ask too', async () => {
  const dir = await tmp()
  try {
    const st = createAttachmentStore((id) => join(dir, id), { getAttachmentService: () => fakeImages() })
    const calls = []
    const describe = async (roomId, m, o) => {
      calls.push(o?.question || 'describe')
      if (o?.question) return { text: '红框写着「你的账号已被封禁」。', by: 'deepseek' }
      await st.update(roomId, m.id, { description: 'a red notice', describedBy: 'deepseek' })
      return { text: 'a red notice', by: 'deepseek' }
    }
    const tools = createAttachmentTools({ store: st, describe })
    const img = await st.save('r', { data: PNG, name: 'p.png', mediaType: 'image/png' })
    const r = await tools.run('r', 'view_attachment', { id: img.id, question: '红框里写了什么？' }, { vision: true, seat: { provider: 'claude-vision' } })
    assert.equal(r.images.length, 1)
    assert.match(r.modelText, /Text description \(written by deepseek\): a red notice/)
    assert.match(r.modelText, /Answer to "红框里写了什么？" \(from deepseek, who looked at it\): 红框写着「你的账号已被封禁」。/)
    assert.deepEqual(calls, ['describe', '红框里写了什么？'])
    const t = await tools.run('r', 'view_attachment', { id: img.id, question: '有几行字？' }, { vision: false, seat: { provider: 'claude' } })
    assert.equal(t.images, undefined)
    assert.match(t.modelText, /Answer to "有几行字？"/)
    assert.match(t.modelText, /their description, not something you saw yourself/)
    // 原生识图成员不提问时不额外调用
    calls.length = 0
    await tools.run('r', 'view_attachment', { id: img.id }, { vision: true, seat: { provider: 'google' } })
    assert.deepEqual(calls, [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('feature: ask path goes to a vision-capable member with the real image; relay seats trigger room descriptions', async () => {
  const dir = await tmp()
  const llm = {
    listProviders: () => [{ id: 'claude-vision' }, { id: 'deepseek' }],
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, inputModalities: ['text', 'image'] }),
    stream: () => { throw new Error('not used') },
  }
  const asked = []
  const cfg = { chatroomEnabled: true, chatroomOwnerTelegramId: '1', chatroomSeats: [{ id: 'cl', name: 'Claude', provider: 'claude-vision', model: 'claude-sonnet-5-5' }, { id: 'ds', name: 'deepseek', provider: 'deepseek', model: 'deepseek-flash' }] }
  const feat = createChatroomFeature(null, () => cfg, {
    dir, llm, presets: null, attachmentService: fakeImages(), tools: { schemas: () => [], get: () => undefined },
    call: async (o) => { asked.push({ seat: o.seat.name, images: o.prompt.messages.flatMap((m) => m.images || []).length, q: o.prompt.messages[0].content }); return { text: /asks:/.test(o.prompt.messages[0].content) ? '写着封禁。' : 'A red notice.', usage: {} } },
  })
  try {
    const s = resolveSeats(cfg)
    const room = await feat.store.createRoom({ title: 'vr' })
    const m = await feat.attachments.save(room.id, { data: PNG, name: 'p.png', mediaType: 'image/png' })
    const r = await feat.toolkit.run(room.id, tc('c1', 'view_attachment', { id: m.id, question: '写了什么' }), { owner: true, seat: s[0], vision: true })
    assert.match(r.modelText, /Answer to "写了什么" \(from deepseek, who looked at it\): 写着封禁。/)
    assert.ok(asked.every((x) => x.seat === 'deepseek' && x.images === 1)) // 原生路由优先于 -vision 孪生路由
    const saved = await feat.attachments.get(room.id, m.id)
    assert.equal(saved.description, 'A red notice.') // 描述写回；提问不写回
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true }) }
})

test("tool framing: fetching from the world's console; cards are answer sheets; failures stay 'blank'", () => {
  const p = buildPrompt({ seat: seats[1], seats, userName: 'Shiro', messages: [], toolsInfo: { owner: true, finder: true, attachments: true } })
  assert.match(p.system, /Using a tool means fetching something from the world's console; every fetch leaves a card in the chat: an answer sheet the world handed back/)
  assert.match(p.system, /A blank sheet just means that fetch didn't work/)
  assert.match(OPEN_CARD.description, /fetch from the world's console/)
  assert.match(FIND_TOOLS.description, /world's console/)
})

test('room rules: no habitual stage-direction openers, home-not-meeting, casual roster header', async () => {
  const { roomRules } = await import('./transcript.mjs')
  const seats = [{ id: 'a', name: 'GPT', talents: '汇总意见', leader: true }, { id: 'b', name: 'Claude' }]
  const s = roomRules({ seat: seats[1], seats, userName: 'Shiro', rules: '' })
  assert.match(s, /Most messages need no \(action\)\. Don't open with a stage direction by habit, and never reuse a gesture you or others used in the last few messages\./)
  assert.match(s, /This is home, not a meeting: unless someone actually asks, don't weigh evidence, fact-check casual remarks, or sum things up — react, joke, tease\./)
  assert.match(s, /Who's home \(what people are good at matters when there's real work; in casual chat everyone just chats\):/)
  assert.ok(!/go easy on the ones they rarely join/.test(s))
})
