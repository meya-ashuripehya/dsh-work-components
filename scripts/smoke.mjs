// 本地冒烟：用假 ctx 挂载宿主半边；主路径 mm_send_image。render 只能是 text+image（无 mm）；MmCard 数据在 presentationMeta；并把 PNG 写到 lib/smoke.png。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { deflateSync } from 'node:zlib'
import { attachConsole, run } from '../src/tools.mjs'

const root = resolve(import.meta.dirname, '..')

// 控制台输出进 live / 环形缓冲，不进日志；失败时把最后几行追加进日志。
{
  const job = { log: [], live: '' }
  const c = attachConsole(job, { keep: 3, intervalMs: 60_000 })
  c.live('drop-me')
  c.live('one')
  c.live('two')
  c.progress('正在下载 uv：1.0 / 2.0 MB（50%）')
  c.live('\x1b[32mok\x1b[0m')
  if (job.log.length) throw new Error('console lines must not be appended to job.log while running')
  if (job.live !== 'drop-me') throw new Error('live updates must be throttled, got ' + job.live)
  c.dump()
  if (job.live !== '') throw new Error('dump must clear the live line')
  const dumped = job.log.join('\n')
  if (!dumped.startsWith('控制台输出（最后 3 行）：')) throw new Error('dump header missing: ' + dumped)
  if (!dumped.includes('two') || !dumped.includes('ok')) throw new Error('dump must keep the ring, not progress: ' + dumped)
  if (dumped.includes('正在下载')) throw new Error('download progress must not be stored in the ring')
  if (dumped.includes('drop-me')) throw new Error('ring must drop lines beyond keep: ' + dumped)
  const liveJob = { log: ['GET https://example'], live: '' }
  const live = attachConsole(liveJob, { intervalMs: 0 })
  await run(process.execPath, ['-e', 'process.stdout.write("alpha\\rbeta\\n")'], { onLine: (l) => live.live(l) })
  if (liveJob.log.length !== 1) throw new Error('run() output must not grow job.log')
  if (liveJob.live !== 'beta') throw new Error('carriage-return progress must keep the last segment, got ' + JSON.stringify(liveJob.live))
  const failJob = { log: [], live: '' }
  const fail = attachConsole(failJob, { intervalMs: 0 })
  let failed = false
  try {
    await run(process.execPath, ['-e', 'console.log("boom-line"); process.exit(3)'], { onLine: (l) => fail.live(l) })
  } catch (error) {
    failed = true
    if (!String(error.message).includes('退出码 3')) throw new Error('run() should still fail with exit code: ' + error.message)
  }
  if (!failed) throw new Error('failing command must reject')
  fail.dump()
  if (!failJob.log.some((l) => l.includes('boom-line'))) throw new Error('failure must dump the console tail into job.log')
  console.log('console live: throttled line, cr-segment, failure dump ok')
}


/** Minimal valid 8×8 RGBA PNG for mm_send_image input (no demo tool). */
function encodeTinyPng(size = 8) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  function crc32(buf) {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const w = size, h = size
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 80
    rgba[i * 4 + 1] = 140
    rgba[i * 4 + 2] = 220
    rgba[i * 4 + 3] = 255
  }
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const samplePath = join(root, 'lib', 'smoke.png')
const fixturePng = encodeTinyPng(8)
writeFileSync(samplePath, fixturePng)

// 冒烟不碰真实状态：没指定时设置文件 / 数据目录都用临时目录（结束时删除）。
const scratch = mkdtempSync(join(tmpdir(), 'dsh-wb-smoke-'))
const ownState = !process.env.DSH_WORKBENCH_DATA_DIR && !process.env.DSH_WORKBENCH_SETTINGS_FILE
process.env.DSH_WORKBENCH_DATA_DIR ||= join(scratch, 'data')
process.env.DSH_WORKBENCH_SETTINGS_FILE ||= join(scratch, 'settings.json')

const mod = await import('../lib/index.mjs')
const tools = []
const routes = []
let savedPng = null
const services = {
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  attachments: {
    async saveImage({ data, mediaType, name }) {
      savedPng = data
      return { attachmentId: 'att_smoke', mediaType, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20), name }
    },
  },
}
// 「通道」› Telegram：假凭据服务（只存在内存里）+ 假 profile（bundles 含 dsh-telegram-temp，验证接管保护）。
const credStore = new Map()
services.credentials = {
  async resolve(ref) { return credStore.has(ref) ? { value: credStore.get(ref) } : undefined },
  async describe(ref) { return { ref, present: credStore.has(ref) } },
  async set(ref, value) { credStore.set(ref, value) },
  async unset(ref) { credStore.delete(ref) },
}
const profileDir = join(scratch, 'profile')
mkdirSync(profileDir, { recursive: true })
const writeProfile = (bundles) => writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } }, dependencies: {} }))
writeProfile(['dsh-work-components', 'dsh-telegram-temp'])
services.profileContext = { dir: profileDir }
const forks = []
const disposers = []
const ctx = {
  ...services,
  // 记录 ctx.plugin：Telegram 运行时挂在这里的 fork 上（冒烟里不真正挂载、不联网）。
  plugin: (plugin) => { const fork = { name: plugin?.name, disposed: false, dispose() { this.disposed = true } }; forks.push(fork); return fork },
  get: (n) => services[n],
  inject: (names, cb) => cb(ctx),
  effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); return off },
  logger: console,
}
mod.apply(ctx, {})
console.log('registered tools:', tools.map((t) => t.name).join(', '))
if (tools.some((t) => t.name === 'mm_image_demo')) throw new Error('mm_image_demo should not be registered')
console.log('routes:', routes.map((r) => `${r.kind} ${r.path}`).join(', '))

const sendTool = tools.find((t) => t.name === 'mm_send_image')
if (!sendTool) throw new Error('mm_send_image not registered')
console.log('tool keys:', Object.keys(sendTool).join(', '))

let sendResult
try {
  sendResult = await sendTool.execute({ path: samplePath, title: 'smoke-send', caption: 'from smoke' }, { signal: new AbortController().signal })
} catch (e) {
  console.error('mm_send_image execute failed:', e)
  process.exit(1)
}
console.log('mm_send_image result:', JSON.stringify(sendResult, null, 2).slice(0, 500))
if (!sendResult?.image?.attachmentId) throw new Error('mm_send_image missing image.attachmentId')
if (!savedPng) throw new Error('no image saved via attachments.saveImage')
console.log('smoke.png bytes:', savedPng.length)

const sendOut = sendTool.output || sendTool.definition?.output
const sendRender = sendOut && (sendOut.render || sendOut.renderer)
if (typeof sendRender === 'function') {
  const blocks = sendRender({}, sendResult)
  const forbidden = (blocks || []).filter((b) => b && b.type === 'mm')
  if (forbidden.length) throw new Error('mm_send_image render must not emit type:mm (DeepSeek Messages UNSUPPORTED_CONTENT); got ' + forbidden.length)
  const text = (blocks || []).find((b) => b && b.type === 'text' && typeof b.text === 'string')
  if (!text?.text) throw new Error('mm_send_image render missing text envelope')
  const image = (blocks || []).find((b) => b && b.type === 'image' && b.attachment?.attachmentId)
  if (!image) throw new Error('mm_send_image render missing image attachment block')
  const badType = (blocks || []).find((b) => b && b.type !== 'text' && b.type !== 'image')
  if (badType) throw new Error('mm_send_image render has unsupported content type: ' + badType.type)
  console.log('mm_send_image render ok (text+image only):', JSON.stringify(blocks).slice(0, 240))
} else {
  console.log('skip mm_send_image render check (no output.render on tool wrapper)')
}

const sendMetaFn = sendOut && sendOut.presentationMeta
if (typeof sendMetaFn === 'function') {
  const meta = sendMetaFn({}, sendResult)
  if (!meta?.mm?.asset?.attachment?.attachmentId) throw new Error('mm_send_image presentationMeta missing mm ready block')
  if (meta.mm.type !== 'mm' || meta.mm.kind !== 'image' || meta.mm.status !== 'ready') {
    throw new Error('mm_send_image presentationMeta.mm shape invalid')
  }
  if (meta.title !== 'smoke-send') throw new Error('mm_send_image presentationMeta title mismatch')
  console.log('mm_send_image presentationMeta ok:', JSON.stringify(meta.mm).slice(0, 200))
} else {
  console.log('skip mm_send_image presentationMeta check (missing on tool wrapper)')
}

// ── /settings：密钥打码（GET 不回传明文；POST 原样带回占位值 = 保持不变）──
const api = routes.find((r) => r.path === '/dsh-workbench/api')
if (!api) throw new Error('settings API route not registered')
async function call(method, body, path = '/settings') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: '/dsh-workbench/api' + path, headers: {} })
  let status = 0
  let text = ''
  const res = { writeHead: (s) => { status = s }, setHeader() {}, end: (t) => { text = String(t ?? '') } }
  await api.handler(req, res)
  return { status, json: JSON.parse(text || '{}'), text }
}
const secret = `smoke-secret-${Math.random().toString(36).slice(2, 10)}`
const set = await call('POST', { githubToken: secret })
if (set.status !== 200 || set.text.includes(secret)) throw new Error('POST /settings leaked or failed')
const got = await call('GET')
if (got.text.includes(secret) || got.json.value.githubToken !== got.json.secretMask) throw new Error('GET /settings did not mask githubToken')
const back = await call('POST', { ...got.json.value })
if (back.status !== 200 || back.text.includes(secret)) throw new Error('POST mask round-trip failed')
const stored = JSON.parse(readFileSync(process.env.DSH_WORKBENCH_SETTINGS_FILE, 'utf8'))
if (stored.githubToken !== secret) throw new Error('posting the mask back must keep the saved secret')
const cleared = await call('POST', { githubToken: '' })
if (cleared.json.value.githubToken !== '') throw new Error('empty string should clear a secret')
console.log('settings secrets masked: GET hides, mask round-trip keeps, empty clears [values not printed]')

// ── 「通道」› Telegram：默认关闭；令牌只进宿主凭据（不回传、不落设置文件）；dsh-telegram-temp 在时不启动 ──
{
  const TAKEOVER = '已由独立插件 dsh-telegram-temp 接管，请先移除该插件'
  const tgItem = async () => (await call('GET', undefined, '/components')).json.components.find((c) => c.id === 'telegram')
  let tg = await tgItem()
  if (!tg || tg.group !== '通道' || !tg.builtin || tg.status !== 'off' || tg.enabled) throw new Error('telegram should be listed in 通道, builtin, off by default: ' + JSON.stringify(tg && { group: tg.group, status: tg.status }))
  if (tg.detail !== TAKEOVER) throw new Error('telegram (off) should show the takeover hint, got ' + tg.detail)
  const bad = await call('POST', { telegramToken: 'not-a-token' })
  if (bad.status !== 400 || credStore.size) throw new Error('malformed bot token must be rejected (400) and not stored')
  const tok = `${100000000 + Math.floor(Math.random() * 1e8)}:${'A'.repeat(20)}${Math.random().toString(36).slice(2, 17)}`
  const saved = await call('POST', { telegramToken: tok })
  if (saved.status !== 200 || saved.text.includes(tok)) throw new Error('POST telegramToken leaked or failed')
  if (credStore.get('TELEGRAM_BOT_TOKEN') !== tok) throw new Error('telegramToken must be written to credentials ref TELEGRAM_BOT_TOKEN')
  if (readFileSync(process.env.DSH_WORKBENCH_SETTINGS_FILE, 'utf8').includes(tok)) throw new Error('telegramToken must not be persisted in plugin settings')
  const g = await call('GET')
  if (g.text.includes(tok) || g.json.value.telegramToken !== g.json.secretMask) throw new Error('GET /settings must return the mask for a saved telegramToken')
  await call('POST', { ...g.json.value })
  if (credStore.get('TELEGRAM_BOT_TOKEN') !== tok) throw new Error('posting the mask back must keep the saved bot token')
  const on = await call('POST', { telegramEnabled: true })
  if (on.status !== 200) throw new Error('enabling telegram failed: ' + on.json.error)
  tg = await tgItem()
  if (tg.status !== 'disconnected' || tg.detail !== TAKEOVER || forks.length) throw new Error('with dsh-telegram-temp loaded telegram must not start; got ' + tg.status + ' / ' + tg.detail + ' / forks ' + forks.length)
  console.log('telegram takeover guard ok:', tg.detail)

  // 移除独立插件后（这里改假 profile、关再开）才启动：动态加载 lib/channel-telegram.mjs，挂一个 fork；访问策略写到临时 DSH_HOME。
  writeProfile(['dsh-work-components'])
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(scratch, 'dsh-home')
  try {
    await call('POST', { telegramEnabled: false })
    const started = await call('POST', { telegramEnabled: true, telegramOwnerId: '10001', telegramAllowFrom: '10002, 10003' })
    if (started.status !== 200) throw new Error('enabling telegram failed: ' + started.json.error)
    tg = await tgItem()
    if (forks.length !== 1 || forks[0].name !== 'dsh-workbench-telegram') throw new Error('telegram should mount exactly one fork, got ' + forks.length)
    if (tg.status !== 'connecting' || !tg.connection) throw new Error('telegram should be connecting (host services missing in smoke), got ' + tg.status + ' / ' + tg.detail)
    const policyFile = join(process.env.DSH_HOME, 'dsh-channels', 'storage', 'access', 'policy', 'v1', 'telegram', 'main')
    if (!existsSync(policyFile)) throw new Error('access policy not written under DSH_HOME/dsh-channels/storage')
    const policy = JSON.parse(readFileSync(policyFile, 'utf8'))
    if (policy.ownerId !== '10001' || policy.allowFrom.join() !== '10001,10002,10003' || policy.dmPolicy !== 'allowlist') throw new Error('access policy mismatch: ' + JSON.stringify(policy))
    const off = await call('POST', { telegramEnabled: false })
    if (off.status !== 200 || !forks[0].disposed || (await tgItem()).status !== 'off') throw new Error('disabling telegram must dispose its fork')
    console.log('telegram start/stop ok: one fork mounted then disposed; status', tg.status, '→ off; access policy written to scratch DSH_HOME')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
  const rt = await import('../lib/channel-telegram.mjs')
  for (const [name, ok] of Object.entries(rt.PATCH_MARKERS)) if (!ok) throw new Error('telegram patch marker missing: ' + name)
  const red = rt.sanitizeLogLine([`GET https://api.telegram.org/bot${tok}/getUpdates failed`, new Error(`token ${tok}`)])
  if (red.includes(tok) || red.includes(tok.split(':')[1])) throw new Error('sanitizeLogLine must redact bot tokens')
  if (!rt.isPollingConflict('409: Conflict: terminated by other getUpdates request') || rt.isPollingConflict('sent 4096 bytes')) throw new Error('isPollingConflict mismatch')
  const routes = rt.parseRouteMap('telegram:guest, qq:guest\n6153059771:lingsnow')
  if (routes.telegram?.preset !== 'guest' || routes['6153059771']?.preset !== 'lingsnow') throw new Error('parseRouteMap mismatch')
  const hc = rt.harnessConfig({
    inboundPreempt: true, preset: 'lingsnow', includeMetadataPrefix: true, routingMode: 'conversation',
    channelRoutes: 'telegram:guest, qq:guest, weixin:guest', conversationRoutes: 'B4C6E62A8A0919E62678494F20F30530:lingsnow, 6153059771:lingsnow',
  })
  if (!hc.includeMetadataPrefix || hc.agent?.default?.preset !== 'lingsnow' || hc.routing?.mode !== 'conversation') throw new Error('harnessConfig migration mismatch')
  if (hc.routing.overrides.channel.telegram.preset !== 'guest' || hc.routing.overrides.conversation['6153059771'].preset !== 'lingsnow') throw new Error('harnessConfig routes mismatch')
  const tc = rt.telegramAdapterConfig({ format: 'html' })
  if (tc.formatting?.mode !== 'html') throw new Error('telegramAdapterConfig format mismatch')
  for (const [name, ok] of Object.entries(rt.PATCH_MARKERS)) if (!ok) throw new Error('telegram patch marker missing: ' + name)
  // 分段 / 限速 / HTML 增量（直接测 vendor 源，避免把测试辅助打进运行时包）
  const seg = await import('../vendor/wsz987/channel-harness/lib/segmented-reply.js')
  const html = await import('../vendor/wsz987/channel-telegram/lib/incremental-html.js')
  const { StreamThrottle } = await import('../vendor/wsz987/channel-telegram/lib/stream-throttle.js')
  const proc = seg.buildProcessHtml({
    reasoning: 'a'.repeat(2000),
    tools: [{ name: 'web_search', status: 'done', startedAt: 0, endedAt: 1200 }],
    sendReasoning: true,
    reasoningMaxChars: 1500,
  })
  if (!proc.includes('<blockquote expandable>') || !proc.includes('web_search') || !proc.includes('完成')) throw new Error('process html mismatch')
  if (!seg.shouldShowProcess({ sendReasoning: false, showToolCalls: true, reasoning: '', tools: [{ name: 'x' }] })) throw new Error('shouldShowProcess tools')
  if (seg.shouldShowProcess({ sendReasoning: false, showToolCalls: false, reasoning: 'x', tools: [] })) throw new Error('shouldShowProcess empty')
  const th = new StreamThrottle({ isGroup: false, minIntervalMs: 1200 })
  th.mark(1000)
  if (th.waitMs(1500) <= 0) throw new Error('throttle min interval')
  const wait429 = th.onRateLimit(2, 2000)
  if (wait429 < 2000) throw new Error('429 backoff too short')
  const built = html.buildIncrementalHtml('hello **world**\n\n```\ncode', 3800)
  if (!built.html.includes('<b>') && !built.html.includes('world')) { /* may escape if render fails */ }
  if (html.openFenceCount('```\nx') !== 1) throw new Error('open fence')
  const split = html.splitClosedTail('para1\n\n' + 'x'.repeat(4000), 3800)
  if (!split.overflow || split.closed.length > 3800) throw new Error('3800 split')
  const chunks = html.buildFinalHtmlChunks('**hi**')
  if (!Array.isArray(chunks) || !chunks[0]) throw new Error('final html chunks')
  // Draft fallback: StreamingReply falls back when sendMessageDraft throws
  const { TelegramStreamingReply } = await import('../vendor/wsz987/channel-telegram/lib/streaming-reply.js')
  const { TelegramApiError } = await import('../vendor/wsz987/channel-telegram/lib/api-error.js')
  let draftCalls = 0, sendCalls = 0, editCalls = 0
  const fakeUp = {
    async sendMessageDraft() { draftCalls++; throw new TelegramApiError('sendMessageDraft', { ok: false, error_code: 400, description: 'Bad Request: TEXTDRAFT_PEER_INVALID' }) },
    async sendMessage(_c, text) { sendCalls++; return { messageId: String(100 + sendCalls), text } },
    async editMessageText(_c, _id, text) { editCalls++; return { text } },
  }
  // TelegramApiError ctor may differ — soft-fallback test with generic error
  const fakeUp2 = {
    async sendMessageDraft() { draftCalls++; const e = new Error('draft unavailable'); e.kind = 'format'; throw e },
    async sendMessage(_c, text) { sendCalls++; return { messageId: '1', text } },
    async editMessageText(_c, id, text, fmt) { editCalls++; return { messageId: id, text, fmt } },
  }
  draftCalls = sendCalls = editCalls = 0
  const reply = new TelegramStreamingReply(fakeUp2, { conversationId: '1', conversationType: 'dm' }, '…', { formatting: { mode: 'html' }, streamMode: 'draft', kind: 'text' })
  await reply.start()
  if (!reply.draftFailed || reply.useDraft) throw new Error('draft should fall back to edit mode, draftCalls=' + draftCalls)
  await reply.finish({ text: '回退后的正文' })
  if (sendCalls !== 1) throw new Error('draft fallback must deliver via one real message, send=' + sendCalls)
  console.log('telegram runtime ok: patch markers', Object.keys(rt.PATCH_MARKERS).join('/'), '; segments; throttle; html; draft-fallback [token not printed]')
  // ── 去重：step/end 紧接 turn/end（不等待）时，每个正文段只送达一次 ──
  {
    const { ReplyRouter } = await import('../vendor/wsz987/channel-harness/lib/reply-router.js')
    const finishes = []
    const sends = []
    const adapter = {
      capabilities: { text: true, streaming: 'edit' },
      resolveStreamingMode: () => 'edit',
      async createReply(_t, opts) {
        const kind = opts?.kind || 'text'
        return {
          async replace() {}, async append() {}, async fail() {},
          async finish(m) { await new Promise((r) => setTimeout(r, 5)); finishes.push({ kind, text: m?.text ?? '' }) },
        }
      },
      async send(_t, m) { sends.push(m.text) },
    }
    const router = new ReplyRouter({
      config: { reply: { updateIntervalMs: 0, sendReasoning: false, showToolCalls: true, reasoningMaxChars: 1500 }, maxTextLength: 4096 },
      replyContexts: { getTurn: () => ({ conversationType: 'dm' }), releaseTurn() {} },
      getBinding: () => ({ sessionId: 's1', channelId: 'telegram', accountId: 'main', conversationId: '1' }),
      getAdapter: () => adapter,
      logger: { warn() {}, error() {}, info() {} },
    })
    const session = { id: 's1' }
    const agent = { id: 'a1', session }
    router.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
    // step 1: tool call, no text
    router.onSessionEvent(session, { type: 'step/start', data: { turn: 1, step: 1 } })
    router.onSessionEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_search' } })
    router.onSessionEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } })
    router.onSessionEvent(session, { type: 'step/end', data: { turn: 1, step: 1 } })
    // step 2: streamed text, then step/end + turn/end back-to-back
    router.onSessionEvent(session, { type: 'step/start', data: { turn: 1, step: 2 } })
    router.onAssistantStream(agent, { type: 'start', attemptId: 'x', turn: 1 })
    for (const piece of ['第一段', '正文', '内容']) router.onAssistantStream(agent, { type: 'chunk', attemptId: 'x', chunk: { type: 'text-delta', text: piece } })
    router.onAssistantStream(agent, { type: 'end', attemptId: 'x' })
    router.onSessionEvent(session, { type: 'step/end', data: { turn: 1, step: 2 } })
    router.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((r) => setTimeout(r, 200))
    const texts = finishes.filter((f) => f.kind === 'text' && f.text)
    const procs = finishes.filter((f) => f.kind === 'process' && f.text)
    if (texts.length !== 1 || sends.length !== 0) throw new Error(`text segment must be delivered exactly once, got finishes=${texts.length} sends=${sends.length}`)
    if (procs.length !== 1 || !procs[0].text.includes('web_search')) throw new Error('process segment must be delivered once before text')
    if (finishes.indexOf(procs[0]) > finishes.indexOf(texts[0])) throw new Error('segment order must be process → text')
    console.log('telegram segments ok: process → text, each delivered once (step/end + turn/end race)')
  }
  // ── 自动模式：私聊也走 edit（同一条消息），避免 draft+sendMessage 双气泡 ──
  {
    const calls = []
    const up = {
      async sendMessageDraft() { calls.push(['draft']); return true },
      async sendMessage(_c, text, o) { calls.push(['send', text, o?.replyToMessageId]); return { messageId: '1' } },
      async editMessageText(_c, id, text, fmt) { calls.push(['edit', id, text, fmt?.parseMode]); return {} },
    }
    const r = new TelegramStreamingReply(up, { conversationId: '1', conversationType: 'dm', replyToMessageId: 42 }, '…', { formatting: { mode: 'html' }, streamMode: 'auto', kind: 'text' })
    await r.start()
    await r.replace({ text: '你好，**世界** …' })
    await r.finish({ text: '你好，**世界** …' })
    if (calls.some((c) => c[0] === 'draft')) throw new Error('auto must not use sendMessageDraft')
    const sendsA = calls.filter((c) => c[0] === 'send')
    if (sendsA.length !== 1) throw new Error('short auto reply must be exactly one real message')
    const lastA = calls.filter((c) => c[0] !== 'draft').at(-1)
    const lastText = String(lastA[0] === 'send' ? lastA[1] : lastA[2])
    if (!lastText.includes('<b>世界</b>')) throw new Error('final must be HTML')
    if (lastText.includes('…')) throw new Error('trailing streaming ellipsis must be stripped from final')
    console.log('telegram auto ok: DM edit-in-place only; no second send; ellipsis stripped')
  }
  // ── process 段：已是 HTML，必须带 parse_mode=HTML 且不再次转义标签 ──
  {
    const calls = []
    const up = {
      async sendMessageDraft() { calls.push(['draft']); return true },
      async sendMessage(_c, text, o) { calls.push(['send', text, o?.replyToMessageId]); return { messageId: 'p1' } },
      async editMessageText(_c, id, text, fmt) { calls.push(['edit', id, text, fmt?.parseMode]); return {} },
    }
    const html = '<blockquote expandable>\n🔧 mm_send_image · 完成（1.3s）\n</blockquote>'
    const r = new TelegramStreamingReply(up, { conversationId: '1', conversationType: 'dm', replyToMessageId: 42 }, '…', { formatting: { mode: 'html' }, streamMode: 'auto', kind: 'process' })
    await r.start()
    await r.replace({ text: html })
    await r.finish({ text: html })
    if (calls.some((c) => c[0] === 'draft')) throw new Error('process must not use draft')
    const edits = calls.filter((c) => c[0] === 'edit')
    if (!edits.length || edits.at(-1)[3] !== 'HTML') throw new Error('process must edit with parse_mode HTML')
    if (String(edits.at(-1)[2]).includes('&lt;blockquote') || !String(edits.at(-1)[2]).includes('<blockquote expandable>'))
      throw new Error('process HTML tags must not be escaped')
    if (calls.filter((c) => c[0] === 'send').length !== 1) throw new Error('process must keep one bubble (placeholder + edits)')
    console.log('telegram process ok: expandable blockquote sent as HTML, tags not escaped')
  }
  // ── 强制草稿：延迟 in-flight draft + finalize 后不得再发 draft；且无 messageId 时才 sendMessage ──
  {
    const calls = []
    let draftGate = null
    const up = {
      async sendMessageDraft(_c, id, text) {
        calls.push(['draft', id, text])
        if (draftGate) await draftGate
        return true
      },
      async sendMessage(_c, text, o, fmt) {
        calls.push(['send', text, o?.replyToMessageId, fmt?.parseMode])
        return { messageId: '9' }
      },
      async editMessageText() { calls.push(['edit']); return {} },
    }
    const r = new TelegramStreamingReply(up, { conversationId: '1', conversationType: 'dm', replyToMessageId: 42 }, '…', {
      formatting: { mode: 'html' }, streamMode: 'draft', kind: 'text',
    })
    await r.start()
    let release
    draftGate = new Promise((res) => { release = res })
    const mid = r.replace({ text: '流式正文内容足够长以便通过最小增量检查一二三四五六七八九十' })
    await new Promise((r) => setTimeout(r, 30))
    r.throttle.onRateLimit(0.05)
    const done = r.finish({ text: '流式正文内容足够长以便通过最小增量检查一二三四五六七八九十' })
    await new Promise((r) => setTimeout(r, 20))
    release()
    draftGate = null
    await mid.catch(() => { })
    await done
    await new Promise((r) => setTimeout(r, 80))
    await r.replace({ text: '不应再出现的草稿' })
    await new Promise((r) => setTimeout(r, 50))
    const sendIdx = calls.findIndex((c) => c[0] === 'send')
    if (sendIdx < 0) throw new Error('draft mode must sendMessage the final once')
    if (calls.slice(sendIdx + 1).some((c) => c[0] === 'draft')) throw new Error('no draft calls after final sendMessage')
    if (calls.some((c) => c[0] === 'edit')) throw new Error('pure draft mode must not create/edit a real preview')
    if (calls.filter((c) => c[0] === 'send').length !== 1) throw new Error('draft finalize must be exactly one sendMessage')
    if (calls.some((c) => c[0] === 'draft' && c[2] === '')) throw new Error('must not clear draft with empty text (Thinking…)')
    if (calls[sendIdx][3] !== 'HTML') throw new Error('final must be HTML')
    console.log('telegram draft ok: in-flight awaited; no draft after send; no real preview; no empty-clear')
  }
  // ── edit 预览已存在时，finalize 必须 edit 而非再 send（防双真实消息）──
  {
    const calls = []
    const up = {
      async sendMessageDraft() { calls.push(['draft']); return true },
      async sendMessage(_c, text, o) { calls.push(['send', text, o?.replyToMessageId]); return { messageId: String(100 + calls.filter(x=>x[0]==='send').length) } },
      async editMessageText(_c, id, text, fmt) { calls.push(['edit', id, text, fmt?.parseMode]); return {} },
    }
    const r = new TelegramStreamingReply(up, { conversationId: '1', conversationType: 'dm', replyToMessageId: 42 }, '…', { formatting: { mode: 'html' }, streamMode: 'edit', kind: 'text' })
    await r.start()
    // Bypass throttle so preview lands.
    r.throttle.nextAt = 0
    await r.replace({ text: '预览正文，长度超过二十个字符以便立即发出第一条气泡 …' })
    await r.finish({ text: '最终正文' })
    const sends = calls.filter((c) => c[0] === 'send')
    const edits = calls.filter((c) => c[0] === 'edit')
    if (sends.length !== 1) throw new Error(`edit mode must keep one real message, sends=${sends.length}`)
    if (!edits.length || !String(edits.at(-1)[2]).includes('最终正文')) throw new Error('finalize must edit preview into final')
    console.log('telegram edit-final ok: preview edited in place, no second sendMessage')
  }
  // ── 流式节奏：路由 + 真实 StreamingReply；首条气泡 ≤500ms，结束前有多次编辑，间隔 ≥ ~0.55s ──
  {
    const { ReplyRouter } = await import('../vendor/wsz987/channel-harness/lib/reply-router.js')
    const t0 = Date.now()
    const calls = []
    let nextId = 500
    const up = {
      async sendMessageDraft() { calls.push({ op: 'draft', t: Date.now() - t0 }); return true },
      async sendMessage(_c, text, o) { await new Promise((r) => setTimeout(r, 40)); calls.push({ op: 'send', t: Date.now() - t0, text, reply: o?.replyToMessageId }); return { messageId: String(nextId++) } },
      async editMessageText(_c, id, text) { await new Promise((r) => setTimeout(r, 40)); calls.push({ op: 'edit', t: Date.now() - t0, id, text }); return {} },
    }
    const adapter = {
      capabilities: { text: true, streaming: 'edit' },
      resolveStreamingMode: () => 'edit',
      async createReply(target, opts) {
        const r = new TelegramStreamingReply(up, target, '…', { formatting: { mode: 'html' }, streamMode: 'auto', kind: opts?.kind || 'text' })
        await r.start()
        return r
      },
      async send() { calls.push({ op: 'legacy-send' }) },
    }
    const router = new ReplyRouter({
      config: { reply: { updateIntervalMs: 200, sendReasoning: false, showToolCalls: true, reasoningMaxChars: 1500 }, maxTextLength: 4096 },
      replyContexts: { getTurn: () => ({ conversationType: 'dm', replyToMessageId: 77 }), releaseTurn() {} },
      getBinding: () => ({ sessionId: 's2', channelId: 'telegram', accountId: 'main', conversationId: '9', conversationType: 'dm' }),
      getAdapter: () => adapter,
      logger: { warn() {}, error() {}, info() {} },
    })
    const session = { id: 's2' }
    const agent = { id: 'a2', session }
    router.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
    router.onSessionEvent(session, { type: 'step/start', data: { turn: 1, step: 1 } })
    router.onAssistantStream(agent, { type: 'start', attemptId: 'y', turn: 1 })
    const firstDeltaAt = Date.now() - t0
    let full = ''
    for (let i = 0; i < 30; i++) {
      const piece = `第${i}句流式输出内容。`
      full += piece
      router.onAssistantStream(agent, { type: 'chunk', attemptId: 'y', chunk: { type: 'text-delta', index: 0, text: piece } })
      await new Promise((r) => setTimeout(r, 100))
    }
    router.onAssistantStream(agent, { type: 'end', attemptId: 'y' })
    const finishAt = Date.now() - t0
    router.onSessionEvent(session, { type: 'step/end', data: { turn: 1, step: 1 } })
    router.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((r) => setTimeout(r, 1500))
    const sends = calls.filter((c) => c.op === 'send')
    const editsBefore = calls.filter((c) => c.op === 'edit' && c.t <= finishAt)
    if (calls.some((c) => c.op === 'draft' || c.op === 'legacy-send')) throw new Error('auto stream must use edit path only')
    if (sends.length !== 1) throw new Error(`stream must be one bubble, sends=${sends.length}`)
    if (sends[0].t - firstDeltaAt > 500) throw new Error(`first bubble too late: ${sends[0].t - firstDeltaAt}ms`)
    if (sends[0].reply !== 77) throw new Error('first bubble must carry the reply quote')
    if (editsBefore.length < 3) throw new Error(`expected ≥3 live edits before finalize, got ${editsBefore.length}`)
    const live = [sends[0], ...editsBefore]
    for (let i = 1; i < live.length; i++) if (live[i].t - live[i - 1].t < 500) throw new Error(`edits too dense: ${live[i].t - live[i - 1].t}ms`)
    const lastEdit = calls.filter((c) => c.op === 'edit').at(-1)
    if (!lastEdit || !lastEdit.text.includes('第29句') || lastEdit.id !== sends[0].id && lastEdit.id !== '500') throw new Error('final must edit the same bubble with full text')
    console.log(`telegram live ok: first bubble +${sends[0].t - firstDeltaAt}ms, ${editsBefore.length} edits during generation, final edited in place`)
  }
  // ── 表格 / 特殊块 ──
  {
    const { renderHtml } = await import('../vendor/wsz987/channel-telegram/lib/render/html.js')
    const narrow = renderHtml('| 名称 | 状态 |\n|---|---|\n| `foo` | ✅ |\n| 中文**粗** | ❌ |\n').join('')
    if (!narrow.startsWith('<pre>') || !narrow.includes('│') || narrow.includes('**') || narrow.includes('`')) throw new Error('narrow table must be an aligned <pre> table without inline markdown')
    const rows = narrow.replace(/<\/?pre>/g, '').split('\n')
    if (rows.length !== 4) throw new Error('table must keep one line per row, got ' + rows.length)
    const wide = renderHtml('| 字段一 | 字段二 | 字段三 |\n|---|---|---|\n| 很长很长很长的内容甲 | 很长很长很长的内容乙 | 很长很长很长的内容丙 |\n').join('')
    if (wide.includes('<pre>') || !wide.includes('<b>很长很长很长的内容甲</b>') || !wide.includes('字段二：')) throw new Error('wide table must fall back to records')
    const code = renderHtml('```ts copy\nconst a = 1\n```').join('')
    if (!code.includes('class="language-ts"') || code.includes('copy')) throw new Error('code fence language must be the first info token')
    const misc = renderHtml('# 标题\n\n- a\n  - b\n\n> 引用\n\n---\n\n[x](https://e.x)').join('')
    if (!misc.includes('<b>标题</b>') || !misc.includes('  ◦ b') || !misc.includes('<blockquote>') || !misc.includes('──') || !misc.includes('<a href="https://e.x">')) throw new Error('heading/list/quote/rule/link rendering')
    const { buildIncrementalHtml } = await import('../vendor/wsz987/channel-telegram/lib/incremental-html.js')
    const live = buildIncrementalHtml('前文\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    if (live.html.includes('<pre>') || !live.html.includes('| a | b |')) throw new Error('open table at live edge must stay pending (plain)')
    const closedT = buildIncrementalHtml('前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n后文')
    if (!closedT.html.includes('<pre>')) throw new Error('closed table must render')
    console.log('telegram render ok: aligned/record tables, code language, lists, quote, rule, link; pending table at live edge')
  }
}

// ── 启动门控：挑一个本机尚未安装、且需要安装的组件，启用必须被拒绝（409）且不落盘──
let gateError = null
try {
  if (!ownState) {
    console.log('skip launch gate check (DSH_WORKBENCH_DATA_DIR / DSH_WORKBENCH_SETTINGS_FILE set externally)')
  } else {
    const listed = await call('GET', undefined, '/components')
    const target = (listed.json.components || []).find((c) => c.kind === 'component' && c.needsInstall && !c.installed && !c.builtin)
    if (!target) {
      console.log('skip launch gate check: every installable component is already installed on this machine')
    } else {
      const key = target.id + 'Enabled'
      if (target.status === 'on' || target.status === 'connected') throw new Error(target.id + ' is not installed but was launched')
      if (!String(target.launchBlocked || '').includes('安装完成后可启动')) throw new Error(target.id + ' should report launchBlocked, got ' + target.launchBlocked)
      const on = await call('POST', { [key]: true })
      if (on.status !== 409 || !String(on.json.error).includes('安装完成后可启动')) throw new Error('enabling uninstalled ' + target.id + ' must be 409, got ' + on.status + ' ' + on.json.error)
      if ((await call('GET')).json.value[key] === true) throw new Error('rejected enable must not be saved')
      const again = (await call('GET', undefined, '/components')).json.components.find((c) => c.id === target.id)
      if (again.status === 'on' || again.status === 'connected') throw new Error('rejected enable must not launch ' + target.id)
      console.log('launch gate ok: uninstalled', target.id, 'not started; enable rejected (409):', on.json.error)
    }
  }
} catch (error) {
  gateError = error
}

// ── 卸载：跑完 ctx.effect 的清理（停组件、子进程、GameBot body、退出钩子）──
for (const off of disposers.reverse()) await off()
rmSync(scratch, { recursive: true, force: true })
if (gateError) throw gateError
console.log(`disposed ${disposers.length} effects; smoke ok`)
