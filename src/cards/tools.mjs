import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { contextKey } from './context.mjs'
import { CardError } from './errors.mjs'
import { missingCardDms } from './dm.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame } from './session.mjs'
import { toLosslessJson } from './json-output.mjs'
import { telegramOriginFor } from './telegram.mjs'
import { hasSession as boardOpen } from '../boards/session.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

const UNO_PARAMS = {
  players: { type: 'integer', description: 'UNO only: number of players, 2-10. Defaults to the cardsUnoPlayers setting.' },
  teams: { type: 'string', description: 'UNO only: "none" (default), "2", "3" or "auto". Seats are split alternately: 2 teams need an even player count of at least 4 (seat i -> team i % 2), 3 teams need a multiple of 3 of at least 6 (seat i -> team i % 3). "auto" picks 2 if the count is even, else 3 if divisible by 3, else no teams. An explicit choice that does not fit the player count is rejected.' },
  seats: {
    type: 'array',
    description: 'Channel UNO: one role string per seat, "user", "ai" or "bot". Chatroom: one object per seat, kind "ai" with memberId (seated immediately) or kind "human" with telegramUserId or local:true (pending until that person replies 入座). Chatroom counts: UNO 2-10, leduc and limit hold\'em 2, doudizhu 3 with seat 0 as landlord. Blackjack is not available at a chatroom table.',
    items: {
      oneOf: [
        { type: 'string', description: 'Channel UNO role: user, ai, or bot.' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, description: 'ai or human.' },
            memberId: { type: 'string', description: 'Chatroom member id. Required when kind is ai.' },
            telegramUserId: { type: 'string', description: 'Telegram user id when kind is human.' },
            local: { type: 'boolean', description: 'True when this human plays at the desktop.' },
            name: { type: 'string', description: 'Display name.' },
          },
        },
      ],
    },
  },
}

/** 工具参数 → 会话的 gameOptions；人数缺省时回落到设置 cardsUnoPlayers。 */
function splitSeats(args) {
  if (args.seats === undefined || args.seats === null) return { roles: undefined, roomSeats: undefined }
  if (!Array.isArray(args.seats)) return { roles: args.seats, roomSeats: undefined }
  if (args.seats.every((s) => s && typeof s === 'object')) return { roles: undefined, roomSeats: args.seats }
  return { roles: args.seats.map((r) => String(r).trim().toLowerCase()), roomSeats: undefined }
}

function unoOptions(args, cfg) {
  const out = { unoPlayers: cfg.cardsUnoPlayers }
  if (args.players !== undefined && args.players !== null && args.players !== '') out.players = args.players
  if (args.teams !== undefined && args.teams !== null && args.teams !== '') out.teams = args.teams
  const { roles } = splitSeats(args)
  if (roles !== undefined) out.seats = roles
  return out
}

function roomCaller(exec) {
  if (!exec?.game?.roomId) return null
  return {
    key: `room:${exec.game.roomId}`,
    roomId: String(exec.game.roomId),
    caller: exec.game.caller || null,
    owner: exec.game.owner !== false,
  }
}

function refuseRoomOwner(exec) {
  const room = roomCaller(exec)
  if (room && room.owner === false) throw new CardError('只有所有者可以开局、结束或重开', 403)
  return room
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
    description: 'Open a card table shown to the user in the right-hand panel. game: blackjack (default), leduc, limit-holdem, uno, doudizhu. One table per room or conversation. In a chatroom, pass seats as objects: AI members (memberId) sit immediately and may card_play only their own seat; humans (telegramUserId or local) stay pending until they reply 入座. A chatroom has one table, board or cards, and no automatic bots. Blackjack is refused there. Do not copy yourHand into the room. Outside a chatroom, mode "versus" (default) means YOU play against the user: the user is seat 0 and plays by clicking cards on the page or via Telegram; you are your own seat (seat 1) and act only through card_play; any remaining seats (UNO 3-10 players, doudizhu third seat) are built-in bots that move automatically. Tool results only ever contain YOUR private view (yourHand plus public info such as top card, board, pot, card counts, recent moves) and never the user\'s hand; never guess, ask for, or reveal it. In versus blackjack there is only the user\'s hand: the user plays, you watch. mode "solo" (代打) means you play seat 0 alone against bots (the old behaviour). Saves are kept per game and per conversation (desktop session or Telegram chat/topic); reopening the same unfinished game resumes it in its saved mode. If the rules source is missing, download RLCard (MIT) in settings first. Never use RLCard or other upstream agents; bots are run by the plugin. UNO only: players, teams and seats configure a NEW hand (ignored when an unfinished save is resumed; card_reset first to apply them). With teams, seats are split alternately (seat i is on team i % teams); a team wins as soon as any member empties their hand; your view shows yourTeam, teammates (seats) and the team list, never teammates\' hands. The plugin never plays for the user or for you: bots only play their own bot seats.',
    parameters: {
      game: { type: 'string', description: 'blackjack, leduc, limit-holdem, uno or doudizhu. Defaults to blackjack.' },
      mode: { type: 'string', description: '"versus" (default): you play your own seat against the user. "solo": you play seat 0 alone against bots.' },
      ...UNO_PARAMS,
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cfg = getConfig() || {}
      const room = refuseRoomOwner(exec)
      if (room && boardOpen(room.key)) throw new CardError('这个房间已经有一桌棋，请先结束', 409)
      const { roomSeats } = splitSeats(args)
      let seats = roomSeats
      if (room && !seats) {
        const memberId = room.caller?.memberId || ''
        if (!memberId) throw new CardError('中转站开局需要 seats，或由入座的 AI 成员来开', 400)
        seats = [
          { kind: 'human', local: true, name: cfg.cardsPlayerName || 'user' },
          { kind: 'ai', memberId, name: 'AI' },
        ]
      }
      if (room && seats) {
        const missing = missingCardDms(seats)
        if (missing.length) throw new CardError(`这些玩家还没有私聊接收机器人并发送 /start：${missing.join('、')}`, 409)
      }
      const { origin } = room ? { origin: null } : caller(exec)
      return openSession({
        game: args.game || 'blackjack',
        playerName: cfg.cardsPlayerName,
        gameOptions: unoOptions(args, cfg),
        mode: room ? 'room' : (args.mode || 'versus'),
        roomSeats: room ? seats : undefined,
        caller: room?.caller || undefined,
        perspective: 'agent',
        ...(room ? { roomId: room.roomId } : { sessionId: exec?.agent?.id }),
        ...(origin ? { origin } : {}),
      }).catch(fail)
    },
  })

  const lookTool = defineTool({
    name: 'card_look',
    description: 'Show YOUR private view of the current table: your seat and hand (yourHand), public info, seats with card counts, whose turn it is (turn = "you", "user" or "over"), and legal (non-empty only when it is your turn). The user\'s hand and other seats\' hands are never included until a showdown makes them public. In a chatroom the shared room history does not include yourHand.',
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const room = roomCaller(exec)
      const { key } = room || caller(exec)
      return lookSession(key, 'agent', room?.caller || undefined)
    },
  })

  const playTool = defineTool({
    name: 'card_play',
    description: 'Play one action for YOUR OWN seat. Only allowed when it is your turn; another seat is rejected. Never play for the user or for another member. action must be one of legal. UNO: a card code such as r-5, or for wilds the chosen color + card (e.g. g-wild, b-wild_draw_4), or draw. Nothing is ever played for you: after draw, if the drawn card is playable you keep the turn (drawnCard) and must choose to play exactly that card or "pass" to keep it and end your turn. Doudizhu: a combination such as 34567 or 33, or pass. Leduc / limit hold\'em: call, raise, fold, check. Blackjack (solo or versus channel only): hit or stand. Illegal actions are rejected and the table is unchanged. Outside a chatroom, bot seats move automatically after you. A chatroom table does not.',
    parameters: {
      action: { type: 'string', required: true, description: 'One of legal from card_look, for your own seat.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const room = roomCaller(exec)
      const { key } = room || caller(exec)
      const played = await playSession(key, args.action, 'ai', room?.caller || undefined).catch(fail)
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
      const room = refuseRoomOwner(exec)
      const { key } = room || caller(exec)
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
      const room = refuseRoomOwner(exec)
      const { key } = room || caller(exec)
      const cfg = getConfig() || {}
      return resetGame(key, args.game, { ...unoOptions(args, cfg), mode: args.mode, perspective: 'agent', caller: room?.caller || undefined }).catch(fail)
    },
  })

  const tools = [openTool, lookTool, playTool, closeTool, resetTool]
  for (const tool of tools) {
    const run = tool.execute
    tool.execute = async (...args) => toLosslessJson(await run.apply(tool, args))
  }
  return tools
}
