import { randomBytes } from 'node:crypto'
import { BoardError } from './errors.mjs'
import { openChess } from './engines/chess.mjs'
import { openGo } from './engines/go.mjs'
import { openGomoku } from './engines/gomoku.mjs'
import { openXiangqi } from './engines/xiangqi.mjs'
import { ensureGame } from './download.mjs'
import { humanMovePrompt, playerName } from './names.mjs'
import { GAMES } from './sources.mjs'

const PAIRS = {
  xiangqi: ['red', 'black'],
  chess: ['white', 'black'],
  gomoku: ['black', 'white'],
  go: ['black', 'white'],
}

const LABELS = {
  red: '红方', black: '黑方', white: '白方',
}

let current = null

export function resetSession() {
  current = null
}

export function hasSession() {
  return current != null
}

function normalizeSide(game, value) {
  const raw = String(value ?? '').trim().toLowerCase()
  const alias = { red: 'red', 红: 'red', black: 'black', 黑: 'black', white: 'white', 白: 'white' }
  const side = alias[raw] || alias[String(value ?? '').trim()]
  if (!side || !PAIRS[game]?.includes(side)) return ''
  return side
}

function otherSide(game, side) {
  const pair = PAIRS[game]
  return pair[0] === side ? pair[1] : pair[0]
}

async function openEngine(game, dirs, options) {
  if (game === 'xiangqi') return openXiangqi(dirs.xiangqi)
  if (game === 'chess') return openChess(dirs['chess-engine'])
  if (game === 'gomoku') return openGomoku(dirs.gomoku)
  return openGo(dirs['go-board'], { strict: options.strict !== false, deadstonesDir: dirs.deadstones })
}

function present() {
  const snap = current.engine.view()
  const items = current.engine.list()
  const counts = new Map()
  for (const item of items) counts.set(item.label, (counts.get(item.label) || 0) + 1)
  const legal = items.map((item) => (counts.get(item.label) > 1 ? item.move : item.label))
  const you = snap.turnSide === current.aiSide
  const over = snap.over
    ? {
      winner: snap.over.winner == null ? null : (snap.over.winner === current.aiSide ? 'ai' : 'human'),
      side: snap.over.winner,
      reason: snap.over.reason,
    }
    : null
  let instruction
  if (over) instruction = '这局已经结束。可以调用 board_close。'
  else if (you) instruction = '现在轮到你。请立刻调用 board_play，着法必须来自 legal。不要使用棋库自带的对手。'
  else instruction = '现在轮到对方。请等待对方落子后再调用 board_look，然后用 board_play 应着。'
  return {
    id: current.id,
    game: current.game,
    label: GAMES[current.game].label,
    playerName: current.playerName,
    aiSide: current.aiSide,
    humanSide: current.humanSide,
    aiLabel: LABELS[current.aiSide],
    humanLabel: LABELS[current.humanSide],
    turn: over ? 'over' : (you ? 'ai' : 'human'),
    turnSide: snap.turnSide,
    strict: current.strict,
    legal,
    board: snap,
    over,
    instruction,
  }
}

export async function openSession(options = {}) {
  if (current) throw new BoardError('已经有一局进行中，请先 board_close', 409)
  const game = String(options.game || '').trim()
  if (!GAMES[game]) throw new BoardError('game 只能是 xiangqi、chess、gomoku、go')
  const aiSide = normalizeSide(game, options.aiSide)
  if (!aiSide) throw new BoardError('aiSide 只能是这盘棋的一方：红/黑、白/黑')
  const strict = options.strict !== false
  const dirs = options.dirs || await ensureGame(game)
  const engine = await openEngine(game, dirs, { strict })
  current = {
    id: randomBytes(4).toString('hex'),
    game,
    aiSide,
    humanSide: otherSide(game, aiSide),
    playerName: playerName(options.playerName),
    strict,
    engine,
  }
  return present()
}

export function lookSession() {
  if (!current) throw new BoardError('没有进行中的棋局', 404)
  return present()
}

export async function playSession(text, who) {
  if (!current) throw new BoardError('没有进行中的棋局', 404)
  const before = present()
  if (before.over) throw new BoardError('这局已经结束')
  if (who === 'ai' && before.turn !== 'ai') throw new BoardError('现在是对方的回合', 409)
  if (who === 'human' && before.turn !== 'human') throw new BoardError('现在是 AI 的回合', 409)
  const hit = await current.engine.play(text)
  const view = present()
  return {
    view,
    notation: hit.label,
    prompt: who === 'human' ? humanMovePrompt(current.playerName, hit.label) : '',
  }
}

export function closeSession() {
  if (!current) return { closed: false }
  current = null
  return { closed: true }
}

export function setPlayerName(value) {
  if (!current) return
  current.playerName = playerName(value)
}
