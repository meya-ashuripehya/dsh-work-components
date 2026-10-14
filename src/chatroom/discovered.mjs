/**
 * 发现的群聊：接收机器人在未绑定的群里看到的群（被拉进群的 my_chat_member 事件，或群里的任何消息）。
 * 写在 <数据目录>/chatroom/discovered.json：{ groups: { [chatId]: { chatId, title, type, firstSeen, lastSeen, addedBy, addedById, via, active, status, roomId? } } }
 *   status：new（待处理）| ignored（已忽略）| bound（已绑定）。只记录元数据，不记录消息正文。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function createDiscovered(file) {
  let chain = Promise.resolve()
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }
  async function load() {
    try { const j = JSON.parse(await readFile(file, 'utf8')); return j && typeof j.groups === 'object' && j.groups ? j : { groups: {} } } catch { return { groups: {} } }
  }
  async function save(j) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(j, null, 2) + '\n', 'utf8')
    await rename(file + '.tmp', file)
  }
  const str = (v, n) => String(v ?? '').slice(0, n)

  function record(d) {
    return serial(async () => {
      if (!/^-\d{5,20}$/.test(String(d.chatId || ''))) return null
      const j = await load()
      const prev = j.groups[d.chatId]
      const now = new Date().toISOString()
      const g = {
        chatId: d.chatId,
        title: str(d.title, 200) || prev?.title || '',
        type: str(d.type, 20) || prev?.type || '',
        firstSeen: prev?.firstSeen || str(d.at, 40) || now,
        lastSeen: now,
        addedBy: str(d.addedBy, 120) || prev?.addedBy || '',
        addedById: str(d.addedById, 30) || prev?.addedById || '',
        via: prev?.via === 'my_chat_member' ? prev.via : str(d.via, 20),
        active: d.active !== false,
        // 被重新拉进群时，已忽略的群重新变为待处理
        status: prev?.status === 'bound' ? 'bound' : (prev?.status === 'ignored' && !(d.via === 'my_chat_member' && d.active)) ? 'ignored' : 'new',
        ...(prev?.roomId ? { roomId: prev.roomId } : {}),
      }
      j.groups[d.chatId] = g
      await save(j)
      return g
    })
  }

  function mark(chatId, patch) {
    return serial(async () => {
      const j = await load()
      const g = j.groups[chatId] || { chatId, title: '', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), via: 'manual', active: true }
      j.groups[chatId] = { ...g, ...patch }
      await save(j)
      return j.groups[chatId]
    })
  }

  /** 列表（最近在前）；bound 集合用于把当前已绑定的群标为 bound、被解除的群恢复为 new。 */
  async function list({ bound } = {}) {
    const j = await load()
    return Object.values(j.groups).map((g) => {
      if (!bound) return g
      if (bound.has(g.chatId)) return { ...g, status: 'bound' }
      return g.status === 'bound' ? { ...g, status: 'new', roomId: undefined } : g
    }).map((g) => JSON.parse(JSON.stringify(g))).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
  }

  return { record, mark, list, file }
}
