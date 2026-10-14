/**
 * UNO，2 至 10 人，不调用 RLCard 的智能体。座位 0 是玩家，其余座位由插件内置的对手走。
 * 108 张牌，各发 7 张。起手翻到 +4 就塞回去重洗。
 *
 * 新开的牌局按官方规则（state.rules === 'official'）：
 * - 发牌位是最后一个座位，座位 0 先出；起手跳过让座位 1 先出，起手反转改为逆时针并由发牌位先出，
 *   起手 +2 由座位 0 摸两张并失去这一轮。
 * - 跳过：下家停一轮。反转：方向反过来；两人局里反转等同跳过，出牌者再出一张。
 * - +2 和 +4：下家摸牌并停一轮。
 * - 牌堆空了，把弃牌堆除顶牌以外的牌洗回去。
 *
 * 旧版两人存档（没有 options）按原先跟随 RLCard 两人局的走法重放，结果与之前完全一致：
 * 起手的 +2 给发牌位补两张并仍由发牌位出牌；反转轮到另一人。
 *
 * 两种走法共用：没牌可出才允许 +4；再没有就摸牌。摸到同色或万能牌会直接打出，摸到异色才留在手里。
 * 先出完手牌者胜，其余每人记 -1。对手手牌只公开张数。
 */
import { CardError } from '../errors.mjs'
import { shuffle, stepInt } from './rng.mjs'

const COLORS = ['r', 'g', 'b', 'y']
const WILD = COLORS.map((color) => `${color}-wild`)
const WILD4 = COLORS.map((color) => `${color}-wild_draw_4`)

export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 10
export const DEFAULT_PLAYERS = 4

function mod(n, m) {
  return ((n % m) + m) % m
}

function card(type, color, trait) {
  return { type, color, trait }
}

const FACE = { skip: '⊘', reverse: '⇄', draw_2: '+2', wild: 'W', wild_draw_4: '+4' }
const KIND = { skip: 'skip', reverse: 'reverse', draw_2: 'draw2', wild: 'wild', wild_draw_4: 'wild4' }

/**
 * 牌面：text 是给人看的牌面（数字、⊘、⇄、+2、W、+4），kind 供图片画矢量图标。
 * 万能牌在手里没有颜色（tone 为空，页面画四色、图片画四色轮）；打出后（played）按所选颜色上色。
 */
export function show(c, played = false) {
  const wild = c.type === 'wild'
  const face = { code: `${c.color}-${c.trait}`, text: FACE[c.trait] ?? c.trait, kind: KIND[c.trait] || 'number', tone: wild && !played ? '' : c.color }
  if (wild) face.wild = true
  return face
}

export function freshDeck() {
  const deck = []
  for (const color of COLORS) {
    for (let n = 0; n <= 9; n++) {
      deck.push(card('number', color, String(n)))
      if (n !== 0) deck.push(card('number', color, String(n)))
    }
    for (const trait of ['skip', 'reverse', 'draw_2']) {
      deck.push(card('action', color, trait))
      deck.push(card('action', color, trait))
    }
    deck.push(card('wild', color, 'wild'))
    deck.push(card('wild', color, 'wild_draw_4'))
  }
  return deck
}

function clone(c) {
  return card(c.type, c.color, c.trait)
}

/** 人数：限制在 2 到 10；不是整数时用 fallback。 */
export function clampPlayers(value, fallback = DEFAULT_PLAYERS) {
  const n = Number(value)
  if (!Number.isInteger(n)) return fallback
  return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n))
}

export const SEAT_ROLES = ['user', 'ai', 'bot']

/**
 * 组队：交错分座，座位 i 属于队伍 i % teams（队伍编号从 0 起，界面显示为第 1 队…）。
 * value：none / 2 / 3 / auto（auto：偶数人 2 队，否则能被 3 整除 3 队，否则不组队）。
 * 返回 0（不组队）、2 或 3；明确给出却不成立的组队抛出 CardError。
 */
export function resolveTeams(players, value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'none' || raw === 'no' || raw === 'off' || raw === 'false' || raw === '0' || raw === '1' || raw === '不组队') return 0
  // 每队至少 2 人才算组队：2、3 人局 auto 不组队
  if (raw === 'auto' || raw === '自动') return players % 2 === 0 && players >= 4 ? 2 : players % 3 === 0 && players >= 6 ? 3 : 0
  const n = Number(raw)
  if (n === 2 || n === 3) {
    if (players % n !== 0) throw new CardError(`${players} 人局不能分成 ${n} 队：分 ${n} 队要求人数能被 ${n} 整除（2 队需偶数人，3 队需 3 的倍数）。可用 teams=auto 或改人数。`)
    if (players < 2 * n) throw new CardError(`${players} 人局分 ${n} 队后每队只有 1 人，等于不组队；请至少 ${2 * n} 人，或 teams=none。`)
    return n
  }
  throw new CardError('teams 只能是 none、2、3 或 auto')
}

export function teamOf(state, seat) {
  const teams = state && state.teams
  return teams ? seat % teams : null
}

function validRoles(seats, players) {
  return Array.isArray(seats) && seats.length === players && seats.every((r) => SEAT_ROLES.includes(r))
}

/** 存档里的 options：缺省（旧存档）按旧版两人走法；有 players 时按官方规则。没有 teams = 不组队。 */
export function validOptions(options) {
  if (options == null) return true
  if (typeof options !== 'object') return false
  if (options.players === undefined) return options.teams === undefined && options.seats === undefined
  if (options.drawChoice !== undefined && typeof options.drawChoice !== 'boolean') return false
  if (!(Number.isInteger(options.players) && options.players >= MIN_PLAYERS && options.players <= MAX_PLAYERS)) return false
  if (options.teams !== undefined && !((options.teams === 2 || options.teams === 3) && options.players % options.teams === 0 && options.players >= 2 * options.teams)) return false
  if (options.seats !== undefined && !validRoles(options.seats, options.players)) return false
  return true
}

function countOf(state) {
  return state.players || state.hands.length || 2
}

/** 新规则：摸到能出的牌留在手里，由该座位自己决定打出这张或 pass；旧存档（没有 drawChoice）仍按旧版自动打出重放。 */
function choosing(state) {
  return state.drawChoice === true
}

function official(state) {
  return state.rules === 'official'
}

export function seatName(seat, viewer = 0) {
  return seat === viewer ? '你' : `对手 ${seat}`
}

export const uno = {
  id: 'uno',
  opponent: true,
  badAction: 'UNO 要打出一张合法牌（如 r-5），或 draw / 摸牌',
  start,
  fromSpec,
  apply,
  replay(seed, actions, options) {
    let state = start(seed, options)
    for (const action of actions || []) {
      if (state.over) throw new CardError('终局后仍有动作')
      state = apply(state, action)
    }
    return state
  },
  validOptions,
  /** cfg.players（开局参数）优先于 cfg.unoPlayers（设置）；teams 见 resolveTeams；seats 原样带上（由会话层按模式校验）。 */
  defaultOptions(cfg = {}) {
    const fallback = clampPlayers(cfg.unoPlayers ?? cfg.cardsUnoPlayers, DEFAULT_PLAYERS)
    let players = fallback
    if (cfg.players !== undefined && cfg.players !== null && cfg.players !== '') {
      const n = Number(cfg.players)
      if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) throw new CardError(`UNO 人数 players 必须是 ${MIN_PLAYERS} 到 ${MAX_PLAYERS} 的整数`)
      players = n
    }
    const out = { players, drawChoice: true }
    const teams = resolveTeams(players, cfg.teams)
    if (teams) out.teams = teams
    if (cfg.seats !== undefined && cfg.seats !== null) {
      if (!validRoles(cfg.seats, players)) throw new CardError(`seats 必须是长度为 ${players} 的数组，每项为 user、ai 或 bot`)
      out.seats = cfg.seats.slice()
    }
    return out
  },
  teamOf,
  legal,
  publicView,
  actor(state) { return state.over ? 'over' : (state.turn === 0 ? 'human' : 'ai') },
  accepts(action) { return action === 'draw' || action === 'pass' || /^[rgby]-(?:[0-9]|skip|reverse|draw_2|wild|wild_draw_4)$/.test(String(action)) },
  canonical,
  normalize(text, list) {
    const action = canonical(text)
    return action && (!list || list.includes(action)) ? action : ''
  },
  ai,
}

function canonical(raw) {
  const text = String(raw ?? '').trim()
  if (text.toLowerCase() === 'draw' || text === '摸牌' || text === '抽牌') return 'draw'
  if (text.toLowerCase() === 'pass' || text === '不出' || text === '过' || text === '结束回合' || text === '留牌') return 'pass'
  if (/^[rgby]-(?:[0-9]|skip|reverse|draw_2|wild|wild_draw_4)$/.test(text)) return text
  return ''
}

/**
 * @param {number} seed
 * @param {{ players?: number }} [options] 省略或没有 players 时是旧版两人走法（旧存档重放用）。
 */
function start(seed, options) {
  const isOfficial = options != null && options.players !== undefined
  const players = isOfficial ? clampPlayers(options.players) : 2
  const shuffled = shuffle(freshDeck(), seed)
  const deck = shuffled.deck
  const hands = Array.from({ length: players }, () => [])
  for (let seat = 0; seat < players; seat++) {
    for (let i = 0; i < 7; i++) hands[seat].push(deck.pop())
  }
  let rng = shuffled.state
  let top = deck.pop()
  for (let guard = 0; top.trait === 'wild_draw_4' && guard < 12; guard++) {
    deck.push(top)
    const again = shuffle(deck, rng)
    deck.length = 0
    deck.push(...again.deck)
    rng = again.state
    top = deck.pop()
  }
  if (top.trait === 'wild') {
    const color = stepInt(rng, 4)
    rng = color.state
    top = clone(top)
    top.color = COLORS[color.value]
  }
  const state = {
    hands, deck, target: top, played: [clone(top)], turn: 0, direction: 1, over: null, rng,
  }
  if (isOfficial) {
    state.players = players
    state.rules = 'official'
    if (options.drawChoice === true) state.drawChoice = true
    if (options.teams === 2 || options.teams === 3) state.teams = options.teams
    performTopOfficial(state, top)
  } else performTop(state, top)
  return state
}

function fromSpec(spec) {
  const state = {
    hands: spec.hands.map((hand) => hand.map(clone)),
    deck: (spec.deck || []).map(clone),
    target: clone(spec.target),
    played: [clone(spec.target)],
    turn: spec.turn || 0,
    direction: spec.direction || 1,
    over: null,
    rng: spec.rng >>> 0 || 1,
  }
  if (spec.rules === 'official' || spec.hands.length > 2) {
    state.players = spec.hands.length
    state.rules = 'official'
  }
  if (spec.drawChoice) state.drawChoice = true
  if (spec.teams === 2 || spec.teams === 3) state.teams = spec.teams
  return state
}

/** 旧版两人：与 RLCard 两人局一致。 */
function performTop(state, top) {
  if (top.trait === 'skip') state.turn = 1
  else if (top.trait === 'reverse') {
    state.direction = -1
    state.turn = mod(state.direction, 2)
  } else if (top.trait === 'draw_2') deal(state, state.turn, 2)
}

/** 官方：发牌位是最后一个座位，座位 0 是发牌位的下家。 */
function performTopOfficial(state, top) {
  const n = countOf(state)
  const dealer = n - 1
  if (top.trait === 'skip') state.turn = mod(1, n)
  else if (top.trait === 'reverse') {
    state.direction = -1
    state.turn = n === 2 ? mod(1, n) : dealer
  } else if (top.trait === 'draw_2') {
    deal(state, 0, 2)
    state.turn = mod(1, n)
  }
}

function drawnPlayable(state, item) {
  if (item.type === 'wild') return true
  return state.target.type === 'wild' ? item.color === state.target.color : (item.color === state.target.color || item.trait === state.target.trait)
}

function legal(state) {
  if (state.over) return []
  if (state.pending) {
    // 刚摸到的牌：只能打出这一张，或 pass
    const item = state.hands[state.turn][state.pending.index]
    const plays = item.type === 'wild' ? COLORS.map((color) => `${color}-${item.trait}`) : [`${item.color}-${item.trait}`]
    return [...plays, 'pass']
  }
  const actions = []
  let wild = false
  let wild4 = false
  const wild4s = []
  for (const item of state.hands[state.turn]) {
    if (item.type === 'wild') {
      if (item.trait === 'wild_draw_4') {
        if (!wild4) { wild4 = true; wild4s.push(...WILD4) }
      } else if (!wild) {
        wild = true
        actions.push(...WILD)
      }
    } else if (state.target.type === 'wild' ? item.color === state.target.color : (item.color === state.target.color || item.trait === state.target.trait)) {
      const code = `${item.color}-${item.trait}`
      if (!actions.includes(code)) actions.push(code)
    }
  }
  if (actions.length) return actions
  if (wild4s.length) return wild4s
  return ['draw']
}

function refill(state) {
  if (state.deck.length) return
  if (official(state)) {
    // 顶牌留在弃牌堆，其余洗回去
    const rest = state.played.slice(0, -1)
    const top = state.played.slice(-1)
    if (!rest.length) return
    const again = shuffle(rest.map(clone), state.rng || 1)
    state.deck = again.deck
    state.played = top
    state.rng = again.state
    return
  }
  const again = shuffle(state.played.map(clone), state.rng || 1)
  state.deck = again.deck
  state.played = []
  state.rng = again.state
}

function deal(state, seat, n) {
  if (official(state)) {
    for (let i = 0; i < n; i++) {
      refill(state)
      if (!state.deck.length) break
      state.hands[seat].push(state.deck.pop())
    }
    return
  }
  if (state.deck.length < n) refill(state)
  for (let i = 0; i < n && state.deck.length; i++) state.hands[seat].push(state.deck.pop())
}

function effectLegacy(state, item) {
  const current = state.turn
  const direction = state.direction
  if (item.trait === 'reverse') state.direction = -direction
  else if (item.trait === 'skip') state.turn = mod(current + direction, 2)
  else if (item.trait === 'draw_2' || item.trait === 'wild_draw_4') {
    const next = mod(current + direction, 2)
    deal(state, next, item.trait === 'draw_2' ? 2 : 4)
    state.turn = next
  }
  state.turn = mod(state.turn + state.direction, 2)
  state.target = item
}

function effectOfficial(state, item) {
  const n = countOf(state)
  const current = state.turn
  if (item.trait === 'reverse') {
    if (n === 2) state.turn = current
    else {
      state.direction = -state.direction
      state.turn = mod(current + state.direction, n)
    }
  } else if (item.trait === 'skip') {
    state.turn = mod(current + 2 * state.direction, n)
  } else if (item.trait === 'draw_2' || item.trait === 'wild_draw_4') {
    const victim = mod(current + state.direction, n)
    deal(state, victim, item.trait === 'draw_2' ? 2 : 4)
    state.turn = mod(current + 2 * state.direction, n)
  } else {
    state.turn = mod(current + state.direction, n)
  }
  state.target = item
}

function effect(state, item) {
  if (official(state)) effectOfficial(state, item)
  else effectLegacy(state, item)
}

function advance(state) {
  state.turn = mod(state.turn + state.direction, countOf(state))
}

function finish(state, seat) {
  const n = countOf(state)
  if (state.teams) {
    // 组队：任一队员出完手牌，全队获胜
    const team = seat % state.teams
    const pay = Array.from({ length: n }, (_, i) => (i % state.teams === team ? 1 : -1))
    return {
      winner: team === 0 ? 'player' : 'ai',
      winnerSeat: seat,
      winnerTeam: team,
      reason: `第 ${team + 1} 队获胜（座位 ${seat} 出完手牌）`,
      payoffs: pay,
    }
  }
  const payoffs = Array.from({ length: n }, (_, i) => (i === seat ? 1 : -1))
  return {
    winner: seat === 0 ? 'player' : 'ai',
    winnerSeat: seat,
    reason: seat === 0 || n === 2 ? '出完手牌' : `${seatName(seat)}出完手牌`,
    payoffs,
  }
}

function apply(state, action) {
  if (state.over) throw new CardError('这手已经结束')
  const allowed = legal(state)
  if (!allowed.includes(action)) throw new CardError('这个动作现在不合法')
  const next = structuredClone(state)
  if (action === 'draw') return draw(next)
  if (action === 'pass') {
    delete next.pending
    advance(next)
    return next
  }
  const [color, trait] = action.split('-')
  const seat = next.turn
  const hand = next.hands[seat]
  const pendingIndex = next.pending ? next.pending.index : -1
  delete next.pending
  const index = pendingIndex >= 0 ? pendingIndex : hand.findIndex((item) => (trait === 'wild' || trait === 'wild_draw_4' ? item.trait === trait : item.color === color && item.trait === trait))
  if (index < 0) throw new CardError('手里没有这张牌')
  const item = hand.splice(index, 1)[0]
  if (trait === 'wild' || trait === 'wild_draw_4') item.color = color
  const emptied = hand.length === 0
  next.played.push(clone(item))
  if (item.type === 'number') {
    next.target = item
    advance(next)
  } else effect(next, item)
  if (emptied) next.over = finish(next, seat)
  return next
}

function draw(state) {
  refill(state)
  if (!state.deck.length) {
    if (!official(state)) throw new CardError('牌堆是空的')
    // 牌全在手里时无牌可摸，直接轮到下家
    advance(state)
    return state
  }
  const item = state.deck.pop()
  if (choosing(state)) {
    // 不替任何座位自动出牌：能出的牌留在手里等它自己决定
    state.hands[state.turn].push(item)
    if (drawnPlayable(state, item)) state.pending = { index: state.hands[state.turn].length - 1 }
    else advance(state)
    return state
  }
  if (item.type === 'wild') {
    const color = stepInt(state.rng || 1, 4)
    state.rng = color.state
    item.color = COLORS[color.value]
    state.target = item
    state.played.push(clone(item))
    if (official(state) && item.trait === 'wild_draw_4') effect(state, item)
    else advance(state)
    return state
  }
  if (item.color === state.target.color) {
    state.played.push(clone(item))
    if (item.type === 'number') {
      state.target = item
      advance(state)
    } else effect(state, item)
    return state
  }
  state.hands[state.turn].push(item)
  advance(state)
  return state
}

/** viewer：页面下方「你」的座位（默认 0）；其余座位从 viewer 的下家起依次排列。 */
function publicView(state, viewer = 0) {
  const n = countOf(state)
  const me = Number.isInteger(viewer) && viewer >= 0 && viewer < n && official(state) ? viewer : 0
  const mine = state.hands[me].map((c) => `${c.color}-${c.trait}`).join(' ')
  const over = state.over ? {
    winner: state.over.winner,
    reason: state.over.reason,
    payoffs: state.over.payoffs.slice(),
    ...(state.over.winnerSeat !== undefined ? { winnerSeat: state.over.winnerSeat } : {}),
    ...(state.over.winnerTeam !== undefined ? { winnerTeam: state.over.winnerTeam } : {}),
  } : null
  const base = {
    turn: state.over ? 'over' : (state.turn === me ? 'human' : 'ai'),
    legal: legal(state),
    over,
    mark: 'N1',
    ...(state.pending && state.turn === me ? { drawn: { index: state.pending.index } } : {}),
    players: n,
    ...(state.teams ? { teams: state.teams, teamOfSeat: Array.from({ length: n }, (_, i) => i % state.teams) } : {}),
  }
  if (n === 2 && !official(state)) {
    const caption = `当前 ${state.target.color}-${state.target.trait}，你 ${mine}，对手 ${state.hands[1].length} 张`
    return {
      ...base,
      rows: [
        { title: '你', label: 'H', cards: state.hands[0].map((c) => show(c)) },
        { title: '对手', label: 'A', cards: state.hands[1].map(() => ({ hidden: true })) },
        { title: '当前', label: 'T', cards: [show(state.target, true)] },
      ],
      caption,
      summary: caption,
    }
  }
  const opponents = []
  for (let k = 1; k < n; k++) {
    const seat = (me + k) % n
    opponents.push({ seat, name: seatName(seat, me), count: state.hands[seat].length, ...(state.teams ? { team: seat % state.teams } : {}) })
  }
  const way = state.direction === 1 ? '顺时针' : '逆时针'
  const counts = opponents.map((o) => `${o.name} ${o.count} 张`).join('，')
  const caption = `${n} 人局，${way}。当前 ${state.target.color}-${state.target.trait}，你 ${mine}；${counts}`
    + (state.teams ? `；分 ${state.teams} 队（交错分座），你在第 ${(me % state.teams) + 1} 队` : '')
  const teamTag = (seat) => (state.teams ? { team: seat % state.teams } : {})
  const rows = [{ title: '你', label: 'H', seat: me, ...teamTag(me), cards: state.hands[me].map((c) => show(c)) }]
  if (n === 2) {
    rows.push({ title: '对手', label: 'A', seat: 1 - me, cards: state.hands[1 - me].map(() => ({ hidden: true })) })
  } else {
    // 多人局：每名对手一张牌背，上面只标张数（组队时另带队伍编号，不含任何牌面）
    rows.push({ title: `对手（${way}）`, label: 'A', cards: opponents.map((o) => ({ hidden: true, count: o.count, name: o.name, seat: o.seat, ...(o.team !== undefined ? { team: o.team } : {}) })) })
  }
  rows.push({ title: '当前', label: 'T', cards: [show(state.target, true)] })
  return {
    ...base,
    direction: state.direction,
    opponents,
    rows,
    caption,
    summary: caption,
  }
}

function ai(state) {
  const actions = legal(state)
  const colored = actions.filter((action) => action !== 'draw' && action !== 'pass' && !action.endsWith('wild') && !action.endsWith('wild_draw_4'))
  const rank = (action) => {
    const trait = action.split('-')[1]
    if (trait === 'draw_2') return 30
    if (trait === 'skip') return 20
    if (trait === 'reverse') return 10
    return Number(trait) || 0
  }
  if (colored.length) return colored.slice().sort((a, b) => rank(b) - rank(a) || (a < b ? -1 : 1))[0]
  if (actions.length === 1) return actions[0]
  const counts = { r: 0, g: 0, b: 0, y: 0 }
  for (const item of state.hands[state.turn]) if (item.type !== 'wild') counts[item.color] += 1
  const color = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]
  return actions.find((action) => action.startsWith(`${color}-`)) || actions[0]
}
