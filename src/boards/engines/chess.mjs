import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleEntry } from '../compile.mjs'
import { BoardError } from '../errors.mjs'

const FILES = 'abcdefgh'

function square(file, rank) {
  return FILES[file] + String(rank)
}

export async function openChess(dir) {
  const file = await bundleEntry('chess', 'chess-engine', {
    entryPoints: [join(dir, 'src', 'index.ts')],
  })
  const mod = await import(pathToFileURL(file).href)
  const game = new mod.Game()
  let lastMove = null

  function config() {
    return game.exportJson()
  }

  function list() {
    const map = game.moves() || {}
    const out = []
    for (const [from, tos] of Object.entries(map)) {
      const src = String(from).toLowerCase()
      for (const to of tos || []) out.push({ move: src + String(to).toLowerCase(), label: src + String(to).toLowerCase() })
    }
    return out
  }

  return {
    list,
    /** 当前局面的 FEN（给辅助引擎用）。 */
    fen() {
      return game.exportFEN()
    },
    play(text) {
      const cfg = config()
      if (cfg.isFinished) throw new BoardError('这局已经结束')
      const raw = String(text || '').trim().toLowerCase().replace(/\s+/g, '')
      const hit = list().find((item) => item.move === raw)
      if (!hit || hit.move.length < 4) throw new BoardError('这步不在合法着法里')
      try {
        game.move(hit.move.slice(0, 2), hit.move.slice(2, 4))
      } catch (error) {
        throw new BoardError(error?.message || '这步不在合法着法里')
      }
      lastMove = hit.move
      return hit
    },
    view() {
      const cfg = config()
      const turnSide = String(cfg.turn || 'white').toLowerCase()
      let over = null
      if (cfg.checkMate) {
        over = { winner: turnSide === 'white' ? 'black' : 'white', reason: '将死' }
      } else if (cfg.staleMate || cfg.isFinished) {
        over = { winner: null, reason: '和棋' }
      }
      return {
        turnSide: turnSide.startsWith('b') ? 'black' : 'white',
        pieces: cfg.pieces || {},
        check: cfg.check === true,
        lastMove,
        over,
      }
    },
  }
}

export { square }
