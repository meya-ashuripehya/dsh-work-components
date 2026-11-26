import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserVideo, allowedMediaUrl, readVideoPage } from './browser-video.mjs'
import { findVideoLinks, shortVideoLink } from '../chatroom/video.mjs'
import { createVideoTools } from './tools.mjs'
import { videoSettings } from './index.mjs'

const ID = '7710906517213416730'
const URL = `https://www.douyin.com/video/${ID}`
const MEDIA = 'https://v26-webf.douyinvod.com/test/video.mp4'
const DATA = Buffer.from('0000ftypisom0000video-test')
const temp = () => mkdtemp(join(tmpdir(), 'dsh-browser-video-'))

test('short video links: escaped share text, canonical URLs, short links and domain validation', () => {
  assert.equal(findVideoLinks('看看 https\\://v.douyin.com/UZC2ZoipTzA/ :4pm L@w.fB')[0].kind, 'douyin')
  assert.equal(shortVideoLink(`https://www.iesdouyin.com/share/video/${ID}/?x=1`).url, URL)
  assert.equal(shortVideoLink('https://www.tiktok.com/@name/video/123456789').kind, 'tiktok')
  for (const host of ['vm.tiktok.com', 'vt.tiktok.com']) assert.equal(shortVideoLink(`https://${host}/ABC123/`).kind, 'tiktok')
  assert.equal(shortVideoLink('https://www.tiktok.com/t/ABC123/').kind, 'tiktok')
  for (const url of ['https://douyin.com.evil.test/video/123', 'https://evil.test/v.douyin.com/ABC123', 'https://user@v.douyin.com/ABC123/', 'https://www.tiktok.com/@user']) assert.equal(shortVideoLink(url), null)
  assert.equal(allowedMediaUrl('https://v.tiktokcdn.com/video', 'tiktok'), true)
  for (const url of ['http://127.0.0.1/video', 'https://v.douyinvod.com.evil.test/video', 'https://v.douyinvod.com:9222/video']) assert.equal(allowedMediaUrl(url, 'douyin'), false)
})

function browser({ size = DATA.length, data = DATA, redirect, error = false } = {}) {
  const calls = [], requests = []
  const call = async (_tools, _server, name, args) => {
    calls.push({ name, args })
    if (name === 'list_pages') return { ok: true, text: `2: ${URL} [selected]` }
    if (name === 'evaluate_script') return { ok: true, text: '```json\n' + JSON.stringify({ pageUrl: URL, url: MEDIA, userAgent: 'Chrome-test' }) + '\n```' }
    return { ok: true, value: error ? { isError: true } : {} }
  }
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } })
    return new Response(data, { headers: { 'content-length': String(size), 'content-type': 'video/mp4' } })
  }
  return { calls, requests, downloader: createBrowserVideo({ call, fetchImpl }) }
}

test('browser downloader: real file bytes, referer, no cookies, early size rejection, redirect rejection, partial cleanup', async () => {
  const dir = await temp()
  try {
    const b = browser()
    const r = await b.downloader.download(URL, dir, { maxBytes: 1000 })
    assert.equal(r.ok, true)
    assert.deepEqual(await readFile(r.path), DATA)
    assert.equal(b.requests[0].init.headers.referer, URL)
    assert.equal(b.requests[0].init.headers.cookie, undefined)
    assert.ok(!b.calls.some((c) => /ytdlp/.test(c.name)))
    await rm(r.path)
    for (const options of [{ size: 1001 }, { size: 0, data: Buffer.alloc(1001) }, { data: Buffer.from('this is an HTML error') }, { redirect: 'http://127.0.0.1/internal' }, { error: true }]) {
      const x = await browser(options).downloader.download(URL, dir, { maxBytes: 1000 })
      assert.equal(x.ok, false, JSON.stringify(options))
      assert.deepEqual(await readdir(dir), [])
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('browser page extraction: current item SSR overrides another video and blob URL', () => {
  const old = { document: globalThis.document, location: globalThis.location, navigator: globalThis.navigator }
  try {
    globalThis.location = { pathname: `/video/${ID}`, href: URL }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'test' } })
    globalThis.document = { title: 'test', body: { innerText: '' }, querySelectorAll(selector) {
      if (selector === 'video') return [{ currentSrc: 'blob:video', getBoundingClientRect: () => ({ width: 500, height: 500 }) }]
      return [{ textContent: JSON.stringify({ items: [{ id: '999', video: { playAddr: 'https://v.tiktokcdn.com/wrong.mp4' } }, { id: ID, video: { playAddr: MEDIA } }] }) }]
    } }
    assert.equal(readVideoPage().url, MEDIA)
  } finally {
    globalThis.document = old.document; globalThis.location = old.location
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: old.navigator })
  }
})

test('short link navigation timeout: retry reuses resolved page after user verification', async () => {
  const dir = await temp()
  let opened = 0, verified = false
  const call = async (_tools, _server, name) => {
    if (name === 'list_pages') return { ok: true, text: opened ? `2: ${URL} [selected]` : '1: chrome://newtab/' }
    if (name === 'new_page') { opened++; return { ok: false, timeout: true } }
    if (name === 'evaluate_script') return { ok: true, text: '```json\n' + JSON.stringify({ pageUrl: URL, url: verified ? MEDIA : '', userAgent: 'test', blocked: !verified }) + '\n```' }
    return { ok: true }
  }
  const b = createBrowserVideo({ call, timeoutMs: 0, wait: async () => {}, fetchImpl: async () => new Response(DATA, { headers: { 'content-type': 'video/mp4' } }) })
  try {
    const first = await b.download('https://v.douyin.com/UZC2ZoipTzA/', dir, { maxBytes: 1000 })
    assert.equal(first.ok, false)
    assert.match(first.error, /验证码/)
    verified = true
    const next = await b.download('https://v.douyin.com/UZC2ZoipTzA/', dir, { maxBytes: 1000 })
    assert.equal(next.ok, true)
    assert.equal(opened, 1)
    const ac = new AbortController(); ac.abort()
    assert.equal((await b.download(URL, dir, { maxBytes: 1000, signal: ac.signal })).ok, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('session tools: TikTok / Douyin use browser download and Gemini bytes, cache downloads and honour toggles', async () => {
  const dir = await temp()
  const downloads = [], generates = []
  const cfg = { videoGeminiKey: 'browser-video-test' }
  const browserVideo = { async download(url, dest, opts) { downloads.push({ url, opts }); const path = join(dest, 'test.mp4'); await writeFile(path, DATA); return { ok: true, path, bytes: DATA.length } } }
  const g = { resolveKey: async () => ({ key: cfg.videoGeminiKey }), fetch: () => async (_url, init) => { generates.push(JSON.parse(init.body)); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[0:00] 测试视频' }] } }] })) } }
  const list = createVideoTools({ getSettings: () => videoSettings(cfg), getConfig: () => cfg, getGemini: () => g, browserVideo, ytdlp: { detect() { throw new Error('must not use yt-dlp') } }, videosRoot: () => dir })
  try {
    const describe = list.find((x) => x.name === 'describe_video')
    const watch = list.find((x) => x.name === 'watch_video')
    for (const url of [URL, 'https://www.tiktok.com/@name/video/123456789']) {
      await describe.execute({ source: url })
      await watch.execute({ source: url, question: '什么内容', start: '1', end: '5' })
    }
    assert.equal(downloads.length, 2)
    assert.equal(downloads[0].opts.maxBytes, 4 * 1024 * 1024 * 1024)
    assert.deepEqual(Buffer.from(generates[0].contents[0].parts[0].inlineData.data, 'base64'), DATA)
    cfg.videoDouyin = false
    await assert.rejects(() => describe.execute({ source: URL }), /已关闭/)
    assert.equal(downloads.length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
