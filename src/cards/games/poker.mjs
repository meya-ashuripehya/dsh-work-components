/**
 * 两人限注下注，以及 7 张牌里最好的 5 张。勒杜克和限注德州共用。
 * 下注轮次与 RLCard 的 LimitHoldemRound 一致：跟注补到当前最高，加注再加一个 raiseAmount，
 * 本轮加注次数到顶后不能再加，已经跟平才能过牌。两人各自过牌或跟注后这一轮结束。
 */
import { CardError } from '../errors.mjs'
import { cardCode } from '../rules.mjs'

const VALUE = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 }

export const CATEGORY = ['', '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺']

export function face(card) {
  return { rank: card.rank, suit: card.suit, code: cardCode(card) }
}

export function hidden(n) {
  return Array.from({ length: n }, () => ({ hidden: true }))
}

function choose(items, k, emit) {
  const acc = []
  const walk = (start) => {
    if (acc.length === k) { emit(acc); return }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i])
      walk(i + 1)
      acc.pop()
    }
  }
  if (k > 0 && k <= items.length) walk(0)
}

function scoreFive(cards) {
  const ranks = cards.map((c) => VALUE[c.rank]).sort((a, b) => b - a)
  const flush = cards.every((c) => c.suit === cards[0].suit)
  const unique = [...new Set(ranks)]
  let straight = 0
  if (unique.length === 5) {
    const desc = unique.slice().sort((a, b) => b - a)
    if (desc[0] - desc[4] === 4) straight = desc[0]
    else if (desc[0] === 14 && desc[1] === 5 && desc[4] === 2) straight = 5
  }
  const counts = new Map()
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1)
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  if (straight && flush) return [9, straight]
  if (groups[0][1] === 4) return [8, groups[0][0], groups[1][0]]
  if (groups[0][1] === 3 && groups[1][1] === 2) return [7, groups[0][0], groups[1][0]]
  if (flush) return [6, ...ranks]
  if (straight) return [5, straight]
  if (groups[0][1] === 3) return [4, groups[0][0], ...groups.slice(1).map((g) => g[0])]
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const high = Math.max(groups[0][0], groups[1][0])
    const low = Math.min(groups[0][0], groups[1][0])
    return [3, high, low, groups[2][0]]
  }
  if (groups[0][1] === 2) return [2, groups[0][0], ...groups.slice(1).map((g) => g[0])]
  return [1, ...ranks]
}

export function bestScore(cards) {
  if (cards.length <= 5) return scoreFive(cards)
  let best = null
  choose(cards, 5, (five) => {
    const score = scoreFive(five)
    if (!best || compareScores(score, best) > 0) best = score
  })
  return best
}

export function compareScores(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  return 0
}

export function chipPayoff(chips, winner) {
  const pot = chips[0] + chips[1]
  if (winner === 0 || winner === 1) {
    const pay = [0, 0]
    pay[winner] = chips[1 - winner]
    pay[1 - winner] = -chips[1 - winner]
    return pay
  }
  const half = Math.floor(pot / 2)
  return [half + (pot % 2) - chips[0], half - chips[1]]
}

export function legalBets(state) {
  if (state.over) return []
  const maxBet = Math.max(state.street[0], state.street[1])
  const mine = state.street[state.turn]
  const actions = []
  if (mine < maxBet) actions.push('call')
  if (state.raises < state.maxRaises) actions.push('raise')
  actions.push('fold')
  if (mine === maxBet) actions.push('check')
  return actions
}

export function applyBet(state, action, finishStreet) {
  if (state.over) throw new CardError('这手已经结束')
  if (!legalBets(state).includes(action)) throw new CardError('这个动作现在不合法')
  const next = structuredClone(state)
  const me = next.turn
  const maxBet = Math.max(next.street[0], next.street[1])
  if (action === 'call') {
    next.chips[me] += maxBet - next.street[me]
    next.street[me] = maxBet
    next.quiet += 1
  } else if (action === 'raise') {
    next.chips[me] += maxBet - next.street[me] + next.raiseAmount
    next.street[me] = maxBet + next.raiseAmount
    next.raises += 1
    next.quiet = 1
  } else if (action === 'fold') {
    next.folded[me] = true
    next.log.push({ seat: me, action })
    const winner = me === 0 ? 1 : 0
    next.over = {
      winner: winner === 0 ? 'player' : 'ai',
      reason: me === 0 ? '你弃牌' : '对手弃牌',
      payoffs: chipPayoff(next.chips, winner),
    }
    return next
  } else next.quiet += 1
  next.log.push({ seat: me, action })
  next.turn = (me + 1) % 2
  if (next.quiet >= 2) {
    next.street = [0, 0]
    next.raises = 0
    next.quiet = 0
    finishStreet(next)
  }
  return next
}

export function pokerView(state, mark) {
  const showdown = Boolean(state.over) && !state.folded[0] && !state.folded[1]
  const rows = [
    { title: '你', label: 'H', cards: state.hands[0].map(face) },
    { title: '对手', label: 'A', cards: showdown ? state.hands[1].map(face) : hidden(state.hands[1].length) },
  ]
  if (state.board.length) rows.push({ title: '公共牌', label: 'BD', cards: state.board.map(face) })
  const mine = state.hands[0].map((c) => cardCode(c)).join(' ')
  const opp = showdown ? state.hands[1].map((c) => cardCode(c)).join(' ') : hidden(state.hands[1].length).map(() => '暗牌').join(' ')
  const board = state.board.length ? `，公共 ${state.board.map((c) => cardCode(c)).join(' ')}` : ''
  const caption = `你 ${mine}，对手 ${opp}${board}，底池 ${state.chips[0] + state.chips[1]}`
  return {
    turn: state.over ? 'over' : (state.turn === 0 ? 'human' : 'ai'),
    legal: legalBets(state),
    over: state.over ? { winner: state.over.winner, reason: state.over.reason, payoffs: state.over.payoffs.slice() } : null,
    rows,
    mark,
    caption,
    summary: `${caption}。${state.sb === 0 ? '你是小盲' : '你是大盲'}`,
    board: state.board.map(face),
  }
}

const POKER_WORDS = { call: 'call', raise: 'raise', fold: 'fold', check: 'check', 跟注: 'call', 加注: 'raise', 弃牌: 'fold', 过牌: 'check' }

export function chooseBet(state, cat) {
  const legal = legalBets(state)
  if (cat >= 4 && legal.includes('raise') && state.raises < 1) return 'raise'
  if (cat >= 2 && legal.includes('raise') && state.raises === 0) return 'raise'
  if (legal.includes('check')) return 'check'
  if ((cat >= 2 || (cat >= 1 && state.raises <= 1)) && legal.includes('call')) return 'call'
  if (legal.includes('fold')) return 'fold'
  return legal[0]
}

export function canonicalBet(raw) {
  const text = String(raw ?? '').trim()
  return POKER_WORDS[text] || POKER_WORDS[text.toLowerCase()] || ''
}

export function replayWith(start, apply, seed, actions) {
  let state = start(seed)
  for (const action of actions || []) {
    if (state.over) throw new CardError('终局后仍有动作')
    state = apply(state, action)
  }
  return state
}
