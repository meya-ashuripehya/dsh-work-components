import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  ATTACH_MAX_BYTES, IMAGE_WINDOW, checkSize, oversizeNotice, kindOf, createAttachmentStore, planImageWindow, attachmentLine,
  telegramFilesOf, hasTelegramContent, createMediaGroupBuffer, snapshotOf,
} from './attachments.mjs'
import { buildTranscribeRequest, transcribeAudio, resolveGeminiKey, geminiKeyRefs, parseTranscript, redact, transcriptionConfig, TRANSCRIBE_KEY_REF } from './transcribe.mjs'
import { createAttachmentTools, loadLocalForSend, ATTACHMENT_TOOL_NAMES } from './attachment-tools.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createTelegramBots } from './telegram-bots.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { toLlmMessages } from './providers.mjs'
import { listCatalog } from './tool-selector.mjs'
import { createChatroomFeature } from './index.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-att-'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082', 'hex')
const fakeImages = () => {
  const saved = []
  return { saved, saveImage: async ({ data, mediaType, name }) => { saved.push(name); return { attachmentId: `sha256:${saved.length}`, mediaType, bytes: data.length, width: 1, height: 1 } } }
}
const imgMsg = (i, speaker = { id: 'user', name: 'Shiro' }, kind = 'user') => ({
  seq: i, kind, speaker, status: 'ok', ts: '2026-10-15T01:00:00Z', text: `图 ${i}`,
  attachments: [{ id: `a${String(i).padStart(12, '0')}`, kind: 'image', name: `p${i}.png`, mediaType: 'image/png', bytes: 10, ref: { attachmentId: `sha256:${i}`, mediaType: 'image/png', bytes: 10, width: 1, height: 1 } }],
})
const seatsOf = (list) => resolveSeats({ chatroomSeats: list })

// ── 大小上限 ──
test('size limit: 25 MB per attachment, formal Chinese notice, store rejects with TOO_LARGE', async () => {
  assert.equal(ATTACH_MAX_BYTES, 25 * 1024 * 1024)
  assert.equal(checkSize('a.zip', ATTACH_MAX_BYTES), null)
  const n = checkSize('大文件.zip', ATTACH_MAX_BYTES + 1)
  assert.match(n, /^附件「大文件\.zip」大小为 25\.0 MB，超过单个附件 25 MB 的上限，未予接收。/)
  assert.equal(oversizeNotice('x', 0), '附件「x」超过单个附件 25 MB 的上限，未予接收。请压缩或拆分后重新发送。')
  const dir = await tmp()
  try {
    const st = createAttachmentStore((id) => join(dir, id), { getAttachmentService: () => fakeImages() })
    await assert.rejects(st.save('r1', { data: Buffer.alloc(ATTACH_MAX_BYTES + 1), name: 'big.bin' }), (e) => e.code === 'TOO_LARGE' && e.status === 413 && /未予接收/.test(e.notice))
    await assert.rejects(st.save('r1', { data: Buffer.alloc(0), name: 'empty.txt' }), /空文件/)
    // 正常保存 + 去重 + 图片得到 DSH 附件引用
    const a = await st.save('r1', { data: PNG, name: 'p.png', mediaType: 'image/png' })
    assert.match(a.id, /^a[0-9a-f]{12}$/); assert.equal(a.kind, 'image'); assert.equal(a.ref.attachmentId, 'sha256:1')
    const b = await st.save('r1', { data: PNG, name: 'again.png', mediaType: 'image/png' })
    assert.equal(b.id, a.id); assert.equal(b.dedupe, true)
    const t = await st.save('r1', { data: Buffer.from('line1\nline2 needle\nline3'), name: '笔记.txt' })
    assert.equal(t.kind, 'file')
    const page = await st.readText('r1', t.id, { grep: 'needle' })
    assert.equal(page.ok, true); assert.match(page.text, /needle/)
    assert.equal((await st.readText('r1', a.id)).ok, false)
    assert.equal(kindOf('image/svg+xml'), 'file')
    assert.equal(kindOf('audio/ogg'), 'audio')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('local send path: rejects URLs, relative paths and files over 25 MB', async () => {
  const dir = await tmp()
  try {
    await assert.rejects(loadLocalForSend('https://example.com/a.png'), /不支持网址/)
    await assert.rejects(loadLocalForSend('relative/a.png'), /绝对路径/)
    const big = join(dir, 'big.bin')
    await writeFile(big, '')
    await truncate(big, ATTACH_MAX_BYTES + 1)
    await assert.rejects(loadLocalForSend(big), (e) => e.code === 'TOO_LARGE')
    const ok = join(dir, 'ok.png')
    await writeFile(ok, PNG)
    const f = await loadLocalForSend(ok)
    assert.equal(f.name, 'ok.png'); assert.equal(f.mediaType, 'image/png'); assert.equal(f.data.length, PNG.length)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── 9 张窗口与占位 ──
test('image window: latest 9 real images for vision seats, stubs for older ones and for non-vision seats', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => imgMsg(i + 1))
  const win = planImageWindow(msgs)
  assert.equal(IMAGE_WINDOW, 9)
  assert.deepEqual([...win], msgs.slice(3).map((m) => m.attachments[0].id))
  assert.equal(planImageWindow(msgs, { max: 20 }).size, 9)
  assert.equal(planImageWindow(msgs, { max: 0 }).size, 0)

  const seats = seatsOf([{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm' }])
  const p = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, vision: true, toolsInfo: { owner: true, attachments: true } })
  const images = p.messages.flatMap((m) => m.images || [])
  assert.equal(images.length, 9)
  assert.equal(p.realImages.length, 9)
  const text = p.messages.map((m) => m.content).join('\n')
  assert.match(text, /\[image #a000000000001 p1\.png.*older image, not attached; call view_attachment\("a000000000001"\)/)
  assert.match(text, /\[image #a000000000012 p12\.png .*attached below\]/)
  assert.match(p.system, /view_attachment/)
  // 少给几张（工具循环取回了图片时）
  assert.equal(buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, vision: true, imageWindow: 4 }).messages.flatMap((m) => m.images || []).length, 4)
  // 非视觉成员：只有占位
  const np = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: msgs, vision: false, attachmentMeta: { a000000000012: { description: 'a red cat' } } })
  assert.equal(np.messages.flatMap((m) => m.images || []).length, 0)
  const nt = np.messages.map((m) => m.content).join('\n')
  assert.match(nt, /\[image #a000000000012 p12\.png 1x1, from Shiro, .*; description by someone who saw it: a red cat\] \(you can't see it; that's their description\)/)
  assert.match(np.system, /Pictures don't reach you here/); assert.ok(!/never(?! reuse a gesture)|CANNOT/.test(np.system)) // the tone rule's "never reuse a gesture" is not about pictures
  // 自己发出的图片不占真图名额，只在 assistant 文字里
  const own = [imgMsg(1), imgMsg(2, { id: 'ds', name: 'DeepSeek' }, 'seat')]
  const op = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages: own, vision: true })
  assert.deepEqual(op.realImages, ['a000000000001'])
  assert.equal(op.messages.find((m) => m.role === 'assistant').images, undefined)
  // 文件 / 音频占位
  assert.match(attachmentLine({ id: 'a1234567890ab', kind: 'file', name: 'r.pdf', bytes: 2048, mediaType: 'application/pdf' }), /\[file #a1234567890ab r\.pdf 2\.0 KB \(application\/pdf\)\] \(call read_attachment\("a1234567890ab"\)/)
  assert.match(attachmentLine({ id: 'a1234567890ab', kind: 'audio', name: 'v.ogg', bytes: 10, transcript: 'x' }), /transcript is in the message text; original audio kept/)
})

test('image blocks: user images and view_attachment results; tool results stay role tool', () => {
  const seat = { provider: 'deepseek', model: 'deepseek-v4-pro' }
  const ref = { attachmentId: 'sha256:1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
  const out = toLlmMessages(seat, [
    { role: 'user', content: '[Shiro] 看图', images: [{ id: 'a000000000001', ref }] },
    { role: 'assistant', blocks: [{ type: 'reasoning', text: 'think' }, { type: 'tool-call', id: 'c1', name: 'view_attachment', arguments: '{}' }], replayState: { sig: 1 } },
    { role: 'user', toolResult: { toolCallId: 'c1', text: '#a000000000001 (attached below)', isError: false, images: [{ id: 'a000000000001', ref }] } },
    { role: 'user', content: '纯文字' },
  ])
  assert.deepEqual(out[0].content.map((b) => b.type), ['text', 'text', 'image'])
  assert.equal(out[0].content[1].text, '(image #a000000000001)')
  assert.deepEqual(out[0].content[2].attachment, { attachmentId: 'sha256:1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 })
  assert.equal(out[1].role, 'assistant'); assert.deepEqual(out[1].source.replayState, { sig: 1 })
  assert.equal(out[2].role, 'tool'); assert.equal(out[2].toolCallId, 'c1')
  assert.deepEqual(out[2].content.map((b) => b.type), ['text', 'image'])
  assert.deepEqual(out[3].content, [{ type: 'text', text: '纯文字' }])
})

// ── Telegram 入站映射 ──
test('telegram file mapping: photo / document / voice / audio / video_note / video / animation / sticker', () => {
  const f = (m) => telegramFilesOf({ message_id: 7, ...m })
  const photo = f({ photo: [{ file_id: 's', file_size: 100, width: 90, height: 90 }, { file_id: 'L', file_size: 9000, width: 1280, height: 960 }], caption: '看' })
  assert.deepEqual(photo.map((x) => `${x.fileId}:${x.kind}:${x.name}:${x.mediaType}`), ['L:image:photo-7.jpg:image/jpeg'])
  assert.deepEqual(f({ document: { file_id: 'd', file_name: 'r.pdf', mime_type: 'application/pdf', file_size: 5 } }).map((x) => `${x.kind}:${x.name}:${!!x.transcribe}`), ['file:r.pdf:false'])
  assert.deepEqual(f({ document: { file_id: 'd', file_name: 'rec.m4a', mime_type: 'audio/m4a' } }).map((x) => `${x.kind}:${!!x.transcribe}`), ['audio:true'])
  assert.deepEqual(f({ voice: { file_id: 'v', mime_type: 'audio/ogg', duration: 3, file_size: 10 } }).map((x) => `${x.kind}:${x.name}:${x.voice}:${x.transcribe}`), ['audio:voice-7.ogg:true:true'])
  assert.deepEqual(f({ audio: { file_id: 'au', file_name: 'song.mp3', mime_type: 'audio/mpeg' } }).map((x) => `${x.kind}:${x.name}:${x.transcribe}`), ['audio:song.mp3:true'])
  assert.deepEqual(f({ video_note: { file_id: 'vn', duration: 5 } }).map((x) => `${x.kind}:${x.name}`), ['video:video-note-7.mp4'])
  assert.deepEqual(f({ video: { file_id: 'vi', mime_type: 'video/mp4' } }).map((x) => `${x.kind}:${x.name}`), ['video:video-7.mp4'])
  // animation 同时带 document：只算一个
  assert.equal(f({ animation: { file_id: 'an', mime_type: 'video/mp4' }, document: { file_id: 'an', mime_type: 'video/mp4', file_name: 'a.mp4' } }).length, 1)
  assert.deepEqual(f({ sticker: { file_id: 'st', emoji: '😀' } }).map((x) => `${x.kind}:${x.mediaType}`), ['image:image/webp'])
  assert.deepEqual(f({ sticker: { file_id: 'st', is_animated: true } }).map((x) => `${x.kind}:${x.name}`), ['file:sticker-7.tgs'])
  assert.equal(hasTelegramContent({ voice: { file_id: 'v' } }), true)
  assert.equal(hasTelegramContent({ new_chat_members: [] }), false)
})

test('telegram intake: file-only messages reach onInbound with files and a download via the receiving bot; captions are not commands', async () => {
  const token = '111:aaaaaaaaaaaaaaaaaaaaaaaa'
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(url.replace(token, '<T>'))
    if (url.endsWith('/getMe')) return { ok: true, json: async () => ({ ok: true, result: { id: 111, username: 'ds_bot' } }) }
    if (url.endsWith('/getFile')) { const b = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, result: { file_id: b.file_id, file_size: 3, file_path: 'voice/file_1.oga' } }) } }
    if (url.includes('/file/bot')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
    return { ok: true, json: async () => ({ ok: true, result: {} }) }
  }
  const seats = seatsOf([{ id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'T' } }])
  const inbound = []
  const cmds = []
  const bots = createTelegramBots({ resolveToken: async () => token, getSeats: () => seats, fetchImpl, onInbound: (u) => inbound.push(u), onCommand: (c) => cmds.push(c) })
  bots.setBound(() => new Set(['-1001']))
  const g = { id: -1001, type: 'supergroup', title: 'G' }
  await bots.handleUpdate({ update_id: 1, message: { message_id: 1, chat: g, from: { id: 9000000001, first_name: 'Shiro' }, voice: { file_id: 'VOICE', mime_type: 'audio/ogg', file_size: 3 } } })
  await bots.handleUpdate({ update_id: 2, message: { message_id: 2, chat: g, from: { id: 5, first_name: 'X' }, caption: '/bind 房间', photo: [{ file_id: 'P', file_size: 3 }], media_group_id: 'mg1' } })
  await bots.handleUpdate({ update_id: 3, edited_message: { message_id: 1, edit_date: 9, chat: g, from: { id: 5 }, caption: '改了说明', voice: { file_id: 'VOICE' } } })
  assert.equal(cmds.length, 0)
  assert.equal(inbound.length, 3)
  assert.equal(inbound[0].text, ''); assert.deepEqual(inbound[0].files.map((f) => `${f.fileId}:${f.kind}`), ['VOICE:audio'])
  assert.equal(inbound[1].mediaGroupId, 'mg1'); assert.equal(inbound[1].text, '/bind 房间')
  assert.deepEqual(inbound[2].files, []); assert.equal(inbound[2].text, '改了说明')
  const dl = await inbound[0].download('VOICE', ATTACH_MAX_BYTES)
  assert.deepEqual([...dl.data], [1, 2, 3])
  assert.ok(calls.includes('https://api.telegram.org/file/bot<T>/voice/file_1.oga'))
  await assert.rejects(inbound[0].download('VOICE', 2), (e) => e.code === 'TOO_LARGE')
})

test('media group buffer merges an album into one flush', async () => {
  const flushed = []
  const timers = []
  const buf = createMediaGroupBuffer({ flush: (g) => flushed.push(g), setTimer: (fn) => { timers.push(fn); return timers.length }, clearTimer: () => {} })
  buf.add('c:1', { text: 'a' }); buf.add('c:1', { text: '' }); buf.add('c:2', { text: 'x' })
  assert.equal(buf.pending(), 2)
  timers[1](); timers[2]()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(flushed.map((g) => `${g.key}:${g.items.length}`), ['c:1:2', 'c:2:1'])
})

// ── 转写请求（模拟 fetch，不联网） ──
const GKEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKE00000'
test('transcription request: model URL, key only in header, inline audio, transcription config', () => {
  const { url, init } = buildTranscribeRequest({ apiKey: GKEY, data: Buffer.from('abc'), mediaType: 'audio/x-wav', mode: 'VERBATIM', languages: 'cmn-Hans-CN, ja-JP' })
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent')
  assert.ok(!url.includes(GKEY))
  assert.equal(init.method, 'POST'); assert.equal(init.headers['x-goog-api-key'], GKEY)
  const body = JSON.parse(init.body)
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'audio/wav', data: Buffer.from('abc').toString('base64') } })
  assert.deepEqual(body.generationConfig.audioTranscriptionConfig, { languageCodes: ['cmn-Hans-CN', 'ja-JP'], mode: 'VERBATIM' })
  assert.deepEqual(transcriptionConfig({}), { mode: 'SMART' })
  const f = buildTranscribeRequest({ apiKey: GKEY, fileUri: 'https://x/files/1', mediaType: 'audio/ogg', model: 'gemini-x' })
  assert.match(f.url, /models\/gemini-x:generateContent$/)
  assert.deepEqual(JSON.parse(f.init.body).contents[0].parts[0], { fileData: { fileUri: 'https://x/files/1', mimeType: 'audio/ogg' } })
  assert.equal(parseTranscript({ candidates: [{ content: { parts: [{ audioTranscription: { speakerLabel: 'A', words: [{ word: 'hi' }, { word: 'there' }] } }] } }] }), '[A] hi there')
  assert.equal(redact(`bad key ${GKEY} ?key=${GKEY}`, GKEY), 'bad key *** ?key=***')
})

test('transcribeAudio: inline vs Files API upload, errors redacted', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    if (url.endsWith('/upload/v1beta/files')) return { ok: true, headers: { get: (h) => (h === 'x-goog-upload-url' ? 'https://upload.example/u1' : null) }, json: async () => ({}) }
    if (url === 'https://upload.example/u1') return { ok: true, json: async () => ({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/f1', name: 'files/f1', state: 'ACTIVE', mimeType: 'audio/ogg' } }) }
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: ' 你好，世界 ' }] } }] }) }
  }
  const a = await transcribeAudio({ fetchImpl, apiKey: GKEY, data: Buffer.from('ogg'), mediaType: 'audio/ogg', name: 'v.ogg' })
  assert.deepEqual(a, { ok: true, text: '你好，世界' })
  assert.equal(seen.length, 1)
  assert.ok(JSON.parse(seen[0].init.body).contents[0].parts[0].inlineData)
  seen.length = 0
  const b = await transcribeAudio({ fetchImpl, apiKey: GKEY, data: Buffer.alloc(100), mediaType: 'audio/ogg', name: 'v.ogg', inlineMax: 10 })
  assert.equal(b.ok, true)
  assert.deepEqual(seen.map((s) => s.url), ['https://generativelanguage.googleapis.com/upload/v1beta/files', 'https://upload.example/u1', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent'])
  assert.equal(JSON.parse(seen[2].init.body).contents[0].parts[0].fileData.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/f1')
  const bad = await transcribeAudio({ fetchImpl: async () => { throw new Error(`connect failed for key=${GKEY}`) }, apiKey: GKEY, data: Buffer.from('x'), mediaType: 'audio/ogg' })
  assert.equal(bad.ok, false); assert.ok(!bad.error.includes(GKEY))
  const http = await transcribeAudio({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) }), apiKey: GKEY, data: Buffer.from('x'), mediaType: 'audio/ogg' })
  assert.deepEqual(http, { ok: false, error: 'Gemini 转写请求失败：API key not valid' })
  assert.equal((await transcribeAudio({ fetchImpl, apiKey: '', data: Buffer.from('x') })).ok, false)
})

test('gemini key: setting first, then the Gemini seat provider, then name match; problem text when none', async () => {
  const seats = seatsOf([{ id: 'gem', name: 'Gemini', provider: 'google', model: 'gemini-3-pro' }, { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'm' }])
  assert.deepEqual(geminiKeyRefs({ seats, providerKeyRef: () => 'MY_GOOGLE_REF' }).refs.map((r) => r.ref), [TRANSCRIBE_KEY_REF, 'MY_GOOGLE_REF', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'])
  const vault = { GOOGLE_API_KEY: 'g-key-value-123', [TRANSCRIBE_KEY_REF]: 'setting-key-123' }
  const r1 = await resolveGeminiKey({ seats, resolve: async (ref) => vault[ref] })
  assert.equal(r1.ref, TRANSCRIBE_KEY_REF); assert.equal(r1.via, 'setting')
  delete vault[TRANSCRIBE_KEY_REF]
  const r2 = await resolveGeminiKey({ seats, resolve: async (ref) => vault[ref] })
  assert.equal(r2.key, 'g-key-value-123'); assert.equal(r2.ref, 'GOOGLE_API_KEY'); assert.equal(r2.seat, 'Gemini')
  const r3 = await resolveGeminiKey({ seats: [], resolve: async () => undefined })
  assert.equal(r3.key, ''); assert.match(r3.problem, /未找到 Gemini API 密钥/)
})

// ── 出站：send_attachment ──
test('attachment tools: view / read / send (attachment id or local path), unknown ids', async () => {
  const dir = await tmp()
  try {
    const st = createAttachmentStore((id) => join(dir, id), { getAttachmentService: () => fakeImages() })
    const tools = createAttachmentTools({ store: st })
    const img = await st.save('r', { data: PNG, name: 'p.png', mediaType: 'image/png' })
    const v = await tools.run('r', 'view_attachment', { id: img.id }, { vision: true })
    assert.equal(v.isError, false); assert.equal(v.images[0].ref.attachmentId, 'sha256:1')
    const nv = await tools.run('r', 'view_attachment', { id: img.id }, { vision: false })
    assert.equal(nv.images, undefined); assert.match(nv.modelText, /pictures don't reach you/); assert.match(nv.modelText, /No description yet/)
    assert.equal((await tools.run('r', 'view_attachment', { id: 'a0000000000ff' }, { vision: true })).isError, true)
    const s1 = await tools.run('r', 'send_attachment', { source: '#' + img.id, caption: '给大家看' }, { seat: { name: 'GPT' } })
    assert.equal(s1.isError, false); assert.equal(s1.post.text, '给大家看'); assert.equal(s1.post.attachments[0].id, img.id)
    const local = join(dir, 'report.txt')
    await writeFile(local, 'hello')
    const s2 = await tools.run('r', 'send_attachment', { source: local }, { seat: { name: 'GPT' } })
    assert.equal(s2.isError, false); assert.equal(s2.post.attachments[0].name, 'report.txt')
    assert.equal((await st.get('r', s2.post.attachments[0].id)).from, 'GPT')
    assert.equal((await tools.run('r', 'send_attachment', { source: 'https://evil/x' }, {})).isError, true)
    const big = join(dir, 'big.bin'); await writeFile(big, ''); await truncate(big, ATTACH_MAX_BYTES + 5)
    const s3 = await tools.run('r', 'send_attachment', { source: big }, {})
    assert.equal(s3.isError, true); assert.match(s3.modelText, /超过单个附件 25 MB 的上限/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('telegram sendAttachments: own bot when it is in the group, otherwise the intake bot with a name prefix', async () => {
  const tokens = { TD: '111:aaaaaaaaaaaaaaaaaaaaaaaa', TG: '222:bbbbbbbbbbbbbbbbbbbbbbbb' }
  const sent = []
  const memberOf = { '-1001': true, '-1002': false }
  const fetchImpl = async (url, init) => {
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(url)
    const who = token === tokens.TD ? 'intake' : 'gpt'
    if (method === 'getChatMember') { const b = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, result: { status: memberOf[b.chat_id] ? 'member' : 'left' } }) } }
    if (method === 'sendPhoto' || method === 'sendDocument') {
      const form = init.body
      sent.push(`${who}:${method}:${form.get('chat_id')}:${form.get('caption') || ''}:${form.get(method === 'sendPhoto' ? 'photo' : 'document').name}`)
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) }
  }
  const seats = seatsOf([{ id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'TD' } }, { id: 'gpt', name: 'GPT', telegram: { tokenRef: 'TG' } }, { id: 'cl', name: 'Claude' }])
  const bots = createTelegramBots({ resolveToken: async (r) => tokens[r], getSeats: () => seats, fetchImpl, onInbound: () => {} })
  const files = [{ data: PNG, name: 'p.png', mediaType: 'image/png', kind: 'image' }, { data: Buffer.from('x'), name: 'r.txt', mediaType: 'text/plain', kind: 'file' }]
  const r = await bots.sendAttachments(seats[1], ['-1001', '-1002'], files, { caption: '结果', prefixName: 'GPT' })
  assert.deepEqual(r.map((x) => `${x.chatId}:${x.ok}:${x.via}`), ['-1001:true:own', '-1002:true:intake'])
  assert.deepEqual(sent, [
    'gpt:sendPhoto:-1001:结果:p.png', 'gpt:sendDocument:-1001::r.txt',
    'intake:sendPhoto:-1002:[GPT] 结果:p.png', 'intake:sendDocument:-1002::r.txt',
  ])
  sent.length = 0
  await bots.sendAttachments(seats[2], ['-1001'], files.slice(1), { prefixName: 'Claude' })
  assert.deepEqual(sent, ['intake:sendDocument:-1001:[Claude]:r.txt'])
})

function toolSetup(dir, { script, vision = false, tg }) {
  const store = createStore(dir)
  const seats = seatsOf([{ id: 'gpt', name: 'GPT', provider: 'openai', model: 'gpt-x' }])
  const attachments = createAttachmentStore((id) => join(dir, 'rooms', id), { getAttachmentService: () => fakeImages() })
  const toolkit = createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [] }), getLlm: () => null,
    getSettings: () => ({ enabled: false }), providers: async () => ({ available: false, providers: [] }), attachments,
  })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(o) : step }
  const cfg = { seats, userName: 'Shiro', budget: 3, maxTokens: 100, ownerId: '9000000001', defaultMain: 'gpt', tools: { enabled: false }, attachments: { enabled: true } }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, isVision: async () => vision })
  return { store, moderator, calls, attachments, toolkit }
}
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })

test('outbound: send_attachment in a non-owner Telegram turn posts to the room and relays to the group', async () => {
  const dir = await tmp()
  try {
    const relayed = []
    const tg = { typing: () => () => {}, relay: async () => [], relayAttachments: async (seat, roomId, msg) => { relayed.push(`${seat?.id}:${msg.text}:${msg.attachments.map((a) => a.name).join(',')}`); return [{ chatId: '-1001', ok: true, via: 'intake' }] } }
    const local = join(dir, 'chart.png')
    await writeFile(local, PNG)
    const { store, moderator, calls } = toolSetup(dir, {
      tg,
      script: [
        (o) => { assert.deepEqual(o.tools.map((t) => t.name).sort(), [...ATTACHMENT_TOOL_NAMES].filter((n) => n !== 'watch_video' /* 没有视频路由的工具集不提供 */).concat(['set_leader', 'set_main_answerer', 'end_round', 'sweep_cards', 'list_bin', 'restore_card']).sort()); assert.ok(!o.tools.some((t) => t.name === 'find_tools')); return { text: '', toolCalls: [tc('c1', 'send_attachment', { source: local, caption: '图表' })], usage: {} } },
        (o) => { const last = o.prompt.messages.at(-1); assert.match(last.toolResult.text, /已发送 #a[0-9a-f]{12} chart\.png/); assert.match(last.toolResult.text, /已写入房间；Telegram：1 个群发送成功/); assert.equal(relayed.length, 1); return { text: '发好了。', toolCalls: [], usage: {} } },
      ],
    })
    const room = await store.createRoom({ title: '中转站' })
    const out = await moderator.post(room.id, '把图表发群里', { owner: false, source: 'telegram', fromId: '5', userName: 'X' })
    await out.promise
    assert.equal(calls.length, 2)
    assert.ok(!/budget|send_attachment/i.test(calls[0].prompt.system)) // 工具说明在工具描述里，规则不提预算
    const msgs = await store.readMessages(room.id)
    const sentMsg = msgs.find((m) => m.via === 'send_attachment')
    assert.equal(sentMsg.kind, 'seat'); assert.equal(sentMsg.text, '图表'); assert.equal(sentMsg.attachments[0].name, 'chart.png')
    assert.deepEqual(relayed, ['gpt:图表:chart.png'])
    assert.equal(msgs.filter((m) => m.kind === 'seat' && m.status === 'ok').pop().text, '发好了。')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('vision turn: view_attachment returns a real image as a role-tool block and the total stays within 9 images', async () => {
  const dir = await tmp()
  try {
    let ids = []
    const { store, moderator, calls, attachments } = toolSetup(dir, {
      vision: true,
      script: [
        (o) => { assert.equal(o.prompt.messages.flatMap((m) => m.images || []).length, 9); return { text: '', toolCalls: [tc('c1', 'view_attachment', { id: ids[0] })], usage: {} } },
        (o) => {
          const hist = o.prompt.messages.filter((m) => !m.toolResult).flatMap((m) => m.images || []).length
          const viewed = o.prompt.messages.filter((m) => m.toolResult).flatMap((m) => m.toolResult.images || []).length
          assert.equal(viewed, 1); assert.equal(hist, 8)
          const llm = toLlmMessages({ provider: 'openai', model: 'gpt-x' }, o.prompt.messages)
          const tool = llm.find((m) => m.role === 'tool')
          assert.deepEqual(tool.content.map((b) => b.type), ['text', 'image'])
          return { text: '第一张是红色的。', toolCalls: [], usage: {} }
        },
      ],
    })
    const room = await store.createRoom({ title: '图' })
    for (let i = 0; i < 11; i++) {
      const buf = Buffer.concat([PNG, Buffer.from([i])])
      const meta = await attachments.save(room.id, { data: buf, name: `p${i}.png`, mediaType: 'image/png' })
      ids.push(meta.id)
      await store.append(room.id, { kind: 'user', speaker: { id: 'user', name: 'Shiro' }, owner: true, source: 'local', text: '', attachments: [snapshotOf(meta)] })
    }
    const out = await moderator.post(room.id, '第一张是什么颜色？', { owner: true, source: 'local' })
    await out.promise
    assert.equal(calls.length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── 功能层：上传 / 超限提示 / Telegram 语音转写 ──
test('feature: desktop upload, over-limit notice, Telegram voice transcribed into the message text, oversize Telegram file noticed via the intake bot', async () => {
  const dir = await tmp()
  const replies = []
  const gem = []
  const cfg = { chatroomEnabled: true, chatroomOwnerTelegramId: '9000000001', chatroomSeats: [] }
  const feat = createChatroomFeature(null, () => cfg, {
    dir, llm: null, presets: null, attachmentService: fakeImages(),
    credentials: { resolve: async (ref) => (ref === 'GOOGLE_API_KEY' ? GKEY : undefined), set: async () => {} },
    geminiFetch: async (url, init) => { gem.push({ url, key: init.headers['x-goog-api-key'] }); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '今晚八点开会' }] } }] }) } },
    isVision: async () => false,
  })
  feat.bots.reply = async (chatId, text) => { replies.push([chatId, text]); return true }
  const api = async (method, sub, { body, raw, headers = {} } = {}) => {
    let status, json
    const req = raw ? Object.assign(Readable.from([raw]), { method, headers, url: sub }) : { method, headers, url: sub, on() {} }
    await feat.handleApi(req, { writeHead() {}, write() {}, end() {}, on() {} }, sub, { sendJson: (_, s, j) => { status = s; json = j }, readBody: async () => JSON.stringify(body || {}) })
    return { status, json }
  }
  try {
    const room = await feat.store.createRoom({ title: '中转站' })
    const up = await api('POST', `/chatroom/rooms/${room.id}/attachments`, { raw: PNG, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('截图.png'), 'content-length': String(PNG.length) } })
    assert.equal(up.status, 200); assert.equal(up.json.attachment.name, '截图.png'); assert.equal(up.json.attachment.kind, 'image')
    const big = await api('POST', `/chatroom/rooms/${room.id}/attachments`, { raw: Buffer.from('x'), headers: { 'x-file-name': 'big.zip', 'content-length': String(ATTACH_MAX_BYTES + 1) } })
    assert.equal(big.status, 413); assert.match(big.json.error, /超过单个附件 25 MB 的上限/)
    const rej = await api('POST', `/chatroom/rooms/${room.id}/attachments/rejected`, { body: { name: '视频.mp4', bytes: 30 * 1024 * 1024 } })
    assert.match(rej.json.notice, /^附件「视频\.mp4」大小为 30\.0 MB/)
    const att = await api('GET', '/chatroom/attach')
    assert.equal(att.json.key.ready, true); assert.equal(att.json.key.ref, 'GOOGLE_API_KEY'); assert.ok(!JSON.stringify(att.json).includes(GKEY))

    await feat.telegramInbound(room.id, [{
      chatId: '-1001', fromId: '9000000001', fromName: 'Shiro', text: '',
      files: [{ fileId: 'V', kind: 'audio', name: 'voice-1.ogg', mediaType: 'audio/ogg', size: 3, transcribe: true }, { fileId: 'B', kind: 'video', name: 'huge.mp4', mediaType: 'video/mp4', size: ATTACH_MAX_BYTES + 10 }],
      download: async () => ({ data: Buffer.from('OggS') }),
    }])
    const msgs = await feat.store.readMessages(room.id)
    const voice = msgs.find((m) => m.source === 'telegram')
    assert.equal(voice.text, '今晚八点开会'); assert.equal(voice.owner, true)
    assert.equal(voice.attachments[0].kind, 'audio'); assert.equal(voice.attachments[0].transcript, '今晚八点开会')
    assert.equal(gem.length, 1); assert.equal(gem[0].key, GKEY); assert.ok(!gem[0].url.includes(GKEY))
    const notices = msgs.filter((m) => m.kind === 'system').map((m) => m.text)
    assert.ok(notices.some((t) => /附件「huge\.mp4」.*超过单个附件 25 MB 的上限/.test(t)))
    assert.ok(notices.some((t) => /大文件|big\.zip/.test(t)))
    assert.deepEqual(replies.map((r) => r[0]), ['-1001']); assert.match(replies[0][1], /huge\.mp4/)
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true }) }
})

test('catalog never offers attachment tools to the finder', () => {
  const tools = { schemas: () => [{ name: 'view_attachment' }, { name: 'send_attachment' }, { name: 'read_attachment' }, { name: 'web_search', description: 'w', parameters: { type: 'object' } }] }
  assert.deepEqual(listCatalog(tools).map((t) => t.name), ['web_search'])
})
