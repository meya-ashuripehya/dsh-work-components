// 本地冒烟：用假 ctx 挂载宿主半边；主路径 mm_send_image。render 只能是 text+image（无 mm）；MmCard 数据在 presentationMeta；并把 PNG 写到 lib/smoke.png。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const disposers = []
const ctx = {
  ...services,
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
