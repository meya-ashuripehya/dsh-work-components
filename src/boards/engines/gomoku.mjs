import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleEntry } from '../compile.mjs'
import { BoardError } from '../errors.mjs'

const SIZE = 15

function cellName(index) {
  const row = Math.floor(index / SIZE)
  const col = index % SIZE
  return String.fromCharCode(65 + col) + String(row + 1)
}

function parseCell(text) {
  const m = /^([A-O])(\d{1,2})$/i.exec(String(text || '').trim())
  if (!m) return -1
  const col = m[1].toUpperCase().charCodeAt(0) - 65
  const row = Number(m[2]) - 1
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return -1
  return row * SIZE + col
}

export async function openGomoku(dir) {
  const file = await bundleEntry('gomoku', 'gomoku', {
    stdin: {
      contents: "export { advanceGame, createInitialState } from './game.ts'\n",
      resolveDir: join(dir, 'src', 'logic'),
      sourcefile: 'entry.ts',
      loader: 'ts',
    },
  })
  const mod = await import(pathToFileURL(file).href)
  let state = mod.createInitialState({ mode: 'pvp', humanStone: 'B', startingStone: 'B' })

  function list() {
    if (state.status !== 'playing') return []
    const out = []
    for (let i = 0; i < state.board.length; i++) {
      if (state.board[i] != null) continue
      const name = cellName(i)
      out.push({ move: name, label: name, index: i })
    }
    return out
  }

  return {
    list,
    play(text) {
      if (state.status !== 'playing') throw new BoardError('这局已经结束')
      const index = parseCell(text)
      const hit = list().find((item) => item.index === index || item.move.toUpperCase() === String(text || '').trim().toUpperCase())
      if (!hit) throw new BoardError('这步不在合法着法里')
      const next = mod.advanceGame(state, { type: 'place', index: hit.index }, { rng: () => 0 })
      if (next === state || next.moveCount === state.moveCount) throw new BoardError('这步不在合法着法里')
      state = next
      return hit
    },
    view() {
      const turnSide = state.current === 'B' ? 'black' : 'white'
      let over = null
      if (state.status === 'won') over = { winner: state.winner === 'B' ? 'black' : 'white', reason: '五连' }
      else if (state.status === 'draw') over = { winner: null, reason: '和棋' }
      return {
        turnSide,
        board: state.board.slice(),
        lastIndex: state.lastMoveIndex,
        winningLine: state.winningLine,
        over,
      }
    },
  }
}
