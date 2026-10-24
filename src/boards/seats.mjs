/**
 * 棋局座位。省略 seats 时仍是「一个 AI 对一个人类」（通道 / 桌面旧局）。
 * 显式座位用于中转站：AI 立即入座；人类保持 pending，直到本人回复「入座」。
 */
import { BoardError } from './errors.mjs'

const ALIAS = { red: 'red', 红: 'red', black: 'black', 黑: 'black', white: 'white', 白: 'white' }

export function normalizeSide(game, value, pairs) {
  const raw = String(value ?? '').trim()
  const side = ALIAS[raw.toLowerCase()] || ALIAS[raw]
  if (!side || !pairs[game]?.includes(side)) return ''
  return side
}

export function seatOnSide(seats, side) {
  return (seats || []).find((s) => s.side === side) || null
}

/**
 * @param {string} game
 * @param {Array|undefined} input
 * @param {{ aiSide: string, humanSide: string, playerName: string, pairs: object }} ctx
 */
export function normalizeBoardSeats(game, input, ctx) {
  if (!input) {
    return {
      mode: 'legacy',
      seats: [
        { seatId: 'ai', side: ctx.aiSide, kind: 'ai', name: 'AI', status: 'seated' },
        { seatId: 'human', side: ctx.humanSide, kind: 'human', name: ctx.playerName, ref: 'local', local: true, status: 'seated' },
      ],
    }
  }
  if (!Array.isArray(input) || input.length !== 2) throw new BoardError('seats 需要双方各一个')
  const seats = []
  const seen = new Set()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new BoardError('seats 里的每一项都要写明 side 和 kind')
    const side = normalizeSide(game, raw.side, ctx.pairs)
    if (!side) throw new BoardError('side 只能是这盘棋的一方')
    if (seen.has(side)) throw new BoardError('同一方不能有两个座位')
    seen.add(side)
    const kind = raw.kind === 'human' ? 'human' : raw.kind === 'ai' ? 'ai' : ''
    if (!kind) throw new BoardError('kind 只能是 ai 或 human')
    const name = String(raw.name || '').trim().slice(0, 40)
    if (kind === 'ai') {
      const memberId = String(raw.memberId || '').trim()
      if (!memberId) throw new BoardError('AI 座位需要 memberId（聊天室成员编号）')
      seats.push({ seatId: memberId, side, kind, name: name || memberId, memberId, status: 'seated' })
    } else {
      const tg = String(raw.telegramUserId || '').trim()
      const local = raw.local === true || tg === 'local' || raw.ref === 'local'
      if (!local && !/^-?\d{1,20}$/.test(tg)) throw new BoardError('人类座位需要 telegramUserId，或 local 表示桌面')
      seats.push({
        seatId: local ? 'local' : `tg:${tg}`,
        side,
        kind,
        name: name || (local ? ctx.playerName : tg),
        ...(local ? { ref: 'local', local: true } : { telegramUserId: tg }),
        status: 'pending',
      })
    }
  }
  const pair = ctx.pairs[game]
  if (seen.size !== 2 || pair.some((s) => !seen.has(s))) throw new BoardError('seats 必须正好覆盖这盘棋的双方')
  return { mode: 'seats', seats }
}

/** AI 走子：有 memberId 的座位只能由该成员调用。旧局没有 memberId，仍允许唯一的 AI 方。 */
export function assertAiMove(session, caller) {
  const side = session.engine.view().turnSide
  const seat = seatOnSide(session.seats, side)
  if (!seat || seat.kind !== 'ai' || seat.status !== 'seated') throw new BoardError('现在是对方的回合', 409)
  if (seat.memberId && caller?.memberId !== seat.memberId) throw new BoardError('只能走自己这一方的棋', 403)
  return seat
}

/** 人类走子。不传 caller 时沿用旧局（页面 / 通道已另行核对是谁）。 */
export function assertHumanMove(session, caller) {
  const side = session.engine.view().turnSide
  const seat = seatOnSide(session.seats, side)
  if (!seat || seat.kind !== 'human' || seat.status !== 'seated') throw new BoardError('现在是 AI 的回合', 409)
  if (caller && !humanMatches(seat, caller)) throw new BoardError('只能走自己这一方的棋', 403)
  return seat
}

export function humanMatches(seat, caller) {
  if (!seat || seat.kind !== 'human') return false
  if (caller?.telegramUserId && String(seat.telegramUserId || '') === String(caller.telegramUserId)) return true
  if (caller?.local && (seat.local || seat.ref === 'local')) return true
  return false
}

/** 待确认的人类回复「入座」。返回入座的座位，没有则 null。 */
export function confirmHuman(session, caller) {
  const pending = (session.seats || []).filter((s) => s.kind === 'human' && s.status === 'pending' && humanMatches(s, caller))
  const seat = pending[0]
  if (!seat) return null
  seat.status = 'seated'
  return seat
}
