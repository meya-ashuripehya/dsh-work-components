/**
 * 表情包同源接口（设置页）。修改请求拒绝 cross-site。
 *   GET    /stickers                 包 + 贴纸列表 + stats
 *   POST   /stickers/packs           新建包
 *   PUT    /stickers/packs/:id       重命名
 *   DELETE /stickers/packs/:id       删包（级联贴纸）
 *   POST   /stickers/items           导入（path 或 base64）
 *   PUT    /stickers/items/:id       改 tags/aliases/pack/emoji
 *   DELETE /stickers/items/:id       删除贴纸
 *   GET    /stickers/file/:id        贴纸字节（缩略图）
 *   GET    /stickers/recent          最近缓冲（可选 sessionId）
 *   DELETE /stickers/recent          清空缓冲
 */
import { readFileSync } from 'node:fs'
import {
  StickersError,
  clearRecent,
  createPack,
  deletePack,
  deleteSticker,
  listRecent,
  loadCatalog,
  readStickerBytes,
  renamePack,
  saveSticker,
  updateSticker,
} from './store.mjs'

const IMPORT_BODY_LIMIT = 6 * 1024 * 1024

function refuseCrossSite(req) {
  return req.headers['sec-fetch-site'] === 'cross-site'
}

function readBodyLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function mediaFromName(name, fallback) {
  const n = String(name || '').toLowerCase()
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.webp')) return 'image/webp'
  if (n.endsWith('.gif')) return 'image/gif'
  return fallback || ''
}

/** @returns {Promise<boolean>} */
export async function handleStickersApi(req, res, sub, helpers) {
  const { sendJson, readBody } = helpers
  const url = new URL(req.url ?? '/', 'http://local')
  const body = async () => JSON.parse(await readBody(req) || '{}')

  try {
    if (sub === '/stickers' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...(await loadCatalog()) })
      return true
    }

    if (sub === '/stickers/recent' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') || ''
      sendJson(res, 200, { ok: true, ...(await listRecent(sessionId || undefined)) })
      return true
    }

    if (req.method !== 'GET' && refuseCrossSite(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      return true
    }

    if (sub === '/stickers/recent' && req.method === 'DELETE') {
      const input = await body().catch(() => ({}))
      const sessionId = input.sessionId === undefined ? '*' : input.sessionId
      sendJson(res, 200, { ok: true, ...(await clearRecent(sessionId)) })
      return true
    }

    if (sub === '/stickers/packs' && req.method === 'POST') {
      const input = await body()
      sendJson(res, 200, { ok: true, ...(await createPack(input)), ...(await loadCatalog()) })
      return true
    }

    const packMatch = /^\/stickers\/packs\/([^/]+)$/.exec(sub)
    if (packMatch) {
      const id = decodeURIComponent(packMatch[1])
      if (req.method === 'PUT') {
        sendJson(res, 200, { ok: true, ...(await renamePack(id, await body())), ...(await loadCatalog()) })
        return true
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { ok: true, ...(await deletePack(id)), ...(await loadCatalog()) })
        return true
      }
    }

    if (sub === '/stickers/items' && req.method === 'POST') {
      // 导入可能带 base64，单独放宽 body 上限
      const raw = await readBodyLimited(req, IMPORT_BODY_LIMIT)
      let input
      try { input = JSON.parse(raw || '{}') } catch {
        sendJson(res, 400, { ok: false, error: '请求不是 JSON' })
        return true
      }
      const path = String(input.path || '').trim()
      const b64 = String(input.base64 || input.data || '').trim()
      let result
      if (path) {
        result = await saveSticker({
          path,
          pack: input.pack,
          tags: input.tags,
          aliases: input.aliases,
          emoji: input.emoji,
          source: { channel: 'import', originalName: input.originalName || '' },
        })
      } else if (b64) {
        const cleaned = b64.replace(/^data:[^;]+;base64,/, '')
        const buf = Buffer.from(cleaned, 'base64')
        const mediaType = String(input.mediaType || mediaFromName(input.originalName, 'image/png')).trim()
        result = await saveSticker({
          data: buf,
          mediaType,
          originalName: input.originalName || 'import',
          pack: input.pack,
          tags: input.tags,
          aliases: input.aliases,
          emoji: input.emoji,
          source: { channel: 'import', originalName: input.originalName || '' },
        })
      } else {
        sendJson(res, 400, { ok: false, error: '请提供 path 或 base64' })
        return true
      }
      sendJson(res, 200, { ok: true, ...result, ...(await loadCatalog()) })
      return true
    }

    const itemMatch = /^\/stickers\/items\/([^/]+)$/.exec(sub)
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1])
      if (req.method === 'PUT') {
        sendJson(res, 200, { ok: true, ...(await updateSticker(id, await body())), ...(await loadCatalog()) })
        return true
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { ok: true, ...(await deleteSticker(id)), ...(await loadCatalog()) })
        return true
      }
    }

    const fileMatch = /^\/stickers\/file\/([^/]+)$/.exec(sub)
    if (fileMatch && req.method === 'GET') {
      const id = decodeURIComponent(fileMatch[1])
      const { sticker, data } = await readStickerBytes(id)
      res.writeHead(200, {
        'Content-Type': sticker.mediaType || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=3600',
      })
      res.end(data)
      return true
    }

    return false
  } catch (error) {
    const status = stickersErrorStatus(error)
    sendJson(res, status, { ok: false, error: String(error?.message || error) })
    return true
  }
}

export function stickersErrorStatus(error) {
  if (error instanceof StickersError) return error.status || 400
  return error?.status ?? 400
}

export { readFileSync }
