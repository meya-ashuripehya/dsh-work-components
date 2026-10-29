/**
 * 聊天室成员 → Minecraft NPC。席位来自席位池（chatroomSeats），不接受模型自报的成员 id。
 * 优先：绑定聊天室的成员 id 列表（cfg.mcRoomSeatIds，或 setBoundRoomSeatIds 写入的缓存）中已启用且合法的席位。
 * 回退：旧「Minecraft AI」表（gb_minecraft_MC_AGENTS）中已启用、未移除的编码 ∩ 已启用席位。
 * 表从未保存过时按旧 MC_MEMBER_IDS 迁移。id 必须符合模组的 agent id 规则。
 */
import { memberToken } from './process.mjs'
import { activeAgents } from './agents.mjs'

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const TOKEN_HEADER = 'x-gamebot-member-token'

/** undefined = 未注入房间名册（走旧 MC_AGENTS 交集）；数组 = 绑定房间的席位 id（可为空）。 */
let boundRoomSeatIds = undefined

/** 宿主在绑定房间成员变化时写入，供 launch / 工具同步读取。传 undefined 清除。 */
export function setBoundRoomSeatIds(ids) {
  boundRoomSeatIds = Array.isArray(ids) ? ids.map((x) => String(x || '').trim()).filter(Boolean) : undefined
}

function roomSeatIdsOf(cfg) {
  if (Array.isArray(cfg?.mcRoomSeatIds)) return cfg.mcRoomSeatIds
  if (Array.isArray(boundRoomSeatIds)) return boundRoomSeatIds
  return null
}

function enabledPoolIds(cfg, source) {
  const enabled = []
  for (const seat of source) {
    const id = String(seat?.id || '').trim()
    if (!seat || seat.enabled === false || !AGENT_ID.test(id) || enabled.includes(id)) continue
    enabled.push(id)
  }
  return enabled
}

export function memberIdsFor(cfg) {
  const pool = Array.isArray(cfg?.chatroomSeats) ? cfg.chatroomSeats : []
  const byId = new Map(pool.filter((s) => s && s.id).map((s) => [String(s.id).trim(), s]))
  const roomIds = roomSeatIdsOf(cfg)
  if (roomIds) {
    const source = []
    for (const raw of roomIds) {
      const seat = byId.get(String(raw || '').trim())
      if (seat) source.push(seat)
    }
    return enabledPoolIds(cfg, source)
  }
  const enabled = enabledPoolIds(cfg, pool)
  const allow = new Set(activeAgents(cfg).map((a) => a.code))
  return enabled.filter((id) => allow.has(id))
}

/** 成员 id → NPC 名称（席位显示名；旧表回退）。 */
export function memberNamesFor(cfg) {
  const names = {}
  const pool = Array.isArray(cfg?.chatroomSeats) ? cfg.chatroomSeats : []
  const ids = memberIdsFor(cfg)
  const byId = new Map(pool.filter((s) => s && s.id).map((s) => [String(s.id).trim(), s]))
  for (const id of ids) {
    const seat = byId.get(id)
    if (seat) names[id] = String(seat.name || id)
  }
  if (Object.keys(names).length) return names
  for (const a of activeAgents(cfg)) names[a.code] = a.name
  return names
}

function baseUrl(cfg) {
  return String(cfg?.gamebotUrl || 'http://127.0.0.1:8766').replace(/\/$/, '')
}

export async function memberRequest(cfg, path, { method = 'GET', body, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const token = memberToken()
  if (!token) {
    throw new Error('成员令牌还没准备好。请先启用 GameBot · Minecraft，让工作台启动 body。')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl(cfg)}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        [TOKEN_HEADER]: token,
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { detail: text } }
    if (!res.ok) {
      if (res.status === 503) throw new Error('成员接口没有令牌。请从工作台重启 GameBot body，不要复用外部启动的进程。')
      if (res.status === 401) throw new Error('缺少成员令牌')
      if (res.status === 403) throw new Error('成员令牌被拒绝')
      const detail = data?.detail || data?.error || `HTTP ${res.status}`
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('成员接口超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function reconcileMembers(cfg, { fetchImpl = fetch } = {}) {
  const memberIds = memberIdsFor(cfg)
  if (!memberIds.length) return { ok: true, members: [], note: '没有可连接的成员席位' }
  const data = await memberRequest(cfg, '/v1/minecraft/members/reconcile', {
    method: 'POST',
    body: { member_ids: memberIds, names: Object.fromEntries(Object.entries(memberNamesFor(cfg)).filter(([id]) => memberIds.includes(id))) },
    fetchImpl,
    timeoutMs: 30000,
  })
  const members = Array.isArray(data?.members) ? data.members : []
  const connected = members.filter((item) => item?.connected).length
  return { ok: true, members, note: `成员 NPC：${connected}/${memberIds.length} 已连接` }
}

export async function memberStatusSummary(cfg, { fetchImpl = fetch } = {}) {
  const ids = memberIdsFor(cfg)
  if (!ids.length) return '成员 NPC：0 个已启用席位'
  if (!memberToken()) return '成员 NPC：令牌未就绪'
  let connected = 0
  let unconfigured = false
  await Promise.all(ids.map(async (id) => {
    try {
      const data = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(id)}/status`, { fetchImpl, timeoutMs: 4000 })
      if (data?.connected) connected += 1
    } catch (error) {
      if (/没有令牌|重启 GameBot/.test(String(error?.message || ''))) unconfigured = true
    }
  }))
  if (unconfigured) return `成员 NPC：body 没有成员令牌（${ids.length} 个席位）。请从工作台重启 GameBot。`
  return `成员 NPC：${connected}/${ids.length} 已连接`
}


/**
 * One seat's Minecraft presence for chatroom prompts.
 * Soft-fails: never throws; returns null when Minecraft is off.
 * @returns {Promise<null|{ eligible:boolean, connected:boolean|null, connecting:boolean|null, exists:boolean|null, last_error:string|null, username:string|null, agent_id:string|null, detail:string, lines:string[] }>}
 */
export async function seatMcPresence(cfg, memberId, { fetchImpl = fetch } = {}) {
  if (cfg?.['gamebot-minecraftEnabled'] !== true) return null
  const id = String(memberId || '').trim()
  if (!id) return null
  const eligible = memberIdsFor(cfg).includes(id)
  const base = {
    eligible,
    connected: null,
    connecting: null,
    exists: null,
    last_error: null,
    username: null,
    agent_id: null,
  }
  if (!eligible) {
    const detail = 'Minecraft is on, but this seat is not on the Minecraft AI roster'
    return {
      ...base,
      detail,
      lines: [
        `- Minecraft: enabled, but your seat (${id}) is not in the bound chatroom roster — you have no NPC. Chatroom turns stay separate from in-game control.`,
      ],
    }
  }
  if (!memberToken()) {
    const detail = 'Minecraft seat eligible; member token not ready'
    return {
      ...base,
      detail,
      lines: [
        `- Minecraft seat: you have NPC code "${id}". Status: body token not ready (restart GameBot from the workbench). Tools when ready: mc_status, mc_connect, mc_observe, mc_act, mc_cancel, mc_disconnect. Chatroom rounds do not drive the world — call mc_* when you want to act in-game.`,
      ],
    }
  }
  try {
    const data = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(id)}/status`, { fetchImpl, timeoutMs: 4000 })
    const connected = !!data?.connected
    const connecting = !!data?.connecting
    const exists = data?.exists !== false
    const last_error = data?.last_error == null || data?.last_error === '' ? null : String(data.last_error).slice(0, 200)
    const username = data?.username == null || data?.username === '' ? null : String(data.username).slice(0, 64)
    const agent_id = data?.agent_id == null || data?.agent_id === '' ? null : String(data.agent_id).slice(0, 64)
    let status = 'not connected'
    if (connected) status = 'connected'
    else if (connecting) status = 'connecting'
    else if (exists === false) status = 'no session yet'
    const who = username || agent_id || id
    const err = last_error ? ` last_error: ${last_error}.` : ' last_error: none.'
    const detail = `Minecraft seat ${id}: ${status}`
    return {
      eligible: true,
      connected,
      connecting,
      exists,
      last_error,
      username,
      agent_id,
      detail,
      lines: [
        `- Minecraft seat: you have NPC code "${id}"${who !== id ? ` (in-world: ${who})` : ''}. Status: ${status}.${err} Tools: mc_status, mc_connect, mc_observe, mc_act, mc_cancel, mc_disconnect. Chatroom rounds do not drive the world — call mc_* when you want to act in-game.`,
      ],
    }
  } catch (error) {
    const msg = String(error?.message || error || 'status failed').slice(0, 160)
    const detail = `Minecraft seat ${id}: status unavailable (${msg})`
    return {
      ...base,
      eligible: true,
      last_error: msg,
      detail,
      lines: [
        `- Minecraft seat: you have NPC code "${id}". Status: could not reach GameBot (${msg}). Try mc_status later. Chatroom rounds do not drive the world.`,
      ],
    }
  }
}

/**
 * Cached resolver for createModerator({ resolveMcInfo }).
 * Returns null when Minecraft is off; otherwise seatMcPresence for seat.id.
 */
export function createMcPresenceResolver({ getConfig, fetchImpl = fetch, ttlMs = 3000 } = {}) {
  const cache = new Map() // id → { at, value }
  return async function resolveMcInfo(seat) {
    const cfg = typeof getConfig === 'function' ? getConfig() : getConfig
    if (cfg?.['gamebot-minecraftEnabled'] !== true) return null
    const id = String(seat?.id || '').trim()
    if (!id) return null
    const now = Date.now()
    const hit = cache.get(id)
    if (hit && now - hit.at < ttlMs) return hit.value
    const value = await seatMcPresence(cfg, id, { fetchImpl })
    cache.set(id, { at: now, value })
    return value
  }
}
