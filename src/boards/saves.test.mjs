import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardError } from './errors.mjs'
import { DEFAULT_KEY, closeSession, lookSession, onSessionChange, openSession, playSession, resetGame, resetSession, saveFile, saveFileFor, savesDir } from './session.mjs'
import { createBoardsTools } from './tools.mjs'

/** 假五子棋（15×15），有五连判定；engineFactory 让存档逻辑照常读写。 */
function fakeGomoku() {
  const board = Array(225).fill(null)
  let turn = 'B'
  let over = null
  const name = (i) => String.fromCharCode(65 + (i % 15)) + String(Math.floor(i / 15) + 1)
  const list = () => (over ? [] : board.map((v, i) => (v ? null : { move: name(i), label: name(i), index: i })).filter(Boolean))
  const five = (i) => {
    const r = Math.floor(i / 15)
    let n = 0
    for (let c = 0; c < 15; c++) { n = board[r * 15 + c] === board[i] ? n + 1 : 0; if (n >= 5) return true }
    return false
  }
  return {
    list,
    play(text) {
      const hit = list().find((it) => it.move === String(text).trim().toUpperCase())
      if (!hit) throw new BoardError('这步不在合法着法里')
      board[hit.index] = turn
      if (five(hit.index)) over = { winner: turn === 'B' ? 'black' : 'white', reason: '五连' }
      turn = turn === 'B' ? 'W' : 'B'
      return hit
    },
    view: () => ({ turnSide: turn === 'B' ? 'black' : 'white', board: board.slice(), lastIndex: null, winningLine: null, over }),
  }
}

const factory = async () => fakeGomoku()
const open = (extra = {}) => openSession({ game: 'gomoku', aiSide: 'black', engineFactory: factory, ...extra })

async function withData(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-boards-saves-'))
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  try { await fn(root) } finally {
    resetSession()
    delete process.env.DSH_WORKBENCH_DATA_DIR
    await rm(root, { recursive: true, force: true })
  }
}

test('save after open and every move; restart resumes from the saved position', () => withData(async (root) => {
  assert.equal(savesDir(), join(root, 'boards', 'saves'))
  const first = await open()
  assert.equal(first.resumed, undefined)
  assert.ok(existsSync(saveFileFor(DEFAULT_KEY, 'gomoku')))
  await playSession('H8', 'ai')
  await playSession('H9', 'human')
  await playSession('I8', 'ai')
  const saved = JSON.parse(readFileSync(saveFileFor(DEFAULT_KEY, 'gomoku'), 'utf8'))
  assert.deepEqual(saved.moves, ['H8', 'H9', 'I8'])
  assert.equal(saved.aiSide, 'black')
  assert.equal(saved.turnSide, 'white')
  assert.ok(saved.createdAt && saved.updatedAt)
  assert.ok(!readdirSync(savesDir()).some((n) => n.endsWith('.tmp')))

  // 模拟进程退出：内存清空，不经 board_close。
  resetSession()
  const events = []
  const off = onSessionChange((e) => { events.push(e) })
  const back = await open({ aiSide: 'white' })
  off()
  assert.equal(back.resumed.moveCount, 3)
  assert.equal(back.resumed.turn, 'human')
  assert.equal(back.aiSide, 'black', 'resume keeps the saved side')
  assert.match(back.notice, /board_reset/)
  assert.match(back.instruction, /续局：已走 3 步，轮到白方/)
  assert.equal(back.board.board.filter(Boolean).length, 3)
  assert.equal(events[0].type, 'open')
  assert.equal(events[0].resumed, true)
  assert.equal(events[0].last.move, 'I8')
  assert.equal(lookSession().notice, undefined)
}))

test('board_close mid-game keeps the save; the next open resumes', () => withData(async () => {
  await open()
  await playSession('A1', 'ai')
  const closed = closeSession()
  assert.equal(closed.saved, true)
  assert.ok(existsSync(saveFileFor(DEFAULT_KEY, 'gomoku')))
  const back = await open()
  assert.equal(back.resumed.moveCount, 1)
}))

test('corrupt save is backed up and a fresh game starts', () => withData(async () => {
  await open(); await playSession('A1', 'ai'); resetSession()
  writeFileSync(saveFileFor(DEFAULT_KEY, 'gomoku'), '{ not json', 'utf8')
  const fresh = await open()
  assert.equal(fresh.resumed, undefined)
  assert.match(fresh.notice, /存档损坏/)
  assert.equal(fresh.moveCount, 0)
  assert.ok(readdirSync(savesDir()).some((n) => /^gomoku\.corrupt-.*\.json$/.test(n)))
  resetSession()
  // 存档能解析但着法无法重放：同样备份并重开。
  writeFileSync(saveFileFor(DEFAULT_KEY, 'gomoku'), JSON.stringify({ game: 'gomoku', aiSide: 'black', moves: ['A1', 'A1'] }), 'utf8')
  const again = await open()
  assert.equal(again.moveCount, 0)
  assert.equal(readdirSync(savesDir()).filter((n) => n.includes('.corrupt-')).length, 2)
}))

test('board_reset: active game resets in place and re-renders; inactive just clears the save', () => withData(async () => {
  const tools = Object.fromEntries(createBoardsTools().map((t) => [t.name, t]))
  assert.ok(tools.board_reset)
  await open()
  await playSession('A1', 'ai'); await playSession('B1', 'human')
  const events = []
  const off = onSessionChange((e) => { events.push(e) })
  const view = await resetGame()
  off()
  assert.equal(view.reset, true)
  assert.equal(view.moveCount, 0)
  assert.equal(view.turn, 'ai')
  assert.equal(events[0].type, 'open')
  assert.equal(events[0].reset, true)
  assert.deepEqual(JSON.parse(readFileSync(saveFileFor(DEFAULT_KEY, 'gomoku'), 'utf8')).moves, [])
  await playSession('C1', 'ai')
  closeSession()
  const inactive = await tools.board_reset.execute({ game: 'gomoku' })
  assert.deepEqual(inactive, { reset: true, game: 'gomoku', active: false, clearedSave: true })
  assert.equal(existsSync(saveFileFor(DEFAULT_KEY, 'gomoku')), false)
  await assert.rejects(() => tools.board_reset.execute({}), /指定 game/)
  await assert.rejects(() => tools.board_reset.execute({ game: 'nope' }), /game 只能是/)
  assert.equal((await open()).resumed, undefined)
}))

test('finished game: next open starts new and reports the last result', () => withData(async () => {
  await open()
  for (const [a, h] of [['A1', 'A2'], ['B1', 'B2'], ['C1', 'C2'], ['D1', 'D2']]) { await playSession(a, 'ai'); await playSession(h, 'human') }
  const end = await playSession('E1', 'ai')
  assert.equal(end.view.over.winner, 'ai')
  assert.equal(closeSession().saved, undefined)
  const next = await open()
  assert.equal(next.resumed, undefined)
  assert.equal(next.moveCount, 0)
  assert.deepEqual({ ...next.lastResult, endedAt: undefined }, { side: 'black', winner: 'ai', reason: '五连', moveCount: 9, endedAt: undefined })
  assert.match(next.notice, /上一局已经结束/)
  assert.deepEqual(JSON.parse(readFileSync(saveFileFor(DEFAULT_KEY, 'gomoku'), 'utf8')).moves, [])
}))

test('injected engine (no factory) never touches saves', () => withData(async () => {
  await openSession({ game: 'gomoku', aiSide: 'black', engine: fakeGomoku() })
  await playSession('A1', 'ai')
  assert.equal(existsSync(saveFileFor(DEFAULT_KEY, 'gomoku')), false)
}))
