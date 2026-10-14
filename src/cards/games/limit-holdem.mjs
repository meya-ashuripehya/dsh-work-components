/**
 * 限注德州扑克，两人，52 张牌。对应 RLCard 的 limitholdem，不是无限注。
 * 小盲 1、大盲 2。翻牌前和小盲后的翻牌圈加注额是 2，转牌和河牌是 4。每条街最多加注 4 次。
 * 两个人时第一个行动的是小盲；一条街结束后，下一条街从收尾动作的下一家开始，与 RLCard 相同。
 * 摊牌用 7 张里最好的 5 张，比牌型再比踢脚。种子决定洗牌和小盲。对手策略在本文件，不调用上游智能体。
 * 无限注（半池、一池、全下和边池）这一轮没有做。
 */
import { CATEGORY, applyBet, bestScore, canonicalBet, chipPayoff, chooseBet, compareScores, legalBets, pokerView, replayWith } from './poker.mjs'
import { shuffle, stepInt } from './rng.mjs'

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
const VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]))

function judge(state) {
  const mine = bestScore(state.hands[0].concat(state.board))
  const opp = bestScore(state.hands[1].concat(state.board))
  const cmp = compareScores(mine, opp)
  const winner = cmp > 0 ? 0 : cmp < 0 ? 1 : -1
  const cat = CATEGORY[(winner === 1 ? opp : mine)[0]] || '高牌'
  const reason = winner < 0 ? '摊牌平局' : winner === 0 ? `摊牌胜（${cat}）` : `摊牌负（${cat}）`
  return { winner: winner === 0 ? 'player' : winner === 1 ? 'ai' : 'push', reason, payoffs: chipPayoff(state.chips, winner) }
}

function finishStreet(state) {
  if (state.streetIndex === 0) state.board.push(state.deck.pop(), state.deck.pop(), state.deck.pop())
  else if (state.streetIndex <= 2) state.board.push(state.deck.pop())
  if (state.streetIndex === 1) state.raiseAmount *= 2
  state.streetIndex += 1
  if (state.streetIndex >= 4) state.over = judge(state)
}

function strength(state) {
  const hole = state.hands[state.turn]
  if (state.board.length >= 3) return bestScore(hole.concat(state.board))[0]
  const a = VALUE[hole[0].rank]
  const b = VALUE[hole[1].rank]
  if (a === b || (a >= 12 && b >= 12)) return 2
  if (Math.max(a, b) >= 14) return 1
  return 0
}

export const limitHoldem = {
  id: 'limit-holdem',
  opponent: true,
  badAction: '限注德州只能 call、raise、fold、check，或跟注、加注、弃牌、过牌',
  start,
  fromSpec,
  apply(state, action) { return applyBet(state, action, finishStreet) },
  replay(seed, actions) { return replayWith(start, (state, action) => applyBet(state, action, finishStreet), seed, actions) },
  legal: legalBets,
  publicView(state) { return pokerView(state, 'HOLD') },
  actor(state) { return state.over ? 'over' : (state.turn === 0 ? 'human' : 'ai') },
  accepts(action) { return action === 'call' || action === 'raise' || action === 'fold' || action === 'check' },
  canonical: canonicalBet,
  normalize(text, legal) {
    const action = canonicalBet(text)
    return action && (!legal || legal.includes(action)) ? action : ''
  },
  ai(state) { return chooseBet(state, strength(state)) },
}

function start(seed) {
  const cards = []
  for (const suit of ['S', 'H', 'D', 'C']) for (const rank of RANKS) cards.push({ rank, suit })
  const shuffled = shuffle(cards, seed)
  const deck = shuffled.deck
  const hands = [[], []]
  for (let i = 0; i < 4; i++) hands[i % 2].push(deck.pop())
  const blind = stepInt(shuffled.state, 2)
  const sb = blind.value
  const chips = [0, 0]
  chips[sb] = 1
  chips[(sb + 1) % 2] = 2
  return {
    hands, board: [], deck, chips, street: chips.slice(),
    raises: 0, quiet: 0, raiseAmount: 2, maxRaises: 4, turn: sb,
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
    maxRaises: spec.maxRaises || 4,
    turn: spec.turn ?? sb,
    folded: spec.folded ? spec.folded.slice() : [false, false],
    streetIndex: spec.streetIndex || 0,
    sb,
    log: [],
    over: null,
    rng: spec.rng || 1,
  }
}
