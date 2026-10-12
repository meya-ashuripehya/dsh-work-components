/**
 * 把工具结果里的本地文件发到 Telegram（sendDocument），并给出多模态卡片数据。
 * 模型侧只看文字说明；卡片在 presentationMeta.mm，文件引用在 presentationMeta.telegramFile。
 * 不把 type:file 塞进 DeepSeek Messages。投递挂在 ReplyRouter 原型上，不改 vendor 补丁。
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { dataDir } from '../../tools.mjs'

/** Telegram Bot API 云端 sendDocument 上限。 */
export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024
const NAME_MAX = 120
const FILES_PER_TURN = 10

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac'])
const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.cs', '.go', '.rs', '.sql', '.sh', '.ps1', '.toml', '.ini', '.cfg', '.svg',
])
const TEXT_PREVIEW_CHARS = 4000
const PREVIEW_FILE = 'file-previews.json'
const MAX_PREVIEWS = 200

export function mimeFromName(name) {
  return MIME_BY_EXT[extname(String(name ?? '')).toLowerCase()] || 'application/octet-stream'
}

/** 卡片预览类别。图片、音视频、PDF、Markdown 和 Office 文档显示内容，其余只标类型。 */
export function classifyPreview(name) {
  const ext = extname(String(name ?? '')).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (TEXT_EXT.has(ext)) return 'text'
  if (ext === '.doc' || ext === '.docx') return 'word'
  if (ext === '.xls' || ext === '.xlsx') return 'sheet'
  if (ext === '.ppt' || ext === '.pptx') return 'slides'
  if (ext === '.zip') return 'archive'
  return 'file'
}

export function textPreview(data, kind) {
  if ((kind !== 'text' && kind !== 'markdown') || !data) return ''
  const text = Buffer.from(data).toString('utf8').replace(/\u0000/g, '')
  if (text.length <= TEXT_PREVIEW_CHARS) return text
  return text.slice(0, TEXT_PREVIEW_CHARS) + '\n…'
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

function previewStorePath() {
  return join(dataDir(), PREVIEW_FILE)
}

function loadPreviews() {
  try {
    const parsed = JSON.parse(readFileSync(previewStorePath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function savePreviews(all) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(previewStorePath(), JSON.stringify(all), 'utf8')
}

/** 登记一个可预览的本地文件。只按 id 读取，不接受调用方传入的路径。 */
export function registerFilePreview(entry) {
  const id = randomBytes(16).toString('hex')
  const all = loadPreviews()
  all[id] = {
    path: entry.path,
    name: entry.name,
    mimeType: entry.mimeType,
    bytes: entry.bytes,
  }
  const ids = Object.keys(all)
  while (ids.length > MAX_PREVIEWS) delete all[ids.shift()]
  savePreviews(all)
  return id
}

export function openFilePreview(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id ?? ''))) return null
  const row = loadPreviews()[id]
  if (!row || typeof row.path !== 'string' || !existsSync(row.path)) return null
  const st = statSync(row.path)
  if (!st.isFile() || st.size !== row.bytes || st.size > TELEGRAM_FILE_MAX_BYTES) return null
  return {
    path: row.path,
    name: sanitizeFileName(row.name) || 'file',
    mimeType: typeof row.mimeType === 'string' ? row.mimeType : 'application/octet-stream',
    size: st.size,
  }
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  return 'inline; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name)
}

/** 把已登记的文件按原类型流给 DSH 窗口。支持音视频拖动所需的 Range。 */
export function streamFilePreview(req, res, id) {
  const row = openFilePreview(id)
  if (!row) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('not found')
    return
  }
  const size = row.size
  const headers = {
    'content-type': row.mimeType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'content-disposition': contentDisposition(row.name),
    'x-content-type-options': 'nosniff',
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': String(size) })
    res.end()
    return
  }
  const range = String(req.headers?.range ?? '')
  if (range) {
    const matched = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!matched) {
      res.writeHead(416, { ...headers, 'content-range': 'bytes */' + size })
      res.end()
      return
    }
    const start = Number(matched[1])
    const end = matched[2] ? Number(matched[2]) : size - 1
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size || end >= size) {
      res.writeHead(416, { ...headers, 'content-range': 'bytes */' + size })
      res.end()
      return
    }
    res.writeHead(206, {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': 'bytes ' + start + '-' + end + '/' + size,
    })
    createReadStream(row.path, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  createReadStream(row.path).pipe(res)
}

function takeCells(value, limit) {
  if (!Array.isArray(value)) return null
  const rows = value.slice(0, limit).map((row) => {
    if (!Array.isArray(row)) return null
    return row.slice(0, 10).map((cell) => String(cell ?? '').slice(0, 200))
  }).filter((row) => row && row.some((cell) => cell))
  return rows.length ? rows : null
}

function parsedPreview(raw) {
  if (!raw || typeof raw !== 'string') return {}
  let parsed
  try { parsed = JSON.parse(raw) } catch { return {} }
  const rows = takeCells(parsed?.rows, 24)
  const slides = takeCells(parsed?.slides, 12)
  return {
    ...(rows ? { rows } : {}),
    ...(slides ? { slides } : {}),
  }
}

/**
 * 多模态卡片。有图片附件时 kind 为 image，视频为 video，其余为 document。
 * file.previewKind 告诉窗口具体怎么预览。
 */
export function mmFileBlock(value) {
  const previewKind = value.previewKind || 'file'
  const image = value.image
  const kind = previewKind === 'video'
    ? 'video'
    : (previewKind === 'image' && image && image.attachmentId ? 'image' : 'document')
  const file = {
    name: value.name,
    bytes: value.bytes,
    mimeType: value.mimeType,
    previewKind,
    ...(value.previewId ? { previewId: value.previewId } : {}),
    ...(value.text ? { text: value.text } : {}),
    ...parsedPreview(value.preview),
  }
  const block = {
    type: 'mm',
    kind,
    status: 'ready',
    title: value.name,
    caption: (value.mimeType || 'application/octet-stream') + ' · ' + formatBytes(value.bytes),
    file,
  }
  if (kind === 'image') {
    block.asset = {
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width || 0,
        height: image.height || 0,
        ...(image.name ? { name: image.name } : {}),
      },
    }
  }
  return block
}

export function sanitizeFileName(value) {
  const base = basename(String(value ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim()
  if (!base || base === '.' || base === '..') return ''
  return base.length > NAME_MAX ? base.slice(0, NAME_MAX) : base
}

function fileUrlToPath(input) {
  let full = decodeURIComponent(new URL(input).pathname)
  if (/^\/[A-Za-z]:\//.test(full)) full = full.slice(1)
  return full
}

/** 读取本机文件。拒绝空路径、远程 URL、目录和超过 Telegram 上限的文件。 */
export function loadLocalFile(rawPath) {
  const input = String(rawPath ?? '').trim()
  if (!input) throw new Error('path must be a non-empty local file path')
  if (/^(https?|ftp|data):/i.test(input)) throw new Error('remote URLs are not supported; pass a local file path')
  let full = input
  if (/^file:/i.test(input)) {
    try { full = fileUrlToPath(input) } catch { throw new Error('invalid file: URL') }
  }
  full = resolve(full)
  if (!existsSync(full)) throw new Error('file not found: ' + full)
  const st = statSync(full)
  if (!st.isFile()) throw new Error('path is not a file: ' + full)
  if (st.size <= 0) throw new Error('file is empty: ' + full)
  if (st.size > TELEGRAM_FILE_MAX_BYTES) {
    throw new Error('file too large (' + st.size + ' bytes); max ' + TELEGRAM_FILE_MAX_BYTES)
  }
  const name = sanitizeFileName(basename(full))
  if (!name) throw new Error('file name is empty')
  return { full, name, data: readFileSync(full), bytes: st.size, mimeType: mimeFromName(name) }
}

function refFrom(raw) {
  if (!raw || typeof raw !== 'object') return null
  const attachmentId = String(raw.attachmentId ?? '').trim()
  const name = sanitizeFileName(raw.name)
  const bytes = Number(raw.bytes)
  const path = typeof raw.path === 'string' ? raw.path : ''
  if (!name || (!attachmentId && !path)) return null
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > TELEGRAM_FILE_MAX_BYTES) return null
  return { attachmentId, name, bytes, path }
}

export function fileRefsFromToolResult(event) {
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const ref = refFrom(raw)
    const key = ref && (ref.attachmentId || ref.path)
    if (!ref || seen.has(key)) return
    seen.add(key)
    out.push(ref)
  }
  push(event?.data?.meta?.telegramFile)
  const content = event?.data?.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'file') push(block.attachment)
    }
  }
  return out
}

function readLocalFile(ref) {
  if (!ref || !ref.path || !existsSync(ref.path)) return undefined
  const st = statSync(ref.path)
  if (!st.isFile() || st.size !== ref.bytes || st.size > TELEGRAM_FILE_MAX_BYTES) return undefined
  return readFileSync(ref.path)
}

export async function readStoredFile(attachments, ref) {
  if (!attachments || !ref || ref.bytes > TELEGRAM_FILE_MAX_BYTES) return undefined
  let streamError
  if (typeof attachments.readFileStream === 'function') {
    try {
      const chunks = []
      let total = 0
      for await (const chunk of attachments.readFileStream(ref)) {
        const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk)
        total += bytes.byteLength
        if (total > TELEGRAM_FILE_MAX_BYTES) return undefined
        chunks.push(bytes)
      }
      if (total > 0) {
        const out = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk, offset)
          offset += chunk.byteLength
        }
        return out
      }
    } catch (error) {
      streamError = error
    }
  }
  if (typeof attachments.fileHostPath === 'function') {
    const path = attachments.fileHostPath(ref)
    if (path && existsSync(path)) {
      const size = statSync(path).size
      if (size > 0 && size <= TELEGRAM_FILE_MAX_BYTES) return readFileSync(path)
      return undefined
    }
  }
  if (streamError) throw streamError
  return undefined
}

function turnOf(router, sessionId, data) {
  if (data.turn !== undefined) return data.turn
  if (router.currentTurns?.has(sessionId)) return router.currentTurns.get(sessionId)
  return router.active?.get(sessionId)?.turn
}

export function installFileDelivery(ReplyRouter) {
  const proto = ReplyRouter && ReplyRouter.prototype
  if (!proto || proto.__dshTelegramFile || typeof proto.collectToolResultImages !== 'function') return false
  proto.__dshTelegramFile = true
  const origCollect = proto.collectToolResultImages
  const origDeliver = proto.deliverTurnImages
  const origDispose = proto.dispose

  proto.collectToolResultImages = function collectToolResultImages(session, event) {
    const refs = fileRefsFromToolResult(event)
    if (refs.length) {
      const sessionId = String(session.id)
      const data = (event && event.data) || {}
      if (data.message && data.message.isError === true) return origCollect.call(this, session, event)
      const turn = turnOf(this, sessionId, data)
      if (turn !== undefined && this.options?.replyContexts?.getTurn(sessionId, turn)) {
        const key = sessionId + ':' + String(turn)
        if (!this.pendingFiles) this.pendingFiles = new Map()
        const list = this.pendingFiles.get(key) || []
        for (const ref of refs) {
          if (list.length >= FILES_PER_TURN) break
          const key = ref.attachmentId || ref.path
          if (list.some((item) => (item.attachmentId || item.path) === key)) continue
          list.push(ref)
        }
        this.pendingFiles.set(key, list)
      }
    }
    return origCollect.call(this, session, event)
  }

  proto.deliverTurnImages = async function deliverTurnImages(sessionId, turn, terminalTarget) {
    const key = sessionId + ':' + String(turn)
    const refs = this.pendingFiles ? this.pendingFiles.get(key) : undefined
    if (this.pendingFiles) this.pendingFiles.delete(key)
    if (refs && refs.length && terminalTarget && terminalTarget.adapter) {
      if (terminalTarget.adapter.capabilities && terminalTarget.adapter.capabilities.file === false) {
        this.options?.logger?.warn?.('[channel-harness] file dropped: adapter cannot send documents')
      } else {
        let attachments
        try { attachments = this.attachCtx ? this.attachCtx.get('attachments') : undefined } catch { attachments = undefined }
        for (const ref of refs) {
          try {
            let data
            if (ref.attachmentId && attachments) {
              try { data = await readStoredFile(attachments, ref) } catch { data = undefined }
            }
            if (!data) data = readLocalFile(ref)
            if (!data || data.byteLength === 0) throw new Error('empty file data')
            await terminalTarget.adapter.send(terminalTarget.target, {
              parts: [{ type: 'file', localData: data, name: ref.name, mimeType: mimeFromName(ref.name) }],
            })
          } catch (error) {
            this.options?.logger?.warn?.(
              `[channel-harness] failed to forward file '${ref.name}'`,
              error,
            )
          }
        }
      }
    }
    if (typeof origDeliver === 'function') return origDeliver.call(this, sessionId, turn, terminalTarget)
  }

  proto.dispose = function dispose() {
    this.pendingFiles?.clear()
    if (typeof origDispose === 'function') return origDispose.call(this)
  }
  return true
}
