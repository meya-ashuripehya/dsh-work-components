/**
 * Minecraft 设置卡片「绑定聊天室」（设置键 gb_minecraft_MC_CHATROOM = 房间 id）。
 * 同步（保存 Minecraft 卡片、启用 Minecraft 时运行，可重复执行）：
 * 1. 未绑定或所绑定房间已不存在 → 新建房间「Minecraft」，并把房间 id 写回设置。
 * 2. 旧 Minecraft AI 表中尚未出现在席位池的行 → 迁入席位池（不改已有席位）。
 * 3. 把旧表里的 profileId 合并到同 id 席位上（席位已有则不覆盖）。
 * 4. 保证该房间有 memberSeatIds（缺省则快照当前席位池）；房间名册与聊天室共用席位池。
 * 游戏内发言镜像不在这次同步里，见 mc-mirror.mjs。
 * 不向聊天室注册任何 GameBot / MC 工具。
 */
import { AGENTS_KEY, codeError, resolveAgents } from './agents.mjs'
import { mergeAgentProfilesIntoSeats, seatsFromMcAgents } from '../../chatroom/seats.mjs'

export const ROOM_KEY = 'gb_minecraft_MC_CHATROOM'
export const ROOM_TITLE = 'Minecraft'
const ENABLED_KEY = 'gamebot-minecraftEnabled'

/** 本次设置保存是否需要同步：保存了 Minecraft 卡片（含表或绑定），或启用了 Minecraft。 */
export function roomSyncWanted(patch, next) {
  if (!patch || typeof patch !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(patch, AGENTS_KEY) || Object.prototype.hasOwnProperty.call(patch, ROOM_KEY)) return true
  return patch[ENABLED_KEY] === true && next?.[ENABLED_KEY] === true
}

/**
 * @param {{ getConfig: () => any, store: { listRooms: () => Promise<any[]>, createRoom: (o: { title: string }) => Promise<any> },
 *   ensureSession?: (roomId: string) => Promise<any>, applyPatch: (patch: any) => Promise<void>,
 *   normalizeSeats: (list: any[]) => any[],
 *   ensureRoomMembers?: (roomId: string, opts?: { preferIds?: string[], addIds?: string[] }) => Promise<string[]>,
 *   now?: () => number }} deps
 */
export function createMinecraftRoomBinding({ getConfig, store, ensureSession, applyPatch, normalizeSeats, ensureRoomMembers, now = Date.now }) {
  let last = null
  let chain = Promise.resolve()

  async function rooms() {
    try { return (await store.listRooms()).map((r) => ({ id: String(r.id), title: String(r.title || r.id) })) } catch { return [] }
  }

  async function run(reason) {
    const cfg = getConfig() || {}
    const list = await rooms()
    const bound = String(cfg[ROOM_KEY] || '').trim()
    let room = bound ? list.find((r) => r.id === bound) : null
    let created = false
    let lost = false
    if (!room) {
      lost = !!bound
      const made = await store.createRoom({ title: ROOM_TITLE })
      room = { id: String(made.id), title: String(made.title || ROOM_TITLE) }
      created = true
      if (ensureSession) { try { await ensureSession(room.id) } catch {} }
    }
    const seats = Array.isArray(cfg.chatroomSeats) ? cfg.chatroomSeats.filter((s) => s && typeof s === 'object') : []
    const agents = resolveAgents(cfg)
    const have = new Set(seats.map((s) => String(s?.id || '').trim()))
    const extra = seatsFromMcAgents(agents).filter((s) => s && !have.has(s.id) && !codeError(s.id))
    const merged = mergeAgentProfilesIntoSeats(seats, agents)
    const patch = {}
    if (room.id !== bound) patch[ROOM_KEY] = room.id
    let nextSeats = merged.changed ? merged.seats : seats
    if (extra.length) nextSeats = (typeof normalizeSeats === 'function' ? normalizeSeats([...nextSeats, ...extra]) : [...nextSeats, ...extra])
    const added = extra.map((s) => s.id)
    if (extra.length || merged.changed) patch.chatroomSeats = nextSeats
    if (Object.keys(patch).length) await applyPatch(patch)
    let memberIds = []
    if (typeof ensureRoomMembers === 'function') {
      memberIds = await ensureRoomMembers(room.id, { addIds: added })
    }
    last = {
      ok: true,
      at: now(),
      reason,
      roomId: room.id,
      roomTitle: room.title,
      created,
      lost,
      imported: added,
      added,
      skipped: [],
      invalid: agents.filter((a) => a && !a.removed && codeError(a.code)).map((a) => ({ id: a.code, name: a.name })),
      memberIds,
    }
    return last
  }

  /** 串行执行；出错时记录正式的中文说明，不抛出。 */
  function sync(reason = 'save') {
    const p = chain.then(() => run(reason)).catch((error) => {
      last = { ok: false, at: now(), reason, error: `同步聊天室失败：${error?.message || error}` }
      return last
    })
    chain = p
    return p
  }

  return { sync, rooms, last: () => last }
}
