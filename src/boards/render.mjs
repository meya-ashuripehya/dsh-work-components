/**
 * 由棋局状态直接出图（不截图）：PNG，带坐标与上一步高亮。尺寸约 700×750，Telegram 里清晰。
 * 输入是 session.present() 的结果（view.game、view.board）与上一步 last（session 记录的命中着法）。
 */
import { Canvas, rgb } from './render/raster.mjs'

const WOOD = '#e8c27a'
const INK = '#3b2a14'
const LAST = rgb('#ff3b30')
const HIGHLIGHT = rgb('#f5e663', 0.75)

function renderChess(board, last) {
  const S = 80; const M = 40; const N = 8
  const c = new Canvas(S * N + M * 2, S * N + M * 2, '#2f2f2f')
  const files = 'abcdefgh'
  const lastSquares = new Set()
  if (last?.move && last.move.length >= 4) { lastSquares.add(last.move.slice(0, 2)); lastSquares.add(last.move.slice(2, 4)) }
  for (let r = 0; r < N; r++) {
    for (let f = 0; f < N; f++) {
      const x = M + f * S; const y = M + (N - 1 - r) * S
      c.fillRect(x, y, S, S, (r + f) % 2 === 0 ? '#b58863' : '#f0d9b5')
      if (lastSquares.has(files[f] + (r + 1))) c.fillRect(x, y, S, S, HIGHLIGHT)
    }
  }
  const map = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' }
  const outline = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' }
  for (const [sq, p] of Object.entries(board.pieces || {})) {
    const f = files.indexOf(sq[0].toLowerCase()); const r = Number(sq.slice(1)) - 1
    if (f < 0 || r < 0 || r >= N) continue
    const cx = M + f * S + S / 2; const cy = M + (N - 1 - r) * S + S / 2
    const kind = p.toUpperCase()
    const white = p === kind
    if (white) {
      c.glyph('c', map[kind], cx, cy, '#ffffff')
      c.glyph('c', outline[kind], cx, cy, '#111111')
    } else {
      c.glyph('c', map[kind], cx, cy, '#111111')
    }
  }
  if (board.check) {
    const king = board.turnSide === 'white' ? 'K' : 'k'
    const sq = Object.entries(board.pieces || {}).find(([, p]) => p === king)?.[0]
    if (sq) {
      const f = files.indexOf(sq[0].toLowerCase()); const r = Number(sq.slice(1)) - 1
      c.circle(M + f * S + S / 2, M + (N - 1 - r) * S + S / 2, S / 2 - 3, LAST, 4)
    }
  }
  for (let i = 0; i < N; i++) {
    const x = M + i * S + S / 2; const y = M + (N - 1 - i) * S + S / 2
    c.text(files[i], x, M / 2, '#eeeeee'); c.text(files[i], x, M + N * S + M / 2, '#eeeeee')
    c.text(String(i + 1), M / 2, y, '#eeeeee'); c.text(String(i + 1), M + N * S + M / 2, y, '#eeeeee')
  }
  return c
}

function renderXiangqi(board, last) {
  const S = 70; const M = 60; const W = 9; const H = 10
  const c = new Canvas(S * (W - 1) + M * 2, S * (H - 1) + M * 2, WOOD)
  const px = (x) => M + x * S; const py = (y) => M + y * S
  c.line(px(0) - 6, py(0) - 6, px(8) + 6, py(0) - 6, INK, 3)
  c.line(px(0) - 6, py(9) + 6, px(8) + 6, py(9) + 6, INK, 3)
  c.line(px(0) - 6, py(0) - 6, px(0) - 6, py(9) + 6, INK, 3)
  c.line(px(8) + 6, py(0) - 6, px(8) + 6, py(9) + 6, INK, 3)
  for (let y = 0; y < H; y++) c.line(px(0), py(y), px(8), py(y), INK, 1.6)
  for (let x = 0; x < W; x++) {
    if (x === 0 || x === 8) { c.line(px(x), py(0), px(x), py(9), INK, 1.6); continue }
    c.line(px(x), py(0), px(x), py(4), INK, 1.6)
    c.line(px(x), py(5), px(x), py(9), INK, 1.6)
  }
  for (const [y0, y1] of [[0, 2], [7, 9]]) {
    c.line(px(3), py(y0), px(5), py(y1), INK, 1.6)
    c.line(px(5), py(y0), px(3), py(y1), INK, 1.6)
  }
  if (last?.from) {
    const fx = px(last.from.x); const fy = py(last.from.y); const k = 10
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      c.line(fx + sx * 6, fy + sy * 6, fx + sx * (6 + k), fy + sy * 6, LAST, 3)
      c.line(fx + sx * 6, fy + sy * 6, fx + sx * 6, fy + sy * (6 + k), LAST, 3)
    }
  }
  for (const p of board.pieces || []) {
    const cx = px(p.x); const cy = py(p.y)
    const red = p.side === 'RED'
    c.circle(cx + 2, cy + 3, 30, rgb('#000000', 0.25))
    c.circle(cx, cy, 30, '#f7e7c4')
    c.circle(cx, cy, 30, red ? '#b3261e' : '#222222', 3)
    c.circle(cx, cy, 25, red ? '#b3261e' : '#222222', 1.2)
    c.glyph('x', p.name, cx, cy, red ? '#b3261e' : '#222222')
    if (last?.to && last.to.x === p.x && last.to.y === p.y) c.circle(cx, cy, 34, LAST, 3)
  }
  for (let x = 0; x < W; x++) {
    c.text(String(9 - x), px(x), M / 2 - 6, INK) // 黑方路数
    c.text(String(x + 1), px(x), py(9) + M / 2 + 6, '#b3261e') // 红方路数
  }
  return c
}

function stone(c, cx, cy, r, black) {
  c.circle(cx + 1.5, cy + 2, r, rgb('#000000', 0.3))
  c.circle(cx, cy, r, black ? '#1b1b1b' : '#f4f4f0')
  if (!black) c.circle(cx, cy, r, '#555555', 1.2)
}

function renderGrid(n, S, M, stars, labelsX, labelsY) {
  const c = new Canvas(S * (n - 1) + M * 2, S * (n - 1) + M * 2, '#dcb35c')
  for (let i = 0; i < n; i++) {
    c.line(M, M + i * S, M + (n - 1) * S, M + i * S, INK, i === 0 || i === n - 1 ? 2.2 : 1.2)
    c.line(M + i * S, M, M + i * S, M + (n - 1) * S, INK, i === 0 || i === n - 1 ? 2.2 : 1.2)
  }
  for (const [x, y] of stars) c.circle(M + x * S, M + y * S, 4.5, INK)
  for (let i = 0; i < n; i++) {
    c.text(labelsX[i], M + i * S, M / 2 - 4, INK); c.text(labelsX[i], M + i * S, M + (n - 1) * S + M / 2 + 4, INK)
    c.text(labelsY[i], M / 2 - 4, M + i * S, INK); c.text(labelsY[i], M + (n - 1) * S + M / 2 + 4, M + i * S, INK)
  }
  return c
}

function renderGomoku(board) {
  const n = 15; const S = 44; const M = 50
  const cols = [...'ABCDEFGHIJKLMNO']
  const rows = Array.from({ length: n }, (_, i) => String(i + 1)) // 第 0 行在上，记作 1（与右侧棋盘一致）
  const c = renderGrid(n, S, M, [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]], cols, rows)
  const cells = board.board || []
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue
    stone(c, M + (i % n) * S, M + Math.floor(i / n) * S, 19, cells[i] === 'B')
  }
  for (const i of board.winningLine || []) c.circle(M + (i % n) * S, M + Math.floor(i / n) * S, 21, rgb('#2e7d32'), 3)
  if (board.lastIndex != null && board.lastIndex >= 0) c.circle(M + (board.lastIndex % n) * S, M + Math.floor(board.lastIndex / n) * S, 5, LAST)
  return c
}

function renderGo(board, last) {
  const n = board.size || 19; const S = n <= 9 ? 64 : n <= 13 ? 50 : 36; const M = 44
  const COLS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
  const cols = [...COLS.slice(0, n)]
  const rows = Array.from({ length: n }, (_, y) => String(n - y))
  const pts = n === 19 ? [3, 9, 15] : n === 13 ? [3, 6, 9] : n === 9 ? [2, 4, 6] : []
  const stars = []
  for (const a of pts) for (const b of pts) stars.push([a, b])
  const c = renderGrid(n, S, M, stars, cols, rows)
  const r = S * 0.46
  const map = board.signMap || []
  for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) {
    if (map[y][x]) stone(c, M + x * S, M + y * S, r, map[y][x] === 1)
  }
  if (Array.isArray(board.dead)) {
    for (const [x, y] of board.dead) c.line(M + x * S - r / 2, M + y * S - r / 2, M + x * S + r / 2, M + y * S + r / 2, LAST, 3)
  }
  if (last?.vertex) {
    const [x, y] = last.vertex
    c.circle(M + x * S, M + y * S, r * 0.5, map[y]?.[x] === 1 ? '#ffffff' : '#111111', 2.5)
  }
  return c
}

/** @returns {{ png: Buffer, width: number, height: number }} */
export function renderBoard(view, last = null) {
  const board = view?.board || {}
  let canvas
  if (view?.game === 'chess') canvas = renderChess(board, last)
  else if (view?.game === 'xiangqi') canvas = renderXiangqi(board, last)
  else if (view?.game === 'gomoku') canvas = renderGomoku(board)
  else if (view?.game === 'go') canvas = renderGo(board, last)
  else throw new Error('unknown game ' + view?.game)
  return { png: canvas.toPng(), width: canvas.width, height: canvas.height }
}
