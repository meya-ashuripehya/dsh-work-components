/**
 * 座位模型。
 *
 * mode = 'versus'（与 AI 对战，card_open 的默认）：
 *   座位 0 是用户（只能在页面点牌或在 Telegram 里出牌），座位 1 是对话里的 AI（只能用 card_* 工具），
 *   其余座位由插件内置机器人自动走。工具只返回 AI 自己座位的私有视图（自己的手牌 + 公开信息），
 *   页面 / Telegram 只显示用户的手牌。二十一点只有一个闲家座位：用户打这手，AI 只能看庄家明牌和结果。
 * mode = 'solo'（代打）：旧版行为。AI 坐座位 0，对手全是机器人；页面是观战视角（也允许点牌）。
 *   会话层直接调用 openSession 而不传 mode 时也是 solo，旧存档没有 mode 字段时按调用方给的 mode 续局。
 */
import { cardCode } from './rules.mjs'

export const MODES = ['versus', 'solo']
export const USER_SEAT = 0

export function normalizeMode(value, fallback = 'solo') {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'versus' || text === 'vs' || text === '对战' || text === '与 ai 对战' || text === '与ai对战') return 'versus'
  if (text === 'solo' || text === '代打' || text === 'proxy') return 'solo'
  return fallback
}

export function seatCount(game, state) {
  if (game === 'blackjack') return 1
  return state.hands.length
}

/** 开局时指定的座位分配（仅 UNO：options.seats，每项 'user' | 'ai' | 'bot'）；旧存档没有则为 null。 */
export function seatRoles(session) {
  const seats = session?.options?.seats
  return Array.isArray(seats) ? seats : null
}

/**
 * 校验座位分配：长度等于人数，每项 user / ai / bot；
 * versus 恰好一个 user、最多一个 ai；solo 没有 user、恰好一个 ai。返回错误文本，合法时返回空串。
 */
export function seatsProblem(seats, mode, players) {
  if (!Array.isArray(seats)) return 'seats must be an array of seat roles ("user", "ai" or "bot")'
  if (seats.length !== players) return `seats must list exactly ${players} roles (one per seat), got ${seats.length}`
  const bad = seats.find((r) => r !== 'user' && r !== 'ai' && r !== 'bot')
  if (bad !== undefined) return `invalid seat role "${bad}": use "user", "ai" or "bot"`
  const users = seats.filter((r) => r === 'user').length
  const ais = seats.filter((r) => r === 'ai').length
  if (users + ais === 0) return 'seats must contain at least one non-bot seat'
  if (mode === 'versus') {
    if (users !== 1) return `versus mode needs exactly one "user" seat, got ${users}`
    if (ais > 1) return `there is only one AI player: at most one "ai" seat, got ${ais}`
  } else {
    if (users !== 0) return 'solo mode has no user seat: use "ai" for your seat and "bot" for the rest'
    if (ais !== 1) return `solo mode needs exactly one "ai" seat, got ${ais}`
  }
  return ''
}

/** AI 的座位；versus 二十一点没有 AI 座位（null）；座位分配里没有 ai 时也为 null。 */
export function agentSeatOf(session) {
  const roles = seatRoles(session)
  if (roles) {
    const i = roles.indexOf('ai')
    return i >= 0 ? i : null
  }
  if (session.mode !== 'versus') return USER_SEAT
  return session.game === 'blackjack' ? null : 1
}

/** 用户的座位（versus）；solo 没有用户座位（null）。 */
export function userSeatOf(session) {
  if (session.mode !== 'versus') return null
  const roles = seatRoles(session)
  if (roles) {
    const i = roles.indexOf('user')
    return i >= 0 ? i : USER_SEAT
  }
  return USER_SEAT
}

/** 页面 / Telegram 下方「你」的座位：versus 是用户座位，solo 是 AI 的座位（页面可替它点）。 */
export function viewerSeatOf(session) {
  if (session.mode === 'versus') return userSeatOf(session)
  const seat = agentSeatOf(session)
  return seat == null ? USER_SEAT : seat
}

/** 组队时该座位的队伍编号（从 0 起），不组队为 null。 */
export function teamOfSeat(session, seat) {
  const teams = session?.state?.teams
  return teams && seat != null ? seat % teams : null
}

export function turnSeat(game, state) {
  if (state.over) return null
  return game === 'blackjack' ? 0 : state.turn
}

/** 'user' | 'agent' | 'bot'。solo 时座位 0 归 AI（用户在页面上也可以替它点）。 */
export function roleOf(session, seat) {
  if (seat == null) return 'over'
  if (session.mode !== 'versus') return seat === agentSeatOf(session) ? 'agent' : 'bot'
  if (seat === userSeatOf(session)) return 'user'
  return seat === agentSeatOf(session) ? 'agent' : 'bot'
}

export function seatLabel(session, seat) {
  const role = roleOf(session, seat)
  if (session.mode !== 'versus') return role === 'agent' ? 'AI（代打）' : `机器人 ${seat}`
  if (role === 'user') return session.playerName || '用户'
  if (role === 'agent') return 'AI'
  return `机器人 ${seat}`
}

function roster(session) {
  const n = seatCount(session.game, session.state)
  const out = []
  for (let seat = 0; seat < n; seat++) {
    const entry = { seat, role: roleOf(session, seat), name: seatLabel(session, seat) }
    const team = teamOfSeat(session, seat)
    if (team != null) entry.team = team + 1
    if (session.game !== 'blackjack') {
      const hand = session.state.hands[seat]
      entry.cards = typeof hand === 'string' ? hand.length : hand.length
    }
    out.push(entry)
  }
  if (session.game === 'doudizhu') for (const entry of out) entry.landlord = entry.seat === session.state.landlord
  return out
}

function unoCode(c) { return `${c.color}-${c.trait}` }

function teamSeats(session, team) {
  const n = session.state.hands.length
  const out = []
  for (let seat = 0; seat < n; seat++) if (seat % session.state.teams === team) out.push(seat)
  return out
}

/** 组队信息（公开）：每队的座位；不含任何手牌。 */
function teamInfo(session, seat) {
  const teams = session.state.teams
  if (!teams) return {}
  const list = []
  for (let t = 0; t < teams; t++) list.push({ team: t + 1, seats: teamSeats(session, t), names: teamSeats(session, t).map((s) => seatLabel(session, s)) })
  const info = { teams: list, teamRule: `Seats are split alternately into ${teams} teams (seat i is on team (i % ${teams}) + 1). A team wins as soon as any member empties their hand. You only see your own hand, never your teammates' hands.` }
  if (seat != null) {
    const mine = seat % teams
    info.yourTeam = mine + 1
    info.teammates = teamSeats(session, mine).filter((s) => s !== seat)
  }
  return info
}

/** 对 seat 而言的结局。 */
function outcomeFor(session, seat, over) {
  if (!over) return null
  const out = { reason: over.reason || '' }
  if (session.game === 'blackjack') {
    out.winner = over.winner
    return out
  }
  const pay = Array.isArray(over.payoffs) ? over.payoffs : []
  out.payoffs = pay.slice()
  if (seat != null && pay.length > seat) {
    out.yourPayoff = pay[seat]
    out.result = pay[seat] > 0 ? 'you_win' : pay[seat] < 0 ? 'you_lose' : 'draw'
  }
  if (over.winnerTeam !== undefined) {
    out.winnerTeam = over.winnerTeam + 1
    out.winnerTeamSeats = teamSeats(session, over.winnerTeam)
  }
  if (over.winnerSeat !== undefined) out.winnerSeat = over.winnerSeat
  else if (session.game === 'doudizhu') out.winnerSide = over.winner === 'player' ? 'landlord' : 'farmers'
  else if (over.winner === 'player') out.winnerSeat = 0
  else if (over.winner === 'ai') out.winnerSeat = 1
  if (out.winnerSeat !== undefined) out.winnerName = seatLabel(session, out.winnerSeat)
  return out
}

function privateTable(session, seat) {
  const s = session.state
  const game = session.game
  if (game === 'uno') {
    if (seat == null) return { topCard: unoCode(s.target), direction: s.direction === -1 ? 'counterclockwise' : 'clockwise', deckCount: s.deck.length, ...teamInfo(session, null) }
    return {
      yourHand: s.hands[seat].map(unoCode),
      topCard: unoCode(s.target),
      direction: s.direction === -1 ? 'counterclockwise' : 'clockwise',
      deckCount: s.deck.length,
      ...teamInfo(session, seat),
      ...(s.pending && s.turn === seat ? { drawnCard: unoCode(s.hands[seat][s.pending.index]), drawnNote: 'You just drew drawnCard and it is playable: play exactly that card (legal) or "pass" to keep it and end your turn.' } : {}),
    }
  }
  if (game === 'doudizhu') {
    const lastBy = s.greater == null ? null : s.greater
    return {
      yourHand: s.hands[seat],
      landlordSeat: s.landlord,
      bottom: s.bottom,
      lastPlay: s.last || '',
      lastPlaySeat: lastBy,
      ...(lastBy != null ? { lastPlayBy: seatLabel(session, lastBy) } : {}),
      ...(s.over ? { revealedHands: s.hands.slice() } : {}),
    }
  }
  if (game === 'leduc' || game === 'limit-holdem') {
    const other = 1 - seat
    const showdown = Boolean(s.over) && !s.folded[0] && !s.folded[1]
    return {
      yourHand: s.hands[seat].map(cardCode),
      board: s.board.map(cardCode),
      pot: s.chips[0] + s.chips[1],
      yourChips: s.chips[seat],
      opponentChips: s.chips[other],
      youAre: s.sb === seat ? 'small blind' : 'big blind',
      ...(showdown ? { opponentHand: s.hands[other].map(cardCode) } : {}),
    }
  }
  return {}
}

/**
 * 给 AI 的私有视图。只含 AI 自己座位的手牌和公开信息；用户座位的手牌永远不会出现（终局摊牌除外，
 * 那时已经公开）。versus 二十一点：只给庄家公开的牌、局面状态，不给用户手牌。
 */
export function agentView(session, engine, pub, extra = {}) {
  const seat = agentSeatOf(session)
  const now = turnSeat(session.game, session.state)
  const role = roleOf(session, now)
  const yours = seat != null && now === seat
  const view = {
    id: session.id,
    game: session.game,
    label: extra.label,
    playerName: session.playerName,
    mode: session.mode,
    you: seat == null ? { seat: null, role: 'spectator' } : { seat, name: seatLabel(session, seat) },
    seats: roster(session),
    turn: session.state.over ? 'over' : (yours ? 'you' : role),
    turnSeat: now,
    ...(now != null ? { turnName: seatLabel(session, now) } : {}),
    legal: yours ? engine.legal(session.state) : [],
    over: outcomeFor(session, seat, pub.over),
    moveCount: session.actions.length,
  }
  if (session.game === 'blackjack') {
    view.dealer = (pub.dealer || []).map((c) => (c && c.hidden ? 'hidden' : c?.code))
    view.revealed = Boolean(pub.revealed)
    if (pub.revealed) view.dealerScore = pub.dealerScore
  } else Object.assign(view, privateTable(session, seat))
  if (session.recent?.length) view.recent = session.recent.map((m) => ({ seat: m.seat, name: seatLabel(session, m.seat), action: m.action }))
  Object.assign(view, extra)
  view.instruction = agentInstruction(session, view)
  return view
}

function listed(actions) {
  const shown = actions.slice(0, 24)
  return shown.join('、') + (actions.length > shown.length ? ` 等 ${actions.length} 个` : '')
}

export function agentInstruction(session, view) {
  if (view.over) return `这手已经结束（${view.over.reason}）。可以调用 card_close。`
  if (session.mode === 'versus' && session.game === 'blackjack') {
    return '与 AI 对战模式下二十一点只有用户这一手：用户在页面或 Telegram 上要牌 / 停牌，你不能替用户出牌，只能旁观（card_look）。想自己打请 card_reset 后以 mode=solo 开局。'
  }
  if (view.turn === 'you') {
    const team = view.yourTeam ? `你在第 ${view.yourTeam} 队，队友座位 ${view.teammates.length ? view.teammates.join('、') : '无'}；任一队员出完手牌全队获胜。` : ''
    const lead = (session.mode === 'versus' ? `轮到你（AI，座位 ${view.you.seat}）。你在和用户对战，yourHand 是你自己的手牌。` : `轮到你（代打模式，座位 ${view.you.seat}）。`) + team
    return `${lead}请调用 card_play，action 只能是 ${listed(view.legal)}。不要使用 RLCard 或其他上游对手。`
  }
  if (view.turn === 'user') return '现在是用户的回合：等用户在页面或 Telegram 上出牌，不要替用户调用 card_play（会被拒绝）。用户出牌后你会收到通知，届时再 card_look。'
  return '机器人座位由插件自动走。'
}

/** 页面视图：只给用户座位的手牌标注可出动作（UNO 单张、斗地主多选）。 */
export function annotateUserView(session, engine, view) {
  const now = turnSeat(session.game, session.state)
  const role = roleOf(session, now)
  const versus = session.mode === 'versus'
  view.mode = session.mode
  view.turnSeat = now
  view.turnRole = role
  if (now != null) view.turnName = seatLabel(session, now)
  // solo 时页面也可以替 AI 点座位 0（旧版行为）
  const viewer = viewerSeatOf(session)
  view.viewerSeat = viewer
  view.canAct = now === viewer && (role === 'user' || role === 'agent')
  if (session.state.teams && session.game === 'uno') {
    view.teams = session.state.teams
    view.yourTeam = viewer % session.state.teams + 1
  }
  if (versus && session.game !== 'blackjack' && view.rows) {
    const agent = agentSeatOf(session)
    for (const row of view.rows) {
      if (row.label === 'H') row.title = session.game === 'doudizhu' ? `${seatLabel(session, 0)}（地主）` : seatLabel(session, viewer)
      else if (row.label === 'A' && row.cards.length && row.cards.every((c) => c.hidden && typeof c.count === 'number')) {
        row.cards = row.cards.map((c, i) => ({ ...c, name: seatLabel(session, Number.isInteger(c.seat) ? c.seat : i + 1) }))
      } else if (row.label === 'A') row.title = session.game === 'doudizhu' ? `下家 · ${seatLabel(session, agent)}` : seatLabel(session, Number.isInteger(row.seat) ? row.seat : agent)
      else if (row.label === 'B' && session.game === 'doudizhu') row.title = `上家 · ${seatLabel(session, 2)}`
    }
  }
  if (session.game === 'uno' || session.game === 'doudizhu') {
    view.handMode = session.game === 'uno' ? 'single' : 'multi'
    const legal = view.canAct ? engine.legal(session.state) : []
    const row = (view.rows || []).find((r) => r.label === 'H')
    if (row && view.canAct) {
      const hand = session.state.hands[viewer]
      row.cards = row.cards.map((card, i) => {
        if (session.game === 'uno') {
          const c = hand[i]
          if (session.state.pending && i !== session.state.pending.index) return { ...card, play: [], playable: false }
          const play = c.type === 'wild'
            ? legal.filter((a) => a.split('-')[1] === c.trait)
            : legal.filter((a) => a === unoCode(c))
          return { ...card, play, playable: play.length > 0 }
        }
        const rank = card.code
        return { ...card, rank, playable: legal.some((a) => a !== 'pass' && a.includes(rank)) }
      })
    }
    if (view.canAct && legal.includes('draw')) view.drawAction = 'draw'
    if (view.canAct && session.game === 'uno' && legal.includes('pass')) view.passAction = 'pass'
  }
  return view
}
