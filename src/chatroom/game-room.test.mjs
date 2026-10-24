import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOpenTool } from '../channels/telegram/owner-gate.mjs'
import { BoardError } from '../boards/errors.mjs'
import { closeSession as closeBoard, confirmSeat, lookSession as lookBoard, onSessionChange, openSession as openBoard, playSession as playBoard, resetSession as resetBoards, roomIdOf, saveFile, saveFileFor } from '../boards/session.mjs'
import { createBoardsTools } from '../boards/tools.mjs'
import { captionFor } from '../cards/telegram.mjs'
import { renderTable } from '../cards/render.mjs'
import { missingCardDms, registerCardDm, resetCardDms } from '../cards/dm.mjs'
import { confirmCardSeat, lookSession as lookCard, openSession as openCard, playSession as playCard, resetSession as resetCards, roomSnapshot, stripPrivate } from '../cards/session.mjs'
import { createCardsTools } from '../cards/tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { createRoomGames, streakLimit } from './game-table.mjs'
import { redactGameShare } from './chatroom-tools.mjs'
import { denyReason } from './tool-gate.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'

function fakeGomoku() {
  const board = Array(225).fill(null)
  let turn = 'B'
  let over = null
  const name = (i) => String.fromCharCode(65 + (i % 15)) + String(Math.floor(i / 15) + 1)
  const list = () => (over ? [] : board.map((v, i) => (v ? null : { move: name(i), label: name(i), index: i })).filter(Boolean))
  return {
    list,
    play(text) {
      const hit = list().find((it) => it.move === String(text).trim().toUpperCase())
      if (!hit) throw new BoardError('这步不在合法着法里')
      board[hit.index] = turn
      over = null
      turn = turn === 'B' ? 'W' : 'B'
      return hit
    },
    view: () => ({ turnSide: turn === 'B' ? 'black' : 'white', board: board.slice(), lastIndex: null, winningLine: null, over }),
  }
}

const factory = async () => fakeGomoku()
const bothAi = (black, white) => ([
  { side: 'black', kind: 'ai', memberId: black, name: black },
  { side: 'white', kind: 'ai', memberId: white, name: white },
])

async function withData(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-game-room-'))
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetBoards()
  resetCards()
  resetCardDms()
  try { await fn(root) } finally {
    resetBoards()
    resetCards()
    resetCardDms()
    delete process.env.DSH_WORKBENCH_DATA_DIR
    await rm(root, { recursive: true, force: true })
  }
}

test('streakLimit treats 0 as unlimited and falls back only for empty values', () => {
  assert.equal(streakLimit(0), 0)
  assert.equal(streakLimit('0'), 0)
  assert.equal(streakLimit(undefined), 60)
  assert.equal(streakLimit(''), 60)
})

test('two rooms do not share a board, and one AI cannot move the other side', () => withData(async () => {
  const a = await openBoard({ game: 'gomoku', roomId: 'room-a', seats: bothAi('claude', 'gpt'), engineFactory: factory, persist: false })
  const b = await openBoard({ game: 'gomoku', roomId: 'room-b', seats: bothAi('claude', 'gpt'), engineFactory: factory, persist: false })
  assert.equal(a.key, 'room:room-a')
  assert.notEqual(a.id, b.id)
  await assert.rejects(() => playBoard('H8', 'ai', { key: a.key, caller: { memberId: 'gpt' } }), /只能走自己这一方的棋/)
  await playBoard('H8', 'ai', { key: a.key, caller: { memberId: 'claude' } })
  assert.equal(lookBoard(a.key).moveCount, 1)
  assert.equal(lookBoard(b.key).moveCount, 0)
  await assert.rejects(() => playBoard('A1', 'ai', { key: a.key, caller: { memberId: 'claude' } }), /只能走自己这一方的棋/)
  await playBoard('A1', 'ai', { key: a.key, caller: { memberId: 'gpt' } })
  assert.equal(lookBoard(b.key).board.board.filter(Boolean).length, 0)
}))

test('legacy save is adopted once by a desktop open and never by a room', () => withData(async () => {
  mkdirSync(join(process.env.DSH_WORKBENCH_DATA_DIR, 'boards', 'saves'), { recursive: true })
  writeFileSync(saveFile('gomoku'), JSON.stringify({ game: 'gomoku', aiSide: 'black', moves: ['H8'] }))
  const room = await openBoard({ game: 'gomoku', roomId: 'keep', seats: bothAi('claude', 'gpt'), engineFactory: factory, persist: true })
  assert.equal(room.moveCount, 0)
  assert.equal(existsSync(saveFile('gomoku')), true)
  await closeBoard(room.key)
  const desk = await openBoard({ game: 'gomoku', sessionId: 'desk-1', engineFactory: factory, persist: true, aiSide: 'white' })
  assert.equal(desk.resumed.moveCount, 1)
  assert.match(desk.notice, /旧的单机存档/)
  assert.equal(existsSync(`${saveFile('gomoku')}.adopted`), true)
  assert.equal(existsSync(saveFileFor('desktop:desk-1', 'gomoku')), true)
  await closeBoard(desk.key)
  const other = await openBoard({ game: 'gomoku', sessionId: 'desk-2', engineFactory: factory, persist: true, aiSide: 'black' })
  assert.equal(other.moveCount, 0)
  assert.equal(existsSync(saveFile('gomoku')), false)
  assert.equal(existsSync(`${saveFile('gomoku')}.adopted`), true)
}))

test('board and card actions are not open tools; only the owner may open', () => {
  for (const name of ['board_look', 'board_play', 'board_hint', 'card_look', 'card_play', 'board_open', 'card_open']) {
    assert.equal(isOpenTool(name), false)
  }
  assert.match(denyReason('board_open', { owner: false, gameTurn: true }), /所有者/)
  assert.match(denyReason('card_open', { owner: false, gameTurn: true }), /所有者/)
  assert.match(denyReason('board_play', { owner: false, gameTurn: false }), /自己的座位/)
  assert.match(denyReason('card_play', { owner: false, gameTurn: false }), /自己的座位/)
  assert.equal(denyReason('board_play', { owner: false, gameTurn: true }), null)
  assert.equal(denyReason('card_look', { owner: true, gameTurn: false }), null)
})

test('a seated AI cannot board_play for the other member', () => withData(async () => {
  await openBoard({ game: 'gomoku', roomId: 'gate', seats: bothAi('claude', 'gpt'), engineFactory: factory, persist: false })
  const play = createBoardsTools({ getConfig: () => ({}) }).find((tool) => tool.name === 'board_play')
  const exec = (memberId, owner = false) => ({ game: { roomId: 'gate', owner, caller: { kind: 'ai', memberId } } })
  await play.execute({ move: 'H8' }, exec('claude', true))
  await assert.rejects(() => play.execute({ move: 'A1' }, exec('claude', true)), /只能走自己这一方的棋/)
}))

function scriptedCall(seen) {
  return async (req) => {
    seen.push(req)
    return { text: `${req.seat.name} 看过了`, usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } }
  }
}

async function settle(mod, roomId) {
  for (let i = 0; i < 50 && mod.status(roomId).running; i++) await new Promise((resolve) => setTimeout(resolve, 20))
}

async function roomMod(gameAiStreak = 60) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-game-mod-'))
  const store = createStore(dir)
  const room = await store.createRoom({ title: '对局' })
  const seen = []
  const seats = [
    { id: 'claude', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true },
    { id: 'gpt', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: true },
  ]
  const games = createRoomGames()
  const mod = createModerator({
    store,
    games,
    call: scriptedCall(seen),
    emit: () => {},
    getRoomConfig: async () => ({ seats: resolveSeats({ chatroomSeats: seats }), userName: 'Shiro', gameAiStreak, budget: 10, maxTokens: 100, ownerId: '9000000001' }),
  })
  return { dir, store, room, mod, seen, games, seats }
}

test('an AI turn calls only that member and does not spend the discussion budget', () => withData(async () => {
  const fx = await roomMod()
  try {
    await openBoard({ game: 'gomoku', roomId: fx.room.id, seats: bothAi('claude', 'gpt'), engineFactory: factory, persist: false })
    const reason = await fx.mod.start(fx.room.id)
    assert.equal(reason, 'reminded')
    assert.deepEqual(fx.seen.map((s) => s.seat.id), ['claude'])
    assert.match(JSON.stringify(fx.seen[0].prompt), /轮到你了/)
    const messages = await fx.store.readMessages(fx.room.id)
    assert.equal(messages.some((m) => m.kind === 'seat' && m.speaker?.id === 'gpt'), false)
    assert.equal(fx.mod.status(fx.room.id).task, null)
    const prompt = JSON.stringify(buildPrompt({ seat: fx.seats[0], seats: fx.seats, userName: 'Shiro', messages }))
    assert.match(prompt, /轮到Claude了/)
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
}))

test('group text and a desktop click become room events and rotate the turn', () => withData(async () => {
  const fx = await roomMod()
  try {
    const group = await fx.store.createRoom({ title: '群' })
    await openBoard({
      game: 'gomoku', roomId: group.id, engineFactory: factory, persist: false,
      seats: [
        { side: 'black', kind: 'ai', memberId: 'claude', name: 'Claude' },
        { side: 'white', kind: 'human', telegramUserId: '7001', name: '客人' },
      ],
    })
    const joined = await fx.games.route(group.id, { text: '入座', telegramUserId: '7001' })
    assert.equal(joined.consumed, true)
    await playBoard('H8', 'ai', { key: `room:${group.id}`, caller: { memberId: 'claude' } })
    const desk = await fx.store.createRoom({ title: '桌面' })
    await openBoard({
      game: 'gomoku', roomId: desk.id, engineFactory: factory, persist: false,
      seats: [
        { side: 'black', kind: 'ai', memberId: 'claude', name: 'Claude' },
        { side: 'white', kind: 'human', local: true, name: 'Shiro' },
      ],
    })
    await confirmSeat(`room:${desk.id}`, { local: true })
    await playBoard('H8', 'ai', { key: `room:${desk.id}`, caller: { memberId: 'claude' } })
    const off = onSessionChange((event) => {
      const roomId = roomIdOf(event?.key)
      if (!roomId) return undefined
      return fx.mod.noteBoard(roomId, event)
    })
    try {
      const posted = await fx.mod.post(group.id, 'A1', { source: 'telegram', fromId: '7001', owner: false, run: false })
      assert.equal(posted.routed, true)
      await settle(fx.mod, group.id)
      const messages = await fx.store.readMessages(group.id)
      assert.ok(messages.some((m) => m.kind === 'system' && m.game === true && /客人 下在了A1/.test(m.text) && /轮到 Claude/.test(m.text)))
      await playBoard('B2', 'human', { key: `room:${desk.id}`, caller: { local: true } })
      await settle(fx.mod, desk.id)
      const deskMessages = await fx.store.readMessages(desk.id)
      assert.ok(deskMessages.some((m) => m.kind === 'system' && m.game === true && /Shiro 下在了B2/.test(m.text)))
    } finally { off() }
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
}))

test('an AI streak pauses the match, and 继续 / 停止 stay out of the AI prompt', () => withData(async () => {
  const fx = await roomMod(2)
  const off = onSessionChange((event) => {
    const roomId = roomIdOf(event?.key)
    if (!roomId) return undefined
    return fx.mod.noteBoard(roomId, event)
  })
  try {
    await openBoard({ game: 'gomoku', roomId: fx.room.id, seats: bothAi('claude', 'gpt'), engineFactory: factory, persist: false })
    await playBoard('H8', 'ai', { key: `room:${fx.room.id}`, caller: { memberId: 'claude' } })
    await settle(fx.mod, fx.room.id)
    assert.equal(fx.games.snapshot(fx.room.id).paused, false)
    await playBoard('A1', 'ai', { key: `room:${fx.room.id}`, caller: { memberId: 'gpt' } })
    await settle(fx.mod, fx.room.id)
    assert.equal(fx.games.snapshot(fx.room.id).paused, true)
    const paused = await fx.store.readMessages(fx.room.id)
    assert.ok(paused.some((m) => /对局已暂停（已连续 2 步）/.test(m.text) && m.game !== true))
    const resumed = await fx.mod.post(fx.room.id, '继续', { owner: true, run: false })
    assert.equal(resumed.control, 'resume')
    assert.equal(resumed.message, null)
    await fx.mod.post(fx.room.id, '停止', { owner: true, run: false })
    const messages = await fx.store.readMessages(fx.room.id)
    assert.equal(messages.some((m) => m.kind === 'user'), false)
    const prompt = JSON.stringify(buildPrompt({ seat: fx.seats[0], seats: fx.seats, userName: 'Shiro', messages }))
    assert.doesNotMatch(prompt, /继续|停止|对局已暂停/)
    assert.match(prompt, /下在了H8/)
  } finally {
    off()
    await rm(fx.dir, { recursive: true, force: true })
  }
}))

test('a chatroom UNO hides other hands, rejects the wrong seat, and will not deal before /start', () => withData(async () => {
  const seats = [
    { kind: 'human', local: true, name: 'Shiro' },
    { kind: 'ai', memberId: 'claude', name: 'Claude' },
    { kind: 'ai', memberId: 'gpt', name: 'GPT' },
    { kind: 'ai', memberId: 'deepseek', name: 'DeepSeek' },
  ]
  const opened = await openCard({ game: 'uno', roomId: 'uno', skipSource: true, seed: 11, persist: false, roomSeats: seats, playerName: 'Shiro' })
  assert.equal(opened.mode, 'room')
  const key = 'room:uno'
  const views = ['claude', 'gpt', 'deepseek'].map((memberId) => lookCard(key, 'agent', { memberId }))
  for (const view of views) {
    const mine = new Set(view.yourHand)
    const pub = JSON.stringify({ ...view, yourHand: undefined, legal: undefined })
    for (const other of views) {
      if (other === view) continue
      for (const code of other.yourHand) if (!mine.has(code)) assert.equal(pub.includes(code), false, code)
    }
    const red = redactGameShare('card_look', JSON.stringify(view))
    assert.equal(red.shared, '看了自己的牌。')
    assert.equal(red.stored.includes('yourHand'), false)
  }
  const games = createRoomGames()
  const snap = roomSnapshot(key)
  for (const memberId of ['claude', 'gpt', 'deepseek']) {
    const own = views.find((view) => view.you.name === (memberId === 'claude' ? 'Claude' : memberId === 'gpt' ? 'GPT' : 'DeepSeek'))
    let text = games.prompt(snap, memberId)
    assert.match(text, /yourHand/)
    if (own.topCard) text = text.split(own.topCard).join('')
    for (const code of views.flatMap((view) => view.yourHand)) {
      if (own.yourHand.includes(code)) continue
      assert.equal(text.includes(code), false, code)
    }
  }
  const page = lookCard(key)
  const caption = captionFor({ type: 'open', view: page })
  const png = renderTable(stripPrivate(page)).png
  const topCodes = new Set((page.rows || []).filter((row) => row.label === 'T').flatMap((row) => (row.cards || []).map((card) => card.code).filter(Boolean)))
  for (const code of views.flatMap((view) => view.yourHand)) {
    if (topCodes.has(code)) continue
    assert.equal(caption.includes(code), false, caption)
    assert.equal(png.includes(Buffer.from(code)), false)
  }
  await assert.rejects(() => playCard(key, views[0].yourHand[0], 'ai', { memberId: 'claude' }), /未入座|自己这一方/)
  await confirmCardSeat(key, { local: true })
  const actor = roomSnapshot(key).actor
  const legal = lookCard(key).legal
  assert.ok(legal.length)
  if (actor?.kind === 'human') {
    await assert.rejects(() => playCard(key, legal[0], 'ai', { memberId: 'claude' }), /自己这一方/)
    await playCard(key, legal[0], 'human', { local: true })
  } else {
    const other = actor?.memberId === 'claude' ? 'gpt' : 'claude'
    await assert.rejects(() => playCard(key, legal[0], 'ai', { memberId: other }), /自己这一方/)
  }

  const tools = createCardsTools({ getConfig: () => ({ cardsPlayerName: 'Shiro' }) })
  const open = tools.find((tool) => tool.name === 'card_open')
  const guest = { kind: 'human', telegramUserId: '7001', name: '客人' }
  const partner = { kind: 'ai', memberId: 'claude', name: 'Claude' }
  await assert.rejects(() => open.execute({ game: 'uno', seats: [guest, partner] }, { game: { roomId: 'dm', owner: false, caller: { kind: 'ai', memberId: 'claude' } } }), /所有者/)
  await assert.rejects(() => open.execute({ game: 'uno', seats: [guest, partner] }, { game: { roomId: 'dm', owner: true, caller: { kind: 'ai', memberId: 'claude' } } }), /\/start/)
  registerCardDm('7001', '9001')
  assert.deepEqual(missingCardDms([guest, partner]), [])
  await openCard({ game: 'uno', roomId: 'dm', skipSource: true, seed: 4, persist: false, roomSeats: [guest, { kind: 'human', local: true, name: 'Shiro' }, partner], playerName: 'Shiro' })
  const guestKey = 'room:dm'
  await confirmCardSeat(guestKey, { telegramUserId: '7001' })
  await confirmCardSeat(guestKey, { local: true })
  const guestActor = roomSnapshot(guestKey).actor
  const guestLegal = lookCard(guestKey).legal
  assert.ok(guestLegal.length)
  if (guestActor?.seat === 0) {
    await assert.rejects(() => playCard(guestKey, guestLegal[0], 'human', { local: true }), /自己这一方/)
    await playCard(guestKey, guestLegal[0], 'human', { telegramUserId: '7001' })
    await assert.rejects(() => playCard(guestKey, 'r-0', 'human', { local: true }), /自己这一方|不合法/)
  } else if (guestActor?.kind === 'human') {
    await assert.rejects(() => playCard(guestKey, guestLegal[0], 'human', { telegramUserId: '7001' }), /自己这一方/)
    await playCard(guestKey, guestLegal[0], 'human', { local: true })
  } else {
    await assert.rejects(() => playCard(guestKey, guestLegal[0], 'human', { telegramUserId: '7001' }), /自己这一方/)
    await assert.rejects(() => playCard(guestKey, guestLegal[0], 'ai', { memberId: 'gpt' }), /自己这一方/)
  }
}))
