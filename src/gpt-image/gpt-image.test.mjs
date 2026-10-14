// GPT Image 2 生图：模拟 OpenAI 兼容服务（b64_json / url / 各类错误 / 测试连接 / 编辑 multipart），不访问真实接口。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GptImageError, generateImages, normalizeBaseUrl, redactSecret, testConnection } from './client.mjs'
import { createGptImageTools } from './tools.mjs'
import { createGptImageFeature, gptImageSettings, handleGptImageApi } from './index.mjs'
import { isOpenTool } from '../channels/telegram/owner-gate.mjs'

const KEY = 'sk-test-do-not-leak-0123456789abcdef'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let server
let base
let mode = 'b64'
const seen = []

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'] || '', body })
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.url === '/files/a.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG) }
      if (req.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: { message: 'Incorrect API key provided: ' + String(req.headers.authorization).slice(7) } })
      if (req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'gpt-image-2' }, { id: 'gpt-4o' }] })
      if (mode === 'b64') return json(200, { created: 1, data: [{ b64_json: PNG.toString('base64'), revised_prompt: '一只猫' }, { b64_json: PNG.toString('base64') }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } })
      if (mode === 'url') return json(200, { created: 1, data: [{ url: base.replace(/\/v1$/, '') + '/files/a.png' }] })
      if (mode === '403') return json(403, { error: { message: 'organization must be verified' } })
      if (mode === '429') return json(429, { error: { message: 'Rate limit reached' } })
      if (mode === '500') { res.writeHead(502, { 'content-type': 'text/html' }); return res.end('<html>bad gateway</html>') }
      if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>hi</html>') }
      if (mode === 'empty') return json(200, { data: [] })
      if (mode === 'slow') return setTimeout(() => json(200, { data: [] }), 3000)
      json(500, {})
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/v1`
})
after(() => { server.closeAllConnections?.(); server.close() })

function fakeAttachments() {
  let n = 0
  return { saved: [], async saveImage(img) { this.saved.push(img); return { attachmentId: 'att-' + (++n), mediaType: img.mediaType, bytes: img.data.length, width: 1, height: 1 } } }
}

function tools(root, attachments, extra = {}) {
  return createGptImageTools({
    getSettings: () => ({ apiKey: KEY, baseUrl: base + '/', model: 'gpt-image-2', size: '1024x1024', quality: 'low', timeoutSec: 30, ...extra }),
    getAttachments: () => attachments,
    imagesRoot: () => root,
    now: () => new Date('2026-10-13T09:30:00Z'),
  })
}

test('normalizeBaseUrl and redaction', () => {
  assert.equal(normalizeBaseUrl(''), 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('https://x.example/v1///'), 'https://x.example/v1')
  assert.throws(() => normalizeBaseUrl('ftp://x'), GptImageError)
  assert.throws(() => normalizeBaseUrl('https://u:p@x/v1'), GptImageError)
  assert.ok(!redactSecret('key ' + KEY, KEY).includes(KEY))
  assert.ok(!redactSecret('Bearer abcdefghijklmnop').includes('abcdefghijklmnop'))
})

test('testConnection uses GET /models only', async () => {
  seen.length = 0
  const r = await testConnection({ baseUrl: base, apiKey: KEY, model: 'gpt-image-2' })
  assert.deepEqual(r, { status: 'connected', host: new URL(base).host, modelCount: 2, modelListed: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].url, '/v1/models')
  await assert.rejects(testConnection({ baseUrl: base, apiKey: 'sk-wrong-key-123456789012' }), (e) => /401/.test(e.message) && !e.message.includes('sk-wrong-key-123456789012'))
  await assert.rejects(testConnection({ baseUrl: base, apiKey: '' }), /尚未配置 API Key/)
})

test('image_generate: b64_json saved under images/<date>/ with JSON-valid output', async () => {
  mode = 'b64'
  seen.length = 0
  const root = mkdtempSync(join(tmpdir(), 'gi-'))
  try {
    const att = fakeAttachments()
    const [gen] = tools(root, att)
    const value = await gen.execute({ prompt: '一只猫', n: 2, background: 'transparent' })
    const req = JSON.parse(seen[0].body.toString())
    assert.equal(seen[0].url, '/v1/images/generations')
    assert.deepEqual(req, { model: 'gpt-image-2', prompt: '一只猫', n: 2, size: '1024x1024', quality: 'low', background: 'transparent', output_format: 'png' })
    assert.equal(value.count, 2)
    assert.equal(value.directory, join(root, '2026-10-13'))
    for (const img of value.images) {
      assert.ok(existsSync(img.path))
      assert.ok(img.path.startsWith(join(root, '2026-10-13')))
      assert.ok(img.path.endsWith('.png'))
      assert.deepEqual(readFileSync(img.path), PNG)
      assert.equal(img.width, 1)
    }
    assert.equal(value.images[0].revisedPrompt, '一只猫')
    assert.deepEqual(value.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    assert.ok(!JSON.stringify(value).includes(KEY))
    const blocks = gen.output.render({}, value)
    assert.equal(blocks.filter((b) => b.type === 'image').length, 2)
    assert.equal(blocks[0].type, 'text')
    assert.ok(!blocks.some((b) => b.type === 'mm'))
    assert.equal(att.saved.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('image_generate: image block uses the host ref verbatim when the host transcodes', async () => {
  mode = 'b64'
  seen.length = 0
  const root = mkdtempSync(join(tmpdir(), 'gi-'))
  try {
    // 宿主把大 PNG 转成 JPEG 存进附件库；读取时逐项核对 mediaType/bytes/width/height。
    const att = { async saveImage() { return { attachmentId: 'sha256:x', mediaType: 'image/jpeg', bytes: 1234, width: 1, height: 1 } } }
    const [gen] = tools(root, att)
    const value = await gen.execute({ prompt: 'fish', n: 1 })
    assert.equal(value.images[0].mediaType, 'image/png')
    assert.equal(value.images[0].bytes, PNG.length)
    const img = gen.output.render({}, value).find((b) => b.type === 'image')
    assert.equal(img.attachment.mediaType, 'image/jpeg')
    assert.equal(img.attachment.bytes, 1234)
    const meta = gen.output.presentationMeta({}, value)
    assert.equal(meta.mm.asset.attachment.mediaType, 'image/jpeg')
    assert.equal(meta.mm.asset.attachment.bytes, 1234)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('image_generate: url response is downloaded', async () => {
  mode = 'url'
  const root = mkdtempSync(join(tmpdir(), 'gi-'))
  try {
    const [gen] = tools(root, fakeAttachments())
    const value = await gen.execute({ prompt: 'a cat' })
    assert.equal(value.count, 1)
    assert.deepEqual(readFileSync(value.images[0].path), PNG)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('errors become formal Chinese messages', async () => {
  const args = { baseUrl: base, apiKey: KEY, args: { prompt: 'x' }, timeoutMs: 10_000 }
  mode = '403'; await assert.rejects(generateImages(args), (e) => /403/.test(e.message) && /organization must be verified/.test(e.message))
  mode = '429'; await assert.rejects(generateImages(args), /429/)
  mode = '500'; await assert.rejects(generateImages(args), (e) => /服务端出错（502）/.test(e.message) && !/html/.test(e.message))
  mode = 'html'; await assert.rejects(generateImages(args), /不是有效的 JSON/)
  mode = 'empty'; await assert.rejects(generateImages(args), /未返回任何图片/)
  mode = 'slow'; await assert.rejects(generateImages({ ...args, timeoutMs: 300 }), /请求超时/)
  await assert.rejects(generateImages({ ...args, baseUrl: 'http://127.0.0.1:1/v1' }), /网络连接失败/)
  await assert.rejects(generateImages({ ...args, args: { prompt: 'x', n: 5 } }), /n 须为 1 到 4/)
  await assert.rejects(generateImages({ ...args, args: { prompt: '' } }), /prompt/)
  await assert.rejects(generateImages({ ...args, args: { prompt: 'x', size: 'big' } }), /size/)
})

test('image_edit sends multipart with images and mask', async () => {
  mode = 'b64'
  seen.length = 0
  const root = mkdtempSync(join(tmpdir(), 'gi-'))
  try {
    const a = join(root, 'a.png'); const b = join(root, 'b.png'); const m = join(root, 'm.png')
    writeFileSync(a, PNG); writeFileSync(b, PNG); writeFileSync(m, PNG)
    const [, edit] = tools(join(root, 'out'), fakeAttachments())
    const value = await edit.execute({ prompt: '合成', images: [a, b], mask: m })
    assert.equal(seen[0].url, '/v1/images/edits')
    assert.match(seen[0].type, /^multipart\/form-data/)
    const text = seen[0].body.toString('latin1')
    assert.equal((text.match(/name="image\[\]"/g) || []).length, 2)
    assert.match(text, /name="mask"/)
    assert.match(text, /name="model"\r\n\r\ngpt-image-2/)
    assert.equal(value.count, 2)
    writeFileSync(join(root, 'x.gif'), 'GIF89a')
    await assert.rejects(edit.execute({ prompt: 'x', images: [join(root, 'x.gif')] }), /仅支持/)
    await assert.rejects(edit.execute({ prompt: 'x', images: ['https://e.com/a.png'] }), /不支持网址/)
    await assert.rejects(edit.execute({ prompt: 'x', images: [] }), /至少需要/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('feature mounts only when enabled with key; API test never returns the key', async () => {
  let cfg = { gptImageEnabled: false, gptImageApiKey: KEY, gptImageBaseUrl: base }
  const registered = []
  const ctx = { logger: { warn() {} }, plugin(def) { def.apply({ inject(_d, fn) { fn({ get: () => fakeAttachments(), tools: { register: (t) => registered.push(t.name) } }) } }); return { dispose() {} } } }
  const f = createGptImageFeature(ctx, () => cfg)
  await f.sync(); assert.equal(f.state().status, 'off'); assert.equal(registered.length, 0)
  cfg = { ...cfg, gptImageEnabled: true, gptImageApiKey: '' }
  await f.sync(); assert.equal(f.state().detail, '未配置 API Key')
  cfg = { ...cfg, gptImageApiKey: KEY }
  await f.sync(); assert.equal(f.state().status, 'on'); assert.deepEqual(registered, ['image_generate', 'image_edit'])
  assert.equal(gptImageSettings({}).model, 'gpt-image-2')
  assert.equal(gptImageSettings({}).baseUrl, 'https://api.openai.com/v1')
  let sent
  const sendJson = (_res, status, body) => { sent = { status, body } }
  await handleGptImageApi({ method: 'POST', headers: {} }, {}, '/gpt-image/test', { sendJson, getConfig: () => cfg, feature: f })
  assert.equal(sent.body.ok, true); assert.equal(sent.body.status, 'connected')
  assert.ok(!JSON.stringify(sent.body).includes(KEY))
  await handleGptImageApi({ method: 'POST', headers: {} }, {}, '/gpt-image/test', { sendJson, getConfig: () => ({ ...cfg, gptImageApiKey: 'sk-bad-0000000000000000' }), feature: f })
  assert.equal(sent.body.ok, false); assert.match(sent.body.error, /401/); assert.ok(!JSON.stringify(sent.body).includes('sk-bad-0000000000000000'))
  await handleGptImageApi({ method: 'POST', headers: {} }, {}, '/gpt-image/test', { sendJson, getConfig: () => ({ gptImageApiKey: '' }), feature: f })
  assert.equal(sent.body.status, 'disconnected'); assert.match(sent.body.error, /^未连接/)
  await f.dispose()
})

test('Telegram owner gate: image tools are owner-only', () => {
  assert.equal(isOpenTool('image_generate'), false)
  assert.equal(isOpenTool('image_edit'), false)
})
