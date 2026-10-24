/**
 * 房间控制工具（房间级，所有成员每个回合都可用，不经 find_tools，不受所有者门禁——只改房间状态，不碰电脑）：
 *   set_main_answerer(member, reason)  切换主答：本任务立即生效（新主答下一个发言），并写入设置「默认主答」（之后的任务也由其主答）
 *   set_leader(member, reason)         切换领队（起草 Cursor 任务书的成员）：写入成员设置
 *   end_round(reason?)                 提前结束本轮（只给本轮主答与领队；棋局回合不提供）：回合成功后生效，调度器随即停下——
 *                                      不再请其他成员发言，不写预算提示 / 汇报；用户看到一条不转发、不进提示词的「×× 结束了这一轮」。
 * 回合预算对 AI 完全不可见，没有追加预算的工具（只有所有者回复「批准 +N」可追加，见 moderator）。
 * 防循环：主答、领队每个任务各最多切换 MAX_SWITCHES_PER_TASK 次，不能切回本任务中已担任过该角色的成员（防来回切换），
 *   同一回合内每种操作只能调用一次。目标必须是存在且参与发言的成员（名字 / 编号 / 别名 / 预设编号，不区分大小写）。
 * 执行时机：回合内只校验并预约；回合成功结束时才生效并在房间写一条系统通知（同时转发 Telegram 群）；
 *   回合失败或被「停止」时取消预约，不生效、不留通知（与「失败的 AI 轮次不记入历史」一致）。
 * 纯函数部分在此；状态与持久化由 moderator 处理。
 */
import { findSeat } from './directives.mjs'

export const SET_MAIN_NAME = 'set_main_answerer'
export const SET_LEADER_NAME = 'set_leader'
export const END_ROUND_NAME = 'end_round'
export const ROOM_CONTROL_NAMES = new Set([SET_MAIN_NAME, SET_LEADER_NAME, END_ROUND_NAME])

export const MAX_SWITCHES_PER_TASK = 2

const memberParam = { type: 'string', description: 'Member name as shown in the roster (case-insensitive; id, alias or preset id also accepted).' }
const reasonParam = { type: 'string', description: 'One short sentence explaining why. Shown to everyone in the room.' }

export const SET_MAIN_ANSWERER = {
  name: SET_MAIN_NAME,
  description: 'Let someone else answer first, now and for later messages (saved to the room settings). Handy when a topic is clearly more their thing, or the owner asks for it. To just pass the next turn, end your message with [[NEXT: Name]] instead. Takes effect after your turn; at most ' + MAX_SWITCHES_PER_TASK + ' switches per owner message, and no switching back and forth.',
  parameters: { type: 'object', properties: { member: memberParam, reason: reasonParam }, required: ['member'] },
}

export const SET_LEADER = {
  name: SET_LEADER_NAME,
  description: 'Make someone else the leader (the one who writes Cursor task briefs with cursor_handoff). Only when the group agrees they are better placed, or the owner asks. Takes effect after your turn and is saved to the member settings; at most ' + MAX_SWITCHES_PER_TASK + ' switches per owner message, and no switching back and forth.',
  parameters: { type: 'object', properties: { member: memberParam, reason: reasonParam }, required: ['member'] },
}

export const ROOM_CONTROL_TOOLS = [SET_MAIN_ANSWERER, SET_LEADER]

/** end_round：世界控制台上的「暂停」键。只给本轮主答与领队（见 canEndRound）。 */
export function endRoundTool(userName = 'the owner') {
  return {
    name: END_ROUND_NAME,
    description: `Go to the world's console and press pause: this round of chat ends right after your turn, and nobody else speaks until ${userName} writes again. Press it when the matter is done or everyone is now waiting on ${userName} (an answer, a decision, 「执行」, or an in-flight Cursor handoff — ending the round does not cancel Cursor). Don't press it while someone still has a real point pending or a question to them is still open. Write your message as usual in the same turn; the pause only happens if your turn goes through. Only the main answerer and the leader have this button.`,
    parameters: { type: 'object', properties: { reason: { type: 'string', description: `Optional short note on why, for ${userName} only (the others don't see it).` } } },
  }
}

/** 能否结束本轮：本轮主答或领队；棋局回合（gameTurn）与没有任务时不行。 */
export function canEndRound(seat, task) {
  if (!seat || !task || task.gameTurn || task.state && task.state !== 'running') return false
  return task.main === seat.id || !!seat.leader
}

/** 「×× 结束了这一轮」（只在界面显示）。 */
export function endRoundNotice(by, reason) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${by} 结束了这一轮${why ? '（理由：' + why + '）' : ''}`
}

const normKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '')

/** 名字 → 席位：名字 / 编号 / 别名，其次唯一匹配的预设编号；返回 { seat } 或 { error }（英文，给模型看）。 */
export function resolveMember(seats, raw) {
  const name = String(raw ?? '').trim().replace(/^@/, '')
  if (!name) return { error: 'member is required.' }
  let seat = findSeat(seats, name)
  if (!seat) {
    const byPreset = seats.filter((s) => s.preset && normKey(s.preset) === normKey(name))
    if (byPreset.length === 1) seat = byPreset[0]
  }
  const roster = seats.filter((s) => s.enabled !== false).map((s) => s.name).join(', ')
  if (!seat) return { error: `No member named "${name.slice(0, 40)}". Members: ${roster}.` }
  if (seat.enabled === false) return { error: `${seat.name} is not taking part in this room (disabled). Members: ${roster}.` }
  return { seat }
}

/** 每个任务的控制记录（挂在 task 上）。 */
export function controlState(task) {
  if (!task.ctl) task.ctl = { mainHistory: [], leaderHistory: [], mainSwitches: 0, leaderSwitches: 0 }
  return task.ctl
}

/** 校验切换（kind: 'main' | 'leader'）；current = 当前担任者 seatId。返回 null 或错误文字。 */
export function checkSwitch(task, kind, target, current) {
  const st = controlState(task)
  const label = kind === 'main' ? 'main answerer' : 'leader'
  if (target.id === current) return `${target.name} is already the ${label}.`
  if ((kind === 'main' ? st.mainSwitches : st.leaderSwitches) >= MAX_SWITCHES_PER_TASK) return `The ${label} was already switched ${MAX_SWITCHES_PER_TASK} times for this user message; no more switches until the owner writes again.`
  const hist = kind === 'main' ? st.mainHistory : st.leaderHistory
  if (hist.includes(target.id)) return `${target.name} was already ${label} earlier in this task; switching back is refused to avoid ping-pong.`
  return null
}

/** 系统通知（正式中文）。 */
export function controlNotice(kind, { by, target, reason }) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const tail = why ? `（理由：${why}）` : ''
  if (kind === 'main') return `${by} 将主答切换为 ${target}${tail}`
  return `${by} 将领队切换为 ${target}${tail}`
}
