/**
 * 聊天室工具门禁：聊天室直接执行注册表中的工具（不经 ctx.tools.guard），所以在这里自行把关。
 *   - 所有者回合：本机桌面端的消息，或 Telegram 用户 ID 等于所有者 ID 的消息 → 可用房间工具集中的全部工具。
 *   - 其他回合：只开放只读的 OPEN_TOOLS（与 Telegram 通道的所有者门禁同一份清单）。
 */
import { OPEN_TOOLS, DENY_MESSAGE, isOwnerOnlyTool, isOpenTool } from '../channels/telegram/owner-gate.mjs'

export { OPEN_TOOLS, DENY_MESSAGE, isOwnerOnlyTool }

/** 触发本任务的用户消息是否来自所有者。 */
export function isOwnerMessage(msg, ownerId) {
  if (!msg || msg.kind !== 'user') return false
  if (msg.source !== 'telegram') return true
  const id = String(msg.speaker?.id || '').replace(/^tg:/, '')
  return msg.owner === true && !!ownerId && id === String(ownerId)
}

export const isOpen = (name) => isOpenTool(String(name || ''))

/** 开局、关局、重置：仅所有者。会改本机（下载或写存档）。 */
export const GAME_OWNER_TOOLS = new Set(['board_open', 'board_close', 'board_reset', 'card_open', 'card_close', 'card_reset'])
/** 看局面、走子、提示：按座位校验，不再经由 OPEN_TOOLS 放行。 */
export const GAME_ACTION_TOOLS = new Set(['board_look', 'board_play', 'board_hint', 'card_look', 'card_play'])
/** 聊天室成员各自的 Minecraft NPC。身份在工具内部核对，不看所有者。 */
export const MC_MEMBER_TOOLS = [
  'mc_connect', 'mc_observe', 'mc_act', 'mc_cancel', 'mc_status', 'mc_disconnect',
  'mc_blueprint_submit', 'mc_blueprint_preview', 'mc_task_claim', 'mc_task_continue',
  'mc_work_stop', 'mc_work_status', 'mc_conflict_decide', 'mc_material_claim', 'mc_work_resolve',
]
const MC_MEMBER_TOOL_SET = new Set(MC_MEMBER_TOOLS)

export function isLegacyGamebotTool(name) {
  return String(name || '').startsWith('mcp__gamebot-')
}

export function isGameTool(name) {
  const n = String(name || '')
  return GAME_OWNER_TOOLS.has(n) || GAME_ACTION_TOOLS.has(n)
}

/** 本回合可暴露给模型的工具名。 */
export function allowedNames(names, owner) {
  return (names || []).filter((n) => !isLegacyGamebotTool(n) && (owner || isOpen(n) || (owner && isGameTool(n))))
}

/**
 * 执行前复核：返回 null 表示放行，否则为拒绝原因。
 * gameTurn：这一步是对局调度叫来的成员，可以看和走自己的座位。
 * 开局类始终要求所有者。行动类不再因为 OPEN_TOOLS 对旁人放行。
 */
export function denyReason(name, { owner, inToolset, gameTurn = false } = {}) {
  const n = String(name || '')
  if (isLegacyGamebotTool(n)) return 'Minecraft 成员 NPC 请用 mc_connect、mc_observe、mc_act、mc_cancel、mc_status、mc_disconnect，不要用旧的 gamebot MCP 桥。'
  if (MC_MEMBER_TOOL_SET.has(n)) return null
  if (GAME_OWNER_TOOLS.has(n)) {
    if (!owner) return '只有所有者可以开局、结束或重开。'
    return null
  }
  if (GAME_ACTION_TOOLS.has(n)) {
    if (!owner && !gameTurn) return '只能在自己的座位上行动。'
    return null
  }
  if (!owner && isOwnerOnlyTool(n)) return DENY_MESSAGE
  if (!inToolset) return `工具 ${name} 不在房间工具集中，请先用 find_tools 查找。`
  if (!owner && !isOpen(n)) return DENY_MESSAGE
  return null
}
