/** 房间工具集：rooms/<id>/toolset.json，所有成员共享，最多 max 个，超出按最近使用淘汰（LRU）。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 把 names 加入列表（已有则刷新时间）。
 * 普通条目超出 max 时淘汰 lastUsed 最早的（优先淘汰本次没点名的）。
 * exact 条目是按名称钉选的全套：不占 max，只受 hardMax（声明上限）约束，后到的普通查找不会把它们挤掉。
 * 返回 { list, added, evicted, accepted, omitted }。
 */
export function addLru(list, names, { max = 12, now = Date.now(), by = '', exact = false, hardMax = Infinity } = {}) {
  const out = (list || []).map((x) => ({ ...x }))
  const added = []
  const omitted = []
  const cap = Math.max(1, max)
  const ceiling = Number.isFinite(hardMax) ? Math.max(0, hardMax) : Infinity
  for (const n of names) {
    const hit = out.find((x) => x.name === n)
    if (hit) {
      hit.lastUsed = now
      if (exact) hit.exact = true
      continue
    }
    if (exact && out.length >= ceiling) { omitted.push(n); continue }
    out.push({ name: n, addedBy: by, addedAt: now, lastUsed: now, ...(exact ? { exact: true } : {}) })
    added.push(n)
  }
  const evicted = []
  const fresh = new Set(names)
  const nonExact = () => out.filter((x) => !x.exact)
  while (nonExact().length > cap || out.length > ceiling) {
    const overCeiling = out.length > ceiling
    let pool = nonExact()
    if (!pool.length) {
      if (!overCeiling) break
      pool = out.slice()
    }
    const prefer = pool.some((x) => !fresh.has(x.name)) ? pool.filter((x) => !fresh.has(x.name)) : pool
    let victim = prefer[0]
    for (const x of prefer) if ((x.lastUsed || 0) < (victim.lastUsed || 0)) victim = x
    out.splice(out.indexOf(victim), 1)
    evicted.push(victim.name)
  }
  const kept = new Set(out.map((x) => x.name))
  const accepted = []
  for (const n of names) if (kept.has(n) && !accepted.includes(n)) accepted.push(n)
  return {
    list: out,
    added: added.filter((n) => kept.has(n)),
    evicted,
    accepted,
    omitted: [...omitted, ...added.filter((n) => !kept.has(n))],
  }
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
  const add = (roomId, names, { max, by, exact, hardMax } = {}) => lock(roomId, async () => { const r = addLru(await list(roomId), names, { max, by, exact, hardMax, now: now() }); await write(roomId, r.list); return r })
  const touch = (roomId, name) => lock(roomId, async () => write(roomId, touchLru(await list(roomId), name, now())))
  const remove = (roomId, name) => lock(roomId, async () => { const cur = await list(roomId); const next = cur.filter((x) => x.name !== name); await write(roomId, next); return next.length !== cur.length })
  const clear = (roomId) => lock(roomId, async () => { const n = (await list(roomId)).length; await write(roomId, []); return n })
  return { list, add, touch, remove, clear }
}
