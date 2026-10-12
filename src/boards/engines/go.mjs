import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BoardError } from '../errors.mjs'

const COLS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

function coordOf(x, y, height) {
  return COLS[x] + String(height - y)
}

function parseVertex(text, width, height) {
  const raw = String(text || '').trim().toUpperCase()
  if (raw === 'PASS' || raw === '停着') return null
  const m = /^([A-Z])(\d{1,2})$/.exec(raw)
  if (!m) throw new BoardError('这步不在合法着法里')
  const x = COLS.indexOf(m[1])
  const y = height - Number(m[2])
  if (x < 0 || x >= width || y < 0 || y >= height) throw new BoardError('这步不在合法着法里')
  return [x, y]
}

export function openGo(dir, options = {}) {
  const require = createRequire(pathToFileURL(join(dir, 'package.json')).href)
  const Board = require('./src/main.js')
  const strict = options.strict !== false
  const flags = {
    preventOverwrite: strict,
    preventSuicide: strict,
    preventKo: strict,
  }
  const size = options.size || 19
  let board = options.signMap
    ? new Board(options.signMap.map((row) => row.slice()))
    : Board.fromDimensions(size)
  let side = options.turn === -1 || options.turn === 'white' ? -1 : 1
  let passes = 0
  let over = null
  let dead = null

  function sideName(sign) {
    return sign === 1 ? 'black' : 'white'
  }

  function list() {
    if (over) return []
    const out = []
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        const info = board.analyzeMove(side, [x, y])
        if (info.pass) continue
        if (strict && (info.overwrite || info.suicide || info.ko)) continue
        const name = coordOf(x, y, board.height)
        out.push({ move: name, label: name, vertex: [x, y] })
      }
    }
    out.push({ move: 'pass', label: 'pass', vertex: null })
    return out
  }

  async function finish() {
    over = { winner: null, reason: '双方停着' }
    dead = null
    if (!options.deadstonesDir) return
    try {
      const load = createRequire(pathToFileURL(join(options.deadstonesDir, 'package.json')).href)
      const ds = load('./js/main.js')
      dead = await ds.guess(board.signMap.map((row) => row.slice()), { finished: true, iterations: 40 })
    } catch {
      dead = null
    }
  }

  return {
    list,
    async play(text) {
      if (over) throw new BoardError('这局已经结束')
      const raw = String(text || '').trim().toLowerCase()
      const hit = list().find((item) => item.move.toLowerCase() === raw || item.label.toLowerCase() === raw)
      if (!hit) throw new BoardError('这步不在合法着法里')
      if (hit.vertex == null) {
        passes += 1
        side = -side
        if (passes >= 2) await finish()
        return hit
      }
      passes = 0
      try {
        board = board.makeMove(side, hit.vertex, flags)
      } catch (error) {
        throw new BoardError(error?.message || '这步不在合法着法里')
      }
      side = -side
      return hit
    },
    view() {
      return {
        turnSide: sideName(side),
        size: board.width,
        signMap: board.signMap.map((row) => row.slice()),
        captures: { black: board.getCaptures(1), white: board.getCaptures(-1) },
        dead,
        over,
      }
    },
  }
}
