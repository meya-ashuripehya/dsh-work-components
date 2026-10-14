/**
 * 聊天室存储：<dir>/rooms/<roomId>/meta.json + messages.jsonl（只追加）。
 * meta：{ id, title, createdAt, updatedAt, messages, sessionId? }（sessionId：对应的 DSH 房间会话）。
 * meta 另有 telegramChatIds（绑定的群）、briefs（Cursor 任务书状态）、task（当前任务的调度状态）。
 * 消息：{ id, seq, ts, kind: 'user'|'seat'|'system'|'tool'|'brief', speaker: { id, name }, model?, text, status, usage?, error? }
 *   status：ok | pass（席位选择不发言）| error | stopped（被用户中止，保留已生成部分）
 *   usage：{ input, output, cacheRead, cacheWrite }（各家字段统一后的 token 数）
 * 不依赖 UI 与设置，Telegram 群桥可直接复用。
 */
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const ID_RE = /^[a-z0-9-]{4,40}$/

export class ChatroomError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

export function createStore(dir) {
  const roomsDir = join(dir, 'rooms')
  const chains = new Map()
  const seqs = new Map()

  const roomDir = (id) => {
    if (!ID_RE.test(String(id || ''))) throw new ChatroomError('房间编号无效', 400)
    return join(roomsDir, id)
  }
  function serial(id, fn) {
    const prev = chains.get(id) || Promise.resolve()
    const next = prev.then(fn, fn)
    chains.set(id, next.catch(() => {}))
    return next
  }
  async function writeMeta(id, meta) {
    const file = join(roomDir(id), 'meta.json')
    await writeFile(file + '.tmp', JSON.stringify(meta, null, 2) + '\n', 'utf8')
    await rename(file + '.tmp', file)
  }

  async function getRoom(id) {
    try { return JSON.parse(await readFile(join(roomDir(id), 'meta.json'), 'utf8')) } catch (e) {
      if (e instanceof ChatroomError) throw e
      throw new ChatroomError('房间不存在', 404)
    }
  }

  async function createRoom({ title } = {}) {
    const id = newId('room')
    await mkdir(roomDir(id), { recursive: true })
    const now = new Date().toISOString()
    const meta = { id, title: String(title || '').trim().slice(0, 80) || '新房间', createdAt: now, updatedAt: now, messages: 0 }
    await writeMeta(id, meta)
    await writeFile(join(roomDir(id), 'messages.jsonl'), '', 'utf8')
    return meta
  }

  async function renameRoom(id, title) {
    return serial(id, async () => {
      const meta = await getRoom(id)
      meta.title = String(title || '').trim().slice(0, 80) || meta.title
      await writeMeta(id, meta)
      return meta
    })
  }

  async function listRooms() {
    let names = []
    try { names = await readdir(roomsDir) } catch { return [] }
    const out = []
    for (const n of names) {
      if (!ID_RE.test(n)) continue
      try { out.push(await getRoom(n)) } catch {}
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  async function readMessages(id) {
    let raw = ''
    try { raw = await readFile(join(roomDir(id), 'messages.jsonl'), 'utf8') } catch (e) {
      if (e instanceof ChatroomError) throw e
      await getRoom(id)
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {} // 截断的末行（崩溃时）跳过
    }
    return out
  }

  async function append(id, msg) {
    return serial(id, async () => {
      const meta = await getRoom(id)
      if (!seqs.has(id)) {
        const all = await readMessages(id)
        seqs.set(id, all.reduce((m, x) => Math.max(m, x.seq || 0), 0))
      }
      const seq = seqs.get(id) + 1
      const full = { id: newId('msg'), seq, ts: new Date().toISOString(), status: 'ok', ...msg }
      full.seq = seq
      await appendFile(join(roomDir(id), 'messages.jsonl'), JSON.stringify(full) + '\n', 'utf8')
      seqs.set(id, seq)
      meta.messages = seq
      meta.updatedAt = full.ts
      await writeMeta(id, meta)
      return full
    })
  }

  /** 记录房间对应的 DSH 会话编号（房间会话，见 ./room-sessions.mjs）。 */
  async function setRoomSession(id, sessionId) {
    return serial(id, async () => {
      const meta = await getRoom(id)
      meta.sessionId = String(sessionId || '') || undefined
      await writeMeta(id, meta)
      return meta
    })
  }

  /** 改 meta（串行）：fn(meta) 原地修改或返回新对象。 */
  async function patchMeta(id, fn) {
    return serial(id, async () => {
      const meta = await getRoom(id)
      const next = (await fn(meta)) || meta
      await writeMeta(id, next)
      return next
    })
  }

  /** 绑定的 Telegram 群聊 ID（负数字符串），去重、最多 8 个。 */
  async function setTelegramChats(id, chatIds) {
    const list = [...new Set((Array.isArray(chatIds) ? chatIds : String(chatIds || '').split(/[\s,，]+/)).map((x) => String(x).trim()).filter((x) => /^-\d{5,20}$/.test(x)))].slice(0, 8)
    return patchMeta(id, (m) => { m.telegramChatIds = list })
  }

  async function lastSeq(id) {
    const all = await readMessages(id)
    return all.reduce((m, x) => Math.max(m, x.seq || 0), 0)
  }

  return { dir, createRoom, renameRoom, listRooms, getRoom, readMessages, append, setRoomSession, patchMeta, setTelegramChats, lastSeq }
}
