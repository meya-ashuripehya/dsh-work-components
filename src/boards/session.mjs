import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError } from './errors.mjs'
import { openChess } from './engines/chess.mjs'
import { openGo } from './engines/go.mjs'
import { openGomoku } from './engines/gomoku.mjs'
import { openXiangqi } from './engines/xiangqi.mjs'
import { boardsRoot, ensureGame } from './download.mjs'
import { humanMovePrompt, playerName } from './names.mjs'
import { normalizeMove } from './notation.mjs'
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
const listeners = new Set()

/** 棋局变化监听（开局 / 每步 / 关闭）。监听出错不影响棋局。返回取消函数。 */
export function onSessionChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function emit(event) {
  for (const fn of [...listeners]) {
    try { await fn(event) } catch { /* 投递失败不影响棋局 */ }
  }
}

export function resetSession() {
  current = null
}

// ---- 本地存档：<数据目录>/boards/saves/<game>.json，每次开局 / 落子 / 重开后原子写入 ----

const SAVE_VERSION = 1

export function savesDir() {
  return join(boardsRoot(), 'saves')
}

export function saveFile(game) {
  return join(savesDir(), `${game}.json`)
}

function writeAtomic(file, text) {
  mkdirSync(savesDir(), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function persist() {
  if (!current || !current.persist) return
  const snap = current.engine.view()
  const origin = current.origin
  const data = {
    version: SAVE_VERSION,
    game: current.game,
    id: current.id,
    aiSide: current.aiSide,
    humanSide: current.humanSide,
    strict: current.strict,
    moves: current.moves.slice(),
    turnSide: snap.turnSide,
    over: snap.over ? { winner: snap.over.winner ?? null, reason: snap.over.reason || '' } : null,
    opponent: origin?.opponentId || '',
    telegram: origin?.channel === 'telegram'
      ? { chatId: origin.chatId, threadId: origin.threadId || '', messageId: origin.messageId || '', conversationType: origin.conversationType, starterId: origin.starterId || '' }
      : null,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  }
  try {
    writeAtomic(saveFile(current.game), JSON.stringify(data, null, 2) + '\n')
  } catch { /* 存档失败不影响棋局 */ }
}

function validSave(data, game) {
  return data && typeof data === 'object' && data.game === game && Array.isArray(data.moves)
    && data.moves.every((m) => typeof m === 'string' && m.length > 0 && m.length < 64)
    && PAIRS[game].includes(data.aiSide)
}

/** 读存档：没有 → null；损坏 → 备份为 <game>.corrupt-<时间>.json 后返回 { corrupt }。 */
function readSave(game) {
  const file = saveFile(game)
  if (!existsSync(file)) return null
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { data = null }
  if (validSave(data, game)) return { data }
  return { corrupt: backupCorrupt(game) }
}

function backupCorrupt(game) {
  const file = saveFile(game)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(savesDir(), `${game}.corrupt-${stamp}-${randomBytes(2).toString('hex')}.json`)
  try { renameSync(file, backup) } catch { rmSync(file, { force: true }) }
  return backup
}

function clearSave(game) {
  const file = saveFile(game)
  const had = existsSync(file)
  rmSync(file, { force: true })
  return had
}

/** 立即写一次存档（Telegram 后台出图后记下新的 messageId）。没有棋局时什么都不做。 */
export function saveSessionNow() {
  persist()
}

/** 当前棋局绑定的来源（Telegram 会话等）；没有棋局或不是通道发起时为 null。 */
export function sessionOrigin() {
  return current?.origin || null
}

export function sessionLabel(side) {
  return LABELS[side] || side
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
    moveCount: current.moves.length,
    ...(current.notice ? { notice: current.notice } : {}),
    ...(current.origin?.channel === 'telegram'
      ? { delivery: 'telegram', deliveryNote: '每一步后插件会自动把棋盘图片发到这个 Telegram 对话，不需要再调用 mm_send_image 或描述棋盘。' }
      : {}),
  }
}

function summary(over, aiSide) {
  if (!over) return null
  const winner = over.winner == null ? null : (over.winner === aiSide ? 'ai' : 'human')
  return { side: over.winner ?? null, winner, reason: over.reason || '' }
}

export async function openSession(options = {}) {
  if (current) throw new BoardError('已经有一局进行中，请先 board_close', 409)
  const game = String(options.game || '').trim()
  if (!GAMES[game]) throw new BoardError('game 只能是 xiangqi、chess、gomoku、go')
  // 注入 engine（测试）时不读写存档；engineFactory 或真实棋库时读写。
  const persistOn = options.persist !== undefined ? options.persist !== false : !options.engine
  const saved = persistOn ? readSave(game) : null
  let resume = saved?.data && !saved.data.over ? saved.data : null
  const lastResult = saved?.data?.over ? { ...summary(saved.data.over, saved.data.aiSide), moveCount: saved.data.moves.length, endedAt: saved.data.updatedAt || '' } : null

  const aiSide = resume ? resume.aiSide : normalizeSide(game, options.aiSide)
  if (!aiSide) throw new BoardError('aiSide 只能是这盘棋的一方：红/黑、白/黑')
  const strict = resume ? resume.strict !== false : options.strict !== false
  let factory = options.engineFactory || null
  if (!factory && !options.engine) {
    const dirs = options.dirs || await ensureGame(game)
    factory = () => openEngine(game, dirs, { strict })
  }
  let engine = options.engine || await factory()
  let corrupt = saved?.corrupt || ''
  let last = null
  if (resume) {
    try {
      for (const move of resume.moves) {
        const side = engine.view().turnSide
        last = lastOf(await engine.play(move), side)
      }
    } catch {
      corrupt = backupCorrupt(game)
      resume = null
      last = null
      engine = await factory()
    }
  }
  const notices = []
  if (corrupt) notices.push(`存档损坏，已备份为 ${corrupt}，重新开局。`)
  if (lastResult) notices.push('上一局已经结束，这是新的一局。')
  if (resume && normalizeSide(game, options.aiSide) && normalizeSide(game, options.aiSide) !== aiSide) {
    notices.push(`已按存档恢复，AI 仍执${LABELS[aiSide]}；要换边请先 board_reset。`)
  }
  const origin = options.origin ? { ...options.origin } : null
  current = {
    id: resume?.id || randomBytes(4).toString('hex'),
    game,
    aiSide,
    humanSide: otherSide(game, aiSide),
    playerName: playerName(options.playerName),
    strict,
    engine,
    factory,
    persist: persistOn,
    moves: resume ? resume.moves.slice() : [],
    createdAt: resume?.createdAt || new Date().toISOString(),
    last,
    origin,
    notice: notices.join(''),
  }
  persist()
  const view = present()
  if (resume) view.resumed = { moveCount: resume.moves.length, turn: view.turn, turnLabel: LABELS[view.turnSide], savedAt: resume.updatedAt || '' }
  if (lastResult) view.lastResult = lastResult
  if (resume) {
    view.instruction = `已从存档续局：已走 ${resume.moves.length} 步，轮到${LABELS[view.turnSide]}（${view.turn === 'ai' ? '你' : '对方'}）。` + view.instruction
  }
  current.notice = ''
  // 续局时 origin.messageId 为空：Telegram 会发一张新图，并绑定到当前会话的聊天。
  await emit({ type: 'open', view, last, origin: current.origin, resumed: Boolean(resume) })
  persist()
  return view
}

/** 清掉存档并从初始局面重开。game 省略时指当前棋局。当前棋局正是这一种时就地重开并重新出图。 */
export async function resetGame(gameArg) {
  const game = String(gameArg || current?.game || '').trim()
  if (!game) throw new BoardError('没有进行中的棋局，请指定 game', 400)
  if (!GAMES[game]) throw new BoardError('game 只能是 xiangqi、chess、gomoku、go')
  const hadSave = current?.persist === false ? false : clearSave(game)
  if (!current || current.game !== game) {
    return { reset: true, game, active: false, clearedSave: hadSave }
  }
  if (!current.factory) throw new BoardError('这局无法重开', 409)
  current.engine = await current.factory()
  current.moves = []
  current.last = null
  current.createdAt = new Date().toISOString()
  if (current.origin) current.origin.messageId = null
  persist()
  const view = present()
  view.reset = true
  view.instruction = '已重新开局。' + view.instruction
  await emit({ type: 'open', view, last: null, origin: current.origin, reset: true })
  persist()
  return view
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
  const side = before.turnSide
  const hit = await current.engine.play(normalizeMove(current.game, text, side))
  current.last = lastOf(hit, side)
  current.moves.push(hit.move)
  persist()
  const view = present()
  await emit({ type: 'move', view, last: current.last, origin: current.origin, side, notation: hit.label, who })
  persist()
  return {
    view,
    notation: hit.label,
    prompt: who === 'human' ? humanMovePrompt(current.playerName, hit.label) : '',
  }
}

function lastOf(hit, side) {
  const last = { move: hit.move, label: hit.label, side }
  if (hit.from) last.from = { x: hit.from.x, y: hit.from.y }
  if (hit.to) last.to = { x: hit.to.x, y: hit.to.y }
  if (hit.vertex !== undefined) last.vertex = hit.vertex
  if (hit.index !== undefined) last.index = hit.index
  return last
}

/** 关闭棋盘。存档保留：未终局的下次 board_open 同一棋种会续局；要丢弃请用 board_reset。 */
export function closeSession() {
  if (!current) return { closed: false }
  persist()
  const game = current.game
  const over = Boolean(current.engine.view().over)
  const kept = current.persist && !over
  const origin = current.origin
  current = null
  emit({ type: 'close', origin })
  return { closed: true, ...(kept ? { saved: true, game, note: '存档已保留，下次 board_open 同一棋种会续局；不想续局请 board_reset。' } : {}) }
}

/** 辅助引擎用：当前局面的只读快照（引擎适配器、着法记录、合法着法）。没有棋局时为 null。 */
export function sessionHintContext() {
  if (!current) return null
  const snap = current.engine.view()
  return {
    id: current.id,
    game: current.game,
    aiSide: current.aiSide,
    humanSide: current.humanSide,
    turnSide: snap.turnSide,
    over: Boolean(snap.over),
    view: snap,
    moves: current.moves.slice(),
    items: current.engine.list(),
    engine: current.engine,
  }
}

export function setPlayerName(value) {
  if (!current) return
  current.playerName = playerName(value)
}
