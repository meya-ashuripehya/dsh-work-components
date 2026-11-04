import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveVideoKey, videoKeyStatus, maskTail, VIDEO_KEY_MISSING } from './key.mjs'
import { handleVideoApi, ytdlpCandidates } from './index.mjs'
import { createYtdlpInstaller, parseSums, ytdlpAsset, ytdlpBinPath, readYtdlpInstalled, YTDLP_LATEST_API } from './ytdlp-install.mjs'
import { createYtdlp } from '../chatroom/ytdlp.mjs'
import { createChatroomFeature } from '../chatroom/index.mjs'

const KEY = 'AIzaVideoOwnKeyForTests000000000000wxyz'
const VAULT_KEY = 'AIzaTranscribeOrSeatKey00000000000000abcd'

test('video key: only the component setting counts; no env / transcription / seat fallback', () => {
  const saved = { g: process.env.GEMINI_API_KEY, o: process.env.GOOGLE_API_KEY }
  process.env.GEMINI_API_KEY = VAULT_KEY; process.env.GOOGLE_API_KEY = VAULT_KEY
  try {
    assert.deepEqual(resolveVideoKey({}), { key: '', credentialSource: 'apiKey', problem: VIDEO_KEY_MISSING })
    assert.deepEqual(resolveVideoKey({ videoGeminiKey: '   ' }), { key: '', credentialSource: 'apiKey', problem: VIDEO_KEY_MISSING })
    assert.deepEqual(resolveVideoKey({ videoGeminiKey: ` ${KEY}\n` }), { key: KEY, credentialSource: 'apiKey', ref: 'videoGeminiKey', via: 'component' })
    assert.match(VIDEO_KEY_MISSING, /^未配置密钥/)
  } finally {
    if (saved.g === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.g
    if (saved.o === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = saved.o
  }
})

test('video key status: source + masked tail only, never the key', () => {
  const st = videoKeyStatus({ videoGeminiKey: KEY })
  assert.deepEqual(st, { ready: true, credentialSource: 'apiKey', source: '组件设置', tail: '••••wxyz' })
  assert.ok(!JSON.stringify(st).includes(KEY.slice(0, 8)))
  assert.equal(maskTail('short'), '••••')
  assert.deepEqual(videoKeyStatus({}), { ready: false, credentialSource: 'apiKey', problem: VIDEO_KEY_MISSING })
})

test('chatroom video route uses the component key even when the transcription / seat vault has a Gemini key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vk-'))
  try {
    const cfg = { chatroomEnabled: true, chatroomSeats: [{ id: 'gm', name: 'Gemini', provider: 'google', model: 'gemini-3-pro' }] }
    const feat = createChatroomFeature(null, () => cfg, { dir, llm: null, presets: null, attachmentService: null, credentials: { resolve: async () => VAULT_KEY, set: async () => {} }, isVision: async () => false, call: async () => ({ text: '', toolCalls: [], usage: {} }) })
    assert.deepEqual(await feat.gemini.resolveKey(), { key: '', credentialSource: 'apiKey', problem: VIDEO_KEY_MISSING })
    cfg.videoGeminiKey = KEY
    assert.equal((await feat.gemini.resolveKey()).key, KEY)
    await feat.dispose?.()
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('yt-dlp lookup order: setting path > PATH > downloaded copy; falls through; cache resets', async () => {
  assert.deepEqual(ytdlpCandidates({ videoYtdlpPath: '"D:\\t\\yt-dlp.exe"' }, { downloaded: 'X:\\bin\\yt-dlp.exe', exists: () => true }), [
    { bin: 'D:\\t\\yt-dlp.exe', source: 'setting' }, { bin: 'yt-dlp', source: 'path' }, { bin: 'X:\\bin\\yt-dlp.exe', source: 'downloaded' }])
  assert.deepEqual(ytdlpCandidates({}, { downloaded: 'X:\\bin\\yt-dlp.exe', exists: () => false }), [{ bin: 'yt-dlp', source: 'path' }])
  const works = new Set(['X:\\bin\\yt-dlp.exe'])
  const ran = []
  const runImpl = async (bin, args) => { ran.push(bin); return works.has(bin) ? { err: null, stdout: bin === 'yt-dlp' ? '2026.09.01\n' : '2026.08.19\n', stderr: '' } : { err: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' } }
  let cfg = { videoYtdlpPath: 'D:\\broken.exe' }
  const y = createYtdlp({ runImpl, candidates: () => ytdlpCandidates(cfg, { downloaded: 'X:\\bin\\yt-dlp.exe', exists: () => true }) })
  assert.deepEqual(await y.resolve().then(({ version, bin, source }) => ({ version, bin, source })), { version: '2026.08.19', bin: 'X:\\bin\\yt-dlp.exe', source: 'downloaded' })
  assert.deepEqual(ran, ['D:\\broken.exe', 'yt-dlp', 'X:\\bin\\yt-dlp.exe'])
  ran.length = 0; await y.detect(); assert.equal(ran.length, 0, 'cached')
  works.add('yt-dlp'); y.reset()
  assert.equal((await y.resolve()).source, 'path')
  cfg = {}; ran.length = 0
  assert.equal((await y.resolve()).source, 'path'); assert.deepEqual(ran, ['yt-dlp'], 'changed candidates invalidate the cache')
  // 下载时用检测到的那个程序
  const dl = []
  const y2 = createYtdlp({ runImpl: async (bin, args) => { dl.push(bin); return args[0] === '--version' ? { err: null, stdout: '2026.08.19', stderr: '' } : { err: new Error('x'), stdout: '', stderr: 'ERROR: nope' } }, candidates: () => [{ bin: 'X:\\bin\\yt-dlp.exe', source: 'downloaded' }] })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-yt-'))
  try { await y2.download('https://www.bilibili.com/video/BV1', dir, { maxBytes: 1 << 20 }) } finally { rmSync(dir, { recursive: true, force: true }) }
  assert.deepEqual(dl, ['X:\\bin\\yt-dlp.exe', 'X:\\bin\\yt-dlp.exe'])
})

test('yt-dlp assets and SHA2-256SUMS parsing', () => {
  assert.equal(ytdlpAsset('win32', 'x64'), 'yt-dlp.exe')
  assert.equal(ytdlpAsset('win32', 'arm64'), 'yt-dlp_arm64.exe')
  assert.equal(ytdlpAsset('darwin', 'arm64'), 'yt-dlp_macos')
  assert.equal(ytdlpAsset('linux', 'x64'), 'yt-dlp_linux')
  assert.equal(ytdlpAsset('linux', 'arm64'), 'yt-dlp_linux_aarch64')
  assert.equal(ytdlpAsset('freebsd', 'x64'), null)
  const h = 'a'.repeat(64)
  const sums = `${'1'.repeat(64)}  yt-dlp\n${h}  yt-dlp.exe\n${'2'.repeat(64)}  yt-dlp_x86.exe\n`
  assert.equal(parseSums(sums, 'yt-dlp.exe'), h)
  assert.equal(parseSums(sums, 'yt-dlp'), '1'.repeat(64))
  assert.equal(parseSums(sums, 'yt-dlp_macos'), null)
})

const noNet = async () => { throw new Error('network disabled in tests') }
function fakeRelease({ tag = '2026.08.19', body = Buffer.from('fake yt-dlp binary'), sumFor } = {}) {
  const sha = createHash('sha256').update(body).digest('hex')
  const urls = []
  const download = async (url, dest, { onProgress } = {}) => {
    urls.push(url)
    if (url === YTDLP_LATEST_API) { writeFileSync(dest, JSON.stringify({ tag_name: tag })); return }
    if (url.endsWith('/SHA2-256SUMS')) { writeFileSync(dest, `${sumFor ?? sha}  yt-dlp.exe\n${'0'.repeat(64)}  yt-dlp_linux\n`); return }
    onProgress?.(0, body.length); onProgress?.(body.length, body.length)
    writeFileSync(dest, body)
  }
  return { download, urls, sha }
}

test('yt-dlp download: latest official release, pinned to its tag, sha256 verified, progress, marker, cache cleared', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ytdl-'))
  try {
    const r = fakeRelease()
    let cleared = 0
    const inst = createYtdlpInstaller({ download: r.download, redirect: noNet, root, platform: 'win32', arch: 'x64', onInstalled: () => { cleared++ } })
    assert.equal(inst.installed(), null)
    const info = await inst.start()
    assert.deepEqual(r.urls, [YTDLP_LATEST_API, 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS', 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe'])
    assert.equal(info.version, '2026.08.19'); assert.equal(info.sha256, r.sha)
    assert.equal(cleared, 1)
    assert.equal(readFileSync(ytdlpBinPath(root, 'win32'), 'utf8'), 'fake yt-dlp binary')
    const ins = readYtdlpInstalled(root, 'win32')
    assert.equal(ins.version, '2026.08.19')
    assert.equal(inst.job().state, 'done'); assert.equal(inst.job().progress, 100)
    assert.deepEqual(readdirSync(join(root, 'bin')).sort(), ['yt-dlp.exe', 'yt-dlp.json'], 'no temp files left')
    // 更新：同一按钮再下一次，替换旧副本
    const r2 = fakeRelease({ tag: '2026.10.01', body: Buffer.from('newer') })
    const inst2 = createYtdlpInstaller({ download: r2.download, redirect: noNet, root, platform: 'win32', arch: 'x64' })
    assert.equal((await inst2.start()).version, '2026.10.01')
    assert.equal(readFileSync(ytdlpBinPath(root, 'win32'), 'utf8'), 'newer')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('yt-dlp download: checksum mismatch / bad tag / unsupported platform fail cleanly and keep the old copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ytdl-'))
  try {
    await createYtdlpInstaller({ download: fakeRelease().download, redirect: noNet, root, platform: 'win32', arch: 'x64' }).start()
    const bad = createYtdlpInstaller({ download: fakeRelease({ tag: '2026.10.01', body: Buffer.from('tampered'), sumFor: 'b'.repeat(64) }).download, root, platform: 'win32', arch: 'x64' })
    await assert.rejects(bad.start(), /sha256 与官方 SHA2-256SUMS 不一致/)
    assert.equal(bad.job().state, 'error')
    assert.equal(readFileSync(ytdlpBinPath(root, 'win32'), 'utf8'), 'fake yt-dlp binary'); assert.equal(readYtdlpInstalled(root, 'win32').version, '2026.08.19')
    assert.deepEqual(readdirSync(join(root, 'bin')).sort(), ['yt-dlp.exe', 'yt-dlp.json'])
    await assert.rejects(createYtdlpInstaller({ download: fakeRelease({ tag: '../../evil' }).download, redirect: async () => 'https://github.com/yt-dlp/yt-dlp/releases/tag/..%2F..%2Fevil', root, platform: 'win32', arch: 'x64' }).start(), /GitHub API 返回的版本信息无效；改用 github\.com 发布页也失败：github\.com 发布页跳转目标中没有有效的版本号/)
    await assert.rejects(createYtdlpInstaller({ download: fakeRelease().download, redirect: noNet, root, platform: 'linux', arch: 'x64' }).start(), /SHA2-256SUMS 中没有|不一致/)
    await assert.rejects(createYtdlpInstaller({ download: fakeRelease().download, redirect: noNet, root, platform: 'freebsd', arch: 'x64' }).start(), /没有适用于 freebsd-x64/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('video API: download is settings-page only (cross-site refused) and reports yt-dlp state', async () => {
  let started = 0
  const feature = {
    state: () => ({ status: 'on', detail: '已启用', mounted: true }),
    ytdlp: { resolve: async () => ({ version: '2026.08.19', bin: 'X', source: 'downloaded' }) },
    installer: { start: async () => { started++ }, job: () => ({ state: 'running', step: '正在下载', progress: 40 }), installed: () => ({ version: '2026.08.19', installedAt: 't', path: 'X' }) },
  }
  let sent
  const sendJson = (_r, status, body) => { sent = { status, body } }
  await handleVideoApi({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }, {}, '/video/ytdlp/download', { sendJson, getConfig: () => ({}), feature })
  assert.equal(sent.status, 403); assert.equal(started, 0)
  await handleVideoApi({ method: 'POST', headers: {} }, {}, '/video/ytdlp/download', { sendJson, getConfig: () => ({}), feature })
  assert.equal(sent.status, 200); assert.equal(started, 1)
  assert.deepEqual(sent.body.ytdlp, { version: '2026.08.19', source: 'downloaded', customPath: false, downloadable: ytdlpAsset() != null, installed: { version: '2026.08.19', installedAt: 't' }, job: { state: 'running', step: '正在下载', progress: 40 } })
  assert.ok(!JSON.stringify(sent.body).includes('"path"'))
})

test('settings + UI: videoGeminiKey is a secret; yt-dlp download button and path field exist', () => {
  const root = join(import.meta.dirname, '..', '..')
  const src = readFileSync(join(root, 'src', 'index.mjs'), 'utf8')
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(src, /videoGeminiKey: z\.string\(\)\.role\('secret'\)/)
  assert.match(src, /videoCredentialSource: z\.union/)
  assert.match(src, /videoYtdlpPath: z\.string\(\)/)
  assert.ok(client.includes('key: "videoGeminiKey", label: "Gemini API 密钥", type: "password"'))
  assert.ok(client.includes('key: "videoCredentialSource", label: "凭据来源"'))
  assert.ok(client.includes('"/video/credential"'))
  assert.ok(client.includes('"/video/ytdlp/download"') && client.includes('更新 / 重新下载 yt-dlp'))
  assert.ok(existsSync(join(root, 'src', 'video', 'ytdlp-install.mjs')))
})
// ── GitHub API 限流（403）时的回退 ──
import { createServer } from 'node:http'
import { tagFromLocation, reasonOf, YTDLP_LATEST_PAGE } from './ytdlp-install.mjs'
import { download as realDownload, resolveRedirect } from '../tools.mjs'

const rateLimited = () => Object.assign(new Error('HTTP 403：' + YTDLP_LATEST_API), { status: 403, rateLimited: true, noRetry: true })

test('yt-dlp download: API 403 rate limit → falls back to the github.com redirect; same proxy; checksum still verified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ytdl-'))
  try {
    const body = Buffer.from('yt-dlp via redirect')
    const sha = createHash('sha256').update(body).digest('hex')
    const calls = []
    const download = async (url, dest, opts = {}) => {
      calls.push({ url, proxy: opts.proxy, accept: opts.headers?.accept })
      if (url === YTDLP_LATEST_API) throw rateLimited()
      if (url.endsWith('/SHA2-256SUMS')) { writeFileSync(dest, `${sha}  yt-dlp.exe\n`); return }
      writeFileSync(dest, body)
    }
    const redirects = []
    const redirect = async (url, opts) => { redirects.push({ url, proxy: opts.proxy }); return 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19' }
    const inst = createYtdlpInstaller({ download, redirect, proxy: () => ' http://127.0.0.1:7890 ', root, platform: 'win32', arch: 'x64' })
    const info = await inst.start()
    assert.equal(info.version, '2026.08.19'); assert.equal(info.via, 'redirect'); assert.equal(info.sha256, sha)
    assert.equal(calls[0].accept, 'application/vnd.github+json')
    assert.deepEqual(redirects, [{ url: YTDLP_LATEST_PAGE, proxy: 'http://127.0.0.1:7890' }])
    assert.deepEqual(calls.map((c) => c.url).slice(1), ['https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS', 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe'])
    assert.ok(calls.every((c) => c.proxy === 'http://127.0.0.1:7890'), 'every request uses the download proxy')
    assert.equal(readFileSync(ytdlpBinPath(root, 'win32'), 'utf8'), 'yt-dlp via redirect')
    // 回退之后校验依然强制：sha 不符 → 失败、不安装
    const bad = createYtdlpInstaller({ download: async (url, dest) => { if (url === YTDLP_LATEST_API) throw rateLimited(); writeFileSync(dest, url.endsWith('SUMS') ? `${'c'.repeat(64)}  yt-dlp.exe\n` : 'evil') }, redirect, root, platform: 'win32', arch: 'x64' })
    await assert.rejects(bad.start(), /sha256 与官方 SHA2-256SUMS 不一致/)
    assert.equal(readFileSync(ytdlpBinPath(root, 'win32'), 'utf8'), 'yt-dlp via redirect')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('yt-dlp download: when API and redirect both fail, a clear Chinese error names both reasons', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ytdl-'))
  try {
    const inst = createYtdlpInstaller({ download: async () => { throw rateLimited() }, redirect: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), {}) }, root, platform: 'win32', arch: 'x64' })
    await assert.rejects(inst.start(), (e) => /^无法获取 yt-dlp 最新版本：GitHub API 未登录请求已达每小时上限（HTTP 403 rate limit/.test(e.message) && /改用 github\.com 发布页也失败：连接被拒绝/.test(e.message) && /下载代理/.test(e.message))
    assert.equal(inst.job().state, 'error'); assert.match(inst.job().error, /无法获取 yt-dlp 最新版本/)
    // 资产下载失败也给中文原因
    const r2 = createYtdlpInstaller({ download: async (url, dest) => { if (url === YTDLP_LATEST_API) { writeFileSync(dest, '{"tag_name":"2026.08.19"}'); return } throw Object.assign(new Error('HTTP 404：' + url), { status: 404 }) }, redirect: async () => { throw new Error('unused') }, root, platform: 'win32', arch: 'x64' })
    await assert.rejects(r2.start(), /下载校验文件 SHA2-256SUMS（2026\.08\.19）失败：github\.com 找不到该地址（HTTP 404）/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('tag from redirect target; reasons stay Chinese and drop full URLs', () => {
  assert.equal(tagFromLocation('https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19'), '2026.08.19')
  assert.equal(tagFromLocation('https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19/'), '2026.08.19')
  assert.equal(tagFromLocation('https://github.com/yt-dlp/yt-dlp/releases'), null)
  assert.equal(tagFromLocation('https://github.com/yt-dlp/yt-dlp/releases/tag/..%2F..%2Fx'), null)
  assert.match(reasonOf({ status: 429, rateLimited: true }, 'GitHub API'), /每小时上限/)
  assert.match(reasonOf({ status: 500 }), /HTTP 500/)
  assert.equal(reasonOf(new Error('boom at https://example.com/a?token=1')), 'boom at example.com')
})

test('tools download(): extra headers sent, 403 rate limit flagged and not retried; resolveRedirect returns the first hop', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'], accept: req.headers.accept })
    if (req.url === '/api') { res.writeHead(403, 'rate limit exceeded', { 'x-ratelimit-remaining': '0' }).end('{}'); return }
    if (req.url === '/latest') { res.writeHead(302, { location: '/releases/tag/2026.08.19' }).end(); return }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  // Windows 的环境变量不分大小写：只改 NO_PROXY，结束时恢复
  const saved = { no: process.env.NO_PROXY }
  process.env.NO_PROXY = '127.0.0.1'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    await assert.rejects(realDownload(base + '/api', join(dir, 'x.json'), { retries: 3, timeoutMs: 5000, headers: { accept: 'application/vnd.github+json' } }), (e) => e.status === 403 && e.rateLimited === true && /^HTTP 403：/.test(e.message))
    assert.equal(seen.filter((s) => s.url === '/api').length, 1, '403 is not retried')
    assert.equal(seen[0].accept, 'application/vnd.github+json'); assert.equal(seen[0].ua, 'dsh-workbench')
    assert.equal(await resolveRedirect(base + '/latest'), base + '/releases/tag/2026.08.19')
    await assert.rejects(resolveRedirect(base + '/plain'), (e) => e.status === 200)
  } finally {
    if (saved.no === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = saved.no
    rmSync(dir, { recursive: true, force: true })
    await new Promise((r) => server.close(r))
  }
})