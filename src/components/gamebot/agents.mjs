/**
 * Minecraft AI 表（设置键 gb_minecraft_MC_AGENTS，JSON 字符串）。
 * 每行 = 一个 MC AI：{ code, name, enabled, removed, provider, model, preset, reasoningEffort, persona }。
 * - code：小写字母、数字、连字符，最长 32；须与聊天室成员 id 相同才能对应到该成员。保存后不可修改。
 * - name：显示名，也是游戏内 NPC 名（取代旧的 MC_USERNAME）。
 * - removed：软删除（标记为已移除并下线，信息保留，可恢复）。
 * 迁移：MC_AGENTS 为空字符串（从未保存过）时，按旧的 MC_MEMBER_IDS / MC_USERNAME 一次性生成；
 *       保存过（哪怕是 "[]"）就不再迁移。lib/client.js 的设置页有同一套逻辑（浏览器脚本无法 import）。
 */
export const AGENT_CODE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const AGENTS_KEY = 'gb_minecraft_MC_AGENTS'
const LEGACY_IDS_KEY = 'gb_minecraft_MC_MEMBER_IDS'
const LEGACY_NAME_KEY = 'gb_minecraft_MC_USERNAME'
const NAME_WIDTH_MAX = 12

/** 游戏内名称的显示宽度：ASCII 记 1，其余记 2。上限 12。 */
export function nameWidth(name) {
  let width = 0
  const text = String(name ?? '')
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)
    width += cp > 0xff ? 2 : 1
    i += cp > 0xffff ? 2 : 1
  }
  return width
}

export function nameError(name) {
  if (nameWidth(name) > NAME_WIDTH_MAX) return `名称最多 ${NAME_WIDTH_MAX} 个显示宽度（一个汉字算 2）。`
  return ''
}

const str = (v) => (v == null ? '' : String(v))

/** 校验编码；合法返回 ''，否则返回正式的中文说明。taken：已占用的编码。 */
export function codeError(code, taken = []) {
  const c = String(code ?? '')
  if (!c.trim()) return '编码不能为空。'
  if (c.length > 32) return '编码长度不能超过 32 个字符。'
  if (!AGENT_CODE.test(c)) return '编码只能包含小写字母、数字和连字符（-），且须以小写字母或数字开头。'
  if (taken.includes(c)) return `编码「${c}」已存在，请使用其他编码。`
  return ''
}

function named(agent, name) {
  agent.name = name
  if (nameWidth(name) > NAME_WIDTH_MAX) agent.nameOverLimit = true
  return agent
}

/** 规范化一行；编码不合法返回 null。超宽名称保留原文并标出，不截断、不改名。 */
export function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const code = str(raw.code ?? raw.agent_id).trim()
  if (codeError(code)) return null
  return named({
    code,
    enabled: raw.enabled !== false,
    removed: raw.removed === true,
    provider: str(raw.provider),
    model: str(raw.model),
    preset: str(raw.preset),
    reasoningEffort: str(raw.reasoningEffort),
    persona: str(raw.persona),
  }, str(raw.name).trim() || code)
}

/** 解析已保存的表：丢弃不合法与重复编码的行。未保存过返回 null。 */
export function parseAgents(text) {
  const raw = str(text).trim()
  if (!raw) return null
  let list
  try { list = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const row = normalizeAgent(item)
    if (row && !out.some((x) => x.code === row.code)) out.push(row)
  }
  return out
}

export const serializeAgents = (list) => JSON.stringify(list.map(normalizeAgent).filter(Boolean))

const seatsOf = (cfg) => (Array.isArray(cfg?.chatroomSeats) ? cfg.chatroomSeats.filter((s) => s && typeof s === 'object') : [])

/** 由聊天室成员生成一行（只读取成员配置，不修改成员）。 */
export function agentFromSeat(seat) {
  return normalizeAgent({
    code: str(seat?.id).trim(),
    name: seat?.name,
    enabled: true,
    provider: seat?.provider,
    model: seat?.model,
    preset: seat?.preset,
    reasoningEffort: seat?.reasoningEffort,
    persona: seat?.persona,
  })
}

/** 旧设置迁移：MC_MEMBER_IDS 留空 = 全部已启用席位；填写 = 这些 id。只有一行时沿用非默认的 MC_USERNAME 作为名称。 */
export function migrateLegacyAgents(cfg) {
  const seats = seatsOf(cfg)
  const ids = str(cfg?.[LEGACY_IDS_KEY]).split(/[,，\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
  const picked = ids.length
    ? ids.map((id) => seats.find((s) => str(s.id).trim() === id) || { id })
    : seats.filter((s) => s.enabled !== false)
  const out = []
  for (const seat of picked) {
    const row = agentFromSeat(seat)
    if (row && !out.some((x) => x.code === row.code)) out.push(row)
  }
  const legacyName = str(cfg?.[LEGACY_NAME_KEY]).trim()
  if (out.length === 1 && legacyName && legacyName !== 'Player') {
    out[0].name = legacyName
    if (nameWidth(legacyName) > NAME_WIDTH_MAX) out[0].nameOverLimit = true
    else delete out[0].nameOverLimit
  }
  return out
}

/** 当前生效的表：已保存的，或（从未保存过时）由旧设置迁移得到的。 */
export function resolveAgents(cfg) {
  return parseAgents(cfg?.[AGENTS_KEY]) ?? migrateLegacyAgents(cfg)
}

/** 启用且未移除的行。 */
export const activeAgents = (cfg) => resolveAgents(cfg).filter((a) => a.enabled && !a.removed)

/** 软删除 / 恢复：不删数据，只改 removed 标记。 */
export function setRemoved(list, code, removed) {
  return list.map((a) => (a.code === code ? { ...a, removed: !!removed } : a))
}

/**
 * 从聊天室导入：ids 为所选成员 id。编码已存在的成员只有 overwrite 为 true 时才覆盖（覆盖时恢复为未移除）。
 * 返回 { agents, added, overwritten, conflicts, invalid }；不修改传入的成员与表。
 */
export function importFromSeats(list, seats, ids, { overwrite = false } = {}) {
  const agents = list.map((a) => ({ ...a }))
  const res = { agents, added: [], overwritten: [], conflicts: [], invalid: [] }
  for (const id of ids) {
    const seat = (seats || []).find((s) => s && str(s.id) === id)
    const row = seat && agentFromSeat(seat)
    if (!row) { res.invalid.push(id); continue }
    const at = agents.findIndex((a) => a.code === row.code)
    if (at < 0) { agents.push(row); res.added.push(row.code); continue }
    if (!overwrite) { res.conflicts.push(row.code); continue }
    agents[at] = { ...row, enabled: agents[at].enabled }
    res.overwritten.push(row.code)
  }
  return res
}

/**
 * 绑定聊天室的成员对齐（纯函数）。聊天室成员（chatroomSeats）对所有房间通用，所以「房间成员」即全部席位。
 * - importRows：编码合法、尚无对应 MC 行的成员 → 新建 MC 行（复制配置，启用状态沿用成员；不修改成员）。
 * - invalid：id 不符合编码规则的成员（只提示，不导入）。
 * - addSeats：已启用、未移除、但不在成员中的 MC AI → 作为新成员加入（沿用名称 / 服务商 / 模型 / 预设 / 推理强度 / 附加人设）。
 * 已移除（软删除）的 MC 行既不会被重新加入，也不会从房间中移除；同名编码的行已存在时不导入（幂等）。
 */
export function planRoomSync(agents, seats) {
  const list = (Array.isArray(seats) ? seats : []).filter((s) => s && typeof s === 'object')
  const codes = new Set((agents || []).map((a) => a.code))
  const importRows = []
  const invalid = []
  for (const seat of list) {
    const id = str(seat.id).trim()
    if (codeError(id)) { invalid.push({ id, name: str(seat.name) }); continue }
    if (codes.has(id)) continue
    const row = agentFromSeat(seat)
    row.enabled = seat.enabled !== false
    importRows.push(row)
    codes.add(id)
  }
  const seatIds = new Set(list.map((s) => str(s.id).trim()))
  const addSeats = (agents || [])
    .filter((a) => a.enabled && !a.removed && !seatIds.has(a.code))
    .map((a) => ({ id: a.code, name: a.name, provider: a.provider, model: a.model, preset: a.preset, reasoningEffort: a.reasoningEffort, persona: a.persona, enabled: true }))
  return { importRows, invalid, addSeats }
}
