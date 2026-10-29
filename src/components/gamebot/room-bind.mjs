/**
 * Minecraft 设置卡片「绑定聊天室」（设置键 gb_minecraft_MC_CHATROOM = 房间 id）。
 * 同步（保存 Minecraft 卡片、启用 Minecraft 时运行，可重复执行）：
 * 1. 未绑定或所绑定房间已不存在 → 新建房间「Minecraft」，并把房间 id 写回设置。
 * 2. 聊天室成员 → MC AI：按编码 = 成员 id 自动建行（见 agents.planRoomSync）；不修改成员。
 * 3. 已启用的 MC AI 不在成员中 → 加入成员（经宿主的设置写入，与 PUT /chatroom/seats 相同的 normalizeSeats）。
 * 聊天室成员对所有房间通用，因此第 3 步加入的成员在所有房间都可见。游戏内发言镜像不在这次同步里，见 mc-mirror.mjs。
 * 不向聊天室注册任何 GameBot / MC 工具。
 */
import { AGENTS_KEY, planRoomSync, resolveAgents, serializeAgents } from './agents.mjs'

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
 *   ensureSession?: (roomId: string) => Promise<any>, applyPatch: (patch: any) => Promise<void>, normalizeSeats: (list: any[]) => any[],
 *   now?: () => number }} deps
 */
export function createMinecraftRoomBinding({ getConfig, store, ensureSession, applyPatch, normalizeSeats, now = Date.now }) {
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
    const agents = resolveAgents(cfg)
    const seats = Array.isArray(cfg.chatroomSeats) ? cfg.chatroomSeats : []
    const plan = planRoomSync(agents, seats)
    const patch = {}
    if (room.id !== bound) patch[ROOM_KEY] = room.id
    if (plan.importRows.length) patch[AGENTS_KEY] = serializeAgents([...agents, ...plan.importRows])
    let added = []
    if (plan.addSeats.length) {
      const nextSeats = normalizeSeats([...seats, ...plan.addSeats])
      const have = new Set(seats.map((s) => String(s?.id || '')))
      added = nextSeats.filter((s) => !have.has(s.id)).map((s) => s.id)
      patch.chatroomSeats = nextSeats
    }
    if (Object.keys(patch).length) await applyPatch(patch)
    last = {
      ok: true,
      at: now(),
      reason,
      roomId: room.id,
      roomTitle: room.title,
      created,
      lost,
      imported: plan.importRows.map((r) => r.code),
      added,
      skipped: plan.addSeats.map((s) => s.id).filter((id) => !added.includes(id)),
      invalid: plan.invalid,
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
