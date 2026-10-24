/**
 * 聊天室附件（图片 / 文件 / 语音）：
 *   - 落盘 rooms/<roomId>/attachments/<aid><ext> + index.json（sha256 去重，永久保留，删除房间时才一并删除）。
 *   - 单个附件上限 25 MB（ATTACH_MAX_BYTES），合计不设上限；超限时给出正式中文提示（oversizeNotice）。
 *   - 图片另存一份到 DSH 附件服务（attachments.saveImage）得到 ImageAttachmentRef，供模型调用时作 image 块。
 *   - 提示词里的图片窗口：视觉成员最多 IMAGE_WINDOW（9）张真图（最新的 9 张），更早的为一行占位，
 *     可用 view_attachment(id) 取回；非视觉成员只给占位（含缓存的描述）。见 planImageWindow / attachmentLine。
 *   - 非图片文件只给占位，read_attachment(id) 分页读取文本（文本类直接读；docx 解压取正文；PDF 用 pdftotext）。
 *   - Telegram 入站：telegramFilesOf(message) 把 photo / document / voice / audio / video / video_note / animation / sticker
 *     映射为待下载的文件描述；同一相册（media_group_id）由 createMediaGroupBuffer 合并成一条消息。
 */
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { basename, extname, join } from 'node:path'
import { pageText } from './tool-results.mjs'

export const ATTACH_MAX_BYTES = 25 * 1024 * 1024
export const IMAGE_WINDOW = 9
export const ATTACH_ID_RE = /^a[a-f0-9]{10,24}$/

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.log': 'text/plain', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.m4a': 'audio/m4a',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.weba': 'audio/webm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.tgs': 'application/x-tgsticker',
}
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).reverse().map(([e, m]) => [m, e]))
EXT_BY_MIME['image/jpeg'] = '.jpg'
EXT_BY_MIME['audio/ogg'] = '.ogg'
EXT_BY_MIME['audio/mpeg'] = '.mp3'

/** DSH 附件服务接受、并可作为模型 image 块的图片类型。 */
export const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.cs', '.go', '.rs', '.sql', '.sh', '.ps1', '.bat', '.cmd',
  '.toml', '.ini', '.cfg', '.conf', '.svg', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.lua', '.kt', '.swift', '.srt', '.vtt', '.env',
])

export function mimeFromName(name) {
  return MIME_BY_EXT[extname(String(name ?? '')).toLowerCase()] || 'application/octet-stream'
}

export function sanitizeName(value, fallback = 'file') {
  const base = basename(String(value ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  if (!base || base === '.' || base === '..') return fallback
  return base.length > 120 ? base.slice(0, 120) : base
}

/** image | audio | video | file。SVG 当作文本文件（不当图片发给模型）。 */
export function kindOf(mediaType, name = '') {
  const mt = String(mediaType || '').toLowerCase() || mimeFromName(name)
  if (mt === 'image/svg+xml') return 'file'
  if (mt.startsWith('image/')) return 'image'
  if (mt.startsWith('audio/')) return 'audio'
  if (mt.startsWith('video/')) return 'video'
  return 'file'
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 超过单个附件上限时的正式中文提示（房间与 Telegram 共用）。 */
export function oversizeNotice(name, bytes, max = ATTACH_MAX_BYTES) {
  const size = Number(bytes) > 0 ? `大小为 ${formatBytes(bytes)}，` : ''
  return `附件「${sanitizeName(name, '未命名文件')}」${size}超过单个附件 ${Math.round(max / 1024 / 1024)} MB 的上限，未予接收。请压缩或拆分后重新发送。`
}

/** 单个附件大小检查：返回 null 表示通过，否则为提示文字。 */
export function checkSize(name, bytes, max = ATTACH_MAX_BYTES) {
  return Number(bytes) > max ? oversizeNotice(name, bytes, max) : null
}

export function isTextLike(name, mediaType) {
  const ext = extname(String(name || '')).toLowerCase()
  const mt = String(mediaType || '').toLowerCase()
  return TEXT_EXT.has(ext) || mt.startsWith('text/') || /json|xml|yaml|javascript|csv/.test(mt)
}

/** 房间消息里保存的附件快照（不含落盘路径）。 */
export function snapshotOf(meta) {
  if (!meta) return null
  const out = { id: meta.id, kind: meta.kind, name: meta.name, mediaType: meta.mediaType, bytes: meta.bytes }
  if (meta.width) out.width = meta.width
  if (meta.height) out.height = meta.height
  if (meta.ref) out.ref = meta.ref
  if (meta.description) out.description = meta.description
  if (meta.transcript) out.transcript = meta.transcript
  if (meta.transcriptError) out.transcriptError = meta.transcriptError
  // 视频理解（Gemini 远端文件 uri 不进快照）
  for (const k of VIDEO_SNAPSHOT_KEYS) if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') out[k] = meta[k]
  return out
}
/** 视频附件 / 视频链接在消息快照里带的字段（界面卡片据此显示「描述中… / 内容描述 / 失败原因」）。 */
export const VIDEO_SNAPSHOT_KEYS = ['videoStatus', 'videoError', 'describedBy', 'durationSec', 'link', 'linkKind']

/** 视频时长：83 → "1:23"。 */
export function videoClock(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 视频行（给 AI）。videoStatus 缺省 = 视频理解未开启（旧行）。失败原因只给用户看，AI 只知道「这张单子是空白的」。
 *   mode 'real'：该成员本轮直接收到视频（视频输入模态）。
 */
export function videoLine(a, { mode = 'stub', who = '' } = {}) {
  const label = a.link ? `video link #${a.id} ${a.link}` : `video #${a.id} ${a.name}`
  const dur = Number(a.durationSec) > 0 ? ' ' + videoClock(a.durationSec) : (a.link ? '' : ' ' + formatBytes(a.bytes))
  const head = `${label}${dur}${who ? ', ' + who : ''}`
  if (mode === 'real') return `[${head} — attached below; you are watching it yourself]`
  const desc = a.description ? String(a.description).replace(/\s+/g, ' ').trim().slice(0, 2000) : ''
  if (desc) return `[${head} · 内容描述：${desc}] (Gemini watched it and wrote this, not you; watch_video("${a.id}", question) asks Gemini about details or a time range)`
  if (a.videoStatus === 'pending') return `[${head}; Gemini is still watching it] (watch_video("${a.id}", question) can ask about it)`
  if (a.videoStatus === 'failed') return `[${head}] (Gemini was asked to watch it at the world's console and this sheet came back blank; watch_video("${a.id}", question) can try again)`
  if (a.link) return `[${head}]`
  return `[${head}; stored as a file, not viewable]`
}

// ── 极简 zip 读取（docx 正文用），只依赖 node:zlib ──
export function zipEntry(buf, wanted) {
  const b = Buffer.from(buf)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) { if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
  if (eocd < 0) return null
  const count = b.readUInt16LE(eocd + 10)
  let p = b.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null
    const method = b.readUInt16LE(p + 10)
    const csize = b.readUInt32LE(p + 20)
    const nlen = b.readUInt16LE(p + 28)
    const xlen = b.readUInt16LE(p + 30)
    const clen = b.readUInt16LE(p + 32)
    const local = b.readUInt32LE(p + 42)
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8')
    if (name === wanted) {
      const lnlen = b.readUInt16LE(local + 26)
      const lxlen = b.readUInt16LE(local + 28)
      const start = local + 30 + lnlen + lxlen
      const data = b.subarray(start, start + csize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      return null
    }
    p += 46 + nlen + xlen + clen
  }
  return null
}

export function docxText(buf) {
  const xml = zipEntry(buf, 'word/document.xml')
  if (!xml) return null
  return xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim()
}

function pdfToText(path, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) resolve({ ok: false, missing: err.code === 'ENOENT', error: String(err.message || err).slice(0, 200) })
      else resolve({ ok: true, text: String(stdout || '') })
    })
  })
}

/**
 * @param {(roomId: string) => string} roomDir
 * @param {{ getAttachmentService?: () => any, now?: () => number, pdfText?: (path: string) => Promise<any> }} [o]
 */
export function createAttachmentStore(roomDir, { getAttachmentService = () => null, now = () => Date.now(), pdfText = pdfToText } = {}) {
  const dirOf = (roomId) => join(roomDir(roomId), 'attachments')
  const locks = new Map()
  function withLock(roomId, fn) {
    const prev = locks.get(roomId) || Promise.resolve()
    const p = prev.then(fn, fn)
    locks.set(roomId, p.catch(() => {}))
    return p
  }
  async function readIndex(roomId) {
    try { const j = JSON.parse(await readFile(join(dirOf(roomId), 'index.json'), 'utf8')); return j && typeof j === 'object' ? { items: {}, byHash: {}, ...j } : { items: {}, byHash: {} } } catch { return { items: {}, byHash: {} } }
  }
  async function writeIndex(roomId, idx) {
    const file = join(dirOf(roomId), 'index.json')
    await writeFile(file + '.tmp', JSON.stringify(idx), 'utf8')
    await rename(file + '.tmp', file)
  }
  const pathOf = (roomId, meta) => join(dirOf(roomId), meta.id + (meta.ext || ''))

  /**
   * 保存一个附件。超过上限时抛出 { code: 'TOO_LARGE', notice }。
   * @returns {Promise<object>} meta（含 id / kind / ref?）
   */
  function save(roomId, { data, name, mediaType, source = 'local', from = null, kind } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    const cleanName = sanitizeName(name, 'file')
    const tooBig = checkSize(cleanName, buf.length)
    if (tooBig) return Promise.reject(Object.assign(new Error(tooBig), { code: 'TOO_LARGE', notice: tooBig, status: 413 }))
    if (!buf.length) return Promise.reject(Object.assign(new Error(`附件「${cleanName}」为空文件，未予接收。`), { status: 400 }))
    return withLock(roomId, async () => {
      await mkdir(dirOf(roomId), { recursive: true })
      const idx = await readIndex(roomId)
      const sha256 = createHash('sha256').update(buf).digest('hex')
      const prior = idx.byHash[sha256] && idx.items[idx.byHash[sha256]]
      if (prior) {
        try { await stat(pathOf(roomId, prior)); return { ...prior, dedupe: true } } catch {}
      }
      let mt = String(mediaType || '').split(';')[0].trim().toLowerCase()
      if (!mt || mt === 'application/octet-stream') mt = mimeFromName(cleanName)
      const k = kind || kindOf(mt, cleanName)
      const ext = (extname(cleanName).toLowerCase() || EXT_BY_MIME[mt] || '').replace(/[^.a-z0-9]/g, '').slice(0, 10)
      const id = 'a' + sha256.slice(0, 12)
      const meta = { id, kind: k, name: cleanName, mediaType: mt, bytes: buf.length, sha256, ext, createdAt: new Date(now()).toISOString(), source, ...(from ? { from } : {}) }
      await writeFile(pathOf(roomId, meta), buf)
      if (k === 'image' && MODEL_IMAGE_TYPES.has(mt)) {
        const svc = getAttachmentService?.()
        if (svc && typeof svc.saveImage === 'function') {
          try {
            const ref = await svc.saveImage({ data: new Uint8Array(buf), mediaType: mt, name: cleanName })
            if (ref?.attachmentId) {
              meta.ref = { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType || mt, bytes: Number(ref.bytes ?? buf.length), width: Number(ref.width) || 0, height: Number(ref.height) || 0, name: cleanName }
              meta.width = meta.ref.width
              meta.height = meta.ref.height
            }
          } catch (e) { meta.refError = String(e?.message || e).slice(0, 200) }
        }
      }
      idx.items[id] = meta
      idx.byHash[sha256] = id
      await writeIndex(roomId, idx)
      return { ...meta }
    })
  }

  async function get(roomId, id) {
    const aid = String(id || '').replace(/^#/, '')
    if (!ATTACH_ID_RE.test(aid)) return null
    const idx = await readIndex(roomId)
    const meta = idx.items[aid]
    return meta ? { ...meta, path: pathOf(roomId, meta) } : null
  }
  async function list(roomId) {
    return (await readIndex(roomId)).items
  }
  async function read(roomId, id) {
    const meta = await get(roomId, id)
    if (!meta) return null
    return { meta, data: await readFile(meta.path) }
  }
  function update(roomId, id, patch) {
    return withLock(roomId, async () => {
      const idx = await readIndex(roomId)
      if (!idx.items[id]) return null
      idx.items[id] = { ...idx.items[id], ...patch }
      await writeIndex(roomId, idx)
      return { ...idx.items[id] }
    })
  }

  /** 文本抽取（缓存为 <aid>.txt）。返回 { ok, text } 或 { ok: false, error }。 */
  async function extractText(roomId, meta) {
    const cache = join(dirOf(roomId), meta.id + '.extracted.txt')
    try { return { ok: true, text: await readFile(cache, 'utf8') } } catch {}
    const ext = (meta.ext || extname(meta.name || '')).toLowerCase()
    let text = null
    if (meta.kind === 'image' || meta.kind === 'audio' || meta.kind === 'video') {
      if (meta.kind === 'audio' && meta.transcript) return { ok: true, text: meta.transcript }
      return { ok: false, error: `附件 #${meta.id} 是${meta.kind === 'image' ? '图片' : meta.kind === 'audio' ? '音频' : '视频'}，没有可读取的文本。${meta.kind === 'image' ? '请改用 view_attachment。' : ''}` }
    }
    const data = await readFile(meta.path)
    if (isTextLike(meta.name, meta.mediaType)) text = data.toString('utf8').replace(/^\uFEFF/, '')
    else if (ext === '.docx') {
      try { text = docxText(data) } catch { text = null }
      if (text == null) return { ok: false, error: `无法解析 Word 文档 #${meta.id}。` }
    } else if (ext === '.pdf' || meta.mediaType === 'application/pdf') {
      const r = await pdfText(meta.path)
      if (!r.ok) return { ok: false, error: r.missing ? 'PDF 文本抽取需要 poppler 的 pdftotext，本机未找到该程序。' : `PDF 文本抽取失败：${r.error}` }
      text = r.text
    } else {
      const head = data.subarray(0, 8192)
      if (!head.includes(0)) {
        const s = data.toString('utf8')
        if (!s.includes('\uFFFD')) text = s
      }
      if (text == null) return { ok: false, error: `附件 #${meta.id}（${meta.name}，${meta.mediaType}）是二进制文件，无法按文本读取。` }
    }
    text = String(text).replace(/\u0000/g, '')
    try { await writeFile(cache, text, 'utf8') } catch {}
    return { ok: true, text }
  }

  async function readText(roomId, id, opts = {}) {
    const meta = await get(roomId, id)
    if (!meta) return { ok: false, error: `附件 ${id} 不存在` }
    const r = await extractText(roomId, meta)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, id: meta.id, name: meta.name, ...pageText(r.text, opts) }
  }

  return { save, get, list, read, update, readText, dirOf }
}

// ── 提示词中的图片窗口与占位 ──

/** 图片是否能作为真图交给模型（需要 DSH 附件服务的引用）。 */
export const isModelImage = (a) => !!(a && a.kind === 'image' && a.ref && a.ref.attachmentId)

/**
 * 选出作为真图的图片：按消息顺序收集候选（可选 skip(m) 排除，如成员自己的消息），取最新的 max 张。
 * @returns {Set<string>} 附件 id 集合
 */
export function planImageWindow(messages, { max = IMAGE_WINDOW, skip, latest = false } = {}) {
  const ids = []
  let pool = messages || []
  // latest：只看最新一条用户消息（触发本轮的那条）里的图片
  if (latest) {
    let last = null
    for (const m of pool) if (m?.kind === 'user' && !(skip && skip(m))) last = m
    pool = last ? [last] : []
  }
  for (const m of pool) {
    if (skip && skip(m)) continue
    for (const a of m.attachments || []) if (isModelImage(a) && !ids.includes(a.id)) ids.push(a.id)
  }
  const n = Math.max(0, Math.min(IMAGE_WINDOW, Number.isFinite(max) ? max : IMAGE_WINDOW))
  return new Set(n ? ids.slice(-n) : [])
}

function shortTime(ts) {
  const d = new Date(ts || 0)
  if (!Number.isFinite(d.getTime()) || !d.getTime()) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 一个附件在提示词中的一行文字。
 * @param {object} a 附件快照（可带最新 description）
 * @param {{ mode: 'real'|'stub'|'text', sender?: string, ts?: string, vision?: boolean }} o
 */
export function attachmentLine(a, { mode = 'stub', sender = '', ts = '', vision = false, relay = false } = {}) {
  const who = [sender && `from ${sender}`, shortTime(ts)].filter(Boolean).join(', ')
  const w = a.width || a.ref?.width
  const h = a.height || a.ref?.height
  const dims = w && h ? ` ${w}x${h}` : ''
  const descText = a.description ? String(a.description).replace(/\s+/g, ' ').slice(0, 600) : ''
  const desc = descText ? `; description: ${descText}` : ''
  if (a.kind === 'image') {
    if (mode === 'real') {
      if (relay && descText) return `[image #${a.id} ${a.name}${dims}${who ? ', ' + who : ''} — attached below; in case it reaches you only as a text marker, description by ${a.describedBy || 'someone who saw it'}: ${descText}]`
      return `[image #${a.id} ${a.name}${dims}${who ? ', ' + who : ''} — attached below]`
    }
    if (!vision) {
      const head = `[image #${a.id} ${a.name}${dims}${who ? ', ' + who : ''}`
      if (descText) return `${head}; description by ${a.describedBy || 'someone who saw it'}: ${descText}] (you can't see it; that's their description)`
      return `${head}; no description yet] (you can't see it; view_attachment("${a.id}") can fetch a description)`
    }
    if (!isModelImage(a)) return `[image #${a.id} ${a.name}${who ? ', ' + who : ''}${desc}] (this image could not be prepared for the model)`
    return `[image #${a.id} ${a.name}${dims}${who ? ', ' + who : ''}${desc}] (older image, not attached; call view_attachment("${a.id}") to look at it)`
  }
  if (a.kind === 'audio') {
    const t = a.transcript ? ' — transcript is in the message text' : (a.transcriptError ? ' — transcription failed' : '')
    return `[audio #${a.id} ${a.name} ${formatBytes(a.bytes)}${who ? ', ' + who : ''}${t}; original audio kept]`
  }
  if (a.kind === 'video') return videoLine(a, { mode, who })
  return `[file #${a.id} ${a.name} ${formatBytes(a.bytes)} (${a.mediaType})${who ? ', ' + who : ''}] (call read_attachment("${a.id}") to read its text)`
}

// ── Telegram 入站映射 ──

/**
 * Telegram 消息 → 待下载的文件描述列表。
 * @returns {{ fileId: string, uniqueId: string, kind: string, name: string, mediaType: string, size: number, voice?: boolean, transcribe?: boolean }[]}
 */
export function telegramFilesOf(m) {
  if (!m || typeof m !== 'object') return []
  const out = []
  const mid = m.message_id ?? Date.now()
  if (Array.isArray(m.photo) && m.photo.length) {
    const best = m.photo.slice().sort((a, b) => (b.file_size || b.width * b.height || 0) - (a.file_size || a.width * a.height || 0))[0]
    out.push({ fileId: best.file_id, uniqueId: best.file_unique_id || '', kind: 'image', name: `photo-${mid}.jpg`, mediaType: 'image/jpeg', size: Number(best.file_size) || 0, width: best.width, height: best.height })
  }
  if (m.document) {
    const d = m.document
    const name = sanitizeName(d.file_name || `document-${mid}${EXT_BY_MIME[d.mime_type] || ''}`)
    const mediaType = String(d.mime_type || mimeFromName(name))
    const kind = kindOf(mediaType, name)
    out.push({ fileId: d.file_id, uniqueId: d.file_unique_id || '', kind, name, mediaType, size: Number(d.file_size) || 0, ...(kind === 'audio' ? { transcribe: true } : {}) })
  }
  if (m.voice) {
    const v = m.voice
    out.push({ fileId: v.file_id, uniqueId: v.file_unique_id || '', kind: 'audio', name: `voice-${mid}.ogg`, mediaType: String(v.mime_type || 'audio/ogg'), size: Number(v.file_size) || 0, duration: v.duration, voice: true, transcribe: true })
  }
  if (m.audio) {
    const a = m.audio
    const mediaType = String(a.mime_type || 'audio/mpeg')
    const name = sanitizeName(a.file_name || `audio-${mid}${EXT_BY_MIME[mediaType] || '.mp3'}`)
    out.push({ fileId: a.file_id, uniqueId: a.file_unique_id || '', kind: 'audio', name, mediaType, size: Number(a.file_size) || 0, duration: a.duration, transcribe: true })
  }
  if (m.video_note) {
    const v = m.video_note
    out.push({ fileId: v.file_id, uniqueId: v.file_unique_id || '', kind: 'video', name: `video-note-${mid}.mp4`, mediaType: 'video/mp4', size: Number(v.file_size) || 0, duration: v.duration })
  }
  if (m.video) {
    const v = m.video
    const mediaType = String(v.mime_type || 'video/mp4')
    out.push({ fileId: v.file_id, uniqueId: v.file_unique_id || '', kind: 'video', name: sanitizeName(v.file_name || `video-${mid}${EXT_BY_MIME[mediaType] || '.mp4'}`), mediaType, size: Number(v.file_size) || 0 })
  }
  if (m.animation && !m.document) {
    const v = m.animation
    const mediaType = String(v.mime_type || 'video/mp4')
    out.push({ fileId: v.file_id, uniqueId: v.file_unique_id || '', kind: kindOf(mediaType), name: sanitizeName(v.file_name || `animation-${mid}${EXT_BY_MIME[mediaType] || '.mp4'}`), mediaType, size: Number(v.file_size) || 0 })
  }
  if (m.sticker) {
    const s = m.sticker
    const animated = s.is_animated || s.is_video
    out.push(animated
      ? { fileId: s.file_id, uniqueId: s.file_unique_id || '', kind: 'file', name: `sticker-${mid}${s.is_video ? '.webm' : '.tgs'}`, mediaType: s.is_video ? 'video/webm' : 'application/x-tgsticker', size: Number(s.file_size) || 0, emoji: s.emoji || '' }
      : { fileId: s.file_id, uniqueId: s.file_unique_id || '', kind: 'image', name: `sticker-${mid}.webp`, mediaType: 'image/webp', size: Number(s.file_size) || 0, emoji: s.emoji || '' })
  }
  return out.filter((f) => f.fileId)
}

/** Telegram 消息是否值得进房间（有文字、说明或文件）。 */
export const hasTelegramContent = (m) => typeof m?.text === 'string' || typeof m?.caption === 'string' || telegramFilesOf(m).length > 0

/**
 * 相册合并：同一 media_group_id 的多条消息在 delayMs 内合并为一条（说明文字取第一条非空的）。
 * flush(merged) 收到 { key, items: [payload…] }。
 */
export function createMediaGroupBuffer({ delayMs = 1500, flush, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const groups = new Map()
  function add(key, payload) {
    let g = groups.get(key)
    if (!g) { g = { key, items: [], timer: null }; groups.set(key, g) }
    g.items.push(payload)
    if (g.timer) clearTimer(g.timer)
    g.timer = setTimer(() => { groups.delete(key); void Promise.resolve(flush({ key, items: g.items })).catch(() => {}) }, delayMs)
    g.timer?.unref?.()
  }
  return { add, pending: () => groups.size }
}
