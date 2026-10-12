/**
 * 笔记的同源接口（设置页使用）。修改请求拒绝 cross-site，与设置接口相同。
 *   GET    /notes                     整棵树（类别全量 + 笔记摘要）
 *   GET    /notes/items/:id           一条笔记全文
 *   POST   /notes/items               新建笔记；PUT /notes/items/:id 修改；DELETE 删除
 *   POST   /notes/categories          新建类别；PUT /notes/categories/:id 修改
 *   DELETE /notes/categories/:id?confirm=1   非空类别须带 confirm
 */
import { deleteCategory, deleteNote, getNote, loadTree, NotesError, saveCategory, saveNote } from './store.mjs'

function refuseCrossSite(req) {
  return req.headers['sec-fetch-site'] === 'cross-site'
}

/** @returns {Promise<boolean>} 是否已处理该路径 */
export async function handleNotesApi(req, res, sub, helpers) {
  const { sendJson, readBody } = helpers
  const url = new URL(req.url ?? '/', 'http://local')
  const body = async () => JSON.parse(await readBody(req) || '{}')

  if (sub === '/notes' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, tree: await loadTree() })
    return true
  }
  if (req.method !== 'GET' && refuseCrossSite(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    return true
  }

  if (sub === '/notes/items' && req.method === 'POST') {
    const result = await saveNote({ ...(await body()), id: '' })
    sendJson(res, 200, { ok: true, ...result, tree: await loadTree() })
    return true
  }
  const item = /^\/notes\/items\/([^/]+)$/.exec(sub)
  if (item) {
    const id = decodeURIComponent(item[1])
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, note: await getNote(id) })
      return true
    }
    if (req.method === 'PUT') {
      const result = await saveNote({ ...(await body()), id })
      sendJson(res, 200, { ok: true, ...result, tree: await loadTree() })
      return true
    }
    if (req.method === 'DELETE') {
      const result = await deleteNote(id)
      sendJson(res, 200, { ok: true, ...result, tree: await loadTree() })
      return true
    }
  }

  if (sub === '/notes/categories' && req.method === 'POST') {
    const result = await saveCategory({ ...(await body()), id: '' })
    sendJson(res, 200, { ok: true, ...result, tree: await loadTree() })
    return true
  }
  const cat = /^\/notes\/categories\/([^/]+)$/.exec(sub)
  if (cat) {
    const id = decodeURIComponent(cat[1])
    if (req.method === 'PUT') {
      const input = await body()
      delete input.parentId
      const result = await saveCategory({ ...input, id })
      sendJson(res, 200, { ok: true, ...result, tree: await loadTree() })
      return true
    }
    if (req.method === 'DELETE') {
      const confirm = url.searchParams.get('confirm') === '1'
      const result = await deleteCategory(id, { confirm })
      sendJson(res, 200, { ok: true, ...result, tree: await loadTree() })
      return true
    }
  }
  return false
}

export function notesErrorStatus(error) {
  if (error instanceof NotesError) return error.status || 400
  return error?.status ?? 400
}
