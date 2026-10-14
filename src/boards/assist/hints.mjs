/**
 * 辅助提示：轮到 AI（或刚走完、轮到对方）时，用已安装的辅助引擎做一次限时分析，
 * 给出前三名候选着法（本棋种自己的记谱）与 AI 一方视角的胜率。
 * 引擎没装、起不来、崩溃或超时：一律不给提示，绝不影响棋局。
 */
import { displayMove } from '../notation.mjs'
import { sessionHintContext } from '../session.mjs'
import { ASSIST_ENGINES } from './specs.mjs'
import { createEngine, readInstalled, setBeforeRemove } from './install.mjs'

export const DEFAULT_HINT_MS = 1000
const engines = new Map()
let factory = createEngine

/** 测试用：替换引擎构造（模拟进程）。传 null 还原。 */
export function setEngineFactory(fn) {
  factory = fn || createEngine
}

export function hintMs(cfg) {
  const n = Number(cfg?.boardsHintMs)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HINT_MS
  return Math.max(100, Math.min(10000, Math.round(n)))
}

function engineFor(game) {
  const installed = readInstalled(game)
  if (!installed) { stopEngine(game); return null }
  const prev = engines.get(game)
  if (prev && prev.key === installed.installedAt + installed.bin) return prev.engine
  if (prev) prev.engine.dispose()
  const engine = factory(game, installed)
  engines.set(game, { engine, key: installed.installedAt + installed.bin })
  return engine
}

/** 结束某棋种的引擎进程；返回的 Promise 在进程退出后完成（移除文件前要等它）。 */
export function stopEngine(game) {
  const e = engines.get(game)
  engines.delete(game)
  try { return Promise.resolve(e?.engine.dispose()).catch(() => {}) } catch { return Promise.resolve() }
}

export function stopAllEngines() {
  return Promise.all([...engines.keys()].map((game) => stopEngine(game)))
}

setBeforeRemove(stopEngine)
process.once('exit', stopAllEngines)

// ---- 局面 → 引擎输入；引擎着法 → 本棋种着法 ----

const XQ_FILES = 'abcdefghi'

function xiangqiFen(ctx) {
  const fen = String(ctx.view.fen || '').trim()
  if (!fen) return null
  const parts = fen.split(/\s+/)
  return `${parts[0]} ${parts[1] || (ctx.turnSide === 'red' ? 'w' : 'b')} - - 0 1`
}

function xiangqiItem(ctx, uci) {
  const m = /^([a-i])(\d)([a-i])(\d)$/.exec(uci)
  if (!m) return null
  const from = { x: XQ_FILES.indexOf(m[1]), y: 9 - Number(m[2]) }
  const to = { x: XQ_FILES.indexOf(m[3]), y: 9 - Number(m[4]) }
  return ctx.items.find((it) => it.from?.x === from.x && it.from?.y === from.y && it.to?.x === to.x && it.to?.y === to.y) || null
}

function chessItem(ctx, uci) {
  const base = String(uci || '').toLowerCase().slice(0, 4)
  return ctx.items.find((it) => it.move === base) || null
}

function gomokuStones(ctx) {
  const stones = []
  for (const mv of ctx.moves) {
    const m = /^([A-O])(\d{1,2})$/i.exec(mv)
    if (!m) return null
    stones.push({ x: m[1].toUpperCase().charCodeAt(0) - 65, y: Number(m[2]) - 1 })
  }
  return { stones }
}

function simpleItem(ctx, move) {
  const raw = String(move || '').trim().toLowerCase()
  return ctx.items.find((it) => it.move.toLowerCase() === raw) || null
}

const GO_COLS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

function goQuery(ctx) {
  const map = ctx.view.signMap
  if (!Array.isArray(map)) return null
  const size = map.length
  const stones = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (map[y][x] === 1) stones.push(['B', GO_COLS[x] + String(size - y)])
      else if (map[y][x] === -1) stones.push(['W', GO_COLS[x] + String(size - y)])
    }
  }
  return {
    moves: [],
    initialStones: stones,
    initialPlayer: ctx.turnSide === 'black' ? 'B' : 'W',
    rules: 'chinese',
    komi: 7.5,
    boardXSize: size,
    boardYSize: size,
  }
}

/** 与 present() 的 legal 一致的可走写法：标签唯一时用标签，否则用坐标。 */
function playable(ctx, item) {
  const same = ctx.items.filter((it) => it.label === item.label).length
  return same > 1 ? item.move : item.label
}

function positionFor(ctx) {
  if (ctx.game === 'xiangqi') return xiangqiFen(ctx)
  if (ctx.game === 'chess') return typeof ctx.engine.fen === 'function' ? ctx.engine.fen() : null
  if (ctx.game === 'gomoku') return gomokuStones(ctx)
  return goQuery(ctx)
}

function itemFor(ctx, move) {
  if (ctx.game === 'xiangqi') return xiangqiItem(ctx, move)
  if (ctx.game === 'chess') return chessItem(ctx, move)
  return simpleItem(ctx, move)
}

function flipWdl(wdl) {
  return { win: wdl.loss, draw: wdl.draw, loss: wdl.win }
}

/**
 * 计算提示。返回 null 表示不给（没装引擎 / 终局 / 引擎失败）。
 * ctx 默认取当前棋局；options.ms 为搜索时长。
 */
export async function computeHints(options = {}) {
  try {
    const ctx = options.ctx || sessionHintContext()
    if (!ctx || ctx.over || !ASSIST_ENGINES[ctx.game]) return null
    const engine = options.engine || engineFor(ctx.game)
    if (!engine) return null
    const position = positionFor(ctx)
    if (!position) return null
    const ms = options.ms || DEFAULT_HINT_MS
    const raw = await engine.analyze(position, ms)
    if (!Array.isArray(raw) || !raw.length) return null
    const aiToMove = ctx.turnSide === ctx.aiSide
    const candidates = []
    for (const r of raw) {
      const item = itemFor(ctx, r.move)
      if (!item || candidates.some((c) => c.move === playable(ctx, item))) continue
      const notation = displayMove(ctx.game, item.label, ctx.turnSide)
      const winrate = r.winrate == null ? null : (aiToMove ? r.winrate : Math.round((100 - r.winrate) * 10) / 10)
      const c = { move: playable(ctx, item), notation, winrate }
      if (r.wdl) c.wdl = aiToMove ? r.wdl : flipWdl(r.wdl)
      if (r.cp != null) c.cp = aiToMove ? r.cp : -r.cp
      if (r.mate != null) c.mate = aiToMove ? r.mate : -r.mate
      if (r.scoreLead != null) c.scoreLead = aiToMove ? r.scoreLead : -r.scoreLead
      if (r.depth) c.depth = r.depth
      if (r.visits) c.visits = r.visits
      candidates.push(c)
      if (candidates.length >= 3) break
    }
    if (!candidates.length) return null
    const spec = ASSIST_ENGINES[ctx.game]
    return {
      engine: spec.name,
      ms,
      toMove: aiToMove ? 'ai' : 'human',
      perspective: 'ai',
      candidates,
      note: aiToMove
        ? `${spec.name} 给出的你方前三名候选着法；winrate 为走这步后你方的胜率（%），仅供参考，最终由你决定。`
        : `${spec.name} 预测的对方前三名应着；winrate 为对方这样应着后你方的胜率（%）。`,
    }
  } catch {
    return null
  }
}
