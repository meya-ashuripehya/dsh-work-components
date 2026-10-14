/**
 * 二十一点适配器。点数与庄家补牌与钉死的 RLCard 一致（A 先计 11，爆了再减 10；庄家不足 17 必须要牌，含软 17 停牌）。
 * 天成（起手两张 21）由本适配器判定：双方天成和局，仅一方天成则该方胜，天成高于后来凑成的 21。
 * 不调用上游对局或智能体。庄家第二张是暗牌，开牌前不进入公开局面。
 */
import { CardError } from './errors.mjs'

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K']
export const SUITS = ['S', 'H', 'D', 'C']
export const DEALER_DRAWS_BELOW = 17

const SCORE = { A: 11, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 10, Q: 10, K: 10 }

export function card(rank, suit) {
  return { rank, suit }
}

export function cardCode(c) {
  if (!c) return ''
  const rank = c.rank === 'T' ? '10' : c.rank
  return `${rank}${c.suit}`
}

export function handScore(cards) {
  let score = 0
  let aces = 0
  for (const c of cards || []) {
    score += SCORE[c.rank] || 0
    if (c.rank === 'A') aces += 1
  }
  while (score > 21 && aces > 0) {
    aces -= 1
    score -= 10
  }
  return score
}

export function isNatural(cards) {
  return Array.isArray(cards) && cards.length === 2 && handScore(cards) === 21
}

export function outcome(player, dealer) {
  const playerNatural = isNatural(player)
  const dealerNatural = isNatural(dealer)
  if (playerNatural || dealerNatural) {
    if (playerNatural && dealerNatural) return { winner: 'push', reason: '天成和局' }
    if (playerNatural) return { winner: 'player', reason: '天成' }
    return { winner: 'dealer', reason: '庄家天成' }
  }
  const playerScore = handScore(player)
  const dealerScore = handScore(dealer)
  if (playerScore > 21) return { winner: 'dealer', reason: '爆牌' }
  if (dealerScore > 21) return { winner: 'player', reason: '庄家爆牌' }
  if (playerScore > dealerScore) return { winner: 'player', reason: '点数更高' }
  if (playerScore < dealerScore) return { winner: 'dealer', reason: '点数更高' }
  return { winner: 'push', reason: '点数相同' }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffledDeck(seed) {
  const rng = mulberry32(seed)
  const deck = []
  for (const suit of SUITS) for (const rank of RANKS) deck.push(card(rank, suit))
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const swap = deck[i]
    deck[i] = deck[j]
    deck[j] = swap
  }
  return deck
}

function cloneState(state) {
  return {
    queue: state.queue.map((c) => card(c.rank, c.suit)),
    player: state.player.map((c) => card(c.rank, c.suit)),
    dealer: state.dealer.map((c) => card(c.rank, c.suit)),
    revealed: state.revealed === true,
    over: state.over ? { winner: state.over.winner, reason: state.over.reason } : null,
  }
}

function take(queue) {
  const next = queue.shift()
  if (!next) throw new CardError('牌组空了')
  return next
}

/** 发牌顺序：玩家、庄家明牌、玩家、庄家暗牌。起手天成立即开牌并结束。 */
export function deal(queue) {
  const cards = (queue || []).map((c) => card(c.rank, c.suit))
  const player1 = take(cards)
  const up = take(cards)
  const player2 = take(cards)
  const hole = take(cards)
  const state = {
    queue: cards,
    player: [player1, player2],
    dealer: [up, hole],
    revealed: false,
    over: null,
  }
  return resolveOpening(state)
}

export function resolveOpening(state) {
  if (!isNatural(state.player) && !isNatural(state.dealer)) return state
  const next = cloneState(state)
  next.revealed = true
  next.over = outcome(next.player, next.dealer)
  return next
}

export function applyHit(state) {
  if (state.over) throw new CardError('这手已经结束')
  const next = cloneState(state)
  next.player.push(take(next.queue))
  if (handScore(next.player) > 21) {
    next.revealed = true
    next.over = { winner: 'dealer', reason: '爆牌' }
  }
  return next
}

export function applyStand(state) {
  if (state.over) throw new CardError('这手已经结束')
  const next = cloneState(state)
  if (isNatural(next.player) || isNatural(next.dealer)) {
    next.revealed = true
    next.over = outcome(next.player, next.dealer)
    return next
  }
  while (handScore(next.dealer) < DEALER_DRAWS_BELOW) next.dealer.push(take(next.queue))
  next.revealed = true
  next.over = outcome(next.player, next.dealer)
  return next
}

export function applyAction(state, action) {
  if (action === 'hit') return applyHit(state)
  if (action === 'stand') return applyStand(state)
  throw new CardError('action 只能是 hit 或 stand')
}

export function startFromSeed(seed) {
  return deal(shuffledDeck(seed))
}

export function replay(seed, actions) {
  let state = startFromSeed(seed)
  for (const action of actions || []) {
    if (state.over) throw new CardError('终局后仍有动作')
    state = applyAction(state, action)
  }
  return state
}

export function showCard(c) {
  return { rank: c.rank, suit: c.suit, code: cardCode(c) }
}

/** 公开局面。未开牌时庄家只有明牌和一张暗牌占位，暗牌没有点数、花色或编码。 */
export function publicView(state) {
  const revealed = state.revealed === true || Boolean(state.over)
  const dealer = revealed
    ? state.dealer.map(showCard)
    : [showCard(state.dealer[0]), { hidden: true }]
  return {
    player: state.player.map(showCard),
    dealer,
    playerScore: handScore(state.player),
    dealerScore: revealed ? handScore(state.dealer) : handScore([state.dealer[0]]),
    revealed,
    over: state.over ? { winner: state.over.winner, reason: state.over.reason } : null,
    legal: state.over ? [] : ['hit', 'stand'],
  }
}

export function normalizeAction(value) {
  const raw = String(value ?? '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'hit' || raw === '要牌' || raw === '拿牌') return 'hit'
  if (lower === 'stand' || raw === '停牌') return 'stand'
  return ''
}

export function parseSpokenAction(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const exact = normalizeAction(raw)
  if (exact) return { action: exact, rest: '' }
  const match = raw.match(/^(hit|stand|要牌|拿牌|停牌)\s*[,，:：]\s*(\S[\s\S]*)$/i)
  if (!match) return null
  const action = normalizeAction(match[1])
  if (!action) return null
  return { action, rest: match[2].trim() }
}
