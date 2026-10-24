import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { contextKey, saveId } from '../cards/context.mjs'
import { sameAccount } from '../channels/telegram/accounts.mjs'
import { BoardError } from './errors.mjs'
import { openChess } from './engines/chess.mjs'
import { openGo } from './engines/go.mjs'
import { openGomoku } from './engines/gomoku.mjs'
import { openXiangqi } from './engines/xiangqi.mjs'
import { boardsRoot, ensureGame } from './download.mjs'
import { humanMovePrompt, playerName } from './names.mjs'
import { normalizeMove } from './notation.mjs'
import { GAMES } from './sources.mjs'
import { assertAiMove, assertHumanMove, confirmHuman, normalizeBoardSeats, normalizeSide, seatOnSide } from './seats.mjs'

const PAIRS = {
  xiangqi: ['red', 'black'],
  chess: ['white', 'black'],
  gomoku: ['black', 'white'],
  go: ['black', 'white'],
}

const LABELS = {
  red: '红方', black: '黑方', white: '白方',
}

/** 没有房间、会话或 Telegram 来源时的键（测试与尚未绑定会话的调用）。 */
export const DEFAULT_KEY = 'desktop:default'

const tables = new Map()
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
  tables.clear()
}

/**
 * 隔离键：中转站 room:<roomId>，Telegram 聊天，或桌面会话。
 * 什么都没有时用 DEFAULT_KEY，这样不带身份的旧调用仍共用一桌。
 */
export function boardKey(options = {}) {
  if (options.key) {
    const key = String(options.key).trim()
    if (key) return key
  }
  if (options.roomId) {
    const id = String(options.roomId).trim()
    if (id) return `room:${id}`
  }
  if (options.origin) {
    const key = contextKey({ origin: options.origin })
    if (key) return key
  }
  if (options.sessionId) {
    const key = contextKey({ sessionId: options.sessionId })
    if (key) return key
  }
  return DEFAULT_KEY
}

export function roomIdOf(key) {
  const k = String(key || '')
  return k.startsWith('room:') ? k.slice('room:'.length) : ''
}

// ---- 存档：by-key/<hash>.json。旧的 saves/<game>.json 只被下一次无房间开局收养一次。 ----

const SAVE_VERSION = 2

export function savesDir() {
  return join(boardsRoot(), 'saves')
}

/** 旧路径，仅用于收养。新对局不再写这里。 */
export function saveFile(game) {
  return join(savesDir(), `${game}.json`)
}

export function saveFileFor(key, game) {
  return join(savesDir(), 'by-key', `${saveId(String(key) + '\n' + String(game))}.json`)
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function snapshotData(current) {
  const snap = current.engine.view()
  const origin = current.origin
  return {
    version: SAVE_VERSION,
    key: current.key,
    game: current.game,
    id: current.id,
    mode: current.mode,
    aiSide: current.aiSide,
    humanSide: current.humanSide,
    seats: current.seats,
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
}

function persist(current) {
  if (!current || !current.persist) return
  try {
    writeAtomic(saveFileFor(current.key, current.game), JSON.stringify(snapshotData(current), null, 2) + '\n')
  } catch { /* 存档失败不影响棋局 */ }
}

function validSave(data, game) {
  return data && typeof data === 'object' && data.game === game && Array.isArray(data.moves)
    && data.moves.every((m) => typeof m === 'string' && m.length > 0 && m.length < 64)
    && PAIRS[game].includes(data.aiSide)
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function backupCorrupt(file, game) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(savesDir(), `${game}.corrupt-${stamp}-${randomBytes(2).toString('hex')}.json`)
  mkdirSync(savesDir(), { recursive: true })
  try { renameSync(file, backup) } catch { rmSync(file, { force: true }) }
  return backup
}

/** 读某一键的存档。无房间的键在没有自己的档时收养一次旧的 saves/<game>.json。 */
function readSave(key, game) {
  const file = saveFileFor(key, game)
  if (existsSync(file)) {
    const data = readJson(file)
    if (validSave(data, game)) return { data, file }
    return { corrupt: backupCorrupt(file, game), file }
  }
  if (String(key).startsWith('room:')) return null
  const legacy = saveFile(game)
  if (!existsSync(legacy)) return null
  const adopted = `${legacy}.adopted`
  try { renameSync(legacy, adopted) } catch { return null }
  const data = readJson(adopted)
  if (validSave(data, game)) return { data, file, adopted: true }
  return { corrupt: backupCorrupt(adopted, game), file, adopted: true }
}

function clearSave(key, game) {
  const file = saveFileFor(key, game)
  const had = existsSync(file)
  rmSync(file, { force: true })
  if (!String(key).startsWith('room:') && existsSync(saveFile(game))) {
    rmSync(saveFile(game), { force: true })
    return true
  }
  return had
}

function sole() {
  if (tables.size !== 1) return null
  return [...tables.values()][0]
}

function table(key) {
  if (key && tables.has(key)) return tables.get(key)
  if (!key) return sole()
  return null
}

function requireTable(key) {
  const current = table(key)
  if (current) return current
  if (!key && tables.size > 1) throw new BoardError('无法确定是哪一盘棋', 400)
  throw new BoardError('没有进行中的棋局', 404)
}

/** 立即写一次存档（Telegram 后台出图后记下新的 messageId）。 */
export function saveSessionNow(key) {
  const current = table(key)
  if (current) persist(current)
}

/** 当前棋局绑定的来源。多桌时必须带 key。 */
export function sessionOrigin(key) {
  return table(key)?.origin || null
}

/** 按 Telegram 聊天找到进行中的那一桌的键。 */
export function telegramTableKey(chatId, accountId) {
  for (const current of tables.values()) {
    const origin = current.origin
    if (!origin || origin.channel !== 'telegram') continue
    if (String(origin.chatId) !== String(chatId)) continue
    if (!sameAccount(origin.accountId, accountId)) continue
    return current.key
  }
  return ''
}

export function sessionLabel(side) {
  return LABELS[side] || side
}

export function hasSession(key) {
  if (key) return tables.has(key)
  return tables.size > 0
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

function publicSeats(seats) {
  return (seats || []).map((s) => ({
    seatId: s.seatId,
    side: s.side,
    kind: s.kind,
    name: s.name,
    status: s.status,
    ...(s.memberId ? { memberId: s.memberId } : {}),
    ...(s.telegramUserId ? { telegramUserId: s.telegramUserId } : {}),
    ...(s.local || s.ref === 'local' ? { local: true } : {}),
  }))
}

function present(current, caller) {
  const snap = current.engine.view()
  const items = current.engine.list()
  const counts = new Map()
  for (const item of items) counts.set(item.label, (counts.get(item.label) || 0) + 1)
  const legal = items.map((item) => (counts.get(item.label) > 1 ? item.move : item.label))
  const turnSeat = seatOnSide(current.seats, snap.turnSide)
  const overSeat = snap.over?.winner ? seatOnSide(current.seats, snap.over.winner) : null
  const over = snap.over
    ? {
      winner: snap.over.winner == null ? null : (snap.over.winner === current.aiSide ? 'ai' : 'human'),
      side: snap.over.winner,
      reason: snap.over.reason,
      ...(overSeat ? { seatId: overSeat.seatId, name: overSeat.name } : {}),
    }
    : null
  const mine = caller?.memberId && turnSeat?.memberId === caller.memberId
  const legacyYou = !caller?.memberId && turnSeat?.kind === 'ai' && !turnSeat.memberId
  let instruction
  if (over) instruction = '这局已经结束。可以调用 board_close。'
  else if (mine || legacyYou) instruction = '现在轮到你。请立刻调用 board_play，着法必须来自 legal。不要使用棋库自带的对手。'
  else if (turnSeat?.kind === 'ai') instruction = `现在轮到${turnSeat.name}。请等待，不要替对方调用 board_play。`
  else instruction = '现在轮到对方。请等待对方落子后再调用 board_look，然后用 board_play 应着。'
  const waiting = current.seats.filter((s) => s.status === 'pending').map((s) => s.name)
  return {
    id: current.id,
    key: current.key,
    ...(roomIdOf(current.key) ? { roomId: roomIdOf(current.key) } : {}),
    game: current.game,
    label: GAMES[current.game].label,
    playerName: current.playerName,
    mode: current.mode,
    aiSide: current.aiSide,
    humanSide: current.humanSide,
    aiLabel: LABELS[current.aiSide],
    humanLabel: LABELS[current.humanSide],
    seats: publicSeats(current.seats),
    turn: over ? 'over' : (turnSeat?.kind === 'ai' ? 'ai' : 'human'),
    turnSide: snap.turnSide,
    ...(turnSeat ? { turnSeat: { seatId: turnSeat.seatId, name: turnSeat.name, kind: turnSeat.kind, side: turnSeat.side, status: turnSeat.status, ...(turnSeat.memberId ? { memberId: turnSeat.memberId } : {}) } } : {}),
    ...(waiting.length ? { waiting } : {}),
    strict: current.strict,
    legal,
    board: snap,
    over,
    instruction,
    moveCount: current.moves.length,
    ...(current.notice ? { notice: current.notice } : {}),
    ...(current.origin?.channel === 'telegram'
      ? {
        delivery: 'telegram',
        deliveryNote: '每一步后插件会自动把棋盘图片发到这个 Telegram 对话，不需要再调用 mm_send_image 或描述棋盘。',
        conversationType: current.origin.conversationType === 'group' ? 'group' : 'dm',
        starterId: current.origin.starterId || '',
        opponentId: current.origin.opponentId || '',
      }
      : {}),
  }
}

function summary(over, aiSide) {
  if (!over) return null
  const winner = over.winner == null ? null : (over.winner === aiSide ? 'ai' : 'human')
  return { side: over.winner ?? null, winner, reason: over.reason || '' }
}

function sidesFromSeats(game, seated, options) {
  if (seated.mode === 'legacy') return { aiSide: options.aiSide, humanSide: otherSide(game, options.aiSide) }
  const ai = seated.seats.find((s) => s.kind === 'ai')
  const aiSide = ai?.side || seated.seats[0].side
  return { aiSide, humanSide: otherSide(game, aiSide) }
}

export async function openSession(options = {}) {
  const key = boardKey(options)
  if (tables.has(key)) throw new BoardError('已经有一局进行中，请先 board_close', 409)
  const game = String(options.game || '').trim()
  if (!GAMES[game]) throw new BoardError('game 只能是 xiangqi、chess、gomoku、go')
  const persistOn = options.persist !== undefined ? options.persist !== false : !options.engine
  const saved = persistOn ? readSave(key, game) : null
  let resume = saved?.data && !saved.data.over ? saved.data : null
  const savedAi = resume?.aiSide || saved?.data?.aiSide
  const lastResult = saved?.data?.over ? { ...summary(saved.data.over, savedAi), moveCount: saved.data.moves.length, endedAt: saved.data.updatedAt || '' } : null

  const explicit = options.seats
  let aiSide = ''
  if (!explicit) {
    aiSide = resume ? resume.aiSide : normalizeSide(game, options.aiSide, PAIRS)
    if (!aiSide) throw new BoardError('aiSide 只能是这盘棋的一方：红/黑、白/黑')
  }
  const named = playerName(options.playerName)
  let seated
  if (resume) {
    if (Array.isArray(resume.seats) && resume.seats.length) {
      seated = { mode: resume.mode === 'seats' ? 'seats' : 'legacy', seats: resume.seats.map((s) => ({ ...s })) }
      aiSide = resume.aiSide
    } else {
      aiSide = resume.aiSide
      seated = normalizeBoardSeats(game, null, { aiSide, humanSide: otherSide(game, aiSide), playerName: named, pairs: PAIRS })
    }
  } else if (explicit) {
    seated = normalizeBoardSeats(game, explicit, { aiSide: '', humanSide: '', playerName: named, pairs: PAIRS })
    aiSide = sidesFromSeats(game, seated, {}).aiSide
  } else {
    seated = normalizeBoardSeats(game, null, { aiSide, humanSide: otherSide(game, aiSide), playerName: named, pairs: PAIRS })
  }
  const humanSide = otherSide(game, aiSide)
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
      const file = saveFileFor(key, game)
      corrupt = existsSync(file) ? backupCorrupt(file, game) : '无法重放'
      resume = null
      last = null
      engine = await factory()
    }
  }
  const notices = []
  if (corrupt) notices.push(`存档损坏，已备份为 ${corrupt}，重新开局。`)
  if (saved?.adopted && resume) notices.push('已从旧的单机存档继续。')
  if (lastResult) notices.push('上一局已经结束，这是新的一局。')
  if (resume && explicit) notices.push('已按存档恢复座位；要换座位请先 board_reset。')
  if (resume && !explicit && normalizeSide(game, options.aiSide, PAIRS) && normalizeSide(game, options.aiSide, PAIRS) !== aiSide) {
    notices.push(`已按存档恢复，AI 仍执${LABELS[aiSide]}；要换边请先 board_reset。`)
  }
  const origin = options.origin ? { ...options.origin } : (resume?.telegram ? {
    channel: 'telegram',
    chatId: String(resume.telegram.chatId),
    ...(resume.telegram.threadId ? { threadId: String(resume.telegram.threadId) } : {}),
    conversationType: resume.telegram.conversationType === 'group' ? 'group' : 'dm',
    starterId: resume.telegram.starterId || '',
    messageId: null,
  } : null)
  if (options.origin) origin.messageId = options.origin.messageId ?? null
  const current = {
    key,
    id: resume?.id || randomBytes(4).toString('hex'),
    game,
    mode: seated.mode,
    aiSide,
    humanSide,
    seats: seated.seats,
    playerName: named,
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
  tables.set(key, current)
  persist(current)
  const view = present(current)
  if (resume) view.resumed = { moveCount: resume.moves.length, turn: view.turn, turnLabel: LABELS[view.turnSide], savedAt: resume.updatedAt || '' }
  if (lastResult) view.lastResult = lastResult
  if (resume) {
    view.instruction = `已从存档续局：已走 ${resume.moves.length} 步，轮到${LABELS[view.turnSide]}（${view.turn === 'ai' ? '你' : '对方'}）。` + view.instruction
  }
  current.notice = ''
  await emit({ type: 'open', key, view, last, origin: current.origin, resumed: Boolean(resume) })
  persist(current)
  return view
}

/** 清掉存档并从初始局面重开。game 省略时指这一键上的当前棋局。 */
export async function resetGame(gameArg, keyArg) {
  const key = keyArg || table()?.key || DEFAULT_KEY
  const current = tables.get(key) || null
  const game = String(gameArg || current?.game || '').trim()
  if (!game) throw new BoardError('没有进行中的棋局，请指定 game', 400)
  if (!GAMES[game]) throw new BoardError('game 只能是 xiangqi、chess、gomoku、go')
  const hadSave = current?.persist === false ? false : clearSave(key, game)
  if (!current || current.game !== game) {
    return { reset: true, game, active: false, clearedSave: hadSave }
  }
  if (!current.factory) throw new BoardError('这局无法重开', 409)
  current.engine = await current.factory()
  current.moves = []
  current.last = null
  current.createdAt = new Date().toISOString()
  if (current.origin) current.origin.messageId = null
  persist(current)
  const view = present(current)
  view.reset = true
  view.instruction = '已重新开局。' + view.instruction
  await emit({ type: 'open', key, view, last: null, origin: current.origin, reset: true })
  persist(current)
  return view
}

export function lookSession(key, caller) {
  const current = requireTable(typeof key === 'object' ? key?.key : key)
  return present(current, caller && caller.memberId ? caller : undefined)
}

export async function playSession(text, who, options = {}) {
  const key = typeof options === 'string' ? options : options?.key
  const caller = typeof options === 'object' ? options.caller : undefined
  const current = requireTable(key)
  const before = present(current, caller)
  if (before.over) throw new BoardError('这局已经结束')
  let seat
  if (who === 'ai') seat = assertAiMove(current, caller)
  else if (who === 'human') seat = assertHumanMove(current, caller)
  else throw new BoardError('无法确定是谁在走棋', 400)
  const side = before.turnSide
  const hit = await current.engine.play(normalizeMove(current.game, text, side))
  current.last = lastOf(hit, side)
  current.moves.push(hit.move)
  persist(current)
  const view = present(current, caller)
  await emit({ type: 'move', key: current.key, view, last: current.last, origin: current.origin, side, notation: hit.label, who, seat })
  persist(current)
  const name = who === 'human' ? (seat?.name || current.playerName) : ''
  return {
    view,
    notation: hit.label,
    prompt: who === 'human' ? humanMovePrompt(name, hit.label) : '',
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

/** 关闭棋盘。不带 key 且有多桌时全部关闭（停用棋类）。存档保留。 */
export function closeSession(key) {
  if (!key && tables.size > 1) {
    const keys = [...tables.keys()]
    const closed = keys.map((k) => closeOne(k))
    return { closed: true, all: true, games: closed.map((c) => c.game).filter(Boolean) }
  }
  const current = table(key)
  if (!current) return { closed: false }
  return closeOne(current.key)
}

function closeOne(key) {
  const current = tables.get(key)
  if (!current) return { closed: false }
  persist(current)
  const game = current.game
  const over = Boolean(current.engine.view().over)
  const kept = current.persist && !over
  const origin = current.origin
  tables.delete(key)
  emit({ type: 'close', key, origin })
  return { closed: true, ...(kept ? { saved: true, game, note: '存档已保留，下次 board_open 同一棋种会续局；不想续局请 board_reset。' } : {}) }
}

/** 人类回复「入座」。 */
export async function confirmSeat(key, caller) {
  const current = requireTable(key)
  const seat = confirmHuman(current, caller)
  if (!seat) return null
  persist(current)
  const view = present(current)
  await emit({ type: 'seat', key, view, seat, origin: current.origin })
  return { seat, view }
}

/** 辅助引擎用：当前局面的只读快照。caller 指定时，胜率按该成员自己的一方计算。 */
export function sessionHintContext(key, { caller } = {}) {
  const current = table(typeof key === 'object' ? undefined : key)
  if (!current) return null
  const snap = current.engine.view()
  let aiSide = current.aiSide
  if (caller?.memberId) {
    const mine = current.seats.find((s) => s.memberId === caller.memberId)
    if (mine) aiSide = mine.side
  } else {
    const turnSeat = seatOnSide(current.seats, snap.turnSide)
    if (turnSeat?.kind === 'ai' && turnSeat.side) aiSide = turnSeat.side
  }
  return {
    id: current.id,
    key: current.key,
    game: current.game,
    aiSide,
    humanSide: otherSide(current.game, aiSide),
    turnSide: snap.turnSide,
    over: Boolean(snap.over),
    view: snap,
    moves: current.moves.slice(),
    items: current.engine.list(),
    engine: current.engine,
  }
}

export function setPlayerName(value, key) {
  const current = table(key)
  if (!current) return
  current.playerName = playerName(value)
  const human = current.seats.find((s) => s.kind === 'human' && (s.local || s.ref === 'local'))
  if (human && current.mode === 'legacy') human.name = current.playerName
}
