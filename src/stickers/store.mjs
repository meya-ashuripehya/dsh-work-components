/**
 * 表情包存储：catalog.json + files/ 内容寻址；可选 recent/ 入站环形缓冲。
 * 可写状态在 dataDir()/stickers/；同一进程内读写串行；原子写 catalog。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import imageSize from 'image-size'
import { dataDir } from '../tools.mjs'

export class StickersError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'StickersError'
    this.status = status
  }
}

export const LIMITS = {
  name: 40,
  description: 200,
  tag: 20,
  tags: 12,
  alias: 40,
  aliases: 12,
  emoji: 8,
  query: 80,
  fileBytes: 5 * 1024 * 1024,
  packStickers: 200,
  recentPerSession: 5,
}

export const MEDIA_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export const EXT_BY_MEDIA = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

const DEFAULT_PACK_NAME = '默认'

let tail = Promise.resolve()
function exclusive(fn) {
  const run = tail.then(fn, fn)
  tail = run.then(() => undefined, () => undefined)
  return run
}

export function stickersRoot(root) {
  return join(root || dataDir(), 'stickers')
}

function catalogPath(root) {
  return join(stickersRoot(root), 'catalog.json')
}

function filesDir(root) {
  return join(stickersRoot(root), 'files')
}

function recentDir(root) {
  return join(stickersRoot(root), 'recent')
}

function recentIndexPath(root) {
  return join(recentDir(root), 'index.json')
}

function replaceFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(file, { force: true })
    renameSync(tmp, file)
  }
}

function emptyCatalog() {
  return { version: 1, packs: [], stickers: [] }
}

function readCatalog(root) {
  const file = catalogPath(root)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyCatalog()
    throw new StickersError('表情包目录无法读取', 500)
  }
  try {
    const data = JSON.parse(raw)
    return {
      version: 1,
      packs: Array.isArray(data?.packs) ? data.packs : [],
      stickers: Array.isArray(data?.stickers) ? data.stickers : [],
    }
  } catch {
    throw new StickersError('表情包目录无法读取', 500)
  }
}

function writeCatalog(root, catalog) {
  replaceFile(catalogPath(root), JSON.stringify({
    version: 1,
    packs: catalog.packs,
    stickers: catalog.stickers,
  }, null, 2) + '\n')
}

const now = () => new Date().toISOString()
const newId = (prefix) => prefix + '_' + randomBytes(6).toString('hex')
const sameFold = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

function text(value, label, max, required) {
  const s = String(value ?? '').trim()
  if (required && !s) throw new StickersError(label + '不能为空')
  if (s.length > max) throw new StickersError(label + '不超过 ' + max + ' 字')
  return s
}

function cleanList(value, { label, itemMax, listMax }) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? value.split(/[,，、\s]+/) : [])
  const out = []
  for (const raw of list) {
    const item = String(raw ?? '').trim()
    if (!item) continue
    if (item.length > itemMax) throw new StickersError(label + '单项不超过 ' + itemMax + ' 字')
    if (!out.includes(item)) out.push(item)
  }
  if (out.length > listMax) throw new StickersError(label + '最多 ' + listMax + ' 个')
  return out
}

function ensureDefaultPack(catalog) {
  let pack = catalog.packs.find((p) => p.name === DEFAULT_PACK_NAME)
  if (!pack) {
    const t = now()
    pack = { id: newId('pack'), name: DEFAULT_PACK_NAME, description: '', createdAt: t, updatedAt: t }
    catalog.packs.push(pack)
  }
  return pack
}

function resolvePack(catalog, packRef, { createIfMissingName = false } = {}) {
  const raw = String(packRef ?? '').trim()
  if (!raw) return ensureDefaultPack(catalog)
  const byId = catalog.packs.find((p) => p.id === raw)
  if (byId) return byId
  const byName = catalog.packs.find((p) => sameFold(p.name, raw))
  if (byName) return byName
  if (createIfMissingName) {
    const name = text(raw, '包名', LIMITS.name, true)
    if (catalog.packs.some((p) => sameFold(p.name, name))) {
      throw new StickersError('已有同名表情包')
    }
    const t = now()
    const pack = { id: newId('pack'), name, description: '', createdAt: t, updatedAt: t }
    catalog.packs.push(pack)
    return pack
  }
  throw new StickersError('找不到表情包：' + raw, 404)
}

function mediaTypeOf(extOrType) {
  const s = String(extOrType ?? '').trim().toLowerCase()
  if (MEDIA_BY_EXT[s]) return MEDIA_BY_EXT[s]
  if (EXT_BY_MEDIA[s]) return s
  if (s.startsWith('.')) return MEDIA_BY_EXT[s] || null
  return null
}

function extOfMedia(mediaType) {
  return EXT_BY_MEDIA[mediaType] || null
}

function hashBytes(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function probeDims(buf) {
  try {
    const dims = imageSize(buf)
    return { width: Number(dims?.width) || 0, height: Number(dims?.height) || 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

function assertSafeRelFile(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/')
  if (!s.startsWith('files/') || s.includes('..') || s.includes('\0')) {
    throw new StickersError('非法文件路径')
  }
  return s
}

function absoluteFile(root, rel) {
  const safe = assertSafeRelFile(rel)
  const full = resolve(stickersRoot(root), ...safe.split('/'))
  const base = resolve(filesDir(root))
  if (!full.startsWith(base + sep) && full !== base) throw new StickersError('非法文件路径')
  return full
}

function publicPack(pack, catalog) {
  const count = catalog.stickers.filter((s) => s.packId === pack.id).length
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description || '',
    stickers: count,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
  }
}

function publicSticker(sticker, catalog, root) {
  const pack = catalog.packs.find((p) => p.id === sticker.packId)
  return {
    id: sticker.id,
    packId: sticker.packId,
    packName: pack?.name || '',
    hash: sticker.hash,
    file: sticker.file,
    path: join(stickersRoot(root), sticker.file),
    mediaType: sticker.mediaType,
    bytes: sticker.bytes,
    width: sticker.width || 0,
    height: sticker.height || 0,
    tags: sticker.tags || [],
    aliases: sticker.aliases || [],
    emoji: sticker.emoji || '',
    source: sticker.source || {},
    createdAt: sticker.createdAt,
    updatedAt: sticker.updatedAt,
  }
}

/** 加载整库摘要（设置页）。 */
export function loadCatalog(root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    ensureDefaultPack(catalog)
    writeCatalog(root, catalog)
    return {
      packs: catalog.packs.map((p) => publicPack(p, catalog)),
      stickers: catalog.stickers.map((s) => publicSticker(s, catalog, root)),
      stats: {
        packs: catalog.packs.length,
        stickers: catalog.stickers.length,
      },
    }
  })
}

export function createPack({ name, description } = {}, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    ensureDefaultPack(catalog)
    const n = text(name, '包名', LIMITS.name, true)
    if (catalog.packs.some((p) => sameFold(p.name, n))) throw new StickersError('已有同名表情包')
    const t = now()
    const pack = {
      id: newId('pack'),
      name: n,
      description: text(description ?? '', '描述', LIMITS.description, false),
      createdAt: t,
      updatedAt: t,
    }
    catalog.packs.push(pack)
    writeCatalog(root, catalog)
    return { pack: publicPack(pack, catalog) }
  })
}

export function renamePack(id, { name, description } = {}, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const pack = catalog.packs.find((p) => p.id === String(id ?? '').trim())
    if (!pack) throw new StickersError('找不到表情包', 404)
    if (name !== undefined) {
      const n = text(name, '包名', LIMITS.name, true)
      if (catalog.packs.some((p) => p.id !== pack.id && sameFold(p.name, n))) {
        throw new StickersError('已有同名表情包')
      }
      pack.name = n
    }
    if (description !== undefined) {
      pack.description = text(description, '描述', LIMITS.description, false)
    }
    pack.updatedAt = now()
    writeCatalog(root, catalog)
    return { pack: publicPack(pack, catalog) }
  })
}

/** 删包：级联删除其下贴纸；无引用的 files 一并删除。默认包若被删会在下次加载时重建。 */
export function deletePack(id, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const packId = String(id ?? '').trim()
    const idx = catalog.packs.findIndex((p) => p.id === packId)
    if (idx < 0) throw new StickersError('找不到表情包', 404)
    const removed = catalog.stickers.filter((s) => s.packId === packId)
    catalog.packs.splice(idx, 1)
    catalog.stickers = catalog.stickers.filter((s) => s.packId !== packId)
    for (const s of removed) maybeUnlinkFile(root, catalog, s.file)
    writeCatalog(root, catalog)
    return { deleted: true, stickersRemoved: removed.length }
  })
}

function maybeUnlinkFile(root, catalog, rel) {
  if (!rel) return
  if (catalog.stickers.some((s) => s.file === rel)) return
  try {
    rmSync(absoluteFile(root, rel), { force: true })
  } catch { /* ignore */ }
}

/**
 * 从本地绝对路径或 Buffer 写入贴纸库。
 * @param {{ path?: string, data?: Buffer|Uint8Array, mediaType?: string, originalName?: string, pack?: string, tags?: string[], aliases?: string[], emoji?: string, source?: object }} input
 */
export function saveSticker(input = {}, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const defaultPack = ensureDefaultPack(catalog)
    const pack = resolvePack(catalog, input.pack || defaultPack.id)
    const inPack = catalog.stickers.filter((s) => s.packId === pack.id).length
    if (inPack >= LIMITS.packStickers) {
      throw new StickersError('单个表情包最多 ' + LIMITS.packStickers + ' 张')
    }

    let buf
    let mediaType
    let originalName = String(input.originalName ?? '').trim()

    if (input.data != null) {
      buf = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data)
      mediaType = mediaTypeOf(input.mediaType) || guessMediaFromName(originalName)
      if (!mediaType) throw new StickersError('无法识别图片类型；请使用 png/jpg/webp/gif')
    } else {
      const loaded = loadLocalImage(input.path || input.source)
      buf = loaded.data
      mediaType = loaded.mediaType
      originalName = originalName || loaded.name
    }

    if (!buf.length) throw new StickersError('图片文件为空')
    if (buf.length > LIMITS.fileBytes) {
      throw new StickersError('图片过大（' + buf.length + ' 字节）；上限 ' + LIMITS.fileBytes)
    }

    const hash = hashBytes(buf)
    const existing = catalog.stickers.find((s) => s.hash === hash && s.packId === pack.id)
    if (existing) {
      const tags = input.tags !== undefined ? cleanList(input.tags, { label: '标签', itemMax: LIMITS.tag, listMax: LIMITS.tags }) : existing.tags
      const aliases = input.aliases !== undefined ? cleanList(input.aliases, { label: '别名', itemMax: LIMITS.alias, listMax: LIMITS.aliases }) : existing.aliases
      const emoji = input.emoji !== undefined ? text(input.emoji, 'emoji', LIMITS.emoji, false) : existing.emoji
      existing.tags = tags
      existing.aliases = aliases
      existing.emoji = emoji
      existing.updatedAt = now()
      writeCatalog(root, catalog)
      return { sticker: publicSticker(existing, catalog, root), deduped: true }
    }

    const ext = extOfMedia(mediaType)
    const shortHash = hash.slice(0, 12)
    const rel = 'files/' + shortHash + ext
    mkdirSync(filesDir(root), { recursive: true })
    const abs = absoluteFile(root, rel)
    if (!existsSync(abs)) writeFileSync(abs, buf)

    const dims = probeDims(buf)
    const t = now()
    const sticker = {
      id: newId('stk'),
      packId: pack.id,
      hash,
      file: rel,
      mediaType,
      bytes: buf.length,
      width: dims.width,
      height: dims.height,
      tags: cleanList(input.tags, { label: '标签', itemMax: LIMITS.tag, listMax: LIMITS.tags }),
      aliases: cleanList(input.aliases, { label: '别名', itemMax: LIMITS.alias, listMax: LIMITS.aliases }),
      emoji: text(input.emoji ?? '', 'emoji', LIMITS.emoji, false),
      source: sanitizeSource(input.source, originalName),
      createdAt: t,
      updatedAt: t,
    }
    catalog.stickers.push(sticker)
    pack.updatedAt = t
    writeCatalog(root, catalog)
    return { sticker: publicSticker(sticker, catalog, root), deduped: false }
  })
}

function sanitizeSource(source, originalName) {
  const s = source && typeof source === 'object' ? source : {}
  const channel = String(s.channel ?? 'import').trim().slice(0, 32)
  return {
    channel: channel || 'import',
    conversationId: String(s.conversationId ?? '').trim().slice(0, 80),
    messageId: String(s.messageId ?? '').trim().slice(0, 80),
    originalName: String(s.originalName ?? originalName ?? '').trim().slice(0, 120),
    attachmentId: String(s.attachmentId ?? '').trim().slice(0, 80),
  }
}

function guessMediaFromName(name) {
  return MEDIA_BY_EXT[extname(String(name || '')).toLowerCase()] || null
}

/** 校验并读取本地图片路径（拒绝 URL / 逃逸）。 */
export function loadLocalImage(rawPath) {
  const input = String(rawPath ?? '').trim()
  if (!input) throw new StickersError('请提供本地图片路径')
  if (/^(https?|ftp|data):/i.test(input)) {
    throw new StickersError('不支持远程 URL；请提供本地绝对路径')
  }
  let full = input
  if (/^file:/i.test(input)) {
    try {
      full = decodeURIComponent(new URL(input).pathname)
      if (/^\/[A-Za-z]:\//.test(full)) full = full.slice(1)
    } catch {
      throw new StickersError('无效的 file: URL')
    }
  }
  full = resolve(full)
  if (!isAbsolute(full)) throw new StickersError('请使用绝对路径')
  if (!existsSync(full)) throw new StickersError('找不到图片文件：' + full, 404)
  const data = readFileSync(full)
  const ext = extname(full).toLowerCase()
  const mediaType = MEDIA_BY_EXT[ext]
  if (!mediaType) {
    throw new StickersError('不支持的图片类型 "' + (ext || '(无)') + '"；允许：' + Object.keys(MEDIA_BY_EXT).join(' '))
  }
  if (data.length > LIMITS.fileBytes) {
    throw new StickersError('图片过大（' + data.length + ' 字节）；上限 ' + LIMITS.fileBytes)
  }
  if (!data.length) throw new StickersError('图片文件为空')
  return { full, name: basename(full), mediaType, data, bytes: data.length, ...probeDims(data) }
}

export function updateSticker(id, patch = {}, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const sticker = catalog.stickers.find((s) => s.id === String(id ?? '').trim())
    if (!sticker) throw new StickersError('找不到贴纸', 404)
    if (patch.pack !== undefined || patch.packId !== undefined) {
      const pack = resolvePack(catalog, patch.pack ?? patch.packId)
      const inPack = catalog.stickers.filter((s) => s.packId === pack.id && s.id !== sticker.id).length
      if (inPack >= LIMITS.packStickers) throw new StickersError('目标表情包已满')
      sticker.packId = pack.id
      pack.updatedAt = now()
    }
    if (patch.tags !== undefined) {
      sticker.tags = cleanList(patch.tags, { label: '标签', itemMax: LIMITS.tag, listMax: LIMITS.tags })
    }
    if (patch.aliases !== undefined) {
      sticker.aliases = cleanList(patch.aliases, { label: '别名', itemMax: LIMITS.alias, listMax: LIMITS.aliases })
    }
    if (patch.emoji !== undefined) {
      sticker.emoji = text(patch.emoji, 'emoji', LIMITS.emoji, false)
    }
    sticker.updatedAt = now()
    writeCatalog(root, catalog)
    return { sticker: publicSticker(sticker, catalog, root) }
  })
}

export function deleteSticker(id, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const sid = String(id ?? '').trim()
    const idx = catalog.stickers.findIndex((s) => s.id === sid)
    if (idx < 0) throw new StickersError('找不到贴纸', 404)
    const [removed] = catalog.stickers.splice(idx, 1)
    maybeUnlinkFile(root, catalog, removed.file)
    writeCatalog(root, catalog)
    return { deleted: true, id: sid }
  })
}

export function getSticker(id, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const sticker = catalog.stickers.find((s) => s.id === String(id ?? '').trim())
    if (!sticker) throw new StickersError('找不到贴纸', 404)
    return publicSticker(sticker, catalog, root)
  })
}

export function readStickerBytes(id, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const sticker = catalog.stickers.find((s) => s.id === String(id ?? '').trim())
    if (!sticker) throw new StickersError('找不到贴纸', 404)
    const abs = absoluteFile(root, sticker.file)
    if (!existsSync(abs)) throw new StickersError('贴纸文件缺失', 404)
    const data = readFileSync(abs)
    return { sticker: publicSticker(sticker, catalog, root), data, abs }
  })
}

/**
 * 检索：query 空白分词 AND；可叠加 pack / tag。
 */
export function searchStickers({ query, pack, tag, limit } = {}, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    ensureDefaultPack(catalog)
    let list = catalog.stickers.slice()
    const packRef = String(pack ?? '').trim()
    if (packRef) {
      const p = catalog.packs.find((x) => x.id === packRef || sameFold(x.name, packRef))
      if (!p) return { count: 0, stickers: [] }
      list = list.filter((s) => s.packId === p.id)
    }
    const tagFilter = String(tag ?? '').trim().toLowerCase()
    if (tagFilter) {
      list = list.filter((s) => (s.tags || []).some((t) => t.toLowerCase() === tagFilter))
    }
    const q = text(query ?? '', '查询', LIMITS.query, false)
    if (q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean)
      list = list.filter((s) => {
        const packName = (catalog.packs.find((p) => p.id === s.packId)?.name || '').toLowerCase()
        const hay = [
          s.id,
          packName,
          s.emoji || '',
          ...(s.tags || []),
          ...(s.aliases || []),
          s.source?.originalName || '',
        ].join('\n').toLowerCase()
        return words.every((w) => hay.includes(w))
      })
    }
    const lim = Math.min(30, Math.max(1, Number(limit) || 10))
    const stickers = list.slice(0, lim).map((s) => {
      const pub = publicSticker(s, catalog, root)
      return {
        id: pub.id,
        packId: pub.packId,
        packName: pub.packName,
        tags: pub.tags,
        aliases: pub.aliases,
        emoji: pub.emoji,
        path: pub.path,
        mediaType: pub.mediaType,
        width: pub.width,
        height: pub.height,
        bytes: pub.bytes,
      }
    })
    return { count: stickers.length, stickers }
  })
}

/**
 * 解析发送目标：id > alias（精确，大小写不敏感）> tag（唯一命中）。
 * 多命中返回 candidates，不抛错。
 */
export function resolveSendTarget({ id, alias, tag } = {}, root) {
  return exclusive(async () => {
    const catalog = readCatalog(root)
    const sid = String(id ?? '').trim()
    if (sid) {
      const hit = catalog.stickers.find((s) => s.id === sid)
      if (!hit) throw new StickersError('找不到贴纸 id：' + sid, 404)
      return { ok: true, sticker: publicSticker(hit, catalog, root) }
    }
    const al = String(alias ?? '').trim().toLowerCase()
    if (al) {
      const hits = catalog.stickers.filter((s) => (s.aliases || []).some((a) => a.toLowerCase() === al))
      if (hits.length === 1) return { ok: true, sticker: publicSticker(hits[0], catalog, root) }
      if (hits.length === 0) throw new StickersError('找不到别名：' + alias, 404)
      return {
        ok: false,
        reason: 'ambiguous_alias',
        candidates: hits.slice(0, 10).map((s) => publicSticker(s, catalog, root)),
      }
    }
    const tg = String(tag ?? '').trim().toLowerCase()
    if (tg) {
      const hits = catalog.stickers.filter((s) => (s.tags || []).some((t) => t.toLowerCase() === tg))
      if (hits.length === 1) return { ok: true, sticker: publicSticker(hits[0], catalog, root) }
      if (hits.length === 0) throw new StickersError('找不到标签：' + tag, 404)
      return {
        ok: false,
        reason: 'ambiguous_tag',
        candidates: hits.slice(0, 10).map((s) => publicSticker(s, catalog, root)),
      }
    }
    throw new StickersError('请提供 id、alias 或 tag')
  })
}

// ── recent inbound ring buffer（按 session）──

function readRecentIndex(root) {
  const file = recentIndexPath(root)
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : { sessions: {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { sessions: {} }
    return { sessions: {} }
  }
}

function writeRecentIndex(root, index) {
  mkdirSync(recentDir(root), { recursive: true })
  replaceFile(recentIndexPath(root), JSON.stringify(index, null, 2) + '\n')
}

export function pushRecent(sessionId, { data, mediaType, channel, messageId, width, height } = {}, root) {
  return exclusive(async () => {
    const sid = String(sessionId ?? '').trim() || '_default'
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    const mt = mediaTypeOf(mediaType)
    if (!mt || !buf.length) return { pushed: false }
    if (buf.length > LIMITS.fileBytes) return { pushed: false }
    const entryId = newId('rec')
    const ext = extOfMedia(mt)
    const relName = entryId + ext
    mkdirSync(recentDir(root), { recursive: true })
    writeFileSync(join(recentDir(root), relName), buf)
    const dims = (width && height) ? { width, height } : probeDims(buf)
    const index = readRecentIndex(root)
    if (!index.sessions) index.sessions = {}
    const items = Array.isArray(index.sessions[sid]) ? index.sessions[sid] : []
    items.push({
      entryId,
      savedAt: now(),
      mediaType: mt,
      path: 'recent/' + relName,
      channel: String(channel ?? '').slice(0, 32),
      messageId: String(messageId ?? '').slice(0, 80),
      width: dims.width || 0,
      height: dims.height || 0,
    })
    while (items.length > LIMITS.recentPerSession) {
      const old = items.shift()
      try { rmSync(join(recentDir(root), basename(old.path)), { force: true }) } catch { /* ignore */ }
    }
    index.sessions[sid] = items
    writeRecentIndex(root, index)
    return { pushed: true, entryId }
  })
}

export function listRecent(sessionId, root) {
  return exclusive(async () => {
    const sid = String(sessionId ?? '').trim() || '_default'
    const index = readRecentIndex(root)
    const items = Array.isArray(index.sessions?.[sid]) ? index.sessions[sid] : []
    return { sessionId: sid, items: items.slice().reverse() }
  })
}

export function clearRecent(sessionId, root) {
  return exclusive(async () => {
    const index = readRecentIndex(root)
    if (!index.sessions) index.sessions = {}
    if (sessionId === '*' || sessionId === undefined || sessionId === null || sessionId === '') {
      for (const items of Object.values(index.sessions)) {
        for (const it of items || []) {
          try { rmSync(join(recentDir(root), basename(it.path)), { force: true }) } catch { /* ignore */ }
        }
      }
      index.sessions = {}
    } else {
      const sid = String(sessionId).trim()
      for (const it of index.sessions[sid] || []) {
        try { rmSync(join(recentDir(root), basename(it.path)), { force: true }) } catch { /* ignore */ }
      }
      delete index.sessions[sid]
    }
    writeRecentIndex(root, index)
    return { cleared: true }
  })
}

/** 取某会话最近一条入站图的字节（不删除）。 */
export function takeLatestRecent(sessionId, root) {
  return exclusive(async () => {
    const sid = String(sessionId ?? '').trim() || '_default'
    const index = readRecentIndex(root)
    const items = Array.isArray(index.sessions?.[sid]) ? index.sessions[sid] : []
    if (!items.length) throw new StickersError('当前会话没有最近入站图片；请提供 source 路径', 404)
    const last = items[items.length - 1]
    const abs = join(recentDir(root), basename(last.path))
    if (!existsSync(abs)) throw new StickersError('最近入站图片文件已丢失', 404)
    const data = readFileSync(abs)
    return {
      data,
      mediaType: last.mediaType,
      originalName: basename(last.path),
      source: {
        channel: last.channel || 'desktop',
        messageId: last.messageId || '',
        conversationId: sid,
        originalName: basename(last.path),
      },
    }
  })
}
