import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VIDEO_KEYS, VIDEO_BASE_URL_DEFAULT, videoBaseUrl, videoSettings, migrateVideoKeys, createVideoFeature, handleVideoApi } from './index.mjs'
import { createVideoTools } from './tools.mjs'
import { YTDLP_MISSING } from '../chatroom/ytdlp.mjs'

const KEY = 'AIzaVideoComponentTestKey0000000000000'
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-video-'))

function fakeGemini({ generate = () => ({ text: '[0:00] 画面：一只猫。' }) } = {}) {
  const calls = []
  const res = (status, j) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => j })
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, key: init.headers?.['x-goog-api-key'], body })
    if (url.includes(':generateContent')) {
      const r = generate(body, calls.length)
      if (r.status) return res(r.status, r.json || {})
      return res(200, { candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: 'STOP' }] })
    }
    return res(404, { error: { message: 'unexpected ' + url } })
  }
  const gemini = { resolveKey: async () => ({ key: KEY, ref: 'GOOGLE_API_KEY', via: 'provider', seat: 'Gemini' }), fetch: () => fetchImpl }
  return { gemini, calls, gens: () => calls.filter((c) => c.url.includes(':generateContent')) }
}

function tools({ cfg = {}, gemini, ytdlp, root } = {}) {
  const config = { videoGeminiKey: KEY, ...cfg }
  const list = createVideoTools({ getSettings: () => videoSettings(config), getConfig: () => config, getGemini: () => gemini, ytdlp, videosRoot: () => root })
  return { describe: list.find((t) => t.name === 'describe_video'), watch: list.find((t) => t.name === 'watch_video'), list }
}

test('video settings: defaults on; legacy chatroom keys still read; one-time migration clears them', () => {
  assert.deepEqual(VIDEO_KEYS, ['videoEnabled', 'videoCredentialSource', 'videoGeminiKey', 'videoServiceAccountFile', 'videoVertexLocation', 'videoBucket', 'videoBucketPrefix', 'videoMaxHeight', 'videoBaseUrl', 'videoModel', 'videoYoutube', 'videoBilibili', 'videoYtdlpPath'])
  assert.deepEqual(videoSettings({}), { enabled: true, model: 'gemini-3.8-flash', youtube: true, bilibili: true, baseUrl: 'https://generativelanguage.googleapis.com', credentialSource: 'apiKey', vertexLocation: 'us-central1', serviceAccountFile: '', videoBucket: '', videoBucketPrefix: 'dsh-video', videoMaxHeight: '480', bucketEnabled: false })
  assert.equal(videoSettings({ chatroomVideoEnabled: false }).enabled, false)
  assert.equal(videoSettings({ videoEnabled: false }).enabled, false)
  assert.equal(videoSettings({ chatroomVideoModel: 'gemini-x' }).model, 'gemini-x')
  assert.equal(videoSettings({ videoModel: 'gemini-y', chatroomVideoModel: 'gemini-x' }).model, 'gemini-y')
  assert.equal(migrateVideoKeys({}), null)
  assert.equal(migrateVideoKeys({ chatroomVideoEnabled: true, chatroomVideoModel: 'gemini-3.8-flash' }), null)
  const p = migrateVideoKeys({ chatroomVideoEnabled: false, chatroomVideoModel: 'gemini-x', videoModel: 'gemini-3.8-flash' })
  assert.equal(p.videoEnabled, false); assert.equal(p.videoModel, 'gemini-x')
  assert.ok('chatroomVideoEnabled' in p && p.chatroomVideoEnabled === undefined)
  assert.ok('chatroomVideoModel' in p && p.chatroomVideoModel === undefined)
  // 迁移后的设置与迁移前等价
  const before = { chatroomVideoEnabled: false, chatroomVideoModel: 'gemini-x' }
  assert.deepEqual(videoSettings({ ...before, ...p }), videoSettings(before))
})

test('video feature: mounts describe_video / watch_video while enabled, unmounts when switched off', async () => {
  const cfg = { videoEnabled: true }
  const registered = []
  let disposed = 0
  const ctx = { logger: { warn() {} }, plugin(def) { assert.equal(def.name, 'dsh-workbench-video'); def.apply({ inject(_d, fn) { fn({ tools: { register: (t) => registered.push(t.name) } }) } }); return { dispose() { disposed++ } } } }
  const f = createVideoFeature(ctx, () => cfg, { getGemini: () => null, ytdlp: { detect: async () => '' } })
  await f.sync()
  assert.deepEqual(registered, ['describe_video', 'watch_video'])
  assert.deepEqual(f.state(), { status: 'on', detail: '已启用', mounted: true })
  await f.sync(); assert.equal(registered.length, 2)
  cfg.videoEnabled = false
  await f.sync()
  assert.equal(disposed, 1); assert.equal(f.state().status, 'off'); assert.equal(f.state().mounted, false)
  // 旧键关闭同样视为关闭
  const g = createVideoFeature(ctx, () => ({ chatroomVideoEnabled: false }), { getGemini: () => null })
  await g.sync(); assert.equal(g.state().mounted, false)
  // 宿主不能挂子插件：聊天室仍可用，说明写清楚
  const h = createVideoFeature({ logger: {} }, () => ({}), { getGemini: () => null })
  await h.sync(); assert.equal(h.state().status, 'on'); assert.match(h.state().detail, /会话工具不可用/)
  await f.dispose()
})

test('video tools: local file inline, YouTube by link, cache for the same question, key never leaks', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'cat.mp4')
    await writeFile(file, Buffer.alloc(2048, 1))
    const g = fakeGemini({ generate: (body) => ({ text: body.contents[0].parts[0].videoMetadata ? '[0:05] 范围回答' : '[0:00] 橘猫' }) })
    const { describe, watch } = tools({ gemini: g.gemini, root: dir })
    const d = await describe.execute({ source: file })
    assert.equal(d.text, '[0:00] 橘猫'); assert.equal(d.model, 'gemini-3.8-flash'); assert.equal(d.source, file)
    const gen = g.gens()[0]
    assert.equal(gen.key, KEY); assert.ok(!gen.url.includes(KEY)); assert.ok(gen.body.contents[0].parts[0].inlineData)
    assert.ok(!JSON.stringify(d).includes(KEY))
    const w1 = await watch.execute({ source: file, question: '发生了什么', start: '0:02', end: '0:08' })
    assert.equal(w1.range, '0:02–0:08'); assert.match(w1.text, /范围回答/)
    assert.deepEqual(g.gens().at(-1).body.contents[0].parts[0].videoMetadata, { startOffset: '2s', endOffset: '8s' })
    const n = g.gens().length
    const w2 = await watch.execute({ source: file, question: ' 发生了什么 ', start: '0:02', end: '0:08' })
    assert.equal(w2.cached, true); assert.equal(g.gens().length, n)
    const yt = await describe.execute({ source: 'https://youtu.be/dQw4w9WgXcQ' })
    assert.ok(yt.text)
    assert.deepEqual(g.gens().at(-1).body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
    const text = describe.output.render({}, d).map((b) => b.text).join('')
    assert.match(text, /Gemini's view/)
    // 失败原因中不含密钥
    const bad = fakeGemini({ generate: () => ({ status: 429, json: { error: { status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for key ${KEY}` } } }) })
    const t2 = tools({ gemini: bad.gemini, root: dir })
    await assert.rejects(t2.describe.execute({ source: file }), (e) => { assert.match(e.message, /视频理解失败/); assert.ok(!e.message.includes(KEY)); return true })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('video tools: clear Chinese errors (disabled, relative path, not a video, YouTube off, Bilibili without yt-dlp, no key, bad range)', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'a.mp4'); await writeFile(file, Buffer.alloc(64, 1))
    const txt = join(dir, 'a.txt'); await writeFile(txt, 'x')
    const g = fakeGemini()
    await assert.rejects(tools({ cfg: { videoEnabled: false }, gemini: g.gemini, root: dir }).describe.execute({ source: file }), /未启用/)
    const t = tools({ gemini: g.gemini, root: dir, ytdlp: { detect: async () => '' } })
    await assert.rejects(t.describe.execute({ source: 'clip.mp4' }), /绝对路径/)
    await assert.rejects(t.describe.execute({ source: txt }), /不是受支持的视频文件/)
    await assert.rejects(t.describe.execute({ source: join(dir, 'none.mp4') }), /文件不存在/)
    await assert.rejects(t.describe.execute({ source: 'https://example.com/v.mp4' }), /只支持/)
    await assert.rejects(t.describe.execute({ source: 'https://www.bilibili.com/video/BV1xx411c7mD' }), (e) => e.message === YTDLP_MISSING)
    await assert.rejects(tools({ cfg: { videoYoutube: false }, gemini: g.gemini, root: dir }).describe.execute({ source: 'https://youtu.be/dQw4w9WgXcQ' }), /已关闭 YouTube/)
    await assert.rejects(tools({ cfg: { videoBilibili: false }, gemini: g.gemini, root: dir }).describe.execute({ source: 'https://www.bilibili.com/video/BV1xx411c7mD' }), /已关闭哔哩哔哩/)
    const nokey = { resolveKey: async () => ({ problem: '未配置' }), fetch: () => async () => { throw new Error('should not fetch') } }
    await assert.rejects(tools({ gemini: nokey, root: dir }).describe.execute({ source: file }), (e) => e.message === '未配置')
    const none = { resolveKey: async () => ({}), fetch: () => async () => { throw new Error('should not fetch') } }
    await assert.rejects(tools({ gemini: none, root: dir }).describe.execute({ source: file }), (e) => e.message.startsWith('未配置密钥'))
    await assert.rejects(t.watch.execute({ source: file, question: 'q', start: 'later' }), /不是有效的时间/)
    await assert.rejects(t.watch.execute({ source: file, question: 'q', start: '10', end: '5' }), /end 必须晚于 start/)
    await assert.rejects(t.watch.execute({ source: file, question: ' ' }), /需要 question/)
    assert.equal(g.calls.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('video tools: Bilibili with yt-dlp downloads into videos/<date>/ and is watched as a local video', async () => {
  const dir = await tmp()
  try {
    const g = fakeGemini({ generate: () => ({ text: '[0:01] 弹幕很多' }) })
    let downloads = 0
    const ytdlp = {
      detect: async () => '2026.09.30',
      download: async (url, into) => { downloads++; await mkdir(into, { recursive: true }); const p = join(into, 'BV1xx411c7mD.mp4'); await writeFile(p, Buffer.alloc(512, 2)); return { ok: true, path: p, bytes: 512 } },
    }
    const t = tools({ gemini: g.gemini, root: join(dir, 'videos'), ytdlp })
    const url = 'https://www.bilibili.com/video/BV1xx411c7mD'
    const r = await t.describe.execute({ source: url })
    assert.equal(r.source, url); assert.match(r.text, /弹幕/)
    assert.ok(g.gens()[0].body.contents[0].parts[0].inlineData)
    await t.watch.execute({ source: url, question: '讲了什么' })
    assert.equal(downloads, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('video API: GET /video/status reports state, key source (masked tail) and yt-dlp without returning the key', async () => {
  const g = fakeGemini()
  const ctx = { logger: { warn() {} }, plugin(def) { def.apply({ inject(_d, fn) { fn({ tools: { register() {} } }) } }); return { dispose() {} } } }
  const f = createVideoFeature(ctx, () => ({}), { getGemini: () => g.gemini, ytdlp: { detect: async () => '2026.09.30' } })
  await f.sync()
  let sent
  const sendJson = (_res, status, body) => { sent = { status, body } }
  const handled = await handleVideoApi({ method: 'GET', headers: {} }, {}, '/video/status', { sendJson, getConfig: () => ({ videoBilibili: false, videoGeminiKey: KEY }), feature: f })
  assert.notEqual(handled, false)
  assert.equal(sent.status, 200)
  assert.equal(sent.body.status, 'on'); assert.equal(sent.body.mounted, true)
  assert.deepEqual(sent.body.key, { ready: true, credentialSource: 'apiKey', source: '组件设置', tail: '••••' + KEY.slice(-4) })
  assert.equal(sent.body.ytdlp.version, '2026.09.30'); assert.equal(sent.body.ytdlp.source, 'path'); assert.equal(sent.body.settings.bilibili, false)
  assert.ok(!JSON.stringify(sent.body).includes(KEY.slice(0, -4)))
  await handleVideoApi({ method: 'GET', headers: {} }, {}, '/video/status', { sendJson, getConfig: () => ({}), feature: f })
  assert.deepEqual(sent.body.key, { ready: false, credentialSource: 'apiKey', problem: '未配置密钥：请在「多模态 › 视频理解」中填写 Gemini API 密钥。' })
  assert.equal(await handleVideoApi({ method: 'GET', headers: {} }, {}, '/video/other', { sendJson, getConfig: () => ({}), feature: f }), false)
  await f.dispose()
})
test('video base URL: default, custom, trailing slashes, invalid falls back', () => {
  assert.equal(VIDEO_BASE_URL_DEFAULT, 'https://generativelanguage.googleapis.com')
  assert.equal(videoBaseUrl(undefined), VIDEO_BASE_URL_DEFAULT)
  assert.equal(videoBaseUrl('   '), VIDEO_BASE_URL_DEFAULT)
  assert.equal(videoBaseUrl(' https://gw.example.com/gemini '), 'https://gw.example.com/gemini')
  assert.equal(videoBaseUrl('https://gw.example.com/gemini///'), 'https://gw.example.com/gemini')
  assert.equal(videoBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
  for (const bad of ['gw.example.com', 'ftp://gw.example.com', 'javascript:alert(1)', 'https://', 'https://u:p@gw.example.com', 'https://gw.example.com/?x=1', 'not a url']) assert.equal(videoBaseUrl(bad), VIDEO_BASE_URL_DEFAULT, bad)
  assert.equal(videoSettings({ videoBaseUrl: 'https://gw.example.com/' }).baseUrl, 'https://gw.example.com')
  assert.equal(videoSettings({ videoBaseUrl: 'bogus' }).baseUrl, VIDEO_BASE_URL_DEFAULT)
})

test('video tools: requests go to the configured base URL; key only in x-goog-api-key header', async () => {
  for (const [cfg, base] of [[{}, VIDEO_BASE_URL_DEFAULT], [{ videoBaseUrl: 'https://gw.example.com/v/' }, 'https://gw.example.com/v']]) {
    const g = fakeGemini()
    const { describe } = tools({ cfg, gemini: g.gemini })
    await describe.execute({ source: 'https://youtu.be/dQw4w9WgXcQ' })
    const call = g.gens().at(-1)
    assert.equal(call.url, base + '/v1beta/models/gemini-3.8-flash:generateContent')
    assert.equal(call.key, KEY)
    assert.ok(!call.url.includes(KEY))
  }
})
