/** 房间工具集：rooms/<id>/toolset.json，所有成员共享，最多 max 个，超出按最近使用淘汰（LRU）。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 纯函数：把 names 加入列表（已有则刷新时间），超出 max 时淘汰 lastUsed 最早的。返回 { list, added, evicted }。 */
export function addLru(list, names, { max = 12, now = Date.now(), by = '' } = {}) {
  const out = (list || []).map((x) => ({ ...x }))
  const added = []
  for (const n of names) {
    const hit = out.find((x) => x.name === n)
    if (hit) { hit.lastUsed = now; continue }
    out.push({ name: n, addedBy: by, addedAt: now, lastUsed: now })
    added.push(n)
  }
  const evicted = []
  const fresh = new Set(names)
  while (out.length > Math.max(1, max)) {
    const pool = out.some((x) => !fresh.has(x.name)) ? out.filter((x) => !fresh.has(x.name)) : out
    let victim = pool[0]
    for (const x of pool) if ((x.lastUsed || 0) < (victim.lastUsed || 0)) victim = x
    out.splice(out.indexOf(victim), 1)
    evicted.push(victim.name)
  }
  return { list: out, added: added.filter((n) => !evicted.includes(n)), evicted }
}

export function touchLru(list, name, now = Date.now()) {
  return (list || []).map((x) => (x.name === name ? { ...x, lastUsed: now } : x))
}

export function createToolsets(roomDir, { now = () => Date.now() } = {}) {
  const file = (roomId) => join(roomDir(roomId), 'toolset.json')
  const locks = new Map()
  const lock = (roomId, fn) => { const p = (locks.get(roomId) || Promise.resolve()).then(fn, fn); locks.set(roomId, p.catch(() => {})); return p }
  async function list(roomId) {
    try { const j = JSON.parse(await readFile(file(roomId), 'utf8')); return Array.isArray(j?.tools) ? j.tools.filter((x) => x && typeof x.name === 'string') : [] } catch { return [] }
  }
  async function write(roomId, tools) {
    await mkdir(roomDir(roomId), { recursive: true })
    await writeFile(file(roomId), JSON.stringify({ tools }, null, 2), 'utf8')
    return tools
  }
  const add = (roomId, names, { max, by } = {}) => lock(roomId, async () => { const r = addLru(await list(roomId), names, { max, by, now: now() }); await write(roomId, r.list); return r })
  const touch = (roomId, name) => lock(roomId, async () => write(roomId, touchLru(await list(roomId), name, now())))
  const remove = (roomId, name) => lock(roomId, async () => { const cur = await list(roomId); const next = cur.filter((x) => x.name !== name); await write(roomId, next); return next.length !== cur.length })
  const clear = (roomId) => lock(roomId, async () => { const n = (await list(roomId)).length; await write(roomId, []); return n })
  return { list, add, touch, remove, clear }
}
