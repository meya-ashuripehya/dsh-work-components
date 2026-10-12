import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BoardError } from '../errors.mjs'

const requireZh = (dir) => createRequire(pathToFileURL(join(dir, 'package.json')).href)

function fileNo(side, x) {
  return side === 'RED' ? x + 1 : 9 - x
}

function formatMove(pieces, piece, to) {
  const side = piece.side
  const onFile = pieces.filter((p) => p.side === side && p.name === piece.name && p.x === piece.x)
  const forward = side === 'RED' ? to.y < piece.y : to.y > piece.y
  const style = to.y === piece.y ? '平' : (forward ? '进' : '退')
  const horseLike = '马馬相象仕士'.includes(piece.name)
  const num = style === '平' || horseLike ? fileNo(side, to.x) : Math.abs(to.y - piece.y)
  if (onFile.length >= 2) {
    const ordered = onFile.slice().sort((a, b) => (side === 'RED' ? a.y - b.y : b.y - a.y))
    const index = ordered.findIndex((p) => p.y === piece.y)
    const prefix = ordered.length === 2
      ? (index === 0 ? '前' : '后')
      : (index === 0 ? '前' : index === ordered.length - 1 ? '后' : '中')
    return prefix + piece.name + style + num
  }
  return piece.name + String(fileNo(side, piece.x)) + style + num
}

function piecesOf(game) {
  return game.currentLivePieceList.map((p) => ({ x: p.x, y: p.y, name: p.name, side: p.side }))
}

export function openXiangqi(dir) {
  const ZhChess = requireZh(dir)('./lib/zh-chess.cjs.js').default
  const game = new ZhChess({ gameWidth: 520, gameHeight: 576, duration: 0 })
  game.gameStart('RED')
  let turn = 'RED'

  function list() {
    const pieces = piecesOf(game)
    return game.generateLegalMoves(turn).map((move) => {
      const piece = pieces.find((p) => p.x === move.from.x && p.y === move.from.y && p.side === turn)
      const coord = `${move.from.x},${move.from.y}-${move.to.x},${move.to.y}`
      return {
        move: coord,
        label: piece ? formatMove(pieces, piece, move.to) : coord,
        from: { x: move.from.x, y: move.from.y },
        to: { x: move.to.x, y: move.to.y },
      }
    })
  }

  return {
    list,
    play(text) {
      if (game.isGameOver()) throw new BoardError('这局已经结束')
      const raw = String(text || '').trim()
      const items = list()
      const byMove = items.find((item) => item.move === raw)
      const byLabel = items.filter((item) => item.label === raw)
      const hit = byMove || (byLabel.length === 1 ? byLabel[0] : null)
      if (!hit) throw new BoardError('这步不在合法着法里')
      if (!game.isLegalMove(turn, hit.from, hit.to)) throw new BoardError('这步不在合法着法里')
      const result = game.update(hit.from, hit.to, turn, true)
      if (!result || result.flag === false) throw new BoardError(result?.message || '这步不在合法着法里')
      turn = turn === 'RED' ? 'BLACK' : 'RED'
      return hit
    },
    view() {
      const over = game.isGameOver()
      const winner = game.winnerSide
      return {
        turnSide: turn === 'RED' ? 'red' : 'black',
        fen: game.getCurrentPenCode(turn === 'RED' ? 'RED' : 'BLACK'),
        pieces: piecesOf(game),
        over: over ? { winner: winner === 'RED' ? 'red' : winner === 'BLACK' ? 'black' : null, reason: '终局' } : null,
      }
    },
  }
}
