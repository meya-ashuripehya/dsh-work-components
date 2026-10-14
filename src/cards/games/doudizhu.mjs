/**
 * 斗地主，三人。牌型和大小按 RLCard 钉死版的出牌生成器，不读取它的 27472 条动作表，也不调用智能体。
 * 这份源码把叫分注释掉了，地主固定是 0 号。这里也一样：你当地主，先出牌，另外两家是农民，由本插件轮流走。
 * 三张底牌在确定地主时公开，和 RLCard 的 seen_cards 以及通常规则一致。另外两家的手牌不公开。
 * 飞机、顺子、连对都不带 2 和王。炸弹大于普通牌型，王炸最大。两家都不要，上一手出牌的人重新领出。
 */
import { CardError } from '../errors.mjs'
import { shuffle } from './rng.mjs'

const RANK = '3456789TJQKA2BR'

function countsOf(hand) {
  const counts = Array(15).fill(0)
  for (const ch of hand) {
    const index = RANK.indexOf(ch)
    if (index >= 0) counts[index] += 1
  }
  return counts
}

export function sortHand(hand) {
  return [...hand].filter((ch) => RANK.includes(ch)).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b)).join('')
}

function chainIndexes(indexes) {
  const chains = []
  let prev = -100
  let count = 0
  let start = 0
  for (const index of indexes) {
    if (index >= 12) break
    if (index === prev + 1) count += 1
    else {
      if (count > 1) chains.push([start, count])
      count = 1
      start = index
    }
    prev = index
  }
  if (count > 1) chains.push([start, count])
  return chains
}

function combinations(items, k) {
  const out = []
  const acc = []
  const walk = (start) => {
    if (acc.length === k) { out.push(acc.slice()); return }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i])
      walk(i + 1)
      acc.pop()
    }
  }
  if (k > 0 && k <= items.length) walk(0)
  return out
}

function bisectLeft(items, target) {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function soloAttachments(hand, chainStart, chainLength, size) {
  const found = new Set()
  const candidates = []
  let prev = ''
  let same = 0
  for (const ch of hand) {
    const index = RANK.indexOf(ch)
    if (index >= chainStart && index < chainStart + chainLength) continue
    if (ch === prev) {
      if (same === 3) continue
      if (same === 2 && (index === chainStart - 1 || index === chainStart + chainLength) && ch !== '2') continue
      same += 1
    } else {
      prev = ch
      same = 1
    }
    candidates.push(index)
  }
  for (const attachment of combinations(candidates, size)) {
    if (attachment.length >= 2 && attachment.at(-1) === 14 && attachment.at(-2) === 13) continue
    const cut = bisectLeft(attachment, chainStart)
    found.add(JSON.stringify([attachment.slice(0, cut), attachment.slice(cut)]))
  }
  return [...found].map((item) => JSON.parse(item))
}

function pairAttachments(cardsCount, chainStart, chainLength, size) {
  const found = new Set()
  const candidates = []
  for (let i = 0; i < 15; i++) {
    if (i >= chainStart && i < chainStart + chainLength) continue
    if (cardsCount[i] >= 2 && cardsCount[i] <= 4) candidates.push(i)
  }
  for (const attachment of combinations(candidates, size)) {
    if (attachment.length >= 2 && attachment.at(-1) === 14 && attachment.at(-2) === 13) continue
    const cut = bisectLeft(attachment, chainStart)
    found.add(JSON.stringify([attachment.slice(0, cut), attachment.slice(cut)]))
  }
  return [...found].map((item) => JSON.parse(item))
}

function attach(left, body, right, repeat) {
  return left.map((i) => RANK[i].repeat(repeat)).join('') + body + right.map((i) => RANK[i].repeat(repeat)).join('')
}

export function playableFromHand(current) {
  const hand = sortHand(current)
  const cardsCount = countsOf(hand)
  const playable = new Set()
  const nz = []
  const gt1 = []
  const gt2 = []
  const gt3 = []
  for (let i = 0; i < 15; i++) {
    if (cardsCount[i] > 0) nz.push(i)
    if (cardsCount[i] > 1) gt1.push(i)
    if (cardsCount[i] > 2) gt2.push(i)
    if (cardsCount[i] > 3) gt3.push(i)
  }
  for (const i of nz) playable.add(RANK[i])
  for (const i of gt1) playable.add(RANK[i].repeat(2))
  for (const i of gt3) {
    const body = RANK[i].repeat(4)
    playable.add(body)
    for (const [left, right] of soloAttachments(hand, i, 1, 2)) playable.add(attach(left, body, right, 1))
    for (const [left, right] of pairAttachments(cardsCount, i, 1, 2)) playable.add(attach(left, body, right, 2))
  }
  for (const [start, length] of chainIndexes(nz)) {
    let s = start
    let l = length
    while (l >= 5) {
      let cards = ''
      let curr = s - 1
      let currLength = 0
      while (currLength < l && currLength < 12) {
        curr += 1
        currLength += 1
        cards += RANK[curr]
        if (currLength >= 5) playable.add(cards)
      }
      l -= 1
      s += 1
    }
  }
  for (const [start, length] of chainIndexes(gt1)) {
    let s = start
    let l = length
    while (l >= 3) {
      let cards = ''
      let curr = s - 1
      let currLength = 0
      while (currLength < l && currLength < 10) {
        curr += 1
        currLength += 1
        cards += RANK[curr].repeat(2)
        if (currLength >= 3) playable.add(cards)
      }
      l -= 1
      s += 1
    }
  }
  for (const i of gt2) {
    playable.add(RANK[i].repeat(3))
    for (const j of nz) {
      if (j < i) playable.add(RANK[j] + RANK[i].repeat(3))
      else if (j > i) playable.add(RANK[i].repeat(3) + RANK[j])
    }
    for (const j of gt1) {
      if (j < i) playable.add(RANK[j].repeat(2) + RANK[i].repeat(3))
      else if (j > i) playable.add(RANK[i].repeat(3) + RANK[j].repeat(2))
    }
  }
  for (const [start, length] of chainIndexes(gt2)) {
    let s = start
    let l = length
    while (l >= 2) {
      let cards = ''
      let curr = s - 1
      let currLength = 0
      while (currLength < l && currLength < 6) {
        curr += 1
        currLength += 1
        cards += RANK[curr].repeat(3)
        if (currLength >= 2 && currLength <= 6) playable.add(cards)
        if (currLength >= 2 && currLength <= 5) {
          for (const [left, right] of soloAttachments(hand, s, currLength, currLength)) playable.add(attach(left, cards, right, 1))
        }
        if (currLength >= 2 && currLength <= 4) {
          for (const [left, right] of pairAttachments(cardsCount, s, currLength, currLength)) playable.add(attach(left, cards, right, 2))
        }
      }
      l -= 1
      s += 1
    }
  }
  if (cardsCount[13] && cardsCount[14]) playable.add('BR')
  return playable
}

export function typesOf(text) {
  if (!text || text === 'pass' || text === 'BR') return text === 'BR' ? [{ type: 'rocket', weight: 14 }] : []
  const counts = countsOf(text)
  if (counts.reduce((sum, n) => sum + n, 0) !== text.length) return []
  const nz = []
  for (let i = 0; i < 15; i++) if (counts[i]) nz.push(i)
  if (nz.length === 1) {
    const index = nz[0]
    const n = counts[index]
    if (n === 1) return [{ type: 'solo', weight: index }]
    if (n === 2 && index < 13) return [{ type: 'pair', weight: index }]
    if (n === 3) return [{ type: 'trio', weight: index }]
    if (n === 4) return [{ type: 'bomb', weight: index }]
    return []
  }
  const same = nz.every((index) => counts[index] === counts[nz[0]])
  const consecutive = nz.every((index, i) => i === 0 || index === nz[i - 1] + 1)
  if (same && consecutive && nz.at(-1) < 12) {
    const n = counts[nz[0]]
    const length = nz.length
    if (n === 1 && length >= 5) return [{ type: `solo_chain_${length}`, weight: nz[0] }]
    if (n === 2 && length >= 3) return [{ type: `pair_chain_${length}`, weight: nz[0] }]
    if (n === 3 && length >= 2 && length <= 6) return [{ type: `trio_chain_${length}`, weight: nz[0] }]
  }
  const fours = nz.filter((index) => counts[index] === 4)
  if (fours.length === 1) {
    const main = fours[0]
    const rest = []
    for (let i = 0; i < 15; i++) if (i !== main) for (let k = 0; k < counts[i]; k++) rest.push(i)
    const out = []
    if (rest.length === 2 && !(rest[0] === 13 && rest[1] === 14)) out.push({ type: 'four_two_solo', weight: main })
    const pairs = nz.filter((index) => index !== main && counts[index] === 2)
    if (pairs.length === 2 && nz.every((index) => index === main || counts[index] === 2)) out.push({ type: 'four_two_pair', weight: main })
    return out
  }
  const trios = []
  let start = -1
  let length = 0
  for (let i = 0; i < 12; i++) {
    if (counts[i] === 3) {
      if (start < 0) start = i
      length += 1
    } else if (length) {
      if (length >= 2) trios.push([start, length])
      start = -1
      length = 0
    }
  }
  if (length >= 2) trios.push([start, length])
  const out = []
  for (const [run, runLength] of trios) {
    for (let size = 2; size <= runLength; size++) {
      for (let at = run; at + size <= run + runLength; at++) {
        let outside = 0
        let ok = true
        const kickers = []
        for (let i = 0; i < 15; i++) {
          if (i >= at && i < at + size) {
            if (counts[i] !== 3) ok = false
          } else if (counts[i]) {
            outside += counts[i]
            kickers.push([i, counts[i]])
          }
        }
        if (!ok) continue
        const indexes = []
        for (const [index, n] of kickers) for (let k = 0; k < n; k++) indexes.push(index)
        const rockets = indexes.includes(13) && indexes.includes(14)
        if (outside === 0) out.push({ type: `trio_chain_${size}`, weight: at })
        else if (outside === size && size <= 5 && !rockets) out.push({ type: `trio_solo_chain_${size}`, weight: at })
        else if (size <= 4 && kickers.length === size && kickers.every(([, n]) => n === 2) && !rockets) out.push({ type: `trio_pair_chain_${size}`, weight: at })
      }
    }
  }
  if (out.length) return out
  const exact = nz.filter((index) => counts[index] === 3)
  if (exact.length === 1 && nz.length === 2) {
    const main = exact[0]
    const other = nz.find((index) => index !== main)
    if (counts[other] === 1) return [{ type: 'trio_solo', weight: main }]
    if (counts[other] === 2) return [{ type: 'trio_pair', weight: main }]
  }
  return []
}

export function beats(play, target) {
  if (!target) return play !== 'pass'
  if (play === 'BR') return target !== 'BR'
  if (target === 'BR') return false
  const mine = typesOf(play)
  const theirs = typesOf(target)
  if (mine.some((item) => item.type === 'bomb') && !theirs.some((item) => item.type === 'bomb')) return true
  return mine.some((left) => theirs.some((right) => left.type === right.type && left.weight > right.weight))
}

function cmpPlay(a, b) {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) {
    const diff = RANK.indexOf(a[i]) - RANK.indexOf(b[i])
    if (diff) return diff
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function legal(state) {
  if (state.over) return []
  const plays = [...playableFromHand(state.hands[state.turn])].sort(cmpPlay)
  if (state.greater === null || state.greater === state.turn) return plays
  return ['pass', ...plays.filter((play) => beats(play, state.last))]
}

function without(hand, action) {
  const counts = countsOf(hand)
  for (const ch of action) {
    const index = RANK.indexOf(ch)
    if (index < 0 || counts[index] <= 0) throw new CardError('手里没有这些牌')
    counts[index] -= 1
  }
  let next = ''
  for (let i = 0; i < 15; i++) next += RANK[i].repeat(counts[i])
  return next
}

const PIPS = ['S', 'H', 'C', 'D']

/**
 * 只用于显示的花色：引擎只认点数。每名玩家开局时的牌（现手牌 + 已打出的牌，地主含底牌）按座位 0、1、2
 * 依次分配同点数的第 1–4 个花色，所以同一点数的四张牌花色各不相同，且整局不变。
 * 同一玩家同点数的牌：先打出的取靠前的花色，手里剩下的取其余。规则不受影响。
 */
export function suitPlan(state) {
  const played = [[], [], []]
  for (const step of state.trace || []) if (step.action !== 'pass') played[step.seat].push(...step.action)
  const next = {}
  const seats = [0, 1, 2].map((seat) => {
    const own = {}
    for (const ch of sortHand(state.hands[seat] + played[seat].join(''))) {
      if (ch === 'B' || ch === 'R') continue
      const i = next[ch] || 0
      next[ch] = i + 1
      ;(own[ch] ||= []).push(PIPS[i % 4])
    }
    const used = {}
    for (const ch of played[seat]) used[ch] = (used[ch] || 0) + 1
    return { own, used }
  })
  return seats
}

function tile(ch, pip) {
  if (ch === 'B') return { code: ch, text: 'JOKER', pip: 'J', color: 'black' }
  if (ch === 'R') return { code: ch, text: 'JOKER', pip: 'J', color: 'red' }
  return { code: ch, text: ch === 'T' ? '10' : ch, pip, color: pip === 'H' || pip === 'D' ? 'red' : 'black' }
}

/** seat 的现手牌；fromEnd 用于底牌（取该玩家该点数的最后几个花色）。 */
function tiles(text, plan, seat, fromEnd = false) {
  const p = plan && plan[seat]
  const taken = {}
  const counts = {}
  if (fromEnd) for (const ch of text) counts[ch] = (counts[ch] || 0) + 1
  return [...text].map((ch) => {
    const list = (p && p.own[ch]) || []
    const k = taken[ch] = (taken[ch] || 0) + 1
    const index = fromEnd ? list.length - counts[ch] + k - 1 : (p ? p.used[ch] || 0 : 0) + k - 1
    return tile(ch, list[index] || PIPS[(k - 1) % 4])
  })
}

function apply(state, action) {
  if (state.over) throw new CardError('这手已经结束')
  const allowed = legal(state)
  if (!allowed.includes(action)) throw new CardError('这个动作现在不合法')
  const next = structuredClone(state)
  const seat = next.turn
  next.trace.push({ seat, action })
  if (action !== 'pass') {
    next.hands[seat] = without(next.hands[seat], action)
    next.greater = seat
    next.last = action
    if (!next.hands[seat]) {
      const landlord = seat === next.landlord
      next.over = {
        winner: landlord ? 'player' : 'ai',
        reason: landlord ? '地主胜' : '农民胜',
        payoffs: landlord ? [1, -1, -1] : [-1, 1, 1],
      }
      return next
    }
  }
  next.turn = (seat + 1) % 3
  return next
}

function publicView(state) {
  const reveal = Boolean(state.over)
  const plan = suitPlan(state)
  const rows = [
    { title: '你（地主）', label: 'H', cards: tiles(state.hands[0], plan, 0) },
    { title: '下家', label: 'A', cards: reveal ? tiles(state.hands[1], plan, 1) : state.hands[1].split('').map(() => ({ hidden: true })) },
    { title: '上家', label: 'B', cards: reveal ? tiles(state.hands[2], plan, 2) : state.hands[2].split('').map(() => ({ hidden: true })) },
  ]
  if (state.bottom) rows.push({ title: '底牌', label: 'BD', cards: tiles(state.bottom, plan, 0, true) })
  const last = state.trace.length ? state.trace.at(-1).action : '无'
  const caption = `你 ${state.hands[0]}，下家 ${state.hands[1].length} 张，上家 ${state.hands[2].length} 张，底牌 ${state.bottom}，上一手 ${last}`
  return {
    turn: state.over ? 'over' : (state.turn === 0 ? 'human' : 'ai'),
    legal: legal(state),
    over: state.over ? { winner: state.over.winner, reason: state.over.reason, payoffs: state.over.payoffs.slice() } : null,
    rows,
    mark: 'DD',
    caption,
    summary: caption,
  }
}

function ai(state) {
  const actions = legal(state)
  const hand = state.hands[state.turn]
  const finish = actions.find((action) => action !== 'pass' && action.length === hand.length)
  if (finish) return finish
  const mate = state.turn !== 0 && state.greater !== null && state.greater !== state.turn && state.greater !== 0
  if (mate && actions.includes('pass')) return 'pass'
  const plays = actions.filter((action) => action !== 'pass' && !typesOf(action).some((item) => item.type === 'bomb' || item.type === 'rocket'))
  const pool = plays.length ? plays : actions.filter((action) => action !== 'pass')
  return pool[0] || 'pass'
}

function canonical(raw) {
  const text = String(raw ?? '').trim()
  if (text === 'pass' || text === '过' || text === '不要' || text === '要不起') return 'pass'
  if (/^[3456789TJQKA2BR]+$/.test(text)) return sortHand(text)
  return ''
}

function freshRanks() {
  const cards = []
  for (const ch of '3456789TJQKA2') for (let i = 0; i < 4; i++) cards.push(ch)
  cards.push('B', 'R')
  return cards
}

function start(seed) {
  const shuffled = shuffle(freshRanks(), seed)
  const deck = shuffled.deck
  const hands = [0, 1, 2].map((i) => sortHand(deck.slice(i * 17, (i + 1) * 17).join('')))
  const bottom = sortHand(deck.slice(51).join(''))
  hands[0] = sortHand(hands[0] + bottom)
  return { hands, bottom, landlord: 0, turn: 0, greater: null, last: '', trace: [], over: null }
}

function fromSpec(spec) {
  return {
    hands: spec.hands.map(sortHand),
    bottom: sortHand(spec.bottom || ''),
    landlord: 0,
    turn: spec.turn || 0,
    greater: spec.greater ?? null,
    last: spec.last || '',
    trace: [],
    over: null,
  }
}

export const doudizhu = {
  id: 'doudizhu',
  opponent: true,
  badAction: '斗地主要出一种牌型（如 34567 或 33），或 pass / 过',
  start,
  fromSpec,
  apply,
  replay(seed, actions) {
    let state = start(seed)
    for (const action of actions || []) {
      if (state.over) throw new CardError('终局后仍有动作')
      state = apply(state, action)
    }
    return state
  },
  legal,
  publicView,
  actor(state) { return state.over ? 'over' : (state.turn === 0 ? 'human' : 'ai') },
  accepts(action) { return action === 'pass' || /^[3456789TJQKA2BR]+$/.test(action) },
  canonical,
  normalize(text, list) {
    const action = canonical(text)
    return action && (!list || list.includes(action)) ? action : ''
  },
  ai,
}
