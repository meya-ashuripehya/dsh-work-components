// 出站文件发送：multipart 必须被 undici fetch 识别（回归：曾把全局 FormData 发成 "[object FormData]" 文本）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetch as undiciFetch } from 'undici'
import { createBotClient } from './telegram-bots.mjs'

test('sendFile posts real multipart (photo field + filename) through undici fetch', async () => {
  let got = null
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { got = { url: req.url, ctype: String(req.headers['content-type'] || ''), body: Buffer.concat(chunks) }; res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"result":{"message_id":7}}') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const base = 'http://127.0.0.1:' + srv.address().port
    const fetchImpl = (url, init) => undiciFetch(base + new URL(url).pathname.replace(/\/bot[^/]+\//, '/botX/'), init)
    const c = createBotClient('TEST', { fetchImpl })
    const data = Buffer.alloc(316657, 7)
    const r = await c.sendFile('sendPhoto', 'photo', '-100123', { data, name: 'screen_capture.png', mediaType: 'image/png' }, '截图')
    assert.equal(r.message_id, 7)
    assert.equal(got.url, '/botX/sendPhoto')
    assert.match(got.ctype, /^multipart\/form-data; boundary=/)
    const text = got.body.toString('latin1')
    assert.doesNotMatch(text, /\[object FormData\]/)
    assert.match(text, /name="photo"; filename="screen_capture.png"/)
    assert.match(text, /name="chat_id"\r\n\r\n-100123/)
    assert.ok(got.body.length > data.length)
  } finally { srv.close() }
})