/**
 * 聊天室存储：<dir>/rooms/<roomId>/meta.json + messages.jsonl（只追加）。
 * meta：{ id, title, createdAt, updatedAt, messages, sessionId?, memberSeatIds? }（sessionId：对应的 DSH 房间会话；memberSeatIds：本房间成员 = 席位池中的有序 id）。
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

// ── 界面分页（只影响聊天室面板的显示，不改变成员看到的上下文，也不删减存储） ──
export const HISTORY_PAGE_DEFAULT = 50
export const HISTORY_PAGE_MAX = 500
/** 解析 limit：正整数，上限 HISTORY_PAGE_MAX；无效时取 def。 */
export function historyLimit(value, def = HISTORY_PAGE_DEFAULT) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(HISTORY_PAGE_MAX, n)
}
/**
 * 取一页聊天记录：序号小于 before 的消息中最近的 limit 条（按记录顺序，较早在前）；before 缺省 / 无效时从最新一条往前取。
 * 返回 { messages, total, older }：total 为房间消息总数，older 为本页之前尚未返回的条数（0 表示已到最早）。
 */
export function pageMessages(all, { before, limit } = {}) {
  const list = Array.isArray(all) ? all : []
  const b = Number(before)
  const pool = before != null && before !== '' && Number.isFinite(b) && b > 0 ? list.filter((m) => (Number(m?.seq) || 0) < b) : list
  const lim = historyLimit(limit)
  const start = Math.max(0, pool.length - lim)
  return { messages: pool.slice(start), total: list.length, older: start }
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
    await renameRetry(file + '.tmp', file)
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

  /**
   * 原位更新一条消息（编号、序号、时间不变），整份 messages.jsonl 原子重写。fn(msg) 返回新内容（或直接修改）。
   * 找不到时返回 null。用于「先交卷、后补卷」的 Cursor 任务卡片。
   */
  // Windows：目标文件正被读取时 rename 会短暂报 EPERM / EBUSY / EACCES，稍后重试几次
  async function renameRetry(from, to) {
    for (let i = 0; ; i++) {
      try { return await rename(from, to) } catch (e) {
        if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e
        await new Promise((r) => setTimeout(r, 25 * (i + 1)))
      }
    }
  }
  async function updateMessage(id, msgId, fn) {
    return serial(id, async () => {
      const file = join(roomDir(id), 'messages.jsonl')
      let raw = ''
      try { raw = await readFile(file, 'utf8') } catch { return null }
      let updated = null
      const lines = raw.split('\n').map((line) => {
        if (updated || !line.trim()) return line
        let m
        try { m = JSON.parse(line) } catch { return line }
        if (m.id !== msgId) return line
        const next = (fn(m) || m)
        updated = { ...next, id: m.id, seq: m.seq, ts: m.ts }
        return JSON.stringify(updated)
      })
      if (!updated) return null
      await writeFile(file + '.tmp', lines.join('\n'), 'utf8')
      await renameRetry(file + '.tmp', file)
      return updated
    })
  }

  // ── 思考过程（成员回复的 reasoning / thinking 文本）：单独存 <room>/thinking.jsonl，按消息编号；不写进 messages.jsonl ──
  const THINKING_MAX = 200000
  const MSG_ID_RE = /^msg-[a-z0-9-]{3,60}$/
  async function appendThinking(id, msgId, text) {
    const t = String(text || '').trim()
    if (!t || !MSG_ID_RE.test(String(msgId || ''))) return null
    return serial(id, async () => {
      await getRoom(id)
      const rec = { id: msgId, ts: new Date().toISOString(), chars: t.length, text: t.slice(0, THINKING_MAX), ...(t.length > THINKING_MAX ? { truncated: true } : {}) }
      await appendFile(join(roomDir(id), 'thinking.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
      return { id: msgId, chars: rec.chars }
    })
  }
  /** 某条消息的思考过程；没有时返回 null。 */
  async function readThinking(id, msgId) {
    if (!MSG_ID_RE.test(String(msgId || ''))) return null
    let raw = ''
    try { raw = await readFile(join(roomDir(id), 'thinking.jsonl'), 'utf8') } catch { return null }
    let found = null
    for (const line of raw.split('\n')) {
      if (!line.includes(msgId)) continue
      try { const r = JSON.parse(line); if (r.id === msgId) found = r } catch {}
    }
    return found
  }
  /** 清空房间的思考过程（清空聊天记录时一并调用）。 */
  async function clearThinking(id) {
    return serial(id, async () => { try { await writeFile(join(roomDir(id), 'thinking.jsonl'), '', 'utf8') } catch {} })
  }

  /**
   * Mark messages with seq <= untilSeq as hidden from AI context (contextHidden).
   * UI still shows them; messages.jsonl is rewritten once (same path as updateMessage).
   * Returns how many messages were newly marked.
   */
  async function markContextHidden(id, untilSeq) {
    const edge = Math.max(0, Math.floor(Number(untilSeq) || 0))
    if (!edge) return 0
    return serial(id, async () => {
      const file = join(roomDir(id), 'messages.jsonl')
      let raw = ''
      try { raw = await readFile(file, 'utf8') } catch { return 0 }
      let n = 0
      const lines = raw.split('\n').map((line) => {
        if (!line.trim()) return line
        let m
        try { m = JSON.parse(line) } catch { return line }
        if (!(Number(m.seq) > 0 && Number(m.seq) <= edge)) return line
        if (m.contextHidden === true) return line
        n++
        return JSON.stringify({ ...m, contextHidden: true })
      })
      if (!n) return 0
      await writeFile(file + '.tmp', lines.join('\n'), 'utf8')
      await renameRetry(file + '.tmp', file)
      return n
    })
  }

  async function lastSeq(id) {
    const all = await readMessages(id)
    return all.reduce((m, x) => Math.max(m, x.seq || 0), 0)
  }

  /**
   * 按消息编号删除（仅本机桌面端接口调用）。串行、原子重写 messages.jsonl 与 thinking.jsonl；
   * 清理 meta.cardBin 中已不存在的条目；meta.messages 取剩余消息的最大序号（与 append 的「末序号」语义一致）；
   * 内存 seqs 高水位不回退，避免新消息复用序号。返回 { deleted, remaining, meta }。
   */
  async function deleteMessages(id, ids) {
    const want = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter((x) => MSG_ID_RE.test(x)))].slice(0, 500)
    return serial(id, async () => {
      const meta = await getRoom(id)
      if (!want.length) {
        const all = await readMessages(id)
        return { deleted: [], remaining: all.length, meta }
      }
      const drop = new Set(want)
      const file = join(roomDir(id), 'messages.jsonl')
      let raw = ''
      try { raw = await readFile(file, 'utf8') } catch { raw = '' }
      const keptLines = []
      const deleted = []
      let maxSeq = 0
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let m
        try { m = JSON.parse(line) } catch { keptLines.push(line); continue }
        if (m && m.id && drop.has(m.id)) { deleted.push(m.id); continue }
        keptLines.push(line)
        const q = Number(m && m.seq) || 0
        if (q > maxSeq) maxSeq = q
      }
      if (!deleted.length) {
        const all = await readMessages(id)
        return { deleted: [], remaining: all.length, meta }
      }
      await writeFile(file + '.tmp', keptLines.length ? keptLines.join('\n') + '\n' : '', 'utf8')
      await renameRetry(file + '.tmp', file)

      const delSet = new Set(deleted)
      const thinkFile = join(roomDir(id), 'thinking.jsonl')
      try {
        let traw = await readFile(thinkFile, 'utf8')
        const tkept = []
        for (const line of traw.split('\n')) {
          if (!line.trim()) continue
          let r
          try { r = JSON.parse(line) } catch { tkept.push(line); continue }
          if (r && r.id && delSet.has(r.id)) continue
          tkept.push(line)
        }
        await writeFile(thinkFile + '.tmp', tkept.length ? tkept.join('\n') + '\n' : '', 'utf8')
        await renameRetry(thinkFile + '.tmp', thinkFile)
      } catch {}

      if (meta.cardBin && typeof meta.cardBin === 'object' && !Array.isArray(meta.cardBin)) {
        for (const k of Object.keys(meta.cardBin)) if (delSet.has(k)) delete meta.cardBin[k]
      }
      meta.messages = maxSeq
      meta.updatedAt = new Date().toISOString()
      await writeMeta(id, meta)
      const prev = seqs.get(id) || 0
      if (prev < maxSeq) seqs.set(id, maxSeq)
      return { deleted, remaining: keptLines.length, meta }
    })
  }
  return { dir, createRoom, renameRoom, listRooms, getRoom, readMessages, append, setRoomSession, patchMeta, setTelegramChats, lastSeq, updateMessage, appendThinking, readThinking, clearThinking, markContextHidden, deleteMessages }
}
