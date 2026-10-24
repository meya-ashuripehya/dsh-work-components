import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  videoPart, generateWithVideo, describeVideo, askVideo, mp4Duration, parseOffset, youtubeLink, bilibiliLink, findVideoLinks,
  withRange, watchKey, normalizeVideoMime, REUSE_MIN_MS,
} from './video.mjs'
import { toGeminiContents, fromGeminiResponse, callGeminiSeat, isNativeGeminiSeat, SIGNATURE_PLACEHOLDER } from './gemini-seat.mjs'
import { createYtdlp, ytdlpReason, YTDLP_MISSING } from './ytdlp.mjs'
import { attachmentLine, snapshotOf, createAttachmentStore } from './attachments.mjs'
import { buildPrompt } from './transcript.mjs'
import { resolveSeats } from './seats.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { createChatroomFeature } from './index.mjs'

const KEY = 'AIzaVIDEOFAKEFAKEFAKEFAKEFAKE000000'
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-vid-'))
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000) {
  const t0 = Date.now()
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await settle(15) }
}

/** 最小 MP4：ftyp + moov/mvhd（v0，timescale 1000，时长 seconds 秒）+ 填充。 */
function mp4(seconds = 42, pad = 0) {
  const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16, 0); ftyp.write('ftypisom', 4, 'latin1')
  const mvhd = Buffer.alloc(108); mvhd.writeUInt32BE(108, 0); mvhd.write('mvhd', 4, 'latin1'); mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(seconds * 1000, 24)
  const moov = Buffer.alloc(8); moov.writeUInt32BE(8 + 108, 0); moov.write('moov', 4, 'latin1')
  const free = Buffer.alloc(8 + pad); free.writeUInt32BE(8 + pad, 0); free.write('free', 4, 'latin1')
  return Buffer.concat([ftyp, moov, mvhd, free])
}

/** Gemini 模拟：记录请求；generate(body, n) 决定 generateContent 的响应。 */
function fakeGemini({ generate = () => ({ text: '[0:00] 画面：一只猫。' }), expiresIn = 48 * 3600e3 } = {}) {
  const calls = []
  let uploads = 0
  let gens = 0
  const res = (status, j, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => j })
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, key: init.headers?.['x-goog-api-key'], body, method: init.method })
    if (url.endsWith('/upload/v1beta/files')) return res(200, {}, { 'x-goog-upload-url': `https://upload.example/u${uploads + 1}` })
    if (url.startsWith('https://upload.example/')) { uploads++; return res(200, { file: { uri: `https://gen.example/files/f${uploads}`, name: `files/f${uploads}`, mimeType: 'video/mp4', state: 'ACTIVE', expirationTime: new Date(Date.now() + expiresIn).toISOString() } }) }
    if (url.includes(':generateContent')) {
      const r = generate(body, gens++)
      if (r.status) return res(r.status, r.json || {})
      return res(200, r.json || { candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
    }
    return res(404, { error: { message: 'unexpected ' + url } })
  }
  return { fetchImpl, calls, uploads: () => uploads, gens: () => gens, generates: () => calls.filter((c) => c.url.includes(':generateContent')) }
}

// ── video.mjs ──

test('video: small videos go inline, large ones through Files API; uri reused while > 1h left, re-uploaded otherwise', async () => {
  const small = mp4(5)
  const g = fakeGemini()
  const a = await videoPart({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { name: 'a.mp4', mediaType: 'video/mp4' }, load: async () => small })
  assert.equal(a.via, 'inline'); assert.equal(a.part.inlineData.mimeType, 'video/mp4'); assert.equal(Buffer.from(a.part.inlineData.data, 'base64').length, small.length)
  assert.equal(g.calls.length, 0)

  const big = mp4(5, 200)
  let saved = null
  const b = await videoPart({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { name: 'b.mp4', mediaType: 'video/mp4' }, load: async () => big, saveRemote: async (x) => { saved = x }, inlineMax: 100 })
  assert.equal(b.via, 'file'); assert.equal(b.part.fileData.fileUri, 'https://gen.example/files/f1')
  assert.equal(saved.uri, 'https://gen.example/files/f1'); assert.ok(saved.expiresAt > Date.now() + 47 * 3600e3)
  assert.equal(g.uploads(), 1)
  // 头部只带密钥一次、URL 不含密钥
  assert.ok(g.calls.every((c) => !c.url.includes(KEY)))
  assert.equal(g.calls[0].key, KEY)

  // 剩余 > 1 小时：复用，不读本地、不上传
  let loaded = 0
  const reuse = await videoPart({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { name: 'b.mp4', mediaType: 'video/mp4', gemini: { ...saved, expiresAt: Date.now() + REUSE_MIN_MS + 60000 } }, load: async () => { loaded++; return big }, inlineMax: 100 })
  assert.equal(reuse.part.fileData.fileUri, saved.uri); assert.equal(loaded, 0); assert.equal(g.uploads(), 1)
  // 剩余不足 1 小时：重新上传
  const stale = await videoPart({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { name: 'b.mp4', mediaType: 'video/mp4', gemini: { ...saved, expiresAt: Date.now() + 30 * 60000 } }, load: async () => { loaded++; return big }, inlineMax: 100 })
  assert.equal(stale.part.fileData.fileUri, 'https://gen.example/files/f2'); assert.equal(loaded, 1); assert.equal(g.uploads(), 2)
  // YouTube 链接：直接给 fileUri，不下载
  const yt = await videoPart({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', linkKind: 'youtube' }, load: async () => { throw new Error('no') } })
  assert.deepEqual(yt.part, { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
})

test('video: expired / 404 remote file is re-uploaded once from the local copy; a second failure stops', async () => {
  const big = mp4(5, 200)
  const g = fakeGemini({ generate: (body, n) => (n === 0 ? { status: 404, json: { error: { status: 'NOT_FOUND', message: 'File files/old not found' } } } : { text: '[0:01] 好' }) })
  const writes = []
  const meta = { name: 'b.mp4', mediaType: 'video/mp4', gemini: { uri: 'https://gen.example/files/old', mimeType: 'video/mp4', expiresAt: Date.now() + 10 * 3600e3 } }
  const r = await describeVideo({ fetchImpl: g.fetchImpl, apiKey: KEY, meta, load: async () => big, saveRemote: async (x) => { writes.push(x) }, inlineMax: 100 })
  assert.equal(r.ok, true); assert.equal(r.text, '[0:01] 好')
  assert.equal(g.gens(), 2); assert.equal(g.uploads(), 1)
  assert.deepEqual(writes.map((w) => (w ? w.uri : null)), [null, 'https://gen.example/files/f1'])
  const second = g.generates()[1].body.contents[0].parts[0]
  assert.equal(second.fileData.fileUri, 'https://gen.example/files/f1')

  const g2 = fakeGemini({ generate: () => ({ status: 404, json: { error: { status: 'NOT_FOUND', message: 'gone' } } }) })
  const r2 = await describeVideo({ fetchImpl: g2.fetchImpl, apiKey: KEY, meta, load: async () => big, saveRemote: async () => {}, inlineMax: 100 })
  assert.equal(r2.ok, false); assert.equal(g2.gens(), 2); assert.equal(g2.uploads(), 1)
  // 内联请求失败不重传
  const g3 = fakeGemini({ generate: () => ({ status: 404, json: { error: { status: 'NOT_FOUND', message: 'model not found' } } }) })
  const r3 = await describeVideo({ fetchImpl: g3.fetchImpl, apiKey: KEY, meta: { name: 'a.mp4' }, load: async () => mp4(1) })
  assert.equal(r3.ok, false); assert.equal(g3.gens(), 1)
})

test('video: keys are scrubbed from every error and never put in URLs', async () => {
  const leak = async (url) => { throw new Error(`connect failed ${url}?key=${KEY} using ${KEY}`) }
  const r = await describeVideo({ fetchImpl: leak, apiKey: KEY, meta: { name: 'a.mp4' }, load: async () => mp4(1) })
  assert.equal(r.ok, false); assert.ok(!r.error.includes(KEY)); assert.match(r.error, /\*\*\*/)
  const g = fakeGemini({ generate: () => ({ status: 400, json: { error: { message: `API key ${KEY} invalid` } } }) })
  const r2 = await askVideo({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { name: 'a.mp4' }, load: async () => mp4(1), question: 'q' })
  assert.ok(!r2.error.includes(KEY))
  const seat = { name: 'Gemini', model: 'gemini-3.8-flash', provider: 'google' }
  await assert.rejects(callGeminiSeat({ seat, prompt: { system: 's', messages: [{ role: 'user', content: 'hi' }] }, fetchImpl: g.fetchImpl, apiKey: KEY, resolveMedia: async () => null }), (e) => !String(e.message).includes(KEY))
  assert.ok(g.calls.every((c) => !c.url.includes(KEY)))
})

test('video: time ranges become videoMetadata offsets; offsets parse; links detected', async () => {
  assert.equal(parseOffset('1:05'), 65); assert.equal(parseOffset('90'), 90); assert.equal(parseOffset('90s'), 90); assert.equal(parseOffset('1:02:03'), 3723); assert.equal(parseOffset('1m5s'), 65)
  assert.equal(parseOffset('soon'), null); assert.equal(parseOffset(''), null)
  assert.deepEqual(withRange({ x: 1 }, { start: '1:05', end: 90 }).videoMetadata, { startOffset: '65s', endOffset: '90s' })
  assert.deepEqual(withRange({ x: 1 }, {}), { x: 1 })
  const g = fakeGemini({ generate: () => ({ text: '[1:10] 牌子上写着「出口」' }) })
  const r = await askVideo({ fetchImpl: g.fetchImpl, apiKey: KEY, meta: { name: 'a.mp4' }, load: async () => mp4(100), question: '牌子写什么', start: '1:05', end: '1:30' })
  assert.equal(r.ok, true)
  const parts = g.generates()[0].body.contents[0].parts
  assert.deepEqual(parts[0].videoMetadata, { startOffset: '65s', endOffset: '90s' }); assert.match(parts[1].text, /1:05–1:30/)
  assert.equal(watchKey({ target: 'a1', question: ' 牌子 写什么 ', start: '65' }), watchKey({ target: 'a1', question: '牌子 写什么', start: '1:05' }))
  assert.notEqual(watchKey({ target: 'a1', question: 'q', start: '1' }), watchKey({ target: 'a1', question: 'q' }))

  assert.equal(youtubeLink('https://youtu.be/dQw4w9WgXcQ?t=3').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(youtubeLink('https://m.youtube.com/shorts/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ')
  assert.equal(youtubeLink('https://example.com/watch?v=dQw4w9WgXcQ'), null)
  assert.equal(bilibiliLink('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm=1').url, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2')
  assert.deepEqual(findVideoLinks('看这个 https://youtu.be/dQw4w9WgXcQ，还有 https://www.bilibili.com/video/BV1xx411c7mD 和 https://youtu.be/dQw4w9WgXcQ').map((l) => l.kind), ['youtube', 'bilibili'])
  assert.equal(normalizeVideoMime('video/x-msvideo'), 'video/avi'); assert.equal(normalizeVideoMime('', 'x.mov'), 'video/quicktime')
  assert.equal(mp4Duration(mp4(42)), 42); assert.equal(mp4Duration(Buffer.from('not a video')), 0)
})

test('video: lines for AIs: description / pending / blank sheet (reason stays user-only) / watching it yourself', () => {
  const base = { id: 'a0123456789ab', kind: 'video', name: 'clip.mp4', bytes: 1000, durationSec: 42 }
  assert.match(attachmentLine({ ...base, videoStatus: 'done', description: '[0:00] 一只猫' }), /^\[video #a0123456789ab clip\.mp4 0:42 · 内容描述：\[0:00\] 一只猫\] \(Gemini watched it/)
  assert.match(attachmentLine({ ...base, videoStatus: 'pending' }), /still watching it/)
  const failed = attachmentLine({ ...base, videoStatus: 'failed', videoError: '配额用完 quota exceeded' })
  assert.match(failed, /sheet came back blank/); assert.ok(!failed.includes('quota')); assert.ok(!failed.includes('配额'))
  assert.match(attachmentLine(base), /stored as a file, not viewable/)
  assert.match(attachmentLine({ ...base }, { mode: 'real' }), /attached below; you are watching it yourself/)
  const snap = snapshotOf({ ...base, videoStatus: 'done', description: 'd', describedBy: 'Gemini', gemini: { uri: 'https://gen.example/files/x' }, answers: { k: 1 } })
  assert.equal(snap.videoStatus, 'done'); assert.equal(snap.describedBy, 'Gemini'); assert.ok(!('gemini' in snap)); assert.ok(!('answers' in snap))
})

test('video input: only native Gemini seats; latest message videos reach the prompt as real videos', () => {
  assert.equal(isNativeGeminiSeat({ provider: 'google' }), true)
  assert.equal(isNativeGeminiSeat({ provider: 'google-vision' }), false)
  assert.equal(isNativeGeminiSeat({ provider: 'deepseek' }), false)
  const seats = resolveSeats({ chatroomSeats: [{ id: 'gm', name: 'Gemini', provider: 'google', model: 'gemini-3.8-flash', video: true }, { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro', video: true }] })
  assert.equal(seats[0].video, true); assert.equal(seats[1].video, false)
  const v = (id, extra = {}) => ({ id, kind: 'video', name: `${id}.mp4`, mediaType: 'video/mp4', bytes: 9, ...extra })
  const messages = [
    { seq: 1, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, status: 'ok', text: '旧的', attachments: [v('a000000000001', { videoStatus: 'done', description: '旧描述' })] },
    { seq: 2, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, status: 'ok', text: '新的 https://youtu.be/dQw4w9WgXcQ', attachments: [v('a000000000002', { videoStatus: 'pending' })], videoLinks: [v('a000000000003', { link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', linkKind: 'youtube', videoStatus: 'pending' })] },
  ]
  const on = buildPrompt({ seat: seats[0], seats, userName: 'Shiro', messages, videoInput: true, toolsInfo: { attachments: true } })
  assert.deepEqual(on.realVideos, ['a000000000002', 'a000000000003'])
  const last = on.messages[on.messages.length - 1]
  assert.deepEqual(last.videos.map((x) => x.id), ['a000000000002', 'a000000000003'])
  assert.match(last.content, /video #a000000000002 .*you are watching it yourself/); assert.match(last.content, /内容描述：旧描述/)
  assert.match(on.system, /watch the video\(s\) in the newest message yourself/)
  const off = buildPrompt({ seat: seats[1], seats, userName: 'Shiro', messages, toolsInfo: { attachments: true } })
  assert.ok(!off.messages.some((m) => m.videos)); assert.match(off.system, /watch_video/)
  assert.match(JSON.stringify(off.messages), /video link #a000000000003 https:\/\/www\.youtube\.com/)
})

test('gemini seat adapter: tools, media parts, function-call replay with thought signatures', async () => {
  const media = async (kind, item) => (kind === 'video' ? { inlineData: { mimeType: 'video/mp4', data: 'VklE' } } : { inlineData: { mimeType: 'image/png', data: 'UE5H' } })
  const contents = await toGeminiContents([
    { role: 'user', content: '[Shiro] 看', videos: [{ id: 'a1' }], images: [{ id: 'a2' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: '我查一下' }, { type: 'tool-call', id: 'c1', name: 'watch_video', arguments: '{"id":"a1","question":"q"}', thoughtSignature: 'SIG' }, { type: 'tool-call', id: 'c2', name: 'open_card', arguments: { id: 'r1' } }] },
    { role: 'user', toolResult: { toolCallId: 'c1', text: 'ok' } },
    { role: 'user', toolResult: { toolCallId: 'c2', text: 'bad', isError: true } },
  ], media)
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user'])
  assert.ok(contents[0].parts.some((p) => p.inlineData?.mimeType === 'video/mp4'))
  assert.deepEqual(contents[1].parts[1], { functionCall: { name: 'watch_video', args: { id: 'a1', question: 'q' } }, thoughtSignature: 'SIG' })
  assert.equal(contents[1].parts[2].thoughtSignature, SIGNATURE_PLACEHOLDER)
  assert.deepEqual(contents[2].parts.map((p) => p.functionResponse.name), ['watch_video', 'open_card'])
  assert.deepEqual(contents[2].parts[1].functionResponse.response, { error: 'bad' })
  const out = fromGeminiResponse({ candidates: [{ content: { parts: [{ text: '想想', thought: true }, { text: '好' }, { functionCall: { name: 'open_card', args: { id: 'r2' } }, thoughtSignature: 'S2' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } })
  assert.equal(out.text, '好'); assert.equal(out.reasoning, '想想'); assert.equal(out.finish, 'tool-calls')
  assert.equal(out.toolCalls[0].name, 'open_card'); assert.equal(out.blocks[1].thoughtSignature, 'S2'); assert.equal(out.usage.input, 7)
  const g = fakeGemini({ generate: () => ({ text: '看到了：一只猫' }) })
  const deltas = []
  const r = await callGeminiSeat({ seat: { name: 'Gemini', provider: 'google', model: 'gemini-3.8-flash' }, prompt: { system: 'sys', messages: [{ role: 'user', content: 'hi', videos: [{ id: 'a1' }] }] }, tools: [{ name: 'open_card', description: 'd', parameters: { type: 'object', properties: {} } }], maxTokens: 50, fetchImpl: g.fetchImpl, apiKey: KEY, resolveMedia: media, onDelta: (t) => deltas.push(t) })
  assert.equal(r.text, '看到了：一只猫'); assert.deepEqual(deltas, ['看到了：一只猫'])
  const body = g.generates()[0].body
  assert.match(g.generates()[0].url, /models\/gemini-3\.8-flash:generateContent$/)
  assert.equal(body.tools[0].functionDeclarations[0].name, 'open_card'); assert.equal(body.generationConfig.maxOutputTokens, 50); assert.equal(body.systemInstruction.parts[0].text, 'sys')
})

test('callGeminiSeat omits maxOutputTokens when unset', async () => {
  const g = fakeGemini({ generate: () => ({ text: 'hi' }) })
  const resolveMedia = async () => { throw new Error('no media') }
  await callGeminiSeat({ seat: { name: 'Gemini', provider: 'google', model: 'gemini-3.8-flash' }, prompt: { messages: [{ role: 'user', content: 'hi' }] }, fetchImpl: g.fetchImpl, apiKey: KEY, resolveMedia })
  assert.equal(g.generates()[0].body.generationConfig, undefined)
  await callGeminiSeat({ seat: { name: 'Gemini', provider: 'google', model: 'gemini-3.8-flash' }, prompt: { messages: [{ role: 'user', content: 'hi' }] }, maxTokens: 0, fetchImpl: g.fetchImpl, apiKey: KEY, resolveMedia })
  assert.equal(g.generates()[1].body.generationConfig, undefined)
})

test('yt-dlp: missing on PATH is detected; failures map to Chinese reasons', async () => {
  const none = createYtdlp({ runImpl: async () => ({ err: Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }) })
  assert.equal(await none.detect(), '')
  const ok = createYtdlp({ runImpl: async () => ({ err: null, stdout: '2026.09.01\n', stderr: '' }) })
  assert.equal(await ok.detect(), '2026.09.01')
  assert.match(ytdlpReason('ERROR: [BiliBili] HTTP Error 412: Precondition Failed', 25 * 1024 * 1024), /风控/)
  assert.match(ytdlpReason('File is larger than max-filesize (30000000 bytes > 26214400 bytes). Aborting.', 25 * 1024 * 1024), /超过 25 MB/)
  assert.match(YTDLP_MISSING, /yt-dlp/)
})

// ── watch_video 卡片：完成的工具结果，失败回合也保留；不发 Telegram；相同问题走缓存 ──

test('watch_video: normal tool card, kept on a failed turn, never relayed to Telegram', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const seats = resolveSeats({ chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro' }] })
    const attachments = createAttachmentStore((id) => join(dir, 'rooms', id))
    const asks = []
    const toolkit = createChatroomTools({
      roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [], get: () => null }), getLlm: () => null, getSettings: () => ({}),
      providers: async () => ({ available: true, providers: [] }), attachments,
      watchVideo: async (roomId, o) => { asks.push(o); return { text: '[0:03] 猫跳上桌子', label: '#x clip.mp4', range: '' } },
    })
    let i = 0
    const script = [
      { text: '', toolCalls: [{ id: 'w1', name: 'watch_video', arguments: JSON.stringify({ id: 'a0123456789ab', question: '猫做了什么' }) }], usage: {} },
      async () => { throw new Error('DeepSeek 请求失败：HTTP 500') },
    ]
    const tools = []
    const call = async (o) => { tools.push((o.tools || []).map((t) => t.name)); const s = script[Math.min(i++, script.length - 1)]; return typeof s === 'function' ? s(o) : s }
    const relays = []
    const tg = { typing: () => () => {}, relay: async (seat, roomId, text) => { relays.push(text); return [] }, relayAttachments: async () => { relays.push('ATTACH'); return [] } }
    const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {}, attachments: { enabled: true, video: true } }
    const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg })
    const room = await store.createRoom({ title: 'v' })
    const out = await moderator.post(room.id, '视频里猫做了什么', { owner: true, source: 'telegram', fromId: '1', userName: 'Shiro' })
    await out.promise
    await settle()
    assert.ok(tools[0].includes('watch_video'))
    assert.equal(asks.length, 1); assert.equal(asks[0].question, '猫做了什么')
    const msgs = await store.readMessages(room.id)
    const card = msgs.find((m) => m.kind === 'tool')
    assert.equal(card.tool, 'watch_video'); assert.equal(card.status, 'ok'); assert.equal(card.salvaged, true)
    assert.ok(!relays.some((t) => /猫跳上桌子|watch_video|ATTACH/.test(t)))
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

// ── 功能层：上传 / Telegram 视频自动描述、watch_video 缓存、YouTube、哔哩哔哩、视频输入席位 ──

function feature(dir, { generate, seats = [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-v4-pro' }], call, ytdlp, extra = {} } = {}) {
  const g = fakeGemini({ generate })
  const cfg = { chatroomEnabled: true, chatroomOwnerTelegramId: '1', chatroomSeats: seats, chatroomDefaultMain: seats[0]?.id, videoGeminiKey: KEY, ...extra }
  const prompts = []
  const feat = createChatroomFeature(null, () => cfg, {
    dir, llm: null, presets: null, attachmentService: null,
    credentials: { resolve: async (ref) => (ref === 'GOOGLE_API_KEY' ? KEY : undefined), set: async () => {} },
    geminiFetch: g.fetchImpl,
    isVision: async () => false,
    call: call || (async (o) => { prompts.push(o.prompt); return { text: '收到', toolCalls: [], usage: {} } }),
    ...(ytdlp ? { ytdlp } : {}),
  })
  feat.bots.reply = async () => true
  return { feat, g, prompts, cfg }
}
const api = (feat) => async (method, sub, { body, raw, headers = {} } = {}) => {
  const { Readable } = await import('node:stream')
  let status, json
  const req = raw ? Object.assign(Readable.from([raw]), { method, headers, url: sub }) : { method, headers, url: sub, on() {} }
  await feat.handleApi(req, { writeHead() {}, write() {}, end() {}, on() {} }, sub, { sendJson: (_, s, j) => { status = s; json = j }, readBody: async () => JSON.stringify(body || {}) })
  return { status, json }
}

test('feature: every uploaded video is described in the background; card snapshot updates; members wait and see the description', async () => {
  const dir = await tmp()
  const { feat, g, prompts } = feature(dir, { generate: () => ({ text: '[0:00] 一只橘猫在窗台上。\n[0:05] 字幕：「早上好」' }) })
  try {
    const room = await feat.store.createRoom({ title: '视频' })
    const data = mp4(42)
    const up = await api(feat)('POST', `/chatroom/rooms/${room.id}/attachments`, { raw: data, headers: { 'content-type': 'video/mp4', 'x-file-name': 'cat.mp4', 'content-length': String(data.length) } })
    assert.equal(up.status, 200); assert.equal(up.json.attachment.kind, 'video')
    const sent = await api(feat)('POST', `/chatroom/rooms/${room.id}/messages`, { body: { text: '看看这个', attachments: [up.json.attachment.id] } })
    assert.equal(sent.status, 200)
    const msg = await until(async () => (await feat.store.readMessages(room.id)).find((m) => m.kind === 'user' && m.attachments?.[0]?.videoStatus === 'done'))
    const a = msg.attachments[0]
    assert.equal(a.durationSec, 42); assert.match(a.description, /橘猫/); assert.equal(a.describedBy, 'Gemini'); assert.ok(!('gemini' in a))
    await until(() => prompts.length > 0)
    assert.match(JSON.stringify(prompts[0].messages), /video #a[0-9a-f]+ cat\.mp4 0:42, from 用户[^·]* · 内容描述：\[0:00\] 一只橘猫/)
    const gen = g.generates()[0]
    assert.equal(gen.key, KEY); assert.ok(!gen.url.includes(KEY)); assert.match(gen.url, /gemini-3\.8-flash:generateContent/)
    assert.ok(gen.body.contents[0].parts[0].inlineData); assert.match(gen.body.contents[0].parts[1].text, /时间戳/)
    // 设置：视频理解开关与模型在附件分组中
    const att = await api(feat)('GET', '/chatroom/attach')
    assert.equal(att.json.settings.video, true); assert.equal(att.json.settings.videoModel, 'gemini-3.8-flash'); assert.ok(!JSON.stringify(att.json).includes(KEY))
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('feature: a failed description shows the reason on the card only; AIs get a blank sheet', async () => {
  const dir = await tmp()
  const { feat, prompts } = feature(dir, { generate: () => ({ status: 429, json: { error: { status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for key ${KEY}` } } }) })
  try {
    const room = await feat.store.createRoom({ title: '视频' })
    await feat.telegramInbound(room.id, [{ chatId: '-1', fromId: '1', fromName: 'Shiro', text: '', files: [{ fileId: 'V', kind: 'video', name: 'clip.mp4', mediaType: 'video/mp4', size: 200 }], download: async () => ({ data: mp4(7) }) }])
    const msg = await until(async () => (await feat.store.readMessages(room.id)).find((m) => m.kind === 'user' && m.attachments?.[0]?.videoStatus === 'failed'))
    assert.match(msg.attachments[0].videoError, /Quota exceeded/); assert.ok(!msg.attachments[0].videoError.includes(KEY))
    await until(() => prompts.length > 0)
    const text = JSON.stringify(prompts[0].messages)
    assert.match(text, /sheet came back blank/); assert.ok(!/Quota|RESOURCE_EXHAUSTED/.test(text))
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('feature: watch_video caches identical questions, honours ranges, accepts YouTube links; video feature off hides the tool', async () => {
  const dir = await tmp()
  const { feat, g, cfg } = feature(dir, { generate: (body) => ({ text: body.contents[0].parts[0].videoMetadata ? '[1:10] 范围内的回答' : '[0:02] 回答' }) })
  try {
    const room = await feat.store.createRoom({ title: '视频' })
    const meta = await feat.attachments.save(room.id, { data: mp4(100), name: 'long.mp4', mediaType: 'video/mp4' })
    const seat = resolveSeats(cfg)[0]
    const run = (args) => feat.toolkit.run(room.id, { id: 'w', name: 'watch_video', arguments: JSON.stringify(args) }, { owner: true, seat })
    const r1 = await run({ id: meta.id, question: '谁先说话？' })
    assert.equal(r1.isError, false); assert.match(r1.modelText, /Gemini's view/); assert.match(r1.modelText, /\[0:02\] 回答/)
    assert.equal(r1.room.tool, 'watch_video'); assert.equal(r1.room.relay, false); assert.ok(r1.room.data.resultId)
    const before = g.gens()
    const r2 = await run({ id: '#' + meta.id, question: ' 谁先说话？ ' })
    assert.equal(g.gens(), before); assert.match(r2.modelText, /same question as before/)
    const r3 = await run({ id: meta.id, question: '谁先说话？', start: '1:05', end: '1:30' })
    assert.equal(g.gens(), before + 1); assert.match(r3.modelText, /1:05–1:30/)
    assert.deepEqual(g.generates().pop().body.contents[0].parts[0].videoMetadata, { startOffset: '65s', endOffset: '90s' })
    const bad = await run({ id: meta.id, question: 'q', start: 'later' })
    assert.equal(bad.isError, true); assert.match(bad.modelText, /not a time/)
    const yt = await run({ id: 'https://youtu.be/dQw4w9WgXcQ', question: '讲了什么' })
    assert.equal(yt.isError, false)
    assert.deepEqual(g.generates().pop().body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
    // 关闭视频理解：不再提供 watch_video
    cfg.chatroomVideoEnabled = false
    const names = (await feat.toolkit.schemas(room.id, { owner: true })).map((t) => t.name)
    assert.ok(!names.includes('watch_video')); assert.ok(names.includes('view_attachment'))
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('feature: YouTube links in a message are described from the link (no download, not a Telegram attachment)', async () => {
  const dir = await tmp()
  const { feat, g, prompts } = feature(dir, { generate: () => ({ text: '[0:00] 一段音乐视频' }) })
  try {
    const room = await feat.store.createRoom({ title: '链接' })
    const relayed = []
    const sent = await api(feat)('POST', `/chatroom/rooms/${room.id}/messages`, { body: { text: '这个好看 https://youtu.be/dQw4w9WgXcQ' } })
    assert.equal(sent.status, 200)
    const msg = await until(async () => (await feat.store.readMessages(room.id)).find((m) => m.kind === 'user' && m.videoLinks?.[0]?.videoStatus === 'done'))
    assert.ok(!msg.attachments || !msg.attachments.length)
    assert.equal(msg.videoLinks[0].link, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'); assert.equal(msg.videoLinks[0].linkKind, 'youtube')
    assert.deepEqual(g.generates()[0].body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
    assert.equal(g.uploads(), 0)
    await until(() => prompts.length > 0)
    assert.match(JSON.stringify(prompts[0].messages), /video link #a[0-9a-f]+ https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ, from 用户[^·]* · 内容描述/)
    assert.equal(relayed.length, 0)
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('feature: Bilibili needs yt-dlp on PATH (clear reason otherwise); with it, the download becomes a normal video', async () => {
  const dir = await tmp()
  const missing = { detect: async () => '', download: async () => { throw new Error('should not run') } }
  const a = feature(dir, { ytdlp: missing })
  try {
    const room = await a.feat.store.createRoom({ title: 'b' })
    await a.feat.localPost(room.id, '看 https://www.bilibili.com/video/BV1xx411c7mD', [])
    const msg = await until(async () => (await a.feat.store.readMessages(room.id)).find((m) => m.videoLinks?.[0]?.videoStatus === 'failed'))
    assert.match(msg.videoLinks[0].videoError, /未检测到 yt-dlp/)
    assert.equal(a.g.gens(), 0)
  } finally { a.feat.dispose?.() }
  const dir2 = await tmp()
  const present = {
    detect: async () => '2026.09.01',
    download: async (url, d) => { const p = join(d, 'BV1xx411c7mD.mp4'); await writeFile(p, mp4(12)); return { ok: true, path: p, bytes: 1 } },
  }
  const b = feature(dir2, { ytdlp: present, generate: () => ({ text: '[0:00] 哔哩哔哩视频' }) })
  try {
    const room = await b.feat.store.createRoom({ title: 'b' })
    await b.feat.localPost(room.id, '看 https://www.bilibili.com/video/BV1xx411c7mD', [])
    const msg = await until(async () => (await b.feat.store.readMessages(room.id)).find((m) => m.videoLinks?.[0]?.videoStatus === 'done'))
    assert.equal(msg.videoLinks[0].durationSec, 12); assert.equal(msg.videoLinks[0].linkKind, 'bilibili')
    assert.ok(b.g.generates()[0].body.contents[0].parts[0].inlineData)
  } finally { b.feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await rm(dir2, { recursive: true, force: true }) }
})

test('feature: a Gemini seat with video input receives the latest video via the plugin route; others use DSH with the description', async () => {
  const dir = await tmp()
  const dshCalls = []
  const seats = [{ id: 'gm', name: 'Gemini', provider: 'google', model: 'gemini-3.8-flash', video: true }]
  const { feat, g } = feature(dir, {
    seats,
    call: async (o) => { dshCalls.push(o); return { text: 'DSH', toolCalls: [], usage: {} } },
    generate: (body) => (body.systemInstruction?.parts?.[0]?.text?.includes("world's console in a shared group chat: when someone needs a video watched") ? { text: '[0:00] 描述' } : { text: '我看了，猫很可爱' }),
  })
  try {
    const room = await feat.store.createRoom({ title: '视频' })
    const meta = await feat.attachments.save(room.id, { data: mp4(9), name: 'cat.mp4', mediaType: 'video/mp4' })
    await feat.localPost(room.id, '你看看', [meta.id])
    const reply = await until(async () => (await feat.store.readMessages(room.id)).find((m) => m.kind === 'seat' && m.status === 'ok'))
    assert.equal(reply.text, '我看了，猫很可爱')
    assert.equal(dshCalls.length, 0)
    const seatReq = g.generates().find((c) => !/when someone needs a video watched/.test(c.body.systemInstruction?.parts?.[0]?.text || ''))
    assert.match(seatReq.url, /gemini-3\.8-flash:generateContent/)
    const parts = seatReq.body.contents.flatMap((c) => c.parts)
    assert.ok(parts.some((p) => p.inlineData?.mimeType === 'video/mp4'))
    assert.ok(parts.some((p) => /you are watching it yourself/.test(p.text || '')))
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
test('feature: with 多模态 › 视频理解 off, videos get an "off" card, nothing reaches Gemini, watch_video is hidden, links are ignored', async () => {
  const dir = await tmp()
  const { feat, g, prompts, cfg } = feature(dir, { extra: { videoEnabled: false } })
  try {
    const room = await feat.store.createRoom({ title: '视频' })
    const data = mp4(12)
    const up = await api(feat)('POST', `/chatroom/rooms/${room.id}/attachments`, { raw: data, headers: { 'content-type': 'video/mp4', 'x-file-name': 'off.mp4', 'content-length': String(data.length) } })
    assert.equal(up.status, 200)
    await api(feat)('POST', `/chatroom/rooms/${room.id}/messages`, { body: { text: '看看 https://youtu.be/dQw4w9WgXcQ', attachments: [up.json.attachment.id] } })
    const msg = await until(async () => (await feat.store.readMessages(room.id)).find((m) => m.kind === 'user' && m.attachments?.[0]?.videoStatus === 'off'))
    assert.ok(!msg.attachments[0].description)
    assert.ok(!(msg.videoLinks || []).length)
    await until(() => prompts.length > 0)
    const text = JSON.stringify(prompts[0].messages)
    assert.ok(!/内容描述|blank|being watched/.test(text))
    assert.equal(g.calls.length, 0)
    const names = (await feat.toolkit.schemas(room.id, { owner: true })).map((t) => t.name)
    assert.ok(!names.includes('watch_video'))
    const att = await api(feat)('GET', '/chatroom/attach')
    assert.equal(att.json.video.enabled, false); assert.equal(att.json.settings.video, false)
    // 旧接口仍可写：写入的是组件的键
    assert.equal(cfg.chatroomVideoEnabled, undefined)
  } finally { feat.dispose?.(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})