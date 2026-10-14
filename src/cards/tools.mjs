import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { contextKey } from './context.mjs'
import { CardError } from './errors.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame } from './session.mjs'
import { toLosslessJson } from './json-output.mjs'
import { telegramOriginFor } from './telegram.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

const UNO_PARAMS = {
  players: { type: 'integer', description: 'UNO only: number of players, 2-10. Defaults to the cardsUnoPlayers setting.' },
  teams: { type: 'string', description: 'UNO only: "none" (default), "2", "3" or "auto". Seats are split alternately: 2 teams need an even player count of at least 4 (seat i -> team i % 2), 3 teams need a multiple of 3 of at least 6 (seat i -> team i % 3). "auto" picks 2 if the count is even, else 3 if divisible by 3, else no teams. An explicit choice that does not fit the player count is rejected.' },
  seats: { type: 'array', items: { type: 'string' }, description: 'UNO only: role of every seat in order, one of "user", "ai" (you) or "bot", length = players. Versus: exactly one "user" and at most one "ai". Solo: no "user" and exactly one "ai". Default: versus = user seat 0, you seat 1, bots elsewhere; solo = you seat 0. Combine with teams to choose who is on which team (e.g. 4 players, teams "2", seats ["user","bot","ai","bot"] puts you and the user on team 1).' },
}

/** 工具参数 → 会话的 gameOptions；人数缺省时回落到设置 cardsUnoPlayers。 */
function unoOptions(args, cfg) {
  const out = { unoPlayers: cfg.cardsUnoPlayers }
  if (args.players !== undefined && args.players !== null && args.players !== '') out.players = args.players
  if (args.teams !== undefined && args.teams !== null && args.teams !== '') out.teams = args.teams
  if (args.seats !== undefined && args.seats !== null) out.seats = Array.isArray(args.seats) ? args.seats.map((r) => String(r).trim().toLowerCase()) : args.seats
  return out
}

function fail(error) {
  if (error instanceof CardError) throw error
  throw new CardError(error?.message || '牌局操作失败')
}

function caller(exec) {
  const origin = telegramOriginFor(exec?.agent?.id)
  const key = contextKey({ sessionId: exec?.agent?.id, origin })
  if (!key) throw new CardError('无法确定会话，已拒绝', 400)
  return { key, origin }
}

/** @param {{ getConfig?: () => object }} options */
export function createCardsTools(options = {}) {
  const getConfig = options.getConfig || (() => ({}))

  const openTool = defineTool({
    name: 'card_open',
    description: 'Open a card table shown to the user in the right-hand panel. game: blackjack (default), leduc, limit-holdem, uno, doudizhu. Only one table at a time. mode "versus" (default) means YOU play against the user: the user is seat 0 and plays by clicking cards on the page or via Telegram; you are your own seat (seat 1) and act only through card_play; any remaining seats (UNO 3-10 players, doudizhu third seat) are built-in bots that move automatically. Tool results only ever contain YOUR private view (yourHand plus public info such as top card, board, pot, card counts, recent moves) and never the user\'s hand; never guess, ask for, or reveal it. In versus blackjack there is only the user\'s hand: the user plays, you watch. mode "solo" (代打) means you play seat 0 alone against bots (the old behaviour). Saves are kept per game and per conversation (desktop session or Telegram chat/topic); reopening the same unfinished game resumes it in its saved mode. If the rules source is missing, download RLCard (MIT) in settings first. Never use RLCard or other upstream agents; bots are run by the plugin. UNO only: players, teams and seats configure a NEW hand (ignored when an unfinished save is resumed; card_reset first to apply them). With teams, seats are split alternately (seat i is on team i % teams); a team wins as soon as any member empties their hand; your view shows yourTeam, teammates (seats) and the team list, never teammates\' hands. The plugin never plays for the user or for you: bots only play their own bot seats.',
    parameters: {
      game: { type: 'string', description: 'blackjack, leduc, limit-holdem, uno or doudizhu. Defaults to blackjack.' },
      mode: { type: 'string', description: '"versus" (default): you play your own seat against the user. "solo": you play seat 0 alone against bots.' },
      ...UNO_PARAMS,
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cfg = getConfig() || {}
      const { origin } = caller(exec)
      return openSession({
        game: args.game || 'blackjack',
        playerName: cfg.cardsPlayerName,
        gameOptions: unoOptions(args, cfg),
        mode: args.mode || 'versus',
        perspective: 'agent',
        sessionId: exec?.agent?.id,
        ...(origin ? { origin } : {}),
      }).catch(fail)
    },
  })

  const lookTool = defineTool({
    name: 'card_look',
    description: 'Show YOUR private view of the current table: your seat and hand (yourHand), public info, seats with card counts, whose turn it is (turn = "you", "user" or "over"), and legal (non-empty only when it is your turn). The user\'s hand and bots\' hands are never included until a showdown makes them public.',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const { key } = caller(exec)
      return lookSession(key, 'agent')
    },
  })

  const playTool = defineTool({
    name: 'card_play',
    description: 'Play one action for YOUR OWN seat. Only allowed when card_look/turn says "you"; when it is the user\'s turn the call is rejected: wait for the user to play on the page or in Telegram (you will be told), never play for them. action must be one of legal. UNO: a card code such as r-5, or for wilds the chosen color + card (e.g. g-wild, b-wild_draw_4), or draw. Nothing is ever played for you: after draw, if the drawn card is playable you keep the turn (drawnCard) and must choose to play exactly that card or "pass" to keep it and end your turn. Doudizhu: a combination such as 34567 or 33, or pass. Leduc / limit hold\'em: call, raise, fold, check. Blackjack (solo mode only): hit or stand. Illegal actions are rejected and the table is unchanged; bot seats move automatically after you.',
    parameters: {
      action: { type: 'string', required: true, description: 'One of legal from card_look, for your own seat.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { key } = caller(exec)
      const played = await playSession(key, args.action, 'ai').catch(fail)
      return played.agentView
    },
  })

  const closeTool = defineTool({
    name: 'card_close',
    description: 'Close the card table. Only affects this conversation\'s current table: an unfinished hand stays saved and resumes on the next card_open of the same game; other games and conversations are untouched. Use card_reset to discard it.',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const { key } = caller(exec)
      return closeSession(key)
    },
  })

  const resetTool = defineTool({
    name: 'card_reset',
    description: 'Clear this conversation\'s save for the given game. Without game, redeal the current table in place (same mode unless mode is given). Other games, other conversations and their lastResult are untouched.',
    parameters: {
      game: { type: 'string', description: 'blackjack, leduc, limit-holdem, uno or doudizhu. Omit to redeal the current table.' },
      mode: { type: 'string', description: 'Optional new mode for the redeal: "versus" or "solo".' },
      ...UNO_PARAMS,
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { key } = caller(exec)
      const cfg = getConfig() || {}
      return resetGame(key, args.game, { ...unoOptions(args, cfg), mode: args.mode, perspective: 'agent' }).catch(fail)
    },
  })

  const tools = [openTool, lookTool, playTool, closeTool, resetTool]
  for (const tool of tools) {
    const run = tool.execute
    tool.execute = async (...args) => toLosslessJson(await run.apply(tool, args))
  }
  return tools
}
