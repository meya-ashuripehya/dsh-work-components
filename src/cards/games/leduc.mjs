/**
 * 勒杜克扑克，两人。牌组与 RLCard 钉死版相同：黑桃/红桃的 J、Q、K。
 * 小盲 1、大盲 2，每轮最多加注 2 次；第一轮加注额 2，进入第二轮后加注额 4。
 * 小盲先行动。一条街结束时，下一条街从刚才收尾的那个人开始，和 RLCard 一样。
 * 公共牌点数与手牌相同算对子。这副牌每种点数只有两张，双方同时对上公共牌发不出来；
 * 若局面真的出现，平分底池，不采用 RLCard 把底池判给先被扫到的那一家。
 * 种子同时决定洗牌和小盲座位。对手策略写在本文件，不调用 RLCard 智能体。
 */
import { shuffle, stepInt } from './rng.mjs'
import { applyBet, canonicalBet, chipPayoff, chooseBet, legalBets, pokerView, replayWith } from './poker.mjs'

const RANK = { J: 11, Q: 12, K: 13 }

function judge(state) {
  const pub = state.board[0]
  const pair = [0, 1].map((i) => Boolean(pub) && state.hands[i][0].rank === pub.rank)
  const rank = [0, 1].map((i) => RANK[state.hands[i][0].rank])
  let winner = -1
  let reason = '同点平分'
  if (pair[0] && pair[1]) reason = '双方对子平分'
  else if (pair[0] || pair[1]) { winner = pair[0] ? 0 : 1; reason = '对子' }
  else if (rank[0] !== rank[1]) { winner = rank[0] > rank[1] ? 0 : 1; reason = '高牌' }
  return {
    winner: winner === 0 ? 'player' : winner === 1 ? 'ai' : 'push',
    reason,
    payoffs: chipPayoff(state.chips, winner),
  }
}

function finishStreet(state) {
  if (state.streetIndex === 0) {
    state.board.push(state.deck.pop())
    state.raiseAmount = 4
  }
  state.streetIndex += 1
  if (state.streetIndex >= 2) state.over = judge(state)
}

export const leduc = {
  id: 'leduc',
  opponent: true,
  badAction: '勒杜克只能 call、raise、fold、check，或跟注、加注、弃牌、过牌',
  start,
  fromSpec,
  apply(state, action) { return applyBet(state, action, finishStreet) },
  replay(seed, actions) { return replayWith(start, (state, action) => applyBet(state, action, finishStreet), seed, actions) },
  legal: legalBets,
  publicView(state) { return pokerView(state, 'LED') },
  actor(state) { return state.over ? 'over' : (state.turn === 0 ? 'human' : 'ai') },
  accepts(action) { return action === 'call' || action === 'raise' || action === 'fold' || action === 'check' },
  canonical: canonicalBet,
  normalize(text, legal) {
    const action = canonicalBet(text)
    return action && (!legal || legal.includes(action)) ? action : ''
  },
  ai(state) {
    const hand = state.hands[state.turn][0]
    const paired = Boolean(state.board[0]) && state.board[0].rank === hand.rank
    const value = RANK[hand.rank]
    const cat = paired ? 4 : value >= 13 ? 2 : value >= 12 ? 1 : 0
    return chooseBet(state, cat)
  },
}

function start(seed) {
  const cards = []
  for (const rank of ['J', 'Q', 'K']) for (const suit of ['S', 'H']) cards.push({ rank, suit })
  const shuffled = shuffle(cards, seed)
  const deck = shuffled.deck
  const hands = [[deck.pop()], [deck.pop()]]
  const blind = stepInt(shuffled.state, 2)
  const sb = blind.value
  const chips = [0, 0]
  chips[sb] = 1
  chips[(sb + 1) % 2] = 2
  return {
    hands, board: [], deck, chips, street: chips.slice(),
    raises: 0, quiet: 0, raiseAmount: 2, maxRaises: 2, turn: sb,
    folded: [false, false], streetIndex: 0, sb, log: [], over: null, rng: blind.state,
  }
}

function fromSpec(spec) {
  const sb = spec.sb ?? 0
  const chips = spec.chips || [sb === 0 ? 1 : 2, sb === 0 ? 2 : 1]
  return {
    hands: spec.hands.map((hand) => hand.slice()),
    board: (spec.board || []).slice(),
    deck: (spec.deck || []).slice(),
    chips: chips.slice(),
    street: (spec.street || chips).slice(),
    raises: spec.raises || 0,
    quiet: spec.quiet || 0,
    raiseAmount: spec.raiseAmount || 2,
    maxRaises: spec.maxRaises || 2,
    turn: spec.turn ?? sb,
    folded: spec.folded ? spec.folded.slice() : [false, false],
    streetIndex: spec.streetIndex || 0,
    sb,
    log: [],
    over: null,
    rng: spec.rng || 1,
  }
}
