/**
 * 笔记：三级结构。第一级为知识点类型（如 知识、技巧、规则），第二级为细分类别（如 知识 › 数学），
 * 第三级为具体笔记。数据落在数据目录 notes/notes.json（全局，不分会话），先写临时文件再替换；
 * 同一进程内的读写串行执行。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../tools.mjs'

export class NotesError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'NotesError'
    this.status = status
  }
}

export const LIMITS = { name: 40, description: 200, title: 80, content: 8000, tags: 8, tag: 20, summary: 80 }

let tail = Promise.resolve()
function exclusive(fn) {
  const run = tail.then(fn, fn)
  tail = run.then(() => undefined, () => undefined)
  return run
}

export function notesFile(root) {
  return join(root || dataDir(), 'notes', 'notes.json')
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

function readStore(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { categories: [], notes: [] }
    throw new NotesError('笔记文件无法读取', 500)
  }
  try {
    const data = JSON.parse(raw)
    return {
      categories: Array.isArray(data?.categories) ? data.categories : [],
      notes: Array.isArray(data?.notes) ? data.notes : [],
    }
  } catch {
    throw new NotesError('笔记文件无法读取', 500)
  }
}

function writeStore(file, store) {
  replaceFile(file, JSON.stringify({ version: 1, categories: store.categories, notes: store.notes }, null, 2) + '\n')
}

function text(value, label, max, required) {
  const s = String(value ?? '').trim()
  if (required && !s) throw new NotesError(label + '不能为空')
  if (s.length > max) throw new NotesError(label + '不超过 ' + max + ' 字')
  return s
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? value.split(/[,，、\s]+/) : [])
  const out = []
  for (const raw of list) {
    const tag = String(raw ?? '').trim()
    if (!tag) continue
    if (tag.length > LIMITS.tag) throw new NotesError('标签不超过 ' + LIMITS.tag + ' 字')
    if (!out.includes(tag)) out.push(tag)
  }
  if (out.length > LIMITS.tags) throw new NotesError('标签最多 ' + LIMITS.tags + ' 个')
  return out
}

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
const now = () => new Date().toISOString()
const newId = (prefix) => prefix + '_' + randomBytes(6).toString('hex')

export function summaryOf(content) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > LIMITS.summary ? flat.slice(0, LIMITS.summary) + '…' : flat
}

function pathOf(store, cat) {
  if (!cat) return ''
  const parent = cat.parentId ? store.categories.find((c) => c.id === cat.parentId) : null
  return parent ? parent.name + ' › ' + cat.name : cat.name
}

function subtreeIds(store, cat) {
  return [cat.id, ...store.categories.filter((c) => c.parentId === cat.id).map((c) => c.id)]
}

function countUnder(store, cat) {
  const ids = subtreeIds(store, cat)
  return { notes: store.notes.filter((n) => ids.includes(n.categoryId)).length, subcategories: ids.length - 1 }
}

function publicCategory(store, cat) {
  const level = cat.parentId ? 2 : 1
  const count = countUnder(store, cat)
  return {
    id: cat.id,
    name: cat.name,
    level,
    ...(cat.parentId ? { parentId: cat.parentId } : {}),
    path: pathOf(store, cat),
    ...(cat.description ? { description: cat.description } : {}),
    ...(level === 1 ? { subcategories: count.subcategories } : {}),
    notes: count.notes,
  }
}

function noteSummary(store, note) {
  const cat = store.categories.find((c) => c.id === note.categoryId)
  return {
    id: note.id,
    title: note.title,
    summary: summaryOf(note.content),
    ...(note.tags?.length ? { tags: note.tags } : {}),
    categoryId: note.categoryId,
    path: pathOf(store, cat),
    updatedAt: note.updatedAt,
  }
}

function fullNote(store, note) {
  const cat = store.categories.find((c) => c.id === note.categoryId)
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tags: note.tags || [],
    categoryId: note.categoryId,
    path: pathOf(store, cat),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  }
}

function findCategory(store, id) {
  const cat = store.categories.find((c) => c.id === id)
  if (!cat) throw new NotesError('没有这个类别：' + id, 404)
  return cat
}

/** 整棵树（设置页使用）：类别全量，笔记只带摘要。 */
export function loadTree(root) {
  return exclusive(async () => {
    const store = readStore(notesFile(root))
    return {
      categories: store.categories.map((c) => publicCategory(store, c)),
      notes: store.notes.map((n) => noteSummary(store, n)),
    }
  })
}

/** 逐级浏览：不传 categoryId 列出第一级；第一级 id 列出第二级；第二级 id 列出笔记摘要。 */
export function browse(categoryId, options = {}, root) {
  return exclusive(async () => {
    const store = readStore(notesFile(root))
    const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100)
    const offset = Math.max(Number(options.offset) || 0, 0)
    const id = String(categoryId ?? '').trim()
    const page = (items, map) => ({
      total: items.length,
      items: items.slice(offset, offset + limit).map(map),
      ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
    })
    if (!id) {
      const p = page(store.categories.filter((c) => !c.parentId), (c) => publicCategory(store, c))
      return { level: 1, total: p.total, categories: p.items, ...(p.nextOffset ? { nextOffset: p.nextOffset } : {}) }
    }
    const cat = findCategory(store, id)
    if (!cat.parentId) {
      const p = page(store.categories.filter((c) => c.parentId === cat.id), (c) => publicCategory(store, c))
      return { level: 2, parent: publicCategory(store, cat), total: p.total, categories: p.items, ...(p.nextOffset ? { nextOffset: p.nextOffset } : {}) }
    }
    const items = store.notes.filter((n) => n.categoryId === cat.id)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    const p = page(items, (n) => noteSummary(store, n))
    return { level: 3, parent: publicCategory(store, cat), total: p.total, notes: p.items, ...(p.nextOffset ? { nextOffset: p.nextOffset } : {}) }
  })
}

/** 关键词检索。空格分隔的多个词须全部命中（不区分大小写）。 */
export function search(query, options = {}, root) {
  return exclusive(async () => {
    const store = readStore(notesFile(root))
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const tag = String(options.tag ?? '').trim()
    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 30)
    let scopeIds = null
    const scopeId = String(options.categoryId ?? '').trim()
    if (scopeId) scopeIds = subtreeIds(store, findCategory(store, scopeId))
    const scored = []
    for (const note of store.notes) {
      if (scopeIds && !scopeIds.includes(note.categoryId)) continue
      if (tag && !(note.tags || []).includes(tag)) continue
      const cat = store.categories.find((c) => c.id === note.categoryId)
      const title = note.title.toLowerCase()
      const tags = (note.tags || []).map((t) => t.toLowerCase())
      const hay = [title, String(note.content).toLowerCase(), tags.join(' '), pathOf(store, cat).toLowerCase()].join('\n')
      if (!words.every((w) => hay.includes(w))) continue
      const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (tags.includes(w) ? 2 : 0), 0)
      scored.push({ note, score })
    }
    scored.sort((a, b) => b.score - a.score || String(b.note.updatedAt).localeCompare(String(a.note.updatedAt)))
    const categories = words.length && !tag
      ? store.categories
        .filter((c) => (!scopeIds || scopeIds.includes(c.id)) && words.every((w) => (c.name + ' ' + (c.description || '')).toLowerCase().includes(w)))
        .slice(0, 10).map((c) => publicCategory(store, c))
      : []
    return {
      total: scored.length,
      notes: scored.slice(0, limit).map((s) => noteSummary(store, s.note)),
      ...(categories.length ? { categories } : {}),
      ...(scored.length > limit ? { truncated: true } : {}),
    }
  })
}

export function getNote(id, root) {
  return exclusive(async () => {
    const store = readStore(notesFile(root))
    const note = store.notes.find((n) => n.id === String(id ?? '').trim())
    if (!note) throw new NotesError('没有这条笔记：' + id, 404)
    return fullNote(store, note)
  })
}

export function saveCategory(input, root) {
  return exclusive(async () => {
    const file = notesFile(root)
    const store = readStore(file)
    const src = input || {}
    const id = String(src.id ?? '').trim()
    const existing = id ? findCategory(store, id) : null
    const name = text(src.name ?? existing?.name, '类别名称', LIMITS.name, true)
    const description = text(src.description === undefined ? existing?.description : src.description, '类别说明', LIMITS.description, false)
    const parentId = existing ? (existing.parentId || '') : String(src.parentId ?? '').trim()
    if (existing && src.parentId !== undefined && String(src.parentId ?? '').trim() !== parentId) {
      throw new NotesError('不能改变类别所在的层级；请新建类别后移动笔记')
    }
    if (parentId) {
      const parent = findCategory(store, parentId)
      if (parent.parentId) throw new NotesError('类别最多两级：第一级为知识点类型，第二级为细分类别')
    }
    const clash = store.categories.find((c) => c.id !== existing?.id && (c.parentId || '') === parentId && sameName(c.name, name))
    if (clash) throw new NotesError('同一层级已有同名类别「' + clash.name + '」（id ' + clash.id + '），请直接使用它', 409)
    const stamp = now()
    const next = {
      id: existing?.id || newId('cat'),
      name,
      ...(parentId ? { parentId } : {}),
      ...(description ? { description } : {}),
      createdAt: existing?.createdAt || stamp,
      updatedAt: stamp,
    }
    store.categories = existing ? store.categories.map((c) => (c.id === existing.id ? next : c)) : store.categories.concat([next])
    writeStore(file, store)
    return { category: publicCategory(store, next), created: !existing }
  })
}

/** 删除类别。类别下（含子类别）仍有笔记且未传 confirm 时不删除，返回 needsConfirm 与数量。 */
export function deleteCategory(id, options = {}, root) {
  return exclusive(async () => {
    const file = notesFile(root)
    const store = readStore(file)
    const cat = findCategory(store, String(id ?? '').trim())
    const count = countUnder(store, cat)
    const path = pathOf(store, cat)
    if (count.notes > 0 && options.confirm !== true) {
      return {
        deleted: false,
        needsConfirm: true,
        id: cat.id,
        path,
        notes: count.notes,
        subcategories: count.subcategories,
        message: '类别「' + path + '」下仍有 ' + count.notes + ' 条笔记' + (count.subcategories ? '（分布在 ' + count.subcategories + ' 个子类别中）' : '') + '，删除后将一并删除且无法恢复。确需删除时，请先征得用户同意，再传 confirm: true 重新调用。',
      }
    }
    const ids = subtreeIds(store, cat)
    store.categories = store.categories.filter((c) => !ids.includes(c.id))
    store.notes = store.notes.filter((n) => !ids.includes(n.categoryId))
    writeStore(file, store)
    return { deleted: true, id: cat.id, path, notes: count.notes, subcategories: count.subcategories }
  })
}

export function saveNote(input, root) {
  return exclusive(async () => {
    const file = notesFile(root)
    const store = readStore(file)
    const src = input || {}
    const id = String(src.id ?? '').trim()
    let existing = null
    if (id) {
      existing = store.notes.find((n) => n.id === id)
      if (!existing) throw new NotesError('没有这条笔记：' + id, 404)
    }
    const categoryId = String(src.categoryId || existing?.categoryId || '').trim()
    if (!categoryId) throw new NotesError('需要 categoryId（第二级类别 id）')
    const cat = findCategory(store, categoryId)
    if (!cat.parentId) throw new NotesError('笔记须放在第二级类别下；「' + cat.name + '」是第一级类别，请在其下选择或新建细分类别')
    const title = text(src.title || existing?.title, '笔记标题', LIMITS.title, true)
    let content = src.content === undefined || src.content === '' ? existing?.content : src.content
    const append = String(src.append ?? '').trim()
    if (append) content = (String(content ?? '').trimEnd() + '\n' + append).trim()
    content = text(content, '笔记内容', LIMITS.content, true)
    const tags = src.tags === undefined ? (existing?.tags || []) : cleanTags(src.tags)
    const dup = store.notes.find((n) => n.id !== existing?.id && n.categoryId === categoryId && sameName(n.title, title))
    if (dup) throw new NotesError('该类别下已有同名笔记「' + dup.title + '」（id ' + dup.id + '）。请先 note_get 查看，再以该 id 更新或追加，避免重复', 409)
    const stamp = now()
    const next = {
      id: existing?.id || newId('note'),
      categoryId,
      title,
      content,
      tags,
      createdAt: existing?.createdAt || stamp,
      updatedAt: stamp,
    }
    store.notes = existing ? store.notes.map((n) => (n.id === existing.id ? next : n)) : store.notes.concat([next])
    writeStore(file, store)
    return { note: fullNote(store, next), created: !existing }
  })
}

export function deleteNote(id, root) {
  return exclusive(async () => {
    const file = notesFile(root)
    const store = readStore(file)
    const noteId = String(id ?? '').trim()
    const note = store.notes.find((n) => n.id === noteId)
    if (!note) throw new NotesError('没有这条笔记：' + noteId, 404)
    store.notes = store.notes.filter((n) => n.id !== noteId)
    writeStore(file, store)
    return { deleted: true, id: noteId, title: note.title }
  })
}
