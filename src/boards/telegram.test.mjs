// 棋局转发到 Telegram：出图、来源识别、发图 / 改图回退、文字走子、非 Telegram 会话不变。Telegram API 用假 fetch 模拟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReplyContextStore } from '../../vendor/wsz987/channel-harness/lib/reply-context-store.js'
import { FetchTransport } from '../../vendor/wsz987/channel-telegram/lib/transport.js'
import { HttpTelegramUpstream } from '../../vendor/wsz987/channel-telegram/lib/upstream.js'
import {
  createBoardsTelegramBridge, installBoardsLink, lookupSessionOrigin, originFromContext, resetSessionOrigins,
} from '../channels/telegram/boards-link.mjs'
import { createOwnerGate, isOpenTool } from '../channels/telegram/owner-gate.mjs'
import { BoardError } from './errors.mjs'
import { displayMove, looksLikeMove, normalizeMove, splitLeadingMove } from './notation.mjs'
import { renderBoard } from './render.mjs'
import { closeSession, lookSession, openSession, resetGame, resetSession } from './session.mjs'
import { clearTelegramBridge, getBoardsInbound, setTelegramBridge } from './telegram-bridge.mjs'
import { ILLEGAL_NOTICE, NOT_PLAYER_NOTICE, captionFor, handleBoardInbound, installBoardsTelegram, telegramOriginFor, whenBoardsPublished } from './telegram.mjs'
import { createBoardsTools } from './tools.mjs'

const CHAT = '6153059771'
const GROUP = '-1003435238151'
const OWNER = '6153059771'
const FRIEND = '7000000002'
const STRANGER = '7000000001'

function pngSize(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 一个最小五子棋引擎（不用下载上游仓库）。 */
function fakeGomoku() {
  const board = Array(225).fill(null)
  let turn = 'B'
  let lastIndex = null
  const name = (i) => String.fromCharCode(65 + (i % 15)) + String(Math.floor(i / 15) + 1)
  const list = () => board.map((v, i) => (v ? null : { move: name(i), label: name(i), index: i })).filter(Boolean)
  return {
    list,
    play(text) {
      const hit = list().find((it) => it.move === String(text).trim().toUpperCase())
      if (!hit) throw new BoardError('这步不在合法着法里')
      board[hit.index] = turn; lastIndex = hit.index; turn = turn === 'B' ? 'W' : 'B'
      return hit
    },
    view: () => ({ turnSide: turn === 'B' ? 'black' : 'white', board: board.slice(), lastIndex, winningLine: null, over: null }),
  }
}

/** 假 Telegram Bot API：记录每次调用；editMessageMedia 可按需失败。 */
function fakeTelegram({ deleteFails = false, sendGate = null, startId = 100 } = {}) {
  const calls = []
  let nextId = startId
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop()
    const form = init.body instanceof FormData ? init.body : null
    const fields = {}
    if (form) for (const [k, v] of form.entries()) fields[k] = typeof v === 'string' ? v : { size: v.size, type: v.type }
    else if (typeof init.body === 'string') for (const [k, v] of Object.entries(JSON.parse(init.body))) fields[k] = String(v)
    calls.push({ method, fields })
    if (method === 'sendPhoto' && sendGate) await sendGate
    let body
    if (method === 'deleteMessage' && deleteFails) body = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }
    else if (method === 'deleteMessage') body = { ok: true, result: true }
    else body = { ok: true, result: { message_id: nextId++, date: 1, chat: { id: Number(fields.chat_id), type: 'private' } } }
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : 400, headers: { 'content-type': 'application/json' } })
  }
  const upstream = new HttpTelegramUpstream({
    transport: new FetchTransport('https://api.telegram.test', { timeoutMs: 5000, fetchImpl }),
    token: '123456:TEST_TOKEN_TEST_TOKEN_TEST',
    longPollTimeoutMs: 1000,
  })
  return { calls, upstream }
}

function register(store, sessionId, chatId, senderId, type = 'dm') {
  store.register(`m-${Math.random()}`, {
    sessionId,
    context: {
      conversationType: type,
      senderId,
      replyToMessageId: '1',
      raw: { update_id: 1, message: { message_id: 5, date: 1, chat: { id: Number(chatId), type: type === 'dm' ? 'private' : 'supergroup' }, from: { id: Number(senderId) }, text: 'x' } },
      runId: 'r',
    },
  })
}

installBoardsLink(ReplyContextStore, class {})

test('renderer: every game gives a non-empty PNG with the stated size', () => {
  const views = [
    { game: 'chess', board: { turnSide: 'black', pieces: { E1: 'K', E8: 'k', E4: 'P', D8: 'q', G1: 'N' }, check: false } },
    { game: 'xiangqi', board: { turnSide: 'black', pieces: [{ x: 4, y: 9, name: '帅', side: 'RED' }, { x: 4, y: 0, name: '将', side: 'BLACK' }, { x: 4, y: 7, name: '炮', side: 'RED' }] } },
    { game: 'gomoku', board: { turnSide: 'white', board: Object.assign(Array(225).fill(null), { 112: 'B' }), lastIndex: 112 } },
    { game: 'go', board: { turnSide: 'white', size: 19, signMap: Array.from({ length: 19 }, (_, y) => Array.from({ length: 19 }, (_, x) => (x === 3 && y === 15 ? 1 : 0))) } },
  ]
  const lasts = { chess: { move: 'e2e4' }, xiangqi: { from: { x: 1, y: 7 }, to: { x: 4, y: 7 } }, gomoku: null, go: { vertex: [3, 15] } }
  for (const view of views) {
    const out = renderBoard(view, lasts[view.game])
    assert.ok(out.png.length > 2000, view.game + ' png too small')
    assert.deepEqual(pngSize(out.png), { width: out.width, height: out.height })
    assert.ok(out.width >= 600 && out.width <= 1280 && out.height >= 600 && out.height <= 1280, view.game + ' size')
  }
  assert.throws(() => renderBoard({ game: 'nope', board: {} }))
})

test('notation: Chinese numerals and piece aliases normalise; captions read naturally', () => {
  assert.equal(normalizeMove('xiangqi', '炮二平五', 'red'), '炮2平5')
  assert.equal(normalizeMove('xiangqi', '马8进7', 'black'), '馬8进7')
  assert.equal(normalizeMove('chess', 'E2-E4', 'white'), 'e2e4')
  assert.equal(displayMove('xiangqi', '炮2平5', 'red'), '炮二平五')
  assert.equal(displayMove('xiangqi', '馬8进7', 'black'), '馬8进7')
  assert.equal(displayMove('go', 'pass', 'white'), '停着')
  assert.ok(looksLikeMove('xiangqi', '炮二平五'))
  assert.ok(looksLikeMove('chess', '@bot e2e4'))
  assert.ok(looksLikeMove('gomoku', 'H8'))
  assert.ok(!looksLikeMove('gomoku', '你好'))
  assert.ok(!looksLikeMove('chess', 'hello there'))
  const view = { label: '中国象棋', game: 'xiangqi', turnSide: 'black', over: null }
  assert.equal(captionFor({ type: 'move', view, side: 'red', notation: '炮2平5' }), '红方：炮二平五，轮到黑方')
  assert.equal(captionFor({ type: 'move', view: { ...view, over: { side: 'red', reason: '将死' } }, side: 'red', notation: '车1进9' }), '中国象棋终局：红方胜（将死）')
})

test('detection: the session id maps to the chat of its latest Telegram inbound', () => {
  resetSessionOrigins()
  const store = new ReplyContextStore()
  register(store, 'sess-dm', CHAT, OWNER)
  register(store, 'sess-group', GROUP, FRIEND, 'group')
  assert.deepEqual(lookupSessionOrigin('sess-dm'), { chatId: CHAT, senderId: OWNER, conversationType: 'dm' })
  assert.equal(lookupSessionOrigin('desktop-session'), null)
  assert.equal(originFromContext({ raw: { text: 'no chat' } }), null)
  // 没有通道桥：一律不是 Telegram。
  clearTelegramBridge(getBoardsBridgeForTest())
  assert.equal(telegramOriginFor('sess-dm'), null)
  const bridge = createBoardsTelegramBridge(fakeTelegram().upstream)
  setTelegramBridge(bridge)
  const origin = telegramOriginFor('sess-group', '7000000003')
  assert.equal(origin.chatId, GROUP)
  assert.equal(origin.conversationType, 'group')
  assert.equal(origin.starterId, FRIEND)
  assert.equal(origin.opponentId, '7000000003')
  assert.equal(telegramOriginFor('desktop-session'), null)
  clearTelegramBridge(bridge)
})

function getBoardsBridgeForTest() { return globalThis[Symbol.for('dsh-workbench.boards.telegram')] }


test('board_open from a Telegram session sends the board; every move sends a new photo and deletes the previous one', async () => {
  resetSession(); resetSessionOrigins()
  const tg = fakeTelegram()
  const bridge = createBoardsTelegramBridge(tg.upstream)
  setTelegramBridge(bridge)
  const off = installBoardsTelegram()
  try {
    const store = new ReplyContextStore()
    register(store, 'sess-dm', CHAT, OWNER)
    const origin = telegramOriginFor('sess-dm')
    const view = await openSession({ game: 'gomoku', aiSide: 'white', engine: fakeGomoku(), origin })
    assert.equal(view.delivery, 'telegram')
    assert.equal(tg.calls.length, 1)
    assert.equal(tg.calls[0].method, 'sendPhoto')
    assert.equal(tg.calls[0].fields.chat_id, CHAT)
    assert.equal(tg.calls[0].fields.photo.type, 'image/png')
    assert.ok(tg.calls[0].fields.photo.size > 2000)
    assert.match(tg.calls[0].fields.caption, /五子棋开局/)

    // 人在 Telegram 里打字走子 → 落子，底部发新图并删掉旧图，然后把提示交给 AI。
    const r = await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H8' })
    assert.match(r.forward, /下在了H8/)
    await whenBoardsPublished()
    assert.deepEqual(tg.calls.map((c) => c.method), ['sendPhoto', 'sendPhoto', 'deleteMessage'])
    assert.equal(tg.calls[1].fields.caption, '黑方：H8，轮到白方')
    assert.deepEqual(tg.calls[2].fields, { chat_id: CHAT, message_id: '100' })
    assert.equal(origin.messageId, null, 'caller origin is copied, not mutated')

    assert.deepEqual(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H9' }), { notice: '现在是 AI 的回合' })
    assert.equal(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: '你好' }), null)
    assert.equal(await handleBoardInbound({ chatId: '999', senderId: OWNER, text: 'H9' }), null)

    // AI 的 board_play：删除旧图失败（超过 48 小时 / 没权限）→ 留着，新图照发，之后删的是新图。
    tg.calls.length = 0
    const failing = fakeTelegram({ deleteFails: true })
    setTelegramBridge(createBoardsTelegramBridge(failing.upstream))
    const [, , play] = createBoardsTools()
    await play.execute({ move: 'I9' }, { agent: { id: 'sess-dm' } })
    assert.deepEqual(failing.calls.map((c) => c.method), ['sendPhoto', 'deleteMessage'])
    assert.equal(failing.calls[0].fields.chat_id, CHAT)
    assert.equal(failing.calls[1].fields.message_id, '101')
    assert.equal(lookSession().turn, 'human')
    assert.deepEqual(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'I9' }), { notice: ILLEGAL_NOTICE })
    assert.equal(failing.calls.length, 2, 'illegal move sends nothing')
  } finally {
    off(); closeSession(); clearTelegramBridge(getBoardsBridgeForTest())
  }
})

test('group: only the starter or the named opponent may move', async () => {
  resetSession(); resetSessionOrigins()
  const tg = fakeTelegram()
  setTelegramBridge(createBoardsTelegramBridge(tg.upstream))
  const off = installBoardsTelegram()
  try {
    const store = new ReplyContextStore()
    register(store, 'sess-group', GROUP, OWNER, 'group')
    await openSession({ game: 'gomoku', aiSide: 'white', engine: fakeGomoku(), origin: telegramOriginFor('sess-group', FRIEND) })
    assert.deepEqual(await handleBoardInbound({ chatId: GROUP, senderId: STRANGER, text: 'H8' }), { notice: NOT_PLAYER_NOTICE })
    // 非玩家的「着法 + 聊天」当普通聊天放过。
    assert.equal(await handleBoardInbound({ chatId: GROUP, senderId: STRANGER, text: 'H8 这步怎么样' }), null)
    const ok = await handleBoardInbound({ chatId: GROUP, senderId: FRIEND, text: 'h8' })
    assert.ok(ok.forward)
    await whenBoardsPublished()
    assert.equal(tg.calls.at(-1).fields.chat_id, GROUP)
  } finally {
    off(); closeSession(); clearTelegramBridge(getBoardsBridgeForTest())
  }
})

test('non-Telegram sessions: no origin, nothing sent, output unchanged', async () => {
  resetSession(); resetSessionOrigins()
  const tg = fakeTelegram()
  setTelegramBridge(createBoardsTelegramBridge(tg.upstream))
  const off = installBoardsTelegram()
  try {
    assert.equal(telegramOriginFor('desktop-session'), null)
    const view = await openSession({ game: 'gomoku', aiSide: 'white', engine: fakeGomoku() })
    assert.equal(view.delivery, undefined)
    assert.equal(view.deliveryNote, undefined)
    assert.equal(view.last, undefined)
    assert.equal(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H8' }), null)
    assert.equal(tg.calls.length, 0)
  } finally {
    off(); closeSession(); clearTelegramBridge(getBoardsBridgeForTest())
  }
})

test('inbound hook on the harness bridge: notice swallows, forward rewrites, others pass through', async () => {
  const seen = []
  class FakeBridge {
    async handleQueuedMessage(event, key, text) { seen.push(text) }
    async sendCommandNotice(event, text) { seen.push('notice:' + text) }
  }
  installBoardsLink(class {}, FakeBridge)
  const b = new FakeBridge()
  const ev = (text) => ({ channel: 'telegram', conversation: { id: CHAT, type: 'dm' }, sender: { id: OWNER }, message: { content: [{ type: 'text', text }] }, raw: { message: { chat: { id: Number(CHAT) } } } })
  const off = installBoardsTelegram()
  const saved = getBoardsInbound()
  try {
    globalThis[Symbol.for('dsh-workbench.boards.inbound')] = async ({ text }) => (text === 'bad' ? { notice: ILLEGAL_NOTICE } : text === 'H8' ? { forward: 'Shiro下在了H8,现在是你的回合' } : null)
    await b.handleQueuedMessage(ev('bad'), 'k', 'bad', null, 0)
    await b.handleQueuedMessage(ev('H8'), 'k', 'H8', null, 0)
    await b.handleQueuedMessage(ev('hello'), 'k', 'hello', null, 0)
    await b.handleQueuedMessage(ev('/new'), 'k', '/new', { name: 'new' }, 0)
    assert.deepEqual(seen, ['notice:' + ILLEGAL_NOTICE, 'Shiro下在了H8,现在是你的回合', 'hello', '/new'])
  } finally {
    globalThis[Symbol.for('dsh-workbench.boards.inbound')] = saved
    off()
  }
})

test('owner gate: board_look/board_play are open, board_open/board_close stay gated', () => {
  assert.ok(isOpenTool('board_play'))
  assert.ok(isOpenTool('board_look'))
  assert.ok(!isOpenTool('board_open'))
  assert.ok(!isOpenTool('board_close'))
  assert.ok(!isOpenTool('board_reset'))
  assert.ok(isOpenTool('board_hint'))
  const gate = createOwnerGate({ authorized: [OWNER] })
  gate.noteTurn('s1', STRANGER)
  assert.ok(gate.check({ name: 'board_open', agent: { id: 's1' } }))
  assert.equal(gate.check({ name: 'board_play', agent: { id: 's1' } }), undefined)
})

test('resume from a save re-binds to the current chat and sends a fresh photo; reset re-sends', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'dsh-boards-tg-save-'))
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession(); resetSessionOrigins()
  const tg = fakeTelegram()
  setTelegramBridge(createBoardsTelegramBridge(tg.upstream))
  const off = installBoardsTelegram()
  try {
    const store = new ReplyContextStore()
    register(store, 'sess-a', CHAT, OWNER)
    const engineFactory = async () => fakeGomoku()
    await openSession({ game: 'gomoku', aiSide: 'white', engineFactory, origin: telegramOriginFor('sess-a') })
    await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H8' })
    await whenBoardsPublished()
    resetSession() // 模拟 DSH 退出
    register(store, 'sess-b', GROUP, OWNER, 'group')
    tg.calls.length = 0
    const view = await openSession({ game: 'gomoku', aiSide: 'white', engineFactory, origin: telegramOriginFor('sess-b') })
    assert.equal(view.resumed.moveCount, 1)
    assert.deepEqual(tg.calls.map((c) => c.method), ['sendPhoto'], 'fresh photo, no edit of the old message')
    assert.equal(tg.calls[0].fields.chat_id, GROUP)
    assert.match(tg.calls[0].fields.caption, /续局（已走 1 步）/)
    tg.calls.length = 0
    await resetGame()
    assert.deepEqual(tg.calls.map((c) => c.method), ['sendPhoto'])
    assert.match(tg.calls[0].fields.caption, /重新开局/)
  } finally {
    off(); closeSession(); clearTelegramBridge(getBoardsBridgeForTest())
    delete process.env.DSH_WORKBENCH_DATA_DIR
    await rm(root, { recursive: true, force: true })
  }
})

test('notation: leading move + message splits only on a separator after a real move token', () => {
  assert.deepEqual(splitLeadingMove('gomoku', 'H9,Deepseek准备怎么下？'), { move: 'H9', rest: 'Deepseek准备怎么下？' })
  assert.deepEqual(splitLeadingMove('gomoku', '@bot h10，好'), { move: 'h10', rest: '好' })
  assert.deepEqual(splitLeadingMove('xiangqi', '炮二平五 你觉得呢'), { move: '炮二平五', rest: '你觉得呢' })
  assert.deepEqual(splitLeadingMove('xiangqi', '炮二平五：\n你觉得呢'), { move: '炮二平五', rest: '你觉得呢' })
  assert.deepEqual(splitLeadingMove('xiangqi', '1,2-3,4，嗯'), { move: '1,2-3,4', rest: '嗯' })
  assert.deepEqual(splitLeadingMove('chess', 'e2 e4 nice'), { move: 'e2 e4', rest: 'nice' })
  assert.equal(splitLeadingMove('gomoku', 'H9'), null)
  assert.equal(splitLeadingMove('gomoku', 'H9你好'), null, 'no separator')
  assert.equal(splitLeadingMove('gomoku', 'Hi there'), null)
  assert.equal(splitLeadingMove('gomoku', '我觉得 H9 不错'), null, 'only the leading token')
  assert.equal(splitLeadingMove('go', 'pass the salt'), null, 'no pass in mixed text')
  assert.equal(splitLeadingMove('chess', 'a1 is a square'), null)
})

test('move + message: plays the move and forwards the text; illegal replies and does not forward', async () => {
  resetSession(); resetSessionOrigins()
  const tg = fakeTelegram()
  setTelegramBridge(createBoardsTelegramBridge(tg.upstream))
  const off = installBoardsTelegram()
  try {
    const store = new ReplyContextStore()
    register(store, 'sess-dm', CHAT, OWNER)
    await openSession({ game: 'gomoku', aiSide: 'white', engine: fakeGomoku(), origin: telegramOriginFor('sess-dm'), playerName: 'Shiro' })
    const r = await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H9,Deepseek准备怎么下？' })
    assert.deepEqual(r, { forward: 'Shiro下在了H9，并说：Deepseek准备怎么下？现在是你的回合' })
    assert.equal(lookSession().turn, 'ai')
    // AI 的回合里发「着法 + 聊天」：不吞掉，照常交给 AI。
    assert.equal(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H10 你快点' }), null)
    const [, , play] = createBoardsTools()
    await play.execute({ move: 'H10' }, { agent: { id: 'sess-dm' } })
    await whenBoardsPublished()
    tg.calls.length = 0
    assert.deepEqual(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H9 再下这里' }), { notice: ILLEGAL_NOTICE })
    assert.equal(await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: '你觉得呢' }), null, 'pure chat unchanged')
    const r2 = await handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'G8 你觉得呢' })
    assert.equal(r2.forward, 'Shiro下在了G8，并说：你觉得呢。现在是你的回合')
    await whenBoardsPublished()
    assert.deepEqual(tg.calls.map((c) => c.method), ['sendPhoto', 'deleteMessage'], 'illegal move sent nothing')
  } finally {
    off(); closeSession(); clearTelegramBridge(getBoardsBridgeForTest())
  }
})

test('typed move wakes the AI without waiting for the photo upload; the new message id lands in the save', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'dsh-boards-tg-fast-'))
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession(); resetSessionOrigins()
  let release
  const tg = fakeTelegram()
  setTelegramBridge(createBoardsTelegramBridge(tg.upstream))
  const off = installBoardsTelegram()
  try {
    const store = new ReplyContextStore()
    register(store, 'sess-dm', CHAT, OWNER)
    await openSession({ game: 'gomoku', aiSide: 'white', engineFactory: async () => fakeGomoku(), origin: telegramOriginFor('sess-dm') })
    const slow = fakeTelegram({ startId: 200, sendGate: new Promise((r) => { release = r }) })
    setTelegramBridge(createBoardsTelegramBridge(slow.upstream))
    const r = await Promise.race([
      handleBoardInbound({ chatId: CHAT, senderId: OWNER, text: 'H8' }),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ])
    assert.match(r.forward, /下在了H8/, 'forward must not wait for sendPhoto')
    release()
    await whenBoardsPublished()
    const save = JSON.parse(await readFile(join(root, 'boards', 'saves', 'gomoku.json'), 'utf8'))
    assert.equal(save.telegram.messageId, '200')
    assert.equal(slow.calls[1].fields.message_id, '100')
    assert.deepEqual(slow.calls.map((c) => c.method), ['sendPhoto', 'deleteMessage'])
  } finally {
    release?.()
    off(); closeSession(); clearTelegramBridge(getBoardsBridgeForTest())
    delete process.env.DSH_WORKBENCH_DATA_DIR
    await rm(root, { recursive: true, force: true })
  }
})
