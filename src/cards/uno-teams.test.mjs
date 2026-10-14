import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextKey } from './context.mjs'
import { resolveTeams, uno, validOptions } from './games/uno.mjs'
import { cardTableLayout } from './layout.mjs'
import { renderTable } from './render.mjs'
import { seatsProblem } from './seats.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame, resetSession, saveFileFor, savesDir } from './session.mjs'
import { toLosslessJson } from './json-output.mjs'

function u(color, trait) {
  const type = trait === 'wild' || trait === 'wild_draw_4' ? 'wild' : (['skip', 'reverse', 'draw_2'].includes(trait) ? 'action' : 'number')
  return { type, color, trait }
}

async function withData(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cards-teams-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  try { await fn() } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
  }
}

test('组队规则：auto / 显式 / 非法', () => {
  assert.equal(resolveTeams(4, 'auto'), 2)
  assert.equal(resolveTeams(6, 'auto'), 2)
  assert.equal(resolveTeams(9, 'auto'), 3)
  assert.equal(resolveTeams(5, 'auto'), 0)
  assert.equal(resolveTeams(2, 'auto'), 0)
  assert.equal(resolveTeams(3, 'auto'), 0)
  assert.equal(resolveTeams(6, '3'), 3)
  assert.equal(resolveTeams(8, 2), 2)
  assert.equal(resolveTeams(8, 'none'), 0)
  assert.equal(resolveTeams(8, undefined), 0)
  assert.throws(() => resolveTeams(5, '2'), /不能分成 2 队/)
  assert.throws(() => resolveTeams(8, '3'), /不能分成 3 队/)
  assert.throws(() => resolveTeams(2, '2'), /每队只有 1 人/)
  assert.throws(() => resolveTeams(6, '4'), /teams 只能是/)
  assert.throws(() => uno.defaultOptions({ players: 11 }), /2 到 10/)
  assert.deepEqual(uno.defaultOptions({ unoPlayers: 6, teams: 'auto' }), { players: 6, drawChoice: true, teams: 2 })
  assert.deepEqual(uno.defaultOptions({ unoPlayers: 6, players: 9, teams: 'auto' }), { players: 9, drawChoice: true, teams: 3 })
})

test('座位分配校验', () => {
  assert.equal(seatsProblem(['user', 'ai', 'bot', 'bot'], 'versus', 4), '')
  assert.equal(seatsProblem(['bot', 'bot', 'ai', 'user'], 'versus', 4), '')
  assert.equal(seatsProblem(['user', 'bot', 'bot', 'bot'], 'versus', 4), '')
  assert.match(seatsProblem(['ai', 'bot', 'bot', 'bot'], 'versus', 4), /exactly one "user"/)
  assert.match(seatsProblem(['user', 'user', 'ai', 'bot'], 'versus', 4), /exactly one "user"/)
  assert.match(seatsProblem(['user', 'ai', 'ai', 'bot'], 'versus', 4), /at most one "ai"/)
  assert.match(seatsProblem(['user', 'ai', 'bot'], 'versus', 4), /exactly 4/)
  assert.match(seatsProblem(['user', 'robot', 'bot', 'bot'], 'versus', 4), /invalid seat role/)
  assert.match(seatsProblem(['bot', 'bot', 'bot', 'bot'], 'solo', 4), /non-bot/)
  assert.equal(seatsProblem(['bot', 'ai', 'bot'], 'solo', 3), '')
  assert.match(seatsProblem(['user', 'ai', 'bot'], 'solo', 3), /no user seat/)
})

test('组队终局：任一队员出完手牌，全队获胜', () => {
  const state = uno.fromSpec({
    hands: [[u('r', '1'), u('g', '2')], [u('b', '3'), u('b', '4')], [u('r', '7')], [u('y', '5'), u('y', '6')]],
    target: u('r', '5'), deck: [u('g', '9'), u('g', '8')], turn: 2, drawChoice: true, teams: 2,
  })
  assert.equal(state.teams, 2)
  const done = uno.apply(state, 'r-7')
  assert.equal(done.over.winnerSeat, 2)
  assert.equal(done.over.winnerTeam, 0)
  assert.deepEqual(done.over.payoffs, [1, -1, 1, -1])
  assert.match(done.over.reason, /第 1 队获胜/)
  const three = uno.fromSpec({
    hands: [[u('r', '1')], [u('r', '2')], [u('b', '3')], [u('b', '4')], [u('r', '9')], [u('y', '6')]],
    target: u('r', '5'), deck: [u('g', '9')], turn: 4, drawChoice: true, teams: 3,
  })
  const won = uno.apply(three, 'r-9')
  assert.equal(won.over.winnerTeam, 1)
  assert.deepEqual(won.over.payoffs, [-1, 1, -1, -1, 1, -1])
})

test('存档兼容：没有 teams 即不组队；非法 teams 存档被拒', () => {
  assert.equal(validOptions({ players: 4, drawChoice: true }), true)
  assert.equal(validOptions({ players: 4, drawChoice: true, teams: 2 }), true)
  assert.equal(validOptions({ players: 6, drawChoice: true, teams: 3, seats: ['user', 'bot', 'ai', 'bot', 'bot', 'bot'] }), true)
  assert.equal(validOptions({ players: 5, drawChoice: true, teams: 2 }), false)
  assert.equal(validOptions({ players: 4, teams: 2, seats: ['user', 'ai'] }), false)
  assert.equal(validOptions(null), true)
  const plain = uno.start(7, { players: 4, drawChoice: true })
  assert.equal(plain.teams, undefined)
  assert.equal(uno.publicView(plain).teams, undefined)
})

test('开局参数：人数 / 组队 / 座位分配；AI 只看到自己的手牌和队伍信息', () => withData(async () => {
  const key = contextKey({ sessionId: 'teams' })
  const opened = await openSession({
    game: 'uno', mode: 'versus', perspective: 'agent', skipSource: true, seed: 31, sessionId: 'teams', persist: true,
    gameOptions: { unoPlayers: 4, players: 6, teams: 'auto', seats: ['bot', 'user', 'bot', 'ai', 'bot', 'bot'] },
  })
  assert.equal(opened.you.seat, 3)
  assert.equal(opened.seats.length, 6)
  assert.deepEqual(opened.seats.map((s) => s.role), ['bot', 'user', 'bot', 'agent', 'bot', 'bot'])
  assert.deepEqual(opened.seats.map((s) => s.team), [1, 2, 1, 2, 1, 2])
  assert.equal(opened.yourTeam, 2)
  assert.deepEqual(opened.teammates, [1, 5])
  assert.deepEqual(opened.teams.map((t) => t.seats), [[0, 2, 4], [1, 3, 5]])
  // 绝不含其他座位的手牌
  const state = JSON.parse(readFileSync(saveFileFor(key, 'uno'), 'utf8'))
  assert.deepEqual(state.options, { players: 6, drawChoice: true, teams: 2, seats: ['bot', 'user', 'bot', 'ai', 'bot', 'bot'] })
  const rep = uno.replay(state.seed, state.actions, state.options)
  const text = JSON.stringify(opened)
  for (const seat of [0, 1, 2, 4, 5]) assert.equal(text.includes(JSON.stringify(rep.hands[seat].map((c) => `${c.color}-${c.trait}`))), false)
  assert.deepEqual(opened.yourHand, rep.hands[3].map((c) => `${c.color}-${c.trait}`))
  // 工具输出保持无损 JSON
  assert.deepEqual(JSON.parse(JSON.stringify(toLosslessJson(opened))).yourTeam, 2)

  // 用户视角：下方是用户座位 1，带队伍标签
  const page = lookSession(key)
  assert.equal(page.viewerSeat, 1)
  assert.equal(page.yourTeam, 2)
  const me = page.rows.find((r) => r.label === 'H')
  assert.equal(me.seat, 1)
  assert.equal(me.team, 1)
  assert.equal(me.cards.length, rep.hands[1].length)
  const layout = cardTableLayout(page)
  assert.equal(layout.me.team, 1)
  assert.deepEqual(layout.opponents.map((o) => o.label), ['A2', 'A3', 'A4', 'A5', 'A0'])
  assert.deepEqual(layout.opponents.map((o) => o.team), [0, 1, 0, 1, 0])
  assert.equal(layout.opponents[1].title, 'AI')
  assert.ok(renderTable({ game: 'uno', ...page }).png.length > 1000)

  // 只在轮到自己座位时能出牌；系统不会替用户或 AI 出牌
  let view = lookSession(key, 'agent')
  for (let guard = 0; guard < 600 && !view.over; guard++) {
    if (view.turn === 'you') view = (await playSession(key, uno.ai(uno.replay(31, JSON.parse(readFileSync(saveFileFor(key, 'uno'), 'utf8')).actions, state.options)), 'ai')).agentView
    else {
      assert.equal(view.turn, 'user')
      await assert.rejects(playSession(key, view.legal[0] || 'draw', 'ai'), /user's turn \(seat 1/)
      const s = uno.replay(31, JSON.parse(readFileSync(saveFileFor(key, 'uno'), 'utf8')).actions, state.options)
      assert.equal(s.turn, 1)
      view = (await playSession(key, uno.ai(s), 'human')).agentView
    }
  }
  assert.ok(view.over)
  assert.ok(view.over.winnerTeam === 1 || view.over.winnerTeam === 2)
  assert.equal(view.over.result, view.over.winnerTeam === 2 ? 'you_win' : 'you_lose')
  closeSession(key)
}))

test('开局参数非法时明确报错，不留牌桌', () => withData(async () => {
  const base = { game: 'uno', mode: 'versus', skipSource: true, sessionId: 'bad', persist: true }
  await assert.rejects(openSession({ ...base, gameOptions: { players: 5, teams: '2' } }), /不能分成 2 队/)
  await assert.rejects(openSession({ ...base, gameOptions: { players: 4, seats: ['ai', 'bot', 'bot', 'bot'] } }), /exactly one "user"/)
  await assert.rejects(openSession({ ...base, mode: 'solo', gameOptions: { players: 3, seats: ['user', 'ai', 'bot'] } }), /no user seat/)
  await assert.rejects(openSession({ ...base, game: 'doudizhu', gameOptions: { teams: '2' } }), /only apply to uno/)
  await assert.rejects(openSession({ ...base, gameOptions: { players: 12 } }), /2 到 10/)
  // auto 遇到 5 人：不组队
  const ok = await openSession({ ...base, perspective: 'agent', gameOptions: { players: 5, teams: 'auto' } })
  assert.equal(ok.yourTeam, undefined)
  assert.equal(ok.seats[0].team, undefined)
  closeSession(contextKey({ sessionId: 'bad' }))
}))

test('solo 座位分配：AI 坐指定座位，页面视角也是它', () => withData(async () => {
  const key = contextKey({ sessionId: 'solo' })
  const opened = await openSession({ game: 'uno', mode: 'solo', perspective: 'agent', skipSource: true, seed: 5, sessionId: 'solo', persist: false, gameOptions: { players: 4, teams: '2', seats: ['bot', 'bot', 'ai', 'bot'] } })
  assert.equal(opened.you.seat, 2)
  assert.deepEqual(opened.teammates, [0])
  assert.equal(lookSession(key).viewerSeat, 2)
  closeSession(key)
}))

test('原地重开沿用组队与座位分配；续局时新参数不生效并提示', () => withData(async () => {
  const key = contextKey({ sessionId: 'keep' })
  await openSession({ game: 'uno', mode: 'versus', skipSource: true, seed: 9, sessionId: 'keep', persist: true, gameOptions: { players: 4, teams: '2', seats: ['user', 'bot', 'ai', 'bot'] } })
  const again = await resetGame(key, undefined, { unoPlayers: 4, perspective: 'agent' })
  assert.equal(again.you.seat, 2)
  assert.equal(again.yourTeam, 1)
  assert.deepEqual(again.teammates, [0])
  await assert.rejects(resetGame(key, undefined, { players: 5, teams: '2' }), /不能分成 2 队/)
  assert.equal(lookSession(key, 'agent').you.seat, 2)
  closeSession(key)
  const resumed = await openSession({ game: 'uno', mode: 'versus', perspective: 'agent', skipSource: true, sessionId: 'keep', persist: true, gameOptions: { players: 6, teams: '3' } })
  assert.ok(resumed.resumed)
  assert.equal(resumed.seats.length, 4)
  assert.match(resumed.notice || '', /未生效/)
  closeSession(key)
}))

test('旧存档（无 teams）续局为不组队', () => withData(async () => {
  const key = contextKey({ sessionId: 'old4' })
  mkdirSync(savesDir(), { recursive: true })
  writeFileSync(saveFileFor(key, 'uno'), JSON.stringify({
    version: 1, game: 'uno', contextKey: key, id: 'old44444', seed: 4, actions: [], options: { players: 4, drawChoice: true }, mode: 'versus', over: null,
    playerName: 'Shiro', telegram: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }) + '\n', 'utf8')
  const view = await openSession({ game: 'uno', perspective: 'agent', mode: 'versus', skipSource: true, sessionId: 'old4', persist: true })
  assert.equal(view.id, 'old44444')
  assert.equal(view.you.seat, 1)
  assert.equal(view.yourTeam, undefined)
  assert.equal(lookSession(key).rows.find((r) => r.label === 'H').team, undefined)
  closeSession(key)
}))
