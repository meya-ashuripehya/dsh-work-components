import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRapfiCollector, createUciCollector, parseKatagoResponse, parseRapfiMessage, parseUciInfo, rapfiBestmove, rapfiWinrate, uciWinrate } from './protocols.mjs'
import { KatagoEngine, RapfiEngine, UciEngine } from './engines.mjs'
import { computeHints, hintMs } from './hints.mjs'
import { ASSIST_ENGINES, assetFor } from './specs.mjs'

/** 模拟引擎进程：respond(line, emit, proc) 对每一行 stdin 作答。 */
function fakeSpawn(respond, log = []) {
  const spawned = []
  const impl = () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.killed = false
    const emit = (text) => setImmediate(() => { if (!proc.killed) proc.stdout.emit('data', Buffer.from(text + '\n')) })
    proc.stdin = new EventEmitter()
    proc.stdin.write = (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) { log.push(line); respond(line, emit, proc) }
      return true
    }
    proc.stdin.end = () => {}
    proc.kill = () => { if (!proc.killed) { proc.killed = true; setImmediate(() => proc.emit('exit', 0)) } }
    spawned.push(proc)
    return proc
  }
  impl.spawned = spawned
  return impl
}

const PIKA_LINES = [
  'info depth 14 seldepth 23 multipv 1 score cp 38 wdl 100 892 8 nodes 156319 nps 1008509 time 155 pv h2e2 h9g7 g3g4',
  'info depth 14 seldepth 24 multipv 2 score cp 22 wdl 60 926 14 nodes 156319 time 155 pv b2e2 b9c7 b0c2',
  'info depth 14 seldepth 29 multipv 3 score cp 22 wdl 60 926 14 nodes 156319 time 155 pv c3c4 h7e7',
  'info depth 15 seldepth 18 multipv 1 score cp 34 lowerbound wdl 90 901 9 nodes 169773 time 169 pv h2e2 b9c7',
]

test('UCI: multipv / wdl / bound / mate 解析与胜率', () => {
  const a = parseUciInfo(PIKA_LINES[3])
  assert.equal(a.multipv, 1)
  assert.equal(a.depth, 15)
  assert.equal(a.cp, 34)
  assert.equal(a.bound, 'lowerbound')
  assert.deepEqual(a.wdl, { win: 90, draw: 901, loss: 9 })
  assert.deepEqual(a.pv, ['h2e2', 'b9c7'])
  assert.equal(uciWinrate(a), 54.1)
  assert.equal(uciWinrate(parseUciInfo('info depth 9 multipv 1 score mate 3 pv e1e8')), 100)
  assert.equal(uciWinrate(parseUciInfo('info depth 9 multipv 1 score mate -2 pv e1e8')), 0)
  assert.equal(uciWinrate(parseUciInfo('info depth 9 score cp 0 pv e2e4')), 50)
  assert.equal(parseUciInfo('info depth 9 currmove e2e4 currmovenumber 1'), null)
  assert.equal(parseUciInfo('bestmove e2e4'), null)
  const col = createUciCollector()
  for (const l of PIKA_LINES) col.push(l)
  const top = col.top(3)
  assert.deepEqual(top.map((t) => t.move), ['h2e2', 'b2e2', 'c3c4'])
  assert.equal(top[0].depth, 15)
})

test('Rapfi: ucilike MESSAGE、mate、无 multipv、最佳着法坐标', () => {
  const a = parseRapfiMessage('MESSAGE depth 14-27 multipv 2 ev 416 n 49K n/ms 296 tm 166 pv J7 J8 K7')
  assert.deepEqual(a, { depth: 14, multipv: 2, ev: '416', pv: ['J7', 'J8', 'K7'] })
  const b = parseRapfiMessage('MESSAGE depth 26-2 ev -M2 n 50 n/ms 50 tm 1 pv L8')
  assert.equal(b.multipv, 1)
  assert.equal(rapfiWinrate(b.ev), 0)
  assert.equal(rapfiWinrate('+M5'), 100)
  assert.equal(rapfiWinrate('0'), 50)
  assert.ok(rapfiWinrate('416') > 85 && rapfiWinrate('416') < 90)
  assert.equal(parseRapfiMessage('MESSAGE Speed 392K | Depth 16-18'), null)
  assert.equal(rapfiBestmove('11,7'), 'L8')
  assert.equal(rapfiBestmove('7,7'), 'H8')
  assert.equal(rapfiBestmove('MESSAGE 7,7'), null)
  const col = createRapfiCollector()
  col.push('MESSAGE depth 13-21 multipv 1 ev 100 n 1K tm 9 pv H8')
  col.push('MESSAGE depth 14-21 multipv 1 ev 120 n 1K tm 9 pv I9')
  col.push('MESSAGE depth 13-21 multipv 2 ev 90 n 1K tm 9 pv J9')
  assert.deepEqual(col.top().map((t) => t.move), ['I9', 'J9'])
})

test('KataGo: 只认本次 id 的最终结果，按 order 排序', () => {
  const line = JSON.stringify({ id: 'q1', isDuringSearch: false, rootInfo: { winrate: 0.433, scoreLead: -0.62, visits: 73 }, moveInfos: [
    { move: 'D17', order: 1, winrate: 0.4361, scoreLead: -0.61, visits: 16, pv: ['D17', 'C4'] },
    { move: 'R4', order: 0, winrate: 0.4364, scoreLead: -0.58, visits: 16, pv: ['R4'] },
  ] })
  const r = parseKatagoResponse(line, 'q1')
  assert.deepEqual(r.moves.map((m) => m.move), ['R4', 'D17'])
  assert.equal(r.moves[0].winrate, 43.6)
  assert.equal(r.moves[0].scoreLead, -0.6)
  assert.equal(r.root.visits, 73)
  assert.equal(parseKatagoResponse(line, 'q2'), null)
  assert.equal(parseKatagoResponse('{"id":"q1","isDuringSearch":true,"moveInfos":[]}', 'q1'), null)
  assert.deepEqual(parseKatagoResponse('{"id":"q1","error":"bad"}', 'q1'), { error: 'bad' })
  assert.equal(parseKatagoResponse('not json', 'q1'), null)
})

function uciResponder(line, emit) {
  if (line === 'uci') { emit('id name FakeFish'); emit('uciok') }
  else if (line === 'isready') emit('readyok')
  else if (line.startsWith('go ')) { for (const l of PIKA_LINES) emit(l); emit('bestmove h2e2 ponder b9c7') }
}

test('UciEngine：握手、MultiPV/WDL 选项、限时搜索返回前三', async () => {
  const log = []
  const spawnImpl = fakeSpawn(uciResponder, log)
  const engine = new UciEngine({ command: 'fake', spawnImpl, options: { EvalFile: '/x/pikafish.nnue' } })
  const res = await engine.analyze('FEN w - - 0 1', 300)
  assert.deepEqual(res.map((r) => r.move), ['h2e2', 'b2e2', 'c3c4'])
  assert.ok(log.includes('setoption name MultiPV value 3'))
  assert.ok(log.includes('setoption name UCI_ShowWDL value true'))
  assert.ok(log.includes('setoption name EvalFile value /x/pikafish.nnue'))
  assert.ok(log.includes('position fen FEN w - - 0 1'))
  assert.ok(log.includes('go movetime 300'))
  // 长驻：第二次不重新握手
  await engine.analyze('FEN2 b - - 0 1', 100)
  assert.equal(spawnImpl.spawned.length, 1)
  assert.equal(log.filter((l) => l === 'uci').length, 1)
  engine.dispose()
  assert.ok(spawnImpl.spawned[0].killed)
})

test('引擎崩溃：本次返回 null，不抛错；下次重新启动', async () => {
  let crash = true
  const spawnImpl = fakeSpawn((line, emit, proc) => {
    if (line.startsWith('go ') && crash) { crash = false; proc.killed = true; setImmediate(() => proc.emit('exit', 139)); return }
    uciResponder(line, emit)
  })
  const engine = new UciEngine({ command: 'fake', spawnImpl })
  assert.equal(await engine.analyze('F w', 100), null)
  const again = await engine.analyze('F w', 100)
  assert.equal(again.length, 3)
  assert.equal(spawnImpl.spawned.length, 2)
  engine.dispose()
})

test('引擎起不来（spawn 报错）：返回 null', async () => {
  const spawnImpl = () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter()
    p.stdin = new EventEmitter(); p.stdin.write = () => true; p.stdin.end = () => {}; p.kill = () => {}
    setImmediate(() => p.emit('error', new Error('ENOENT')))
    return p
  }
  const engine = new UciEngine({ command: 'missing', spawnImpl })
  assert.equal(await engine.analyze('F w', 100), null)
})

test('RapfiEngine：START / YXBOARD（按落子顺序，轮到方记 1）/ YXNBEST 3', async () => {
  const log = []
  const spawnImpl = fakeSpawn((line, emit) => {
    if (line.startsWith('START')) emit('OK')
    else if (line === 'YXNBEST 3') {
      emit('MESSAGE depth 10-12 multipv 1 ev 300 n 1K tm 9 pv I9 J10')
      emit('MESSAGE depth 10-12 multipv 2 ev 250 n 1K tm 9 pv G7')
      emit('MESSAGE depth 10-12 multipv 3 ev -M3 n 1K tm 9 pv A1')
      emit('8,8')
    }
  }, log)
  const engine = new RapfiEngine({ command: 'fake', spawnImpl })
  const res = await engine.analyze({ stones: [{ x: 7, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 8 }] }, 500)
  assert.deepEqual(res.map((r) => r.move), ['I9', 'G7', 'A1'])
  assert.equal(res[2].winrate, 0)
  const i = log.indexOf('YXBOARD')
  assert.deepEqual(log.slice(i, i + 5), ['YXBOARD', '7,7,2', '8,7,1', '7,8,2', 'DONE'])
  assert.ok(log.includes('INFO timeout_turn 500'))
  assert.ok(log.includes('INFO rule 0'))
  engine.dispose()
})

test('KatagoEngine：JSON 查询带 maxTime，回应按 id 匹配', async () => {
  const log = []
  const spawnImpl = fakeSpawn((line, emit) => {
    const q = JSON.parse(line)
    emit('{"warning":"ignore me"}')
    emit(JSON.stringify({ id: 'other', moveInfos: [] }))
    emit(JSON.stringify({ id: q.id, isDuringSearch: false, rootInfo: { winrate: 0.5, scoreLead: 0, visits: 10 }, moveInfos: [
      { move: 'Q16', order: 0, winrate: 0.55, scoreLead: 1.2, visits: 5, pv: ['Q16'] },
      { move: 'D4', order: 1, winrate: 0.54, scoreLead: 1.0, visits: 3, pv: ['D4'] },
      { move: 'pass', order: 2, winrate: 0.1, scoreLead: -9, visits: 1, pv: ['pass'] },
      { move: 'C3', order: 3, winrate: 0.1, scoreLead: -9, visits: 1, pv: ['C3'] },
    ] }))
  }, log)
  const engine = new KatagoEngine({ command: 'fake', spawnImpl })
  const res = await engine.analyze({ moves: [], initialStones: [['B', 'D4']], initialPlayer: 'W', rules: 'chinese', komi: 7.5, boardXSize: 19, boardYSize: 19 }, 1000)
  assert.deepEqual(res.map((r) => r.move), ['Q16', 'D4', 'pass'])
  assert.equal(res[0].winrate, 55)
  const q = JSON.parse(log[log.length - 1])
  assert.equal(q.overrideSettings.maxTime, 1)
  assert.equal(q.initialPlayer, 'W')
  engine.dispose()
})

test('computeHints：映射到本棋种着法、AI 视角胜率、过滤非法、终局与无引擎时不给', async () => {
  const items = ['H8', 'I9', 'G7'].map((m) => ({ move: m, label: m }))
  const fake = { analyze: async () => [{ move: 'I9', winrate: 70 }, { move: 'Z99', winrate: 60 }, { move: 'i9', winrate: 65 }, { move: 'G7', winrate: 40 }] }
  const base = { game: 'gomoku', aiSide: 'black', humanSide: 'white', over: false, view: {}, moves: ['H8', 'J10'], items, engine: {} }
  const mine = await computeHints({ ctx: { ...base, turnSide: 'black' }, engine: fake, ms: 200 })
  assert.equal(mine.toMove, 'ai')
  assert.deepEqual(mine.candidates.map((c) => [c.move, c.winrate]), [['I9', 70], ['G7', 40]])
  const theirs = await computeHints({ ctx: { ...base, turnSide: 'white' }, engine: fake, ms: 200 })
  assert.equal(theirs.toMove, 'human')
  assert.deepEqual(theirs.candidates.map((c) => c.winrate), [30, 60])
  assert.equal(await computeHints({ ctx: { ...base, turnSide: 'black', over: true }, engine: fake }), null)
  assert.equal(await computeHints({ ctx: { ...base, turnSide: 'black' }, engine: { analyze: async () => null } }), null)
  assert.equal(await computeHints({ ctx: { ...base, turnSide: 'black' }, engine: { analyze: async () => { throw new Error('boom') } } }), null)
})

test('computeHints：象棋 UCI → 中文记谱（红方中文数字），WDL 随视角翻转', async () => {
  const items = [
    { move: '7,7-4,7', label: '炮2平5', from: { x: 7, y: 7 }, to: { x: 4, y: 7 } },
    { move: '1,7-4,7', label: '炮8平5', from: { x: 1, y: 7 }, to: { x: 4, y: 7 } },
  ]
  const fake = { analyze: async (fen) => { assert.match(fen, / w - - 0 1$/); return [{ move: 'h2e2', winrate: 54.1, wdl: { win: 90, draw: 901, loss: 9 }, cp: 34 }, { move: 'b2e2', winrate: 53 }] } }
  const ctx = { game: 'xiangqi', aiSide: 'red', humanSide: 'black', turnSide: 'red', over: false, view: { fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w' }, moves: [], items, engine: {} }
  const h = await computeHints({ ctx, engine: fake })
  assert.deepEqual(h.candidates.map((c) => c.notation), ['炮二平五', '炮八平五'])
  assert.deepEqual(h.candidates[0].wdl, { win: 90, draw: 901, loss: 9 })
  const h2 = await computeHints({ ctx: { ...ctx, aiSide: 'black', humanSide: 'red' }, engine: fake })
  assert.deepEqual(h2.candidates[0].wdl, { win: 9, draw: 901, loss: 90 })
  assert.equal(h2.candidates[0].cp, -34)
})

test('hintMs：默认 1000，限制在 100–10000', () => {
  assert.equal(hintMs({}), 1000)
  assert.equal(hintMs({ boardsHintMs: 50 }), 100)
  assert.equal(hintMs({ boardsHintMs: 99999 }), 10000)
  assert.equal(hintMs({ boardsHintMs: 2500 }), 2500)
})

test('规格：钉死版本、sha256、Windows x64 / Linux x64 资产', () => {
  for (const spec of Object.values(ASSIST_ENGINES)) {
    for (const key of ['win32-x64', 'linux-x64']) {
      const a = assetFor(spec, key)
      assert.ok(a, `${spec.id} ${key}`)
      assert.match(a.sha256, /^[0-9a-f]{64}$/)
      assert.match(a.url, /^https:\/\/github\.com\//)
    }
    assert.ok(['GPL-3.0', 'MIT'].includes(spec.license))
  }
  assert.match(ASSIST_ENGINES.go.network.sha256, /^[0-9a-f]{64}$/)
})

test('下载本体不会下载辅助引擎；本体未下载时拒绝下载引擎；无引擎时 board_look / board_hint 不报错', async () => {
  const src = readFileSync(new URL('../download.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /assist/)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-assist-'))
  const prev = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = dir
  try {
    const { startAssistDownload, assistStatus } = await import('./install.mjs')
    assert.throws(() => startAssistDownload('chess'), (e) => e.status === 409 && /请先下载国际象棋棋盘/.test(e.message))
    assert.equal(assistStatus().chess.installed, false)
    const { openSession, closeSession } = await import('../session.mjs')
    const { createBoardsTools } = await import('../tools.mjs')
    const tools = Object.fromEntries(createBoardsTools().map((t) => [t.name, t]))
    const items = [{ move: 'H8', label: 'H8' }]
    await openSession({ game: 'gomoku', aiSide: 'black', persist: false, engine: { list: () => items, play: () => items[0], view: () => ({ turnSide: 'black', board: [], over: null }) } })
    const look = await tools.board_look.execute({})
    assert.equal(look.hints, undefined)
    const hint = await tools.board_hint.execute({})
    assert.equal(hint.available, false)
    closeSession()
  } finally {
    if (prev === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})
