import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextKey } from './context.mjs'
import { DEFAULT_PLAYERS, clampPlayers, uno } from './games/uno.mjs'
import { renderTable } from './render.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame, resetSession, saveFileFor, savesDir } from './session.mjs'
import { captionFor } from './telegram.mjs'

function u(color, trait) {
  const type = trait === 'wild' || trait === 'wild_draw_4' ? 'wild' : (['skip', 'reverse', 'draw_2'].includes(trait) ? 'action' : 'number')
  return { type, color, trait }
}

function total(state) {
  return state.hands.reduce((sum, hand) => sum + hand.length, 0) + state.deck.length + state.played.length
}

function autoplay(seed, players) {
  let state = uno.start(seed, { players })
  const actions = []
  let steps = 0
  while (!state.over && steps < 5000) {
    const action = uno.ai(state)
    assert.equal(uno.legal(state).includes(action), true, `${players} 人 seed ${seed}: ${action}`)
    state = uno.apply(state, action)
    actions.push(action)
    assert.equal(total(state), 108, `${players} 人 seed ${seed} 牌数守恒`)
    assert.ok(state.turn >= 0 && state.turn < players)
    steps += 1
  }
  return { state, actions }
}

test('UNO 人数：默认 4，限制在 2 到 10', () => {
  assert.equal(DEFAULT_PLAYERS, 4)
  assert.equal(clampPlayers(undefined), 4)
  assert.equal(clampPlayers(1), 2)
  assert.equal(clampPlayers(11), 10)
  assert.equal(clampPlayers(6), 6)
  assert.deepEqual(uno.defaultOptions({}), { players: 4, drawChoice: true })
  assert.deepEqual(uno.defaultOptions({ unoPlayers: 10 }), { players: 10, drawChoice: true })
  assert.equal(uno.validOptions(undefined), true)
  assert.equal(uno.validOptions({ players: 11 }), false)
})

test('N 人 UNO：按种子自动对局 3、4、6、10 人都能终局，且重放一致', () => {
  for (const players of [3, 4, 6, 10]) {
    const winners = new Set()
    for (let seed = 1; seed <= 25; seed++) {
      const start = uno.start(seed, { players })
      assert.equal(start.hands.length, players)
      assert.equal(start.players, players)
      assert.equal(start.rules, 'official')
      assert.notEqual(start.target.trait, 'wild_draw_4')
      const { state, actions } = autoplay(seed, players)
      assert.ok(state.over, `${players} 人 seed ${seed} 没有终局`)
      const seat = state.over.winnerSeat
      assert.equal(state.hands[seat].length, 0)
      assert.equal(state.over.winner, seat === 0 ? 'player' : 'ai')
      assert.equal(state.over.payoffs.length, players)
      assert.equal(state.over.payoffs.filter((p) => p === 1).length, 1)
      winners.add(seat)
      const again = uno.replay(seed, actions, { players })
      assert.deepEqual(again.over, state.over)
    }
    assert.ok(winners.size > 1, `${players} 人局赢家总是同一座位`)
  }
})

test('N 人 UNO：跳过、反转、+2、+4 与轮转', () => {
  const four = (hand0, extra = {}) => uno.fromSpec({
    hands: [hand0, [u('b', '1'), u('b', '2')], [u('g', '1'), u('g', '2')], [u('y', '1'), u('y', '2')]],
    target: u('r', '3'),
    deck: [u('b', '5'), u('b', '6'), u('b', '7'), u('b', '8'), u('b', '9')],
    ...extra,
  })
  let s = uno.apply(four([u('r', '5'), u('g', '9')]), 'r-5')
  assert.equal(s.turn, 1)
  s = uno.apply(four([u('r', 'skip'), u('g', '9')]), 'r-skip')
  assert.equal(s.turn, 2)
  s = uno.apply(four([u('r', 'reverse'), u('g', '9')]), 'r-reverse')
  assert.equal(s.direction, -1)
  assert.equal(s.turn, 3)
  s = uno.apply(four([u('r', 'draw_2'), u('g', '9')]), 'r-draw_2')
  assert.equal(s.hands[1].length, 4)
  assert.equal(s.turn, 2)
  s = uno.apply(four([u('g', 'wild_draw_4'), u('g', '9')]), 'b-wild_draw_4')
  assert.equal(s.hands[1].length, 6)
  assert.equal(s.turn, 2)
  assert.equal(s.target.color, 'b')
  // 逆时针时从座位 0 往回到最后一个座位
  s = uno.apply(four([u('r', '5'), u('g', '9')], { direction: -1 }), 'r-5')
  assert.equal(s.turn, 3)
  s = uno.apply(four([u('r', 'skip'), u('g', '9')], { direction: -1 }), 'r-skip')
  assert.equal(s.turn, 2)

  // 官方两人局：反转等同跳过，出牌者再出
  const two = (hand0) => uno.fromSpec({ rules: 'official', hands: [hand0, [u('b', '1')]], target: u('r', '3'), deck: [u('b', '5'), u('b', '6')] })
  s = uno.apply(two([u('r', 'reverse'), u('g', '9')]), 'r-reverse')
  assert.equal(s.turn, 0)
  s = uno.apply(two([u('r', 'skip'), u('g', '9')]), 'r-skip')
  assert.equal(s.turn, 0)
  s = uno.apply(two([u('r', 'draw_2'), u('g', '9')]), 'r-draw_2')
  assert.equal(s.turn, 0)
  assert.equal(s.hands[1].length, 3)
})

test('N 人 UNO：起手牌按官方规则', () => {
  const seen = new Set()
  for (let seed = 1; seed <= 600 && seen.size < 3; seed++) {
    const state = uno.start(seed, { players: 5 })
    if (state.target.trait === 'skip') { seen.add('skip'); assert.equal(state.turn, 1) }
    if (state.target.trait === 'reverse') { seen.add('reverse'); assert.equal(state.direction, -1); assert.equal(state.turn, 4) }
    if (state.target.trait === 'draw_2') { seen.add('draw_2'); assert.equal(state.hands[0].length, 9); assert.equal(state.turn, 1) }
  }
  assert.equal(seen.size, 3)
})

test('N 人 UNO：公开局面只给对手张数，牌桌图与说明可用', () => {
  const state = uno.start(11, { players: 10 })
  const view = uno.publicView(state)
  assert.equal(view.players, 10)
  assert.equal(view.opponents.length, 9)
  const json = JSON.stringify(view)
  for (let seat = 1; seat < 10; seat++) {
    assert.equal(view.opponents[seat - 1].count, state.hands[seat].length)
  }
  assert.equal(json.includes('"color"'), false)
  const opp = view.rows.find((row) => row.label === 'A')
  assert.equal(opp.cards.length, 9)
  assert.ok(opp.cards.every((c) => c.hidden === true && Number.isInteger(c.count) && c.code === undefined))
  const png = renderTable({ game: 'uno', ...view }).png
  assert.ok(png.length > 1000)
  const caption = captionFor({ type: 'open', view: { ...view, game: 'uno', label: 'UNO' } })
  assert.match(caption, /10 人局/)
  assert.match(caption, /对手 9 \d+ 张/)
})

test('UNO 存档：新局记下人数；旧版两人存档（无 options）照旧续局', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cards-uno-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  try {
    const key = contextKey({ sessionId: 'multi' })
    const opened = await openSession({ game: 'uno', skipSource: true, seed: 21, sessionId: 'multi', persist: true, gameOptions: { unoPlayers: 6 } })
    assert.equal(lookSession(key).rows.find((row) => row.label === 'A').cards.length, 5)
    let saved = JSON.parse(readFileSync(saveFileFor(key, 'uno'), 'utf8'))
    assert.deepEqual(saved.options, { players: 6, drawChoice: true })
    let view = opened
    for (let guard = 0; guard < 400 && !view.over; guard++) {
      view = (await playSession(key, uno.ai(uno.replay(21, JSON.parse(readFileSync(saveFileFor(key, 'uno'), 'utf8')).actions, { players: 6, drawChoice: true })), 'human')).view
    }
    assert.ok(view.over)
    assert.equal(view.over.payoffs.length, 6)
    closeSession(key)
    // 默认人数
    await resetGame(key, 'uno')
    const fresh = await openSession({ game: 'uno', skipSource: true, seed: 22, sessionId: 'multi', persist: true })
    assert.equal(lookSession(key).rows.find((row) => row.label === 'A').cards.length, 3)
    assert.equal(fresh.game, 'uno')
    closeSession(key)
    await resetGame(key, 'uno')

    // 旧版两人存档：没有 options 字段
    const oldKey = contextKey({ sessionId: 'legacy' })
    let legacy = uno.start(9)
    const actions = []
    while (!legacy.over && actions.length < 6) {
      const action = uno.ai(legacy)
      legacy = uno.apply(legacy, action)
      actions.push(action)
      while (!legacy.over && legacy.turn !== 0) {
        const reply = uno.ai(legacy)
        legacy = uno.apply(legacy, reply)
        actions.push(reply)
      }
    }
    assert.equal(legacy.over, null)
    mkdirSync(savesDir(), { recursive: true })
    writeFileSync(saveFileFor(oldKey, 'uno'), JSON.stringify({
      version: 1, game: 'uno', contextKey: oldKey, id: 'old12345', seed: 9, actions, over: null,
      playerName: 'Shiro', telegram: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    }) + '\n', 'utf8')
    const resumed = await openSession({ game: 'uno', skipSource: true, sessionId: 'legacy', persist: true, gameOptions: { unoPlayers: 8 } })
    assert.equal(resumed.id, 'old12345')
    assert.equal(resumed.resumed.moveCount, actions.length)
    assert.equal(resumed.notice, undefined)
    const look = lookSession(oldKey)
    assert.equal(look.rows.find((row) => row.label === 'A').cards.length, legacy.hands[1].length)
    assert.equal(look.rows.find((row) => row.label === 'T').cards[0].code, `${legacy.target.color}-${legacy.target.trait}`)
    saved = JSON.parse(readFileSync(saveFileFor(oldKey, 'uno'), 'utf8'))
    assert.equal(saved.options, undefined)
    closeSession(oldKey)
  } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
