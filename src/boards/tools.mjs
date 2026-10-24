import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { BoardError } from './errors.mjs'
import { playerName } from './names.mjs'
import { boardKey, closeSession, lookSession, openSession, playSession, resetGame, sessionHintContext } from './session.mjs'
import { telegramOriginFor } from './telegram.mjs'
import { computeHints, hintMs } from './assist/hints.mjs'
import { hasSession as cardTableOpen } from '../cards/session.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

function fail(error) {
  if (error instanceof BoardError) throw error
  throw new BoardError(error?.message || '棋局操作失败')
}

/**
 * 装了辅助引擎时附上 hints（前三名候选与 AI 视角胜率）；没装或失败时原样返回。
 * 只在未终局时做；board_play 后轮到对方时给的是对方可能的应着。
 */
function keyFrom(exec, origin) {
  if (exec?.game?.roomId) return boardKey({ roomId: exec.game.roomId })
  if (origin) return boardKey({ origin })
  if (exec?.agent?.id) return boardKey({ sessionId: exec.agent.id })
  return boardKey({})
}

function callerOf(exec) {
  const caller = exec?.game?.caller
  return caller?.memberId ? caller : undefined
}

function refuseOpen(exec) {
  if (exec?.game?.roomId && exec.game.owner === false) throw new BoardError('只有所有者可以开局、结束或重开', 403)
}

async function withHints(view, cfg, key, caller) {
  if (!view || view.over || view.turn === 'over') return view
  const hints = await computeHints({ ms: hintMs(cfg), ctx: sessionHintContext(key, { caller }) })
  return hints ? { ...view, hints } : view
}

/** @param {{ getConfig?: () => object }} options */
export function createBoardsTools(options = {}) {
  const getConfig = options.getConfig || (() => ({}))

  const openTool = defineTool({
    name: 'board_open',
    description: 'Open a board for this room or session. game is xiangqi, chess, gomoku, or go. Without seats, aiSide is the side you (the single AI) play and the human takes the other side; only one game per room or session. In a chatroom, pass seats: one entry per side, kind "ai" with memberId (seated immediately) or kind "human" with telegramUserId or local:true (pending until that person replies 入座). Do not play for another seat. An unfinished game for this same room or session resumes; a finished one starts fresh and includes lastResult. Missing board projects are downloaded at runtime.',
    parameters: {
      game: { type: 'string', required: true, description: 'One of xiangqi, chess, gomoku, go.' },
      aiSide: { type: 'string', description: 'Required when seats is omitted. red or black (xiangqi); white or black (chess); black or white (gomoku, go). Chinese 红/黑/白 is accepted.' },
      strict: { type: 'boolean', description: 'Go only. Default true: no overwrite, suicide, or immediate ko. false disables those three; captures are still counted.' },
      opponent: { type: 'string', description: 'Optional Telegram user id allowed to move the human side in a channel group. Defaults to the person who started the game.' },
      seats: {
        type: 'array',
        description: 'Chatroom only. Exactly one seat per side. Omit for a normal one-human versus one-AI game.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            side: { type: 'string', required: true, description: 'red, black, or white — a side of this game.' },
            kind: { type: 'string', required: true, description: 'ai or human.' },
            memberId: { type: 'string', description: 'Chatroom member id. Required when kind is ai.' },
            telegramUserId: { type: 'string', description: 'Telegram user id when kind is human. Use local:true instead for the desktop owner.' },
            local: { type: 'boolean', description: 'True when this human plays at the desktop.' },
            name: { type: 'string', description: 'Display name.' },
          },
        },
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      refuseOpen(exec)
      if (exec?.game?.roomId && cardTableOpen(`room:${exec.game.roomId}`)) throw new BoardError('这个房间已经有一桌牌，请先结束', 409)
      const cfg = getConfig() || {}
      const origin = exec?.game?.roomId ? null : telegramOriginFor(exec?.agent?.id, args.opponent)
      const key = keyFrom(exec, origin)
      const view = await openSession({
        key,
        game: args.game,
        aiSide: args.aiSide,
        seats: args.seats,
        strict: args.strict,
        playerName: playerName(cfg.boardsPlayerName),
        ...(origin ? { origin } : {}),
      }).catch(fail)
      const caller = callerOf(exec)
      return view.turnSeat?.memberId && caller?.memberId === view.turnSeat.memberId || (!view.turnSeat?.memberId && view.turn === 'ai')
        ? withHints(view, cfg, key, caller)
        : view
    },
  })

  const lookTool = defineTool({
    name: 'board_look',
    description: 'Look at the current game for this room or session: whose turn, the position, legal moves, and whether it is over. Hints, when an analysis engine is installed, are for the caller only and must not be copied into the shared room.',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const key = keyFrom(exec, exec?.game?.roomId ? null : telegramOriginFor(exec?.agent?.id))
      const caller = callerOf(exec)
      return withHints(lookSession(key, caller), getConfig() || {}, key, caller)
    },
  })

  const playTool = defineTool({
    name: 'board_play',
    description: 'Play one move for your own seat only. The move must be one of legal from board_open or board_look. Xiangqi: 车1进1 or 1,9-1,8. Chess: e2e4. Gomoku: H8. Go: D4, or pass. Illegal moves are rejected and the position is unchanged. Never play the other side.',
    parameters: {
      move: { type: 'string', required: true, description: 'One legal move.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = keyFrom(exec, exec?.game?.roomId ? null : telegramOriginFor(exec?.agent?.id))
      const caller = callerOf(exec)
      const played = await playSession(args.move, 'ai', { key, caller }).catch(fail)
      return withHints(played.view, getConfig() || {}, key, caller)
    },
  })

  const closeTool = defineTool({
    name: 'board_close',
    description: 'Close the board for this room or session. An unfinished game is kept and resumes on the next board_open of the same game. Use board_reset to discard it.',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      refuseOpen(exec)
      const key = keyFrom(exec, exec?.game?.roomId ? null : telegramOriginFor(exec?.agent?.id))
      return closeSession(key)
    },
  })

  const resetTool = defineTool({
    name: 'board_reset',
    description: 'Discard the saved game for this room or session and start again from the initial position. game is optional and defaults to the game in progress. Owner only.',
    parameters: {
      game: { type: 'string', description: 'Optional. One of xiangqi, chess, gomoku, go. Defaults to the game in progress.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      refuseOpen(exec)
      const key = keyFrom(exec, exec?.game?.roomId ? null : telegramOriginFor(exec?.agent?.id))
      return resetGame(args.game, key).catch(fail)
    },
  })

  const hintTool = defineTool({
    name: 'board_hint',
    description: 'Read-only analysis of the current position with an installed engine. Returns up to three candidate moves and win rates from the caller\'s side. Do not repeat the candidates in the shared room. ms is the search time in milliseconds (100–10000). available is false when no engine is installed, the game is over, or the engine fails. Does not change the position.',
    parameters: {
      ms: { type: 'number', description: 'Optional search time in milliseconds, 100–10000.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const key = keyFrom(exec, exec?.game?.roomId ? null : telegramOriginFor(exec?.agent?.id))
      const caller = callerOf(exec)
      lookSession(key, caller)
      const ms = args.ms ? hintMs({ boardsHintMs: args.ms }) : hintMs(getConfig() || {})
      const hints = await computeHints({ ms, ctx: sessionHintContext(key, { caller }) })
      return hints ? { available: true, hints } : { available: false, reason: 'No analysis engine is available (not installed, game over, or the engine failed).' }
    },
  })

  return [openTool, lookTool, playTool, closeTool, resetTool, hintTool]
}
